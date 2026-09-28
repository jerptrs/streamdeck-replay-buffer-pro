import streamDeck, { action, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { toggleKeyName, type ToggleVariant } from "../icons";
import { keyImage } from "../key-images";
import { describe, obs } from "../obs";

const logger = streamDeck.logger.createScope("Toggle");

/** obs-websocket status codes for "output already running" / "output not running". */
const OUTPUT_RUNNING = 500;
const OUTPUT_NOT_RUNNING = 501;

/** The toggle has no per-key settings; OBS connection details are global. */
type ToggleSettings = Record<string, never>;

/**
 * One key that starts or stops OBS's replay buffer and shows whether it's running. State 0 is
 * "off" and state 1 is "on"; in a multi-action the user picks the state to switch to.
 */
@action({ UUID: "com.replay-buffer-pro.obs.toggle" })
export class ToggleReplayBuffer extends SingletonAction<ToggleSettings> {
	readonly #lastImage = new Map<string, string>();

	constructor() {
		super();
		obs.onStatusChange(() => this.actions.forEach((action) => action.isKey() && void this.#render(action)));
	}

	override onWillAppear(ev: WillAppearEvent<ToggleSettings>): Promise<void> | void {
		this.#lastImage.delete(ev.action.id);
		if (ev.action.isKey()) {
			return this.#render(ev.action);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
		if (!obs.connected) {
			logger.warn("Pressed while OBS is not connected");
			obs.retryNow();
			await ev.action.showAlert();
			return;
		}

		const desiredState = ev.payload.isInMultiAction ? ev.payload.userDesiredState : undefined;
		const request = desiredState === 1 ? "StartReplayBuffer" : desiredState === 0 ? "StopReplayBuffer" : "ToggleReplayBuffer";

		try {
			await obs.socket.call(request);
		} catch (error) {
			const code = (error as { code?: number }).code;
			// A multi-action asking for the state it's already in isn't a failure.
			if ((request === "StartReplayBuffer" && code === OUTPUT_RUNNING) || (request === "StopReplayBuffer" && code === OUTPUT_NOT_RUNNING)) {
				return;
			}

			logger.error(`${request} failed: ${describe(error)}`);
			await ev.action.showAlert();
			await obs.refreshReplayState();
		}
	}

	async #render(action: KeyAction<ToggleSettings>): Promise<void> {
		const { connection, replay } = obs.status;
		let variant: ToggleVariant;
		if (connection !== "connected") {
			variant = "offline";
		} else if (replay === "unavailable") {
			variant = "unavailable";
		} else if (replay === "starting" || replay === "stopping") {
			variant = replay;
		} else {
			variant = replay === "started" ? "on" : "off";
		}

		const image = keyImage(toggleKeyName(variant));
		if (this.#lastImage.get(action.id) === image) {
			return;
		}
		this.#lastImage.set(action.id, image);

		await action.setState(replay === "started" || replay === "stopping" ? 1 : 0);
		await action.setImage(image);
	}
}
