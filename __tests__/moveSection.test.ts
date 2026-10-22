// Unit cases for the verified section move — the batched route's
// semantics: the group refusals judged pre-mutation over the held walks
// (identity/closure, the shallower-than-boundary level comparison, the two
// already-at-destination derivations, the per-walk gates), the codec's op
// array (members in document order, heading last; the boundary arm's
// `nextID` legs and the chain arm's `previousID` chain), the landed
// judgment over the post-write walks (exact member equality, the arm-keyed
// tail clauses, the owner certification, the fixed arm order with
// `nothing-moved` first and truncation second), and the sequence wiring.
// The stub tree mutates exactly like the kernel's raw move ops
// (moveSectionStub.ts), so every judged post state is a real walked tree.

import { describe, expect, it } from "vitest";
import {
	judgeMoveSectionLanded,
	moveSectionVerified,
	type MoveSectionOutcome,
} from "../moveSection.js";
import { planMoveSection, type MoveSectionPlan } from "../moveSectionPlan.js";
import type { WalkedTree } from "../walk.js";
import { deepChain } from "./readStub.js";
import {
	DST,
	LANDED_DST,
	MEMBER_IDS,
	MOVED_IDS,
	SRC,
	moveSectionStub,
	preWalk,
	row,
	sectionTree,
	type Tree,
} from "./moveSectionStub.js";

/** Wire subType → heading level for the fixture vocabulary; everything
 * else walks as a paragraph. */
const HEADINGS: Record<string, string> = {
	d1: "h1",
	B: "h2",
	H: "h2",
	SH: "h1",
	H2: "h3",
	Z: "h2",
	E: "h2",
	E2: "h3",
	R: "h2",
	Q: "h3",
	D: "h3",
	C: "h2",
	C1: "h1",
	TOP: "h1",
	T: "h2",
	s0: "h1",
	E3: "h3",
	L4: "h4",
	DH: "h3",
	EH: "h2",
};

/** A tree seed from an id list, headings per the vocabulary above. */
const rows = (rootId: string, ids: string[]): Tree => ({
	[rootId]: ids.map((id) =>
		row(id, HEADINGS[id] === undefined ? "p" : "h", HEADINGS[id] ?? ""),
	),
});

/** The child list `rows` seeds under `rootId`, for composing container
 * fixtures inline. */
const rowList = (rootId: string, ids: string[]): Record<string, unknown>[] =>
	rows(rootId, ids)[rootId]!;

/** A quote container row, for the container fixtures. */
const quote = { id: "q", type: "b", subType: "", content: "q" };

/** The source doc after the move landed: the run gone, the rest intact. */
const emptiedSrc = (): Tree => rows(SRC, ["s0", "T", "t1"]);

// ------------------------------------------------------------- plan inputs

interface PlanOpts {
	blockId?: string;
	toHeadingId?: string;
	/** The doc-end form — no destination heading at all. */
	noDestHeading?: boolean;
	/** The claimed source root — the provenance comparison's input. */
	rootId?: string;
	destRootId?: string;
	sourceTruncated?: boolean;
	destTruncated?: boolean;
	/** Same-doc: one tree serves both walks (the entry's single-fetch
	 * contract — the same object under both names). */
	sameDocId?: string;
}

async function planArgs(tree: Tree, opts: PlanOpts = {}) {
	const rootId = opts.sameDocId ?? opts.rootId ?? SRC;
	const destRootId = opts.sameDocId ?? opts.destRootId ?? DST;
	const sourceWalk = await preWalk(tree, opts.sameDocId ?? SRC);
	const destWalk = await preWalk(tree, opts.sameDocId ?? DST);
	return {
		blockId: opts.blockId ?? "H",
		toHeadingId: opts.noDestHeading ? undefined : (opts.toHeadingId ?? "B"),
		rootId,
		destRootId,
		sourceWalk: opts.sourceTruncated
			? { ...sourceWalk, truncated: true, incomplete: true }
			: sourceWalk,
		destWalk: opts.destTruncated
			? { ...destWalk, truncated: true, incomplete: true }
			: destWalk,
	};
}

/** The phase wrapper's arm, unwrapped for assertions (refused → refusal,
 * unverified → outcome, judged → verdict). The phase itself is structural
 * — the union guarantees it — so the assertions stay on the arm shapes. */
function armOf(outcome: MoveSectionOutcome) {
	switch (outcome.kind) {
		case "refused":
			return outcome.refusal;
		case "unverified":
			return outcome.outcome;
		case "judged":
			return outcome.verdict;
	}
}

