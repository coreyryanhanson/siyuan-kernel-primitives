// The throttle pin — the kernel's per-IP auth-lock schedule, live-falsified
// in the repo that owns the pin (authLockSeconds in authLock.ts). Double-gated:
// SIYUAN_INTEGRATION=1 for the file, SIYUAN_INTEGRATION_THROTTLE=1 for the
// case — its arming sequence ends at a final lock of 480s and the expiry wait
// runs ~8–10 minutes with ZERO kernel calls, so it is never CI, never run
// twice in quick succession, and it 429-locks every client on this kernel's
// IP for the lock's duration. Sequenced last in INTEGRATION_ORDER (see
// vitest.config.ts).
//
// The extension-cooldown leg is deliberately absent: that is a tool-layer
// surface this package cannot reach (the dependency arrow points one way),
// and it does not need a real lock — consumers pin the typed-throw →
// refusal branches with a stubbed SiYuanRateLimitError, and the single-copy
// funnel guarantees that stub's class is the one a real 429 produces. The
// composition is proven on both sides of the one seam this split structurally
// defends: "real 429 → typed throw" here, "typed throw → gate refusal" there.

import { describe, expect, it } from "vitest";
import { SiYuanKernelClient, SiYuanRateLimitError } from "siyuan-kernel-api";
import { authLockSeconds } from "../../authLock.js";
import {
	BASE_URL,
	INTEGRATION,
	TOKEN,
	rawKernelCall,
	setupFixtures,
} from "./harness.js";

