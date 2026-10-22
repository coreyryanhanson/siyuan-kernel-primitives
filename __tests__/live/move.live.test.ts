// Live pins: the verified moves' per-id route (`moveVerified`'s per-id
// arm + `moveDocVerified`). The per-id pins are the sole falsifications
// of the per-id move kernel facts — block landings execute synchronously
// and verify against the post-move walks (position same-doc, membership
// cross-doc), the section-rule anchors land where the walk says even
// inside list items and callouts, fold state does not move a landing —
// true only BECAUSE section-bearing heading targets and move anchors are
// refused pre-mutation by the primitives; the kernel's own block move IS
// fold-dependent (pinned below by the raw-client drag case), the kernel
// never leaves a doc childless (the empty-destination append anchor is
// unreachable live), the depth cap rejects past 7 levels, doc-level moves
// judge on the live-tree hpath over the STORED title (never a
// caller-predicted form — the stale-title pin) while the blocks index
// lags (a child doc is not a block in its parent's tree, and ancestor and
// identity moves reject synchronously behind HTTP 200). The batched
// section route's pins live in moveSection.live.test.ts. Ordered before
// the throttle file; teardown asserts zero strays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { moveDocVerified, moveVerified } from "../../move.js";
import { hPathByID } from "../../byId.js";
import { sectionOf } from "../../placement.js";
import { PINNED_SIYUAN_VERSION } from "../../version.js";
import { sqlString } from "../../sql.js";
import { walkBlockTree, type WalkedTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	mintDoc,
	pollUntil,
	setupFixtures,
	TOKEN,
} from "./harness.js";
import { expectSectionRoute, heading, setFold } from "./moveHelpers.js";

let fx: Awaited<ReturnType<typeof setupFixtures>>;
let client: SiYuanKernelClient;
let box: string;

beforeAll(async () => {
	if (!INTEGRATION) return;
	fx = await setupFixtures();
	client = fx.client;
	box = fx.notebookIds.fixtureA;
});

afterAll(async () => {
	if (!INTEGRATION) return;
	await fx.teardown();
});

const probe = { verdict: "ok" as const, kernelVersion: PINNED_SIYUAN_VERSION };

/** Run a verified block move through the two-route entry's per-id route —
 * the anchor the placement module derives for `toHeadingId`, the exact
 * route a non-heading blockId takes. A fixture whose blockId dispatches
 * to the section route (a heading) is a fixture bug: this helper pins
 * per-id. */
