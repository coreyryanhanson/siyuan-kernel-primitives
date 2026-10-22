// Live-suite harness (runs against the live pinned
// kernel, opt-in with SIYUAN_INTEGRATION=1, never in CI). Self-contained:
// no consumer-side settings load, no session validation, no agent extension —
// the live cases here drive the package's own primitives over the typed client.
//
// 1. Setup pins — kernel version exactly equals the pin (accidental upgrade
//    → red suite), teardown asserts the notebook count back to baseline
//    (zero strays).
// 2. Test-only raw-kernel-call helper — raw DML and bogus-token arming
//    deliberately stay outside the typed client; every notebook/doc
//    lifecycle call rides the typed client.

import { SiYuanKernelClient } from "siyuan-kernel-api";
import { sqlString } from "../../sql.js";
import { PINNED_SIYUAN_VERSION } from "../../version.js";

export const INTEGRATION = process.env.SIYUAN_INTEGRATION === "1";
/** The live kernel origin is operator config — no default is baked in.
 * Required via SIYUAN_BASE_URL whenever the suite actually runs. */
export const BASE_URL = process.env.SIYUAN_BASE_URL ?? "";
export const TOKEN = process.env.SIYUAN_API_TOKEN ?? "";
/** Live round-trips + fixture-mint polling run well past the unit budget. */
export const LIVE_TIMEOUT = 30_000;

if (INTEGRATION && BASE_URL === "") {
	throw new Error(
		"SIYUAN_INTEGRATION=1 requires SIYUAN_BASE_URL (the live kernel origin) — the harness bakes in no default",
	);
}

/** Raw direct kernel call — a POST fetch with a Token header, bypassing the
 * typed client entirely. `token` override is what bogus-token arming uses. */
export interface RawKernelResult {
	status: number;
	headers: Headers;
	/** Parsed JSON body when parseable, undefined otherwise (throttle/lock
	 * responses may carry non-JSON bodies). */
	body: unknown;
}

export async function rawKernelCall(
	path: string,
	body: unknown,
	opts: { token?: string; baseUrl?: string } = {},
): Promise<RawKernelResult> {
	const res = await fetch(`${opts.baseUrl ?? BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Token ${opts.token ?? TOKEN}`,
		},
		body: JSON.stringify(body ?? {}),
	});
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		// non-JSON body (e.g. a throttle response) — status/headers still speak
	}
	return { status: res.status, headers: res.headers, body: parsed };
}

/** Poll a condition with a deadline — the bounded-wait shape the live
 * async-index cases use (blocks index, hpath). */
export async function pollUntil(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`${label} never became true`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** Poll the SQL blocks index until a minted doc is queryable by id — the
 * index lags createDocWithMarkdown (async index queue). */
export async function awaitIndexed(
	client: SiYuanKernelClient,
	boxId: string,
	docId: string,
	timeoutMs = 10_000,
): Promise<void> {
	await pollUntil(
		`fixture doc ${docId} reaching the blocks index`,
		async () =>
			(
				await client.query(
					`SELECT id FROM blocks WHERE box = ${sqlString(boxId)} AND id = ${sqlString(docId)} AND type = 'd'`,
				)
			).length > 0,
		timeoutMs,
	);
}

/** Mint a fixture doc (path includes the leading `/`) and wait for the
 * blocks index — the shape every fixture case starts from. */
export async function mintDoc(
	client: SiYuanKernelClient,
	notebookId: string,
	path: string,
	markdown: string,
): Promise<string> {
	const docId = await client.createDocWithMarkdown({
		notebook: notebookId,
		path,
		markdown,
	});
	await awaitIndexed(client, notebookId, docId);
	return docId;
}

export interface LiveFixtures {
	client: SiYuanKernelClient;
	notebookIds: { fixtureA: string; fixtureB: string };
	/** Removes both fixtures (typed client) and asserts the notebook count is
	 * back to the setup baseline — zero strays. */
	teardown(): Promise<void>;
}

/** Two disposable notebooks per run: the guard's foreign-box scoping case
 * needs a second box, and the multi-notebook teardown catches any case that
 * leaks a fixture. */
export async function setupFixtures(): Promise<LiveFixtures> {
	if (!INTEGRATION || TOKEN === "") {
		throw new Error("setupFixtures called outside a live integration run");
	}
	const client = new SiYuanKernelClient(BASE_URL, TOKEN);

	// Pin: the kernel must report the exact version (accidental upgrade → red).
	const version = await client.getVersion();
	if (version !== PINNED_SIYUAN_VERSION) {
		throw new Error(
			`kernel version ${version} does not match the pin ${PINNED_SIYUAN_VERSION} — re-pin or investigate before running the suite`,
		);
	}

	const baselineCount = (await client.listNotebooks()).notebooks.length;

	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	const fixtureA = await client.createNotebook(`kbpr-it-a-${stamp}`);
	const fixtureB = await client.createNotebook(`kbpr-it-b-${stamp}`);
	await client.openNotebook(fixtureA.id);
	await client.openNotebook(fixtureB.id);

	return {
		client,
		notebookIds: { fixtureA: fixtureA.id, fixtureB: fixtureB.id },
		async teardown(): Promise<void> {
			const failures: string[] = [];
			for (const id of [fixtureA.id, fixtureB.id]) {
				try {
					await client.removeNotebook(id);
				} catch (err) {
					// Attempt both removals; report after, never mask a pin failure.
					failures.push(
						`removeNotebook(${id}) failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const remaining = (await client.listNotebooks()).notebooks;
			const strays = remaining.filter(
				(n) => n.id === fixtureA.id || n.id === fixtureB.id,
			);
			if (strays.length > 0 || failures.length > 0) {
				throw new Error(
					`teardown left strays: ${strays.map((s) => s.id).join(", ") || "none"} — ${failures.join("; ") || "removals reported success"}`,
				);
			}
			if (remaining.length !== baselineCount) {
				throw new Error(
					`post-teardown notebook count ${remaining.length} != baseline ${baselineCount} — unexpected notebook set changed during the run`,
				);
			}
		},
	};
}

/** Poll the search index until a term surfaces `minHits` across `boxIds` —
 * the search index lags doc mints like the blocks index does. */
export async function awaitSearchable(
	client: SiYuanKernelClient,
	boxIds: string[],
	query: string,
	minHits: number,
	timeoutMs = 15_000,
): Promise<void> {
	await pollUntil(
		`search index surfacing ${minHits} hits for '${query}'`,
		async () => {
			const result = await client.fullTextSearch({
				query,
				paths: boxIds,
				pageSize: minHits,
			});
			return result.blocks.length >= minHits;
		},
		timeoutMs,
	);
}
