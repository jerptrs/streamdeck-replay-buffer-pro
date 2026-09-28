import { once } from "node:events";
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";

/**
 * Minimal HTTP client that streams request bodies from disk. Node's fetch() buffers large request
 * bodies in memory (a 1 GB clip used 1 GB of RAM), so uploads go through node:http instead.
 * Redirects are never followed.
 */

/** A piece of a request body: text or bytes, or a byte range of a file that is streamed from disk. */
export type BodyPart = string | Uint8Array | { file: string; start: number; end: number };

export type HttpRequest = {
	method: string;
	headers?: Record<string, string>;
	body?: BodyPart[];
};

export type HttpResponse = { status: number; text: string };

/** Responses are small JSON documents; anything beyond this is cut off. */
const MAX_RESPONSE_BYTES = 1_000_000;

function partLength(part: BodyPart): number {
	if (typeof part === "string") return Buffer.byteLength(part);
	if (part instanceof Uint8Array) return part.byteLength;
	return Math.max(0, part.end - part.start);
}

/**
 * Sends a request and resolves with the response, whatever its status.
 * @param onBodyProgress Called with the number of body bytes sent so far.
 */
export function httpRequest(
	url: URL,
	{ method, headers = {}, body = [] }: HttpRequest,
	timeout: number,
	onBodyProgress?: (sent: number) => void,
): Promise<HttpResponse> {
	const client = url.protocol === "https:" ? https : http;
	const length = body.reduce((sum, part) => sum + partLength(part), 0);
	const requestHeaders = body.length > 0 ? { ...headers, "content-length": String(length) } : headers;

	return new Promise((resolve, reject) => {
		const req = client.request(url, { method, headers: requestHeaders, signal: AbortSignal.timeout(timeout) }, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", reject);
		});
		req.on("error", reject);
		writeBody(req, body, onBodyProgress).catch((error: Error) => req.destroy(error));
	});
}

/** Writes the body with backpressure, so at most a few socket buffers of a file are in memory at once. */
async function writeBody(req: http.ClientRequest, body: BodyPart[], onBodyProgress?: (sent: number) => void): Promise<void> {
	let sent = 0;
	const write = async (chunk: Uint8Array) => {
		if (!req.write(chunk)) await once(req, "drain");
		sent += chunk.byteLength;
		onBodyProgress?.(sent);
	};

	for (const part of body) {
		if (typeof part === "string") {
			await write(Buffer.from(part));
		} else if (part instanceof Uint8Array) {
			await write(part);
		} else if (part.end > part.start) {
			for await (const chunk of createReadStream(part.file, { start: part.start, end: part.end - 1 })) {
				await write(chunk as Buffer);
			}
		}
	}
	req.end();
}

export function isTimeout(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "TimeoutError" || (error.cause instanceof Error && error.cause.name === "TimeoutError");
}
