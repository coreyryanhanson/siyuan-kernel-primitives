// The placement corpus: one canonical fixture set, an independent oracle,
// and the properties that fail when any consumer drifts from the one
// section rule (membership = following siblings in the heading's own
// container, level-bounded; placement = before the boundary, else the
// container's end).
//
// The walk is produced by the real walkBlockTree over a stub seeded from
// the fixture tree, and the oracle reads the child list each heading was
// stored under — so the two cannot share a bug. Anchor echo wording is the
// consumer's concern and is never pinned here: only kind + ids.

import { describe, expect, it } from "vitest";
import type { SectionRefusal } from "../heading.js";
import {
	ALL_FIXTURES,
	build,
	CORPUS,
	treeOf,
	truncatedOf,
	type FNode,
	unwrapSection,
	walkBlock,
} from "./readStub.js";
import {
	appendAnchorOf,
	deriveAppendAnchor,
	deriveMoveAnchor,
	landingId,
	sectionOf,
	type AppendAnchor,
	type MoveAnchor,
} from "../placement.js";

function unwrapAnchor<T extends AppendAnchor | MoveAnchor>(
	result: T | SectionRefusal,
): T {
	if (result.kind === "walk-truncated") {
		throw new Error("unexpected truncation refusal on a complete tree");
	}
	if (result.kind === "heading-absent") {
		throw new Error("unexpected absent heading on a complete tree");
	}
	return result;
}

// ---------------------------------------------------------------- fixtures

// The independent oracle: following SIBLINGS within the heading's own
// container, up to the first sibling heading of level <= the target's.
// Deep headings never bound; a container does. Computed from the fixture
// tree, never from the walk.
function headingChildrenIds(siblings: FNode[], headingId: string): string[] {
	const idx = siblings.findIndex((n) => n.id === headingId);
	if (idx < 0) return [];
	const level = Number(siblings[idx]!.subType.slice(1)) || 1;
	const out: string[] = [];
	for (let i = idx + 1; i < siblings.length; i++) {
		const node = siblings[i]!;
		if (node.type === "h" && (Number(node.subType.slice(1)) || 1) <= level) {
			break;
		}
		out.push(node.id);
	}
	return out;
}

function collectSubtree(node: FNode, into: Set<string>): void {
	into.add(node.id);
	for (const child of node.children) collectSubtree(child, into);
}

/** The fixture tree flattened to id → node, so a member id reaches its
 * stored subtree for the closure check. */
function fixtureTreeIndex(root: FNode[]): Map<string, FNode> {
	const byId = new Map<string, FNode>();
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			byId.set(node.id, node);
			visit(node.children);
		}
	};
	visit(root);
	return byId;
}

/** The fixture tree in pre-order — the document order the flattened walk
 * must agree with — each entry carrying its tree parent. */
function preOrderIds(root: FNode[]): { id: string; parentId: string | null }[] {
	const out: { id: string; parentId: string | null }[] = [];
	const visit = (nodes: FNode[], parentId: string | null): void => {
		for (const node of nodes) {
			out.push({ id: node.id, parentId });
			visit(node.children, node.id);
		}
	};
	visit(root, null);
	return out;
}

// ----------------------------------------------------------- shape cases

