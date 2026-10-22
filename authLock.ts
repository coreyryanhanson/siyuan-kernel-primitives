// The kernel's per-IP auth-lock schedule and the consumer-side dodge over
// it. Version-coupled at 3.8.8. The consumer's circuit breaker is the
// reducer here plus session-lifetime state it owns.

/** The kernel's per-IP auth-lock schedule, pinned at 3.8.8: locking starts
 * at the 6th auth failure inside the kernel's 15-minute sliding failure
 * window (failures older than the window are forgotten), 60s (the 30s base
 * doubled at the lock threshold) and doubling per further failure
 * (`30 << (fail − 5)`), capped at 15 minutes; failures 1–5 arm no lock. Any
 * call — a correct-token call included — inside an active lock records
 * another failure and overwrites the lock, so consumers dodge (wait it out),
 * never retry into it. */
export function authLockSeconds(failures: number): number {
	if (failures < 6) return 0;
	return Math.min(900, 30 * 2 ** (failures - 5));
}

/** The dodge schedule over that lock, shaped entirely by it: a consumer's
 * local circuit breaker is this reducer plus session-lifetime state. The
 * kernel-relative facts it encodes:
 *
 * - Threshold 3, not the kernel's 6: the lock counts failures per IP across
 *   all identities, so a single misconfigured session tripping at 3 keeps
 *   three failures in reserve for other clients sharing the IP — the
 *   session stops itself before it can arm (or feed) a real lock. The
 *   margin is kernel-relative: a schedule that locked earlier would break it.
 * - A 429 is not evidence this session's token is wrong (the lock is
 *   per-IP), so it never advances the failure count and never resets it.
 * - The served `Retry-After` can understate a lock extended since it was
 *   computed, so the first-lock value (`authLockSeconds(6)`) floors the max.
 * - The cooldown deadline only ever extends (monotonic max): a call inside
 *   a lock re-arms it, so an earlier deadline must never mask a later one.
 * - A success clears the failure count but leaves an armed cooldown alone —
 *   clearing it early would invite the retry that re-arms the real lock. */
export const AUTH_DODGE_THRESHOLD = 3;

/** The reducer's state: pure data, no lifecycle — the consumer owns how long
 * it survives (per session, per process; persistence is its call). */
export interface AuthDodgeState {
	consecutiveAuthFailures: number;
	/** Epoch ms before which a retry must not be issued; 0 = none armed. */
	cooldownUntil: number;
}

export type AuthDodgeEvent =
	| { kind: "auth-failure" }
	| { kind: "success" }
	| { kind: "rate-limit"; servedRetryAfterSeconds: number | undefined };

export function authLockDodge(
	state: AuthDodgeState,
	event: AuthDodgeEvent,
	now: number,
): AuthDodgeState {
	switch (event.kind) {
		case "auth-failure":
			return {
				...state,
				consecutiveAuthFailures: state.consecutiveAuthFailures + 1,
			};
		case "success":
			return { ...state, consecutiveAuthFailures: 0 };
		case "rate-limit": {
			const floor = authLockSeconds(6);
			const seconds = Math.max(floor, event.servedRetryAfterSeconds ?? floor);
			return {
				...state,
				cooldownUntil: Math.max(state.cooldownUntil, now + seconds * 1000),
			};
		}
	}
}

/** The threshold judgment: whether this session has spent enough failures
 * that it must stop calling before it arms (or feeds) the real per-IP lock. */
export function authDodgeTripped(state: AuthDodgeState): boolean {
	return state.consecutiveAuthFailures >= AUTH_DODGE_THRESHOLD;
}