describe("planMoveSection — the group refusals", () => {
	it("refuses a truncated source walk before any judgment", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { sourceTruncated: true }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "source",
			refusal: { kind: "walk-truncated" },
		});
	});

	it("refuses a blockId that names no heading of the source walk", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { blockId: "nope" }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "source",
			refusal: { kind: "heading-absent", headingId: "nope" },
		});
	});

	it("refuses a source walk that is not rootId's tree — the tripwire", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { rootId: "d-other" }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "source",
			refusal: { kind: "foreign", blockId: "H", rootId: SRC },
		});
	});

	it("refuses a toHeadingId that names no heading of the destination walk", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { toHeadingId: "nope" }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "destination",
			refusal: { kind: "heading-absent", headingId: "nope" },
		});
	});

	it("refuses a truncated destination walk — the closure bound needs complete evidence", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { destTruncated: true }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "destination",
			refusal: { kind: "walk-truncated" },
		});
	});

	it("refuses a destination walk that is not destRootId's tree — the plan's fail-closed tripwire", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { destRootId: "d-other" }),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "destination",
			refusal: { kind: "foreign", blockId: "B", rootId: DST },
		});
	});

	it("refuses the doc-end form on a destination walk that is not destRootId's tree — the doc-end tripwire", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), {
				noDestHeading: true,
				destRootId: "d-other",
			}),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "destination",
			refusal: { kind: "foreign", blockId: "d-other", rootId: DST },
		});
	});

	it("refuses the doc-end form on a truncated destination walk — the chain anchor needs complete evidence", async () => {
		// The defined form's truncation refusal rides `sectionOf`; the
		// doc-end form has no destination heading to gate through, so the
		// walk's own completeness is the gate — without it an empty span
		// would reach the anchor tripwire as a throw.
		const outcome = planMoveSection(
			await planArgs(sectionTree(), {
				noDestHeading: true,
				destTruncated: true,
			}),
		);
		expect(outcome).toEqual({
			kind: "walk-refused",
			role: "destination",
			refusal: { kind: "walk-truncated" },
		});
	});

	it("refuses the identity form — toHeadingId names the moved heading itself", async () => {
		const outcome = planMoveSection(
			await planArgs(sectionTree(), { toHeadingId: "H" }),
		);
		expect(outcome).toEqual({
			kind: "own-closure",
			blockId: "H",
			toHeadingId: "H",
		});
	});

	it("refuses a destination heading nested inside the moved closure, judged over the closure rather than the sibling-id set", async () => {
		// The destination heading Q is nested inside a quote that is a moved
		// member — transported with the move, invisible to members ∪ {H}.
		const tree: Tree = {
			sd: [
				row("s0", "h", "h1"),
				row("H", "h", "h2"),
				row("m1"),
				quote,
				row("m3"),
				row("T", "h", "h2"),
				row("t1"),
			],
			q: [row("Q", "h", "h3"), row("q1")],
		};
		const outcome = planMoveSection(
			await planArgs(tree, { sameDocId: "sd", toHeadingId: "Q" }),
		);
		expect(outcome).toEqual({
			kind: "own-closure",
			blockId: "H",
			toHeadingId: "Q",
		});
	});

	it("refuses a moved heading strictly shallower than the destination boundary", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(SRC, ["SH", "m1", "m2"]),
		};
		const outcome = planMoveSection(await planArgs(tree, { blockId: "SH" }));
		expect(outcome).toEqual({
			kind: "shallower-than-boundary",
			blockId: "SH",
			boundaryId: "Z",
			headingLevel: 1,
			boundaryLevel: 2,
		});
	});

	it("does not refuse shallower on the chain arm — the container end swallows nothing", async () => {
		const tree: Tree = {
			...rows(SRC, ["SH", "m1", "m2"]),
			...rows(DST, ["d1", "B", "b1"]),
		};
		const outcome = planMoveSection(await planArgs(tree, { blockId: "SH" }));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("chain");
	});

	it("refuses already-at-destination when the boundary is the moved heading itself", async () => {
		// `## B / b1 / ## H / m1 / ## Z`: moving H's section onto the end of
		// B's section makes H — the moved heading — the destination's
		// boundary; the member legs would anchor on blocks that travel with
		// the batch.
		const tree = rows("sd", ["B", "b1", "H", "m1", "Z", "z1"]);
		const outcome = planMoveSection(await planArgs(tree, { sameDocId: "sd" }));
		expect(outcome).toEqual({
			kind: "already-at-destination",
			blockId: "H",
			derivation: "boundary-in-set",
			destination: "section",
		});
	});

	it("refuses already-at-destination when the moved section is the destination's trailing run", async () => {
		// `## B / b1 / ### D / d1 / ## C / c1`: D's section already occupies
		// the end of B's section — the boundary C is outside the moved set,
		// so only the trailing-run derivation catches it.
		const tree = rows("sd", ["B", "b1", "D", "d1", "C", "c1"]);
		const outcome = planMoveSection(
			await planArgs(tree, { sameDocId: "sd", blockId: "D" }),
		);
		expect(outcome).toEqual({
			kind: "already-at-destination",
			blockId: "D",
			derivation: "trailing-run",
			destination: "section",
		});
	});

	it("refuses the memberless degenerate when the heading is already the destination section's last member", async () => {
		// D is memberless and deeper than B; it already sits as B's last
		// member, immediately before the boundary.
		const tree = rows("sd", ["B", "b1", "D", "C", "c1"]);
		const outcome = planMoveSection(
			await planArgs(tree, { sameDocId: "sd", blockId: "D" }),
		);
		expect(outcome).toEqual({
			kind: "already-at-destination",
			blockId: "D",
			derivation: "trailing-run",
			destination: "section",
		});
	});

	it("refuses the doc-end form when the moved section already occupies the document's end", async () => {
		const tree = rows("sd", ["B", "b1", "H", "m1"]);
		const outcome = planMoveSection(
			await planArgs(tree, { sameDocId: "sd", noDestHeading: true }),
		);
		expect(outcome).toEqual({
			kind: "already-at-destination",
			blockId: "H",
			derivation: "trailing-run",
			destination: "doc-end",
		});
	});

	it("proceeds for a destination nested in a container inside the destination section — closure is not membership", async () => {
		// Q sits in the closure of B's section but is a legitimate
		// destination: the run moves out of the quote to B's section end.
		const tree: Tree = {
			sd: [
				row("B", "h", "h2"),
				row("b1"),
				quote,
				row("C", "h", "h2"),
				row("c1"),
			],
			q: [row("Q", "h", "h3"), row("q1")],
		};
		const outcome = planMoveSection(
			await planArgs(tree, { sameDocId: "sd", blockId: "Q" }),
		);
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("boundary");
		expect(outcome.plan.memberIds).toEqual(["q1"]);
	});
});