describe("placement — corpus-unreachable shapes", () => {
	it("sectionOf: an unresolvable heading yields heading-absent (the consumer refuses)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(sectionOf(treeOf(walk), "ghost")).toEqual({
			kind: "heading-absent",
			headingId: "ghost",
		});
	});

	it("sectionOf: a truncated tree refuses — enumeration must not answer from incomplete evidence", () => {
		expect(
			sectionOf(truncatedOf([walkBlock("h1", "h", "h1", "A")]), "h1"),
		).toEqual({ kind: "walk-truncated" });
	});

	it("deriveMoveAnchor: omitted toHeadingId, populated destination → move after the last root-level block (doc end)", () => {
		const anchor = deriveMoveAnchor(
			treeOf([
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p1", "p", "", "one"),
				walkBlock("p2", "p", "", "last top-level"),
			]),
			undefined,
		);
		expect(anchor).toEqual({
			kind: "move",
			previousID: "p2",
			at: "doc-end",
		});
	});

	it("deriveMoveAnchor: omitted toHeadingId, empty destination → parentID on the root (prepend IS the end position)", () => {
		const anchor = deriveMoveAnchor(treeOf([]), undefined);
		expect(anchor).toEqual({ kind: "append" });
	});

	it("deriveAppendAnchor: no heading → the doc-root append (doc end)", () => {
		const anchor = deriveAppendAnchor(
			treeOf([walkBlock("h1", "h", "h1", "A")]),
			undefined,
		);
		expect(anchor).toEqual({ kind: "append", containerId: null });
	});

	// The no-heading arms read no walk content, so they stay positive on a
	// depth-truncated tree — a seen root block is genuinely there. The
	// EMPTY incomplete walk is different: only a tolerated root vanish
	// produces it (depth truncation cannot empty the root run), and an
	// unreadable destination is indistinguishable from a genuinely empty
	// doc at the doc-end arm — refuse rather than silently prepend (the
	// kernel's parentID move prepends).
	it("deriveAppendAnchor/deriveMoveAnchor: no heading → doc-end arms on a depth-truncated tree; an EMPTY incomplete walk refuses", () => {
		const truncated = truncatedOf([walkBlock("h1", "h", "h1", "A")]);
		expect(deriveAppendAnchor(truncated, undefined)).toEqual({
			kind: "append",
			containerId: null,
		});
		expect(deriveMoveAnchor(truncated, undefined)).toEqual({
			kind: "move",
			previousID: "h1",
			at: "doc-end",
		});
		expect(deriveAppendAnchor(truncatedOf([]), undefined)).toEqual({
			kind: "append",
			containerId: null,
		});
		expect(deriveMoveAnchor(truncatedOf([]), undefined)).toEqual({
			kind: "walk-truncated",
		});
	});

	it("deriveAppendAnchor/deriveMoveAnchor refuse a truncated tree when a heading drives the derivation", () => {
		const truncated = truncatedOf([walkBlock("h1", "h", "h1", "A")]);
		expect(deriveAppendAnchor(truncated, "h1")).toEqual({
			kind: "walk-truncated",
		});
		expect(deriveMoveAnchor(truncated, "h1")).toEqual({
			kind: "walk-truncated",
		});
	});

	// A defined id that is not in the supplied walk is a caller/derivation
	// mismatch, not an absence fact about the doc — the explicit arm, never
	// a silent doc-end answer that would place content from a mismatch.
	it("deriveAppendAnchor/deriveMoveAnchor: a heading not in this walk → heading-absent, never doc-end", () => {
		const tree = treeOf([walkBlock("h1", "h", "h1", "A")]);
		expect(deriveAppendAnchor(tree, "ghost")).toEqual({
			kind: "heading-absent",
			headingId: "ghost",
		});
		expect(deriveMoveAnchor(tree, "ghost")).toEqual({
			kind: "heading-absent",
			headingId: "ghost",
		});
		// The omitted-id doc-end arms are unaffected by the mismatch arm.
		expect(deriveAppendAnchor(tree, undefined)).toEqual({
			kind: "append",
			containerId: null,
		});
	});

	// placement is irrelevant to these — only the kind + id are.
	const mv = (previousID: string): MoveAnchor => ({
		kind: "move",
		previousID,
		at: "section-end",
	});

	it("landingId: vanished anchor → undefined (the caller falls back to presence)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(landingId(walk, mv("ghost"))).toBeUndefined();
	});

	it("landingId append: the container's last child, surviving trailing deep children", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p2", "p", "", "last top-level"),
			walkBlock("c1", "p", "", "kid", "p2", "p"),
		];
		expect(landingId(walk, { kind: "append" })).toBe("p2");
	});

	it("landingId: append on an empty walk → undefined", () => {
		expect(landingId([], { kind: "append" })).toBeUndefined();
	});
});

// ------------------------------------------------------------- assertions

describe("placement-map corpus", () => {
	for (const row of CORPUS) {
		it(row.label, async () => {
			const { tree } = await build(row.fixture);
			const section = unwrapSection(sectionOf(tree, row.target));
			// The section reads members; the baselines read closure —
			// pinned separately below, so the members assert covers both
			// corpus columns that list the sibling run.
			expect(section.members.map((m) => m.id)).toEqual(row.members);
			expect(section.boundary?.id ?? null).toEqual(row.boundary);
			const insert = deriveAppendAnchor(
				tree,
				row.target,
				row.placement ?? "section-end",
			);
			expect(insert).toEqual(row.insert);
			// The section-held projection and the id-addressed wrapper agree
			// row for row — appendAnchorOf is the projection half of
			// deriveAppendAnchor (sectionOf is the other), one rule, two
			// entry points.
			expect(appendAnchorOf(section, row.placement ?? "section-end")).toEqual(
				insert,
			);
			// Every corpus move is target-driven, so it always carries the
			// section-end `at` — the doc-end `at` is pinned in the shape
			// cases above.
			const move = deriveMoveAnchor(tree, row.target);
			expect(move).toEqual({
				kind: "move",
				previousID: row.movePreviousID,
				at: "section-end",
			});
		});
	}
});

