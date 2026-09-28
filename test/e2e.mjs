/**
 * End-to-end test: runs the built plugin (bin/plugin.js) against a fake Stream Deck app and a fake
 * obs-websocket v5 server, presses keys, and checks what reaches OBS and which key faces are shown.
 *
 * Run with `npm test` (builds first).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.replay-buffer-pro.obs.sdPlugin");
const UUID = "com.replay-buffer-pro.obs";
const PASSWORD = randomBytes(12).toString("hex");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` returns true, or gives up after `timeout` ms. */
async function waitFor(predicate, timeout = 2_000) {
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

const obsState = { replayActive: false, recRBTime: "300", mode: "Simple", replayBufferPro: true };
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

			switch (requestType) {
				case "GetReplayBufferStatus":
					return ok({ outputActive: obsState.replayActive });
				case "GetHotkeyList": {
					const rbp = obsState.replayBufferPro ? [1, 2, 3, 4, 5, 6].map((i) => `ReplayBufferPro.SaveButton${i}`) : [];
					return ok({ hotkeys: ["OBSBasic.StartStreaming", ...rbp] });
				}
				case "GetProfileParameter": {
					const { parameterCategory, parameterName } = requestData;
					if (parameterCategory === "Output" && parameterName === "Mode") {
						return ok({ parameterValue: obsState.mode, defaultParameterValue: "Simple" });
					}
					const activeSection = obsState.mode === "Advanced" ? "AdvOut" : "SimpleOutput";
					return ok({ parameterValue: parameterCategory === activeSection ? obsState.recRBTime : "20", defaultParameterValue: "20" });
				}
				case "ToggleReplayBuffer":
				case "StartReplayBuffer":
				case "StopReplayBuffer": {
					const target = requestType === "ToggleReplayBuffer" ? !obsState.replayActive : requestType === "StartReplayBuffer";
					if (target === obsState.replayActive) return fail(target ? 500 : 501, "Output already in that state");
					ok(requestType === "ToggleReplayBuffer" ? { outputActive: target } : undefined);
					return setReplay(target);
				}
				case "TriggerHotkeyByName":
					if (!obsState.replayBufferPro || !requestData.hotkeyName.startsWith("ReplayBufferPro.")) {
						return fail(600, "No hotkeys were found by that name.");
					}
					ok();
					setTimeout(() => emit("ReplayBufferSaved", { savedReplayPath: "C:/Videos/Replay.mkv" }), 300);
					return;
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
const triggeredSince = (index) => obsRequests.slice(index).filter((r) => r.requestType === "TriggerHotkeyByName").map((r) => r.requestData.hotkeyName);

// Map the base64 images the plugin sends back to their file names. Identical faces (every "SAVED"
// face looks the same) share an entry, so pick the name that matches the key.
const keyImages = new Map();
for (const file of readdirSync(path.join(PLUGIN_DIR, "imgs", "keys")).filter((f) => f.endsWith("@2x.png"))) {
	const data = `data:image/png;base64,${readFileSync(path.join(PLUGIN_DIR, "imgs", "keys", file)).toString("base64")}`;
	keyImages.set(data, [...(keyImages.get(data) ?? []), file.replace("@2x.png", "")]);
}

function face(context) {
	const image = sdSince(0, "setImage", context).at(-1)?.payload.image;
	const names = keyImages.get(image) ?? [];
	const prefix = contexts[context].action.split(".").at(-1);
	return names.find((name) => name.startsWith(prefix)) ?? names.join("|");
}

const faceBecomes = (context, name, timeout) => waitFor(() => face(context) === name, timeout);

// --------------------------------------------------------------------------- Replay Buffer Pro config

// Point OBS's config folder at a temp dir on every OS so the test never reads a real config.
const tempHome = mkdtempSync(path.join(os.tmpdir(), "rbp-e2e-"));
const obsConfigDir =
	process.platform === "win32"
		? path.join(tempHome, "obs-studio")
		: process.platform === "darwin"
			? path.join(tempHome, "Library", "Application Support", "obs-studio")
			: path.join(tempHome, "obs-studio");
const rbpSettingsFile = path.join(obsConfigDir, "plugin_config", "replay-buffer-pro", "save_button_settings.json");

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
	{ cwd: PLUGIN_DIR, env: { ...process.env, APPDATA: tempHome, HOME: tempHome, XDG_CONFIG_HOME: tempHome }, stdio: ["ignore", "pipe", "pipe"] },
);
let pluginOutput = "";
child.stdout.on("data", (chunk) => (pluginOutput += chunk));
child.stderr.on("data", (chunk) => (pluginOutput += chunk));

try {
	await pluginRegistered;
	check("plugin registers with Stream Deck", true);
	check("connects and authenticates to OBS", await waitFor(() => obsRequests.some((r) => r.requestType === "GetReplayBufferStatus")));
	check("detects Replay Buffer Pro", await waitFor(() => obsRequests.some((r) => r.requestType === "GetHotkeyList")));

	for (const context of Object.keys(contexts)) send("willAppear", context);
	check("toggle shows OFF while the buffer is stopped", await faceBecomes("toggle", "toggle-off"), face("toggle"));
	check("save keys show inactive while the buffer is stopped", await faceBecomes("save60", "save-60-inactive"), face("save60"));

	let m = sdMessages.length;
	let o = obsRequests.length;
	send("keyDown", "save15");
	check("save with the buffer off shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));
	check("save with the buffer off doesn't reach OBS", triggeredSince(o).length === 0);

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
	check("15 sec triggers ReplayBufferPro.SaveButton1", await waitFor(() => triggeredSince(o)[0] === "ReplayBufferPro.SaveButton1"), triggeredSince(o)[0]);
	check("15 sec shows SAVING", await faceBecomes("save15", "save-15-saving"), face("save15"));
	check("15 sec shows SAVED when OBS reports the file", await faceBecomes("save15", "save-15-saved"), face("save15"));
	check("15 sec returns to ready", await faceBecomes("save15", "save-15-ready", 3_000), face("save15"));

	o = obsRequests.length;
	send("keyDown", "save60");
	check("60 sec triggers ReplayBufferPro.SaveButton3", await waitFor(() => triggeredSince(o)[0] === "ReplayBufferPro.SaveButton3"), triggeredSince(o)[0]);

	contexts.save30.settings = { slot: "5" };
	o = obsRequests.length;
	send("keyDown", "save30");
	check("a manually chosen button is used", await waitFor(() => triggeredSince(o)[0] === "ReplayBufferPro.SaveButton5"), triggeredSince(o)[0]);
	contexts.save30.settings = {};

	obsState.mode = "Advanced";
	obsState.recRBTime = "20";
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "save30");
	check("clip longer than the buffer shows an alert", await waitFor(() => sdSince(m, "showAlert", "save30").length > 0));
	check("clip longer than the buffer doesn't reach OBS", triggeredSince(o).length === 0);
	check("buffer length comes from the active output mode", obsRequests.slice(o).some((r) => r.requestData?.parameterCategory === "AdvOut"));
	obsState.mode = "Simple";
	obsState.recRBTime = "300";

	mkdirSync(path.dirname(rbpSettingsFile), { recursive: true });
	writeFileSync(rbpSettingsFile, JSON.stringify({ version: 1, save_buttons: [{ seconds: 10 }, { seconds: 60 }, { seconds: 15 }, { seconds: 120 }] }));
	o = obsRequests.length;
	send("keyDown", "save15");
	check("customised buttons: 15 sec maps to button 3", await waitFor(() => triggeredSince(o)[0] === "ReplayBufferPro.SaveButton3"), triggeredSince(o)[0]);
	m = sdMessages.length;
	o = obsRequests.length;
	send("keyDown", "save30");
	check("customised buttons without 30 sec: alert, nothing sent", (await waitFor(() => sdSince(m, "showAlert", "save30").length > 0)) && triggeredSince(o).length === 0);

	m = sdMessages.length;
	send("propertyInspectorDidAppear", "save30");
	await waitFor(() => sdSince(m, "sendToPropertyInspector").length > 0);
	let status = sdSince(m, "sendToPropertyInspector").at(-1)?.payload;
	check("settings panel gets the connection status", status?.connection === "connected" && status.replay === "started" && status.replayBufferPro === true, JSON.stringify(status));
	check("settings panel explains the missing 30 sec button", status?.slot?.ok === false && /30 sec/.test(status.slot.detail), status?.slot?.detail);

	rmSync(rbpSettingsFile);
	m = sdMessages.length;
	send("propertyInspectorDidAppear", "save60");
	await waitFor(() => sdSince(m, "sendToPropertyInspector").length > 0);
	status = sdSince(m, "sendToPropertyInspector").at(-1)?.payload;
	check("settings panel shows the default button for 60 sec", status?.slot?.ok === true && /button 3/.test(status.slot.detail), status?.slot?.detail);

	obsState.replayBufferPro = false;
	m = sdMessages.length;
	send("keyDown", "save15");
	check("missing Replay Buffer Pro shows an alert", await waitFor(() => sdSince(m, "showAlert", "save15").length > 0));
	obsState.replayBufferPro = true;

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
	check("reconnects when OBS comes back", await faceBecomes("toggle", "toggle-on", 8_000), face("toggle"));

	m = sdMessages.length;
	plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, port: "99999" } } }));
	await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.error?.includes("Invalid port")));
	check("an invalid port is reported", sdSince(m, "sendToPropertyInspector").some((x) => x.payload.error?.includes("Invalid port")));

	m = sdMessages.length;
	plugin.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { ...globalSettings, password: "wrong" } } }));
	check("a wrong password is reported", await waitFor(() => sdSince(m, "sendToPropertyInspector").some((x) => x.payload.connection === "auth-failed")));

	const logDir = path.join(PLUGIN_DIR, "logs");
	const logs = existsSync(logDir) ? readdirSync(logDir).map((file) => readFileSync(path.join(logDir, file), "utf8")).join("\n") : "";
	check("plugin writes its log", logs.includes("Connected to obs-websocket"));
	check("the OBS password never appears in logs or output", !logs.includes(PASSWORD) && !pluginOutput.includes(PASSWORD));
} catch (error) {
	console.error(error);
	failures++;
} finally {
	child.kill();
	streamDeck.close();
	await stopObs().catch(() => undefined);
	rmSync(tempHome, { recursive: true, force: true });
	if (failures) console.log(`\n--- plugin output ---\n${pluginOutput.slice(-3000)}`);
	console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
	process.exitCode = failures ? 1 : 0;
}
