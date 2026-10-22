// The post-mutation receipt projections: where a landed section attached
// (sectionOwnerOf) and the members a heading's section still holds after a
// delete (orphanedMembersOf). The placement corpus (readStub) drives the
// owner property; partitionByAbsence cases live in walk.test.ts, the
// walk's own home.

import { describe, expect, it } from "vitest";
import { sectionOf } from "../placement.js";
import type { WalkedTree } from "../walk.js";
import { sectionOwnerOf, orphanedMembersOf } from "../receipt.js";
import {
	box,
	build,
	ALL_FIXTURES,
	h,
	p,
	treeOf,
	truncatedOf,
	unwrapSection,
	walkBlock,
} from "./readStub.js";

// ------------------------------------------------- sectionOwnerOf

describe("sectionOwnerOf", () => {
	it("deeper landing — the destination heading owns the nested section", async () => {
		const { tree } = await build([h("hA", 1, "A"), p("p1"), h("hH", 2, "H")]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hA", level: 1, content: "A" },
		});
	});

	it("deeper landing — a deeper heading within the destination section that precedes it owns it", async () => {
		const { tree } = await build([
			h("hA", 1, "A"),
			p("p1"),
			h("hD", 2, "D"),
			p("d1"),
			h("hH", 3, "H"),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hD", level: 2, content: "D" },
		});
	});

	it("the nearer deeper heading's section ends before the landing — ownership falls to the destination heading", async () => {
		// hH (level 2) bounds hD's section, but it is still a member of
		// hA's section — the nearest heading whose closure claims it is
		// hA, not the immediately preceding hD and not `null`.
		const { tree } = await build([
			h("hA", 1, "A"),
			p("p1"),
			h("hD", 2, "D"),
			p("d1"),
			h("hH", 2, "H"),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hA", level: 1, content: "A" },
		});
	});

	it("a same-level landing inside a container is the container's (null), never an outer heading's", async () => {
		// The landed hH is a top-level section of the quote beside hQ; hE's
		// closure spans the quote's whole subtree, so a whole-walk closure
		// scan would name hE — a heading OUTSIDE the container. The
		// container-local reading answers the container: null.
		const { tree } = await build([
			h("hE", 1, "E"),
			p("e1"),
			box("q1", "b", [
				h("hQ", 2, "Q"),
				p("qb"),
				h("hH", 2, "H"),
				p("mb"),
				h("hR", 2, "R"),
				p("rb"),
			]),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({ kind: "owner", owner: null });
	});

	it("the same landing with no outer heading preceding the container is null too", async () => {
		const { tree } = await build([
			p("a1"),
			box("q1", "b", [h("hQ", 2, "Q"), p("qb"), h("hH", 2, "H"), p("mb")]),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({ kind: "owner", owner: null });
	});

	it("the enclosing-container case — a landing inside a container with no heading around it is claimed via closure through the container", async () => {
		// hH is the quote's only heading, so the quote's interior claims
		// nothing; the quote's own position falls outward and hP's closure
		// — which spans the quote's subtree — claims the landing.
		const { tree } = await build([
			h("hP", 1, "P"),
			p("p1"),
			box("q1", "b", [p("x"), h("hH", 2, "H")]),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hP", level: 1, content: "P" },
		});
	});

	it("the enclosing-container case crosses nested heading-less containers", async () => {
		const { tree } = await build([
			h("hP", 1, "P"),
			p("p1"),
			box("q1", "b", [
				box("l1", "l", [box("i1", "i", [h("hH", 2, "H"), p("x")])]),
				p("y"),
			]),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hP", level: 1, content: "P" },
		});
	});

	it("a doc-level landing owns nothing — null names the doc root", async () => {
		const { tree } = await build([
			h("hA", 1, "A"),
			p("a1"),
			h("hB", 1, "B"),
			p("b1"),
			h("hH", 1, "H"),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({ kind: "owner", owner: null });
	});

	it("the landed heading as the walk's first block — null", async () => {
		const { tree } = await build([h("hH", 1, "H"), p("m1")]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({ kind: "owner", owner: null });
	});

	it("an empty-section tail heading between the landing and its owner — the owner is the enclosing section's heading", async () => {
		// hH (level 3) landed after hE's EMPTY section: hE claims nothing,
		// but hH is a member of hD's section — the chain-arm tail shape.
		const { tree } = await build([
			h("hB", 1, "B"),
			p("b1"),
			h("hD", 2, "D"),
			p("d1"),
			h("hE", 3, "E"),
			h("hH", 3, "H"),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hD", level: 2, content: "D" },
		});
	});

	it("a deeper landing inside a container nests under the container's own heading", async () => {
		// The container re-nest with a deeper moved heading: hH (level 3) is a
		// member of hQ's section inside the callout — the owner is hQ,
		// inside the container, not a doc-level heading outside it.
		const { tree } = await build([
			h("hTop", 1, "Top"),
			box("c1", "callout", [
				h("hQ", 2, "Q"),
				p("q1"),
				h("hH", 3, "H"),
				p("m1"),
				h("hR", 2, "R"),
				p("r1"),
			]),
		]);
		expect(sectionOwnerOf(tree, "hH")).toEqual({
			kind: "owner",
			owner: { headingId: "hQ", level: 2, content: "Q" },
		});
	});

	it("a truncated walk refuses — a null owner is a negative claim", async () => {
		const walk = truncatedOf([walkBlock("hH", "h", "h2", "H")]);
		expect(sectionOwnerOf(walk, "hH")).toEqual({ kind: "walk-truncated" });
	});

	it("an id that names no heading row of the walk — heading-absent (a non-heading id included)", async () => {
		const { tree } = await build([h("hA", 1, "A"), p("p1")]);
		expect(sectionOwnerOf(tree, "ghost")).toEqual({
			kind: "heading-absent",
			headingId: "ghost",
		});
		expect(sectionOwnerOf(tree, "p1")).toEqual({
			kind: "heading-absent",
			headingId: "p1",
		});
	});

	it("property: the owner is the nearest preceding qualifying heading — every heading between owner and landing fails the closure claim", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { tree } = await build(fixture);
			for (const heading of tree.blocks.filter((b) => b.type === "h")) {
				const owner = sectionOwnerOf(tree, heading.id);
				if (owner.kind !== "owner") continue;
				const ownerHeading = owner.owner;
				if (ownerHeading === null) continue;
				const ownerIdx = tree.blocks.findIndex(
					(b) => b.id === ownerHeading.headingId,
				);
				const landedIdx = tree.blocks.findIndex((b) => b.id === heading.id);
				const ownerSection = unwrapSection(
					sectionOf(tree, ownerHeading.headingId),
				);
				const claimed = new Set(ownerSection.closure.map((b) => b.id));
				expect(claimed.has(heading.id)).toBe(true);
				for (let i = ownerIdx + 1; i < landedIdx; i++) {
					const between = tree.blocks[i]!;
					if (between.type !== "h") continue;
					const betweenSection = sectionOf(tree, between.id);
					if (betweenSection.kind !== "section") continue;
					expect(
						betweenSection.section.closure.some((m) => m.id === heading.id),
					).toBe(false);
				}
			}
		}
	});
});

// ------------------------------------------------- orphanedMembersOf

/** A section-bearing pre-walk: heading "hA" (level 1) with members m-1,
 * m-2, bounded by the same-level heading "hB"; "hZ" closes the walk with
 * a section-less heading (its run reaches the container's end). */
function sectionPreWalk(): WalkedTree {
	return treeOf([
		walkBlock("hA", "h", "h1", "A"),
		walkBlock("m-1", "p", "", "one"),
		walkBlock("m-2", "p", "", "two"),
		walkBlock("hB", "h", "h1", "B"),
		walkBlock("b-1", "p", "", "B body"),
		walkBlock("hZ", "h", "h1", "Z"),
	]);
}

describe("orphanedMembersOf", () => {
	it("names the members still present in the post-delete walk", () => {
		const postWalk = treeOf([
			walkBlock("m-1", "p", "", "one"),
			walkBlock("hB", "h", "h1", "B"),
			walkBlock("b-1", "p", "", "B body"),
			walkBlock("hZ", "h", "h1", "Z"),
		]);
		expect(orphanedMembersOf(sectionPreWalk(), "hA", postWalk)).toEqual({
			kind: "ids",
			ids: ["m-1"],
			unconfirmedIds: [],
		});
	});

	it("empty ids on a section-less heading — never folded into heading-absent", () => {
		// "hZ" is present and section-less (its run reaches the container's
		// end): the empty member set must render as no report, not as the
		// absent-heading refusal.
		const postWalk = treeOf([
			walkBlock("hB", "h", "h1", "B"),
			walkBlock("b-1", "p", "", "B body"),
			walkBlock("hZ", "h", "h1", "Z"),
		]);
		expect(orphanedMembersOf(sectionPreWalk(), "hZ", postWalk)).toEqual({
			kind: "ids",
			ids: [],
			unconfirmedIds: [],
		});
	});

	it("bound-unconfirmed on an incomplete pre-walk — the section's bound cannot be stated", () => {
		// Unconfirmed family, never the pre-mutation walk-truncated
		// discriminant — see `OrphanedMembers`.
		const truncatedPre = truncatedOf([walkBlock("hA", "h", "h1", "A")]);
		expect(orphanedMembersOf(truncatedPre, "hA", sectionPreWalk())).toEqual({
			kind: "bound-unconfirmed",
		});
	});

	it("an incomplete post-walk keeps the sound presences and routes the rest to unconfirmedIds", () => {
		// Presence survives truncation; only the absence claims degrade —
		// a member absent from the seen prefix is never claimed deleted.
		const truncatedPost = truncatedOf([walkBlock("m-1", "p", "", "one")]);
		expect(orphanedMembersOf(sectionPreWalk(), "hA", truncatedPost)).toEqual({
			kind: "ids",
			ids: ["m-1"],
			unconfirmedIds: ["m-2"],
		});
	});

	it("a non-heading row is not-a-heading — a plain block holds no members", () => {
		// "b-1" is present in the pre-walk but is a paragraph: a plain block
		// holds no section members, so there is nothing to report.
		expect(
			orphanedMembersOf(sectionPreWalk(), "b-1", sectionPreWalk()),
		).toEqual({
			kind: "not-a-heading",
		});
	});

	it("an id absent from a complete pre-walk is not-in-pre-walk — no member set can be stated", () => {
		// The walk saw the whole document and the id still is not in it:
		// no member set can be stated.
		expect(
			orphanedMembersOf(sectionPreWalk(), "nope", sectionPreWalk()),
		).toEqual({
			kind: "not-in-pre-walk",
		});
	});

	it("an id absent from an INCOMPLETE pre-walk is bound-unconfirmed, never not-in-pre-walk", () => {
		// Precedence: the incompleteness check runs before the row lookup —
		// an incomplete walk's silence is unconfirmed, never a confident
		// absence.
		expect(
			orphanedMembersOf(
				truncatedOf([walkBlock("hA", "h", "h1", "A")]),
				"nope",
				sectionPreWalk(),
			),
		).toEqual({
			kind: "bound-unconfirmed",
		});
	});
});
