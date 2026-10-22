// Live pins: the batched section move (`moveVerified`'s section route) —
// the pin duties live in the AGENTS.md fact list's batched-route bullet
// and moveSectionPlan.ts's docstrings. The section-route rows falsify, on
// every upgrade pass: the members-first insert-before codec's fold matrix
// (folded and unfolded sources and destinations), the doc-end chain arm
// and its degenerates, the concurrent-append swallow the landed judgment
// must name, the folded boundary anchor, the chain anchor's recursion
// into an empty-section tail heading, the container shapes (list items,
// callouts), the kernel backstops behind the group refusals, the
// cross-doc rollback residue and its source-doc heal, and the ≥32-op
// per-op-path batch. The per-id pins live in move.live.test.ts. Ordered
// before the throttle file; teardown asserts zero strays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import type { TransactionOperation } from "siyuan-kernel-api";
import { moveVerified, type MoveVerifiedOutcome } from "../../move.js";
import { transactThenWalk } from "../../batch.js";
import { planMoveSection } from "../../moveSectionPlan.js";
import { PINNED_SIYUAN_VERSION } from "../../version.js";
import { walkBlockTree, type WalkedTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	mintDoc,
	rawKernelCall,
	setupFixtures,
	TOKEN,
} from "./harness.js";
import {
	byContent,
	containerOf,
	expectSectionRoute,
	idOrder,
	rootContent,
	setFold,
	settle,
} from "./moveHelpers.js";

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

/** The source fixture: S / s0 / H / m1 / m2 / H2 / sub1 / m3 / T / t1
 * — H's member run is [m1, m2, H2, sub1, m3] (H2 a nested subsection
 * heading carrying sub1); the memberless variant is the degenerate shape. */
const SOURCE_MD =
	"# S\n\ns0\n\n## H\n\nm1\n\nm2\n\n### H2\n\nsub1\n\nm3\n\n## T\n\nt1";
/** The memberless degenerate at h1: a level-1 heading with nothing after
 * it (an h2 heading here would carry T's section — memberless requires the
 * heading to be the doc's last block at its own level). The h1 level also
 * pins the owner-null landings: no heading's section contains them. */
const MEMBERLESS_MD = "# S\n\ns0\n\n# H\n";

async function mintSectionSource(
	path: string,
	md: string = SOURCE_MD,
): Promise<{
	docId: string;
	walk: WalkedTree;
	id: (content: string) => string;
}> {
	const docId = await mintDoc(client, box, `/${path}`, md);
	const walk = await walkBlockTree(client, docId);
	return { docId, walk, id: (c) => byContent(walk, c).id };
}

/** The two-route entry — the tool path's one primitive call. The dispatch's
 * row-type judgment (heading → the batched section route) is part of what
 * every case below exercises. */
async function runSectionMove(input: {
	blockId: string;
	rootId: string;
	destRootId: string;
	destWalk: WalkedTree;
	toHeadingId?: string | undefined;
}): Promise<MoveVerifiedOutcome> {
	return moveVerified(client, probe, {
		blockId: input.blockId,
		rootId: input.rootId,
		destRootId: input.destRootId,
		preDestWalk: input.destWalk,
		...(input.toHeadingId === undefined
			? {}
			: { toHeadingId: input.toHeadingId }),
	});
}

/** One section-route cell: mint the source + destination fixture pair,
 * run the two-route entry's section route, and narrow past the wrapper.
 * The per-cell facts — arm, anchor, landed shape, owner — stay in the
 * caller's assertions; this only collapses the fixture/issue scaffold the
 * whole family shares. `toHeading` names the destination heading by
 * content (undefined is the doc-end form); `prepare` runs after the
 * destination walk and before the batch (folds, concurrent appends). */
