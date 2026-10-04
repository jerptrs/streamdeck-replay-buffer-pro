import { ObsError, type ObsWebSocket } from "./obs-websocket";

/**
 * Replay Buffer Pro (https://github.com/JoshuaPotter/replay-buffer-pro) 1.8.0 and newer registers an
 * obs-websocket vendor request, `SaveClip`, that saves the last N seconds (1 to 21600) through the same
 * save-and-trim path as its dock buttons. The keys use it, so nothing needs setting up in OBS.
 */
const VENDOR_NAME = "replay-buffer-pro";
const SAVE_CLIP = "SaveClip";

/**
 * Every Replay Buffer Pro version registers these save button hotkeys. Finding them without the
 * `SaveClip` request means a version older than 1.8.0 is installed.
 */
const HOTKEY_PREFIX = "ReplayBufferPro.SaveButton";

/** obs-websocket's request status when no vendor or vendor request has the given name. */
const RESOURCE_NOT_FOUND = 600;

/** "ready": 1.8.0 or newer is loaded; "outdated": an older version is; "missing": none is. */
export type ReplayBufferProState = "unknown" | "ready" | "outdated" | "missing";

/** `clamped` means the buffer was shorter than requested, so the whole buffer is saved instead. */
export type SaveClipResult = { accepted: true; durationSeconds: number; clamped: boolean } | { accepted: false; error: string };

const PROBLEMS: Partial<Record<ReplayBufferProState, string>> = {
	outdated: "Replay Buffer Pro is older than 1.8.0; update it in OBS",
	missing: "Replay Buffer Pro is not installed or not loaded in OBS",
};

/** Replay Buffer Pro's reasons for not saving. */
const REFUSALS: Record<string, string> = {
	"invalid-duration": "the clip length must be 1 second to 6 hours",
	"buffer-inactive": "the replay buffer is not running",
	"save-refused": "OBS can't save right now (is recording paused?)",
	unavailable: "OBS is shutting down",
};

/**
 * Asks Replay Buffer Pro to save the last `seconds`. Accepted means the save has started; OBS reports
 * the file later with its ReplayBufferSaved event.
 */
export async function requestSaveClip(socket: ObsWebSocket, seconds: number): Promise<SaveClipResult> {
	const { responseData: data = {} } = await socket.call("CallVendorRequest", {
		vendorName: VENDOR_NAME,
		requestType: SAVE_CLIP,
		requestData: { durationSeconds: seconds },
	});
	return data.accepted === true
		? { accepted: true, durationSeconds: Number(data.durationSeconds) || seconds, clamped: data.clamped === true }
		: { accepted: false, error: String(data.error ?? "no reason given") };
}

/** True when the request failed because Replay Buffer Pro's `SaveClip` isn't registered in OBS. */
export function isUnregistered(error: unknown): boolean {
	return error instanceof ObsError && error.code === RESOURCE_NOT_FOUND;
}

/**
 * Finds out whether Replay Buffer Pro can save clips. A 0 second clip is refused before anything is
 * saved, which makes it a safe way to check that the request exists.
 */
export async function detectReplayBufferPro(socket: ObsWebSocket): Promise<ReplayBufferProState> {
	try {
		await requestSaveClip(socket, 0);
		return "ready";
	} catch (error) {
		if (!isUnregistered(error)) throw error;
	}
	const { hotkeys } = await socket.call("GetHotkeyList");
	return hotkeys.some((name) => name.startsWith(HOTKEY_PREFIX)) ? "outdated" : "missing";
}

/** What's wrong when Replay Buffer Pro can't save clips, or undefined when nothing is. */
export function describeProblem(state: ReplayBufferProState): string | undefined {
	return PROBLEMS[state];
}

export function describeRefusal(error: string): string {
	return `Replay Buffer Pro didn't save: ${REFUSALS[error] ?? error}`;
}

export function formatDuration(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600} h`;
	if (seconds % 60 === 0 && seconds >= 120) return `${seconds / 60} min`;
	return `${seconds} sec`;
}