describe("planMoveSection — the codec", () => {
	it("derives the boundary arm: members in document order onto the boundary, heading before the first member", async () => {
		const outcome = planMoveSection(await planArgs(sectionTree()));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("boundary");
		expect(outcome.plan.anchorId).toBe("Z");
		expect(outcome.plan.memberIds).toEqual(MEMBER_IDS);
		expect(outcome.plan.ops).toEqual([
			...MEMBER_IDS.map((id) => ({ action: "move", id, nextID: "Z" })),
			{ action: "move", id: "H", nextID: "m1" },
		]);
	});

	it("derives the memberless boundary arm: the heading leg alone, onto the boundary", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(SRC, ["s0", "H", "T", "t1"]),
		};
		const outcome = planMoveSection(await planArgs(tree));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.ops).toEqual([
			{ action: "move", id: "H", nextID: "Z" },
		]);
	});

	it("derives the chain arm: members chained on previousID from the section's last member, heading on nextID", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(DST, ["d1", "B", "b1"]),
		};
		const outcome = planMoveSection(await planArgs(tree));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("chain");
		expect(outcome.plan.anchorId).toBe("b1");
		expect(outcome.plan.ops).toEqual([
			{ action: "move", id: "m1", previousID: "b1" },
			{ action: "move", id: "m2", previousID: "m1" },
			{ action: "move", id: "H2", previousID: "m2" },
			{ action: "move", id: "sub1", previousID: "H2" },
			{ action: "move", id: "m3", previousID: "sub1" },
			{ action: "move", id: "H", nextID: "m1" },
		]);
	});

	it("derives the doc-end form: the chain anchored on the destination doc's last root-level block", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(DST, ["d1", "E", "e1"]),
		};
		const outcome = planMoveSection(
			await planArgs(tree, { noDestHeading: true }),
		);
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("chain");
		expect(outcome.plan.anchorId).toBe("e1");
		expect(outcome.plan.anchoring).toEqual({
			arm: "chain",
			anchorAt: "doc-end",
		});
		expect(outcome.plan.ops[0]).toEqual({
			action: "move",
			id: "m1",
			previousID: "e1",
		});
		expect(outcome.plan.ops.at(-1)).toEqual({
			action: "move",
			id: "H",
			nextID: "m1",
		});
	});

	it("recurses the chain anchor into an empty-section tail heading", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(DST, ["d1", "E", "e1", "E2"]),
		};
		const outcome = planMoveSection(await planArgs(tree, { toHeadingId: "E" }));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("chain");
		expect(outcome.plan.anchorId).toBe("E2");
	});

	it("derives the empty-destination fixed point: the anchor is the destination heading itself", async () => {
		const tree: Tree = {
			...sectionTree(),
			...rows(DST, ["d1", "B"]),
		};
		const outcome = planMoveSection(await planArgs(tree));
		if (outcome.kind !== "planned") throw new Error("expected planned");
		expect(outcome.plan.anchoring.arm).toBe("chain");
		expect(outcome.plan.anchorId).toBe("B");
		expect(outcome.plan.ops[0]).toEqual({
			action: "move",
			id: "m1",
			previousID: "B",
		});
	});

	it("derives the memberless chain arms: a single heading leg on previousID", async () => {
		const emptyDest: Tree = {
			...rows(SRC, ["s0", "H", "T", "t1"]),
			...rows(DST, ["d1", "B"]),
		};
		const empty = planMoveSection(await planArgs(emptyDest));
		if (empty.kind !== "planned") throw new Error("expected planned");
		expect(empty.plan.ops).toEqual([
			{ action: "move", id: "H", previousID: "B" },
		]);
		const docEnd: Tree = {
			...rows(SRC, ["s0", "H", "T", "t1"]),
			...rows(DST, ["d1", "E", "e1"]),
		};
		const atEnd = planMoveSection(
			await planArgs(docEnd, { noDestHeading: true }),
		);
		if (atEnd.kind !== "planned") throw new Error("expected planned");
		expect(atEnd.plan.ops).toEqual([
			{ action: "move", id: "H", previousID: "e1" },
		]);
	});
});

