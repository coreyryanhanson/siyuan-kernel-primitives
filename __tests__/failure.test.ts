// The failure-taxonomy suite — the shared pre-judgment ladder that every
// verified-mutation union composes. Covers the four `MutationFailure` arms
// (drift via `refuseDrift`, transport-unverified / kernel-refused via
// `catchMutation`, verification-failed via `catchVerification`), the
// phase-split rethrow policy (mutation-phase auth/rate-limit rethrow for
// the caller's gate; verification-phase auth/rate-limit classify so the
// acked mutation is never re-readable as "nothing happened"), the
// Retry-After passthrough, the rethrow of non-layer-1 errors, the
// classification totality over every exported layer-1 error class, and the
// siblinghood fact the classifiers match against: the auth/rate-limit/
// timeout/network prototypes do not inherit `SiYuanApiError.prototype`
// (the classifiers order themselves defensively regardless — see
// failure.ts's header comment).

import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanKernelError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import {
	catchMutation,
	catchVerification,
	causeOf,
	refuseDrift,
} from "../failure.js";

function expectRethrown(fn: () => unknown, original: unknown) {
	let caught: unknown;
	try {
		fn();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBe(original);
}

describe("refuseDrift", () => {
	it("refuses drift with the observed version", () => {
		expect(refuseDrift({ verdict: "drift", kernelVersion: "3.8.5" })).toEqual({
			kind: "drift",
			observed: "3.8.5",
		});
	});

	it("passes a match through as undefined", () => {
		expect(refuseDrift({ verdict: "ok", kernelVersion: "3.8.8" })).toBe(
			undefined,
		);
	});
});

describe("catchMutation", () => {
	it("classifies network errors as transport-unverified", () => {
		expect(catchMutation(new SiYuanNetworkError())).toEqual({
			kind: "transport-unverified",
			detail: "SiYuan kernel unreachable",
		});
	});

	it("classifies timeout errors as transport-unverified", () => {
		expect(catchMutation(new SiYuanTimeoutError(5000))).toEqual({
			kind: "transport-unverified",
			detail: "SiYuan request timed out after 5000ms",
		});
	});

	it("classifies API errors as kernel-refused with the message verbatim", () => {
		expect(catchMutation(new SiYuanApiError(500, 7, "boom"))).toEqual({
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 500, code 7: boom)",
		});
	});

	it("rethrows auth errors for the caller's gate", () => {
		const err = new SiYuanAuthError(401);
		expectRethrown(() => catchMutation(err), err);
	});

	it("rethrows rate-limit errors for the caller's gate", () => {
		const err = new SiYuanRateLimitError(429, 30);
		expectRethrown(() => catchMutation(err), err);
	});

	it("rethrows unknown errors", () => {
		const err = new Error("not ours");
		expectRethrown(() => catchMutation(err), err);
	});
});

describe("catchVerification", () => {
	it("classifies network errors as the transport cause", () => {
		expect(catchVerification(new SiYuanNetworkError())).toEqual({
			kind: "verification-failed",
			cause: { kind: "transport" },
			detail: "SiYuan kernel unreachable",
		});
	});

	it("classifies timeout errors as the transport cause", () => {
		expect(catchVerification(new SiYuanTimeoutError(5000))).toEqual({
			kind: "verification-failed",
			cause: { kind: "transport" },
			detail: "SiYuan request timed out after 5000ms",
		});
	});

	it("classifies API errors as the kernel cause", () => {
		expect(catchVerification(new SiYuanApiError(500, 7, "boom"))).toEqual({
			kind: "verification-failed",
			cause: { kind: "kernel" },
			detail: "SiYuan API error (HTTP 500, code 7: boom)",
		});
	});

	it("classifies auth errors as the auth cause", () => {
		expect(catchVerification(new SiYuanAuthError(401))).toEqual({
			kind: "verification-failed",
			cause: { kind: "auth", status: 401 },
			detail: "SiYuan auth rejected the request (HTTP 401)",
		});
	});

	it("classifies rate-limit errors as the rate-limit cause with the served Retry-After", () => {
		expect(catchVerification(new SiYuanRateLimitError(429, 30))).toEqual({
			kind: "verification-failed",
			cause: { kind: "rate-limit", retryAfterSeconds: 30 },
			detail: "SiYuan rate-limited the request (HTTP 429, Retry-After 30s)",
		});
	});

	it("keeps an absent Retry-After undefined", () => {
		const failure = catchVerification(new SiYuanRateLimitError(429));
		expect(failure.cause).toEqual({ kind: "rate-limit" });
	});

	it("rethrows errors that are not layer-1 errors at all", () => {
		const err = new Error("not ours");
		expectRethrown(() => catchVerification(err), err);
	});
});

