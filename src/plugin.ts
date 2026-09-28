import streamDeck from "@elgato/streamdeck";

import { NO_ALBUM, type SaveClipSettings, saveActions } from "./actions/save-clip";
import { ToggleReplayBuffer } from "./actions/toggle-replay-buffer";
import { chibisafe, type ChibisafeAlbum, type ChibisafeSettings } from "./chibisafe";
import { obs, type ObsSettings } from "./obs";
import { resolveSlot } from "./replay-buffer-pro";

/** Settings shared by all keys: the OBS connection and chibisafe uploads. */
type GlobalSettings = ObsSettings & ChibisafeSettings;

// "trace" would log every message, including the OBS password in the global settings.
streamDeck.logger.setLevel("info");

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
		chibisafe: { ...chibisafe.status, obsIsLocal: obs.isLocal },
	});
}

/**
 * Events the album dropdowns request their options with (sdpi-select's datasource): the default album on
 * the on/off key, and the per-key album on the save keys. Both dropdowns are in the same page, so they
 * need separate events.
 */
const DEFAULT_ALBUM_EVENT = "getAlbums";
const KEY_ALBUM_EVENT = "getKeyAlbums";

type SelectItem = { value: string; label: string; disabled?: boolean };

/**
 * Options for an album dropdown. The save keys' dropdown starts with "Default", which follows the on/off
 * key's album, and "No album"; the on/off key's starts with "No album".
 */
async function albumItems(forKey: boolean, current: string, fresh: boolean): Promise<SelectItem[]> {
	let albums: ChibisafeAlbum[] = [];
	let error: string | undefined;
	try {
		albums = await chibisafe.listAlbums(fresh);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	const nameOf = (uuid: string) => albums.find((album) => album.uuid === uuid)?.name;
	const defaultAlbum = chibisafe.album ? (nameOf(chibisafe.album) ?? "the selected album") : "no album";
	const items: SelectItem[] = forKey
		? [
				{ value: "", label: `Default (${defaultAlbum})` },
				{ value: NO_ALBUM, label: "No album" },
			]
		: [{ value: "", label: "No album" }];
	items.push(...albums.map(({ uuid, name }) => ({ value: uuid, label: name })));

	// Keep a saved choice visible even if it can't be listed right now.
	if (current && !items.some((item) => item.value === current)) {
		items.push({ value: current, label: error ? "Current album" : "Missing album (deleted?)" });
	}
	if (error) {
		items.push({ value: "-", label: `Can't load albums: ${error}`, disabled: true });
	}
	return items;
}

/** Fills the album dropdown of the open settings panel, if it has one. */
async function sendAlbumsToPropertyInspector(fresh: boolean): Promise<void> {
	const action = streamDeck.ui.action;
	if (action?.manifestId?.endsWith(".toggle")) {
		const items = await albumItems(false, chibisafe.album, fresh);
		await streamDeck.ui.sendToPropertyInspector({ event: DEFAULT_ALBUM_EVENT, items });
	} else if (action && saveActions.some(({ manifestId }) => manifestId === action.manifestId)) {
		const { album = "" } = (await action.getSettings()) as SaveClipSettings;
		const items = await albumItems(true, album, fresh);
		await streamDeck.ui.sendToPropertyInspector({ event: KEY_ALBUM_EVENT, items });
	}
}

/**
 * Shares one album fetch between the dropdown's request and the panel appearing. If the server URL or
 * API key changes, or another key's panel opens, while it runs, the list is fetched again afterwards.
 */
let albumsInFlight: Promise<void> | undefined;
function refreshAlbums(fresh = false): Promise<void> {
	if (!albumsInFlight) {
		const connection = chibisafe.connectionKey;
		const panel = streamDeck.ui.action?.id;
		albumsInFlight = sendAlbumsToPropertyInspector(fresh).finally(() => {
			albumsInFlight = undefined;
			if (chibisafe.connectionKey !== connection || streamDeck.ui.action?.id !== panel) void refreshAlbums();
		});
	}
	return albumsInFlight;
}

streamDeck.ui.onDidAppear(() => {
	void sendStatusToPropertyInspector();
	// The dropdown may ask before the SDK knows the panel is open, which drops the reply; send the list now too.
	void refreshAlbums();
});
streamDeck.ui.onSendToPlugin((ev) => {
	// The dropdown's ↻ button marks its request with isRefresh; that one always fetches a fresh list.
	const { event, isRefresh } = (ev.payload as { event?: string; isRefresh?: boolean } | null) ?? {};
	void (event === DEFAULT_ALBUM_EVENT || event === KEY_ALBUM_EVENT ? refreshAlbums(isRefresh === true) : sendStatusToPropertyInspector());
});
streamDeck.settings.onDidReceiveSettings(() => void sendStatusToPropertyInspector());
obs.onStatusChange(() => void sendStatusToPropertyInspector());

let chibisafeState = chibisafe.status.state;
chibisafe.onStatusChange((status) => {
	void sendStatusToPropertyInspector();
	// A finished connection check means the URL or API key changed, so reload the album list.
	if (status.state !== chibisafeState && status.state !== "checking") void refreshAlbums();
	chibisafeState = status.state;
});

function configure(settings: GlobalSettings): void {
	obs.configure(settings);
	chibisafe.configure(settings);
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => configure(ev.settings));

await streamDeck.connect();
configure(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