// ------------------------------------------------------------ judge inputs

interface JudgeOpts {
	headingId?: string;
	memberIds?: string[];
	anchoring?:
		| { arm: "boundary" }
		| { arm: "chain"; anchorAt: "doc-end" | "section-end" };
	/** The codec's anchor — the plan's `anchorId` (boundary id on the
	 * boundary arm, chain anchor on the chain arm). */
	anchorId?: string;
	/** The pre-move destination walk's seed. */
	preTree?: Tree;
	postSourceTree?: Tree;
	postDestTree?: Tree;
	postSourceIncomplete?: boolean;
	postDestIncomplete?: boolean;
	/** The destination heading the move targeted — the destination
	 * relation's subject; omitted for the doc-end form. */
	toHeadingId?: string;
}

async function judgeArgs(opts: JudgeOpts = {}) {
	const preDestWalk = await preWalk(opts.preTree ?? sectionTree(), DST);
	const postSourceWalk = await preWalk(
		opts.postSourceTree ?? emptiedSrc(),
		SRC,
	);
	const postDestWalk = await preWalk(
		opts.postDestTree ?? rows(DST, LANDED_DST),
		DST,
	);
	return {
		plan: {
			headingId: opts.headingId ?? "H",
			memberIds: opts.memberIds ?? MEMBER_IDS,
			anchoring: opts.anchoring ?? { arm: "boundary" as const },
			anchorId: opts.anchorId ?? "Z",
			// The judge never reads the op array — the transport does.
			ops: [],
		},
		sameDoc: false,
		preDestWalk,
		postSourceWalk: opts.postSourceIncomplete
			? { ...postSourceWalk, truncated: true, incomplete: true }
			: postSourceWalk,
		postDestWalk: opts.postDestIncomplete
			? { ...postDestWalk, truncated: true, incomplete: true }
			: postDestWalk,
		toHeadingId: opts.toHeadingId,
	};
}

/** The same-doc judge input the neighbour-identity cases share: the
 * moved run is D + db1 under the chain arm, and one walk serves the
 * pre-move and post-write roles. */
function sdArgs(opts: { anchorId: string; pre: WalkedTree; post: WalkedTree }) {
	const plan: MoveSectionPlan = {
		headingId: "D",
		memberIds: ["db1"],
		anchoring: { arm: "chain", anchorAt: "section-end" },
		anchorId: opts.anchorId,
		ops: [],
	};
	return {
		plan,
		sameDoc: true,
		preDestWalk: opts.pre,
		postSourceWalk: opts.post,
		postDestWalk: opts.post,
	};
}

