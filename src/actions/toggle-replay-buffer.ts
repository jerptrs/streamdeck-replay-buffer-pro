import streamDeck, { action, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { toggleKeyName, type ToggleVariant } from "../icons";
import { keyImage } from "../key-images";
import { describe, obs, OPENING_WAIT_MS } from "../obs";
import { findObsApp, obsRunning, openObs } from "../obs-app";

const logger = streamDeck.logger.createScope("Toggle");

/** obs-websocket status codes for "output already running" / "output not running". */
const OUTPUT_RUNNING = 500;
const OUTPUT_NOT_RUNNING = 501;

export const TOGGLE_UUID = "com.replay-buffer-pro.obs.toggle";

/** The toggle has no per-key settings; OBS connection details are global. */
type ToggleSettings = Record<string, never>;

/** Global settings for opening OBS from the "NO OBS" face. */
export type OpenObsSettings = {
	/** The "OBS app" setting; empty finds a standard install. */
	obsPath?: string;
};

/**
 * One key that starts or stops OBS's replay buffer and shows whether it's running. State 0 is
 * "off" and state 1 is "on"; in a multi-action the user picks the state to switch to. While it shows
 * "NO OBS", pressing it opens OBS; it then shows "STARTING OBS" until OBS has finished starting.
 */
@action({ UUID: TOGGLE_UUID })
export class ToggleReplayBuffer extends SingletonAction<ToggleSettings> {
	readonly #lastImage = new Map<string, string>();
	/** Set while a press checks whether OBS can be opened, so a double press can't open it twice. */
	#checking = false;
	#wasOpening = false;
	/** The "OBS app" setting, from the global settings. */
	obsPath = "";

	constructor() {
		super();
		obs.onStatusChange((status) => {
			// Opening ends when OBS accepts the connection ("loading" keeps STARTING OBS until it's ready),
			// rejects the password, or doesn't answer in time.
			if (this.#wasOpening && !status.opening && status.connection !== "loading" && status.connection !== "connected") {
				logger.warn(
					status.connection === "auth-failed"
						? "OBS opened, but rejected the WebSocket password"
						: `OBS didn't accept the connection within ${OPENING_WAIT_MS / 1000} seconds; ` +
								"check that its WebSocket server is enabled (Tools → WebSocket Server Settings) and the port and password match",
				);
				this.actions.forEach((action) => action.isKey() && void action.showAlert());
			}
			this.#wasOpening = status.opening;
			this.#renderAll();
		});
	}

	override onWillAppear(ev: WillAppearEvent<ToggleSettings>): Promise<void> | void {
		this.#lastImage.delete(ev.action.id);
		if (ev.action.isKey()) {
			return this.#render(ev.action);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
		if (!obs.connected) {
			return this.#pressedWithoutObs(ev.action);
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

	/** "NO OBS" was pressed: starts OBS when it's installed on this computer and isn't running yet. */
	async #pressedWithoutObs(key: KeyDownEvent<ToggleSettings>["action"]): Promise<void> {
		// OBS is already on its way.
		if (obs.status.opening || this.#checking || obs.status.connection === "loading") {
			return;
		}
		this.#checking = true;
		try {
			await this.#openObsIfClosed(key);
		} finally {
			this.#checking = false;
		}
	}

	async #openObsIfClosed(key: KeyDownEvent<ToggleSettings>["action"]): Promise<void> {
		const why =
			obs.status.connection === "auth-failed"
				? "OBS rejected the WebSocket password"
				: !obs.isLocal
					? "OBS isn't connected, and it runs on another computer, so it can't be opened from here"
					: undefined;
		if (why) {
			logger.warn(`Pressed while ${why}`);
			obs.retryNow();
			return key.showAlert();
		}

		const app = await findObsApp(this.obsPath);
		const running = await obsRunning(app);
		if (running === true) {
			logger.warn("OBS is running, but its WebSocket server can't be reached; check Tools → WebSocket Server Settings in OBS");
			obs.retryNow();
			return key.showAlert();
		}
		if (running === undefined) {
			// Opening it anyway is safe: a second OBS asks before it starts.
			logger.warn("Couldn't check whether OBS is already running; opening it anyway");
		}
		if (!app.ok) {
			logger.error(`Can't open OBS: ${app.detail}`);
			return key.showAlert();
		}

		try {
			await openObs(app);
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			return key.showAlert();
		}

		logger.info(`Opened OBS (${app.detail}); connecting once it's up`);
		obs.expectOpening();
	}

	#renderAll(): void {
		this.actions.forEach((action) => action.isKey() && void this.#render(action));
	}

	async #render(action: KeyAction<ToggleSettings>): Promise<void> {
		const { connection, replay, opening } = obs.status;
		let variant: ToggleVariant;
		if (connection !== "connected") {
			variant = opening || connection === "loading" ? "obs-starting" : "offline";
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
