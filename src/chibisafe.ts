import streamDeck from "@elgato/streamdeck";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { type BodyPart, type HttpRequest, httpRequest, type HttpResponse, isTimeout } from "./http";

/**
 * Uploads files to a chibisafe server (https://github.com/chibisafe/chibisafe) using the same
 * protocol as its web uploader: a single multipart POST for small files, numbered chunks for large
 * ones, or a presigned PUT when the server stores files on S3.
 */

const logger = streamDeck.logger.createScope("chibisafe");

/** chibisafe connection details stored in the plugin's global settings. */
export type ChibisafeSettings = {
	/** Master switch; each save key can still opt out. */
	chibisafeEnabled?: boolean;
	chibisafeUrl?: string;
	chibisafeApiKey?: string;
	/** Optional album UUID the clips are added to. */
	chibisafeAlbum?: string;
};

export type ChibisafeStatus = {
	/** The global upload switch. The connection is checked either way, so it can be tested first. */
	enabled: boolean;
	state: "unconfigured" | "checking" | "ready" | "error";
	detail: string;
};

export type ChibisafeAlbum = { uuid: string; name: string };

/** A clip being uploaded. */
type Clip = { file: string; size: number; name: string; type: string };

type ServerSettings = {
	chunkSize: number;
	maxSize: number;
	useNetworkStorage: boolean;
	blockedExtensions: string[];
};

export class ChibisafeError extends Error {
	constructor(
		message: string,
		/** HTTP status of the failed request, when there was one. */
		readonly status?: number,
	) {
		super(message);
	}
}

type SendOptions = {
	timeout: number;
	/**
	 * Whether resending is harmless. The final chunk and the S3 "process" call create the file on the
	 * server, so they're only retried when the server clearly didn't handle them.
	 */
	idempotent?: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const RETRIES = 3;
/** The server didn't handle the request, so any request can be retried. */
const RETRY_STATUSES = new Set([408, 429, 503]);
/** A proxy lost the backend's answer; the request may still have been handled. */
const AMBIGUOUS_STATUSES = new Set([502, 504]);
/** Upload time limits assume at least this upload speed (2 Mbit/s), so a stalled upload fails in minutes. */
const MIN_UPLOAD_BYTES_PER_SECOND = 250_000;

/** Whole milliseconds, as AbortSignal.timeout() rejects fractions. */
function uploadTimeout(bytes: number): number {
	return Math.ceil(60_000 + (bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1_000);
}
const SETTINGS_DEBOUNCE_MS = 800;
/** How long the album list is reused, so opening settings panels one after another fetches it once. */
const ALBUM_LIST_CACHE_MS = 30_000;
/** How long the server settings and "album exists" checks are reused before an upload re-checks them. */
const CHECK_CACHE_MS = 10 * 60_000;

const CONTENT_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".flv": "video/x-flv",
	".ts": "video/mp2t",
	".webm": "video/webm",
};

/** The only file types this plugin will ever upload (OBS's recording formats). */
export function isVideoFile(file: string): boolean {
	return path.extname(file).toLowerCase() in CONTENT_TYPES;
}

/**
 * The API key travels in a header, so require HTTPS unless the server is on this computer or the
 * local network.
 */
function parseServerUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new ChibisafeError("The server URL isn't valid; use something like https://chibisafe.example.com");
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ChibisafeError("The server URL must start with https://");
	}
	if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
		throw new ChibisafeError("Use https:// for servers outside your local network, so your API key isn't sent unencrypted");
	}

	url.hash = "";
	url.search = "";
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url;
}

function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) {
		return true;
	}
	if (isIP(host) === 4) {
		const [a, b] = host.split(".").map(Number);
		return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	if (isIP(host) === 6) {
		return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:");
	}
	return false;
}

function formatBytes(bytes: number): string {
	const [value, unit] = bytes >= 1e9 ? [bytes / 1e9, "GB"] : bytes >= 1e6 ? [bytes / 1e6, "MB"] : [bytes / 1e3, "KB"];
	// Two significant decimals below 100 keep sizes near a limit distinguishable (4.95 MB vs 5 MB).
	return `${value >= 100 ? Math.round(value) : Number(value.toFixed(2))} ${unit}`;
}

function tooLarge(size: number, limit: number): ChibisafeError {
	// Rounded sizes can look identical right at the limit; fall back to exact bytes then.
	const [clip, max] =
		formatBytes(size) === formatBytes(limit)
			? [`${size.toLocaleString("en-US")} bytes`, `${limit.toLocaleString("en-US")} bytes`]
			: [formatBytes(size), formatBytes(limit)];
	return new ChibisafeError(`The clip is ${clip}, over the server's limit of ${max}`);
}

