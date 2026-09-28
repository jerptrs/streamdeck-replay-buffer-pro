import { spawn } from "node:child_process";

/** Copies text to the system clipboard using the OS's own tool (no shell involved). */
export function copyToClipboard(text: string): Promise<void> {
	const [command, ...args] =
		process.platform === "win32"
			? ["clip"]
			: process.platform === "darwin"
				? ["pbcopy"]
				: // Stream Deck doesn't run on Linux; this lets the tests run there.
					["xclip", "-selection", "clipboard"];

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
		child.on("error", (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
		child.stdin.end(text);
	});
}
