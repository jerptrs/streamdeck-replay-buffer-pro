import streamDeck from "@elgato/streamdeck";
import os from "node:os";

import { EventSubscription, ObsError, type ObsEvent, ObsWebSocket } from "./obs-websocket";
import {
	describeProblem,
	detectReplayBufferPro,
	isUnregistered,
	type ReplayBufferProState,
	requestSaveClip,
	type SaveClipResult,
} from "./replay-buffer-pro";

const logger = streamDeck.logger.createScope("OBS");

/** Connection details stored in the plugin's global settings (edited in the property inspector). */
export type ObsSettings = {
	host?: string;
	port?: string;
	password?: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "auth-failed";

/** Replay buffer output state; "unavailable" means the replay buffer is disabled in OBS's output settings. */
type ReplayState = "unknown" | "stopped" | "starting" | "started" | "stopping" | "unavailable";

type ObsStatus = {
	connection: ConnectionState;
	replay: ReplayState;
	/** Whether Replay Buffer Pro 1.8.0 or newer is loaded in OBS. */
	replayBufferPro: ReplayBufferProState;
	/** Human-readable reason for the last connection problem, if any. */
	error?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4455;
/**
 * While OBS isn't reachable, retries start after 5 seconds and double up to once a minute. Pressing a
 * key still retries immediately, so a closed OBS costs one local connection attempt a minute at most.
 */
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const AUTH_RETRY_DELAY_MS = 30_000;
const SETTINGS_DEBOUNCE_MS = 500;

/** obs-websocket close code sent when the password is wrong or missing. */
const CLOSE_AUTHENTICATION_FAILED = 4009;

const OUTPUT_STATES: Record<string, ReplayState> = {
	OBS_WEBSOCKET_OUTPUT_STARTING: "starting",
	OBS_WEBSOCKET_OUTPUT_STARTED: "started",
	OBS_WEBSOCKET_OUTPUT_STOPPING: "stopping",
	OBS_WEBSOCKET_OUTPUT_STOPPED: "stopped",
};

/**
 * Keeps a single obs-websocket (v5, built into OBS 28+) connection alive, reconnecting whenever OBS
 * restarts, and tracks the replay buffer state for the actions.
 */
class ObsClient {
	readonly socket = new ObsWebSocket();

	#settings: Required<ObsSettings> = { host: DEFAULT_HOST, port: String(DEFAULT_PORT), password: "" };
	#status: ObsStatus = { connection: "disconnected", replay: "unknown", replayBufferPro: "unknown" };
	#reconnectTimer: NodeJS.Timeout | undefined;
	#settingsTimer: NodeJS.Timeout | undefined;
	#started = false;
	/** Incremented on every connect attempt so late results from an abandoned attempt are ignored. */
	#attempt = 0;
	/** Failed connection attempts in a row, for the reconnect backoff. */
	#failures = 0;

	readonly #statusListeners = new Set<(status: ObsStatus) => void>();
	readonly #savedListeners = new Set<(path: string) => void>();

	constructor() {
		this.socket.onClose = (error) => this.#onClosed(error);
		this.socket.onEvent = (event) => this.#onEvent(event);
	}

	get status(): Readonly<ObsStatus> {
		return this.#status;
	}

	get connected(): boolean {
		return this.#status.connection === "connected";
	}

	/** True when OBS runs on this computer, so the clips it saves can be read from disk. */
	get isLocal(): boolean {
		const host = this.#settings.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
		if (["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()].includes(host)) {
			return true;
		}
		return Object.values(os.networkInterfaces()).some((addresses) => addresses?.some((address) => address.address.toLowerCase() === host));
	}

	onStatusChange(listener: (status: ObsStatus) => void): void {
		this.#statusListeners.add(listener);
	}

	onReplaySaved(listener: (path: string) => void): void {
		this.#savedListeners.add(listener);
	}

	/** Applies new connection settings, reconnecting if they changed. */
	configure(settings: ObsSettings): void {
		const next: Required<ObsSettings> = {
			host: settings.host?.trim() || DEFAULT_HOST,
			port: String(settings.port ?? "").trim() || String(DEFAULT_PORT),
			password: settings.password ?? "",
		};

		const changed = next.host !== this.#settings.host || next.port !== this.#settings.port || next.password !== this.#settings.password;
		this.#settings = next;

		if (!this.#started) {
			this.#started = true;
			void this.#connect();
		} else if (changed) {
			// The property inspector saves on every keystroke; wait until typing settles.
			clearTimeout(this.#settingsTimer);
			this.#settingsTimer = setTimeout(() => {
				// New settings deserve a quick retry schedule again.
				this.#failures = 0;
				void this.#connect();
			}, SETTINGS_DEBOUNCE_MS);
		}
	}

	/** Retries immediately instead of waiting for the next scheduled attempt (e.g. when a key is pressed while offline). */
	retryNow(): void {
		if (this.#status.connection === "disconnected" || this.#status.connection === "auth-failed") {
			void this.#connect();
		}
	}

	/** Re-reads the replay buffer state from OBS. */
	async refreshReplayState(): Promise<void> {
		if (!this.connected) {
			return;
		}

		try {
			const { outputActive } = await this.socket.call("GetReplayBufferStatus");
			this.#update({ replay: outputActive ? "started" : "stopped" });
		} catch (error) {
			// obs-websocket refuses the request when the replay buffer isn't enabled in Settings → Output.
			logger.warn(`Replay buffer unavailable: ${describe(error)}`);
			this.#update({ replay: "unavailable" });
		}
	}

	/**
	 * Asks Replay Buffer Pro to save the last `seconds`. When it's missing or too old, fails with that
	 * explanation, which also ends up in the status.
	 */
	async saveClip(seconds: number): Promise<SaveClipResult> {
		try {
			const result = await requestSaveClip(this.socket, seconds);
			// Replay Buffer Pro answered, so it's up to date even if OBS was restarted with a new version.
			this.#update({ replayBufferPro: "ready" });
			return result;
		} catch (error) {
			if (!isUnregistered(error)) throw error;
			throw new Error(describeProblem(await this.checkReplayBufferPro()) ?? describe(error));
		}
	}

	/** Checks whether Replay Buffer Pro can save clips, and records the result in the status. */
	async checkReplayBufferPro(): Promise<ReplayBufferProState> {
		try {
			const state = await detectReplayBufferPro(this.socket);
			this.#update({ replayBufferPro: state });
			return state;
		} catch (error) {
			logger.warn(`Could not check for Replay Buffer Pro: ${describe(error)}`);
			return this.#status.replayBufferPro;
		}
	}

	async #connect(): Promise<void> {
		clearTimeout(this.#reconnectTimer);
		const attempt = ++this.#attempt;
		const { host, port, password } = this.#settings;

		const portNumber = Number(port);
		if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
			this.socket.disconnect();
			this.#update({ connection: "disconnected", replay: "unknown", error: `Invalid port "${port}"` });
			return;
		}

		const url = `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${portNumber}`;
		this.#update({ connection: "connecting", replay: "unknown", error: undefined });
		try {
			const { obsWebSocketVersion } = await this.socket.connect(
				url,
				password,
				EventSubscription.General | EventSubscription.Config | EventSubscription.Outputs,
			);
			if (attempt !== this.#attempt) {
				return;
			}

			logger.info(`Connected to obs-websocket ${obsWebSocketVersion} at ${url}`);
			this.#failures = 0;
			this.#update({ connection: "connected" });
			await Promise.all([this.refreshReplayState(), this.checkReplayBufferPro()]);
		} catch (error) {
			if (attempt !== this.#attempt) {
				return;
			}

			const authFailed = error instanceof ObsError && error.code === CLOSE_AUTHENTICATION_FAILED;
			const message = authFailed ? "Wrong or missing OBS WebSocket password" : describe(error);
			logger.debug(`Connection to ${url} failed: ${message}`);
			this.#update({ connection: authFailed ? "auth-failed" : "disconnected", replay: "unknown", error: message });
			this.#failures++;
			const backoff = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** (this.#failures - 1));
			this.#scheduleReconnect(authFailed ? Math.max(AUTH_RETRY_DELAY_MS, backoff) : backoff);
		}
	}

	#onEvent({ eventType, eventData }: ObsEvent): void {
		switch (eventType) {
			case "ReplayBufferStateChanged":
				this.#update({ replay: OUTPUT_STATES[eventData.outputState] ?? "unknown" });
				break;
			case "ReplayBufferSaved":
				logger.info(`Replay saved: ${eventData.savedReplayPath}`);
				this.#savedListeners.forEach((listener) => listener(eventData.savedReplayPath));
				break;
			case "CurrentProfileChanged":
				// Switching profile can enable or disable the replay buffer entirely.
				void this.refreshReplayState();
				break;
		}
	}

	/** The connection dropped after it was established; failed connects are handled in #connect. */
	#onClosed(error: ObsError): void {
		logger.info(`Disconnected from OBS: ${describe(error)}`);
		this.#update({ connection: "disconnected", replay: "unknown", error: "OBS closed the connection" });
		this.#scheduleReconnect(RECONNECT_DELAY_MS);
	}

	#scheduleReconnect(delay: number): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => void this.#connect(), delay);
	}

	#update(patch: Partial<ObsStatus>): void {
		const next = { ...this.#status, ...patch };
		if (JSON.stringify(next) === JSON.stringify(this.#status)) {
			return;
		}

		this.#status = next;
		this.#statusListeners.forEach((listener) => listener(next));
	}
}

export function describe(error: unknown): string {
	if (error instanceof ObsError && error.code >= 0) {
		return `${error.message} (code ${error.code})`;
	}
	return error instanceof Error ? error.message : String(error);
}

export const obs = new ObsClient();
