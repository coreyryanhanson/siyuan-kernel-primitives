// Unit cases for the replace-section sequence: the insert-before-batch
// ordering pin, the delete-leg wrapper's carriage, and the
// replacement-survival seam, over the stubbed kernel.
import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
} from "siyuan-kernel-api";
import type { Transaction } from "siyuan-kernel-api";
import type { WalkedTree } from "../walk.js";
import {
	replaceSectionVerified,
	replacementSurvivalOf,
	type ReplaceSectionOutcome,
} from "../replace.js";
import { deepChain } from "./readStub.js";
import { stakeLookup } from "./sectionStub.js";
import { okProbe, stubClient } from "./writeStub.js";

/** The phase wrapper's arm, unwrapped for assertions (refused → refusal,
 * unverified → outcome, judged → verdict). The phase itself is structural
 * — the union guarantees it — so the assertions stay on the arm shapes. */
function armOf(outcome: ReplaceSectionOutcome) {
	switch (outcome.kind) {
		case "refused":
			return outcome.refusal;
		case "unverified":
			return outcome.outcome;
		case "judged":
			return outcome.verdict;
	}
}

describe("replaceSectionVerified", () => {
	// Raw tree rows — only id/type/subType/content (the walk assigns
	// parentage). The section of h1: the sibling run p1..p2, bounded by the
	// same-level h2 — the kernel nests heading content at the container
	// level, so the members are forest roots (cascade covers descendants).
	const baseTree = (): Record<string, Record<string, unknown>[]> => ({
		"d-doc": [
			{ id: "h1", type: "h", subType: "h1", content: "Head" },
			{ id: "p1", type: "p", subType: "", content: "one" },
			{ id: "p2", type: "p", subType: "", content: "two" },
			{ id: "h2", type: "h", subType: "h1", content: "Next" },
		],
	});
	const preWalk = (): WalkedTree => ({
		blocks: [
			{
				id: "h1",
				type: "h",
				subType: "h1",
				content: "Head",
				markdown: "Head",
				parentId: null,
				parentType: "d",
			},
			{
				id: "p1",
				type: "p",
				subType: "",
				content: "one",
				markdown: "one",
				parentId: null,
				parentType: "d",
			},
			{
				id: "p2",
				type: "p",
				subType: "",
				content: "two",
				markdown: "two",
				parentId: null,
				parentType: "d",
			},
			{
				id: "h2",
				type: "h",
				subType: "h1",
				content: "Next",
				markdown: "Next",
				parentId: null,
				parentType: "d",
			},
		],
		rootId: "d-doc",
		truncated: false,
		incomplete: false,
	});
	const input = { rootId: "d-doc", headingId: "h1", body: "repl" };

	/** The insert leg's landed replacement: "b-new" between p2 and the
	 * boundary h2 — every delete-leg case needs the sequence to reach the
	 * batch, which only happens once the insert has landed. */
	const insertReplacement =
		(tree: Record<string, Record<string, unknown>[]>) => () => {
			const siblings = tree["d-doc"] ?? [];
			tree["d-doc"] = [
				...siblings.slice(0, 3),
				{ id: "b-new", type: "p", subType: "", content: "repl" },
				...siblings.slice(3),
			];
		};

	/** The batch's landing: every op id prunes its tree row, the way the
	 * kernel's committed batch does. A `keep` set simulates the sub-cliff
	 * silent no-op (the op acks, the block stays). */
	const batchApplies =
		(
			tree: Record<string, Record<string, unknown>[]>,
			keep: ReadonlySet<string> = new Set(),
		) =>
		(transactions: Transaction[]) => {
			for (const tx of transactions) {
				for (const op of tx.doOperations) {
					const id = String(op.id);
					if (keep.has(id)) continue;
					tree["d-doc"] = (tree["d-doc"] ?? []).filter((b) => b.id !== id);
				}
			}
		};

	it("refuses walk-truncated before any kernel call", async () => {
		// Enumeration (sectionOf), the anchor, and the judged set all
		// derive from this walk — incomplete evidence must not bound the
		// delete set or place the insert.
		const { client, calls } = stubClient();
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: { ...preWalk(), truncated: true, incomplete: true },
			// Structural arms precede the guard — the lookup is never consulted.
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome.kind).toBe("refused");
		expect(armOf(outcome)).toEqual({ kind: "walk-truncated" });
		expect(calls).toEqual([]);
	});

	it("refuses a walk that is not rootId's tree — the caller-provenance tripwire, zero kernel calls", async () => {
		// Mirrors `deleteSectionVerified`'s `foreign` arm: the walk carries
		// its own root (`WalkedTree.rootId`), so the mismatch is judged
		// pre-mutation with no kernel call — exact where the blocks index
		// would fail open in a minted doc's convergence window.
		const { client, calls } = stubClient();
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			rootId: "d-other", // the claim: the section lives in d-other
			walk: preWalk(), // d-doc's walk — the mismatch
			// The provenance check precedes the guard — the map is never
			// consulted.
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome.kind).toBe("refused");
		expect(armOf(outcome)).toEqual({
			kind: "foreign",
			blockId: "h1",
			rootId: "d-doc",
		});
		expect(calls).toEqual([]);
	});

	it("refuses a heading id absent from the walk before any kernel call", async () => {
		const { client, calls } = stubClient();
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			headingId: "nope",
			walk: preWalk(),
			// Structural arms precede the guard — the lookup is never consulted.
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome.kind).toBe("refused");
		expect(armOf(outcome)).toEqual({
			kind: "heading-absent",
			headingId: "nope",
		});
		expect(calls).toEqual([]);
	});

	it("inserts before deleting: the ordering pin, then judges replaced", async () => {
		const tree = baseTree();
		const { client, calls } = stubClient({
			getChildBlocks: (id) => tree[id] ?? [],
			// insert before the boundary h2
			onInsert: insertReplacement(tree),
			onTransact: batchApplies(tree),
		});
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: preWalk(),
			baselineFor: stakeLookup(preWalk()),
		});
		// The data-loss-direction pin: the replacement exists before the
		// delete batch fires — and the batch is the whole delete leg (one
		// transaction, no per-member deletes).
		const methods = calls.map((c) => c.method);
		expect(methods.indexOf("insertBlock")).toBeLessThan(
			methods.indexOf("transact"),
		);
		expect(methods.filter((m) => m === "transact")).toHaveLength(1);
		expect(methods.filter((m) => m === "deleteBlock")).toEqual([]);
		// The judgment rides the caller-held walk — the sequence's kernel
		// walks are the insert leg's landing walk plus the batch's
		// post-write verification walk. A regression that re-walked inside
		// the guard — or judged over a fresh kernel walk instead of the
		// supplied one — adds a third call here.
		expect(methods.filter((m) => m === "getChildBlocks")).toHaveLength(2);
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged" || outcome.verdict.kind !== "replaced")
			return;
		expect(outcome.verdict).toEqual({
			kind: "replaced",
			anchor: { kind: "insert", nextID: "h2" },
			insertedId: "b-new",
			headingContent: "Head",
			closure: [
				{ blockId: "p1", content: "one" },
				{ blockId: "p2", content: "two" },
			],
			postWalk: {
				blocks: [
					{
						id: "h1",
						type: "h",
						subType: "h1",
						content: "Head",
						markdown: undefined,
						parentId: null,
						parentType: "d",
					},
					{
						id: "b-new",
						type: "p",
						subType: "",
						content: "repl",
						markdown: undefined,
						parentId: null,
						parentType: "d",
					},
					{
						id: "h2",
						type: "h",
						subType: "h1",
						content: "Next",
						markdown: undefined,
						parentId: null,
						parentType: "d",
					},
				],
				rootId: "d-doc",
				truncated: false,
				incomplete: false,
			},
		});
	});

	it("refuses insert-unlanded without issuing the delete batch — the old section is untouched", async () => {
		const tree = baseTree();
		const { client, calls } = stubClient({
			getChildBlocks: (id) => tree[id] ?? [],
			// The tx acks but the tree never changes — a silent rollback.
		});
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: preWalk(),
			baselineFor: stakeLookup(preWalk()),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		if (outcome.verdict.kind !== "insert-unlanded") return;
		expect(outcome.verdict).toEqual({
			kind: "insert-unlanded",
			verdict: { kind: "absent-from-tree", blockId: "b-new" },
			anchor: { kind: "insert", nextID: "h2" },
		});
		expect(calls.filter((c) => c.method === "transact")).toEqual([]);
	});

	// The batched route renders no mid-sequence state — one transaction
	// either acked or threw — so the delete leg's raw-error failures ride
	// the unverified phase's `delete-leg` stage. These cases pin the
	// sequence's mapping and carriage: the raw error instance rides
	// verbatim (the consumer classifies at its own post-insert posture —
	// auth/429 are RETURNED here, never rethrown like the insert leg
	// above), and the wrapper carries the replacement's identity.
	it("maps every batch failure into the delete-leg arm, raw error preserved", async () => {
		const cases: {
			label: string;
			error: Error;
		}[] = [
			{
				label: "api rejection → mutation-failed, raw instance preserved",
				error: new SiYuanApiError(500, undefined, "locked"),
			},
			{
				label: "transport failure → mutation-failed, raw instance preserved",
				error: new SiYuanNetworkError(),
			},
			{
				label: "auth → mutation-failed, not the insert leg's rethrow",
				error: new SiYuanAuthError(403),
			},
			{
				label: "429 → mutation-failed, not the insert leg's rethrow",
				error: new SiYuanRateLimitError(429, 30),
			},
		];
		for (const { label, error } of cases) {
			const tree = baseTree();
			const { client } = stubClient({
				getChildBlocks: (id) => tree[id] ?? [],
				onInsert: insertReplacement(tree),
				transactError: error,
			});
			const outcome = await replaceSectionVerified(client, okProbe, {
				...input,
				walk: preWalk(),
				baselineFor: stakeLookup(preWalk()),
			});
			// The insert landed — a delete-leg failure never reads as
			// "nothing landed"; the phase discriminant words it unverified.
			expect(outcome.kind, label).toBe("unverified");
			if (outcome.kind !== "unverified") continue;
			if (outcome.outcome.stage !== "delete-leg") continue;
			const leg = outcome.outcome;
			expect(leg.failure.kind, label).toBe("mutation-failed");
			if (leg.failure.kind !== "mutation-failed") continue;
			// Instance identity: the consumer classifies THIS error.
			expect(leg.failure.error, label).toBe(error);
			// The judged set (the closure) rides the raw arm; the wrapper
			// carries the issued set and the replacement's identity. No
			// walk — no survival reading on a walk-less arm.
			expect(leg.failure.judgedBlockIds, label).toEqual(["p1", "p2"]);
			expect(leg.memberIds, label).toEqual(["p1", "p2"]);
			expect(leg.insertedId, label).toBe("b-new");
			expect(leg.anchor, label).toEqual({ kind: "insert", nextID: "h2" });
		}
	});

	it("carries a post-batch walk drop as delete-leg/walk-failed — never a raw throw", async () => {
		const tree = baseTree();
		const walkError = new SiYuanNetworkError();
		let batched = false;
		const { client } = stubClient({
			getChildBlocks: (id) => {
				if (batched) throw walkError;
				return tree[id] ?? [];
			},
			onInsert: insertReplacement(tree),
			onTransact: (transactions) => {
				batchApplies(tree)(transactions);
				// The batch acked — the next walk is the apply's own
				// verification read, after the transaction committed.
				batched = true;
			},
		});
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: preWalk(),
			baselineFor: stakeLookup(preWalk()),
		});
		expect(outcome.kind).toBe("unverified");
		if (outcome.kind !== "unverified") return;
		if (outcome.outcome.stage !== "delete-leg") return;
		const leg = outcome.outcome;
		expect(leg.failure.kind).toBe("walk-failed");
		if (leg.failure.kind !== "walk-failed") return;
		expect(leg.failure.error).toBe(walkError);
		expect(leg.insertedId).toBe("b-new");
		// The judged set rides the walk-failed arm — a committed batch
		// takes the closure with the members.
		expect(leg.failure.judgedBlockIds).toEqual(["p1", "p2"]);
	});

	// The apply's judged arms' payload shapes are canonical in
	// sectionDeleteCore.test.ts — the wrapper's mapping is the pin here:
	// each judged arm rides `delete-leg` verbatim, carries the plan's
	// issued set and the replacement's identity, and the replacement
	// positively survives (no adverse reading on any of these).
	const judgedArmCases: {
		title: string;
		arm: "members-survived" | "post-walk-truncated" | "nothing-deleted";
		routes: (tree: Record<string, Record<string, unknown>[]>) => {
			onTransact: (transactions: Transaction[]) => void;
		};
	}[] = [
		{
			// The sub-cliff silent no-op: one op acks but its block stays.
			title: "members-survived with the plan's issued set",
			arm: "members-survived",
			routes: (tree) => ({
				onTransact: batchApplies(tree, new Set(["p2"])),
			}),
		},
		{
			title: "post-walk-truncated — the batch acked, absence unconfirmed",
			arm: "post-walk-truncated",
			routes: (tree) => {
				deepChain(tree, "d-doc", {
					id: "deep",
					type: "p",
					subType: "",
					content: "past the bound",
				});
				return { onTransact: batchApplies(tree) };
			},
		},
		{
			// The batch acks; nothing lands (the ≥32 bulk path's silent
			// void, or every op silently no-oped below the cliff).
			title:
				"nothing-deleted when the batch rolls back whole behind the success ack",
			arm: "nothing-deleted",
			routes: () => ({ onTransact: () => {} }),
		},
	];
	for (const { title, arm, routes } of judgedArmCases) {
		it(`wraps ${title}`, async () => {
			const tree = baseTree();
			const { client } = stubClient({
				getChildBlocks: (id) => tree[id] ?? [],
				onInsert: insertReplacement(tree),
				...routes(tree),
			});
			const outcome = await replaceSectionVerified(client, okProbe, {
				...input,
				walk: preWalk(),
				baselineFor: stakeLookup(preWalk()),
			});
			expect(outcome.kind, title).toBe("judged");
			if (outcome.kind !== "judged") return;
			if (outcome.verdict.kind !== "delete-leg") return;
			expect(outcome.verdict.outcome.kind, title).toBe(arm);
			// The plan's issued set rides the arm; the wrapper carries the
			// replacement's identity and the positive survival reading.
			expect(outcome.verdict.outcome.judgedBlockIds, title).toEqual([
				"p1",
				"p2",
			]);
			expect(outcome.verdict.memberIds, title).toEqual(["p1", "p2"]);
			expect(outcome.verdict.insertedId, title).toBe("b-new");
			expect(outcome.verdict.anchor, title).toEqual({
				kind: "insert",
				nextID: "h2",
			});
			expect(outcome.verdict.replacementSurvival, title).toBeUndefined();
		});
	}

	it("judges the closure's cascade-covered descendants — the stake is the closure, not the issued members", async () => {
		// The judged set is the closure: a container member's
		// cascade-covered descendant is part of the stake, so a stale
		// descendant refuses the sequence before any mutation.
		const walk = (): WalkedTree => ({
			blocks: [
				{
					id: "h1",
					type: "h",
					subType: "h1",
					content: "Head",
					markdown: "Head",
					parentId: null,
					parentType: "d",
				},
				{
					id: "c1",
					type: "callout",
					subType: "",
					content: "container",
					markdown: "container",
					parentId: null,
					parentType: "d",
				},
				{
					id: "kid",
					type: "p",
					subType: "",
					content: "child",
					markdown: "child",
					parentId: "c1",
					parentType: "callout",
				},
				{
					id: "h2",
					type: "h",
					subType: "h1",
					content: "Next",
					markdown: "Next",
					parentId: null,
					parentType: "d",
				},
			],
			rootId: "d-doc",
			truncated: false,
			incomplete: false,
		});
		const { client, calls } = stubClient();
		const w = walk();
		const lookup = stakeLookup(w);
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: w,
			baselineFor: (id) =>
				id === "kid"
					? { kind: "served", hash: "older than the tree" }
					: lookup(id),
		});
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") return;
		const refusal = outcome.refusal;
		if (refusal.kind !== "fresh-refused") return;
		expect(refusal.arms.map((a) => [a.kind, a.blockId])).toEqual([
			["fresh", "c1"],
			["stale", "kid"],
		]);
		// The refusal rides the caller-held walk — no second read.
		expect(refusal.walk).toBe(w);
		expect(
			calls.filter(
				(c) =>
					c.method === "insertBlock" ||
					c.method === "deleteBlock" ||
					c.method === "transact",
			),
		).toEqual([]);
	});

	it("an empty closure (section-less heading) skips the judgment and the batch — the insert proceeds, the fresh walk certifies", async () => {
		// The legitimate empty set: nothing is judged, so the lookup is
		// never consulted and the judgment runs no reads; the plan issues
		// no ops, the apply skips the transaction, and the fresh walk it
		// takes itself is the replaced arm's evidence.
		const tree = baseTree();
		const { client, calls } = stubClient({
			getChildBlocks: (id) => tree[id] ?? [],
			onInsert: insertReplacement(tree),
		});
		const outcome = await replaceSectionVerified(client, okProbe, {
			...input,
			walk: {
				...preWalk(),
				blocks: preWalk().blocks.filter((b) => b.id !== "p1" && b.id !== "p2"),
			},
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		if (outcome.verdict.kind !== "replaced") return;
		expect(outcome.verdict.closure).toEqual([]);
		expect(calls.filter((c) => c.method === "query")).toEqual([]);
		expect(calls.filter((c) => c.method === "transact")).toEqual([]);
	});
});

describe("replacementSurvivalOf", () => {
	const walk = (incomplete: boolean): WalkedTree => ({
		blocks: [
			{
				id: "h1",
				type: "h",
				subType: "h1",
				content: "Head",
				markdown: "Head",
				parentId: null,
				parentType: "d",
			},
		],
		rootId: "d-doc",
		truncated: incomplete,
		incomplete,
	});

	it("an absent replacement on a complete walk reads cascade-consumed — data loss", () => {
		expect(replacementSurvivalOf(walk(false), "b-new")).toBe(
			"cascade-consumed",
		);
	});

	it("an absent replacement on a truncated walk reads unconfirmed — absence is unsound there", () => {
		expect(replacementSurvivalOf(walk(true), "b-new")).toBe("unconfirmed");
	});

	it("a present replacement reads undefined — positively certified", () => {
		const w = walk(false);
		w.blocks[0]!.id = "b-new";
		expect(replacementSurvivalOf(w, "b-new")).toBeUndefined();
	});
});
