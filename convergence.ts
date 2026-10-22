// The async-index convergence window — one home for the fixed retry
// table and the poll loop every index read that must survive the index's
// async lag runs: post-write re-reads AND the flows' pre-mutation
// scoping reads (the create flow's pre-mint parent lookup, the doc-move's
// scoping read). Leaf module: no imports, so the flow modules can depend
// on it without an edge between them.

/** Post-mutation async-index convergence window: the blocks index
 * (content, hpath, fresh rows) rebuilds asynchronously behind a mutation's
 * HTTP success, so the SQL-seeded re-reads retry inside this fixed table
 * (walk re-reads need no window — `getChildBlocks` reads the document
 * tree directly, not the index). Exponential gaps cover the fast-index
 * common case and tolerate a busy-queue tail (~4s worst case). Fixed
 * table, not a knob — a live run that still races past 4s is the signal
 * to extend the table, not to make it tunable. */
export const VERIFY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
	150, 300, 600, 1200, 2000,
]);

// The active window. Tests swap it through `withVerifyWindow`, never by
// mutating the exported table in place (the table is frozen — an in-place
// splice would throw in-process, and across module instances it would
// silently no-op).
let activeWindow = VERIFY_RETRY_DELAYS_MS;

/** Run `fn` with the convergence window replaced by `delays` — e.g.
 * `[0]` exhausts the table instantly in unit tests — restoring the real
 * table when `fn` settles. The `return await` is load-bearing: a bare
 * `return fn()` would run the `finally` at the body's first await
 * suspension, before the polling happens. Process-wide scope: the swap
 * is a module variable, so only serial test bodies may overlap it, and
 * background work the body leaves running is not covered. */
export async function withVerifyWindow<T>(
	delays: readonly number[],
	fn: () => Promise<T>,
): Promise<T> {
	const saved = activeWindow;
	activeWindow = delays;
	try {
		return await fn();
	} finally {
		activeWindow = saved;
	}
}

/** The shared poll loop behind the flows' index reads: call it
 * immediately, then once per convergence-table delay,
 * until it resolves to a value — the window's judgment — or the table
 * is exhausted, which reads as `undefined`. What exhaustion means stays
 * at the call site. Not exported through any barrel: the flows and this
 * repo's own suites (importing the module directly) are its only
 * consumers. */
export async function verifyWithinWindow<T>(
	attempt: () => Promise<T | undefined>,
): Promise<T | undefined> {
	for (let n = 0; ; n++) {
		const judgment = await attempt();
		if (judgment !== undefined) return judgment;
		const delay = activeWindow[n];
		if (delay === undefined) return undefined;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}
