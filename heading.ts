// The heading judgments over a walk — the kernel's wire heading shape and
// the pre-mutation write-target resolution. Beside the walk they are judged
// over, distinct from the section rule in `placement.ts` (which derives
// section bounds; this module resolves a heading as a write target).

import { isTargetableContainer } from "./containers.js";
import {
	type WalkTruncated,
	type WalkedBlock,
	type WalkedTree,
} from "./walk.js";

/** The heading level from the subType ("h3" → 3); a missing subType
 * reads as level 1. One rule shared by the outline and the anchor/section
 * logic, so the rendered nesting can never diverge from section bounds. */
export function headingLevel(block: WalkedBlock): number {
	return Number(String(block.subType).slice(1)) || 1;
}

/** Which walk rows are headings — the kernel's wire type "h". One predicate
 * for every consumer (outline rendering, baseline seeding, the section
 * rule, target resolution), so a heading-representation change can never
 * desync the rendered set from the seeded or judged sets. */
export const isHeadingBlock = (block: WalkedBlock): boolean =>
	block.type === "h";

/** The walk's heading rows in document order. */
export function headingRows(walk: readonly WalkedBlock[]): WalkedBlock[] {
	return walk.filter(isHeadingBlock);
}

/** The shared pre-mutation refusal pair of the heading-target and
 * section/anchor judgments: a defined heading id that names no heading of
 * the supplied walk (the arm carries that id — the verdict states what
 * was judged absent, so consumers word the subject from the verdict,
 * never from their own request params), and the incomplete-walk refusal
 * that keeps that absence unconfirmed. Declared once; every projection
 * union composes it so a new arm lands here or fails typecheck, never
 * silently diverges between flows. (Named for the section rule but homed
 * here because the import direction runs placement → heading:
 * `placement.ts`'s section rule and the section-scoped sequences compose
 * this type.) */
export type SectionRefusal =
	| { kind: "heading-absent"; headingId: string }
	| WalkTruncated;

/** The heading-target judgment's arms; `resolveHeadingTarget` renders
 * them (its doc carries the truncation split and kernel-call posture). */
export type HeadingTarget =
	| { kind: "heading"; heading: WalkedBlock }
	| {
			kind: "untargetable";
			headingContent: string;
			/** The refused container's wire type; "" = unnamed. */
			containerType: string;
	  }
	| SectionRefusal;

/** Pre-mutation heading-target resolution over the tree the caller
 * already holds: membership (the id is a heading of this doc's walk) plus
 * targetability (the immediate parent is in the local targetable set —
 * `IsContainerType` minus `tabs`; see ./containers.js). A heading that
 * fails either arm is refused before any
 * kernel call — the same class as blockInDoc's foreign-block refusal.
 * Takes the whole WalkedTree, not a bare block list: a found heading is a
 * positive fact and stays sound, but an absent one over an incomplete walk
 * is unconfirmed (the `WalkedTree` invariant), so only the negative arm
 * splits — `walk-truncated` instead of a confident `heading-absent`. Pure:
 * no kernel client. */
export function resolveHeadingTarget(
	walk: WalkedTree,
	headingId: string,
): HeadingTarget {
	const heading = walk.blocks.find(
		(b) => b.id === headingId && isHeadingBlock(b),
	);
	if (heading === undefined) {
		return walk.incomplete
			? { kind: "walk-truncated" }
			: { kind: "heading-absent", headingId };
	}
	const containerType = heading.parentType ?? "";
	if (!isTargetableContainer(containerType)) {
		return {
			kind: "untargetable",
			headingContent: heading.content,
			containerType,
		};
	}
	return { kind: "heading", heading };
}
