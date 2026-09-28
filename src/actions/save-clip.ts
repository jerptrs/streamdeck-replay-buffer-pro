import streamDeck, {
	action,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { chibisafe } from "../chibisafe";
import { SAVE_DURATIONS, saveKeyName, type SaveDuration, type SaveVariant, uploadKeyName, type UploadVariant } from "../icons";
import { keyImage } from "../key-images";
import { describe, obs } from "../obs";
import { formatDuration, resolveSlot, type SlotSetting } from "../replay-buffer-pro";
import { uploadClip, waitForTrimmedClip } from "../upload";

const logger = streamDeck.logger.createScope("SaveClip");

/** How long the "SAVED" face stays up. */
const SAVED_FLASH_MS = 1_500;
/** How long the "LINK COPIED" face stays up. */
const COPIED_FLASH_MS = 2_500;
/**
 * Give up waiting for OBS's "replay saved" event after this long. OBS always writes the whole buffer
 * before Replay Buffer Pro trims it, which can take a while with long buffers.
 */
const SAVE_TIMEOUT_MS = 120_000;

/** Per-key album value meaning "no album", even when the on/off key sets a default album. */
export const NO_ALBUM = "none";

export type SaveClipSettings = {
	/** Which Replay Buffer Pro button to trigger; see {@link SlotSetting}. */
	slot?: SlotSetting;
	/** Upload this key's clips to chibisafe when uploading is on globally. Defaults to true. */
	upload?: boolean;
	/** chibisafe album for this key's clips: unset or empty uses the default album, {@link NO_ALBUM} uses none. */
	album?: string;
};

/** A temporary key face that replaces the normal one while a save or upload is in progress. */
type Transient = {
	state: "saving" | "saved" | "uploading" | "copied";
	/** Whether the clip gets uploaded once OBS reports the save; decided when the key is pressed. */
	upload?: boolean;
	/** The album the clip goes into (empty for none); also decided when the key is pressed. */
	album?: string;
	/** Upload progress from 0 to 1. */
	progress?: number;
	/** Saves reported since the press that are still waiting for Replay Buffer Pro's trim. */
	pendingTrims?: number;
	timer?: NodeJS.Timeout;
};

/**
 * Saves the last N seconds of the replay buffer by triggering the matching Replay Buffer Pro hotkey
 * through obs-websocket, then shows "SAVING" until OBS reports the file was written. When uploading
 * is on, the trimmed clip then goes to chibisafe and its link to the clipboard.
 */
abstract class SaveClipAction extends SingletonAction<SaveClipSettings> {
	abstract readonly duration: SaveDuration;

	readonly #transient = new Map<string, Transient>();
	readonly #lastImage = new Map<string, string>();

	constructor() {
		super();
		obs.onStatusChange((status) => {
			// A stopped buffer or lost connection means the pending save isn't coming.
			// Uploads keep going: the file is already on disk.
			if (status.connection !== "connected" || status.replay !== "started") {
				for (const [id, { state, timer }] of this.#transient) {
					if (state === "saving") {
						clearTimeout(timer);
						this.#transient.delete(id);
					}
				}
			}
			this.#renderAll();
		});
		obs.onReplaySaved((savedReplayPath) => {
			for (const [id, transient] of this.#transient) {
				if (transient.state !== "saving") continue;
				if (transient.upload) {
					this.#awaitTrim(id, transient, savedReplayPath);
				} else {
					this.#setTransient(id, { state: "saved" }, SAVED_FLASH_MS);
				}
			}
		});
	}

	override onWillAppear(ev: WillAppearEvent<SaveClipSettings>): Promise<void> | void {
		this.#lastImage.delete(ev.action.id);
		if (ev.action.isKey()) {
			return this.#render(ev.action);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<SaveClipSettings>): void {
		clearTimeout(this.#transient.get(ev.action.id)?.timer);
		this.#transient.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<SaveClipSettings>): Promise<void> {
		const label = formatDuration(this.duration);

		if (!obs.connected) {
			logger.warn(`Save ${label}: OBS is not connected`);
			obs.retryNow();
			return ev.action.showAlert();
		}

		if (obs.status.replay !== "started") {
			logger.warn(`Save ${label}: the replay buffer is not running`);
			return ev.action.showAlert();
		}

		// Replay Buffer Pro refuses clips longer than the buffer with a pop-up in OBS; catch it here instead.
		const bufferLength = await obs.getReplayBufferLength();
		if (bufferLength !== undefined && this.duration > bufferLength) {
			logger.warn(`Save ${label}: the replay buffer only holds ${bufferLength} seconds; increase it in OBS`);
			return ev.action.showAlert();
		}

		const slot = await resolveSlot(this.duration, ev.payload.settings.slot, obs.isLocal);
		if (!slot.ok) {
			logger.warn(`Save ${label}: ${slot.detail}`);
			return ev.action.showAlert();
		}

		let upload = chibisafe.enabled && ev.payload.settings.upload !== false;
		if (upload && !obs.isLocal) {
			logger.warn(`Save ${label}: not uploading, because the clip is saved on another computer (OBS isn't local)`);
			upload = false;
		}

		try {
			await obs.socket.call("TriggerHotkeyByName", { hotkeyName: slot.hotkeyName });
			logger.info(`Save ${label}: triggered ${slot.hotkeyName}${upload ? ", will upload to chibisafe" : ""}`);
		} catch (error) {
			const missing = !(await obs.detectReplayBufferPro());
			logger.error(`Save ${label}: ${missing ? "Replay Buffer Pro is not installed or not loaded in OBS" : describe(error)}`);
			return ev.action.showAlert();
		}

		const { album: keyAlbum } = ev.payload.settings;
		const album = keyAlbum === NO_ALBUM ? "" : keyAlbum || chibisafe.album;
		this.#setTransient(ev.action.id, { state: "saving", upload, album }, SAVE_TIMEOUT_MS);
	}

	/**
	 * Waits for Replay Buffer Pro to trim a reported save, then uploads it. OBS also reports saves this
	 * plugin didn't ask for (its own Save Replay hotkey), which Replay Buffer Pro never trims and may
	 * report before ours, so every save reported while the key waits is a candidate: the first trimmed
	 * one is uploaded, and the key only fails once all of them have.
	 */
	#awaitTrim(id: string, transient: Transient, savedReplayPath: string): void {
		// The save arrived; from here the trim has its own time limit.
		clearTimeout(transient.timer);
		transient.timer = undefined;
		transient.pendingTrims = (transient.pendingTrims ?? 0) + 1;
		const waiting = () => this.#transient.get(id) === transient;

		waitForTrimmedClip(savedReplayPath).then(
			(clip) => waiting() && this.#upload(id, clip, transient.album ?? ""),
			(error: unknown) => {
				transient.pendingTrims = (transient.pendingTrims ?? 1) - 1;
				if (waiting() && transient.pendingTrims === 0) void this.#fail(id, error);
			},
		);
	}

	#upload(id: string, clip: string, album: string): void {
		const transient: Transient = { state: "uploading", progress: 0 };
		this.#setTransient(id, transient);
		// A later press replaces this key's transient; the upload still finishes but no longer drives the face.
		const current = () => this.#transient.get(id) === transient;

		uploadClip(clip, album, (progress) => {
			if (!current()) return;
			transient.progress = progress;
			this.#renderAll();
		}).then(
			() => current() && this.#setTransient(id, { state: "copied" }, COPIED_FLASH_MS),
			(error: unknown) => (current() ? this.#fail(id, error) : this.#logUploadError(error)),
		);
	}

	/** Ends the key's save or upload with the Stream Deck warning triangle. */
	async #fail(id: string, error: unknown): Promise<void> {
		this.#logUploadError(error);
		this.#transient.delete(id);
		this.#renderAll();
		const action = this.actions.find((a) => a.id === id);
		if (action?.isKey()) await action.showAlert();
	}

	#logUploadError(error: unknown): void {
		logger.error(`Upload ${formatDuration(this.duration)}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/** Shows a temporary face; with a duration it reverts to the normal face afterwards. */
	#setTransient(id: string, transient: Transient, duration?: number): void {
		clearTimeout(this.#transient.get(id)?.timer);
		if (duration !== undefined) {
			transient.timer = setTimeout(() => {
				if (transient.state === "saving") {
					logger.warn(`No "replay saved" event from OBS within ${SAVE_TIMEOUT_MS / 1000} seconds`);
				}
				if (this.#transient.get(id) === transient) this.#transient.delete(id);
				this.#renderAll();
			}, duration);
		}
		this.#transient.set(id, transient);
		this.#renderAll();
	}

	#renderAll(): void {
		this.actions.forEach((action) => action.isKey() && void this.#render(action));
	}

	async #render(action: KeyAction<SaveClipSettings>): Promise<void> {
		const image = keyImage(this.#faceName(this.#transient.get(action.id)));
		if (this.#lastImage.get(action.id) !== image) {
			this.#lastImage.set(action.id, image);
			await action.setImage(image);
		}
	}

	#faceName(transient: Transient | undefined): string {
		switch (transient?.state) {
			case "uploading":
				return uploadKeyName(Math.min(90, Math.floor((transient.progress ?? 0) * 10) * 10) as UploadVariant);
			case "copied":
				return uploadKeyName("copied");
			case "saving":
			case "saved":
				return saveKeyName(this.duration, transient.state);
		}

		const { connection, replay } = obs.status;
		const variant: SaveVariant = connection !== "connected" ? "offline" : replay === "started" ? "ready" : "inactive";
		return saveKeyName(this.duration, variant);
	}
}

function createSaveAction(duration: SaveDuration): SaveClipAction {
	@action({ UUID: `com.replay-buffer-pro.obs.save-${duration}` })
	class SaveClip extends SaveClipAction {
		readonly duration = duration;
	}
	return new SaveClip();
}

/** One action per clip length, e.g. `com.replay-buffer-pro.obs.save-15` for the last 15 seconds. */
export const saveActions = SAVE_DURATIONS.map(createSaveAction);
