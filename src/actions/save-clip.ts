import streamDeck, {
	action,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { SAVE_DURATIONS, saveKeyName, type SaveDuration, type SaveVariant } from "../icons";
import { keyImage } from "../key-images";
import { describe, obs } from "../obs";
import { formatDuration, resolveSlot, type SlotSetting } from "../replay-buffer-pro";

const logger = streamDeck.logger.createScope("SaveClip");

/** How long the "SAVED" face stays up. */
const SAVED_FLASH_MS = 1_500;
/**
 * Give up waiting for OBS's "replay saved" event after this long. OBS always writes the whole buffer
 * before Replay Buffer Pro trims it, which can take a while with long buffers.
 */
const SAVE_TIMEOUT_MS = 120_000;

export type SaveClipSettings = {
	/** Which Replay Buffer Pro button to trigger; see {@link SlotSetting}. */
	slot?: SlotSetting;
};

type Transient = { variant: "saving" | "saved"; timer: NodeJS.Timeout };

/**
 * Saves the last N seconds of the replay buffer by triggering the matching Replay Buffer Pro hotkey
 * through obs-websocket, then shows "SAVING" until OBS reports the file was written.
 */
abstract class SaveClipAction extends SingletonAction<SaveClipSettings> {
	abstract readonly duration: SaveDuration;

	readonly #transient = new Map<string, Transient>();
	readonly #lastImage = new Map<string, string>();

	constructor() {
		super();
		obs.onStatusChange((status) => {
			// A stopped buffer or lost connection means the pending save isn't coming.
			if (status.connection !== "connected" || status.replay !== "started") {
				for (const [id, { variant, timer }] of this.#transient) {
					if (variant === "saving") {
						clearTimeout(timer);
						this.#transient.delete(id);
					}
				}
			}
			this.#renderAll();
		});
		obs.onReplaySaved(() => {
			for (const [id, { variant }] of this.#transient) {
				if (variant === "saving") {
					this.#setTransient(id, "saved", SAVED_FLASH_MS);
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

		try {
			await obs.socket.call("TriggerHotkeyByName", { hotkeyName: slot.hotkeyName });
			logger.info(`Save ${label}: triggered ${slot.hotkeyName}`);
		} catch (error) {
			const missing = !(await obs.detectReplayBufferPro());
			logger.error(`Save ${label}: ${missing ? "Replay Buffer Pro is not installed or not loaded in OBS" : describe(error)}`);
			return ev.action.showAlert();
		}

		this.#setTransient(ev.action.id, "saving", SAVE_TIMEOUT_MS);
	}

	#setTransient(id: string, variant: Transient["variant"], duration: number): void {
		clearTimeout(this.#transient.get(id)?.timer);
		const timer = setTimeout(() => {
			if (variant === "saving") {
				logger.warn(`No "replay saved" event from OBS within ${SAVE_TIMEOUT_MS / 1000} seconds`);
			}
			this.#transient.delete(id);
			this.#renderAll();
		}, duration);
		this.#transient.set(id, { variant, timer });
		this.#renderAll();
	}

	#renderAll(): void {
		this.actions.forEach((action) => action.isKey() && void this.#render(action));
	}

	async #render(action: KeyAction<SaveClipSettings>): Promise<void> {
		const { connection, replay } = obs.status;
		let variant: SaveVariant;
		const transient = this.#transient.get(action.id);
		if (transient) {
			variant = transient.variant;
		} else if (connection !== "connected") {
			variant = "offline";
		} else {
			variant = replay === "started" ? "ready" : "inactive";
		}

		const image = keyImage(saveKeyName(this.duration, variant));
		if (this.#lastImage.get(action.id) !== image) {
			this.#lastImage.set(action.id, image);
			await action.setImage(image);
		}
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
