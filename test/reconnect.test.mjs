/**
 * Unit test for when the plugin tries to connect to OBS again (src/reconnect.ts).
 *
 * Run with `npm test`.
 */
import { nextRetry } from "../src/reconnect.ts";

let failures = 0;
function check(name, passed, detail = "") {
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	if (!passed) failures++;
}

/** The delays of `count` failed attempts in a row, starting from no failures. */
function delays(count, options) {
	const result = [];
	let state = { failures: 0 };
	for (let i = 0; i < count; i++) {
		state = nextRetry(state.failures, options);
		result.push(state.delay / 1000);
	}
	return { delays: result, failures: state.failures };
}

const closed = delays(6, { authFailed: false, opening: false });
check("a closed OBS is retried after 5, 10, 20, 40, then every 60 seconds", closed.delays.join() === "5,10,20,40,60,60", closed.delays.join());

const wrongPassword = delays(4, { authFailed: true, opening: false });
check("a wrong password waits at least 30 seconds", wrongPassword.delays.join() === "30,30,30,40", wrongPassword.delays.join());

const opening = delays(30, { authFailed: false, opening: true });
check("while OBS opens, it's retried every 2 seconds", opening.delays.every((delay) => delay === 2));

// Regression: a minute of quick retries used to count as 30 failures, so once the opening window ended
// the next retry was a full minute away, although OBS (held up by a dialog) could be up any moment.
check("retries while OBS opens don't count as failures", opening.failures === 0, `${opening.failures} failures`);
const afterOpening = nextRetry(opening.failures, { authFailed: false, opening: false });
check("after the opening window, the backoff starts at 5 seconds again", afterOpening.delay === 5_000, `${afterOpening.delay / 1000} s`);

const rejected = nextRetry(0, { authFailed: true, opening: true });
check("a wrong password while OBS opens isn't retried quickly", rejected.delay === 30_000 && rejected.failures === 1, `${rejected.delay / 1000} s`);

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exitCode = failures ? 1 : 0;
