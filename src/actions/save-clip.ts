import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { chibisafe } from "../chibisafe";
import {
	CUSTOM_DEFAULT_ACCENT,
	CUSTOM_DEFAULT_LENGTH,
	customSaveKeySvg,
	type KeyLength,
	type LengthUnit,
	SAVE_DURATIONS,
	saveKeyName,
	type SaveDuration,
	type SaveVariant,
	uploadKeyName,
	type UploadVariant,
} from "../icons";
import { keyImage, svgImage } from "../key-images";
import { describe, obs } from "../obs";
import { describeRefusal, formatDuration, type SaveClipResult } from "../replay-buffer-pro";
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

export const CUSTOM_SAVE_UUID = "com.replay-buffer-pro.obs.save-custom";

export type SaveClipSettings = {
	/** Upload this key's clips to chibisafe when uploading is on globally. Defaults to true. */
	upload?: boolean;
	/** chibisafe album for this key's clips: unset or empty uses the default album, {@link NO_ALBUM} uses none. */
	album?: string;
	/** Custom length keys: the length as typed, a whole number of `unit`s. */
	length?: string;
	unit?: LengthUnit;
	/** Custom length keys: the accent colour, as `#rrggbb`. */
	color?: string;
};

const UNIT_SECONDS: Record<LengthUnit, number> = { sec: 1, min: 60, h: 3600 };
/** Replay Buffer Pro saves 1 second to 6 hours. */
const MAX_SECONDS = 21_600;

type CustomLength = { ok: true; length: KeyLength; seconds: number; detail: string } | { ok: false; detail: string };

/** A custom length key's length, with the defaults its settings panel shows for anything not set yet. */
export function customLength({ length, unit }: SaveClipSettings): CustomLength {
	const validUnit = unit && Object.hasOwn(UNIT_SECONDS, unit) ? unit : CUSTOM_DEFAULT_LENGTH.unit;
	const text = String(length ?? CUSTOM_DEFAULT_LENGTH.value).trim();
	const value = /^\d{1,5}$/.test(text) ? Number(text) : 0;
	const seconds = value * UNIT_SECONDS[validUnit];
	if (value < 1 || seconds > MAX_SECONDS) {
		return { ok: false, detail: "Enter a whole number, from 1 second up to 6 hours." };
	}
	return { ok: true, length: { value, unit: validUnit }, seconds, detail: `Saves the last ${value} ${validUnit}.` };
}

/** The settings' colour, if it's a valid `#rrggbb` (it ends up in the key's SVG). */
function accentOf({ color }: SaveClipSettings): string {
	return color && /^#[0-9a-f]{6}$/i.test(color) ? color : CUSTOM_DEFAULT_ACCENT;
}

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
 * Saves the last N seconds of the replay buffer with Replay Buffer Pro's `SaveClip` request through
 * obs-websocket, then shows "SAVING" until OBS reports the file was written. When uploading is on, the
 * trimmed clip then goes to chibisafe and its link to the clipboard.
 */
abstract class SaveClipAction extends SingletonAction<SaveClipSettings> {
	/** The clip length in seconds, or undefined when a custom key's length isn't valid. */
	protected abstract secondsOf(settings: SaveClipSettings): number | undefined;
	/** The image for a save face (ready, inactive, offline, saving or saved). */
	protected abstract saveFace(settings: SaveClipSettings, variant: SaveVariant): string;