async function sectionCell(input: {
	tag: string;
	destMd: string;
	toHeading?: string | undefined;
	srcMd?: string | undefined;
	prepare?:
		| ((ctx: {
				src: Awaited<ReturnType<typeof mintSectionSource>>;
				destWalk: WalkedTree;
		  }) => Promise<void>)
		| undefined;
}) {
	const src = await mintSectionSource(`${input.tag} Src`, input.srcMd);
	const destId = await mintDoc(client, box, `/${input.tag} Dest`, input.destMd);
	const destWalk = await walkBlockTree(client, destId);
	if (input.prepare !== undefined) {
		await input.prepare({ src, destWalk });
	}
	const toHeadingId =
		input.toHeading === undefined
			? undefined
			: byContent(destWalk, input.toHeading).id;
	const outcome = expectSectionRoute(
		await runSectionMove({
			blockId: src.id("H"),
			rootId: src.docId,
			destRootId: destId,
			destWalk,
			...(toHeadingId === undefined ? {} : { toHeadingId }),
		}),
	);
	return { src, destWalk, toHeadingId, outcome };
}

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"live: verified section moves (the batched section route)",
	() => {
		it(
			"the members-first codec lands the folded source's whole section across every fold combination",
			async () => {
				// Every block of the run is issued, sub-members included; a
				// self-folded heading leg drags its current children — the drag
				// lands inside the enumerated span and the re-issued ops put it
				// back in order, so all four fold combinations land identically
				// and the landed judgment reads them clean.
				const combos = [
					{ foldH: false, foldH2: false },
					{ foldH: true, foldH2: false },
					{ foldH: false, foldH2: true },
					{ foldH: true, foldH2: true },
				];
				for (const [i, combo] of combos.entries()) {
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: `FoldCombo ${i}`,
						destMd: "# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
						toHeading: "B",
						prepare: async ({ src }) => {
							if (combo.foldH) await setFold(src.id("H"), true);
							if (combo.foldH2) await setFold(src.id("H2"), true);
							if (combo.foldH || combo.foldH2) await settle();
						},
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "insert",
						nextID: byContent(destWalk, "Z").id,
					});
					expect(landed.landedIds).toEqual([
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
					]);
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D",
						"d1",
						"B",
						"b1",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
						"Z",
						"z1",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// The owner: the landed h2 bounds B's section but is a member
					// of the doc-level section — the destination heading's own
					// owner, read container-locally off the post-write walk.
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D").content,
					});
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"the doc-end chain lands in document order across folds — no LIFO rule, no shared anchor",
			async () => {
				// The doc-end form (no toHeadingId): members chain previousID
				// from the destination doc's last root-level block, the heading
				// issues last on the boundary arm's own nextID leg — the same
				// landing unfolded, with the source heading folded, and with the
				// nested subsection folded.
				for (const [i, fold] of ["none", "H", "H2"].entries()) {
					const { destWalk, outcome: landed } = await sectionCell({
						tag: `DocEnd ${i}`,
						destMd: "# D2\n\nd2\n\n## E\n\ne1\n",
						prepare:
							fold === "none"
								? undefined
								: async ({ src }) => {
										await setFold(src.id(fold), true);
										await settle();
									},
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: byContent(destWalk, "e1").id,
						at: "doc-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D2",
						"d2",
						"E",
						"e1",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// The landed h2 terminates E's section (its boundary), but it
					// stays a member of the doc-level h1's section — the owner is
					// the destination doc's own heading, read container-locally.
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D2").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D2").content,
					});
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"the same-doc doc-end chain lands the section at the document's end — one walk serves both roles",
			async () => {
				// The common flow shape: the caller's single walk IS the source
				// walk and the destination walk (the entry's walk rule) — the
				// group-refusal gates, the codec, and the landed judgment all
				// read it, and the rollback discriminators (the neighbour-identity
				// leg, the chain-anchor interval) all run over that one walk.
				const doc = await mintSectionSource(
					"SameDocEnd",
					"# S\n\ns0\n\n## H\n\nm1\n\nm2\n\n### H2\n\nsub1\n\nm3\n\n## T\n\nt1\n\n## U\n\nu1",
				);
				const walk = await walkBlockTree(client, doc.docId);
				const landed = expectSectionRoute(
					await runSectionMove({
						blockId: doc.id("H"),
						rootId: doc.docId,
						destRootId: doc.docId,
						destWalk: walk,
					}),
				);
				expect(landed.kind).toBe("landed");
				if (landed.kind !== "landed") return;
				expect(landed.anchor).toEqual({
					kind: "move",
					previousID: doc.id("u1"),
					at: "doc-end",
				});
				expect(landed.landedIds).toEqual([
					doc.id("H"),
					doc.id("m1"),
					doc.id("m2"),
					doc.id("H2"),
					doc.id("sub1"),
					doc.id("m3"),
				]);
				// One doc, both roles: the evidence walks are the same doc's
				// tree — the section gone from the front, landed at the end.
				expect(landed.postSourceWalk.rootId).toBe(doc.docId);
				expect(landed.postDestWalk.rootId).toBe(doc.docId);
				expect(rootContent(landed.postDestWalk)).toEqual([
					"S",
					"s0",
					"T",
					"t1",
					"U",
					"u1",
					"H",
					"m1",
					"m2",
					"H2",
					"sub1",
					"m3",
				]);
				// The source doc's own h1 ('# S') spans the document — its
				// closure claims the landed h2, exactly as the destination
				// doc's h1 claims the landing cross-doc.
				expect(landed.owner).toEqual({
					headingId: doc.id("S"),
					level: 1,
					content: byContent(doc.walk, "S").content,
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"an empty destination section anchors on the destination heading itself, fold-independent",
			async () => {
				// The recursion's fixed point: no members → the anchor is the
				// destination heading; the fold redirect has no target while the
				// section stays empty (the 0 < l guard), so both folds land
				// identically.
				for (const [i, foldE] of [false, true].entries()) {
					const { toHeadingId, outcome: landed } = await sectionCell({
						tag: `EmptyDest ${i}`,
						destMd: "# D3\n\nd3\n\n## E\n",
						toHeading: "E",
						prepare: foldE
							? async ({ destWalk }) => {
									await setFold(byContent(destWalk, "E").id, true);
									await settle();
								}
							: undefined,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: toHeadingId,
						at: "section-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D3",
						"d3",
						"E",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// Same shape as the doc-end chain cases above: the landed h2 is a
					// member of the doc-level h1's section.
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D3").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D3").content,
					});
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"a memberless section rides both arms — the degenerate shape is every memberless heading's route",
			async () => {
				// Under the row-type dispatch a memberless heading IS the section
				// route at its degenerate shape — a single heading leg, owner
				// null on both arms (the landing terminates its container's
				// section and owns only its members — of which it has none).
				// Boundary arm: the heading nextID = the boundary.
				{
					const { src, outcome: landed } = await sectionCell({
						tag: "Memberless B",
						destMd: "# D\n\nd1\n\n# X\n\nx1\n",
						toHeading: "D",
						srcMd: MEMBERLESS_MD,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor.kind).toBe("insert");
					expect(landed.landedIds).toEqual([src.id("H")]);
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D",
						"d1",
						"H",
						"X",
						"x1",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual(["S", "s0"]);
					expect(landed.owner).toBeNull();
				}
				// Chain arm, doc-end form: the heading previousID = the last
				// root-level block.
				{
					const { destWalk, outcome: landed } = await sectionCell({
						tag: "Memberless C",
						destMd: "# D2\n\nd2\n\n## E\n\ne1\n",
						srcMd: MEMBERLESS_MD,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: byContent(destWalk, "e1").id,
						at: "doc-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D2",
						"d2",
						"E",
						"e1",
						"H",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual(["S", "s0"]);
					expect(landed.owner).toBeNull();
				}
				// Chain arm onto an empty destination section: the heading
				// previousID = the destination heading (the fixed point).
				{
					const { toHeadingId, outcome: landed } = await sectionCell({
						tag: "Memberless D",
						destMd: "# D3\n\nd3\n\n## E\n",
						toHeading: "E",
						srcMd: MEMBERLESS_MD,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: toHeadingId,
						at: "section-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D3",
						"d3",
						"E",
						"H",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual(["S", "s0"]);
					expect(landed.owner).toBeNull();
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"a concurrent append into the destination between walk and batch is judged, never silent",
			async () => {
				// The destination walk is fetched, then a block is appended into
				// the destination section, then the batch issues — the currency
				// scenario. On the chain arm the append lands behind the run's
				// insertion point and is swallowed into the moved section's
				// tail (fold-dependently); the predicate catches the swallow
				// either way: clause (a)'s exact equality fails, and the
				// report is landed-divergent naming the swallowed block —
				// never a silent one. The redirect cell (folded anchor)
				// lands correctly and reports landed.
				// Empty destination, anchor heading unfolded: swallow.
				{
					const { src, outcome: div } = await sectionCell({
						tag: "Append H",
						destMd: "# D3\n\nd3\n\n## E\n",
						toHeading: "E",
						prepare: async ({ destWalk }) => {
							await client.insertBlock({
								data: "ap",
								previousID: byContent(destWalk, "E").id,
							});
							await settle();
						},
					});
					expect(div.kind).toBe("landed-divergent");
					if (div.kind !== "landed-divergent") return;
					expect(div.stillInSourceIds).toEqual([]);
					expect(div.unjudgedIds).toEqual([
						byContent(div.postDestWalk, "ap").id,
					]);
					expect(div.landedAtIndex).toBe(
						div.postDestWalk.blocks.findIndex((b) => b.id === src.id("H")),
					);
					// The swallow, live: the run landed and the appended block
					// was dragged into the moved section's tail.
					expect(rootContent(div.postDestWalk)).toEqual([
						"D3",
						"d3",
						"E",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
						"ap",
					]);
				}
				// The same shape with the anchor heading folded: the
				// redirect fires, the run lands after the append (correct
				// end-of-section), and the judgment reports landed.
				{
					const { outcome: landed } = await sectionCell({
						tag: "Append I",
						destMd: "# D3\n\nd3\n\n## E\n",
						toHeading: "E",
						prepare: async ({ destWalk }) => {
							await setFold(byContent(destWalk, "E").id, true);
							await settle();
							await client.insertBlock({
								data: "ap",
								previousID: byContent(destWalk, "E").id,
							});
							await settle();
						},
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor.kind).toBe("move");
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D3",
						"d3",
						"E",
						"ap",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// The landed h2 is a member of the doc-level h1's section.
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D3").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D3").content,
					});
				}
				// The same append against the doc-end chain anchor (e1,
				// the doc-end form): the append lands at the section's end —
				// exactly the position the hazard needs — and is swallowed.
				{
					const { outcome: div } = await sectionCell({
						tag: "Append J",
						destMd: "# D2\n\nd2\n\n## E\n\ne1\n",
						prepare: async ({ destWalk }) => {
							await client.insertBlock({
								data: "ap",
								previousID: byContent(destWalk, "e1").id,
							});
							await settle();
						},
					});
					expect(div.kind).toBe("landed-divergent");
					if (div.kind !== "landed-divergent") return;
					expect(div.unjudgedIds).toEqual([
						byContent(div.postDestWalk, "ap").id,
					]);
					expect(rootContent(div.postDestWalk)).toEqual([
						"D2",
						"d2",
						"E",
						"e1",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
						"ap",
					]);
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"the chain anchor recurses into an empty-section tail heading — end-of-section, fold-independent",
			async () => {
				// The destination section's tail is a heading: the anchor
				// derivation recurses into it and anchors on it only when its
				// section is EMPTY — after-heading placement IS end-of-section
				// there (the redirect has no target), folded or not; a
				// populated tail anchors on its body (its last member), never
				// on the tail heading itself.
				for (const [i, foldE2] of [false, true].entries()) {
					const { destWalk, outcome: landed } = await sectionCell({
						tag: `TailHead ${i}`,
						destMd: "# D\n\nd1\n\n## E\n\ne1\n\n### E2\n",
						toHeading: "E",
						prepare: foldE2
							? async ({ destWalk }) => {
									await setFold(byContent(destWalk, "E2").id, true);
									await settle();
								}
							: undefined,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: byContent(destWalk, "E2").id,
						at: "section-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D",
						"d1",
						"E",
						"e1",
						"E2",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// The landed h2 terminates E's section; the doc-level h1's
					// section contains the landing.
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D").content,
					});
				}
				// A populated tail (### E2 / e2body): the anchor recurses past
				// the tail heading to its body; the second variant adds the
				// moved-node fold (the drag rides the heading leg over an
				// already-emptied section).
				for (const [i, foldSrcH] of [false, true].entries()) {
					const { destWalk, outcome: landed } = await sectionCell({
						tag: `TailBody ${i}`,
						destMd: "# D\n\nd1\n\n## E\n\ne1\n\n### E2\n\ne2body\n",
						toHeading: "E",
						prepare: foldSrcH
							? async ({ src }) => {
									await setFold(src.id("H"), true);
									await settle();
								}
							: undefined,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: byContent(destWalk, "e2body").id,
						at: "section-end",
					});
					expect(rootContent(landed.postDestWalk)).toEqual([
						"D",
						"d1",
						"E",
						"e1",
						"E2",
						"e2body",
						"H",
						"m1",
						"m2",
						"H2",
						"sub1",
						"m3",
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D").content,
					});
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"every member leg anchors on a folded heading boundary and lands literally",
			async () => {
				// The one fold cell the codec's other rows never exercise: the
				// boundary arm's member legs all anchor on a heading — the
				// nextID branch takes no fold redirect (!moveBefore), so the
				// run lands literally against a folded anchor.
				const { destWalk, outcome: landed } = await sectionCell({
					tag: "FoldAnchor",
					destMd: "# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
					toHeading: "B",
					prepare: async ({ destWalk }) => {
						await setFold(byContent(destWalk, "Z").id, true);
						await settle();
					},
				});
				expect(landed.kind).toBe("landed");
				if (landed.kind !== "landed") return;
				expect(landed.anchor).toEqual({
					kind: "insert",
					nextID: byContent(destWalk, "Z").id,
				});
				expect(rootContent(landed.postDestWalk)).toEqual([
					"D",
					"d1",
					"B",
					"b1",
					"H",
					"m1",
					"m2",
					"H2",
					"sub1",
					"m3",
					"Z",
					"z1",
				]);
				expect(rootContent(landed.postSourceWalk)).toEqual([
					"S",
					"s0",
					"T",
					"t1",
				]);
				expect(landed.owner).toEqual({
					headingId: byContent(landed.postDestWalk, "D").id,
					level: 1,
					content: byContent(landed.postDestWalk, "D").content,
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"doc-end chain anchors on non-heading containers land the run as siblings after the container",
			async () => {
				// The doc-end form's chain anchor is any last root-level block —
				// leaf or container, any tail shape. The run lands as the
				// container's doc-level siblings; the container's children are
				// untouched (the sibling insert is anchor-type-blind).
				const legs = [
					{ tag: "Quote", tail: "> q1", tailKids: ["q1"] },
					{
						tag: "QuoteHeading",
						tail: "> s1\n> ## SH\n> sh1",
						tailKids: ["s1", "SH", "sh1"],
					},
					{
						tag: "QuoteHeadingFolded",
						tail: "> s1\n> ## SH\n> sh1",
						tailKids: ["s1", "SH", "sh1"],
						foldSrcH: true,
					},
					{ tag: "List", tail: "- l1\n\n- l2", tailKids: ["l1", "l2"] },
				];
				for (const leg of legs) {
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: leg.tag,
						destMd: `# D2\n\nd2\n\n## E\n\ne1\n\n${leg.tail}\n`,
						prepare:
							leg.foldSrcH === true
								? async ({ src }) => {
										await setFold(src.id("H"), true);
										await settle();
									}
								: undefined,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					const container = containerOf(landed.postDestWalk, leg.tailKids[0]!);
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: container.id,
						at: "doc-end",
					});
					expect(idOrder(landed.postDestWalk, null)).toEqual([
						byContent(destWalk, "D2").id,
						byContent(destWalk, "d2").id,
						byContent(destWalk, "E").id,
						byContent(destWalk, "e1").id,
						container.id,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
					]);
					// The container's children untouched (trimmed — list items
					// carry the bullet's leading space in their row content).
					expect(
						landed.postDestWalk.blocks
							.filter((b) => b.parentId === container.id)
							.map((b) => b.content.trim()),
					).toEqual(leg.tailKids);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"a container-nested destination section re-nests the moved run into that container",
			async () => {
				// Container locality on the chain arm: the chain anchor lives
				// inside the destination's own container by construction, so a
				// destination section inside a quote re-nests the run into it —
				// the empty-section fixed point (the anchor IS the destination
				// heading, inside the container) included, fold-independent.
				// With E's section {e1}: the anchor is e1, inside the quote.
				{
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: "Nested",
						destMd: "# DA\n\nda1\n\n> ## E\n> e1\n",
						toHeading: "E",
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: byContent(destWalk, "e1").id,
						at: "section-end",
					});
					const quote = containerOf(landed.postDestWalk, "e1");
					expect(idOrder(landed.postDestWalk, quote.id)).toEqual([
						byContent(destWalk, "E").id,
						byContent(destWalk, "e1").id,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
					]);
					expect(idOrder(landed.postDestWalk, null)).toEqual([
						byContent(destWalk, "DA").id,
						byContent(destWalk, "da1").id,
						quote.id,
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// The landed h2 is a top-level section of the quote beside E —
					// the container is the answer (a same-level landing inside a
					// container is that container's, never an outer heading's),
					// never an outer heading whose closure merely spans the
					// container.
					expect(landed.owner).toBeNull();
				}
				// With E's section EMPTY: the fixed point anchors on the
				// destination heading itself, inside the container, and the
				// landing is fold-independent (the redirect has no target).
				for (const [i, foldE] of [false, true].entries()) {
					const {
						src,
						toHeadingId,
						outcome: landed,
					} = await sectionCell({
						tag: `Nested Empty ${i}`,
						destMd: "# DB\n\ndb1\n\n> ## E\n",
						toHeading: "E",
						prepare: foldE
							? async ({ destWalk }) => {
									await setFold(byContent(destWalk, "E").id, true);
									await settle();
								}
							: undefined,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: toHeadingId,
						at: "section-end",
					});
					const quote = containerOf(landed.postDestWalk, "H");
					expect(idOrder(landed.postDestWalk, quote.id)).toEqual([
						toHeadingId,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					expect(landed.owner).toBeNull();
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"callout and superblock chain anchors and re-nests behave like quote and list",
			async () => {
				// The sibling insert is anchor-type-blind across the whole
				// container vocabulary (the kernel's special-casing stays in
				// doMove's parent branch), and the re-nest reading generalizes.
				// Doc-end chain anchors on a callout / superblock: the run
				// lands as the container's doc-level siblings after it.
				for (const leg of [
					{ tag: "Callout", lead: "dc1", tail: "> [!NOTE]\n> c1", kid: "c1" },
					{
						tag: "Superblock",
						lead: "dd1",
						tail: "{{{row\nsb1\n}}}",
						kid: "sb1",
					},
				]) {
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: leg.tag,
						destMd: `# D\n\n${leg.lead}\n\n## E\n\ne1\n\n${leg.tail}\n`,
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					const container = containerOf(landed.postDestWalk, leg.kid);
					expect(landed.anchor).toEqual({
						kind: "move",
						previousID: container.id,
						at: "doc-end",
					});
					expect(idOrder(landed.postDestWalk, null)).toEqual([
						byContent(destWalk, "D").id,
						byContent(destWalk, leg.lead).id,
						byContent(destWalk, "E").id,
						byContent(destWalk, "e1").id,
						container.id,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
				}
				// The destination section inside a callout / superblock,
				// boundary arm: the run re-nests into the container as the
				// destination section's end, R still bounding after.
				for (const leg of [
					{
						tag: "Callout Re-nest",
						lead: "de1",
						tail: "> [!NOTE]\n> ## Q\n> q1\n> ## R\n> r1",
					},
					{
						tag: "Superblock Re-nest",
						lead: "df1",
						tail: "{{{row\n## Q\nq1\n## R\nr1\n}}}",
					},
					{
						tag: "Quote Re-nest",
						lead: "dq1",
						tail: "> ## Q\n> q1\n> ## R\n> r1",
					},
				]) {
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: leg.tag,
						destMd: `# D\n\n${leg.lead}\n\n${leg.tail}\n`,
						toHeading: "Q",
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor).toEqual({
						kind: "insert",
						nextID: byContent(destWalk, "R").id,
					});
					const container = containerOf(landed.postDestWalk, "q1");
					expect(idOrder(landed.postDestWalk, container.id)).toEqual([
						byContent(destWalk, "Q").id,
						byContent(destWalk, "q1").id,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						src.id("H2"),
						src.id("sub1"),
						src.id("m3"),
						byContent(destWalk, "R").id,
						byContent(destWalk, "r1").id,
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					// Same-level landing inside the container: the container is
					// the answer (the owner-certification rule — a same-level
					// landing inside a container is that container's, never an
					// outer heading's).
					expect(landed.owner).toBeNull();
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"the crossed-container heading leg and the deeper-in-container owner",
			async () => {
				// A first moved member that is itself a container: the heading
				// leg anchors on it after it has already crossed mid-batch (the
				// nextID branch takes no fold redirect, the emptied heading
				// drags nothing).
				{
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: "Container Member",
						destMd: "# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
						toHeading: "B",
						srcMd: "# S\n\ns0\n\n## H\n\n> qm\n\nm2\n\n## T\n\nt1",
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor.kind).toBe("insert");
					const quote = containerOf(landed.postDestWalk, "qm");
					expect(idOrder(landed.postDestWalk, null)).toEqual([
						byContent(destWalk, "D").id,
						byContent(destWalk, "d1").id,
						byContent(destWalk, "B").id,
						byContent(destWalk, "b1").id,
						src.id("H"),
						quote.id,
						byContent(src.walk, "m2").id,
						byContent(destWalk, "Z").id,
						byContent(destWalk, "z1").id,
					]);
					// The container's child rode along inside it.
					expect(idOrder(landed.postDestWalk, quote.id)).toEqual([
						byContent(src.walk, "qm").id,
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "D").id,
						level: 1,
						content: byContent(landed.postDestWalk, "D").content,
					});
				}
				// A deeper moved heading inside a container nests under the
				// container's own heading — the owner is inside the container.
				{
					const {
						src,
						destWalk,
						outcome: landed,
					} = await sectionCell({
						tag: "Deep Heading",
						destMd: "# DQ\n\ndq1\n\n> ## Q\n> q1\n> ## R\n> r1\n",
						toHeading: "Q",
						srcMd: "# S\n\ns0\n\n### H\n\nm1\n\nm2\n\n## T\n\nt1",
					});
					expect(landed.kind).toBe("landed");
					if (landed.kind !== "landed") return;
					expect(landed.anchor.kind).toBe("insert");
					const quote = containerOf(landed.postDestWalk, "q1");
					expect(idOrder(landed.postDestWalk, quote.id)).toEqual([
						byContent(destWalk, "Q").id,
						byContent(destWalk, "q1").id,
						src.id("H"),
						src.id("m1"),
						src.id("m2"),
						byContent(destWalk, "R").id,
						byContent(destWalk, "r1").id,
					]);
					expect(rootContent(landed.postSourceWalk)).toEqual([
						"S",
						"s0",
						"T",
						"t1",
					]);
					expect(landed.owner).toEqual({
						headingId: byContent(landed.postDestWalk, "Q").id,
						level: 2,
						content: byContent(landed.postDestWalk, "Q").content,
					});
				}
			},
			LIVE_TIMEOUT,
		);

		it(
			"a rolled-back cross-doc batch leaves wrong-root rows that only a source-doc write heals; heal-then-retry lands whole",
			async () => {
				// The residue round trip: a batch with an injected skip-class op
				// rolls back whole behind the code-0 ack; the moved ids' blocktree
				// rows carry the post-move layout behind the pre-move source tree
				// and resolve not-found (never a wrong block); a committed write
				// to the destination heals nothing (its tree never contained the
				// node); a committed write to the SOURCE doc re-upserts the rows;
				// the healed retry lands whole.
				const infoCode = async (id: string): Promise<number> => {
					const res = await rawKernelCall("/api/block/getBlockInfo", { id });
					return (res.body as { code: number } | undefined)?.code ?? -999;
				};
				const src = await mintSectionSource("Residue Src");
				const destId = await mintDoc(
					client,
					box,
					"/Residue Dest",
					"# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
				);
				const destWalk = await walkBlockTree(client, destId);
				const planned = planMoveSection({
					blockId: src.id("H"),
					toHeadingId: byContent(destWalk, "B").id,
					rootId: src.docId,
					destRootId: destId,
					sourceWalk: src.walk,
					destWalk,
				});
				expect(planned.kind).toBe("planned");
				if (planned.kind !== "planned") return;
				const m3 = byContent(src.walk, "m3");
				const ops: TransactionOperation[] = [
					...planned.plan.ops,
					{ action: "move", id: m3.id, nextID: m3.id },
				];
				const batched = await transactThenWalk(client, {
					operations: ops,
					rootIds: [src.docId, destId],
				});
				expect(batched.kind).toBe("walked");
				if (batched.kind !== "walked") return;
				// Rolled back whole behind the code-0 ack: both walks hold the
				// pre-move layout.
				expect(rootContent(batched.walks[0])).toEqual(rootContent(src.walk));
				expect(rootContent(batched.walks[1]!)).toEqual(rootContent(destWalk));
				const m1 = byContent(src.walk, "m1");
				expect(await infoCode(m1.id)).toBe(-1);
				// A committed write to the DESTINATION doc heals nothing.
				await client.appendBlock({ data: "dest heal\n", parentID: destId });
				expect(await infoCode(m1.id)).toBe(-1);
				// A committed write to the SOURCE doc restores resolvability.
				await client.appendBlock({
					data: "source heal\n",
					parentID: src.docId,
				});
				expect(await infoCode(m1.id)).toBe(0);
				// Heal-then-retry lands whole.
				const landed = expectSectionRoute(
					await runSectionMove({
						blockId: src.id("H"),
						rootId: src.docId,
						destRootId: destId,
						destWalk,
						toHeadingId: byContent(destWalk, "B").id,
					}),
				);
				expect(landed.kind).toBe("landed");
				if (landed.kind !== "landed") return;
				expect(landed.anchor.kind).toBe("insert");
				expect(rootContent(landed.postDestWalk)).toEqual([
					"D",
					"d1",
					"B",
					"b1",
					"H",
					"m1",
					"m2",
					"H2",
					"sub1",
					"m3",
					"Z",
					"z1",
					"dest heal",
				]);
				expect(rootContent(landed.postSourceWalk)).toEqual([
					"S",
					"s0",
					"T",
					"t1",
					"source heal",
				]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a batch anchored inside the moved set rolls back whole behind code 0 — the closure refusal's kernel backstop",
			async () => {
				// The own-closure refusal fires pre-mutation, so the backstop is
				// pinned on the raw op array: a naive derivation whose anchor
				// (q1) lives inside the moved quote trips the kernel's own
				// self-anchoring guard — the batch rolls back WHOLE, including
				// the op that had already landed, behind HTTP success.
				const docId = await mintDoc(
					client,
					box,
					"/MvS Contain",
					"# Probe\n\na1\n\n## H\n\nm1\n\n> ## Q\n> q1\n\nm2\n\n## Z\n\nz1\n",
				);
				const pre = await walkBlockTree(client, docId);
				const q1 = byContent(pre, "q1").id;
				const quote = containerOf(pre, "q1").id;
				const ops: TransactionOperation[] = [
					byContent(pre, "m1").id,
					quote,
					byContent(pre, "m2").id,
					byContent(pre, "H").id,
				].map((id) => ({ action: "move", id, previousID: q1 }));
				const batched = await transactThenWalk(client, {
					operations: ops,
					rootIds: [docId],
				});
				expect(batched.kind).toBe("walked");
				if (batched.kind !== "walked") return;
				// Byte-identical: ids and parents in document order.
				expect(batched.walks[0].blocks.map((b) => [b.id, b.parentId])).toEqual(
					pre.blocks.map((b) => [b.id, b.parentId]),
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a cross-doc batch anchoring into the source tree rolls back whole — the kernel guard is the backstop",
			async () => {
				// The containment shape cannot arise cross-doc; a gate miss that
				// anchors into the SOURCE doc (the anchor cohabits a tree with a
				// moved container) still trips isMovingParentIntoChild — whole
				// rollback, both layouts byte-identical.
				const src = await mintSectionSource(
					"M2 Src",
					"# S\n\ns0\n\n## H\n\nm1\n\n> q2\n\nm2\n\n## T\n\nt1",
				);
				const destId = await mintDoc(
					client,
					box,
					"/M2 Dest",
					"# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
				);
				const destPre = await walkBlockTree(client, destId);
				const q2 = byContent(src.walk, "q2").id;
				const quote = containerOf(src.walk, "q2").id;
				const ops: TransactionOperation[] = [
					{ action: "move", id: byContent(src.walk, "m1").id, nextID: q2 },
					{ action: "move", id: quote, nextID: q2 },
					{ action: "move", id: byContent(src.walk, "m2").id, nextID: q2 },
					{
						action: "move",
						id: src.id("H"),
						nextID: byContent(src.walk, "m1").id,
					},
				];
				const batched = await transactThenWalk(client, {
					operations: ops,
					rootIds: [src.docId, destId],
				});
				expect(batched.kind).toBe("walked");
				if (batched.kind !== "walked") return;
				expect(batched.walks[0].blocks.map((b) => [b.id, b.parentId])).toEqual(
					src.walk.blocks.map((b) => [b.id, b.parentId]),
				);
				expect(batched.walks[1]!.blocks.map((b) => [b.id, b.parentId])).toEqual(
					destPre.blocks.map((b) => [b.id, b.parentId]),
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a 36-op move-only batch takes the per-op path and lands whole (the bulk path collects only delete ops)",
			async () => {
				// 35-member section + heading = 36 ops, cross-doc. Move batches
				// always take the kernel's per-op execution path (the ≥32 bulk
				// path collects only delete ops and falls back when a
				// non-delete op sits before the last position) and land whole
				// in document order. No wall-clock assertion — the latency
				// datum lives in the module docstring.
				const members = Array.from(
					{ length: 35 },
					(_, i) => `j${String(i + 1).padStart(2, "0")}`,
				);
				const { src, outcome: landed } = await sectionCell({
					tag: "Bulk",
					destMd: "# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
					toHeading: "B",
					srcMd: [
						"# J",
						"",
						"s0",
						"",
						"## H",
						"",
						members.join("\n\n"),
						"",
						"## T",
						"",
						"t1",
						"",
					].join("\n"),
				});
				expect(landed.kind).toBe("landed");
				if (landed.kind !== "landed") return;
				expect(landed.anchor.kind).toBe("insert");
				expect(landed.landedIds).toEqual([
					src.id("H"),
					...members.map((m) => src.id(m)),
				]);
				expect(rootContent(landed.postDestWalk)).toEqual([
					"D",
					"d1",
					"B",
					"b1",
					"H",
					...members,
					"Z",
					"z1",
				]);
				expect(rootContent(landed.postSourceWalk)).toEqual([
					"J",
					"s0",
					"T",
					"t1",
				]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a same-level destination lands sibling-after — the relation rides the landed verdict",
			async () => {
				// H (h2) onto B (h2): same-level members can't sit inside a
				// same-level section, so the landing is a sibling section after
				// B's — the reordering capability, pinned live with its level
				// pair.
				const { outcome: landed } = await sectionCell({
					tag: "SiblingAfter",
					destMd: "# D\n\nd1\n\n## B\n\nb1\n\n## Z\n\nz1\n",
					toHeading: "B",
				});
				expect(landed.kind).toBe("landed");
				if (landed.kind !== "landed") return;
				expect(landed.destination).toEqual({
					relation: "sibling-after",
					movedLevel: 2,
					destinationLevel: 2,
				});
			},
			LIVE_TIMEOUT,
		);
	},
);
