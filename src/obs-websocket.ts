import { createHash } from "node:crypto";
import WebSocket from "ws";

/**
 * Minimal client for the obs-websocket v5 protocol (built into OBS 28+), covering only what this
 * plugin needs. See https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */

/** Requests this plugin sends, with their request and response data. */
type Requests = {
	GetReplayBufferStatus: [undefined, { outputActive: boolean }];
	ToggleReplayBuffer: [undefined, { outputActive: boolean }];
	StartReplayBuffer: [undefined, undefined];
	StopReplayBuffer: [undefined, undefined];
	GetHotkeyList: [undefined, { hotkeys: string[] }];
	TriggerHotkeyByName: [{ hotkeyName: string }, undefined];
	GetProfileParameter: [{ parameterCategory: string; parameterName: string }, { parameterValue: string | null; defaultParameterValue: string | null }];
};

/** Events this plugin listens to. */
export type ObsEvent =
	| { eventType: "ReplayBufferStateChanged"; eventData: { outputActive: boolean; outputState: string } }
	| { eventType: "ReplayBufferSaved"; eventData: { savedReplayPath: string } }
	| { eventType: "CurrentProfileChanged"; eventData: { profileName: string } };

/** Bit flags selecting which event categories OBS sends. */
export const EventSubscription = {
	General: 1 << 0,
	Config: 1 << 1,
	Outputs: 1 << 6,
} as const;

/** A failed request (obs-websocket request status code) or a closed connection (WebSocket close code). */
export class ObsError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

const OpCode = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;
const RPC_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

type Pending = { resolve: (data: unknown) => void; reject: (error: ObsError) => void; timer: NodeJS.Timeout };

export class ObsWebSocket {
	#ws: WebSocket | undefined;
	#identified = false;
	#nextRequestId = 0;
	readonly #pending = new Map<string, Pending>();

	/** Called for every subscribed event while identified. */
	onEvent: (event: ObsEvent) => void = () => undefined;
	/** Called when an identified connection closes for any reason. */
	onClose: (error: ObsError) => void = () => undefined;

	get identified(): boolean {
		return this.#identified;
	}

	/**
	 * Connects and authenticates. Rejects with the close code, e.g. 4009 for a wrong password.
	 */
	connect(url: string, password: string, eventSubscriptions: number): Promise<{ obsWebSocketVersion: string }> {
		this.disconnect();

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url, "obswebsocket.json", { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
			this.#ws = ws;
			let obsWebSocketVersion = "";

			ws.on("message", (raw) => {
				if (ws !== this.#ws) return;

				let message: { op: number; d: Record<string, any> };
				try {
					message = JSON.parse(raw.toString());
				} catch {
					return;
				}

				const { op, d } = message;
				switch (op) {
					case OpCode.Hello: {
						obsWebSocketVersion = d.obsWebSocketVersion;
						const identify: Record<string, unknown> = { rpcVersion: RPC_VERSION, eventSubscriptions };
						if (d.authentication) {
							identify.authentication = authenticate(password, d.authentication.salt, d.authentication.challenge);
						}
						ws.send(JSON.stringify({ op: OpCode.Identify, d: identify }));
						break;
					}
					case OpCode.Identified:
						this.#identified = true;
						resolve({ obsWebSocketVersion });
						break;
					case OpCode.Event:
						if (this.#identified) this.onEvent(d as ObsEvent);
						break;
					case OpCode.RequestResponse: {
						const pending = this.#pending.get(d.requestId);
						if (!pending) break;
						this.#pending.delete(d.requestId);
						clearTimeout(pending.timer);
						if (d.requestStatus?.result) {
							pending.resolve(d.responseData);
						} else {
							pending.reject(new ObsError(d.requestStatus?.code ?? -1, d.requestStatus?.comment ?? `${d.requestType} failed`));
						}
						break;
					}
				}
			});

			// "error" is always followed by "close"; only the first rejection of the promise counts.
			ws.on("error", (error) => reject(new ObsError(-1, error.message)));
			ws.on("close", (code, reason) => {
				const error = new ObsError(code, reason.toString() || "Connection closed");
				const wasIdentified = this.#identified && ws === this.#ws;
				if (ws === this.#ws) {
					this.#reset(error);
				}
				reject(error);
				if (wasIdentified) this.onClose(error);
			});
		});
	}

	/** Closes the connection without notifying {@link onClose}. */
	disconnect(): void {
		const ws = this.#ws;
		if (!ws) return;
		this.#reset(new ObsError(1000, "Disconnected"));
		ws.terminate();
	}

	call<T extends keyof Requests>(requestType: T, ...[requestData]: Requests[T][0] extends undefined ? [] : [Requests[T][0]]): Promise<Requests[T][1]> {
		const ws = this.#ws;
		if (!ws || !this.#identified) {
			return Promise.reject(new ObsError(-1, "Not connected to OBS"));
		}

		const requestId = String(++this.#nextRequestId);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				reject(new ObsError(-1, `${requestType} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.#pending.set(requestId, { resolve: resolve as (data: unknown) => void, reject, timer });
			ws.send(JSON.stringify({ op: OpCode.Request, d: { requestType, requestId, requestData } }));
		});
	}

	#reset(error: ObsError): void {
		this.#ws = undefined;
		this.#identified = false;
		for (const { reject, timer } of this.#pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		this.#pending.clear();
	}
}

/** obs-websocket challenge response: base64(sha256(base64(sha256(password + salt)) + challenge)). */
function authenticate(password: string, salt: string, challenge: string): string {
	const secret = createHash("sha256").update(password + salt).digest("base64");
	return createHash("sha256").update(secret + challenge).digest("base64");
}