function json<T>(response: HttpResponse): T {
	try {
		return JSON.parse(response.text) as T;
	} catch {
		throw new ChibisafeError(`The server sent an unexpected response (HTTP ${response.status})`, response.status);
	}
}

function errorMessage(response: HttpResponse): string {
	try {
		const { message } = JSON.parse(response.text) as { message?: string };
		if (message) return `${message} (HTTP ${response.status})`;
	} catch {
		// Not JSON; fall through.
	}
	return `HTTP ${response.status}`;
}

/** Escapes a multipart header parameter the way browsers do. */
function quoted(value: string): string {
	return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Reports upload progress as a 0–1 fraction, only when it moves by at least a percent. */
function progressReporter(total: number, onProgress: (fraction: number) => void): (done: number) => void {
	let last = -1;
	return (done) => {
		const percent = Math.min(100, Math.floor((done / total) * 100));
		if (percent !== last) {
			last = percent;
			onProgress(percent / 100);
		}
	};
}

class ChibisafeClient {
	#settings: Required<ChibisafeSettings> = { chibisafeEnabled: false, chibisafeUrl: "", chibisafeApiKey: "", chibisafeAlbum: "" };
	#status: ChibisafeStatus = { enabled: false, state: "unconfigured", detail: "" };
	#verifyTimer: NodeJS.Timeout | undefined;
	#verifyRun = 0;

	// Caches are tied to the server URL and API key they were made with (see connectionKey).
	#albumList: { connection: string; at: number; albums: ChibisafeAlbum[] } | undefined;
	#serverCache: { connection: string; at: number; settings: ServerSettings } | undefined;
	/** Albums known to exist, keyed by connection and UUID, with the time they were last confirmed. */
	readonly #knownAlbums = new Map<string, number>();
	readonly #listeners = new Set<(status: ChibisafeStatus) => void>();

	get status(): Readonly<ChibisafeStatus> {
		return this.#status;
	}

	/** Uploading is switched on globally and the server has everything it needs. */
	get enabled(): boolean {
		return this.#settings.chibisafeEnabled && Boolean(this.#settings.chibisafeUrl && this.#settings.chibisafeApiKey);
	}

	onStatusChange(listener: (status: ChibisafeStatus) => void): void {
		this.#listeners.add(listener);
	}

	configure(settings: ChibisafeSettings): void {
		const next: Required<ChibisafeSettings> = {
			chibisafeEnabled: settings.chibisafeEnabled === true,
			chibisafeUrl: settings.chibisafeUrl?.trim() ?? "",
			chibisafeApiKey: settings.chibisafeApiKey?.trim() ?? "",
			chibisafeAlbum: settings.chibisafeAlbum?.trim() ?? "",
		};
		const previous = this.#settings;
		if (JSON.stringify(next) === JSON.stringify(previous)) {
			return;
		}
		this.#settings = next;

		const enabled = next.chibisafeEnabled;
		if (!next.chibisafeUrl || !next.chibisafeApiKey) {
			clearTimeout(this.#verifyTimer);
			this.#verifyRun++;
			this.#update({ enabled, state: "unconfigured", detail: "" });
		} else if (
			next.chibisafeUrl !== previous.chibisafeUrl ||
			next.chibisafeApiKey !== previous.chibisafeApiKey ||
			next.chibisafeAlbum !== previous.chibisafeAlbum ||
			this.#status.state === "unconfigured"
		) {
			// The property inspector saves on every keystroke; wait until typing settles.
			clearTimeout(this.#verifyTimer);
			this.#verifyRun++;
			this.#update({ enabled, state: "checking", detail: "Checking the connection…" });
			this.#verifyTimer = setTimeout(() => void this.#verify(), SETTINGS_DEBOUNCE_MS);
		} else {
			// Only the upload switch changed; the connection check still stands.
			this.#update({ ...this.#status, enabled });
		}
	}

	/** The selected album's UUID, or an empty string. */
	get album(): string {
		return this.#settings.chibisafeAlbum;
	}

	/** Identifies the server URL and API key in use, to notice when they change during a request. */
	get connectionKey(): string {
		return `${this.#settings.chibisafeUrl}\n${this.#settings.chibisafeApiKey}`;
	}

	/**
	 * The user's albums, sorted by name. Works whether or not uploading is switched on.
	 * @param fresh Skip the short-lived cache, e.g. when the user presses ↻.
	 */
	async listAlbums(fresh = false): Promise<ChibisafeAlbum[]> {
		const connection = this.connectionKey;
		const cached = this.#albumList;
		if (!fresh && cached?.connection === connection && Date.now() - cached.at < ALBUM_LIST_CACHE_MS) {
			return cached.albums;
		}

		const { chibisafeUrl, chibisafeApiKey } = this.#settings;
		if (!chibisafeUrl || !chibisafeApiKey) {
			throw new ChibisafeError("enter the server URL and API key first");
		}

		const base = parseServerUrl(chibisafeUrl);
		const albums: ChibisafeAlbum[] = [];
		for (let page = 1; page <= 50; page++) {
			const response = await this.#send(
				new URL(`api/albums?page=${page}&limit=100`, base),
				() => ({ method: "GET", headers: { "x-api-key": chibisafeApiKey } }),
				{ timeout: REQUEST_TIMEOUT_MS },
			);
			const body = json<{ albums?: { uuid?: unknown; name?: unknown }[]; count?: unknown }>(response);
			const batch = (body.albums ?? []).filter((album) => typeof album.uuid === "string");
			albums.push(...batch.map((album) => ({ uuid: String(album.uuid), name: String(album.name ?? album.uuid) })));
			if (batch.length === 0 || albums.length >= Number(body.count ?? 0)) break;
		}
		albums.sort((a, b) => a.name.localeCompare(b.name));
		this.#albumList = { connection, at: Date.now(), albums };
		albums.forEach(({ uuid }) => this.#knownAlbums.set(`${connection}\n${uuid}`, Date.now()));
		return albums;
	}

	/**
	 * Uploads a file and returns its public link. The file is streamed from disk, never read into memory.
	 * @param album UUID of the album to add the file to, or an empty string for none.
	 * @param onProgress Called with 0–1 as the upload progresses.
	 */
	async upload(file: string, album: string, onProgress: (fraction: number) => void): Promise<string> {
		if (!this.enabled) {
			throw new ChibisafeError("Uploading to chibisafe is turned off or not set up");
		}
		if (!isVideoFile(file)) {
			throw new ChibisafeError(`Refusing to upload ${path.basename(file)}: not a video file`);
		}

		try {
			return await this.#upload(file, album, onProgress);
		} catch (error) {
			// Something changed or went wrong; check the server and album afresh next time.
			this.#serverCache = undefined;
			this.#knownAlbums.clear();
			throw error;
		}
	}

	async #upload(file: string, album: string, onProgress: (fraction: number) => void): Promise<string> {
		const base = parseServerUrl(this.#settings.chibisafeUrl);
		const server = await this.#serverSettings(base, CHECK_CACHE_MS);
		// chibisafe never answers an upload into an unknown album, so make sure it exists first.
		const known = this.#knownAlbums.get(`${this.connectionKey}\n${album}`) ?? 0;
		if (album && Date.now() - known >= CHECK_CACHE_MS) {
			await this.#albumName(base, album);
		}

		const { size } = await stat(file);
		if (size === 0) {
			throw new ChibisafeError(`${path.basename(file)} is empty`);
		}
		const clip: Clip = { file, size, name: path.basename(file), type: CONTENT_TYPES[path.extname(file).toLowerCase()] };

		if (server.blockedExtensions.map((ext) => ext.toLowerCase()).includes(path.extname(file).toLowerCase())) {
			throw new ChibisafeError(`The server doesn't accept ${path.extname(file)} files`);
		}

		logger.info(`Uploading ${clip.name} (${formatBytes(size)}) to ${base.origin}`);
		const report = progressReporter(size, onProgress);
		report(0);
		const url = server.useNetworkStorage
			? await this.#uploadToNetworkStorage(base, clip, album, server, report)
			: await this.#uploadInChunks(base, clip, album, server, report);

		if (!/^https?:\/\//i.test(url)) {
			throw new ChibisafeError("The server didn't return a link");
		}
		logger.info(`Uploaded ${clip.name}: ${url}`);
		return url;
	}

	async #uploadInChunks(base: URL, clip: Clip, album: string, server: ServerSettings, report: (done: number) => void): Promise<string> {
		const chunkSize = server.chunkSize > 0 ? server.chunkSize : clip.size;
		const totalChunks = Math.ceil(clip.size / chunkSize);
		if (server.maxSize > 0) {
			// The server rejects chunked uploads when chunkSize × chunks exceeds its limit, so the real
			// limit is the largest whole number of chunks that fits.
			const limit = totalChunks > 1 ? Math.floor(server.maxSize / chunkSize) * chunkSize : server.maxSize;
			if (clip.size > limit) throw tooLarge(clip.size, limit);
		}

		const uuid = randomUUID();
		for (let chunk = 1; chunk <= totalChunks; chunk++) {
			const start = (chunk - 1) * chunkSize;
			const end = Math.min(clip.size, start + chunkSize);
			const boundary = `----rbp-${randomUUID()}`;
			const headers: Record<string, string> = { ...this.#authHeaders(album), "content-type": `multipart/form-data; boundary=${boundary}` };
			if (totalChunks > 1) {
				headers["chibi-uuid"] = uuid;
				headers["chibi-chunks-total"] = String(totalChunks);
				headers["chibi-chunk-number"] = String(chunk);
			}

			// Multipart body, like the browser's FormData, with the file range streamed from disk. The
			// server needs the file name before the file data of the final chunk.
			const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
			const fields = chunk === totalChunks ? field("name", clip.name) + field("type", clip.type) + field("size", String(clip.size)) : "";
			const fileHeader =
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted(clip.name)}"\r\n` +
				`Content-Type: ${totalChunks > 1 ? "application/octet-stream" : clip.type}\r\n\r\n`;
			const prefix = Buffer.byteLength(fields + fileHeader);
			const body: BodyPart[] = [fields + fileHeader, { file: clip.file, start, end }, `\r\n--${boundary}--\r\n`];

			// The final chunk makes the server join and store the file, so it mustn't be sent twice.
			const response = await this.#send(
				new URL("api/upload", base),
				() => ({ method: "POST", headers, body }),
				{ timeout: uploadTimeout(end - start), idempotent: chunk < totalChunks },
				(sent) => report(start + Math.min(end - start, Math.max(0, sent - prefix))),
			);
			if (chunk === totalChunks) {
				return json<{ url?: string }>(response).url ?? "";
			}
		}
		throw new ChibisafeError("Upload ended without a response");
	}

	async #uploadToNetworkStorage(base: URL, clip: Clip, album: string, server: ServerSettings, report: (done: number) => void): Promise<string> {
		if (server.maxSize > 0 && clip.size > server.maxSize) {
			throw tooLarge(clip.size, server.maxSize);
		}

		const signed = await this.#send(
			new URL("api/upload", base),
			() => ({
				method: "POST",
				headers: { ...this.#authHeaders(album), "content-type": "application/json" },
				body: [JSON.stringify({ contentType: clip.type, size: clip.size, name: clip.name })],
			}),
			{ timeout: REQUEST_TIMEOUT_MS },
		);
		const { url: putUrl, identifier } = json<{ url?: string; identifier?: string }>(signed);
		if (!putUrl || !identifier || !/^https?:\/\//i.test(putUrl)) {
			throw new ChibisafeError("The server didn't return an upload URL");
		}

		// The presigned URL points at the storage provider; it must not receive the API key.
		const putHeaders: Record<string, string> = { "content-type": clip.type };
		if (new URL(putUrl).hostname.endsWith("digitaloceanspaces.com")) putHeaders["x-amz-acl"] = "public-read";
		await this.#send(
			new URL(putUrl),
			() => ({ method: "PUT", headers: putHeaders, body: [{ file: clip.file, start: 0, end: clip.size }] }),
			{ timeout: uploadTimeout(clip.size) },
			report,
		);

		const processed = await this.#send(
			new URL("api/upload/process", base),
			() => ({
				method: "POST",
				headers: { ...this.#authHeaders(album), "content-type": "application/json" },
				body: [JSON.stringify({ identifier, name: clip.name, type: clip.type })],
			}),
			// Registers the file; sending it twice could store it twice.
			{ timeout: REQUEST_TIMEOUT_MS, idempotent: false },
		);
		return json<{ url?: string }>(processed).url ?? "";
	}

	#authHeaders(album = ""): Record<string, string> {
		const headers: Record<string, string> = { "x-api-key": this.#settings.chibisafeApiKey };
		if (album) headers.albumuuid = album;
		return headers;
	}

	/**
	 * Sends a request, retrying network errors and temporary server errors. Redirects are never
	 * followed, so the API key can't be forwarded to another host.
	 */
	async #send(url: URL, init: () => HttpRequest, { timeout, idempotent = true }: SendOptions, onBodyProgress?: (sent: number) => void): Promise<HttpResponse> {
		for (let attempt = 1; ; attempt++) {
			let response: HttpResponse;
			try {
				response = await httpRequest(url, init(), timeout, onBodyProgress);
			} catch (error) {
				const reason = isTimeout(error) ? "timed out" : error instanceof Error ? error.message : String(error);
				// Without an answer there's no telling whether the server handled it.
				if (idempotent && attempt < RETRIES) {
					logger.warn(`Request to ${url.origin} failed (${reason}); retrying`);
					await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
					continue;
				}
				throw new ChibisafeError(`Could not reach ${url.origin}: ${reason}`);
			}

			const { status } = response;
			if (status >= 200 && status < 300) {
				return response;
			}
			if (status >= 300 && status < 400) {
				throw new ChibisafeError("The server redirected the request; check the server URL (for example https:// instead of http://)", status);
			}
			const retryable = RETRY_STATUSES.has(status) || (idempotent && AMBIGUOUS_STATUSES.has(status));
			if (retryable && attempt < RETRIES) {
				logger.warn(`${url.origin} answered HTTP ${status}; retrying`);
				await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
				continue;
			}
			if (status === 401) {
				throw new ChibisafeError("chibisafe rejected the API key", 401);
			}
			if (status === 413) {
				throw new ChibisafeError("The clip is too large for the server", 413);
			}
			throw new ChibisafeError(errorMessage(response), status);
		}
	}

	/** The server's upload settings, reused for up to `maxAge` ms (0 always fetches). */
	async #serverSettings(base: URL, maxAge = 0): Promise<ServerSettings> {
		const connection = this.connectionKey;
		const cached = this.#serverCache;
		if (cached?.connection === connection && Date.now() - cached.at < maxAge) {
			return cached.settings;
		}

		const response = await this.#send(new URL("api/settings", base), () => ({ method: "GET" }), { timeout: REQUEST_TIMEOUT_MS });
		const body = json<Partial<ServerSettings>>(response);
		const settings: ServerSettings = {
			chunkSize: Number(body.chunkSize) || 0,
			maxSize: Number(body.maxSize) || 0,
			useNetworkStorage: body.useNetworkStorage === true,
			blockedExtensions: Array.isArray(body.blockedExtensions) ? body.blockedExtensions.map(String) : [],
		};
		this.#serverCache = { connection, at: Date.now(), settings };
		return settings;
	}

	/** Name of an album, or undefined for none. Throws if it doesn't exist in this account. */
	async #albumName(base: URL, album: string): Promise<string | undefined> {
		if (!album) return undefined;
		try {
			const response = await this.#send(
				new URL(`api/album/${encodeURIComponent(album)}`, base),
				() => ({ method: "GET", headers: { "x-api-key": this.#settings.chibisafeApiKey } }),
				{ timeout: REQUEST_TIMEOUT_MS },
			);
			this.#knownAlbums.set(`${this.connectionKey}\n${album}`, Date.now());
			return json<{ name?: string }>(response).name ?? album;
		} catch (error) {
			// Only an answer about the album itself means it's missing; anything else is a server or network problem.
			if (error instanceof ChibisafeError && (error.status === 400 || error.status === 403 || error.status === 404)) {
				throw new ChibisafeError("The selected album wasn't found in this account; pick another album or No album", error.status);
			}
			throw error;
		}
	}

	/** Checks the URL, API key and album, and reports the result for the settings panel. */
	async #verify(): Promise<void> {
		const run = this.#verifyRun;
		const report = (state: ChibisafeStatus["state"], detail: string) => {
			if (run === this.#verifyRun) this.#update({ enabled: this.#settings.chibisafeEnabled, state, detail });
		};

		try {
			const base = parseServerUrl(this.#settings.chibisafeUrl);
			const server = await this.#serverSettings(base);
			const me = await this.#send(new URL("api/user/me", base), () => ({ method: "GET", headers: { "x-api-key": this.#settings.chibisafeApiKey } }), {
				timeout: REQUEST_TIMEOUT_MS,
			});
			const { user } = json<{ user?: { username?: string } }>(me);

			const albumName = await this.#albumName(base, this.#settings.chibisafeAlbum);
			const album = albumName ? ` · album "${albumName}"` : "";

			const limit = server.maxSize > 0 ? ` · clips up to ${formatBytes(server.maxSize)}` : "";
			report("ready", `Connected as ${user?.username ?? "unknown user"}${album}${limit}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`chibisafe check failed: ${message}`);
			report("error", message);
		}
	}

	#update(status: ChibisafeStatus): void {
		if (JSON.stringify(status) === JSON.stringify(this.#status)) {
			return;
		}
		this.#status = status;
		this.#listeners.forEach((listener) => listener(status));
	}
}

export const chibisafe = new ChibisafeClient();
