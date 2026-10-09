import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Finds and opens OBS on this computer, for the On/Off key's "NO OBS" face. Only OBS itself (or the
 * app set in the "OBS app" setting) is started, without a shell and without arguments.
 */

export type ObsApp =
	/** `command` and `args` start OBS; `cwd` is OBS's own folder, which OBS on Windows needs. */
	| { ok: true; command: string; args: string[]; cwd?: string; detail: string }
	| { ok: false; detail: string };

/** How long the settings panel reuses a lookup; pressing the key always looks again. */
const CACHE_MS = 5 * 60_000;
const TOOL_TIMEOUT_MS = 5_000;

let cache: { key: string; at: number; app: Promise<ObsApp> } | undefined;

async function isFile(file: string): Promise<boolean> {
	return stat(file).then((s) => s.isFile(), () => false);
}

async function isDirectory(dir: string): Promise<boolean> {
	return stat(dir).then((s) => s.isDirectory(), () => false);
}

/** Runs a system tool and returns its exit code and output; a missing tool counts as a failure. */
function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: TOOL_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
			resolve({ code, stdout: String(stdout) });
		});
	});
}

/** The folder in `reg query <key> /ve` output, whatever the system language calls the default value. */
export function parseRegistryDefault(stdout: string): string | undefined {
	return stdout.match(/REG_SZ[ \t]+([^\r\n]+)/)?.[1]?.trim() || undefined;
}

/** Whether `tasklist /FO CSV /NH` output lists `image`; without a match it prints a localized note instead. */
export function tasklistHasImage(stdout: string, image: string): boolean {
	return stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/** OBS's install folders from the registry entry its installer writes, in both registry views. */
async function registryInstallDirs(): Promise<string[]> {
	const results = await Promise.all(
		["/reg:64", "/reg:32"].map((view) => run("reg", ["query", "HKLM\\SOFTWARE\\OBS Studio", "/ve", view])),
	);
	return results.flatMap(({ code, stdout }) => (code === 0 ? (parseRegistryDefault(stdout) ?? []) : []));
}

/** Standard install locations: the installer, Steam, and on macOS the Applications folders. */
async function autoDetect(): Promise<ObsApp> {
	if (process.platform === "win32") {
		// Both registry views usually name the same folder as the default install; check each folder once.
		const dirs = new Set([
			...(await registryInstallDirs()),
			path.join(process.env.ProgramFiles ?? "C:\\Program Files", "obs-studio"),
			path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam", "steamapps", "common", "OBS Studio"),
		]);
		for (const dir of dirs) {
			const exe = path.join(dir, "bin", "64bit", "obs64.exe");
			if (await isFile(exe)) return { ok: true, command: exe, args: [], cwd: path.dirname(exe), detail: exe };
		}
	} else if (process.platform === "darwin") {
		for (const app of ["/Applications/OBS.app", path.join(os.homedir(), "Applications", "OBS.app")]) {
			if (await isDirectory(app)) return { ok: true, command: "open", args: ["-a", app], detail: app };
		}
	} else {
		// Stream Deck doesn't run on Linux; looking OBS up in PATH lets the tests run there.
		for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
			const exe = path.join(dir, "obs");
			if (await isFile(exe)) return { ok: true, command: exe, args: [], cwd: dir, detail: exe };
		}
	}
	const what = process.platform === "darwin" ? "OBS.app" : "obs64.exe";
	return { ok: false, detail: `OBS wasn't found in its usual places. Enter the path to ${what} under OBS app.` };
}

async function fromSetting(setting: string): Promise<ObsApp> {
	if (process.platform === "darwin" && (await isDirectory(setting))) {
		return { ok: true, command: "open", args: ["-a", setting], detail: setting };
	}
	if (await isFile(setting)) {
		return { ok: true, command: setting, args: [], cwd: path.dirname(setting), detail: setting };
	}
	return { ok: false, detail: `"${setting}" doesn't exist.` };
}

/**
 * Works out how to open OBS: the "OBS app" setting when it's set, otherwise a standard install.
 * @param fresh Look again instead of reusing a recent lookup.
 */
export function findObsApp(setting: string, fresh = true): Promise<ObsApp> {
	const key = setting.trim();
	if (!fresh && cache?.key === key && Date.now() - cache.at < CACHE_MS) return cache.app;
	const app = key ? fromSetting(key) : autoDetect();
	cache = { key, at: Date.now(), app };
	return app;
}

/**
 * Whether OBS is running, whatever state its WebSocket server is in; undefined when the check itself
 * failed (the tool is missing or timed out).
 */
export async function obsRunning(app: ObsApp): Promise<boolean | undefined> {
	if (process.platform === "win32") {
		const image = app.ok && app.command.toLowerCase().endsWith(".exe") ? path.basename(app.command) : "obs64.exe";
		const { code, stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"]);
		return tasklistRunning(code, stdout, image);
	}
	return pgrepRunning((await run("pgrep", ["-x", process.platform === "darwin" ? "OBS" : "obs"])).code);
}

/** `tasklist` exits with 0 whether or not anything matched; any other code means the check failed. */
export function tasklistRunning(code: number, stdout: string, image: string): boolean | undefined {
	return code === 0 ? tasklistHasImage(stdout, image) : undefined;
}

/** `pgrep` exits with 0 when it found the process, 1 when it didn't, and anything else when it failed. */
export function pgrepRunning(code: number): boolean | undefined {
	return code === 0 ? true : code === 1 ? false : undefined;
}

/** Starts OBS detached from the plugin, so it keeps running when Stream Deck restarts the plugin. */
export function openObs(app: Extract<ObsApp, { ok: true }>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(app.command, app.args, { cwd: app.cwd, detached: true, stdio: "ignore" });
		child.once("error", (error) => reject(new Error(`Could not start OBS: ${error.message}`)));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
