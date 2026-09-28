import streamDeck from "@elgato/streamdeck";
import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";

import { chibisafe, ChibisafeError } from "./chibisafe";
import { copyToClipboard } from "./clipboard";

const logger = streamDeck.logger.createScope("Upload");

/** Give up waiting for Replay Buffer Pro's trimmed clip after this long. */
const TRIM_TIMEOUT_MS = 120_000;
const TRIM_POLL_MS = 250;

type Job = { promise: Promise<string>; listeners: Set<(fraction: number) => void> };

/** One job per clip and album, so keys whose presses were folded into one save share one upload. */
const jobs = new Map<string, Job>();

/**
 * Uploads a trimmed clip to chibisafe and copies the link to the clipboard. Resolves with the link.
 * @param album UUID of the album to add the clip to, or an empty string for none.
 */
export function uploadClip(clip: string, album: string, onProgress: (fraction: number) => void): Promise<string> {
	const key = `${clip}\n${album}`;
	let job = jobs.get(key);
	if (!job) {
		const listeners = new Set<(fraction: number) => void>();
		const promise = upload(clip, album, (fraction) => listeners.forEach((listener) => listener(fraction))).finally(() => jobs.delete(key));
		job = { promise, listeners };
		jobs.set(key, job);
	}
	job.listeners.add(onProgress);
	return job.promise;
}

async function upload(clip: string, album: string, onProgress: (fraction: number) => void): Promise<string> {
	const link = await chibisafe.upload(clip, album, onProgress);
	await copyToClipboard(link);
	logger.info(`Copied ${link} to the clipboard`);
	return link;
}

/**
 * Waits for Replay Buffer Pro to trim a replay buffer save and resolves with the trimmed clip.
 *
 * Replay Buffer Pro writes the trim to `<name>.rbp-partial<ext>`, verifies it, and only then renames it
 * to `<name>_trimmed<ext>`; on failure it deletes the partial file and keeps the original. See
 * getTrimmedOutputPath() and getPartialOutputPath() in its replay-buffer-manager.cpp. Saves it didn't
 * request (OBS's own Save Replay hotkey) are never trimmed, so this times out for them.
 *
 * @param savedReplayPath The full-length file OBS reported in its "replay saved" event.
 */
export async function waitForTrimmedClip(savedReplayPath: string): Promise<string> {
	const { dir, name, ext } = path.parse(savedReplayPath);
	const trimmed = path.join(dir, `${name}_trimmed${ext}`);
	const partial = path.join(dir, `${name}.rbp-partial${ext}`);

	// Polling alone can miss a trim that fails within one interval, so also watch the folder for the
	// partial file coming and going. Some drives don't support watching; polling still covers those.
	let sawPartial = false;
	let wake: () => void = () => undefined;
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(dir, (_, file) => {
			if (file === path.basename(partial)) sawPartial = true;
			if (file === path.basename(partial) || file === path.basename(trimmed)) wake();
		});
		watcher.on("error", () => watcher?.close());
	} catch {
		watcher = undefined;
	}

	try {
		const deadline = Date.now() + TRIM_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (existsSync(trimmed)) {
				return trimmed;
			}
			if (existsSync(partial)) {
				sawPartial = true;
			} else if (sawPartial) {
				// Gone: either just renamed to the trimmed clip, or deleted because the trim failed.
				if (existsSync(trimmed)) return trimmed;
				break;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, TRIM_POLL_MS);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
	} finally {
		watcher?.close();
	}

	throw new ChibisafeError(`Replay Buffer Pro didn't produce a trimmed clip for ${path.basename(savedReplayPath)}, so nothing was uploaded (check the OBS log)`);
}
