import { describe, expect, it } from "vitest";
import {
	headingLevel,
	headingRows,
	isHeadingBlock,
	resolveHeadingTarget,
} from "../heading.js";
import type { WalkedBlock, WalkedTree } from "../walk.js";

describe("headingLevel", () => {
	const block = (subType: string | undefined): WalkedBlock => ({
		id: "b",
		type: "h",
		subType: subType ?? "",
		content: "",
		markdown: "",
		parentId: null,
		parentType: "d",
	});

	it("reads h3 as level 3", () => {
		expect(headingLevel(block("h3"))).toBe(3);
	});

	it("reads a missing subType as level 1", () => {
		expect(headingLevel(block(""))).toBe(1);
		expect(headingLevel(block(undefined))).toBe(1);
	});

	it("reads a non-numeric subType as level 1", () => {
		expect(headingLevel(block("odd"))).toBe(1);
	});

	it("reads multi-digit levels verbatim", () => {
		expect(headingLevel(block("h10"))).toBe(10);
	});
});

describe("isHeadingBlock / headingRows", () => {
	const block = (id: string, type: string): WalkedBlock => ({
		id,
		type,
		subType: type === "h" ? "h1" : "",
		content: `content-${id}`,
		markdown: `content-${id}`,
		parentId: null,
		parentType: "d",
	});

	it("selects exactly the type-h rows, in walk order", () => {
		const walk = [
			block("d", "d"),
			block("h1", "h"),
			block("p1", "p"),
			block("h2", "h"),
		];
		expect(headingRows(walk).map((b) => b.id)).toEqual(["h1", "h2"]);
		expect(headingRows([])).toEqual([]);
	});

	it("isHeadingBlock selects only type-h rows", () => {
		expect(isHeadingBlock(block("h1", "h"))).toBe(true);
		expect(isHeadingBlock(block("p1", "p"))).toBe(false);
	});
});

describe("resolveHeadingTarget", () => {
	const tree = (blocks: WalkedBlock[]): WalkedTree => ({
		blocks,
		rootId: "d-doc",
		truncated: false,
		incomplete: false,
	});
	const docChild = (
		id: string,
		type: string,
		parentType: string | null = "d",
	): WalkedBlock => ({
		id,
		type,
		subType: type === "h" ? "h1" : "",
		content: `content-${id}`,
		markdown: `content-${id}`,
		parentId: null,
		parentType,
	});

	it("resolves a heading in a targetable container to its walk row", () => {
		const h = docChild("h1", "h", "l");
		const walk = [docChild("l1", "l"), h];
		const outcome = resolveHeadingTarget(tree(walk), "h1");
		expect(outcome).toEqual({ kind: "heading", heading: h });
	});

	it("the doc root 'd' is in the targetable set", () => {
		const h = docChild("h1", "h", "d");
		expect(resolveHeadingTarget(tree([h]), "h1")).toEqual({
			kind: "heading",
			heading: h,
		});
	});

	it("a heading id absent from the walk is heading-absent", () => {
		const walk = [docChild("h1", "h")];
		expect(resolveHeadingTarget(tree(walk), "oh-gone")).toEqual({
			kind: "heading-absent",
			headingId: "oh-gone",
		});
	});

	it("a non-heading id (even an existing block id) is heading-absent too", () => {
		const walk = [docChild("p1", "p")];
		expect(resolveHeadingTarget(tree(walk), "p1")).toEqual({
			kind: "heading-absent",
			headingId: "p1",
		});
	});

	it("a heading inside a refused container kind is untargetable, naming it", () => {
		const h = docChild("h1", "h", "tabs");
		const outcome = resolveHeadingTarget(
			tree([docChild("tabs1", "tabs"), h]),
			"h1",
		);
		expect(outcome).toEqual({
			kind: "untargetable",
			headingContent: "content-h1",
			containerType: "tabs",
		});
	});

	it('an unnamed container (empty or null parentType) is refused with containerType ""', () => {
		const empty = docChild("h1", "h", "");
		const nullish: WalkedBlock = { ...docChild("h2", "h"), parentType: null };
		expect(resolveHeadingTarget(tree([empty]), "h1").kind).toBe("untargetable");
		const outcome = resolveHeadingTarget(tree([nullish]), "h2");
		expect(outcome.kind === "untargetable" && outcome.containerType).toBe("");
	});

	it("absence on a truncated walk is walk-truncated, never a confident heading-absent", () => {
		expect(
			resolveHeadingTarget(
				{
					blocks: [docChild("h1", "h")],
					rootId: "d-doc",
					truncated: true,
					incomplete: true,
				},
				"oh-gone",
			),
		).toEqual({ kind: "walk-truncated" });
	});

	it("a found heading stays resolvable on a truncated walk (positive facts are sound)", () => {
		const h = docChild("h1", "h", "l");
		expect(
			resolveHeadingTarget(
				{
					blocks: [docChild("l1", "l"), h],
					rootId: "d-doc",
					truncated: true,
					incomplete: true,
				},
				"h1",
			),
		).toEqual({ kind: "heading", heading: h });
	});
});
