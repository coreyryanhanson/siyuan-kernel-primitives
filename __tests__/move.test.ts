// Unit cases for the verified moves: the landed judgment, both block- and
// doc-move flows, and the two-route move's row-type dispatch entry
// (`moveVerified`) over the stubbed kernel.
import { describe, expect, it } from "vitest";
import { SiYuanApiError, SiYuanNetworkError } from "siyuan-kernel-api";
import type { WalkedBlock, WalkedTree } from "../walk.js";
import { withVerifyWindow } from "../convergence.js";
import {
	moveBlockCore,
	moveDocVerified,
	moveVerified,
	verifyMoveLanded,
} from "../move.js";
import { type MoveAnchor } from "../placement.js";
import { deepChain } from "./readStub.js";
import { okProbe, stubClient } from "./writeStub.js";
import {
	DST,
	SRC,
	moveSectionStub,
	preWalk,
	row,
	sectionTree,
	type Tree,
} from "./moveSectionStub.js";

/** Flat pre-order walk rows; parentType mirrors parentId ("d" at root). */
function walkBlock(
	id: string,
	parentId: string | null,
	type = "p",
): WalkedBlock {
	return {
		id,
		type,
		subType: "",
		content: id,
		markdown: id,
		parentId,
		parentType: parentId === null ? "d" : "p",
	};
}

