/**
 * End-to-end test: runs the built plugin (bin/plugin.js) against a fake Stream Deck app and a fake
 * obs-websocket v5 server, presses keys, and checks what reaches OBS and which key faces are shown.
 *
 * Run with `npm test` (builds first).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { WebSocketServer } from "ws";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.replay-buffer-pro.obs.sdPlugin");
const UUID = "com.replay-buffer-pro.obs";
const PASSWORD = randomBytes(12).toString("hex");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` returns true, or gives up after `timeout` ms. Generous defaults keep slow CI machines from flaking. */
async function waitFor(predicate, timeout = 4_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (predicate()) return true;
		await sleep(20);
	}
	return predicate();
}

let failures = 0;
function check(name, passed, detail = "") {
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	if (!passed) failures++;
}

// --------------------------------------------------------------------------- fake OBS

/**
 * ready: false while OBS is still starting; like obs-websocket, it then accepts connections but answers
 * every request with "not ready".
 * replayBufferPro: "1.8.0" (has SaveClip), "1.7.0" (only the save button hotkeys) or null (not loaded).
 * bufferLength: the replay buffer length in seconds. saveRefused: Replay Buffer Pro refuses saves (recording paused).
 * trim: "ok", "fail" (partial file deleted after a while) or "fail-fast" (deleted before any poll could see it).
 */
const obsState = { ready: true, replayActive: false, bufferLength: 300, replayBufferPro: "1.8.0", saveRefused: false, clipSize: 2_500, trim: "ok", foreignSaveFirst: false };
const obsRequests = [];
const obsClients = new Set();
let obsServer;
let obsPort = 0;

async function startObs() {
	obsServer = new WebSocketServer({ port: obsPort, host: "127.0.0.1", handleProtocols: () => "obswebsocket.json" });
	await new Promise((resolve) => obsServer.once("listening", resolve));
	obsPort = obsServer.address().port;

	obsServer.on("connection", (ws) => {
		obsClients.add(ws);
		ws.on("close", () => obsClients.delete(ws));

		const salt = randomBytes(8).toString("base64");
		const challenge = randomBytes(8).toString("base64");
		ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.6.0", rpcVersion: 1, authentication: { challenge, salt } } }));

		ws.on("message", (raw) => {
			const { op, d } = JSON.parse(raw.toString());
			if (op === 1) {
				const secret = createHash("sha256").update(PASSWORD + salt).digest("base64");
				const expected = createHash("sha256").update(secret + challenge).digest("base64");
				if (d.authentication !== expected) return ws.close(4009, "Authentication failed.");
				return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
			}
			if (op !== 6) return;

			const { requestType, requestId, requestData } = d;
			obsRequests.push({ requestType, requestData });
			const ok = (responseData) =>
				ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
			const fail = (code, comment) =>
				ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: false, code, comment } } }));

			if (!obsState.ready) return fail(207, "OBS is not ready to perform the request.");
			switch (requestType) {
				case "GetVersion":
					return ok({ obsVersion: "32.2.0", obsWebSocketVersion: "5.6.0" });
				case "GetReplayBufferStatus":
					return ok({ outputActive: obsState.replayActive });
				case "GetHotkeyList": {
					const rbp = obsState.replayBufferPro ? [1, 2, 3, 4, 5, 6].map((i) => `ReplayBufferPro.SaveButton${i}`) : [];
					return ok({ hotkeys: ["OBSBasic.StartStreaming", ...rbp] });
				}
				case "CallVendorRequest": {
					const { vendorName, requestType: vendorRequest, requestData: data } = requestData;
					if (obsState.replayBufferPro !== "1.8.0" || vendorName !== "replay-buffer-pro" || vendorRequest !== "SaveClip") {
						return fail(600, "No vendor was found by that name.");
					}
					// Replay Buffer Pro 1.8.0's answers (src/plugin/websocket-command.cpp).
					const reply = (responseData) => ok({ vendorName, requestType: vendorRequest, responseData });
					const seconds = data?.durationSeconds;
					if (!Number.isInteger(seconds) || seconds < 1 || seconds > 21600) return reply({ accepted: false, error: "invalid-duration" });
					if (!obsState.replayActive) return reply({ accepted: false, error: "buffer-inactive" });
					if (obsState.saveRefused) return reply({ accepted: false, error: "save-refused" });
					const saved = Math.min(seconds, obsState.bufferLength);
					reply({ accepted: true, durationSeconds: saved, clamped: saved < seconds });
					setTimeout(saveReplay, 300);
					return;
				}
				case "ToggleReplayBuffer":
				case "StartReplayBuffer":
				case "StopReplayBuffer": {
					const target = requestType === "ToggleReplayBuffer" ? !obsState.replayActive : requestType === "StartReplayBuffer";
					if (target === obsState.replayActive) return fail(target ? 500 : 501, "Output already in that state");
					ok(requestType === "ToggleReplayBuffer" ? { outputActive: target } : undefined);
					return setReplay(target);
				}
				default:
					return fail(204, "Unknown request type");
			}
		});
	});
}

async function stopObs() {
	for (const ws of obsClients) ws.terminate();
	await new Promise((resolve) => obsServer.close(resolve));
}

/**
 * Writes the full-length file OBS saves, reports it, then trims it the way Replay Buffer Pro does:
 * a partial file that is renamed to `_trimmed` once complete, or deleted if the trim fails.
 */
let saveCount = 0;
function saveReplay() {
	// Another save (e.g. OBS's own Save Replay hotkey) was already being written: OBS reports it
	// first, Replay Buffer Pro doesn't trim it, and our save follows.
	if (obsState.foreignSaveFirst) {
		const foreign = path.join(recordings, `Foreign ${saveCount}.mp4`);
		writeFileSync(foreign, randomBytes(obsState.clipSize * 4));
		emit("ReplayBufferSaved", { savedReplayPath: foreign });
		setTimeout(saveOwnReplay, 300);
		return;
	}
	saveOwnReplay();
}

