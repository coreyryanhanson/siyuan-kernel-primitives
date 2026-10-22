// Live search pins — the shared-window fact and the fan-out strategy over
// the real kernel's full-text search. The premise pin falsifies the kernel
// behavior the fan-out exists for (a multi-path call dedicates ONE window
// to every path — matches beyond it are counted, never shown); the strategy
// pin falsifies `keywordSearchBoxes` keeping every box's window dedicated. Opt-in
// with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { keywordSearchBoxes } from "../../search.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	awaitSearchable,
	mintDoc,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("search fan-out", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
	});

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	});

	it(
		"premise: a multi-path call shares one window across its paths",
		async () => {
			const term = `crowseed-${Date.now()}`;
			// 4 matching paragraphs in fixture-a against a window of 4, plus
			// one fixture-b hit — more matches than a shared window can show.
			// Headings deliberately do not share a token with the term (the
			// kernel's hyphen tokenization is not pinned here) — only the
			// paragraphs count.
			const markdown = Array.from(
				{ length: 4 },
				(_, i) => `${term} paragraph ${i}`,
			).join("\n\n");
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/crowseed-a-${Date.now()}`,
				`# anchor a\n\n${markdown}\n`,
			);
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureB,
				`/crowseed-b-${Date.now()}`,
				`# anchor b\n\n${term} single hit\n`,
			);
			await awaitSearchable(client, [fixtures.notebookIds.fixtureA], term, 4);
			await awaitSearchable(client, [fixtures.notebookIds.fixtureB], term, 1);

			const shared = await client.fullTextSearch({
				query: term,
				paths: [fixtures.notebookIds.fixtureA, fixtures.notebookIds.fixtureB],
				pageSize: 4,
			});
			// One window for both paths: 4 shown, more counted. A per-path
			// window would have shown every match. (Counted is asserted as a
			// strict surplus, never an exact figure — the pin is the window,
			// not the kernel's tokenization.)
			expect(shared.matchedBlockCount).toBeGreaterThan(4);
			expect(shared.blocks).toHaveLength(4);
		},
		LIVE_TIMEOUT,
	);

	it(
		"strategy: per-box calls keep every box's window dedicated, with the surplus as evidence",
		async () => {
			const term = `dedicate-${Date.now()}`;
			// 5 matching paragraphs in fixture-a against a window of 4 — the
			// surplus (1) is the `hidden` evidence the strategy pin asserts.
			const markdown = Array.from(
				{ length: 5 },
				(_, i) => `${term} paragraph ${i}`,
			).join("\n\n");
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/dedicate-a-${Date.now()}`,
				`# anchor a\n\n${markdown}\n`,
			);
			const bPath = `/dedicate-b-${Date.now()}`;
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureB,
				bPath,
				`# anchor b\n\n${term} single hit\n`,
			);
			await awaitSearchable(client, [fixtures.notebookIds.fixtureA], term, 5);
			await awaitSearchable(client, [fixtures.notebookIds.fixtureB], term, 1);

			const results = await keywordSearchBoxes(client, {
				query: term,
				boxIds: [fixtures.notebookIds.fixtureA, fixtures.notebookIds.fixtureB],
				pageSize: 4,
			});
			const a = results.find((r) => r.boxId === fixtures.notebookIds.fixtureA);
			const b = results.find((r) => r.boxId === fixtures.notebookIds.fixtureB);
			if (a === undefined || b === undefined) {
				throw new Error(
					`per-box results missing: got [${results.map((r) => r.boxId).join(", ")}])`,
				);
			}
			// fixture-a's window saturated: all 4 rows shown, 1 hidden.
			expect(a.rows).toHaveLength(4);
			expect(a.rows.every((row) => row.box === a.boxId)).toBe(true);
			expect(a.hidden).toBe(1);
			expect(a.dropped).toBe(0);
			// fixture-b's hit survives the saturated sibling window.
			expect(b.rows).toHaveLength(1);
			expect(b.rows[0]?.hPath).toBe(bPath);
			expect(b.hidden).toBe(0);
			expect(b.dropped).toBe(0);
		},
		LIVE_TIMEOUT,
	);
});