describe("verifyMoveLanded", () => {
	const moveAfterP1: MoveAnchor = {
		kind: "move",
		previousID: "p1",
		at: "section-end",
	};

	it("reports landed cross-doc when the block reached the destination and left the source", () => {
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("a", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: [walkBlock("x", null), walkBlock("m", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "landed" });
	});
	it("reports absent-from-destination when the block is in neither post-move walk", () => {
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("a", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: [walkBlock("x", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "absent-from-destination" });
	});
	it("reports absent-from-destination even when the block is still in the source — the destination miss is the reportable fact", () => {
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("m", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: [walkBlock("x", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "absent-from-destination" });
	});
	it("reports still-in-source when a cross-doc move copied rather than moved", () => {
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("a", null), walkBlock("m", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: [walkBlock("m", null), walkBlock("x", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "still-in-source" });
	});
	it("reports landed same-doc when the block sits at the anchor's landing position", () => {
		// Landing position = the entry after p1's subtree (p1 is a leaf).
		const walk = [
			walkBlock("h1", null, "h"),
			walkBlock("p1", "h1"),
			walkBlock("m", null),
			walkBlock("tail", null),
		];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: moveAfterP1,
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "landed" });
	});
	it("reports landing-unconfirmed when the destination walk is truncated", () => {
		// Absence from a truncated walk is unconfirmed — a landed move may
		// hide past the bound.
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("a", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: [walkBlock("x", null)],
					rootId: "d",
					truncated: true,
					incomplete: true,
				},
			}),
		).toEqual({ kind: "landing-unconfirmed" });
	});
	it("reports landing-unconfirmed cross-doc when the source walk cannot confirm the departure", () => {
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("a", null)],
					rootId: "d",
					truncated: true,
					incomplete: true,
				},
				postDestWalk: {
					blocks: [walkBlock("m", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "landing-unconfirmed" });
	});
	it("still reports still-in-source from a truncated source walk when the copy is visible", () => {
		// Presence in the source is sound even on a truncated walk.
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: false,
				postSourceWalk: {
					blocks: [walkBlock("m", null)],
					rootId: "d",
					truncated: true,
					incomplete: true,
				},
				postDestWalk: {
					blocks: [walkBlock("m", null)],
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "still-in-source" });
	});
	it("reports misplaced same-doc when the block is present but not at its landing position", () => {
		const walk = [
			walkBlock("m", null),
			walkBlock("p1", null),
			walkBlock("tail", null),
		];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: moveAfterP1,
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "misplaced", append: false });
	});
	it("reports misplaced same-doc with append:true for a doc-end append that did not land last", () => {
		const walk = [walkBlock("m", null), walkBlock("other", null)];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "misplaced", append: true });
	});
	it("reports landed same-doc for an append that landed as the last top-level block", () => {
		const walk = [walkBlock("other", null), walkBlock("m", null)];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "append" },
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "landed" });
	});
	it("falls back to membership when the same-doc anchor vanished (concurrent delete) — no false failure", () => {
		const walk = [walkBlock("a", null), walkBlock("m", null)];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: { kind: "move", previousID: "gone", at: "section-end" },
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "landed" });
	});
	it("reports absent-from-destination when the same-doc block itself vanished", () => {
		const walk = [walkBlock("a", null)];
		expect(
			verifyMoveLanded({
				blockId: "m",
				anchor: moveAfterP1,
				sameDoc: true,
				postSourceWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
				postDestWalk: {
					blocks: walk,
					rootId: "d",
					truncated: false,
					incomplete: false,
				},
			}),
		).toEqual({ kind: "absent-from-destination" });
	});
});
describe("moveBlockCore — the per-id route's core", () => {
	/** Post-move tree for doc root "d"; the stub walks one level ("h" and
	 * "p" do not nest in the walk's container set). */
	const tree = (...ids: string[]): Record<string, unknown>[] =>
		ids.map((id) => ({ id, type: id.startsWith("h") ? "h" : "p" }));
	const moveAfterP1: MoveAnchor = {
		kind: "move",
		previousID: "p1",
		at: "section-end",
	};
	/** Pre-move walk literal — the caller-held walk the placement refusals
	 * judge (all blocks root-level, in walk order). */
	const flatWalk = (...ids: string[]): WalkedTree => ({
		blocks: ids.map((id) => ({
			id,
			type: id.startsWith("h") ? "h" : "p",
			subType: "",
			content: id,
			markdown: id,
			parentId: null,
			parentType: "d",
		})),
		rootId: "d",
		truncated: false,
		incomplete: false,
	});

	it("refuses walk-truncated same-doc before any kernel call", async () => {
		const { client, calls } = stubClient();
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: { ...flatWalk("m"), truncated: true, incomplete: true },
			preDestWalk: { ...flatWalk("m"), truncated: true, incomplete: true },
		});
		expect(outcome).toEqual({ kind: "walk-truncated" });
		expect(calls).toEqual([]);
	});

	it("refuses same-doc already-at-destination before any kernel call", async () => {
		const { client, calls } = stubClient();
		// Occupied landing: m already sits where the anchor would place it —
		// the kernel no-ops behind HTTP success and the walk-set judgment
		// would misreport a landed move.
		const occupied = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("h1", "p1", "m", "tail"),
			preDestWalk: flatWalk("h1", "p1", "m", "tail"),
		});
		// Self-anchor variant: the anchor block is the moved block itself.
		const self = await moveBlockCore(client, {
			blockId: "m",
			anchor: { kind: "move", previousID: "m", at: "section-end" },
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("h1", "m", "p1"),
			preDestWalk: flatWalk("h1", "m", "p1"),
		});
		expect(occupied).toEqual({ kind: "already-at-destination", blockId: "m" });
		expect(self).toEqual({ kind: "already-at-destination", blockId: "m" });
		// Zero kernel calls: the refusal precedes mutation and verification.
		expect(calls).toEqual([]);
	});

	it("refuses same-doc own-subtree anchors before any kernel call", async () => {
		const { client, calls } = stubClient();
		// k sits inside m's subtree — the kernel skips that anchor class
		// (the same TxErrCodeSkipTx no-op as the self-anchor), so the
		// refusal fires before the walk-set judgment reads it as misplaced.
		const preDestWalk: WalkedTree = {
			blocks: [
				{
					id: "m",
					type: "p",
					subType: "",
					content: "m",
					markdown: "m",
					parentId: null,
					parentType: "d",
				},
				{
					id: "k",
					type: "p",
					subType: "",
					content: "k",
					markdown: "k",
					parentId: "m",
					parentType: "p",
				},
			],
			rootId: "d",
			truncated: false,
			incomplete: false,
		};
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: { kind: "move", previousID: "k", at: "section-end" },
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: preDestWalk,
			preDestWalk,
		});
		expect(outcome).toEqual({ kind: "own-subtree", blockId: "m" });
		expect(calls).toEqual([]);
	});

	it("refuses a foreign blockId same-doc — membership rides the caller-held preDestWalk, before any kernel call", async () => {
		const { client, calls } = stubClient();
		// b-foreign is not in the source walk: the scoping judgment the edit
		// and delete flows ride via blockInDoc, keyed on the same raw-id
		// kernel fact, judged here on the walk the move is about to change.
		const outcome = await moveBlockCore(client, {
			blockId: "b-foreign",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toEqual({ kind: "not-in-source", blockId: "b-foreign" });
		expect(calls).toEqual([]);
	});

	it("lets a non-heading member of a heading's section move per-id", async () => {
		// tail is a member of h1's section in the pre-move walk — a member
		// moves per-id; only a section-bearing HEADING is out of the per-id
		// route's scope (the dispatch routes every heading to the section
		// sequence). The stub serves the post-move shape (tail directly after
		// p1 — the move applied); the pre-move walk is the caller-held
		// literal. The pin is the kind and the verdict; the walk is not
		// separately asserted.
		const { client } = stubClient({
			getChildBlocks: (id) => (id === "d" ? tree("h1", "m", "p1", "tail") : []),
		});
		const outcome = await moveBlockCore(client, {
			blockId: "tail",
			anchor: { kind: "move", previousID: "p1", at: "section-end" },
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("h1", "p1", "m", "tail"),
			preDestWalk: flatWalk("h1", "p1", "m", "tail"),
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: { kind: "landed" },
		});
	});

	it("refuses a cross-doc foreign blockId — the entry's own source-walk fetch, before any mutation or post-walk", async () => {
		const { client, calls } = stubClient({
			// The destination walk is populated; the source walk is empty —
			// an unchecked foreign id would mutate and read as landed.
			getChildBlocks: (id) => (id === "d-dest" ? tree("x") : []),
		});
		const outcome = await moveVerified(client, okProbe, {
			blockId: "b-foreign",
			rootId: "d-src",
			destRootId: "d-dest",
			preDestWalk: { ...flatWalk("x"), rootId: "d-dest" },
		});
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: { kind: "not-in-source", blockId: "b-foreign" },
		});
		// The refusal precedes mutation and verification: exactly one kernel
		// call, the source walk the entry fetches.
		expect(calls).toEqual([{ method: "getChildBlocks", args: "d-src" }]);
	});

	it("refuses walk-truncated cross-doc before any mutation — the primitive's own source walk names the bound", async () => {
		// The only pre-mutation refusal fetched by the primitive itself: the
		// source walk it runs for the cross-doc scoping judgment hits the
		// depth bound, whose absences are unconfirmed — the scoping refusal
		// must not read off incomplete evidence. Deepest chain the stub can
		// build: c32's child call enters at depth MAX_WALK_DEPTH + 1. The
		// subject is the deep HEADING itself: with no row the dispatch cannot
		// route it to the section sequence, so this refusal is the fold-blind
		// rule's second half — a section-bearing target that slips past the
		// dispatch must stop here, before any moveBlock.
		const routes: Record<string, Record<string, unknown>[]> = {};
		deepChain(routes, "d-src", {
			id: "leaf",
			type: "h",
			subType: "h1",
			content: "deep",
		});
		const { client, calls } = stubClient({
			getChildBlocks: (id) => routes[id] ?? [],
		});
		const outcome = await moveVerified(client, okProbe, {
			blockId: "leaf",
			rootId: "d-src",
			destRootId: "d-dest",
			preDestWalk: { ...flatWalk("x"), rootId: "d-dest" },
		});
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: { kind: "walk-truncated" },
		});
		// The truncation refusal precedes scoping and mutation: the calls are
		// the source walk's own recursion — no moveBlock fired.
		expect(calls.some((c) => c.method === "moveBlock")).toBe(false);
		expect(calls.every((c) => c.method === "getChildBlocks")).toBe(true);
	});

	it("reports landed same-doc through the core — the block sits at the anchor's landing position", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: (id) => (id === "d" ? tree("h1", "p1", "m", "tail") : []),
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			anchor: moveAfterP1,
			verdict: { kind: "landed" },
		});
		// The verdict carries its evidence — the exact post-move tree.
		expect(
			outcome.kind === "judged"
				? outcome.postSourceWalk.blocks.map((b) => b.id)
				: [],
		).toEqual(["h1", "p1", "m", "tail"]);
		// Same-doc: one walk, shared by both arms of the judgment.
		expect(calls.filter((c) => c.method === "getChildBlocks").length).toBe(1);
		// The mutation rode the anchor: previousID, never the parentID branch.
		expect(calls.find((c) => c.method === "moveBlock")?.args).toEqual({
			id: "m",
			previousID: "p1",
		});
	});

	it("routes the empty-destination append anchor through moveBlock's parentID branch — the pinned placement", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: (id) => (id === "d" ? tree("m") : []),
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: { kind: "append" },
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			anchor: { kind: "append" },
			verdict: { kind: "landed" },
		});
		expect(
			outcome.kind === "judged"
				? outcome.postSourceWalk.blocks.map((b) => b.id)
				: [],
		).toEqual(["m"]);
		expect(calls.find((c) => c.method === "moveBlock")?.args).toEqual({
			id: "m",
			parentID: "d",
		});
	});

	it("judges a silent rollback as misplaced, carrying both post-move walks", async () => {
		const { client } = stubClient({
			getChildBlocks: (id) => (id === "d" ? tree("m", "p1", "tail") : []),
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			anchor: moveAfterP1,
			verdict: { kind: "misplaced", append: false },
		});
		expect(
			outcome.kind === "judged"
				? outcome.postSourceWalk.blocks.map((b) => b.id)
				: [],
		).toEqual(["m", "p1", "tail"]);
	});

	it("walks both docs cross-doc and reports still-in-source for a copy, not a move", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: (id) =>
				id === "d-src" ? tree("a", "m") : id === "d-dest" ? tree("m", "x") : [],
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: { kind: "append" },
			sameDoc: false,
			rootId: "d-src",
			destRootId: "d-dest",
			sourceWalk: { ...flatWalk("a", "m"), rootId: "d-src" },
			preDestWalk: { ...flatWalk("x"), rootId: "d-dest" },
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			anchor: { kind: "append" },
			verdict: { kind: "still-in-source" },
		});
		expect(
			outcome.kind === "judged"
				? outcome.postSourceWalk.blocks.map((b) => b.id)
				: [],
		).toEqual(["a", "m"]);
		expect(
			outcome.kind === "judged"
				? outcome.postDestWalk.blocks.map((b) => b.id)
				: [],
		).toEqual(["m", "x"]);
		expect(calls.filter((c) => c.method === "getChildBlocks").length).toBe(2);
		// Two walks: both post-move reads — the source walk arrives handed in
		// (the entry's single fetch; the core never re-fetches it).
	});

	it("classifies a synchronous kernel rejection verbatim", async () => {
		const { client, calls } = stubClient({
			moveError: new SiYuanApiError(500, -1, "Cannot move to this location"),
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toEqual({
			kind: "kernel-refused",
			anchor: moveAfterP1,
			message:
				"SiYuan API error (HTTP 500, code -1: Cannot move to this location)",
		});
		// A refusal fires no post-move verification reads.
		expect(calls.some((c) => c.method === "getChildBlocks")).toBe(false);
	});

	it("reports verification-failed when a post-move walk read itself fails", async () => {
		const { client } = stubClient({
			getChildBlocks: () => {
				throw new SiYuanNetworkError();
			},
		});
		const outcome = await moveBlockCore(client, {
			blockId: "m",
			anchor: moveAfterP1,
			sameDoc: true,
			rootId: "d",
			destRootId: "d",
			sourceWalk: flatWalk("m", "p1", "tail"),
			preDestWalk: flatWalk("m", "p1", "tail"),
		});
		expect(outcome).toEqual({
			kind: "verification-failed",
			anchor: moveAfterP1,
			cause: { kind: "transport" },
			detail: "SiYuan kernel unreachable",
		});
	});
});