function saveOwnReplay() {
	const base = path.join(recordings, `Replay ${++saveCount}`);
	writeFileSync(`${base}.mp4`, randomBytes(obsState.clipSize * 4));
	emit("ReplayBufferSaved", { savedReplayPath: `${base}.mp4` });

	const trim = obsState.trim;
	setTimeout(() => {
		writeFileSync(`${base}.rbp-partial.mp4`, randomBytes(obsState.clipSize));
		if (trim === "fail-fast") return rmSync(`${base}.rbp-partial.mp4`);
		setTimeout(() => {
			if (trim === "fail") {
				rmSync(`${base}.rbp-partial.mp4`);
			} else {
				renameSync(`${base}.rbp-partial.mp4`, `${base}_trimmed.mp4`);
				rmSync(`${base}.mp4`);
			}
		}, 300);
	}, 100);
}

function emit(eventType, eventData) {
	for (const ws of obsClients) ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 64, eventData } }));
}

function setReplay(active) {
	emit("ReplayBufferStateChanged", { outputActive: false, outputState: `OBS_WEBSOCKET_OUTPUT_${active ? "STARTING" : "STOPPING"}` });
	setTimeout(() => {
		obsState.replayActive = active;
		emit("ReplayBufferStateChanged", { outputActive: active, outputState: `OBS_WEBSOCKET_OUTPUT_${active ? "STARTED" : "STOPPED"}` });
	}, 150);
}

// --------------------------------------------------------------------------- fake Stream Deck

const contexts = {
	toggle: { action: `${UUID}.toggle`, settings: {} },
	save15: { action: `${UUID}.save-15`, settings: {} },
	save30: { action: `${UUID}.save-30`, settings: {} },
	save60: { action: `${UUID}.save-60`, settings: {} },
	save300: { action: `${UUID}.save-300`, settings: {} },
	save1800: { action: `${UUID}.save-1800`, settings: {} },
	saveCustom: { action: `${UUID}.save-custom`, settings: {} },
};

const sdMessages = [];
let globalSettings;
let plugin;

const streamDeck = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((resolve) => streamDeck.once("listening", resolve));
const pluginRegistered = new Promise((resolve) => {
	streamDeck.on("connection", (ws) => {
		plugin = ws;
		ws.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			sdMessages.push(message);
			if (message.event === "registerPlugin") resolve();
			if (message.event === "getGlobalSettings") {
				ws.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: globalSettings } }));
			}
			if (message.event === "getSettings") {
				const { action, settings } = contexts[message.context];
				const payload = { settings, coordinates: { column: 0, row: 0 }, isInMultiAction: false, controller: "Keypad" };
				ws.send(JSON.stringify({ event: "didReceiveSettings", action, context: message.context, device: "dev1", payload }));
			}
		});
	});
});

function send(event, context, payload = {}) {
	const { action, settings } = contexts[context];
	const base = { settings, coordinates: { column: 0, row: 0 }, controller: "Keypad", isInMultiAction: false, state: 0 };
	plugin.send(JSON.stringify({ event, action, context, device: "dev1", payload: { ...base, ...payload } }));
}

const sdSince = (index, event, context) => sdMessages.slice(index).filter((m) => m.event === event && (!context || m.context === context));
/** Clip lengths asked of Replay Buffer Pro since request index `index`, leaving out its 0 second check. */
const savesSince = (index) =>
	obsRequests
		.slice(index)
		.filter((r) => r.requestType === "CallVendorRequest" && r.requestData.vendorName === "replay-buffer-pro" && r.requestData.requestType === "SaveClip")
		.map((r) => r.requestData.requestData.durationSeconds)
		.filter((seconds) => seconds !== 0);
const replayBufferProChecks = () => obsRequests.filter((r) => r.requestType === "CallVendorRequest" && r.requestData.requestData?.durationSeconds === 0).length;

// Map the base64 images the plugin sends back to their file names. Identical faces (every "SAVED"
// face looks the same) share an entry, so pick the name that matches the key.
const keyImages = new Map();
for (const file of readdirSync(path.join(PLUGIN_DIR, "imgs", "keys")).filter((f) => f.endsWith("@2x.png"))) {
	const data = `data:image/png;base64,${readFileSync(path.join(PLUGIN_DIR, "imgs", "keys", file)).toString("base64")}`;
	keyImages.set(data, [...(keyImages.get(data) ?? []), file.replace("@2x.png", "")]);
}

function faceName(context, image) {
	if (image?.startsWith("data:image/svg+xml;base64,")) {
		// Custom length keys are drawn at runtime; name their faces like the pre-rendered ones.
		const svg = decodeSvg(image);
		const variant = svg.includes("SAVING") ? "saving" : svg.includes("SAVED") ? "saved" : svg.includes("stroke-dasharray") ? "offline" : svg.includes('id="glow"') ? "ready" : "inactive";
		return `save-custom-${variant}`;
	}
	const names = keyImages.get(image) ?? [];
	const prefix = contexts[context].action.split(".").at(-1);
	return names.find((name) => name.startsWith(prefix)) ?? names.join("|");
}

const decodeSvg = (image) => Buffer.from(image.slice(image.indexOf(",") + 1), "base64").toString("utf8");

/** The SVG a custom length key currently shows. */
const customSvg = (context) => {
	const image = sdSince(0, "setImage", context).at(-1)?.payload.image ?? "";
	return image.startsWith("data:image/svg+xml;base64,") ? decodeSvg(image) : "";
};

/** The length a custom key shows, e.g. "2 min", or its "SET LENGTH" prompt. */
const customLabel = (context) => {
	const text = customSvg(context).match(/<text[^>]*y="129"[^>]*>(.*?)<\/text>/)?.[1] ?? "";
	return text.replace(/<tspan[^>]*>([^<]*)<\/tspan>/g, "$1 ").replace(/<[^>]+>/g, "").trim();
};