describe("causeOf", () => {
	it("names each layer-1 class with the evidence its consumers need", () => {
		expect(causeOf(new SiYuanNetworkError())).toEqual({ kind: "transport" });
		expect(causeOf(new SiYuanTimeoutError(5000))).toEqual({
			kind: "transport",
		});
		expect(causeOf(new SiYuanAuthError(403))).toEqual({
			kind: "auth",
			status: 403,
		});
		expect(causeOf(new SiYuanRateLimitError(429, 30))).toEqual({
			kind: "rate-limit",
			retryAfterSeconds: 30,
		});
		expect(causeOf(new SiYuanApiError(500, 7, "boom"))).toEqual({
			kind: "kernel",
		});
	});

	it("keeps an absent Retry-After undefined", () => {
		expect(causeOf(new SiYuanRateLimitError(429))).toEqual({
			kind: "rate-limit",
		});
	});

	it("returns undefined for errors that are not layer-1 errors at all", () => {
		expect(causeOf(new Error("not ours"))).toBeUndefined();
	});
});

// The classification totality guard. `verificationFailureOf`'s contract is
// that EVERY layer-1 error class classifies in the verification phase — a
// raw rethrow there erases "the mutation already acked" and invites a blind
// retry that duplicates the write. Enumerating the live layer-1 export list
// turns a NEW layer-1 error class into a red test here instead of a silent
// fall-through to that rethrow. The identity-surface guard in index.test.ts
// pins this same list for the read barrel; this pins it for the classifiers.
// Construction is generic — instanceof does not care about message
// fidelity, which the named per-class cases above pin.
describe("classification totality", () => {
	function isErrorClass(value: unknown): boolean {
		if (typeof value !== "function") return false;
		const proto = (value as { prototype?: unknown }).prototype;
		if (!(proto instanceof Object)) return false;
		return Error.prototype.isPrototypeOf(proto);
	}

	// The mutation phase deliberately rethrows these two for the caller's
	// gate (breaker / 429-cooldown). Name-keyed so a stale entry fails.
	const MUTATION_RETHROW = new Set(["SiYuanAuthError", "SiYuanRateLimitError"]);
	// The exported base is never thrown directly (layer-1 contract), so it
	// sits outside the classifiers' contract on both phases.
	const NEVER_THROWN = new Set(["SiYuanKernelError"]);

	it("classifies every exported layer-1 error class in both phases", async () => {
		const layer1 = (await import("siyuan-kernel-api")) as Record<
			string,
			unknown
		>;
		const errorClasses = Object.keys(layer1).filter((name) =>
			isErrorClass(layer1[name]),
		);
		expect(errorClasses.length).toBeGreaterThan(0);

		// Both named lists must resolve to live exported error classes —
		// a rename in layer 1 turns this red, not silently moot.
		const stale = [...MUTATION_RETHROW, ...NEVER_THROWN].filter(
			(name) => !isErrorClass(layer1[name]),
		);
		expect(stale).toEqual([]);

		const problems: string[] = [];
		for (const name of errorClasses) {
			if (NEVER_THROWN.has(name)) continue;
			const cls = layer1[name] as new () => Error;
			let instance: Error;
			try {
				instance = Reflect.construct(cls, []);
			} catch {
				problems.push(
					`${name}: cannot construct with no arguments — extend this suite`,
				);
				continue;
			}

			// Verification phase: totality — every class classifies, never
			// rethrows (the mutation has already acked).
			let verified: unknown;
			try {
				verified = catchVerification(instance);
			} catch {
				problems.push(`${name}: catchVerification rethrew`);
				continue;
			}
			if (
				verified === undefined ||
				(verified as { kind?: string }).kind !== "verification-failed"
			) {
				problems.push(`${name}: catchVerification did not classify`);
			}

			// Mutation phase: the rethrow allow-list rethrows the original
			// instance; every other layer-1 class classifies.
			let rethrown: unknown;
			let rethrew = false;
			let mutated: unknown;
			try {
				mutated = catchMutation(instance);
			} catch (err) {
				rethrew = true;
				rethrown = err;
			}
			if (MUTATION_RETHROW.has(name)) {
				if (!rethrew || rethrown !== instance) {
					problems.push(
						`${name}: on the mutation rethrow allow-list but not rethrown as-is`,
					);
				}
			} else if (rethrew || (mutated as { kind?: string }).kind === undefined) {
				problems.push(`${name}: catchMutation did not classify`);
			}
		}
		expect(problems).toEqual([]);
	});
});

describe("layer-1 siblinghood", () => {
	it("keeps the specific error prototypes out of the SiYuanApiError chain", () => {
		// Positive control: the inheritance chain itself is real, so the
		// negative assertions cannot pass vacuously.
		expect(
			SiYuanKernelError.prototype.isPrototypeOf(SiYuanApiError.prototype),
		).toBe(true);
		for (const proto of [
			SiYuanAuthError.prototype,
			SiYuanRateLimitError.prototype,
			SiYuanNetworkError.prototype,
			SiYuanTimeoutError.prototype,
		]) {
			expect(SiYuanApiError.prototype.isPrototypeOf(proto)).toBe(false);
		}
	});
});
