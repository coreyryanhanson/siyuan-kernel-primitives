// The extended-outline notation, pinned over fixture trees built through
// the real walkBlockTree. The glyph table and the write-side container pin
// encode the same kernel vocabulary; these fixtures pin them together so a
// vocabulary bump turns red here instead of rendering a writable container
// as `[unnamed]` or lying about a section bound.

import { describe, expect, it } from "vitest";
import { CONTAINER_GLYPHS, renderExtendedOutlineLines } from "../outline.js";
import { TARGETABLE_CONTAINER_TYPES } from "../containers.js";
import { walkBlockTree, type WalkedTree } from "../walk.js";
import { childrenMap, box, h, p, walkClient, type FNode } from "./readStub.js";

// ---------------------------------------------------------------- fixtures

// (fixture vocabulary rides __tests__/readStub.ts)

async function buildWalk(root: FNode[]): Promise<WalkedTree> {
	return walkBlockTree(walkClient(childrenMap(root, "d-doc")), "d-doc");
}

// The outline fixture set: one tree per container-prefix class the
// renderer distinguishes, plus the refused containers.
const OUTLINE_FIXTURES: FNode[][] = [
	[h("hA", 1, "A"), p("p1"), h("hB", 1, "B")],
	[h("hA", 1, "A"), p("p1"), h("hA1", 2, "A1"), p("p2"), h("hB", 1, "B")],
	[
		h("hTop", 1, "Top"),
		box("c1", "callout", [h("hN", 2, "N"), p("p2")]),
		p("pOut"),
		h("hNext", 1, "Next"),
	],
	[
		h("hTop", 1, "Top"),
		box("l1", "l", [
			box("i1", "i", [h("hH", 2, "H"), p("p3")]),
			box("i2", "i", [p("i2p")]),
		]),
		h("hNext", 1, "Next"),
	],
	[
		h("hTop", 1, "Top"),
		box("b2", "b", [p("p3")]),
		box("s1", "s", [h("hH", 2, "H")]),
		box("t1", "tab", [h("hT", 2, "In tab")]),
		h("hNext", 1, "Next"),
	],
	[
		h("hTop", 1, "Top"),
		box("mm1", "mindmap", [
			box("mi1", "mindmap_item", [h("hM", 2, "In map"), p("p4")]),
		]),
		h("hNext", 1, "Next"),
	],
	[
		h("hA", 1, "A"),
		// Unreachable through the pinned kernel (NodeTabs holds only tab
		// items; a footnote definition holds paragraphs) — defensive arms
		// for the `(not targetable)` / `[unnamed]` renderings.
		box("tabs1", "tabs", [h("hT", 1, "In tabs")]),
		box("fn1", "", [h("hF", 2, "In footnote")]),
		h("hB", 1, "B"),
	],
];

describe("renderExtendedOutlineLines", () => {
	it("every heading line carries the → id payload; (not targetable) marks exactly the refused containers", async () => {
		for (const fixture of OUTLINE_FIXTURES) {
			const walk = await buildWalk(fixture);
			const lines = renderExtendedOutlineLines(walk).lines;
			const headings = walk.blocks.filter((b) => b.type === "h");
			expect(lines).toHaveLength(headings.length);
			for (const heading of headings) {
				const line = lines.find((l) => l.includes(`→ ${heading.id}`));
				expect(line).toBeDefined();
				const refused = !TARGETABLE_CONTAINER_TYPES.includes(
					heading.parentType ?? "",
				);
				expect(line!.includes("(not targetable)")).toBe(refused);
			}
		}
	});

	it("bracketed tokens for refused containers; a heading in a list item renders one bullet", async () => {
		const refused = await buildWalk(
			OUTLINE_FIXTURES[OUTLINE_FIXTURES.length - 1]!,
		);
		const refusedLines = renderExtendedOutlineLines(refused).lines;
		expect(
			refusedLines.some((l) => l.includes("[tabs]") && l.includes("In tabs")),
		).toBe(true);
		expect(
			refusedLines.some(
				(l) => l.includes("[unnamed]") && l.includes("In footnote"),
			),
		).toBe(true);
		// l → i nesting renders through the item's bullet once, not twice.
		const listed = await buildWalk(OUTLINE_FIXTURES[3]!);
		const hLine = renderExtendedOutlineLines(listed).lines.find((l) =>
			l.includes("hH"),
		);
		expect(hLine).toBeDefined();
		expect(hLine!.startsWith("-## ")).toBe(true);
	});

	// The glyph table and the write-side container pin encode the same
	// kernel vocabulary; this pins them together so a vocabulary bump turns
	// red here instead of rendering a writable container as `[unnamed]` in
	// outlines.
	it("every targetable container type has a defined glyph, never [unnamed]", () => {
		for (const type of TARGETABLE_CONTAINER_TYPES) {
			expect(Object.hasOwn(CONTAINER_GLYPHS, type)).toBe(true);
		}
	});

	// Prefixes are concatenated with no separator, so the glyph set must be
	// a prefix code: one glyph that is a proper prefix of another ("m" vs
	// "mi") would make a rendered chain segmentable two ways. Every glyph
	// is one character except the self-delimiting bracketed ones.
	it("the glyph set is a prefix code (nesting concatenation stays unambiguous)", () => {
		const glyphs = Object.values(CONTAINER_GLYPHS).filter((g) => g !== "");
		for (const a of glyphs) {
			for (const b of glyphs) {
				if (a !== b) {
					expect(b.startsWith(a)).toBe(false);
				}
			}
		}
	});

	// mindmap → mindmap_item renders the map, then the branched node.
	it("a heading inside a mindmap item renders the m + chain", async () => {
		const walk = await buildWalk(OUTLINE_FIXTURES[5]!);
		const hLine = renderExtendedOutlineLines(walk).lines.find((l) =>
			l.includes("hM"),
		);
		expect(hLine).toBeDefined();
		expect(hLine!.startsWith("m+## ")).toBe(true);
		expect(hLine).not.toContain("(not targetable)");
	});

	// The incompleteness fact rides the render call: the consumer renders
	// the seen prefix and learns — from the same return value — that
	// absences in it are unconfirmed. A truncated tree never renders as a
	// complete outline with no marker available.
	it("a truncated tree renders its seen prefix and carries incomplete: true", async () => {
		const walk = await buildWalk(OUTLINE_FIXTURES[0]!);
		expect(renderExtendedOutlineLines(walk).incomplete).toBe(false);
		expect(
			renderExtendedOutlineLines({ ...walk, truncated: true, incomplete: true })
				.incomplete,
		).toBe(true);
	});
});