/** Whether an SVG parses and renders; resvg rejects malformed markup. */
const renders = (svg) => {
	try {
		new Resvg(svg).render();
		return true;
	} catch {
		return false;
	}
};

/** The key's current face. */
const face = (context) => faceName(context, sdSince(0, "setImage", context).at(-1)?.payload.image);

/** Every face the key has shown since message index `start`, including ones too brief to catch by polling. */
const facesSince = (start, context) => sdSince(start, "setImage", context).map((message) => faceName(context, message.payload.image));

const faceBecomes = (context, name, timeout) => waitFor(() => face(context) === name, timeout);

const logDir = path.join(PLUGIN_DIR, "logs");
const logText = () => (existsSync(logDir) ? readdirSync(logDir).map((file) => readFileSync(path.join(logDir, file), "utf8")).join("\n") : "");

// --------------------------------------------------------------------------- temp files

const tempHome = mkdtempSync(path.join(os.tmpdir(), "rbp-e2e-"));
const recordings = path.join(tempHome, "recordings");
mkdirSync(recordings);

// Stand-ins for the clipboard tools the plugin runs (xclip on Linux, pbcopy on macOS).
const fakeBin = path.join(tempHome, "bin");
const clipboardFile = path.join(tempHome, "clipboard.txt");
mkdirSync(fakeBin);
for (const tool of ["xclip", "pbcopy"]) {
	writeFileSync(path.join(fakeBin, tool), '#!/bin/sh\ncat > "$FAKE_CLIPBOARD"\n');
	chmodSync(path.join(fakeBin, tool), 0o755);
}
const clipboard = () => (existsSync(clipboardFile) ? readFileSync(clipboardFile, "utf8") : "");

// Stand-ins for OBS itself and the process check, for opening OBS from the On/Off key. The fake OBS
// notes how it was started; pgrep reports OBS as running while the marker file exists.
const obsLaunchesFile = path.join(tempHome, "obs-launches.txt");
const obsRunningFile = path.join(tempHome, "obs-running");
const portableObs = path.join(tempHome, "portable", "obs-portable");
mkdirSync(path.dirname(portableObs));
for (const file of [path.join(fakeBin, "obs"), portableObs]) {
	writeFileSync(file, '#!/bin/sh\necho "$0" >> "$FAKE_OBS_LAUNCHES"\n');
	chmodSync(file, 0o755);
}
writeFileSync(path.join(fakeBin, "pgrep"), '#!/bin/sh\n[ -e "$FAKE_OBS_RUNNING" ]\n');
chmodSync(path.join(fakeBin, "pgrep"), 0o755);
const obsLaunches = () => (existsSync(obsLaunchesFile) ? readFileSync(obsLaunchesFile, "utf8").split("\n").filter(Boolean) : []);

// --------------------------------------------------------------------------- fake chibisafe

const chibi = {
	apiKey: randomBytes(8).toString("hex"),
	album: "album-1",
	// Not a round number, so upload time limits come out fractional like with real clip sizes.
	chunkSize: 999,
	maxSize: 100_000,
	useNetworkStorage: false,
	/** Answer the album lookup with this status instead (e.g. a server error). */
	albumStatus: 200,
	/** Answer the next upload of this chunk number ("final" for the last one) with a 502 once. */
	fail502: undefined,
};
const chibiRequests = [];
const chibiUploads = [];
const chibiChunks = new Map();
const s3Objects = new Map();

const chibiServer = http.createServer(async (req, res) => {
	const body = Buffer.concat(await Array.fromAsync(req));
	const { pathname } = new URL(req.url, "http://localhost");
	chibiRequests.push({ method: req.method, url: req.url, pathname, headers: req.headers, body });
	const json = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
	const authorised = req.headers["x-api-key"] === chibi.apiKey;

	if (req.method === "GET" && pathname === "/api/settings") {
		return json(200, { chunkSize: chibi.chunkSize, maxSize: chibi.maxSize, useNetworkStorage: chibi.useNetworkStorage, blockedExtensions: [".exe"] });
	}
	if (req.method === "PUT" && pathname.startsWith("/s3/")) {
		s3Objects.set(pathname.slice(4), body);
		return res.writeHead(200).end();
	}
	if (!authorised) return json(401, { message: "Invalid authorization" });

	if (req.method === "GET" && pathname === "/api/user/me") return json(200, { user: { username: "tester" } });
	if (req.method === "GET" && pathname === "/api/albums") {
		// One album per page, newest name first like chibisafe, so the plugin has to page and sort.
		const albums = [{ uuid: "album-2", name: "Highlights" }, { uuid: chibi.album, name: "Clips" }];
		const page = Number(new URL(req.url, "http://localhost").searchParams.get("page") ?? 1);
		return json(200, { albums: albums.slice(page - 1, page), count: albums.length });
	}
	if (req.method === "GET" && pathname.startsWith("/api/album/")) {
		if (chibi.albumStatus !== 200) return json(chibi.albumStatus, { message: "Internal Server Error" });
		const name = { [chibi.album]: "Clips", "album-2": "Highlights" }[pathname.slice("/api/album/".length)];
		return name ? json(200, { name }) : json(404, { message: "Not found" });
	}
	if (req.method === "POST" && pathname === "/api/upload/process") {
		const { identifier, name } = JSON.parse(body.toString());
		chibiUploads.push({ name, content: s3Objects.get(identifier), s3: true, album: req.headers.albumuuid });
		return json(200, { url: `https://s3.test/${identifier}` });
	}
	if (req.method === "POST" && pathname === "/api/upload") {
		if (chibi.useNetworkStorage) {
			const { name } = JSON.parse(body.toString());
			const identifier = `s3-${saveCount}-${encodeURIComponent(name)}`;
			const address = `http://127.0.0.1:${chibiServer.address().port}/s3/${identifier}`;
			return json(200, { url: address, identifier, publicUrl: address });
		}

		const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData();
		const data = Buffer.from(await form.get("file").arrayBuffer());
		if (data.length > chibi.chunkSize) return json(413, { message: "Chunk is too big" });

		const uuid = req.headers["chibi-uuid"];
		const total = Number(req.headers["chibi-chunks-total"] ?? 1);
		const number = Number(req.headers["chibi-chunk-number"] ?? 1);
		if (chibi.fail502 === number || (chibi.fail502 === "final" && number === total)) {
			// A proxy losing the answer: the final chunk was still stored, like a real backend would.
			chibi.fail502 = undefined;
			if (number === total) chibiUploads.push({ name: form.get("name"), content: Buffer.alloc(0), chunks: total, lostAnswer: true });
			return json(502, { message: "Bad Gateway" });
		}
		const parts = chibiChunks.get(uuid) ?? [];
		parts[number - 1] = data;
		chibiChunks.set(uuid, parts);
		if (number < total) return res.writeHead(204).end();

		// Like chibisafe, the final chunk must name the file before its data.
		const text = body.toString("latin1");
		const nameFirst = text.indexOf('name="name"') !== -1 && text.indexOf('name="name"') < text.indexOf('name="file"');
		if (total > 1 && !nameFirst) return json(400, { message: "Missing file name." });

		const name = form.get("name") ?? form.get("file").name;
		chibiUploads.push({ name, content: Buffer.concat(parts), chunks: total, album: req.headers.albumuuid });
		return json(200, { name, uuid: "file-uuid", url: `https://chibi.test/${encodeURIComponent(name)}` });
	}
	json(404, { message: "Not found" });
});
chibiServer.listen(0, "127.0.0.1");
await new Promise((resolve) => chibiServer.once("listening", resolve));
const chibiUrl = `http://127.0.0.1:${chibiServer.address().port}`;