describe("placement properties", () => {
	it("oracle equality: sectionOf.members equals the independent oracle for every heading in every fixture", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { tree, siblings } = await build(fixture);
			for (const list of siblings.values()) {
				for (const node of list) {
					if (node.type !== "h") continue;
					const section = unwrapSection(sectionOf(tree, node.id));
					expect(section.members.map((m) => m.id)).toEqual(
						headingChildrenIds(list, node.id),
					);
				}
			}
		}
	});

	it("anchor outside the member set: the insert anchor is never inside a member's closure", async () => {
		// The section-end anchor only: the section-start projection is
		// append-only, and its anchor IS a member (the first subsection) —
		// append deletes nothing, so the property does not apply there.
		for (const fixture of ALL_FIXTURES) {
			const { tree } = await build(fixture);
			for (const heading of tree.blocks.filter((b) => b.type === "h")) {
				const section = unwrapSection(sectionOf(tree, heading.id));
				const swept = new Set(section.closure.map((b) => b.id));
				const anchor = unwrapAnchor(
					deriveAppendAnchor(tree, heading.id, "section-end"),
				);
				const anchorId =
					anchor.kind === "insert" ? anchor.nextID : anchor.containerId;
				if (anchorId === null) continue; // the doc root, not a block
				expect(swept.has(anchorId)).toBe(false);
			}
		}
	});

	it("delete-set scope: closure is members plus every tree descendant, in document order", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { tree } = await build(fixture);
			const byId = fixtureTreeIndex(fixture);
			for (const heading of tree.blocks.filter((b) => b.type === "h")) {
				const section = unwrapSection(sectionOf(tree, heading.id));
				const subtree = new Set<string>();
				for (const member of section.members) {
					collectSubtree(byId.get(member.id)!, subtree);
				}
				expect(section.closure.map((b) => b.id)).toEqual(
					tree.blocks.filter((b) => subtree.has(b.id)).map((b) => b.id),
				);
			}
		}
	});

	it("move-anchor invariant: the anchor is never a heading whose own section has content", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { tree } = await build(fixture);
			for (const heading of tree.blocks.filter((b) => b.type === "h")) {
				const move = unwrapAnchor(deriveMoveAnchor(tree, heading.id));
				if (move.kind !== "move") continue; // heading-driven: never append
				const anchorBlock = tree.blocks.find((b) => b.id === move.previousID);
				expect(anchorBlock).toBeDefined();
				if (anchorBlock!.type !== "h") continue;
				expect(unwrapSection(sectionOf(tree, move.previousID)).members).toEqual(
					[],
				);
			}
		}
	});

	it("parentage: every walked block's (parentId, parentType) equals the fixture key it was stored under", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk, siblings } = await build(fixture);
			for (const block of walk) {
				const list = siblings.get(block.parentId);
				expect(list?.some((n) => n.id === block.id)).toBe(true);
				if (block.parentId === null) {
					expect(block.parentType).toBe("d");
				} else {
					const parent = walk.find((b) => b.id === block.parentId);
					expect(parent).toBeDefined();
					expect(block.parentType).toBe(parent!.type);
				}
			}
		}
	});

	it("landingId is the same rule: the tree's pre-order entry after the anchor's subtree — never the raw next entry", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { tree } = await build(fixture);
			// The oracle recomputes the landing from the fixture tree's
			// pre-order, independently of the real walk's flattening.
			const flat = preOrderIds(fixture);
			const byId = new Map(flat.map((e) => [e.id, e]));
			for (const heading of tree.blocks.filter((b) => b.type === "h")) {
				const move = unwrapAnchor(deriveMoveAnchor(tree, heading.id));
				if (move.kind !== "move") continue; // heading-driven: never append
				const idx = flat.findIndex((e) => e.id === move.previousID);
				let expected: string | undefined;
				for (let i = idx + 1; i < flat.length; i++) {
					let parent: string | null = flat[i]!.parentId;
					let inSubtree = false;
					while (parent !== null) {
						if (parent === move.previousID) {
							inSubtree = true;
							break;
						}
						parent = byId.get(parent)!.parentId;
					}
					if (!inSubtree) {
						expected = flat[i]!.id;
						break;
					}
				}
				// The append branch (the container's last child) is pinned in
				// the shape cases above; the move branch is the parent-chain
				// rule.
				expect(landingId(tree.blocks, move)).toBe(expected);
			}
		}
	});
});

// The partitionByAbsence and post-mutation receipt cases live beside their
// homes: receipt.test.ts (sectionOwnerOf / orphanedMembersOf) and
// walk.test.ts (partitionByAbsence).
