// Live replace-section sequence pins — the insert-before-batch ordering
// and its landing judgment (replacement present, the old section's
// members swept through the batched delete route, boundary heading
// surviving) falsified against the real kernel, plus the batched-route
// release gates: a ≥32-member section (the kernel's bulk path) and the
// section-less heading (the empty-issued-set path). The
// replacement-survival seam's data-loss reading pins live here too.
// Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { PINNED_SIYUAN_VERSION } from "../../version.js";
import { replaceSectionVerified } from "../../write.js";
import { replacementSurvivalOf } from "../../replace.js";
import { contentHash, type ServedBaseline } from "../../fresh.js";
import { sectionOf } from "../../placement.js";
import { walkBlockTree, type WalkedBlock } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"replace-section sequence",
	() => {
		let fixtures: LiveFixtures;
		let client: SiYuanKernelClient;
		let boxId: string;

		/** First heading with exactly this content under a doc. */
		function heading(walk: WalkedBlock[], content: string): WalkedBlock {
			const h = walk.find((b) => b.type === "h" && b.content === content);
			expect(h).toBeDefined();
			return h!;
		}

		/** The flow-shaped baseline lookup minted from a live walk: every
		 * walk-present id `served` off the walk row it was resolved from —
		 * hash comparison, the seed read never fires. */
		function closureLookup(
			tree: Awaited<ReturnType<typeof walkBlockTree>>,
		): (blockId: string) => ServedBaseline {
			const hashes = new Map(
				tree.blocks.map((b) => [b.id, contentHash(b.content)] as const),
			);
			return (blockId) => {
				const hash = hashes.get(blockId);
				return hash === undefined
					? { kind: "never-served" }
					: { kind: "served", hash };
			};
		}

		beforeAll(async () => {
			fixtures = await setupFixtures();
			client = fixtures.client;
			boxId = fixtures.notebookIds.fixtureA;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		it(
			"inserts before deleting: the replacement lands, the member heading leaves with the section, the boundary heading survives",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/replace live",
					[
						"# A",
						"",
						"A lead",
						"",
						"## Sub",
						"",
						"sub body",
						"",
						"# B",
						"",
						"B body",
						"",
					].join("\n"),
				);
				const tree = await walkBlockTree(client, docId);
				const walk = tree.blocks;
				const a = heading(walk, "A");
				const sub = heading(walk, "Sub");
				const b = heading(walk, "B");

				const outcome = await replaceSectionVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{
						rootId: docId,
						walk: tree,
						headingId: a.id,
						body: "replacement body",
						// The guard's judged stake — the section's closure (the
						// heading survives the replace), minted `served` from the
						// walk's own content so the judgment rides hash
						// comparison and the seed read never fires.
						baselineFor: closureLookup(tree),
					},
				);

				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				if (outcome.verdict.kind !== "replaced") return;
				const replaced = outcome.verdict;
				// The post-batch walk IS the tree the judgment certified.
				const { blocks: fresh } = await walkBlockTree(client, docId);
				expect(replaced.postWalk.blocks.map((x) => x.id)).toEqual(
					fresh.map((x) => x.id),
				);
				// The member heading itself was deleted; the replacement is A's
				// sole member; the boundary heading B survives with its body.
				expect(fresh.some((x) => x.id === sub.id)).toBe(false);
				expect(fresh.some((x) => x.id === a.id)).toBe(true);
				expect(fresh.some((x) => x.content === "replacement body")).toBe(true);
				expect(heading(fresh, "B").id).toBe(b.id);
				expect(fresh.some((x) => x.content === "B body")).toBe(true);
				// The closure names everything that left the doc — exactly
				// the section closure the caller's own walk computes.
				const callerSection = sectionOf(tree, a.id);
				const callerClosure =
					callerSection.kind === "section"
						? callerSection.section.closure.map((x) => x.id)
						: [];
				expect(replaced.closure.map((x) => x.blockId)).toEqual(callerClosure);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a final section (no boundary) lands the replacement at doc end and the heading survives",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/replace live trailing",
					"# Last\n\nbody one\n\ntrailing para\n",
				);
				const tree = await walkBlockTree(client, docId);
				const walk = tree.blocks;
				const h = heading(walk, "Last");

				const outcome = await replaceSectionVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{
						rootId: docId,
						walk: tree,
						headingId: h.id,
						body: "replacement body",
						baselineFor: closureLookup(tree),
					},
				);

				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				if (outcome.verdict.kind !== "replaced") return;
				const replaced = outcome.verdict;
				// No boundary → the doc-end anchor (append to the doc root).
				expect(replaced.anchor).toEqual({ kind: "append", containerId: null });
				const { blocks: fresh } = await walkBlockTree(client, docId);
				expect(fresh.some((x) => x.content === "trailing para")).toBe(false);
				expect(heading(fresh, "Last").id).toBe(h.id);
				// The replacement is the doc's last root-level block.
				expect(fresh.findLast((x) => x.parentId === null)!.content).toBe(
					"replacement body",
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a childless heading (empty closure) lands the replacement without a delete batch and certifies over a fresh walk",
			async () => {
				// The section-less path the apply's empty-issued-set
				// short-circuit takes: no ops are derived, the transaction is
				// never sent, and the fresh walk the apply takes itself is
				// the replaced arm's evidence.
				const docId = await mintDoc(
					client,
					boxId,
					"/replace live childless",
					"# Head\n\n# Next\n\nnext body\n",
				);
				const tree = await walkBlockTree(client, docId);
				const h = heading(tree.blocks, "Head");

				const outcome = await replaceSectionVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{
						rootId: docId,
						walk: tree,
						headingId: h.id,
						body: "replacement body",
						baselineFor: closureLookup(tree),
					},
				);

				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				if (outcome.verdict.kind !== "replaced") return;
				const replaced = outcome.verdict;
				// Nothing was judged, nothing was deleted.
				expect(replaced.closure).toEqual([]);
				const { blocks: fresh } = await walkBlockTree(client, docId);
				expect(fresh.some((x) => x.content === "replacement body")).toBe(true);
				// The section-less heading's successor is untouched.
				expect(fresh.some((x) => x.content === "next body")).toBe(true);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a ≥32-member section drives the batched route's bulk path and still certifies the absence of the whole section",
			async () => {
				// Release gate for the ≥32 interaction: the bulk path collects
				// every delete op into one tree load — the whole section must
				// leave and the replacement must survive, judged from the
				// single post-batch walk.
				const members = Array.from(
					{ length: 33 },
					(_, i) => `member ${String(i).padStart(2, "0")}`,
				);
				const docId = await mintDoc(
					client,
					boxId,
					"/replace live bulk",
					["# Bulk", "", ...members.map((m) => `${m}\n`), "# Tail", ""].join(
						"\n",
					),
				);
				const tree = await walkBlockTree(client, docId);
				const walk = tree.blocks;
				const bulk = heading(walk, "Bulk");
				const memberIds = walk
					.filter((b) => members.includes(b.content))
					.map((b) => b.id);
				expect(memberIds).toHaveLength(33);

				const outcome = await replaceSectionVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{
						rootId: docId,
						walk: tree,
						headingId: bulk.id,
						body: "replacement body",
						baselineFor: closureLookup(tree),
					},
				);

				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				if (outcome.verdict.kind !== "replaced") return;
				const replaced = outcome.verdict;
				// Every issued member is in the judged closure the arm rides.
				expect(replaced.closure.map((x) => x.blockId).sort()).toEqual(
					[...memberIds].sort(),
				);
				const { blocks: fresh } = await walkBlockTree(client, docId);
				const freshIds = new Set(fresh.map((x) => x.id));
				for (const id of memberIds) expect(freshIds.has(id)).toBe(false);
				expect(fresh.some((x) => x.content === "replacement body")).toBe(true);
				expect(heading(fresh, "Tail").content).toBe("Tail");
			},
			LIVE_TIMEOUT,
		);

		it(
			"the survival seam reads a replacement absent from a real complete walk as cascade-consumed — data loss, never ok",
			async () => {
				// The cascade-consumed live falsifier over the pure seam: a real
				// post-write walk plus a bogus id — the reading the delete-leg
				// wrapper's wording keys on.
				const docId = await mintDoc(
					client,
					boxId,
					"/replace live survival",
					"# Head\n\nbody one\n",
				);
				const postWalk = await walkBlockTree(client, docId);
				expect(replacementSurvivalOf(postWalk, "20240101000000-bogusid0")).toBe(
					"cascade-consumed",
				);
				// The positive reading on the same walk: the real heading is
				// present, so nothing adverse rides an arm carrying this walk.
				const present = heading(postWalk.blocks, "Head").id;
				expect(replacementSurvivalOf(postWalk, present)).toBeUndefined();
			},
			LIVE_TIMEOUT,
		);
	},
);