// --------------------------------------------------------------------------- run

await startObs();
globalSettings = { host: "127.0.0.1", port: String(obsPort), password: PASSWORD };

const info = {
	application: { font: "Arial", language: "en", platform: "windows", platformVersion: "10", version: "7.1.0.0" },
	plugin: { uuid: UUID, version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: "dev1", name: "Stream Deck", size: { columns: 5, rows: 3 }, type: 0 }],
};
const child = spawn(
	process.execPath,
	["bin/plugin.js", "-port", String(streamDeck.address().port), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
	{ cwd: PLUGIN_DIR, env: {
			...process.env,
			PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
			FAKE_CLIPBOARD: clipboardFile,
			FAKE_OBS_LAUNCHES: obsLaunchesFile,
			FAKE_OBS_RUNNING: obsRunningFile,
		}, stdio: ["ignore", "pipe", "pipe"] },
);
let pluginOutput = "";
child.stdout.on("data", (chunk) => (pluginOutput += chunk));
child.stderr.on("data", (chunk) => (pluginOutput += chunk));

try {
	const registered = await Promise.race([pluginRegistered.then(() => true), sleep(10_000).then(() => false)]);
	check("plugin registers with Stream Deck", registered);
	if (!registered) throw new Error("The plugin didn't register with Stream Deck");
	check("connects and authenticates to OBS", await waitFor(() => obsRequests.some((r) => r.requestType === "GetReplayBufferStatus")));
	check("checks for Replay Buffer Pro's SaveClip request", await waitFor(() => replayBufferProChecks() === 1));

	for (const context of Object.keys(contexts)) send("willAppear", context);
	check("toggle shows OFF while the buffer is stopped", await faceBecomes("toggle", "toggle-off"), face("toggle"));
	check("save keys show inactive while the buffer is stopped", await faceBecomes("save60", "save-60-inactive"), face("save60"));

	let m = sdMessages.length;
	let o = obsRequests.length;
	send("keyDown", "save15");
	check("save with the buffer off shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));
	check("save with the buffer off doesn't reach OBS", savesSince(o).length === 0);

	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "toggle");
	check("toggle sends ToggleReplayBuffer", await waitFor(() => obsRequests.slice(o).some((r) => r.requestType === "ToggleReplayBuffer")));
	check("toggle shows STARTING", await faceBecomes("toggle", "toggle-starting"), face("toggle"));
	check("toggle shows ON", await faceBecomes("toggle", "toggle-on"), face("toggle"));
	check("toggle switches to state 1", sdSince(m, "setState", "toggle").at(-1)?.payload.state === 1);
	check("save keys become ready", await faceBecomes("save30", "save-30-ready"), face("save30"));

	o = obsRequests.length;
	send("keyDown", "save15");
	check("15 sec asks Replay Buffer Pro for 15 seconds", await waitFor(() => savesSince(o)[0] === 15), savesSince(o).join(", "));
	check("15 sec shows SAVING", await faceBecomes("save15", "save-15-saving"), face("save15"));
	check("15 sec shows SAVED when OBS reports the file", await faceBecomes("save15", "save-15-saved"), face("save15"));
	check("15 sec returns to ready", await faceBecomes("save15", "save-15-ready", 6_000), face("save15"));
	check("a save is a single request to OBS", obsRequests.length - o === 1, obsRequests.slice(o).map((r) => r.requestType).join(", "));

	// A key longer than the buffer saves the whole buffer, like Replay Buffer Pro's own buttons.
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "save1800");
	check("30 min with a 5 min buffer asks for 30 min", await waitFor(() => savesSince(o)[0] === 1800), savesSince(o).join(", "));
	check("30 min with a 5 min buffer saves the whole buffer", await waitFor(() => facesSince(m, "save1800").includes("save-1800-saved")), facesSince(m, "save1800").join(" → "));
	check("30 min with a 5 min buffer shows no alert", sdSince(m, "showAlert", "save1800").length === 0);
	check("the log says the clip was shortened", await waitFor(() => logText().includes("shortened to the whole buffer (5 min)")));

	obsState.saveRefused = true;
	m = sdMessages.length;
	send("keyDown", "save30");
	check("a refused save shows an alert", await waitFor(() => sdSince(m, "showAlert", "save30").length > 0));
	check("the log explains the refused save", await waitFor(() => logText().includes("is recording paused?")));
	obsState.saveRefused = false;

	/** The status the settings panel gets when it opens; it also gets album lists, so pick the status. */
	const panelStatus = async (context) => {
		const start = sdMessages.length;
		send("propertyInspectorDidAppear", context);
		await waitFor(() => sdSince(start, "sendToPropertyInspector").some((x) => x.payload.event === "status"));
		return sdSince(start, "sendToPropertyInspector").filter((x) => x.payload.event === "status").at(-1)?.payload;
	};
	const status = await panelStatus("save30");
	check("settings panel gets the connection status", status?.connection === "connected" && status.replay === "started" && status.replayBufferPro === "ready", JSON.stringify(status));

	obsState.replayBufferPro = null;
	m = sdMessages.length;
	send("keyDown", "save15");
	check("missing Replay Buffer Pro shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));
	check("the log says Replay Buffer Pro is missing", await waitFor(() => logText().includes("Replay Buffer Pro is not installed or not loaded in OBS")));

	obsState.replayBufferPro = "1.7.0";
	m = sdMessages.length;
	send("keyDown", "save15");
	check("an outdated Replay Buffer Pro shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));
	check("the log asks to update Replay Buffer Pro", await waitFor(() => logText().includes("Replay Buffer Pro is older than 1.8.0")));
	check("settings panel says Replay Buffer Pro is outdated", (await panelStatus("save15"))?.replayBufferPro === "outdated");

	// Updating Replay Buffer Pro and pressing the key again works without reconnecting.
	obsState.replayBufferPro = "1.8.0";
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "save15");
	check("saving works again after updating Replay Buffer Pro", await waitFor(() => facesSince(m, "save15").includes("save-15-saving")) && savesSince(o)[0] === 15, savesSince(o).join(", "));
	check("settings panel shows Replay Buffer Pro as ready again", (await panelStatus("save15"))?.replayBufferPro === "ready");
	await faceBecomes("save15", "save-15-ready", 6_000);

	// ------------------------------------------------------------------- custom length key

	check("custom key shows its default length", customLabel("saveCustom") === "2 min", customLabel("saveCustom"));
	check("custom key uses the default colour", customSvg("saveCustom").includes("#2dd4bf"));
	check("custom key's face is valid SVG", renders(customSvg("saveCustom")));
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "saveCustom");
	check("custom key saves its default 2 min", await waitFor(() => savesSince(o)[0] === 120), savesSince(o).join(", "));
	check("custom key shows SAVING, then SAVED", await waitFor(() => facesSince(m, "saveCustom").join(" ").includes("save-custom-saving save-custom-saved")), facesSince(m, "saveCustom").join(" → "));
	await faceBecomes("saveCustom", "save-custom-ready", 6_000);

	// Editing the length and colour: Stream Deck sends the key's new settings, and the face follows.
	contexts.saveCustom.settings = { length: "45", unit: "sec", color: "#fb7185" };
	send("didReceiveSettings", "saveCustom");
	check("custom key shows the new length", await waitFor(() => customLabel("saveCustom") === "45 sec"), customLabel("saveCustom"));
	check("custom key uses the chosen colour", customSvg("saveCustom").includes("#fb7185"));
	o = obsRequests.length;
	send("keyDown", "saveCustom");
	check("custom key saves 45 seconds", await waitFor(() => savesSince(o)[0] === 45), savesSince(o).join(", "));
	await faceBecomes("saveCustom", "save-custom-ready", 6_000);

	let customStatus = await panelStatus("saveCustom");
	check("settings panel describes the custom length", customStatus?.length?.ok === true && customStatus.length.detail === "Saves the last 45 sec.", JSON.stringify(customStatus?.length));

	contexts.saveCustom.settings = { length: "7", unit: "h", color: '#fff" onload="alert(1)' };
	send("didReceiveSettings", "saveCustom");
	check("a custom length over 6 hours asks for a length", await waitFor(() => customLabel("saveCustom") === "SET LENGTH"), customLabel("saveCustom"));
	check("an invalid colour falls back to the default", customSvg("saveCustom").includes("#2dd4bf") && !customSvg("saveCustom").includes("onload"));
	customStatus = await panelStatus("saveCustom");
	check("settings panel explains the invalid length", customStatus?.length?.ok === false && /6 hours/.test(customStatus.length.detail), JSON.stringify(customStatus?.length));
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "saveCustom");
	check("custom key without a valid length shows an alert", await waitFor(() => sdSince(m, "showAlert", "saveCustom").length > 0));
	check("custom key without a valid length doesn't reach OBS", savesSince(o).length === 0);

	contexts.saveCustom.settings = {};
	send("didReceiveSettings", "saveCustom");
	await waitFor(() => customLabel("saveCustom") === "2 min");

	// ------------------------------------------------------------------- chibisafe uploads

	const setChibisafe = (settings) =>
		plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, ...settings } } }));
	const chibisafeStatus = async (predicate) => {
		const start = sdMessages.length;
		send("propertyInspectorDidAppear", "toggle");
		// The panel also receives album lists; only status messages carry the chibisafe state.
		const statuses = () => sdSince(start, "sendToPropertyInspector").filter((x) => x.payload.event === "status").map((x) => x.payload.chibisafe);
		await waitFor(() => statuses().some(predicate), 4_000);
		return statuses().filter(predicate).at(-1) ?? statuses().at(-1);
	};
	const uploadSettings = { chibisafeEnabled: true, chibisafeUrl: chibiUrl, chibisafeApiKey: chibi.apiKey, chibisafeAlbum: chibi.album };

	setChibisafe({ ...uploadSettings, chibisafeEnabled: false });
	let chibiStatus = await chibisafeStatus((c) => c?.state === "ready");
	check("the connection is checked before uploading is switched on", chibiStatus?.state === "ready" && chibiStatus.enabled === false, JSON.stringify(chibiStatus));

	const albumItems = async (isRefresh = false) => {
		const start = sdMessages.length;
		plugin.send(JSON.stringify({ event: "sendToPlugin", action: contexts.toggle.action, context: "toggle", payload: { event: "getAlbums", isRefresh } }));
		await waitFor(() => sdSince(start, "sendToPropertyInspector").some((x) => x.payload.event === "getAlbums"));
		return sdSince(start, "sendToPropertyInspector").find((x) => x.payload.event === "getAlbums")?.payload.items;
	};
	let r = chibiRequests.length;
	const items = await albumItems();
	check(
		"album dropdown lists albums by name",
		JSON.stringify(items) === JSON.stringify([{ value: "", label: "No album" }, { value: chibi.album, label: "Clips" }, { value: "album-2", label: "Highlights" }]),
		JSON.stringify(items),
	);
	check("album list is fetched page by page", chibiRequests.some((x) => x.url === "/api/albums?page=2&limit=100"));

	r = chibiRequests.length;
	await albumItems();
	check("album list is reused when a panel opens again shortly after", !chibiRequests.slice(r).some((x) => x.pathname === "/api/albums"));
	r = chibiRequests.length;
	await albumItems(true);
	check("the dropdown's refresh button always fetches the album list", chibiRequests.slice(r).some((x) => x.pathname === "/api/albums"));

	setChibisafe(uploadSettings);
	chibiStatus = await chibisafeStatus((c) => c?.state === "ready" && c.enabled);
	check("chibisafe settings are verified", chibiStatus?.state === "ready" && /tester/.test(chibiStatus.detail) && /Clips/.test(chibiStatus.detail), chibiStatus?.detail);

	r = chibiRequests.length;
	m = sdMessages.length;
	send("keyDown", "save15");
	const uploading = () => facesSince(m, "save15").some((name) => /^upload-\d+$/.test(name));
	check("upload: key shows UPLOADING", await waitFor(uploading, 8_000), facesSince(m, "save15").join(" → "));
	check("upload: key shows LINK COPIED", await waitFor(() => facesSince(m, "save15").includes("upload-copied"), 8_000), facesSince(m, "save15").join(" → "));
	let upload = chibiUploads.at(-1);
	const trimmedClip = path.join(recordings, `Replay ${saveCount}_trimmed.mp4`);
	check("upload: the trimmed clip is uploaded", upload?.name === path.basename(trimmedClip) && upload.content.equals(readFileSync(trimmedClip)), upload?.name);
	check("upload: large clips are sent in chunks", upload?.chunks === 3, `${upload?.chunks} chunks`);
	check("upload: clips go into the album", upload?.album === chibi.album);
	check(
		"upload: reuses the connection check instead of checking the server and album again",
		!chibiRequests.slice(r).some((x) => x.pathname === "/api/settings" || x.pathname.startsWith("/api/album/")),
		chibiRequests.slice(r).map((x) => `${x.method} ${x.pathname}`).join(", "),
	);
	check("upload: every upload request carries the API key", chibiRequests.slice(r).filter((x) => x.pathname === "/api/upload").every((x) => x.headers["x-api-key"] === chibi.apiKey));
	check("upload: the link is copied to the clipboard", clipboard() === `https://chibi.test/${encodeURIComponent(path.basename(trimmedClip))}`, clipboard());
	await faceBecomes("save15", "save-15-ready", 6_000);

	// Per-key albums: the save keys' dropdown offers the default album, no album, or any album.
	m = sdMessages.length;
	send("propertyInspectorDidAppear", "save60");
	plugin.send(JSON.stringify({ event: "sendToPlugin", action: contexts.save60.action, context: "save60", payload: { event: "getKeyAlbums" } }));
	await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.event === "getKeyAlbums"));
	const keyItems = sdSince(m, "sendToPropertyInspector").find((x) => x.payload.event === "getKeyAlbums")?.payload.items;
	check(
		"per-key album dropdown offers Default, No album and every album",
		JSON.stringify(keyItems) ===
			JSON.stringify([
				{ value: "", label: "Default (Clips)" },
				{ value: "none", label: "No album" },
				{ value: chibi.album, label: "Clips" },
				{ value: "album-2", label: "Highlights" },
			]),
		JSON.stringify(keyItems),
	);
	check("the on/off key's album dropdown isn't sent to a save key", !sdSince(m, "sendToPropertyInspector").some((x) => x.payload.event === "getAlbums"));

	contexts.save60.settings = { album: "album-2" };
	send("keyDown", "save60");
	check("per-key album: key shows LINK COPIED", await faceBecomes("save60", "upload-copied", 8_000), face("save60"));
	check("per-key album: the clip goes into that key's album", chibiUploads.at(-1)?.album === "album-2", chibiUploads.at(-1)?.album);
	await faceBecomes("save60", "save-60-ready", 6_000);

	contexts.save60.settings = { album: "none" };
	send("keyDown", "save60");
	check("per-key No album: key shows LINK COPIED", await faceBecomes("save60", "upload-copied", 8_000), face("save60"));
	check("per-key No album: the clip isn't added to the default album", chibiUploads.at(-1)?.album === undefined, chibiUploads.at(-1)?.album);
	contexts.save60.settings = {};
	await faceBecomes("save60", "save-60-ready", 6_000);

	contexts.save30.settings = { upload: false };
	r = chibiRequests.length;
	send("keyDown", "save30");
	check("per-key opt-out: key shows SAVED", await faceBecomes("save30", "save-30-saved"), face("save30"));
	await sleep(1_000);
	check("per-key opt-out: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));
	await faceBecomes("save30", "save-30-ready", 6_000);

	// Ticking the key's upload box again: Stream Deck sends the key's new settings to the plugin.
	m = sdMessages.length;
	contexts.save30.settings = { upload: true };
	send("propertyInspectorDidAppear", "save30");
	send("didReceiveSettings", "save30");
	await sleep(1_500);
	check("re-enabling a key's upload alerts no key", sdSince(m, "showAlert").length === 0, JSON.stringify(sdSince(m, "showAlert").map((x) => x.context)));
	check(
		"re-enabling a key's upload leaves every save key's face alone",
		Object.keys(contexts).filter((c) => c.startsWith("save")).every((c) => /-(ready)$/.test(face(c))),
		Object.keys(contexts).map((c) => `${c}=${face(c)}`).join(" "),
	);
	check("plugin is still running", child.exitCode === null && child.signalCode === null, `${child.exitCode}/${child.signalCode}`);
	contexts.save30.settings = {};

	obsState.trim = "fail";
	m = sdMessages.length;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("failed trim: key shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 6_000));
	check("failed trim: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));
	obsState.trim = "fail-fast";
	m = sdMessages.length;
	r = chibiRequests.length;
	const failFastStart = Date.now();
	send("keyDown", "save15");
	check("trim that fails between polls: alert comes quickly", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 10_000), `${Date.now() - failFastStart} ms`);
	check("trim that fails between polls: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));
	obsState.trim = "ok";

	obsState.foreignSaveFirst = true;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("save reported after a foreign save: key shows LINK COPIED", await faceBecomes("save15", "upload-copied", 8_000), face("save15"));
	check("save reported after a foreign save: our trimmed clip is uploaded", /^Replay \d+_trimmed\.mp4$/.test(chibiUploads.at(-1)?.name ?? ""), chibiUploads.at(-1)?.name);
	obsState.foreignSaveFirst = false;
	await faceBecomes("save15", "save-15-ready", 6_000);

	obsState.clipSize = 0;
	m = sdMessages.length;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("empty clip: key shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 6_000));
	check("empty clip: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));
	obsState.clipSize = 2_500;

	chibi.fail502 = 1;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("502 on a middle chunk is retried and the upload succeeds", await faceBecomes("save15", "upload-copied", 10_000), face("save15"));
	await faceBecomes("save15", "save-15-ready", 6_000);

	chibi.fail502 = "final";
	m = sdMessages.length;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("502 on the final chunk shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 10_000));
	check(
		"502 on the final chunk isn't resent (the server may have stored it)",
		chibiRequests.slice(r).filter((x) => x.pathname === "/api/upload" && x.headers["chibi-chunk-number"] === "3").length === 1,
	);

	obsState.clipSize = chibi.maxSize + 1;
	m = sdMessages.length;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("clip over the size limit: key shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 6_000));
	check("clip over the size limit: the log gives distinguishable sizes", /The clip is 100 KB, over the server's limit of 99\.9 KB/.test(logText()), logText().match(/The clip is[^\n]*/)?.[0]);
	check("clip over the size limit: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));
	obsState.clipSize = 2_500;

	// The failed upload above cleared the plugin's cached server settings, so it notices the switch to S3.
	chibi.useNetworkStorage = true;
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("S3 storage: key shows LINK COPIED", await faceBecomes("save15", "upload-copied", 8_000), face("save15"));
	upload = chibiUploads.at(-1);
	check("S3 storage: the clip is stored and registered", upload?.s3 === true && upload.content?.length === 2_500 && upload.album === chibi.album);
	check("S3 storage: the storage upload doesn't get the API key", chibiRequests.slice(r).filter((x) => x.method === "PUT").every((x) => !x.headers["x-api-key"]));
	check("S3 storage: the link is copied", clipboard().startsWith("https://s3.test/"), clipboard());
	chibi.useNetworkStorage = false;
	await faceBecomes("save15", "save-15-ready", 6_000);

	m = sdMessages.length;
	setChibisafe({ ...uploadSettings, chibisafeApiKey: "wrong" });
	chibiStatus = await chibisafeStatus((c) => c?.state === "error");
	check("wrong API key is reported", chibiStatus?.state === "error" && /API key/.test(chibiStatus.detail), chibiStatus?.detail);
	await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.event === "getAlbums"));
	const reloaded = sdSince(m, "sendToPropertyInspector").filter((x) => x.payload.event === "getAlbums").at(-1)?.payload.items ?? [];
	check(
		"album dropdown reloads when the API key changes",
		reloaded.some((item) => item.value === chibi.album && item.label === "Current album") && reloaded.some((item) => item.disabled && /API key/.test(item.label)),
		JSON.stringify(reloaded),
	);
	m = sdMessages.length;
	send("keyDown", "save15");
	check("wrong API key: upload shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0, 6_000));

	chibi.albumStatus = 500;
	setChibisafe({ ...uploadSettings, chibisafeAlbum: chibi.album, chibisafeUrl: `${chibiUrl}/` });
	chibiStatus = await chibisafeStatus((c) => c?.state === "error");
	check("server error while checking the album isn't called a missing album", chibiStatus?.state === "error" && !/wasn't found/.test(chibiStatus.detail), chibiStatus?.detail);
	chibi.albumStatus = 200;

	setChibisafe({ ...uploadSettings, chibisafeAlbum: "missing" });
	chibiStatus = await chibisafeStatus((c) => c?.state === "error");
	check("unknown album is reported", chibiStatus?.state === "error" && /album/i.test(chibiStatus.detail), chibiStatus?.detail);

	setChibisafe({ ...uploadSettings, chibisafeUrl: "http://example.com" });
	chibiStatus = await chibisafeStatus((c) => c?.state === "error");
	check("plain http to a remote server is refused", chibiStatus?.state === "error" && /https/.test(chibiStatus.detail), chibiStatus?.detail);

	setChibisafe({ ...uploadSettings, chibisafeEnabled: false });
	chibiStatus = await chibisafeStatus((c) => c?.enabled === false);
	r = chibiRequests.length;
	send("keyDown", "save15");
	check("uploads off globally: key shows SAVED", await faceBecomes("save15", "save-15-saved"), face("save15"));
	await sleep(1_000);
	check("uploads off globally: nothing is uploaded", !chibiRequests.slice(r).some((x) => x.pathname === "/api/upload"));

	o = obsRequests.length;
	send("keyDown", "toggle", { isInMultiAction: true, userDesiredState: 0 });
	check("multi-action state 0 stops the buffer", await waitFor(() => obsRequests.slice(o).some((r) => r.requestType === "StopReplayBuffer")));
	check("toggle shows OFF after stopping", await faceBecomes("toggle", "toggle-off"), face("toggle"));
	m = sdMessages.length;
	send("keyDown", "toggle", { isInMultiAction: true, userDesiredState: 0 });
	await sleep(300);
	check("stopping an already stopped buffer isn't an error", sdSince(m, "showAlert").length === 0);

	await stopObs();
	check("toggle shows NO OBS when OBS closes", await faceBecomes("toggle", "toggle-offline"), face("toggle"));
	check("save keys show offline when OBS closes", await faceBecomes("save15", "save-15-offline"), face("save15"));
	m = sdMessages.length;
	send("keyDown", "save15");
	check("save while disconnected shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));

	obsState.replayActive = true;
	await startObs();
	// The plugin retries every 5 seconds.
	check("reconnects when OBS comes back", await faceBecomes("toggle", "toggle-on", 15_000), face("toggle"));

	// ------------------------------------------------------------------- opening OBS from the On/Off key

	const setGlobal = (settings) => plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, ...settings } } }));
	let obsApp = (await panelStatus("toggle"))?.obsApp;
	check("settings panel shows which OBS the On/Off key opens", obsApp?.ok === true && obsApp.detail.includes(path.join(fakeBin, "obs")), obsApp?.detail);

	await stopObs();
	await faceBecomes("toggle", "toggle-offline");

	// OBS runs, but its WebSocket server can't be reached (e.g. it's switched off): don't open OBS again.
	writeFileSync(obsRunningFile, "");
	m = sdMessages.length;
	send("keyDown", "toggle");
	check("NO OBS while OBS runs: alert", await waitFor(() => sdSince(m, "showAlert", "toggle").length > 0));
	check("NO OBS while OBS runs: OBS isn't opened again", obsLaunches().length === 0, obsLaunches().join(", "));
	check("NO OBS while OBS runs: the log says to check the WebSocket server", await waitFor(() => logText().includes("its WebSocket server can't be reached")));
	rmSync(obsRunningFile);

	setGlobal({ obsPath: path.join(tempHome, "missing", "obs") });
	await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.obsApp?.ok === false));
	obsApp = (await panelStatus("toggle"))?.obsApp;
	check("a wrong OBS app path is reported", obsApp?.ok === false && /doesn't exist/.test(obsApp.detail), obsApp?.detail);

	// OBS is closed: NO OBS opens it, here from the OBS app setting.
	setGlobal({ obsPath: portableObs });
	await sleep(300);
	m = sdMessages.length;
	send("keyDown", "toggle");
	check("pressing NO OBS opens OBS", await waitFor(() => obsLaunches().includes(portableObs)), obsLaunches().join(", "));
	check("toggle shows STARTING OBS", await faceBecomes("toggle", "toggle-obs-starting"), face("toggle"));
	send("keyDown", "toggle");
	await sleep(1_000);
	check("pressing again while OBS starts doesn't open it twice", obsLaunches().length === 1, obsLaunches().join(", "));

	// OBS accepts the connection before it has finished starting; the keys wait until it's ready.
	obsState.ready = false;
	o = obsRequests.length;
	await startObs();
	check("connects within seconds once OBS's WebSocket server is up", await waitFor(() => obsRequests.slice(o).some((r) => r.requestType === "GetVersion")));
	await sleep(1_500);
	check("toggle stays on STARTING OBS while OBS is still starting", face("toggle") === "toggle-obs-starting", face("toggle"));
	check("settings panel says OBS is starting", (await panelStatus("toggle"))?.connection === "loading");
	const saveStart = sdMessages.length;
	send("keyDown", "save15");
	check("save while OBS is still starting shows an alert", await waitFor(() => sdSince(saveStart, "showAlert", "save15").length > 0));
	check("the log says OBS is still starting", await waitFor(() => logText().includes("Save 15 sec: OBS is still starting")));
	const ready = Date.now();
	obsState.ready = true;
	check("toggle shows the replay buffer state once OBS is ready", await faceBecomes("toggle", "toggle-on", 3_000), `${Date.now() - ready} ms`);
	check(
		"toggle goes straight from STARTING OBS to ON, without DISABLED or OFF in between",
		facesSince(m, "toggle").join(" → ") === "toggle-obs-starting → toggle-on",
		facesSince(m, "toggle").join(" → "),
	);

	m = sdMessages.length;
	plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, port: "99999" } } }));
	await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.error?.includes("Invalid port")));
	check("an invalid port is reported", sdSince(m, "sendToPropertyInspector").some((x) => x.payload.error?.includes("Invalid port")));

	m = sdMessages.length;
	plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, password: "wrong" } } }));
	check("a wrong password is reported", await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.connection === "auth-failed")));

	// A server that accepts the connection but never speaks the obs-websocket protocol.
	const silent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((resolve) => silent.once("listening", resolve));
	m = sdMessages.length;
	plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, port: String(silent.address().port) } } }));
	check(
		"a server that never answers times out",
		await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.error === "OBS did not respond"), 12_000),
	);
	for (const ws of silent.clients) ws.terminate();
	silent.close();

	const logs = logText();
	check("plugin writes its log", logs.includes("Connected to obs-websocket"));
	check("the OBS password and chibisafe API key never appear in logs or output", ![PASSWORD, chibi.apiKey].some((secret) => logs.includes(secret) || pluginOutput.includes(secret)));
} catch (error) {
	console.error(error);
	failures++;
} finally {
	child.kill();
	streamDeck.close();
	await stopObs().catch(() => undefined);
	chibiServer.close();
	rmSync(tempHome, { recursive: true, force: true });
	if (failures) console.log(`\n--- plugin output ---\n${pluginOutput.slice(-3000)}`);
	console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
	process.exitCode = failures ? 1 : 0;
}