describe("judgeMoveSectionLanded — the landed arms", () => {
	it("certifies the sibling landing: exact member equality, the pre boundary intact, the owner report", async () => {
		const verdict = judgeMoveSectionLanded(await judgeArgs());
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["H", ...MEMBER_IDS],
			headingContent: "content of H",
			// H bounds B's section on landing (a following sibling at B's
			// level) — the enclosing top section d1 claims it.
			owner: { headingId: "d1", level: 1, content: "content of d1" },
		});
	});

	it("certifies the container re-nest locally — the owner is the destination heading inside the container", async () => {
		// The destination section B sits inside a quote; the deeper moved
		// run re-nests into it. The doc-level heading d1's closure spans
		// the quote, but the owner is the quote-local B.
		const preTree: Tree = {
			[DST]: [row("d1", "h", "h1"), quote],
			q: rowList("q", ["B", "b1", "R", "r1"]),
		};
		const postDest: Tree = {
			[DST]: [row("d1", "h", "h1"), quote],
			q: rowList("q", ["B", "b1", "DH", "dm1", "dm2", "R", "r1"]),
		};
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				headingId: "DH",
				memberIds: ["dm1", "dm2"],
				preTree,
				postDestTree: postDest,
				anchorId: "R",
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["DH", "dm1", "dm2"],
			owner: { headingId: "B", level: 2, content: "content of B" },
		});
	});

	it("names a drag-at-front block as an unjudged presence inside the span", async () => {
		// A block appended to the source section after enumeration, dragged
		// by a folded leg, lands between the heading and the first member.
		const postDest = rows(DST, [
			"d1",
			"B",
			"b1",
			"H",
			"ap",
			...MEMBER_IDS,
			"Z",
			"z1",
		]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ postDestTree: postDest }),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 3,
			unjudgedIds: ["ap"],
			stillInSourceIds: [],
		});
	});

	it("names a chain-arm concurrent-append swallow as an unjudged presence in the tail", async () => {
		// The append landed after the chain anchor ahead of the run's
		// insertion point; the run swallowed it into the moved section's
		// tail.
		const postDest = rows(DST, ["d1", "B", "b1", "H", ...MEMBER_IDS, "ap"]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				anchoring: { arm: "chain", anchorAt: "section-end" },
				anchorId: "b1",
				preTree: rows(DST, ["d1", "B", "b1"]),
				postDestTree: postDest,
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 3,
			unjudgedIds: ["ap"],
			stillInSourceIds: [],
		});
	});

	it("tolerates a chain-arm tail heading as a benign extension, named in the verdict", async () => {
		// A concurrent append heading now bounds the landed run — the
		// pre-move boundary was null, so nothing of the pre-move account
		// sits there.
		const postDest = rows(DST, ["d1", "B", "b1", "H", ...MEMBER_IDS, "EH"]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				anchoring: { arm: "chain", anchorAt: "section-end" },
				anchorId: "b1",
				preTree: rows(DST, ["d1", "B", "b1"]),
				postDestTree: postDest,
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["H", ...MEMBER_IDS],
			owner: { headingId: "d1", level: 1, content: "content of d1" },
			tailExtensionId: "EH",
		});
	});

	it("tolerates a boundary-arm concurrent append that landed ahead of the run", async () => {
		// The member legs anchor at the boundary, so the append sits before
		// the run: still end-of-section, the predicate passes.
		const postDest = rows(DST, [
			"d1",
			"B",
			"b1",
			"ap",
			"H",
			...MEMBER_IDS,
			"Z",
			"z1",
		]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ postDestTree: postDest }),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["H", ...MEMBER_IDS],
			owner: { headingId: "d1", level: 1, content: "content of d1" },
		});
	});

	it("reports the cross-doc copy case — the run landed while a member is still visible in the source", async () => {
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				postSourceTree: rows(SRC, ["s0", "m2", "T", "t1"]),
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 3,
			unjudgedIds: [],
			stillInSourceIds: ["m2"],
		});
	});

	it("reports a boundary-arm divergence when the pre boundary changed", async () => {
		// The run landed intact and exact, but a different heading now
		// bounds the landing position — the destination section's tail was
		// concurrently mutated between the walk and the batch.
		const postDest = rows(DST, [
			"d1",
			"B",
			"b1",
			"H",
			...MEMBER_IDS,
			"E",
			"e1",
		]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ postDestTree: postDest }),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 3,
			unjudgedIds: [],
			stillInSourceIds: [],
		});
	});

	it("reports a null position when the run is absent from the complete destination walk", async () => {
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				postDestTree: rows(DST, ["d1", "B", "b1", "Z", "z1"]),
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: null,
			unjudgedIds: [],
			stillInSourceIds: [],
		});
	});
});

