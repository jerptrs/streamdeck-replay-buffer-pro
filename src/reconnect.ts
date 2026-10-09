/**
 * When to try connecting to OBS again. This module has no imports so the unit tests can load it directly.
 *
 * While OBS isn't reachable, retries start after 5 seconds and double up to once a minute. Pressing a key
 * still retries immediately, so a closed OBS costs one local connection attempt a minute at most.
 */
export const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** A wrong password won't fix itself quickly. */
const AUTH_RETRY_DELAY_MS = 30_000;
/** After OBS is opened from the On/Off key, retry this often to connect as soon as it's up. */
const OPENING_RETRY_DELAY_MS = 2_000;

/**
 * The delay before the next attempt after one failed, and the failure count to keep. While OBS is
 * opening, failed attempts are expected and don't count, so the backoff starts fresh if OBS takes longer
 * than the opening window (for example because it shows a dialog first).
 */
export function nextRetry(failures: number, { authFailed, opening }: { authFailed: boolean; opening: boolean }): { delay: number; failures: number } {
	if (opening && !authFailed) {
		return { delay: OPENING_RETRY_DELAY_MS, failures };
	}
	const count = failures + 1;
	const backoff = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** (count - 1));
	return { delay: authFailed ? Math.max(AUTH_RETRY_DELAY_MS, backoff) : backoff, failures: count };
}
