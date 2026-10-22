// Live fresh-content judgment pins — checkFreshContent's arms falsified
// against the real kernel: fresh against the served state, stale against a
// real kernel-side edit (the tree endpoint is synchronous, so the walk
// reads the new content while the caller's baseline still hashes the old —
// deterministic), and vanished for a block the walk no longer holds
// (walk-absence decides, whatever the index row still carries). Opt-in
// with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { sqlString } from "../../sql.js";
import { blockContents } from "../../byId.js";
import {
	checkFreshContent,
	contentHash,
	type ServedBaseline,
} from "../../fresh.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("fresh-content judgment", () => {
	/** Named baseline verdicts. */
	const served = (hash: string): ServedBaseline => ({ kind: "served", hash });

	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let boxId: string;
	let docId: string;
	let p1: string;
	let p2: string;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		boxId = fixtures.notebookIds.fixtureA;
		docId = await mintDoc(
			client,
			boxId,
			"/fresh live",
			"# fresh live\n\nbody one\n\nbody two\n",
		);
		const rows = await client.query(
			`SELECT id, content FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'p' ORDER BY content`,
		);
		p1 = String(rows[0]!.id);
		p2 = String(rows[1]!.id);
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"reports fresh for a block whose SQL-seeded baseline matches the tree",
		async () => {
			const rows = await blockContents(client, [p1]);
			expect(rows).toEqual([{ id: p1, content: "body one" }]);
			const r = await checkFreshContent(client, {
				docId,
				targets: [{ blockId: p1, baseline: served(contentHash("body one")) }],
			});
			expect(r.arms).toEqual([
				{ kind: "fresh", blockId: p1, currentContent: "body one" },
			]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"reports stale with the tree's current content after a real edit — while the caller's baseline predates it",
		async () => {
			await client.updateBlock({ id: p1, data: "edited live body" });
			const r = await checkFreshContent(client, {
				docId,
				targets: [{ blockId: p1, baseline: served(contentHash("body one")) }],
			});
			expect(r.arms).toEqual([
				{
					kind: "stale",
					blockId: p1,
					currentContent: "edited live body",
					compared: "baseline",
				},
			]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"reports vanished for a deleted block — walk-absence, regardless of the index row",
		async () => {
			await client.deleteBlock(p2);
			const r = await checkFreshContent(client, {
				docId,
				targets: [{ blockId: p2, baseline: served(contentHash("body two")) }],
			});
			expect(r.arms).toEqual([{ kind: "vanished", blockId: p2 }]);
		},
		LIVE_TIMEOUT,
	);
});
