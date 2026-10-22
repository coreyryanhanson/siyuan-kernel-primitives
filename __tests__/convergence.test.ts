import { describe, expect, it } from "vitest";
import {
	VERIFY_RETRY_DELAYS_MS,
	verifyWithinWindow,
	withVerifyWindow,
} from "../convergence.js";

// The seam the create/edit collapse tests rely on: the swap applies inside
// the body and the SAVED window is restored afterwards. A break here shows
// up as slowness, not red — the exact silently-no-op failure the seam
// exists to prevent — so it is pinned directly, with zero-width delays so
// the check is deterministic and instant.
describe("VERIFY_RETRY_DELAYS_MS", () => {
	it("the exported table is frozen — the seam is the only mutation path", () => {
		expect(Object.isFrozen(VERIFY_RETRY_DELAYS_MS)).toBe(true);
	});
});

describe("withVerifyWindow", () => {
	it("swaps inside the body and restores the saved window, nested", async () => {
		let attempts = 0;
		await withVerifyWindow([0, 0, 0], async () => {
			await withVerifyWindow([0], async () => "inner");
			const verdict = await verifyWithinWindow(async () => {
				attempts += 1;
				return undefined;
			});
			expect(verdict).toBeUndefined();
			return "outer";
		});
		// attempt 0 + one poll per delay: 4 under the restored outer table,
		// 6 if the default table leaked back in, 2 if the inner collapse
		// leaked outward.
		expect(attempts).toBe(4);
	});

	it("restores the saved window when the body ends in a rejection or a sync throw", async () => {
		// Both termination legs of the restore contract: a rejected promise
		// and a non-async fn that throws before returning.
		for (const [message, boom] of [
			["boom", (): Promise<never> => Promise.reject(new Error("boom"))],
			[
				"sync boom",
				(): never => {
					throw new Error("sync boom");
				},
			],
		] as const) {
			let attempts = 0;
			await withVerifyWindow([0, 0, 0], async () => {
				await expect(withVerifyWindow([0], boom)).rejects.toThrow(message);
				// Restored to the OUTER table: 4 attempts. Inner [0] leaking
				// out reads 2; the default table leaking in reads 6.
				await verifyWithinWindow(async () => {
					attempts += 1;
					return undefined;
				});
			});
			expect(attempts).toBe(4);
		}
	});

	it("keeps the swap active across the body's await suspension", async () => {
		let attempts = 0;
		await withVerifyWindow([0, 0, 0], async () => {
			// The suspension point is what the load-bearing `return await`
			// guards: a bare `return fn()` would run the finally HERE — at
			// the body's first suspension, before the polling — so the
			// polls would run against the default table (6 attempts,
			// ~4.25s slow) instead of the swapped one (4 attempts).
			await Promise.resolve();
			await verifyWithinWindow(async () => {
				attempts += 1;
				return undefined;
			});
		});
		expect(attempts).toBe(4);
	});
});