describe("judgeMoveSectionLanded — nothing-moved and truncation, in the fixed order", () => {
	it("fires nothing-moved cross-doc — the run intact in the source, the head absent from the destination", async () => {
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				postSourceTree: sectionTree(),
				postDestTree: rows(DST, ["d1", "B", "b1", "Z", "z1"]),
			}),
		);
		expect(verdict).toMatchObject({ kind: "nothing-moved" });
	});

	it("a cross-doc full copy is never nothing-moved — the head present in the destination vetoes the rollback arm", async () => {
		// The batch copied instead of moved: the whole run still sits in the
		// source AND the run landed in the destination. The rollback
		// recovery's re-issue would duplicate the section, so the head's
		// destination presence (a positive fact, sound on any walk) vetoes
		// `nothing-moved` and the copy reads as divergent.
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ postSourceTree: sectionTree() }),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			stillInSourceIds: ["H", ...MEMBER_IDS],
		});
	});

	it("nothing-moved outranks truncation — source presence is sound on an incomplete walk", async () => {
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				postSourceTree: sectionTree(),
				postSourceIncomplete: true,
				postDestTree: rows(DST, ["d1", "B", "b1", "Z", "z1"]),
			}),
		);
		expect(verdict).toMatchObject({ kind: "nothing-moved" });
	});

	it("truncation outranks the cross-doc nothing-moved leg — head absence is unsound on an incomplete destination walk", async () => {
		// The source walk is complete and the run head is absent from the
		// destination walk, but that walk is truncated: past MAX_WALK_DEPTH
		// the head may sit below the cut, so reading absence as a rollback
		// would let the consumer's re-issue duplicate the section.
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				// Intact source: the source-presence half holds, so the leg
				// is genuinely reached and only the completeness gate saves it.
				postSourceTree: sectionTree(),
				postDestTree: rows(DST, ["d1", "B", "b1", "Z", "z1"]),
				postDestIncomplete: true,
			}),
		);
		expect(verdict).toMatchObject({ kind: "post-walk-truncated" });
	});

	it("fires nothing-moved same-doc on sibling-run neighbour identity", async () => {
		// A no-op rollback leaves the layout untouched: b1 still precedes D
		// among siblings, d1 still follows in enumerated order.
		const tree = rows("sd", ["B", "b1", "D", "db1", "T", "t1"]);
		const walk = await preWalk(tree, "sd");
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "b1", pre: walk, post: walk }),
		);
		expect(verdict).toMatchObject({ kind: "nothing-moved" });
	});

	it("the neighbour identity is sibling-shaped, not index-shaped — an earlier insertion does not break it", async () => {
		// A concurrent insertion before the run's predecessor shifts array
		// indices but not the predecessor's sibling identity: the no-op
		// still reads.
		const pre = await preWalk(
			rows("sd", ["B", "b1", "D", "db1", "T", "t1"]),
			"sd",
		);
		const post = await preWalk(
			rows("sd", ["X", "B", "b1", "D", "db1", "T", "t1"]),
			"sd",
		);
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "b1", pre, post }),
		);
		expect(verdict).toMatchObject({ kind: "nothing-moved" });
	});

	it("a real same-doc landing breaks the neighbour identity and lands", async () => {
		const pre = await preWalk(
			rows("sd", ["B", "b1", "D", "db1", "T", "t1"]),
			"sd",
		);
		const post = await preWalk(
			rows("sd", ["B", "b1", "T", "t1", "D", "db1"]),
			"sd",
		);
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "t1", pre, post }),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["D", "db1"],
			owner: { headingId: "T", level: 2, content: "content of T" },
		});
	});

	it("a same-doc nested landing judged exact when the run overlaps pre-move destination membership", async () => {
		// The moved section (D, inside B's section) lands at the end of the
		// destination section it already sits in: one walk serves both roles,
		// and the landed run matches the enumerated set exactly.
		const pre = await preWalk(
			rows("sd", ["B", "b1", "D", "db1", "E", "e1"]),
			"sd",
		);
		const post = await preWalk(
			rows("sd", ["B", "b1", "E", "e1", "D", "db1"]),
			"sd",
		);
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "e1", pre, post }),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["D", "db1"],
			// D (h3) landed after E's run: E's closure claims it — the deeper
			// nesting the landed predicate certifies.
			owner: { headingId: "E", level: 2, content: "content of E" },
		});
	});

	it("refuses a chain-arm rollback a concurrent insert disguises — the run head must sit after the chain anchor", async () => {
		// The batch rolled back (the layout is the pre-move one) and a
		// concurrent insert landed immediately before the run head: the
		// neighbour-identity nothing-moved leg fails, and without the anchor
		// comparison the unchanged pre-move section would read `landed`.
		const pre = await preWalk(
			rows("sd", ["B", "b1", "D", "db1", "T", "t1"]),
			"sd",
		);
		const post = await preWalk(
			rows("sd", ["B", "b1", "X", "D", "db1", "T", "t1"]),
			"sd",
		);
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "t1", pre, post }),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 3,
			unjudgedIds: [],
			stillInSourceIds: [],
		});
	});

	it("the chain-arm interval admits a concurrent insert between the anchor and the run head (the fold redirect's displacement)", async () => {
		// The anchor was derived on a stale walk (the empty-section heading
		// anchor); the kernel's fold redirect lands the run past a block
		// appended after the anchor — the only sibling between anchor and
		// head is the concurrent insert, so the landing certifies.
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				headingId: "D",
				memberIds: ["db1"],
				anchoring: { arm: "chain", anchorAt: "section-end" },
				anchorId: "E",
				preTree: rows(DST, ["E"]),
				postDestTree: rows(DST, ["E", "ap", "D", "db1"]),
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			landedIds: ["D", "db1"],
			// D (h3) landed inside E's section (h2) — E's closure claims it.
			owner: { headingId: "E", level: 2, content: "content of E" },
		});
	});

	it("refuses the chain arm when a pre-move block sits between the anchor and the run head", async () => {
		// The run head sits behind blocks the pre-move walk already held —
		// not concurrent inserts: no landing can be certified there.
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				headingId: "D",
				memberIds: ["db1"],
				anchoring: { arm: "chain", anchorAt: "section-end" },
				anchorId: "b1",
				preTree: rows(DST, ["B", "b1", "E", "e1"]),
				postDestTree: rows(DST, ["B", "b1", "E", "e1", "D", "db1"]),
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed-divergent",
			landedAtIndex: 4,
			unjudgedIds: [],
			stillInSourceIds: [],
		});
	});

	it("a truncated post-write walk grounds neither landing nor absence", async () => {
		const source = judgeMoveSectionLanded(
			await judgeArgs({ postSourceIncomplete: true }),
		);
		expect(source).toMatchObject({ kind: "post-walk-truncated" });
		const dest = judgeMoveSectionLanded(
			await judgeArgs({ postDestIncomplete: true }),
		);
		expect(dest).toMatchObject({ kind: "post-walk-truncated" });
	});

	it("a truncated same-doc walk refuses after the neighbour check fails", async () => {
		const pre = await preWalk(
			rows("sd", ["B", "b1", "D", "db1", "T", "t1"]),
			"sd",
		);
		const post = {
			...(await preWalk(
				rows("sd", ["B", "b1", "X", "D", "db1", "T", "t1"]),
				"sd",
			)),
			truncated: true,
			incomplete: true,
		};
		const verdict = judgeMoveSectionLanded(
			sdArgs({ anchorId: "b1", pre, post }),
		);
		expect(verdict).toMatchObject({ kind: "post-walk-truncated" });
	});
});

