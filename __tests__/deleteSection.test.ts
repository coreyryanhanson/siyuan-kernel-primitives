// Unit cases for the verified section delete — the wrapper's own
// semantics: the op array's shape (one `delete` op per judged member,
// members in document order, the heading last, never a member's
// descendant), the `judged` receipt's named `heading` field, the
// heading-only set, and delete's missing write-parent rule. The shared
// plan/apply arms (the refusal pair, the provenance refusal, the walk
// partition, the ≥32 bulk path) are pinned on the core's suite
// (`sectionDeleteCore.test.ts`); the mutation-phase classification (a
// `transact` throw → transport-unverified / kernel-refused; auth/429
// rethrow) is pinned in ladder.test.ts with the other flows.
// The stub tree's kernel-mutation semantics live on sectionStub.ts.

import { describe, expect, it } from "vitest";
import { deleteSectionVerified } from "../deleteSection.js";
import { okProbe } from "./writeStub.js";
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

describe("deleteSectionVerified", () => {
	it("accepts a heading inside a non-targetable container — delete has no write-parent rule", async () => {
		// `CheckContainerParent` applies to insert/append, not delete: a
		// heading inside tabs is legally deletable, so the sequence must
		// NOT import the heading-target judgment's `untargetable` arm.
		const tree: Tree = {
			"d-doc": [row("tabs-1", "tabs")],
			"tabs-1": [row("h1", "h", "h2"), row("p1")],
		};
		const { client, batched } = sectionStub({ tree });
		const walk = await preWalk(tree);
		const outcome = await deleteSectionVerified(client, okProbe, {
			...input,
			walk,
			baselineFor: stakeLookup(walk),
		});
		expect(outcome.kind).toBe("judged");
		// The set is container-local: the tab's members plus the heading.
		expect(batched).toEqual(["p1", "h1"]);
	});

	it("issues ONE transaction of delete ops — the whole set, members first, heading last, never a descendant", async () => {
		const { client, batched, calls } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await deleteSectionVerified(client, okProbe, {
			...input,
			walk,
			baselineFor: stakeLookup(walk),
		});
		// The one transaction's op array verbatim: one `delete` op per
		// judged member, in set order, each carrying only its id — the
		// route's payload contract (the kernel fills anchors and undo ops).
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "transact",
			args: [
				{
					doOperations: DELETE_SET.map((id) => ({
						action: "delete",
						id,
					})),
				},
			],
		});
		expect(batched).toEqual(DELETE_SET);
		expect(batched).not.toContain("call-child");
		// The whole set is absent from the post-write walk — the judged arm
		// carries the walk as its evidence; the survivors are the
		// preceding heading and the boundary. The judged set rides the
		// verdict — judged order, heading first, id and observed content
		// each (the consumer's receipt derives from it, never a flow-side
		// re-derivation).
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged" || outcome.verdict.kind !== "judged") return;
		const ids = outcome.verdict.postWalk.blocks.map((b) => b.id);
		expect(ids).toEqual(["h0", "h2"]);
		expect(outcome.verdict.heading).toEqual({
			blockId: "h1",
			content: "content of h1",
		});
		expect(outcome.verdict.judgedBlocks.map((b) => b.blockId)).toEqual(
			JUDGED_SET,
		);
	});

	it("a section-less boundary heading deletes exactly itself — the heading-only set", async () => {
		const { client, batched } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const outcome = await deleteSectionVerified(client, okProbe, {
			...input,
			headingId: "h2",
			walk,
			baselineFor: stakeLookup(walk),
		});
		expect(batched).toEqual(["h2"]);
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		expect(outcome.verdict.postWalk.blocks.map((b) => b.id)).toEqual([
			"h0",
			"h1",
			"p1",
			"sub-h",
			"sub-p",
			"call-1",
			"call-child",
		]);
	});

	it("refuses stale judged content before the transaction — arms in judged order, heading first", async () => {
		// A concurrently-rewritten member diverges from the served hash: the
		// guard refuses pre-mutation with every judged arm carried (the
		// proceeding arms included, in the pinned judged order — heading,
		// then closure in document order), so the consumer words and
		// dispositions without a second read.
		const { client, batched, calls } = sectionStub({ tree: baseTree() });
		const walk = await preWalk();
		const lookup = stakeLookup(walk);
		const outcome = await deleteSectionVerified(client, okProbe, {
			...input,
			walk,
			baselineFor: (id) =>
				id === "p1"
					? { kind: "served", hash: "older than the tree" }
					: lookup(id),
		});
		expect(batched).toEqual([]);
		expect(calls).toEqual([]);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") return;
		const refusal = outcome.refusal;
		if (refusal.kind !== "fresh-refused") return;
		expect(refusal.walk).toBe(walk);
		expect(refusal.arms.map((a) => [a.kind, a.blockId])).toEqual([
			["fresh", "h1"],
			["stale", "p1"],
			["fresh", "sub-h"],
			["fresh", "sub-p"],
			["fresh", "call-1"],
			["fresh", "call-child"],
		]);
	});
});
