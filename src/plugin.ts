import streamDeck from "@elgato/streamdeck";

import { Save15Seconds, Save30Seconds, Save60Seconds, type SaveClipSettings } from "./actions/save-clip";
import { ToggleReplayBuffer } from "./actions/toggle-replay-buffer";
import { obs, type ObsSettings } from "./obs";
import { resolveSlot } from "./replay-buffer-pro";

// "trace" would log every message, including the OBS password in the global settings.
streamDeck.logger.setLevel("info");

const saveActions = [new Save15Seconds(), new Save30Seconds(), new Save60Seconds()];
streamDeck.actions.registerAction(new ToggleReplayBuffer());
saveActions.forEach((action) => streamDeck.actions.registerAction(action));

/** Tells the open property inspector the connection state and which OBS button this key triggers. */
async function sendStatusToPropertyInspector(): Promise<void> {
	const action = streamDeck.ui.action;
	if (!action) {
		return;
	}

	const duration = saveActions.find(({ manifestId }) => manifestId === action.manifestId)?.duration;
	const slot = duration ? await resolveSlot(duration, ((await action.getSettings()) as SaveClipSettings).slot, obs.isLocal) : undefined;
	const { connection, replay, replayBufferPro, error } = obs.status;

	await streamDeck.ui.sendToPropertyInspector({
		event: "status",
		connection,
		replay,
		replayBufferPro,
		error: error ?? null,
		slot: slot ? { ok: slot.ok, detail: slot.detail } : null,
	});
}

streamDeck.ui.onDidAppear(() => void sendStatusToPropertyInspector());
streamDeck.ui.onSendToPlugin(() => void sendStatusToPropertyInspector());
streamDeck.settings.onDidReceiveSettings(() => void sendStatusToPropertyInspector());
obs.onStatusChange(() => void sendStatusToPropertyInspector());

streamDeck.settings.onDidReceiveGlobalSettings<ObsSettings>((ev) => obs.configure(ev.settings));

await streamDeck.connect();
obs.configure(await streamDeck.settings.getGlobalSettings<ObsSettings>());