describe("judgeMoveSectionLanded — the destination relation", () => {
	// The level comparison alone, on both anchoring arms: the boundary
	// arm's guard is only movedLevel < boundaryLevel, so all three
	// relations are reachable through it too.
	it("judges nested on the boundary arm — a deeper move reads the destination level off the post-write walk", async () => {
		// The container re-nest fixture: DH (h3) moved onto B (h2) inside
		// the quote — one level deeper, so the landing sits inside the
		// destination section.
		const preTree: Tree = {
			[DST]: [row("d1", "h", "h1"), quote],
			q: rowList("q", ["B", "b1", "R", "r1"]),
		};
		const postDest: Tree = {
			[DST]: [row("d1", "h", "h1"), quote],
			q: rowList("q", ["B", "b1", "DH", "dm1", "dm2", "R", "r1"]),
		};
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({
				headingId: "DH",
				memberIds: ["dm1", "dm2"],
				preTree,
				postDestTree: postDest,
				anchorId: "R",
				toHeadingId: "B",
			}),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			destination: { relation: "nested", movedLevel: 3, destinationLevel: 2 },
		});
	});

	it("judges sibling-after on the boundary arm — the same-level landing is a capability, never a refusal", async () => {
		// H (h2) moved onto B (h2): the same-level members can't sit inside
		// a same-level section, so the landing is a sibling section after
		// the destination's.
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ toHeadingId: "B" }),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			destination: {
				relation: "sibling-after",
				movedLevel: 2,
				destinationLevel: 2,
			},
		});
	});

	// The level comparison across both anchoring arms: the moved # heading
	// is not strictly shallower than the destination's boundary, so the
	// landing terminates the destination section at TOP's own level —
	// after the boundary (C1, h1) or after the section's last member (the
	// doc-end chain anchor).
	const CHAIN_ANCHORING = { arm: "chain", anchorAt: "section-end" } as const;
	it.each([
		{
			name: "on the boundary arm — a # move onto a ## destination whose section closes at a #",
			preTree: rows(DST, ["d1", "B", "b1", "C1", "c1"]),
			postDest: rows(DST, ["d1", "B", "b1", "TOP", "m1", "C1", "c1"]),
			anchoring: undefined,
			anchorId: "C1",
		},
		{
			name: "on the chain arm — the container end swallows nothing",
			preTree: rows(DST, ["d1", "B", "b1"]),
			postDest: rows(DST, ["d1", "B", "b1", "TOP", "m1"]),
			anchoring: CHAIN_ANCHORING,
			anchorId: "b1",
		},
	])(
		"judges shallower-after $name",
		async ({ preTree, postDest, anchoring, anchorId }) => {
			const verdict = judgeMoveSectionLanded(
				await judgeArgs({
					headingId: "TOP",
					memberIds: ["m1"],
					...(anchoring ? { anchoring } : {}),
					preTree,
					postDestTree: postDest,
					anchorId,
					toHeadingId: "B",
				}),
			);
			expect(verdict).toMatchObject({
				kind: "landed",
				destination: {
					relation: "shallower-after",
					movedLevel: 1,
					destinationLevel: 2,
				},
			});
		},
	);

	it("judges destination-gone when the destination heading is absent from the complete post-write walk — named, never silent, never a refusal", async () => {
		// A concurrent delete of the destination heading leaves both landed
		// clauses satisfiable while the level relation goes unjudgeable.
		const postDest = rows(DST, ["d1", "b1", "H", ...MEMBER_IDS, "Z", "z1"]);
		const verdict = judgeMoveSectionLanded(
			await judgeArgs({ postDestTree: postDest, toHeadingId: "B" }),
		);
		expect(verdict).toMatchObject({
			kind: "landed",
			destination: { relation: "destination-gone" },
		});
		// destinationLevel's absence on this arm is the union's own
		// invariant — compile-checked, no runtime assert needed.
	});

	it("carries no relation on the doc-end form — no destination heading, no sentence", async () => {
		const verdict = judgeMoveSectionLanded(await judgeArgs());
		if (verdict.kind !== "landed") throw new Error("expected landed");
		expect(verdict.destination).toBeUndefined();
	});
});

// ------------------------------------------------------- sequence wiring

async function sequenceInput(tree: Tree) {
	return {
		blockId: "H",
		rootId: SRC,
		destRootId: DST,
		sourceWalk: await preWalk(tree, SRC),
		preDestWalk: await preWalk(tree, DST),
		toHeadingId: "B",
	};
}

