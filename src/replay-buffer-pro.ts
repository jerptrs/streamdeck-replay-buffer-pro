import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Replay Buffer Pro (https://github.com/JoshuaPotter/replay-buffer-pro) registers one OBS hotkey
 * per save button, named `ReplayBufferPro.SaveButton1` … `SaveButton6`. obs-websocket's
 * `TriggerHotkeyByName` runs a hotkey's action directly, so no key needs to be bound in OBS.
 */
export const HOTKEY_PREFIX = "ReplayBufferPro.SaveButton";

/** Replay Buffer Pro's default button durations (seconds), in slot order. */
const DEFAULT_DURATIONS = [15, 30, 60, 300, 900, 1800] as const;
const SLOT_COUNT = DEFAULT_DURATIONS.length;

/** Replay Buffer Pro clamps custom durations to OBS's maximum replay buffer length (6 hours). */
const MAX_DURATION = 21600;

/** "auto" matches the key's duration against Replay Buffer Pro's buttons; "1"–"6" picks a button explicitly. */
export type SlotSetting = "auto" | `${number}`;

type SlotResolution =
	| { ok: true; slot: number; hotkeyName: string; detail: string }
	| { ok: false; detail: string };

function hotkeyName(slot: number): string {
	return `${HOTKEY_PREFIX}${slot}`;
}

/** Replay Buffer Pro's settings file (`obs_module_config_path`) in OBS's config folder. */
function configFile(): string {
	const obsConfig =
		process.platform === "win32"
			? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "obs-studio")
			: process.platform === "darwin"
				? path.join(os.homedir(), "Library", "Application Support", "obs-studio")
				: // Stream Deck doesn't run on Linux; this path lets the tests run there.
					path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "obs-studio");
	return path.join(obsConfig, "plugin_config", "replay-buffer-pro", "save_button_settings.json");
}

/**
 * Reads the durations the user configured via Replay Buffer Pro's "Customize" dialog. Returns
 * undefined when the file doesn't exist, which means the defaults are in use. Mirrors Replay Buffer
 * Pro's own normalisation so slots line up with what OBS shows.
 */
async function readConfiguredDurations(): Promise<number[] | undefined> {
	let raw: string;
	try {
		raw = await readFile(configFile(), "utf8");
	} catch {
		return undefined;
	}

	const durations: number[] = [...DEFAULT_DURATIONS];
	try {
		const parsed = JSON.parse(raw) as { save_buttons?: { seconds?: unknown }[] };
		parsed.save_buttons?.slice(0, SLOT_COUNT).forEach((button, index) => {
			const seconds = Math.trunc(Number(button?.seconds ?? 0));
			durations[index] = Math.max(1, Math.min(Number.isFinite(seconds) ? seconds : 1, MAX_DURATION));
		});
	} catch {
		// Replay Buffer Pro falls back to its defaults when the file is unreadable, so do the same.
	}
	return durations;
}

export function formatDuration(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600} h`;
	if (seconds % 60 === 0 && seconds >= 120) return `${seconds / 60} min`;
	return `${seconds} sec`;
}

/**
 * Works out which Replay Buffer Pro button saves `duration` seconds.
 * @param obsIsLocal Only trust the local config file when OBS runs on this computer.
 */
export async function resolveSlot(duration: number, setting: SlotSetting | undefined, obsIsLocal: boolean): Promise<SlotResolution> {
	const manual = Number(setting);
	if (setting && setting !== "auto" && Number.isInteger(manual) && manual >= 1 && manual <= SLOT_COUNT) {
		return { ok: true, slot: manual, hotkeyName: hotkeyName(manual), detail: `Uses Replay Buffer Pro button ${manual} (set manually).` };
	}

	const configured = obsIsLocal ? await readConfiguredDurations() : undefined;
	const durations = configured ?? [...DEFAULT_DURATIONS];
	const index = durations.indexOf(duration);

	if (index === -1) {
		return {
			ok: false,
			detail:
				`None of your Replay Buffer Pro buttons saves ${formatDuration(duration)} ` +
				`(they are set to ${durations.map(formatDuration).join(", ")}). ` +
				`Add it via "Customize" in OBS's Replay Buffer Pro dock, or pick a button below.`,
		};
	}

	const source = configured ? "your Replay Buffer Pro buttons" : "Replay Buffer Pro's default buttons";
	return {
		ok: true,
		slot: index + 1,
		hotkeyName: hotkeyName(index + 1),
		detail: `Auto: button ${index + 1} of ${source} saves ${formatDuration(duration)}.`,
	};
}