describe("moveDocVerified", () => {
	/** The stored row the scoping read resolves — rootEcho's shape. */
	const echoRow = {
		id: "kid",
		root_id: "kid",
		content: "Mv Kid",
		hpath: "/Mv Kid",
	};
	const docInput = {
		boxId: "box",
	};

	it("refuses not-in-source when the scoping read names no row — before any mutation", async () => {
		const { client, calls } = stubClient();
		// The scoping read polls the convergence window (create-parity); the
		// refusal path pays the poll, so the suite collapses it.
		const outcome = await withVerifyWindow([0], () =>
			moveDocVerified(client, okProbe, {
				...docInput,
				docId: "ghost",
				destRootId: "dest",
			}),
		);
		expect(outcome).toEqual({ kind: "not-in-source", docId: "ghost" });
		expect(calls.some((c) => c.method === "moveDocsByID")).toBe(false);
	});

	it("polls the scoping read instead of refusing a lag-fresh doc — the row lands inside the window", async () => {
		// A doc minted moments ago (kb_read serves doc ids from the live
		// walk) has no blocks row yet on the first attempt; the window must
		// absorb the lag, not refuse it.
		let attempts = 0;
		const { client, calls } = stubClient({
			query: () => {
				attempts++;
				return attempts < 3 ? [] : [echoRow];
			},
			getHPathByID: (id) => (id === "dest" ? "/Dest" : "/Dest/Mv Kid"),
		});
		const outcome = await withVerifyWindow([0, 0], () =>
			moveDocVerified(client, okProbe, {
				...docInput,
				docId: "kid",
				destRootId: "dest",
			}),
		);
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landed", hpath: "/Dest/Mv Kid" },
		});
		expect(calls.some((c) => c.method === "moveDocsByID")).toBe(true);
	});

	it("judges landed under a doc destination when the live-tree hpath reads dest + '/' + the STORED title", async () => {
		const { client, calls } = stubClient({
			query: () => [echoRow],
			getHPathByID: (id) => (id === "dest" ? "/Dest" : "/Dest/Mv Kid"),
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "kid",
			destRootId: "dest",
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landed", hpath: "/Dest/Mv Kid" },
		});
		expect(calls.find((c) => c.method === "moveDocsByID")?.args).toEqual({
			fromIDs: ["kid"],
			toID: "dest",
		});
	});

	it("judges landed from the stored title alone — a caller-held stale form cannot leak into the judgment", async () => {
		// The judgment composes expected over the stored title and lands.
		const { client } = stubClient({
			query: () => [{ ...echoRow, content: "Mv Kid (normalized)" }],
			getHPathByID: (id) =>
				id === "dest" ? "/Dest" : "/Dest/Mv Kid (normalized)",
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "kid",
			destRootId: "dest",
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landed", hpath: "/Dest/Mv Kid (normalized)" },
		});
	});

	it("judges landed at the notebook root when destRootId is omitted — toID is the box", async () => {
		const { client, calls } = stubClient({
			query: () => [echoRow],
			getHPathByID: (id) => (id === "kid" ? "/Mv Kid" : "/Dest"),
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "kid",
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landed", hpath: "/Mv Kid" },
		});
		// Un-nest: exactly one evidence read (the moved doc), toID = the box.
		expect(calls.find((c) => c.method === "moveDocsByID")?.args).toEqual({
			fromIDs: ["kid"],
			toID: "box",
		});
		expect(calls.filter((c) => c.method === "getHPathByID").length).toBe(1);
	});

	it("judges not-landed when the tree still shows the pre-move hpath behind HTTP success", async () => {
		const { client } = stubClient({
			query: () => [echoRow],
			// The stub ignores the move — both reads keep the pre-move hpath.
			getHPathByID: () => "/Old Place",
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "kid",
			destRootId: "dest",
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "not-landed", hpath: "/Old Place" },
		});
	});

	it("carries a synchronous kernel rejection verbatim — the ancestor-move class", async () => {
		const { client, calls } = stubClient({
			query: () => [echoRow],
			moveDocsError: new SiYuanApiError(
				200,
				-1,
				"Cannot move to this location",
			),
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "dest",
			destRootId: "kid",
		});
		expect(outcome).toEqual({
			kind: "kernel-refused",
			message:
				"SiYuan API error (HTTP 200, code -1: Cannot move to this location)",
		});
		// The verification phase is unreached on a synchronous refusal — it
		// runs no evidence read.
		expect(calls.some((c) => c.method === "getHPathByID")).toBe(false);
	});

	it("reports verification-failed when the hpath evidence read itself fails", async () => {
		const { client } = stubClient({
			query: () => [echoRow],
			getHPathByID: () => {
				throw new SiYuanNetworkError();
			},
		});
		const outcome = await moveDocVerified(client, okProbe, {
			...docInput,
			docId: "kid",
			destRootId: "dest",
		});
		expect(outcome).toEqual({
			kind: "verification-failed",
			cause: { kind: "transport" },
			detail: "SiYuan kernel unreachable",
		});
	});
});