describe("moveSectionVerified — the batched sequence", () => {
	it("refuses pre-mutation with zero kernel calls", async () => {
		// The shallower refusal: judged on the held walks, the client never
		// touched.
		const tree: Tree = {
			...sectionTree(),
			...rows(SRC, ["SH", "m1", "m2"]),
		};
		const { client, calls } = moveSectionStub({ tree });
		const outcome = await moveSectionVerified(
			client,
			await sequenceInput(tree).then((input) => ({
				...input,
				blockId: "SH",
			})),
		);
		expect(outcome.kind).toBe("refused");
		expect(armOf(outcome)).toEqual({
			kind: "shallower-than-boundary",
			blockId: "SH",
			boundaryId: "Z",
			headingLevel: 1,
			boundaryLevel: 2,
		});
		expect(calls).toEqual([]);
	});

	it("issues ONE transaction of the codec's ops, both touched docs walked", async () => {
		const { client, issued, calls } = moveSectionStub({ tree: sectionTree() });
		const outcome = await moveSectionVerified(
			client,
			await sequenceInput(sectionTree()),
		);
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(1);
		expect(issued).toEqual([
			...MEMBER_IDS.map((id) => ({ action: "move", id, nextID: "Z" })),
			{ action: "move", id: "H", nextID: "m1" },
		]);
		const arm = armOf(outcome);
		if (arm.kind !== "landed") throw new Error("expected landed");
		expect(arm.anchor).toEqual({ kind: "insert", nextID: "Z" });
		expect(arm.landedIds).toEqual(["H", ...MEMBER_IDS]);
		expect(arm.headingContent).toBe("content of H");
		expect(arm.owner).toEqual({
			headingId: "d1",
			level: 1,
			content: "content of d1",
		});
		expect(arm.tailExtensionId).toBeUndefined();
		expect(arm.destination).toEqual({
			relation: "sibling-after",
			movedLevel: 2,
			destinationLevel: 2,
		});
		expect(arm.postSourceWalk.rootId).toBe(SRC);
		expect(arm.postDestWalk.rootId).toBe(DST);
		expect(arm.postDestWalk.blocks.map((b) => b.id)).toEqual(LANDED_DST);
	});

	it("same-doc walks one doc and one walk serves both roles", async () => {
		const tree = rows(SRC, ["s0", "H", "m1", "m2", "T", "t1"]);
		const { client } = moveSectionStub({ tree });
		const sourceWalk = await preWalk(tree, SRC);
		const outcome = await moveSectionVerified(client, {
			blockId: "H",
			rootId: SRC,
			destRootId: SRC,
			sourceWalk,
			preDestWalk: sourceWalk,
			toHeadingId: "T",
		});
		const arm = armOf(outcome);
		if (arm.kind !== "landed") throw new Error("expected landed");
		expect(arm.anchor).toEqual({
			kind: "move",
			previousID: "t1",
			at: "section-end",
		});
		expect(arm.owner).toEqual({
			headingId: "s0",
			level: 1,
			content: "content of s0",
		});
		expect(arm.postSourceWalk).toBe(arm.postDestWalk);
		expect(arm.postDestWalk.blocks.map((b) => b.id)).toEqual([
			"s0",
			"T",
			"t1",
			"H",
			"m1",
			"m2",
		]);
	});

	it("a silent whole-batch rollback reads nothing-moved, walks riding the verdict", async () => {
		const { client } = moveSectionStub({
			tree: sectionTree(),
			rollback: true,
		});
		const outcome = await moveSectionVerified(
			client,
			await sequenceInput(sectionTree()),
		);
		const arm = armOf(outcome);
		if (arm.kind !== "nothing-moved") throw new Error("expected nothing-moved");
		expect(arm.judgedBlockIds).toEqual(MOVED_IDS);
		expect(arm.postSourceWalk.rootId).toBe(SRC);
		expect(arm.postDestWalk.rootId).toBe(DST);
	});

	it("a post-write walk failure carries the judged set only", async () => {
		const walkErr = new Error("walk dropped");
		const tail = moveSectionStub({
			tree: sectionTree(),
			walkErrorFor: (rootId) => (rootId === DST ? walkErr : undefined),
		});
		const tailOutcome = await moveSectionVerified(
			tail.client,
			await sequenceInput(sectionTree()),
		);
		expect(tailOutcome.kind).toBe("unverified");
		expect(armOf(tailOutcome)).toEqual({
			kind: "walk-failed",
			error: walkErr,
			judgedBlockIds: MOVED_IDS,
		});
		const head = moveSectionStub({
			tree: sectionTree(),
			walkErrorFor: (rootId) => (rootId === SRC ? walkErr : undefined),
		});
		const headOutcome = await moveSectionVerified(
			head.client,
			await sequenceInput(sectionTree()),
		);
		expect(armOf(headOutcome)).toEqual({
			kind: "walk-failed",
			error: walkErr,
			judgedBlockIds: MOVED_IDS,
		});
	});

	it("a truncated post-write destination walk refuses before any landing claim", async () => {
		const tree = sectionTree();
		// The pre-mutation walks are taken off the clean tree first; the
		// chain exists only by the time the post-write walk runs.
		const input = await sequenceInput(tree);
		deepChain(tree, DST);
		const { client } = moveSectionStub({ tree });
		const outcome = await moveSectionVerified(client, input);
		const arm = armOf(outcome);
		expect(arm.kind).toBe("post-walk-truncated");
		if (arm.kind !== "post-walk-truncated") return;
		expect(arm.judgedBlockIds).toEqual(MOVED_IDS);
		expect(arm.postSourceWalk.rootId).toBe(SRC);
		expect(arm.postDestWalk.incomplete).toBe(true);
	});
});
