import { describe, expect, it } from "vitest";
import {
	authLockDodge,
	authLockSeconds,
	authDodgeTripped,
	type AuthDodgeState,
} from "../index.js";

describe("authLockSeconds", () => {
	it("arms no lock before the 6th consecutive auth failure", () => {
		for (let failures = 0; failures <= 5; failures++) {
			expect(authLockSeconds(failures)).toBe(0);
		}
	});

	it("locks 60s at the 6th failure — the breaker's cooldown floor", () => {
		expect(authLockSeconds(6)).toBe(60);
	});

	it("doubles per failure beyond the 6th", () => {
		expect(authLockSeconds(7)).toBe(120);
		expect(authLockSeconds(8)).toBe(240);
		expect(authLockSeconds(9)).toBe(480);
	});

	it("caps at the 15-minute kernel cap", () => {
		expect(authLockSeconds(10)).toBe(900);
		expect(authLockSeconds(11)).toBe(900);
		expect(authLockSeconds(50)).toBe(900);
	});
});

const NOW = 1_000_000;
const fresh: AuthDodgeState = {
	consecutiveAuthFailures: 0,
	cooldownUntil: 0,
};

function failed(n: number, state = fresh): AuthDodgeState {
	let next = state;
	for (let i = 0; i < n; i++) {
		next = authLockDodge(next, { kind: "auth-failure" }, NOW);
	}
	return next;
}

describe("authLockDodge — the dodge schedule over the auth lock", () => {
	it("trips at 3 — one session alone can never arm the kernel's 6-failure lock", () => {
		expect(authDodgeTripped(failed(2))).toBe(false);
		expect(authDodgeTripped(failed(3))).toBe(true);
	});

	it("reset-on-success: the count clears, an armed cooldown is untouched", () => {
		const armed = authLockDodge(
			failed(2),
			{ kind: "rate-limit", servedRetryAfterSeconds: 300 },
			NOW,
		);
		const after = authLockDodge(armed, { kind: "success" }, NOW);
		expect(after.consecutiveAuthFailures).toBe(0);
		expect(after.cooldownUntil).toBe(armed.cooldownUntil);
	});

	it("a 429 never advances the failure count and never resets it", () => {
		const two = failed(2);
		let next = two;
		for (let i = 0; i < 5; i++) {
			next = authLockDodge(
				next,
				{ kind: "rate-limit", servedRetryAfterSeconds: 60 },
				NOW,
			);
		}
		expect(next.consecutiveAuthFailures).toBe(2);
		expect(authDodgeTripped(next)).toBe(false);
		// The count already accumulated survives — one more failure trips.
		expect(authDodgeTripped(failed(1, next))).toBe(true);
	});

	it("the cooldown floors at the kernel's first lock (60s), served value wins the max", () => {
		// Absent Retry-After → floored at authLockSeconds(6).
		const floored = authLockDodge(
			fresh,
			{ kind: "rate-limit", servedRetryAfterSeconds: undefined },
			NOW,
		);
		expect(floored.cooldownUntil).toBe(NOW + 60_000);
		// Served value above the floor wins.
		const served = authLockDodge(
			fresh,
			{ kind: "rate-limit", servedRetryAfterSeconds: 120 },
			NOW,
		);
		expect(served.cooldownUntil).toBe(NOW + 120_000);
		// Served value below the floor is floored up.
		const under = authLockDodge(
			fresh,
			{ kind: "rate-limit", servedRetryAfterSeconds: 5 },
			NOW,
		);
		expect(under.cooldownUntil).toBe(NOW + 60_000);
	});

	it("the deadline only ever extends (monotonic max) — a call inside a lock re-arms it", () => {
		let state = authLockDodge(
			fresh,
			{ kind: "rate-limit", servedRetryAfterSeconds: 60 },
			NOW,
		);
		const firstDeadline = state.cooldownUntil;
		// A later 429 with a longer served value extends past the first.
		state = authLockDodge(
			state,
			{ kind: "rate-limit", servedRetryAfterSeconds: 300 },
			NOW + 1_000,
		);
		expect(state.cooldownUntil).toBe(NOW + 1_000 + 300_000);
		// A later 429 that would compute an earlier deadline never shortens it.
		state = authLockDodge(
			state,
			{ kind: "rate-limit", servedRetryAfterSeconds: undefined },
			NOW + 2_000,
		);
		expect(state.cooldownUntil).toBe(NOW + 1_000 + 300_000);
		expect(firstDeadline).toBe(NOW + 60_000);
	});
});
