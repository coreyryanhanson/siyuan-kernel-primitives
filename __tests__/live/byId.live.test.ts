// Live by-ID read pins — the pinned row semantics (type-'d' doc rows by id,
// root_id doc-membership, hpath display label) falsified against the real
// kernel. Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { sqlString } from "../../sql.js";
import {
	blockContents,
	blockInDoc,
	hPathByID,
	ownership,
	rootEcho,
} from "../../byId.js";
import { backlinkCheck } from "../../refs.js";
import { walkBlockTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	pollUntil,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("by-ID reads", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let boxId: string;
	let docId: string;
	let paraId: string;

	/** First paragraph with exactly this content under a doc — the row
	 * lags the doc's ownership row, so poll for it. */
	async function paraBlock(docId: string, content: string): Promise<string> {
		let rows: Record<string, unknown>[] = [];
		await pollUntil(
			`paragraph '${content}' reaching the blocks index`,
			async () => {
				rows = await client.query(
					"SELECT id, content FROM blocks WHERE root_id = " +
						sqlString(docId) +
						" AND type = 'p' AND content = " +
						sqlString(content),
				);
				return rows.length === 1;
			},
		);
		return String(rows[0]!.id);
	}

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		boxId = fixtures.notebookIds.fixtureA;
		docId = await mintDoc(
			client,
			boxId,
			"/by id live",
			"# by id live\n\na paragraph body\n",
		);
		const paras = await client.query(
			`SELECT id FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'p' LIMIT 1`,
		);
		paraId = String(paras[0]!.id);
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"ownership resolves a block id to its containing doc and a doc id to itself",
		async () => {
			expect(await ownership(client, boxId, paraId)).toBe(docId);
			expect(await ownership(client, boxId, docId)).toBe(docId);
		},
		LIVE_TIMEOUT,
	);

	it(
		"blockContents returns every row past the kernel's default statement cap",
		async () => {
			// /api/query/sql caps statements without their own LIMIT at
			// Conf.Search.Limit (default 64) and reports the truncation only
			// at the envelope top level, which the client drops — the seed
			// read must opt out or a >64-row target set would mis-report.
			const paragraphs = Array.from(
				{ length: 70 },
				(_, i) => `cap body ${i + 1}`,
			);
			const capDocId = await mintDoc(
				client,
				boxId,
				"/by id live cap",
				`# by id live cap\n\n${paragraphs.join("\n\n")}\n`,
			);
			const { blocks } = await walkBlockTree(client, capDocId);
			const ids = blocks.map((b) => b.id);
			expect(ids.length).toBeGreaterThanOrEqual(70);
			const rows: { id: string; content: string }[] = [];
			await pollUntil(
				"the cap fixture's rows reaching the blocks index",
				async () => {
					rows.length = 0;
					rows.push(...(await blockContents(client, ids)));
					return rows.length === ids.length;
				},
			);
			const contents = new Set(rows.map((r) => r.content));
			for (const p of paragraphs) expect(contents.has(p)).toBe(true);
		},
		LIVE_TIMEOUT,
	);

	it(
		"blockInDoc reports the in-doc payload for a block in the requested doc",
		async () => {
			const result = await blockInDoc(client, docId, paraId);
			expect(result).toEqual({
				kind: "in-doc",
				content: "a paragraph body",
				type: "p",
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"blockInDoc reports doc-id for a document id (its content would be the title)",
		async () => {
			const result = await blockInDoc(client, docId, docId);
			expect(result).toEqual({ kind: "doc-id" });
		},
		LIVE_TIMEOUT,
	);

	it(
		"blockInDoc reports foreign for a block that lives in another doc",
		async () => {
			const otherDocId = await mintDoc(
				client,
				boxId,
				"/by id live other",
				"# other doc\n\nforeign body\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(otherDocId)} AND type = 'p' LIMIT 1`,
			);
			const foreignId = String(rows[0]!.id);
			const result = await blockInDoc(client, docId, foreignId);
			expect(result).toEqual({ kind: "foreign", rootId: otherDocId });
		},
		LIVE_TIMEOUT,
	);

	it(
		"blockInDoc reports absent for an id that matches no indexed row",
		async () => {
			expect(
				await blockInDoc(client, docId, "20260101000000-nope0001"),
			).toEqual({ kind: "absent" });
		},
		LIVE_TIMEOUT,
	);

	it(
		"rootEcho reports the doc's stored title verbatim and its real hpath; absent for a bogus id and for a block id",
		async () => {
			const echo = await rootEcho(client, boxId, docId);
			expect(echo).toEqual({
				docId,
				title: "by id live",
				hpath: "/by id live",
			});
			expect(
				await rootEcho(client, boxId, "20260101000000-nope0001"),
			).toBeUndefined();
			// The type-'d' discrimination itself: a real block id (not a
			// bogus one) also reads as absent — doc targeting must refuse it
			// rather than normalize it to its containing doc.
			expect(await rootEcho(client, boxId, paraId)).toBeUndefined();
		},
		LIVE_TIMEOUT,
	);

	it(
		"hPathByID returns the minted doc's known hpath, from any block id of the doc",
		async () => {
			// The containing-doc semantics the doc comment promises: the doc
			// root and a non-doc block id resolve to the same live-tree hpath.
			expect(await hPathByID(client, docId)).toBe("/by id live");
			expect(await hPathByID(client, paraId)).toBe("/by id live");
		},
		LIVE_TIMEOUT,
	);

	it(
		"hPathByID answers the renamed hpath immediately after renameDocByID — no convergence wait",
		async () => {
			// The synchronous-ground-truth fact the doc-move judgment rides:
			// the blocks index lags, the live tree does not. This renames the
			// shared docId fixture — any later case in this file must not
			// assume the minted hpath "/by id live".
			await client.renameDocByID(docId, "by id live renamed");
			expect(await hPathByID(client, docId)).toBe("/by id live renamed");
		},
		LIVE_TIMEOUT,
	);

	it(
		"refs index convergence — a write-planted block ref becomes visible to backlinkCheck within a bounded wait",
		async () => {
			const hostId = await mintDoc(
				client,
				boxId,
				"/Ref Host",
				"# Ref Host\n\nhost body\n",
			);
			const targetId = await mintDoc(
				client,
				boxId,
				"/Ref Target",
				"# Ref Target\n\ntarget body\n",
			);
			const targetBlock = await paraBlock(targetId, "target body");
			const hostBlock = await paraBlock(hostId, "host body");
			// Plant the ref only after the target block exists — the same
			// shape as a tool edit that adds a ref.
			await client.updateBlock({
				id: hostBlock,
				data: `updated body with ref ((${targetBlock} "x"))`,
			});
			// Zero waits would flake: the derived refs index converges on the
			// same asynchronous pass as blocks (~2–3 s live) — the pin is the
			// bounded convergence, not literal immediacy.
			await pollUntil(
				"write-planted ref reaching the refs index",
				async () => (await backlinkCheck(client, [targetBlock])).count >= 1,
				15_000,
			);
			// Both legs of the two-step read: the referring doc's real hpath.
			const refs = await backlinkCheck(client, [targetBlock]);
			expect(refs.hpaths).toContain("/Ref Host");
		},
		LIVE_TIMEOUT,
	);
});