describe("moveVerified", () => {
	/** One doc holding both the moved section and the destination section —
	 * the same-doc dispatch's fixture (one walk serves both roles). */
	const sameDocTree = (): Tree => ({
		d: [
			row("s0", "h", "h1"),
			row("H", "h", "h2"),
			row("m1"),
			row("m2"),
			row("B", "h", "h2"),
			row("b1"),
			row("Z", "h", "h2"),
			row("z1"),
		],
	});
	const ids = (rows: Record<string, unknown>[] | undefined): string[] =>
		(rows ?? []).map((r) => String(r.id));

	it("routes a section-bearing heading to the batched section sequence — the section arm lands end-of-section cross-doc", async () => {
		const tree = sectionTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, DST);
		const outcome = await moveVerified(client, okProbe, {
			blockId: "H",
			rootId: SRC,
			destRootId: DST,
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toMatchObject({
			kind: "section",
			outcome: { kind: "judged", verdict: { kind: "landed" } },
		});
		// The entry's single source fetch: exactly one pre-mutation
		// getChildBlocks, for the source doc — the row type, the moved-set
		// derivation and the group refusals all read that one walk.
		const txIdx = calls.findIndex((c) => c.method === "transact");
		expect(
			calls
				.slice(0, txIdx)
				.filter((c) => c.method === "getChildBlocks")
				.map((c) => c.args),
		).toEqual([SRC]);
	});

	it("routes a memberless heading to the same section route — the degenerate is the batched shape, not the per-id path", async () => {
		const tree = sectionTree();
		tree[SRC] = [row("s0", "h", "h1"), row("H", "h", "h2")];
		const { client, issued } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, DST);
		const outcome = await moveVerified(client, okProbe, {
			blockId: "H",
			rootId: SRC,
			destRootId: DST,
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toMatchObject({
			kind: "section",
			outcome: { kind: "judged", verdict: { kind: "landed" } },
		});
		// The memberless degenerate issues only the heading leg.
		expect(issued).toEqual([{ action: "move", id: "H", nextID: "Z" }]);
	});

	it("routes a non-heading block to the per-id core — judged, with the derived anchor carried on the arm", async () => {
		const tree = sameDocTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, "d");
		const outcome = await moveVerified(client, okProbe, {
			blockId: "m1",
			rootId: "d",
			destRootId: "d",
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toMatchObject({
			kind: "per-id",
			outcome: {
				kind: "judged",
				verdict: { kind: "landed" },
				// The anchor the entry derived off the caller-held walk —
				// B's section-end leaf — carried on the verdict.
				anchor: { kind: "move", previousID: "b1", at: "section-end" },
			},
		});
		expect(ids(tree.d)).toEqual(["s0", "H", "m2", "B", "b1", "m1", "Z", "z1"]);
		// Zero pre-mutation fetches: the dispatch and the derivation both
		// read the caller-held walk; the one getChildBlocks is the post-move
		// walk the judgment runs on.
		expect(calls.filter((c) => c.method === "getChildBlocks")).toHaveLength(1);
	});

	it("refuses a blockId absent from the source walk on the per-id route's scoping arm", async () => {
		const tree = sectionTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, DST);
		const outcome = await moveVerified(client, okProbe, {
			blockId: "ghost",
			rootId: SRC,
			destRootId: DST,
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		// The scoping wording is route-neutral, so the unresolvable id
		// dispatches per-id.
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: { kind: "not-in-source", blockId: "ghost" },
		});
		// One kernel call — the source walk the dispatch read.
		expect(
			calls.filter((c) => c.method === "getChildBlocks").map((c) => c.args),
		).toEqual([SRC]);
	});

	it("routes a heading on a truncated caller-held walk to the section gate's walk-refused arm, zero kernel calls", async () => {
		const tree = sameDocTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = {
			...(await preWalk(tree, "d")),
			truncated: true,
			incomplete: true,
		};
		const outcome = await moveVerified(client, okProbe, {
			blockId: "H",
			rootId: "d",
			destRootId: "d",
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toEqual({
			kind: "section",
			outcome: {
				kind: "refused",
				refusal: {
					kind: "walk-refused",
					role: "source",
					refusal: { kind: "walk-truncated" },
				},
			},
		});
		expect(calls).toEqual([]);
	});

	it("refuses a toHeadingId absent from the destination walk on the per-id route's derivation arm, zero kernel calls", async () => {
		const tree = sameDocTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, "d");
		const outcome = await moveVerified(client, okProbe, {
			blockId: "m1",
			rootId: "d",
			destRootId: "d",
			preDestWalk: destWalk,
			toHeadingId: "ghost",
		});
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: { kind: "heading-absent", headingId: "ghost" },
		});
		expect(calls).toEqual([]);
	});

	it("refuses a truncated caller-held walk on the per-id route's derivation arm, zero kernel calls", async () => {
		const tree = sameDocTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = {
			...(await preWalk(tree, "d")),
			truncated: true,
			incomplete: true,
		};
		const outcome = await moveVerified(client, okProbe, {
			blockId: "m1",
			rootId: "d",
			destRootId: "d",
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: { kind: "walk-truncated" },
		});
		expect(calls).toEqual([]);
	});

	it("carries the issued anchor on the per-id route's failure arms", async () => {
		const tree = sameDocTree();
		const { client } = moveSectionStub({
			tree,
			moveError: new SiYuanApiError(500, -1, "Cannot move to this location"),
		});
		const destWalk = await preWalk(tree, "d");
		const outcome = await moveVerified(client, okProbe, {
			blockId: "m1",
			rootId: "d",
			destRootId: "d",
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toEqual({
			kind: "per-id",
			outcome: {
				kind: "kernel-refused",
				anchor: { kind: "move", previousID: "b1", at: "section-end" },
				message:
					"SiYuan API error (HTTP 500, code -1: Cannot move to this location)",
			},
		});
	});

	it("derives the per-id anchor cross-doc off the caller-held walk — no second source fetch, no destination fetch for the arm", async () => {
		const tree = sectionTree();
		const { client, calls } = moveSectionStub({ tree });
		const destWalk = await preWalk(tree, DST);
		const outcome = await moveVerified(client, okProbe, {
			blockId: "m1",
			rootId: SRC,
			destRootId: DST,
			preDestWalk: destWalk,
			toHeadingId: "B",
		});
		expect(outcome).toMatchObject({
			kind: "per-id",
			outcome: {
				kind: "judged",
				verdict: { kind: "landed" },
				anchor: { kind: "move", previousID: "b1", at: "section-end" },
			},
		});
		// Pre-mutation calls: the entry's single source fetch, nothing else —
		// the anchor arm read the caller-held destination walk.
		const mutateIdx = calls.findIndex((c) => c.method === "moveBlock");
		expect(
			calls
				.slice(0, mutateIdx)
				.filter((c) => c.method === "getChildBlocks")
				.map((c) => c.args),
		).toEqual([SRC]);
		// Post-mutation: both docs' walks.
		expect(
			calls
				.slice(mutateIdx)
				.filter((c) => c.method === "getChildBlocks")
				.map((c) => c.args),
		).toEqual([SRC, DST]);
	});
});