async function runBlockMove(input: {
	blockId: string;
	rootId: string;
	destRootId: string;
	toHeadingId?: string | undefined;
	destWalk?: WalkedTree | undefined;
}) {
	const destWalk =
		input.destWalk ?? (await walkBlockTree(client, input.destRootId));
	const outcome = await moveVerified(client, probe, {
		blockId: input.blockId,
		rootId: input.rootId,
		destRootId: input.destRootId,
		// The walk was fetched before the move — it is the pre-move tree the
		// placement refusals judge.
		preDestWalk: destWalk,
		...(input.toHeadingId === undefined
			? {}
			: { toHeadingId: input.toHeadingId }),
	});
	if (outcome.kind !== "per-id") {
		throw new Error(`fixture blockId ${input.blockId} did not dispatch per-id`);
	}
	return outcome.outcome;
}

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"live: verified moves (block + doc level)",
	() => {
		it(
			"same-doc block move judges landed at the anchor's landing position — one walk, both sets",
			async () => {
				const srcId = await mintDoc(
					client,
					box,
					"/MvB Src",
					"# Src H\n\nmover body\n\nstayer body\n",
				);
				const { blocks: walk } = await walkBlockTree(client, srcId);
				const mover = walk.find((b) => b.content === "mover body")!;
				const outcome = await runBlockMove({
					blockId: mover.id,
					rootId: srcId,
					destRootId: srcId,
					toHeadingId: heading(walk, "Src H").id,
				});
				expect(outcome.kind).toBe("judged");
				if (outcome.kind === "judged") {
					// The mover lands as the section's last member (after the
					// stayer) — position, not presence, is the same-doc judgment.
					expect(outcome.verdict).toEqual({ kind: "landed" });
					const last = outcome.postSourceWalk.blocks.at(-1)!;
					expect(last.id).toBe(mover.id);
					// Same-doc: one walk IS both sets (the consumer seeds
					// baselines from this exact snapshot).
					expect(outcome.postDestWalk).toBe(outcome.postSourceWalk);
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"cross-doc block move judges landed — membership, source absence, provenance survives",
			async () => {
				const srcId = await mintDoc(
					client,
					box,
					"/MvB XSrc",
					"# XSrc H\n\nmover body\n\nstayer body\n",
				);
				const destId = await mintDoc(
					client,
					box,
					"/MvB XDest",
					"# XDest H\n\ndest body\n",
				);
				const { blocks: srcWalk } = await walkBlockTree(client, srcId);
				const mover = srcWalk.find((b) => b.content === "mover body")!;
				const stayer = srcWalk.find((b) => b.content === "stayer body")!;
				const outcome = await runBlockMove({
					blockId: stayer.id,
					rootId: srcId,
					destRootId: destId,
				});
				expect(outcome.kind).toBe("judged");
				if (outcome.kind === "judged") {
					expect(outcome.verdict).toEqual({ kind: "landed" });
					const landed = outcome.postDestWalk.blocks.find(
						(b) => b.id === stayer.id,
					)!;
					expect(landed.content).toBe("stayer body");
					expect(
						outcome.postSourceWalk.blocks.some((b) => b.id === stayer.id),
					).toBe(false);
					expect(
						outcome.postSourceWalk.blocks.some((b) => b.id === mover.id),
					).toBe(true);
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"a move into a list-item-nested section lands inside the item; the sibling item survives",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/MvB Nested",
					[
						"# Top",
						"",
						"- item one",
						"",
						"  ## H",
						"",
						"  item body",
						"",
						"- item two",
						"",
						"# Next",
						"",
					].join("\n"),
				);
				const pre = await walkBlockTree(client, docId);
				const next = heading(pre.blocks, "Next");
				// `Next` is a memberless heading: the dispatch routes it to the
				// section sequence's degenerate form — it is the last block of
				// its list item, nothing follows it inside the container.
				const outcome = await moveVerified(client, probe, {
					blockId: next.id,
					rootId: docId,
					destRootId: docId,
					preDestWalk: pre,
					toHeadingId: heading(pre.blocks, "H").id,
				});
				const landed = expectSectionRoute(outcome);
				expect(landed.kind).toBe("landed");
				// The layout is the fact this case pins — re-read the live tree.
				const after = (await walkBlockTree(client, docId)).blocks;
				// The moved heading lands inside the list item, right after the
				// section's end (it is an h1 — the boundary of H's section there,
				// not a member of it).
				const nextAfter = after.find((b) => b.id === next.id)!;
				const body = after.find((b) => b.content === "item body")!;
				expect(nextAfter.parentId).toBe(body.parentId);
				const itemChildren = after.filter((b) => b.parentId === body.parentId);
				expect(itemChildren.at(-1)!.id).toBe(next.id);
				// The sibling list item survives untouched at doc level.
				const itemTwo = after.find((b) => b.content === "item two");
				expect(itemTwo).toBeDefined();
				expect(itemTwo!.parentId).not.toBe(
					after.find((b) => b.content === "item one")!.parentId,
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"doc-end move lands after the last root-level block; a blank destination carries one empty paragraph and lands the same",
			async () => {
				const srcId = await mintDoc(
					client,
					box,
					"/MvB EndSrc",
					"# EndSrc\n\nsrc paragraph\n",
				);
				const destId = await mintDoc(
					client,
					box,
					"/MvB EndDest",
					"# Dest\n\ndest one\n\ndest two\n",
				);
				const { blocks: srcWalk } = await walkBlockTree(client, srcId);
				const mover = srcWalk.find((b) => b.content === "src paragraph")!;
				const populated = await runBlockMove({
					blockId: mover.id,
					rootId: srcId,
					destRootId: destId,
				});
				expect(populated.kind).toBe("judged");
				if (populated.kind === "judged") {
					expect(populated.verdict).toEqual({ kind: "landed" });
					expect(populated.postDestWalk.blocks.at(-1)!.id).toBe(mover.id);
				}

				// The kernel never leaves a doc childless (a blank doc carries one
				// empty paragraph, and deleting it re-mints one), so the walk is
				// never empty: the empty-destination append anchor (parentID
				// prepend) is unit-pinned, never live-reachable.
				const blankId = await client.createDocWithMarkdown({
					notebook: box,
					path: "/MvB Blank",
					markdown: "",
				});
				const { blocks: blankWalk } = await walkBlockTree(client, blankId);
				expect(blankWalk).toHaveLength(1);
				const srcTree2 = await walkBlockTree(client, srcId);
				const mover2 = heading(srcTree2.blocks, "EndSrc");
				// `EndSrc` rides the section sequence only because the step above
				// moved its section member out (an empty section — the degenerate
				// form) — asserted, not incidental: any fixture change surfaces as
				// an unexplained refusal instead of a silently different move.
				const srcSection = sectionOf(srcTree2, mover2.id);
				expect(srcSection.kind).toBe("section");
				if (srcSection.kind === "section") {
					expect(srcSection.section.members).toHaveLength(0);
				}
				// mover2 is a memberless heading by now — the dispatch routes it
				// to the section sequence's degenerate form, not the per-id path.
				const preBlankWalk = await walkBlockTree(client, blankId);
				const blank = await moveVerified(client, probe, {
					blockId: mover2.id,
					rootId: srcId,
					destRootId: blankId,
					preDestWalk: preBlankWalk,
				});
				const landed = expectSectionRoute(blank);
				expect(landed.kind).toBe("landed");
				expect((await walkBlockTree(client, blankId)).blocks.at(-1)!.id).toBe(
					mover2.id,
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"an empty-section move (heading anchor) lands right after the heading, folded and unfolded",
			async () => {
				const mkCallout = async (
					title: string,
				): Promise<{ docId: string; empty: string }> => {
					const id = await mintDoc(
						client,
						box,
						`/MvB ${title}`,
						[
							"# Top",
							"",
							"> [!NOTE] C",
							"> ## Empty target",
							"",
							"after the callout",
							"",
						].join("\n"),
					);
					const { blocks: w } = await walkBlockTree(client, id);
					return { docId: id, empty: heading(w, "Empty target").id };
				};
				const mint = async (
					title: string,
				): Promise<{ docId: string; filler: string }> => {
					// The mover lives in its own source doc — the move into the
					// callout's empty section is cross-doc (the not-in-source
					// scoping refusal judges membership in the claimed source).
					const docId = await mintDoc(
						client,
						box,
						`/MvB ${title} src`,
						`# ${title}\n\nfiller\n`,
					);
					const { blocks: w } = await walkBlockTree(client, docId);
					return { docId, filler: w.find((b) => b.content === "filler")!.id };
				};
				const unfolded = await mkCallout("Move U");
				const srcU = await mint("unfolded");
				const u = await runBlockMove({
					blockId: srcU.filler,
					rootId: srcU.docId,
					destRootId: unfolded.docId,
					toHeadingId: unfolded.empty,
				});
				expect(u.kind).toBe("judged");
				const folded = await mkCallout("Move F");
				await setFold(folded.empty, true);
				const srcF = await mint("folded");
				const f = await runBlockMove({
					blockId: srcF.filler,
					rootId: srcF.docId,
					destRootId: folded.docId,
					toHeadingId: folded.empty,
				});
				expect(f.kind).toBe("judged");
				// Both land as the empty heading's first section member inside
				// the callout — identical position, fold state irrelevant.
				const movedFillerId = (docId2: string): string =>
					docId2 === unfolded.docId ? srcU.filler : srcF.filler;
				for (const docId2 of [unfolded.docId, folded.docId]) {
					const { blocks: w } = await walkBlockTree(client, docId2);
					const empty = w.find((b) => b.content === "Empty target")!;
					const siblings = w.filter((b) => b.parentId === empty.parentId);
					expect(siblings[1]!.id).toBe(movedFillerId(docId2));
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"raw moveBlock on a folded section-bearing heading drags the whole section — the kernel fact the dispatch dodges",
			async () => {
				// The layer-1 client directly (no judgment between caller and
				// kernel), fold set via setBlockAttrs. If the kernel ever stops
				// dragging, what re-checks is the dispatch's motivation (a heading
				// blockId routes to the section sequence), not the pin's
				// soundness. moveBlock rejects nextID — only previousID /
				// parentID are honored.
				const docId = await mintDoc(
					client,
					box,
					"/MvB Drag",
					"## Alpha\n\npara-one\n\n## Beta\n\npara-two\n",
				);
				const pre = await walkBlockTree(client, docId);
				const alpha = heading(pre.blocks, "Alpha");
				await setFold(alpha.id, true);
				const paraTwo = pre.blocks.find((b) => b.content === "para-two")!;
				await client.moveBlock({ id: alpha.id, previousID: paraTwo.id });
				const post = await walkBlockTree(client, docId);
				// The drag: the section travelled WITH its heading — doc order
				// [Alpha, para-one, Beta, para-two] → [Beta, para-two, Alpha,
				// para-one]. (A heading's section members are root-level
				// siblings, never nested children — this walk never recurses
				// "h".)
				expect(post.blocks.map((b) => b.content)).toEqual([
					"Beta",
					"para-two",
					"Alpha",
					"para-one",
				]);
				// The membership survives: para-one keeps its pre-move parent
				// (the doc root — still Alpha's section member after the drag).
				const preParaOne = pre.blocks.find((b) => b.content === "para-one")!;
				expect(
					post.blocks.find((b) => b.content === "para-one")!.parentId,
				).toBe(preParaOne.parentId);
			},
			LIVE_TIMEOUT,
		);

		it(
			"raw moveBlock with a section-bearing heading anchor redirects past the section when folded — the kernel fact the derived-anchor rule dodges",
			async () => {
				// The layer-1 client directly (no judgment between caller and
				// kernel), fold set via setBlockAttrs. If the kernel ever stops
				// redirecting, what re-checks is the derivation's motivation (a
				// heading anchor is derived only on an empty section), not the
				// pin's soundness. moveBlock rejects nextID — only previousID /
				// parentID are honored.
				const docId = await mintDoc(
					client,
					box,
					"/MvB Anchor Redirect",
					"## Alpha\n\npara-one\n\n## Beta\n\npara-two\n",
				);
				const pre = await walkBlockTree(client, docId);
				const alpha = heading(pre.blocks, "Alpha");
				const paraTwo = pre.blocks.find((b) => b.content === "para-two")!;
				// Folded: the anchor's stated contract ("lands directly after
				// this block") is not honored — the landing redirects past the
				// section's last member.
				await setFold(alpha.id, true);
				await client.moveBlock({ id: paraTwo.id, previousID: alpha.id });
				let post = await walkBlockTree(client, docId);
				expect(post.blocks.map((b) => b.content)).toEqual([
					"Alpha",
					"para-one",
					"para-two",
					"Beta",
				]);
				// Unfolded: the landing sits directly after the anchor. Restore
				// para-two behind Beta first (its pre-move position), then move
				// again unfolded.
				const beta = heading(pre.blocks, "Beta");
				await client.moveBlock({ id: paraTwo.id, previousID: beta.id });
				await setFold(alpha.id, false);
				await client.moveBlock({ id: paraTwo.id, previousID: alpha.id });
				post = await walkBlockTree(client, docId);
				expect(post.blocks.map((b) => b.content)).toEqual([
					"Alpha",
					"para-two",
					"para-one",
					"Beta",
				]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"judges landed under a doc destination — and pins that the blocks index still reports the pre-move hpath",
			async () => {
				const kid = await mintDoc(
					client,
					box,
					"/MvP Kid",
					"# MvP Kid\n\nkid body\n",
				);
				const dest = await mintDoc(
					client,
					box,
					"/MvP Dest",
					"# MvP Dest\n\ndest body\n",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{ docId: kid, boxId: box, destRootId: dest },
				);
				expect(outcome).toEqual({
					kind: "judged",
					verdict: { kind: "landed", hpath: "/MvP Dest/MvP Kid" },
				});
				// The blocks index is rebuilt asynchronously after moveDocsByID —
				// still the pre-move value immediately after the move. The hpath
				// judgment reads the live tree for exactly this reason.
				const sqlRows = await client.query(
					`SELECT hpath FROM blocks WHERE box = ${sqlString(box)} AND id = ${sqlString(kid)} AND type = 'd'`,
				);
				expect(sqlRows[0]?.hpath).toBe("/MvP Kid");
			},
			LIVE_TIMEOUT,
		);

		it(
			"judges landed over the STORED title — a rename before the move cannot read as not-landed",
			async () => {
				// The judgment composes expected over the stored row's title
				// (ground truth, never a caller-predicted form): a doc renamed
				// outside the flow — or kernel-normalized at storage — must not
				// read as a failed move.
				const kid = await mintDoc(
					client,
					box,
					"/MvT Kid",
					"# MvT Kid\n\nkid body\n",
				);
				const dest = await mintDoc(
					client,
					box,
					"/MvT Dest",
					"# MvT Dest\n\ndest body\n",
				);
				await client.renameDocByID(kid, "MvT Kid II");
				await pollUntil(
					"renamed title reaching the blocks index",
					async () =>
						(
							await client.query(
								`SELECT content FROM blocks WHERE box = ${sqlString(box)} AND id = ${sqlString(kid)} AND type = 'd'`,
							)
						)[0]?.content === "MvT Kid II",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{ docId: kid, boxId: box, destRootId: dest },
				);
				expect(outcome).toEqual({
					kind: "judged",
					verdict: { kind: "landed", hpath: "/MvT Dest/MvT Kid II" },
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"judges landed at the notebook root (un-nest) — hpath collapses to '/' + title",
			async () => {
				const kid = await mintDoc(
					client,
					box,
					"/MvP Dest/MvP Kid2",
					"# MvP Kid2\n\nkid2 body\n",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{ docId: kid, boxId: box },
				);
				expect(outcome).toEqual({
					kind: "judged",
					verdict: { kind: "landed", hpath: "/MvP Kid2" },
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"own-parent no-op (a root-level doc to the notebook root) judges landed",
			async () => {
				const kid = await mintDoc(
					client,
					box,
					"/MvP Kid3",
					"# MvP Kid3\n\nkid3 body\n",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{ docId: kid, boxId: box },
				);
				expect(outcome).toEqual({
					kind: "judged",
					verdict: { kind: "landed", hpath: "/MvP Kid3" },
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"rejects an ancestor move synchronously — verbatim, no verification reads",
			async () => {
				const parent = await mintDoc(
					client,
					box,
					"/MvP Parent",
					"# MvP Parent\n\nparent body\n",
				);
				const kid = await mintDoc(
					client,
					box,
					"/MvP Parent/MvP Inner",
					"# MvP Inner\n\ninner body\n",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{ docId: parent, boxId: box, destRootId: kid },
				);
				expect(outcome.kind).toBe("kernel-refused");
				if (outcome.kind === "kernel-refused") {
					expect(outcome.message).toContain("Cannot move to this location");
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"rejects an identity move synchronously — the same ancestor-move class, verbatim",
			async () => {
				// The identity member (fromID ≡ toID) belongs to the kernel's
				// synchronous ancestor-move rejection: no silent no-op behind
				// HTTP success, so the hpath judgment is never reached and the
				// kernel-refused arm surfaces the rejection verbatim. Sole
				// falsification of the identity member — the flows carry no
				// pre-mutation self-check of their own.
				const selfDoc = await mintDoc(
					client,
					box,
					"/MvS Self",
					"# MvS Self\n\nself body\n",
				);
				const outcome = await moveDocVerified(
					client,
					{ verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
					{
						docId: selfDoc,
						boxId: box,
						destRootId: selfDoc,
					},
				);
				expect(outcome.kind).toBe("kernel-refused");
				if (outcome.kind === "kernel-refused") {
					expect(outcome.message).toContain("Cannot move to this location");
				}
				// No torn write behind the rejection: the doc is exactly where
				// it was (the live-tree hpath read — the move judgment's own
				// vehicle).
				expect(await hPathByID(client, selfDoc)).toBe("/MvS Self");
			},
			LIVE_TIMEOUT,
		);

		it(
			"a doc-level move past the kernel's 7-level depth cap is refused synchronously, verbatim",
			async () => {
				// A depth-7 destination chain (the kernel's creation cap): nesting
				// under a doc that deep is rejected by the kernel's own depth cap,
				// both at creation and at move time.
				let path = "";
				for (let i = 1; i <= 7; i++) {
					path += `/MvD Chain ${i}`;
					await mintDoc(client, box, path, `# MvD Chain ${i}\n\ndeep ${i}\n`);
				}
				const mover = await mintDoc(
					client,
					box,
					"/MvD Mover",
					"# MvD Mover\n\nmover body\n",
				);
				const chainRows = await client.query(
					`SELECT id FROM blocks WHERE box = ${sqlString(box)} AND hpath = ${sqlString(path)} AND type = 'd'`,
				);
				const outcome = await moveDocVerified(client, probe, {
					docId: mover,
					boxId: box,
					destRootId: String(chainRows[0]!.id),
				});
				expect(outcome.kind).toBe("kernel-refused");
				if (outcome.kind === "kernel-refused") {
					// The kernel's depth-cap rejection verbatim.
					expect(outcome.message).toContain("7 levels deep");
				}
			},
			LIVE_TIMEOUT,
		);
	},
);
