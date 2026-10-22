// Unit cases for the shared section-delete core — the phase split's own
// semantics: `sectionDeletePlan`'s four-cell flag derivation (judged set ×
// issued set, heading included or not), the refusals it passes through
// untouched, and the heading-excluded fresh guard; `sectionDeleteApply`'s walk
// partition over the single post-write walk (judged / nothing-deleted /
// members-survived / post-walk-truncated), the empty-issued-set
// short-circuit (no transaction, fresh walk, judged), and the raw
// `mutation-failed` arm. The stub tree's kernel-mutation semantics live
// on sectionStub.ts; the composing sequences' own semantics stay with
// their suites (deleteSection.test.ts / replace.test.ts).

import { describe, expect, it } from "vitest";
import {
	sectionDeleteApply,
	sectionDeletePlan,
	type SectionDeletePlan,
} from "../sectionDeleteCore.js";
import { deepChain } from "./readStub.js";
import {
	DELETE_SET,
	baseTree,
	input,
	JUDGED_SET,
	preWalk,
	row,
	sectionStub,
	stakeLookup,
	type Tree,
} from "./sectionStub.js";

describe("sectionDeletePlan", () => {
	it("includeHeading:true — judged set is heading first then the closure; issued ops are members then the heading", async () => {
		const { client, calls } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await sectionDeletePlan(client, {
			...input,
			walk,
			includeHeading: true,
			baselineFor: stakeLookup(walk),
		});
		expect(outcome.kind).toBe("plan");
		if (outcome.kind !== "plan") return;
		expect(outcome.judgedBlocks.map((b) => b.blockId)).toEqual(JUDGED_SET);
		expect(outcome.ops).toEqual(
			DELETE_SET.map((id) => ({ action: "delete", id })),
		);
		expect(outcome.rootId).toBe("d-doc");
		expect(outcome.heading).toEqual({
			blockId: "h1",
			content: "content of h1",
		});
		// The plan derives, never mutates: zero kernel calls but the fresh
		// judgment's (all targets served — no seed read either).
		expect(calls).toEqual([]);
		// The section rides the plan — the same derivation the guard
		// judged, so a consumer's projection cannot drift.
		expect(outcome.section.heading.id).toBe("h1");
		expect(outcome.section.members.map((b) => b.id)).toEqual([
			"p1",
			"sub-h",
			"sub-p",
			"call-1",
		]);
	});

	it("includeHeading:false — both derivations exclude the heading, but the plan arm still carries it", async () => {
		const { client } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await sectionDeletePlan(client, {
			...input,
			walk,
			includeHeading: false,
			baselineFor: stakeLookup(walk),
		});
		expect(outcome.kind).toBe("plan");
		if (outcome.kind !== "plan") return;
		// Judged set: the closure only — call-child is cascade-covered and
		// still part of the stake; the heading is NOT judged.
		expect(outcome.judgedBlocks.map((b) => b.blockId)).toEqual([
			"p1",
			"sub-h",
			"sub-p",
			"call-1",
			"call-child",
		]);
		// Issued set: members only, in document order — no heading op.
		expect(outcome.ops.map((op) => op.id)).toEqual([
			"p1",
			"sub-h",
			"sub-p",
			"call-1",
		]);
		// The heading itself is still on the plan arm — replace-section's
		// receipt content and anchor projection read it from here.
		expect(outcome.heading.blockId).toBe("h1");
		expect(outcome.section.heading.id).toBe("h1");
	});

	it("the heading-excluded fresh guard: a stale heading does not refuse the replace-side plan", async () => {
		// The replace flow's target heading survives the sequence, so it
		// has no stake — `includeHeading: false` must not judge it. The
		// same stale baseline refuses under `includeHeading: true` (the
		// delete-side plan judges the heading).
		const walk = await preWalk();
		const staleHeading = (id: string) =>
			id === "h1"
				? { kind: "served" as const, hash: "older than the tree" }
				: stakeLookup(walk)(id);
		// Each plan runs against its own stub — the walk is held, so the
		// fresh judgment never re-reads the tree.
		const replacePlan = await sectionDeletePlan(
			sectionStub({ tree: baseTree() }).client,
			{
				...input,
				walk,
				includeHeading: false,
				baselineFor: staleHeading,
			},
		);
		expect(replacePlan.kind).toBe("plan");
		const deletePlanOutcome = await sectionDeletePlan(
			sectionStub({ tree: baseTree() }).client,
			{ ...input, walk, includeHeading: true, baselineFor: staleHeading },
		);
		expect(deletePlanOutcome.kind).toBe("fresh-refused");
		if (deletePlanOutcome.kind !== "fresh-refused") return;
		expect(deletePlanOutcome.stale.map((a) => a.blockId)).toEqual(["h1"]);
	});

	it("a stale closure member refuses the plan — judged order rides the refusal", async () => {
		const { client, calls } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await sectionDeletePlan(client, {
			...input,
			walk,
			includeHeading: false,
			baselineFor: (id) =>
				id === "p1"
					? { kind: "served", hash: "older than the tree" }
					: stakeLookup(walk)(id),
		});
		expect(calls).toEqual([]);
		expect(outcome.kind).toBe("fresh-refused");
		if (outcome.kind !== "fresh-refused") return;
		expect(outcome.walk).toBe(walk);
		expect(outcome.stale.map((a) => a.blockId)).toEqual(["p1"]);
	});

	it("refuses an incomplete walk before any kernel call — the derivation's bound needs complete evidence", async () => {
		const { client, calls } = sectionStub({ tree: baseTree() });
		const outcome = await sectionDeletePlan(client, {
			...input,
			walk: { ...(await preWalk()), truncated: true, incomplete: true },
			includeHeading: true,
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome).toEqual({ kind: "walk-truncated" });
		expect(calls).toEqual([]);
	});

	it("refuses a headingId that names no heading of the walk", async () => {
		const { client, calls } = sectionStub({ tree: baseTree() });
		const outcome = await sectionDeletePlan(client, {
			...input,
			headingId: "nope",
			walk: await preWalk(),
			includeHeading: true,
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome).toEqual({ kind: "heading-absent", headingId: "nope" });
		expect(calls).toEqual([]);
	});

	it("refuses a walk that is not rootId's tree — the caller-provenance gate, zero kernel calls", async () => {
		const { client, calls } = sectionStub({ tree: baseTree() });
		const outcome = await sectionDeletePlan(client, {
			...input,
			rootId: "d-other",
			walk: await preWalk(),
			includeHeading: true,
			baselineFor: () => ({ kind: "never-served" }),
		});
		expect(outcome).toEqual({
			kind: "foreign",
			blockId: "h1",
			rootId: "d-doc",
		});
		expect(calls).toEqual([]);
	});

	it("the empty-closure cell: a section-less heading under includeHeading:false plans zero ops over an empty judged set", async () => {
		const { client } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await sectionDeletePlan(client, {
			...input,
			headingId: "h2",
			walk,
			includeHeading: false,
			baselineFor: stakeLookup(walk),
		});
		expect(outcome.kind).toBe("plan");
		if (outcome.kind !== "plan") return;
		expect(outcome.judgedBlocks).toEqual([]);
		expect(outcome.ops).toEqual([]);
	});
});

describe("sectionDeleteApply", () => {
	/** The plan an apply case consumes: derived over the fixture walk with
	 * every walk-present id served from its own content, `includeHeading`
	 * per the caller (default true). Throws on a refusal — the apply cases
	 * never exercise one. */
	async function planned(
		opts: { tree?: Tree; headingId?: string; includeHeading?: boolean } = {},
	): Promise<SectionDeletePlan> {
		const tree = opts.tree ?? baseTree();
		const walk = await preWalk(tree);
		const plan = await sectionDeletePlan(sectionStub({ tree }).client, {
			...input,
			walk,
			includeHeading: opts.includeHeading ?? true,
			baselineFor: stakeLookup(walk),
			...(opts.headingId === undefined ? {} : { headingId: opts.headingId }),
		});
		if (plan.kind !== "plan") throw new Error(`plan refused: ${plan.kind}`);
		return plan;
	}

	it("judged: every issued id absent from the post-write walk — the judged set rides the verdict", async () => {
		const plan = await planned();
		const { client, batched } = sectionStub({ tree: baseTree() });
		const outcome = await sectionDeleteApply(client, plan);
		expect(batched).toEqual(DELETE_SET);
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		const ids = outcome.postWalk.blocks.map((b) => b.id);
		// The whole judged set is gone — call-child with it (the cascade
		// fact); the survivors are the surrounding headings.
		expect(ids).toEqual(["h0", "h2"]);
		expect(outcome.judgedBlocks.map((b) => b.blockId)).toEqual(JUDGED_SET);
	});

	it("members-survived: a silently skipped id commits the rest — survivors in issued order, presence sound on any walk", async () => {
		const plan = await planned();
		const { client, batched } = sectionStub({
			tree: baseTree(),
			prune: (id) => id !== "sub-p",
		});
		const outcome = await sectionDeleteApply(client, plan);
		expect(batched).toEqual(DELETE_SET);
		expect(outcome).toEqual({
			kind: "members-survived",
			survivedIds: ["sub-p"],
			postWalk: expect.anything(),
			judgedBlockIds: JUDGED_SET,
		});
	});

	it("nothing-deleted: every issued id still present — the all-or-nothing arm, guarded on the op count", async () => {
		const plan = await planned();
		const { client } = sectionStub({ tree: baseTree(), prune: () => false });
		const outcome = await sectionDeleteApply(client, plan);
		expect(outcome).toEqual({
			kind: "nothing-deleted",
			postWalk: expect.anything(),
			judgedBlockIds: JUDGED_SET,
		});
	});

	it("post-walk-truncated: every issued id absent, the walk incomplete — absence unconfirmed", async () => {
		const tree = baseTree();
		deepChain(tree, "d-doc");
		const plan = await planned();
		const { client, batched } = sectionStub({ tree });
		const outcome = await sectionDeleteApply(client, plan);
		expect(batched).toEqual(DELETE_SET);
		expect(outcome).toEqual({
			kind: "post-walk-truncated",
			judgedBlockIds: JUDGED_SET,
			postWalk: expect.anything(),
		});
		if (outcome.kind !== "post-walk-truncated") return;
		expect(outcome.postWalk.incomplete).toBe(true);
	});

	it("presence outranks truncation — a fully-skipped batch reads nothing-deleted even on an incomplete walk", async () => {
		const tree = baseTree();
		deepChain(tree, "d-doc");
		const plan = await planned();
		const { client } = sectionStub({ tree, prune: () => false });
		const outcome = await sectionDeleteApply(client, plan);
		expect(outcome.kind).toBe("nothing-deleted");
	});

	it("walk-failed: the batch acked but the post-write walk threw — the judged set rides the arm", async () => {
		const walkError = new Error("kernel unreachable mid-verify");
		const plan = await planned();
		const { client, batched } = sectionStub({
			tree: baseTree(),
			walkError,
		});
		const outcome = await sectionDeleteApply(client, plan);
		expect(batched).toEqual(DELETE_SET);
		expect(outcome).toEqual({
			kind: "walk-failed",
			error: walkError,
			judgedBlockIds: JUDGED_SET,
		});
	});

	it("mutation-failed: the transaction threw — the RAW error instance rides the arm with the judged set", async () => {
		// Phase-neutral by design: the core catches the throw into a value
		// and hands the instance over — classification is the consumer's,
		// at its own phase posture (`catchMutation` rethrows auth/429 raw,
		// so classifying here would drop exactly those errors).
		const transactError = new Error("boom mid-batch");
		const plan = await planned();
		const { client, batched } = sectionStub({
			tree: baseTree(),
			transactError,
		});
		const outcome = await sectionDeleteApply(client, plan);
		expect(batched).toEqual([]);
		expect(outcome).toEqual({
			kind: "mutation-failed",
			error: transactError,
			judgedBlockIds: JUDGED_SET,
		});
	});

	it("the empty-issued-set short-circuit: no transaction is sent; `judged` rides the fresh walk, not the plan walk", async () => {
		// A section-less heading under includeHeading:false — the
		// replace-section path the short-circuit serves. The route is
		// never sent an empty op list, and the walk is taken fresh (the
		// plan walk predates the sequence's insert, so returning it would
		// misread the replacement as absent).
		const plan = await planned({ headingId: "h2", includeHeading: false });
		const { client, calls } = sectionStub({ tree: baseTree() });
		const outcome = await sectionDeleteApply(client, plan);
		expect(calls.filter((c) => c.method === "transact")).toEqual([]);
		// The fresh walk is real evidence: the heading the plan derived
		// (h2) is present in it, and the judged set is trivially absent.
		expect(outcome).toEqual({
			kind: "judged",
			postWalk: expect.anything(),
			judgedBlocks: [],
		});
		if (outcome.kind !== "judged") return;
		expect(outcome.postWalk.blocks.map((b) => b.id)).toContain("h2");
	});

	it("walk-failed on the empty-issued-set path: the fresh walk threw, the judged set is the empty set", async () => {
		const walkError = new Error("kernel unreachable mid-verify");
		const plan = await planned({ headingId: "h2", includeHeading: false });
		const { client } = sectionStub({ tree: baseTree(), walkError });
		const outcome = await sectionDeleteApply(client, plan);
		expect(outcome).toEqual({
			kind: "walk-failed",
			error: walkError,
			judgedBlockIds: [],
		});
	});

	it("the batch rides the ≥32 bulk path with no pre-mutation ceiling — one transaction, the whole issued set", async () => {
		const tree: Tree = {
			"d-doc": [row("h0", "h", "h1"), row("h1", "h", "h2")],
		};
		for (let i = 0; i < 32; i++) tree["d-doc"]!.push(row(`m-${i}`));
		const plan = await planned({ tree });
		const { client, batched } = sectionStub({ tree });
		const outcome = await sectionDeleteApply(client, plan);
		// 32 members + the heading, members first, heading last — issued
		// whole, never split at the cliff.
		expect(batched).toHaveLength(33);
		expect(batched[0]).toBe("m-0");
		expect(batched[32]).toBe("h1");
		expect(outcome.kind).toBe("judged");
	});
});
