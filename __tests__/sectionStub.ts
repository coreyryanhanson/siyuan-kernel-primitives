// Shared stub and fixtures for the batched section flows' suites:
// deleteSection.test.ts owns the delete sequence's own semantics,
// ladder.test.ts rides the same stub in the shared failure-ladder corpus,
// and moveSectionStub.ts re-exports the fixture builders (`Tree`, `row`)
// for the move suites. The wiring is
// the shared `deleteStub` (writeStub.ts) — the tree mutates exactly like
// the kernel (a successful `transact` prunes every op id from its parent,
// the cascade removes a container member's descendants with it, and a
// `prune: false` op simulates the sub-cliff silent no-op) and the
// pre-mutation walk is derived from the tree by the real `walkBlockTree`
// (preWalk below), so fixture and walk cannot drift apart. The routes are
// `DeleteRoutes` verbatim: one declaration, no drift surface between the
// delete stubs; the SQL surface is covered (the internal fresh-content
// guard's seed read rides the same index rows).
import type { DeleteSectionKernelClient } from "../deleteSection.js";
import { contentHash, type ServedBaseline } from "../fresh.js";
import { walkBlockTree, type WalkedTree } from "../walk.js";
import { deleteStub, type DeleteRoutes } from "./writeStub.js";

export type Tree = Record<string, Record<string, unknown>[]>;

export type SectionRoutes = DeleteRoutes;

export function sectionStub(routes: SectionRoutes): {
	client: DeleteSectionKernelClient;
	batched: string[];
	calls: { method: string; args: unknown }[];
} {
	return deleteStub(routes);
}

export const row = (id: string, type = "p", subType = "") => ({
	id,
	type,
	subType,
	content: `content of ${id}`,
	markdown: `content of ${id}`,
});

/** Doc root "d-doc": a preceding heading, the target h1 whose section
 * holds a paragraph, a deeper sibling heading with its body, and a
 * callout container with a nested child — then the boundary heading.
 * The kernel nests heading content at the container level, so the
 * members are siblings at the root level; the callout's child is a
 * DESCENDANT (cascade-covered, never issued). */
export function baseTree(): Tree {
	return {
		"d-doc": [
			row("h0", "h", "h1"),
			row("h1", "h", "h2"),
			row("p1"),
			row("sub-h", "h", "h3"),
			row("sub-p"),
			row("call-1", "callout"),
			row("h2", "h", "h2"),
		],
		"call-1": [row("call-child")],
	};
}

/** The strict pre-mutation walk over the fixture doc — derived by the
 * real `walkBlockTree` over a throwaway stub seeded from `tree`, so the
 * tree and its walk cannot share a bug (the placement.test.ts
 * convention). The throwaway stub keeps the derivation off the test's
 * own calls record (the walk is taken before the primitive runs). */
export async function preWalk(tree: Tree = baseTree()): Promise<WalkedTree> {
	const { client } = sectionStub({ tree });
	return walkBlockTree(client, "d-doc");
}

// Section members in document order, then the heading — the exact issued
// sequence. call-child is cascade-covered and never appears.
export const DELETE_SET = ["p1", "sub-h", "sub-p", "call-1", "h1"];

// The judged set in judged order — heading first, then the closure in
// document order. call-child is cascade-covered and never issued, but it
// is part of the stake the guard judged and the post-mutation arms carry.
export const JUDGED_SET = [
	"h1",
	"p1",
	"sub-h",
	"sub-p",
	"call-1",
	"call-child",
];

export const input = { rootId: "d-doc", headingId: "h1" };

/** The flow-shaped baseline lookup, minted per the fixture rule: every
 * walk-present id mints `served` from the walk's own content — the guard
 * rides hash comparison and adds no seed read to the wiring pins' read
 * ledgers; ids outside the walk take `never-served`. Total over any id
 * the primitive's internal derivation can name — the same shape the
 * tool layer's session lookup has. */
export function stakeLookup(
	walk: WalkedTree,
): (blockId: string) => ServedBaseline {
	const hashes = new Map(
		walk.blocks.map((b) => [b.id, contentHash(b.content)] as const),
	);
	return (blockId) => {
		const hash = hashes.get(blockId);
		return hash === undefined
			? { kind: "never-served" }
			: { kind: "served", hash };
	};
}