	readonly #transient = new Map<string, Transient>();
	readonly #lastImage = new Map<string, string>();
	/** Each key's settings, which custom length keys are drawn from. */
	readonly #settings = new Map<string, SaveClipSettings>();

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
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#lastImage.delete(ev.action.id);
		if (ev.action.isKey()) {
			return this.#render(ev.action);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<SaveClipSettings>): void {
		clearTimeout(this.#transient.get(ev.action.id)?.timer);
		this.#transient.delete(ev.action.id);
		this.#settings.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SaveClipSettings>): Promise<void> | void {
		// A custom key's face follows its length and colour while they're being edited.
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			return this.#render(ev.action);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<SaveClipSettings>): Promise<void> {
		const { settings } = ev.payload;
		this.#settings.set(ev.action.id, settings);
		const seconds = this.secondsOf(settings);
		const label = this.#label(settings);

		if (seconds === undefined) {
			logger.warn(`Save: ${customLength(settings).detail} (in the key's settings)`);
			return ev.action.showAlert();
		}

		if (!obs.connected) {
			logger.warn(`Save ${label}: ${obs.status.connection === "loading" ? "OBS is still starting" : "OBS is not connected"}`);
			obs.retryNow();
			return ev.action.showAlert();
		}

		if (obs.status.replay !== "started") {
			logger.warn(`Save ${label}: the replay buffer is not running`);
			return ev.action.showAlert();
		}

		let upload = chibisafe.enabled && settings.upload !== false;
		if (upload && !obs.isLocal) {
			logger.warn(`Save ${label}: not uploading, because the clip is saved on another computer (OBS isn't local)`);
			upload = false;
		}

		let result: SaveClipResult;
		try {
			result = await obs.saveClip(seconds);
		} catch (error) {
			logger.error(`Save ${label}: ${describe(error)}`);
			return ev.action.showAlert();
		}
		if (!result.accepted) {
			logger.warn(`Save ${label}: ${describeRefusal(result.error)}`);
			return ev.action.showAlert();
		}

		// A key longer than the replay buffer saves the whole buffer.
		const shortened = result.clamped ? `, shortened to the whole buffer (${formatDuration(result.durationSeconds)})` : "";
		logger.info(`Save ${label}: saving${shortened}${upload ? ", will upload to chibisafe" : ""}`);

		const { album: keyAlbum } = settings;
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
			(error: unknown) => (current() ? this.#fail(id, error) : this.#logUploadError(id, error)),
		);
	}

	/** Ends the key's save or upload with the Stream Deck warning triangle. */
	async #fail(id: string, error: unknown): Promise<void> {
		this.#logUploadError(id, error);
		this.#transient.delete(id);
		this.#renderAll();
		const action = this.actions.find((a) => a.id === id);
		if (action?.isKey()) await action.showAlert();
	}

	#logUploadError(id: string, error: unknown): void {
		logger.error(`Upload ${this.#label(this.#settings.get(id) ?? {})}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/** The key's length for log lines, e.g. "15 sec". */
	#label(settings: SaveClipSettings): string {
		const seconds = this.secondsOf(settings);
		return seconds === undefined ? "(no valid length)" : formatDuration(seconds);
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
		const image = this.#face(action.id);
		if (this.#lastImage.get(action.id) !== image) {
			this.#lastImage.set(action.id, image);
			await action.setImage(image);
		}
	}

	#face(id: string): string {
		const transient = this.#transient.get(id);
		const settings = this.#settings.get(id) ?? {};
		switch (transient?.state) {
			case "uploading":
				return keyImage(uploadKeyName(Math.min(90, Math.floor((transient.progress ?? 0) * 10) * 10) as UploadVariant));
			case "copied":
				return keyImage(uploadKeyName("copied"));
			case "saving":
			case "saved":
				return this.saveFace(settings, transient.state);
		}

		const { connection, replay } = obs.status;
		const variant: SaveVariant = connection !== "connected" ? "offline" : replay === "started" ? "ready" : "inactive";
		return this.saveFace(settings, variant);
	}
}

function createSaveAction(duration: SaveDuration): SaveClipAction {
	@action({ UUID: `com.replay-buffer-pro.obs.save-${duration}` })
	class SaveClip extends SaveClipAction {
		protected override secondsOf(): number {
			return duration;
		}

		protected override saveFace(_settings: SaveClipSettings, variant: SaveVariant): string {
			return keyImage(saveKeyName(duration, variant));
		}
	}
	return new SaveClip();
}

/** A save key whose length and colour are set in its settings, drawn at runtime. */
@action({ UUID: CUSTOM_SAVE_UUID })
class SaveCustomClip extends SaveClipAction {
	protected override secondsOf(settings: SaveClipSettings): number | undefined {
		const custom = customLength(settings);
		return custom.ok ? custom.seconds : undefined;
	}

	protected override saveFace(settings: SaveClipSettings, variant: SaveVariant): string {
		const custom = customLength(settings);
		return svgImage(customSaveKeySvg(custom.ok ? custom.length : undefined, accentOf(settings), variant));
	}
}

/**
 * One action per fixed clip length, e.g. `com.replay-buffer-pro.obs.save-15` for the last 15 seconds,
 * and the custom length key.
 */
export const saveActions: SaveClipAction[] = [...SAVE_DURATIONS.map(createSaveAction), new SaveCustomClip()];