const THROTTLE_ENABLED =
	INTEGRATION && process.env.SIYUAN_INTEGRATION_THROTTLE === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The kernel's lockout math at 3.8.8 (util/session.go): locking starts at
 * the 6th fail within the 15-minute sliding failure window, `30 <<
 * (FailCount - 5)` seconds, capped at 15 min; any request during a lock
 * (correct token included) records another
 * fail and overwrites the lock. This case's arming sequence ends at FailCount
 * 9 — 6 bogus + the 7th + the correct-token 429 + the raw during-call —
 * so the final lock is 30 << 4 = 480s (authLockSeconds(9)). Each served
 * Retry-After reports the remaining time of the lock BEFORE the fail that
 * extended it, so the last served value (240s) understates the final lock by
 * one generation — the wait floors on the computed 480s, doubled last-served
 * as drift cover. The margin absorbs clock skew (5s raced it once in the
 * client's runs). */
const THROTTLE_FINAL_LOCK_MS = 480_000;
const SLEEP_MARGIN_MS = 15_000;

describe.skipIf(!THROTTLE_ENABLED)("auth-throttle pin", () => {
	it(
		"6 bogus auths arm the per-IP lock, a correct token rides it, a call during the lock re-arms it, expiry self-heals",
		{ timeout: 1_500_000 },
		async () => {
			const client = new SiYuanKernelClient(BASE_URL, TOKEN);
			// Known-good call on a guarded endpoint: resets the kernel's fail
			// counter (successes clear it), so the arming sequence starts from a
			// clean counter. A 429 here means a lock is already held (a previous
			// run or an external source) — fail with instructions, not a
			// cascading arming sequence.
			try {
				await client.listNotebooks();
			} catch (err) {
				if (err instanceof SiYuanRateLimitError) {
					throw new Error(
						"throttle lock still held from a previous run — it self-heals (≤15 min); rerun after it clears",
					);
				}
				throw err;
			}

			// 6 bogus-token requests; the 6th still returns 401. All throttle
			// legs use a guarded endpoint (lsNotebooks) — an unauthenticated
			// version probe would succeed with a bogus token and prove nothing.
			for (let i = 0; i < 6; i++) {
				const res = await rawKernelCall(
					"/api/notebook/lsNotebooks",
					{},
					{ token: `bogus-throttle-${i}` },
				);
				expect(res.status).toBe(401);
			}

			// 7th bogus call: the distinct 429 class with Retry-After — the lock
			// armed at the 6th failure, so the served value reports
			// authLockSeconds(6) minus elapsed.
			const seventh = await rawKernelCall(
				"/api/notebook/lsNotebooks",
				{},
				{ token: "bogus-throttle-6" },
			);
			expect(seventh.status).toBe(429);
			const served = Number(seventh.headers.get("retry-after"));
			expect(served).toBeGreaterThan(0);
			expect(served).toBeLessThanOrEqual(authLockSeconds(6));
			console.error(`[throttle] 7th served Retry-After: ${served}`);

			// 8th, correctly-authenticated call: the same 429 — the lock is
			// shared per-IP (two identities' failures, exercised for real) — and
			// the typed client throws the rate-limit class on a real 429 (the
			// layer-1 seam a consumer's gate stubs against).
			let served8: SiYuanRateLimitError | undefined;
			try {
				await client.listNotebooks();
				expect.unreachable("the lock must 429 a correct token too");
			} catch (err) {
				expect(err).toBeInstanceOf(SiYuanRateLimitError);
				served8 = err as SiYuanRateLimitError;
			}
			expect(served8?.retryAfterSeconds).toBeDefined();
			console.error(
				`[throttle] 8th (correct token) served Retry-After: ${served8?.retryAfterSeconds}`,
			);

			// 9th, a raw call during the lock: also 429 — any call inside the
			// lock re-arms it (the re-arm proof; this is why consumers dodge,
			// never retry into the lock). This is the last extension: FailCount
			// 9 → authLockSeconds(9) = 480s.
			const ninth = await rawKernelCall("/api/notebook/lsNotebooks", {});
			expect(ninth.status).toBe(429);
			console.error(
				`[throttle] 9th (raw during-lock) served Retry-After: ${ninth.headers.get("retry-after")}`,
			);

			// Passive wait ≥ the final lock with ZERO kernel calls — any request
			// during the lock re-enters the throttle and extends it, so a poll
			// loop cannot terminate. Each served Retry-After understates the
			// final lock by one extension generation — the floor accounts for
			// that (see THROTTLE_FINAL_LOCK_MS above).
			const armedAt = Date.now();
			const servedRaw = ninth.headers.get("retry-after");
			const lastServed =
				servedRaw === null ? THROTTLE_FINAL_LOCK_MS / 1000 : Number(servedRaw);
			await sleep(
				Math.max(THROTTLE_FINAL_LOCK_MS, 2 * lastServed * 1000) +
					SLEEP_MARGIN_MS,
			);
			console.error(
				`[throttle] wait done at +${((Date.now() - armedAt) / 1000).toFixed(0)}s after arming`,
			);

			// Post-expiry: the next call succeeds with no recovery step
			// (self-healing expiry). One bounded recovery cycle covers an
			// external auth-fail source on this IP (another client's bad token
			// re-arms the shared per-IP lock during the blind wait — observed
			// live once): sleep out the served remainder and probe again. The
			// sleep always lands past the served remaining time, so it converges
			// as soon as the external fails stop; if they continue, no wait
			// strategy can terminate and the case goes red naming the external
			// source.
			try {
				await client.listNotebooks();
			} catch (err) {
				if (!(err instanceof SiYuanRateLimitError)) throw err;
				const remaining = err.retryAfterSeconds ?? 0;
				console.error(
					`[throttle] first post-wait probe still locked (remaining ${remaining}s) — external extension suspected; one recovery wait`,
				);
				await sleep(remaining * 1000 + SLEEP_MARGIN_MS);
				await expect(client.listNotebooks()).resolves.toBeDefined();
			}

			// No fixtures were minted during arming; the strays/baseline hygiene
			// assertion runs in the post-lock round below, after expiry.
		},
	);

	it(
		"post-lock hygiene: fixtures still mint and tear down cleanly after expiry",
		{ timeout: 120_000 },
		async () => {
			const fixtures = await setupFixtures();
			await fixtures.teardown();
		},
	);
});
