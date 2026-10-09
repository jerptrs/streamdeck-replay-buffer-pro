/**
 * Unit test for reading the results of the tools that find OBS and check whether it runs. The
 * end-to-end test runs on Linux, so the Windows parsing is checked here. The English samples match real
 * `reg` and `tasklist` output from Windows 11 (checked on 2026-10-04); the German ones follow the same
 * format with localized text.
 *
 * Run with `npm test`.
 */
import { parseRegistryDefault, pgrepRunning, tasklistHasImage, tasklistRunning } from "../src/obs-app.ts";

let failures = 0;
function check(name, passed, detail = "") {
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	if (!passed) failures++;
}

// reg query "HKLM\SOFTWARE\OBS Studio" /ve, on English and German Windows.
const regEnglish = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OBS Studio\r\n    (Default)    REG_SZ    C:\\Program Files\\obs-studio\r\n\r\n";
const regGerman = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OBS Studio\r\n    (Standard)    REG_SZ    D:\\Apps\\OBS Studio\r\n\r\n";
const regMissing = "ERROR: The system was unable to find the specified registry key or value.\r\n";
const regEmpty = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OBS Studio\r\n    (Default)    REG_SZ    \r\n\r\n";

check("registry: install folder", parseRegistryDefault(regEnglish) === "C:\\Program Files\\obs-studio", parseRegistryDefault(regEnglish));
check("registry: folder on German Windows, with a space", parseRegistryDefault(regGerman) === "D:\\Apps\\OBS Studio", parseRegistryDefault(regGerman));
check("registry: missing key", parseRegistryDefault(regMissing) === undefined);
check("registry: empty value", parseRegistryDefault(regEmpty) === undefined, JSON.stringify(parseRegistryDefault(regEmpty)));

// tasklist /FI "IMAGENAME eq obs64.exe" /FO CSV /NH
const running = '"obs64.exe","12345","Console","1","312.456 K"\r\n';
const notRunningEnglish = "INFO: No tasks are running which match the specified criteria.\r\n";
const notRunningGerman = "INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.\r\n";
const similarName = '"obs64.exe.bak","4242","Console","1","1.024 K"\r\n';

check("tasklist: OBS running", tasklistHasImage(running, "obs64.exe"));
check("tasklist: case doesn't matter", tasklistHasImage(running, "OBS64.EXE"));
check("tasklist: not running (English)", !tasklistHasImage(notRunningEnglish, "obs64.exe"));
check("tasklist: not running (German)", !tasklistHasImage(notRunningGerman, "obs64.exe"));
check("tasklist: a similarly named process isn't OBS", !tasklistHasImage(similarName, "obs64.exe"));

// Whether OBS runs: a failed check is "don't know", never "not running".
check("tasklist exit 0 with OBS listed: running", tasklistRunning(0, running, "obs64.exe") === true);
check("tasklist exit 0 without OBS: not running", tasklistRunning(0, notRunningEnglish, "obs64.exe") === false);
check("tasklist failed: unknown", tasklistRunning(1, "", "obs64.exe") === undefined);
check("tasklist missing or timed out: unknown", tasklistRunning(-1, "", "obs64.exe") === undefined);
check("pgrep exit 0: running", pgrepRunning(0) === true);
check("pgrep exit 1: not running", pgrepRunning(1) === false);
check("pgrep error (exit 2): unknown", pgrepRunning(2) === undefined);
check("pgrep missing or timed out: unknown", pgrepRunning(-1) === undefined);

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exitCode = failures ? 1 : 0;
