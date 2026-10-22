// Write placement — the section rule and the anchors derived from it:
// where an append/replace-section lands, where a move lands, and what a
// section delete spans. Pure functions over the document-order walk,
// independently testable (the placement corpus). Fold-state-independent
// except `landingId`'s heading-anchor branch — fold-safe by the
// precondition on `MoveAnchor`'s move variant.
//
// Anchors are structure only: kind + the ids that drive the kernel call.
//
// One section rule: the section of a heading H is H's following siblings
// inside H's own container, up to the first sibling heading of level ≤ H's
// level (same-or-shallower). Every anchor is a projection of that one
// Section — no consumer re-derives placement from walk order.
//
// The post-mutation receipt projections (the landed heading's owner, the
// members a heading still holds after a delete) live in `./receipt.js`.

import {
	isHeadingBlock,
	headingLevel,
	type SectionRefusal,
} from "./heading.js";
import { foreignRefusalOf, type ForeignRefusal } from "./byId.js";
import {
	byIdMap,
	inSubtree,
	siblingRunOf,
	type WalkedBlock,
	type WalkedTree,
} from "./walk.js";

/** The descendants a delete of `blockId` cascades to, in document order —
 * the kernel fact the delete flow's judged set and delete span derive
 * from, homed beside `sectionOf` (whose closure is the same cascade rule
 * over a heading's members). A heading's delete is fold-blind: the
 * cascade consumes nothing, its section members survive it. An id absent
 * from the walk derives nothing — the caller still judges the target id
 * itself (a complete walk's absence is the concurrent-delete fact, a
 * proceeding arm). */
export function cascadeDescendantsOf(
	walk: WalkedTree,
	blockId: string,
): WalkedBlock[] {
	const byId = byIdMap(walk.blocks);
	const targetRow = byId.get(blockId);
	if (targetRow === undefined || isHeadingBlock(targetRow)) return [];
	return walk.blocks.filter((b) => inSubtree(b, blockId, byId));
}

export interface Section {
	heading: WalkedBlock;
	/** The heading's parent — null = document root. */
	containerId: string | null;
	/** Following siblings in the container, up to the first sibling heading
	 * of level ≤ the target's. Deeper headings never bound; a container
	 * does. This is the kernel's HeadingChildren. */
	members: WalkedBlock[];
	/** First same-or-shallower sibling heading, else null (the section runs
	 * to the container's end). */
	boundary: WalkedBlock | null;
	/** members + every descendant of each member — what a delete of the
	 * members cascades to. */
	closure: WalkedBlock[];
}

/** The section rule's outcome as a closed union: the section, a confirmed
 * absent heading, or the truncation refusal — the closure this rule
 * produces bounds a section delete, and a truncated tree cannot state that
 * bound (the `WalkTruncated` rationale). */
export type SectionResult =
	| { kind: "section"; section: Section }
	| SectionRefusal;

/** The one section primitive: membership, boundary and closure for a
 * heading of the tree. Container-local by construction — the flattened
 * walk is pre-order, so the heading's sibling run is the following entries
 * that share its parent, interleaved with (and bounded by) the members'
 * own subtrees. Takes the whole WalkedTree: the section's closure bounds
 * what a section delete spans, so it refuses (`walk-truncated`) before any
 * judgment — unconditional on incompleteness, per the `WalkTruncated`
 * rationale. */
export function sectionOf(walk: WalkedTree, headingId: string): SectionResult {
	if (walk.incomplete) return { kind: "walk-truncated" };
	const blocks = walk.blocks;
	const headingIndex = blocks.findIndex(
		(b) => b.id === headingId && isHeadingBlock(b),
	);
	if (headingIndex < 0) return { kind: "heading-absent", headingId };
	const heading = blocks[headingIndex]!;
	const containerId = heading.parentId;
	const level = headingLevel(heading);
	const byId = byIdMap(blocks);
	const members: WalkedBlock[] = [];
	const memberIndices: number[] = [];
	let boundary: WalkedBlock | null = null;
	let lastMember: WalkedBlock | undefined;
	for (let i = headingIndex + 1; i < blocks.length; i++) {
		const block = blocks[i]!;
		if (block.parentId === containerId) {
			if (isHeadingBlock(block) && headingLevel(block) <= level) {
				boundary = block;
				break;
			}
			members.push(block);
			memberIndices.push(i);
			lastMember = block;
			continue;
		}
		// Not a sibling: a descendant of the last member (the run continues
		// past it) or a block past the container's own subtree (it ended).
		if (lastMember !== undefined && inSubtree(block, lastMember.id, byId)) {
			continue;
		}
		break;
	}
	// The pre-order walk keeps each member's descendants contiguous behind
	// it, so the closure is each member plus the run of subtree entries
	// trailing it — cut at the first entry outside the subtree.
	const closure: WalkedBlock[] = [];
	for (const [k, member] of members.entries()) {
		closure.push(member);
		for (let i = memberIndices[k]! + 1; i < blocks.length; i++) {
			const block = blocks[i]!;
			if (!inSubtree(block, member.id, byId)) break;
			closure.push(block);
		}
	}
	return {
		kind: "section",
		section: { heading, containerId, members, boundary, closure },
	};
}

/** The caller-provenance gate rides `byId.ts` beside its `ForeignRefusal`
 * arm (`foreignRefusalOf`); `sectionSubjectOf` composes it with the
 * section enumeration. */

/** The section enumeration plus the caller-provenance gate, as the
 * section-shaped write flows consume it: `sectionOf`'s closed union
 * (truncation, absent heading) extended with the `foreign` refusal
 * (`foreignRefusalOf`). Zero kernel calls either way — the walk carries
 * its own root. */
export function sectionSubjectOf(
	walk: WalkedTree,
	rootId: string,
	headingId: string,
): SectionResult | ForeignRefusal {
	const section = sectionOf(walk, headingId);
	if (section.kind !== "section") return section;
	return foreignRefusalOf(walk, rootId, headingId) ?? section;
}

export type AppendAnchor =
	| { kind: "insert"; nextID: string }
	| { kind: "append"; containerId: string | null };

export type MoveAnchor =
	// Fold-safety precondition, stated once for the whole module: a move
	// anchor's previousID must be a leaf position — a heading only with an
	// EMPTY section, the only heading shape `deriveMoveAnchor` derives (a
	// self-folded anchor heading with a section would redirect a landing
	// past its whole section — fold-dependent hidden state). And
	// `landingId`'s "entry immediately after" projection assumes a leaf.
	| { kind: "move"; previousID: string; at: "doc-end" | "section-end" }
	// Move's empty-destination fallback: parentID prepends (the defect),
	// which IS the end position when there is nothing to be after.
	| { kind: "append" };

/** The append/replace-section projection: section-end (the default) or
 * section-start (after the heading's leading run, before its first deeper
 * sibling heading). */
export type AppendPlacement = "section-end" | "section-start";

/** The section-end projection — the default insert anchor: `insert` before
 * the section's boundary (a sibling of the target, so the kernel lands it
 * inside the target's own container), else `append` to the container's end
 * (the document root for a doc-level heading with no boundary). */
function sectionEndAnchor(section: Section): AppendAnchor {
	if (section.boundary !== null) {
		return { kind: "insert", nextID: section.boundary.id };
	}
	return { kind: "append", containerId: section.containerId };
}

/** The section-start projection (append only): insert immediately before
 * the section's first deeper sibling heading — after the heading's leading
 * run of members. A deeper heading inside a container is not a sibling, so
 * a section whose only subsections are container-nested has no first
 * sibling heading member and the projection falls through to the
 * section-end rule — identical landing there. Same `Section`, same insert
 * kind, so it inherits the boundary insert's fold-independence. */
function sectionStartAnchor(section: Section): AppendAnchor {
	const firstSubsection = section.members.find(isHeadingBlock);
	if (firstSubsection !== undefined) {
		return { kind: "insert", nextID: firstSubsection.id };
	}
	return sectionEndAnchor(section);
}

/** The append/replace-section anchor projected from a `Section` already in
 * hand — feed it only the `Section` the same walk's `sectionOf` produced
 * (a separately derived section risks a caller/derivation mismatch). The
 * id-addressed `deriveAppendAnchor` stays the entry point for callers who
 * hold no section. */
export function appendAnchorOf(
	section: Section,
	placement: AppendPlacement = "section-end",
): AppendAnchor {
	return placement === "section-start"
		? sectionStartAnchor(section)
		: sectionEndAnchor(section);
}

/** `append`/replace-section anchor, addressed by heading id like every
 * other placement primitive: `sectionOf` + `appendAnchorOf`. `placement`
 * is append-only; other modes always take the section-end rule. No heading
 * id → the doc's end (a positive projection that reads no walk content —
 * sound on any walk). Truncation refusal otherwise: the anchor derives
 * from the section enumeration, which refuses an incomplete tree; a
 * defined id missing from the walk is the `heading-absent` arm (see
 * `deriveMoveAnchor`). */
export function deriveAppendAnchor(
	walk: WalkedTree,
	headingId: string | undefined,
	placement: AppendPlacement = "section-end",
): AppendAnchor | SectionRefusal {
	if (headingId === undefined) return { kind: "append", containerId: null };
	const section = sectionOf(walk, headingId);
	if (section.kind === "walk-truncated") return section;
	if (section.kind === "heading-absent") return section;
	return appendAnchorOf(section.section, placement);
}

/** The move's doc-end fallback: a populated destination positions after
 * its last root-level block (moveBlock with parentID prepends — the
 * defect); an empty one has no block to anchor after, so parentID IS the
 * end position. */
function docEndMoveAnchor(destWalk: readonly WalkedBlock[]): MoveAnchor {
	const lastRoot = siblingRunOf(destWalk, null).at(-1);
	if (lastRoot === undefined) return { kind: "append" };
	return { kind: "move", previousID: lastRoot.id, at: "doc-end" };
}

/** move anchor: after the section's last member — recursing into it while
 * it is a heading (a heading with an empty section is the anchor itself:
 * after-heading placement IS end-of-section there). A container member
 * (list/quote) anchors on the container — the walk's flattened members
 * are exactly the section-level nodes. Fold-state independent by
 * construction: derived from walk structure. Takes the whole
 * WalkedTree: an incomplete destination tree refuses
 * (`walk-truncated`). The omitted-toHeadingId arm is the doc-end
 * fallback, a positive projection over the root-level sibling run —
 * but an empty walk from a tolerated root vanish refuses too: an
 * unreadable destination is indistinguishable from a genuinely empty
 * doc at this arm, and the kernel's parentID move would prepend. A
 * defined id that is not in this walk is the `heading-absent` arm — a
 * caller/derivation mismatch, never a silent doc-end answer. */
export function deriveMoveAnchor(
	destWalk: WalkedTree,
	toHeadingId: string | undefined,
): MoveAnchor | SectionRefusal {
	if (
		toHeadingId === undefined &&
		destWalk.incomplete &&
		destWalk.blocks.length === 0
	) {
		return { kind: "walk-truncated" };
	}
	if (toHeadingId === undefined) return docEndMoveAnchor(destWalk.blocks);
	let targetId = toHeadingId;
	for (;;) {
		const section = sectionOf(destWalk, targetId);
		if (section.kind === "walk-truncated") return section;
		if (section.kind === "heading-absent") return section;
		const last = section.section.members.at(-1);
		if (last === undefined) {
			// Empty section: the heading itself is the anchor. Every heading
			// anchor anchors an EMPTY section — the `MoveAnchor` move
			// variant's precondition — here, or in `docEndMoveAnchor` when
			// the doc's last root-level block is a heading.
			return {
				kind: "move",
				previousID: section.section.heading.id,
				at: "section-end",
			};
		}
		if (!isHeadingBlock(last)) {
			return { kind: "move", previousID: last.id, at: "section-end" };
		}
		targetId = last.id;
	}
}

/**
 * Kernel placement, stated once: the walk id a block anchored at `anchor`
 * lands on, or undefined when no entry occupies the landing position (or
 * the position is unverifiable — vanished anchor). `moveBlock` with
 * previousID=X inserts as X's next SIBLING: for a container anchor the
 * flattened walk's entry after X's whole SUBTREE (a container's descendants
 * trail it, so "the next entry" is the container's first child, not the
 * sibling); for a heading anchor (a leaf by the `MoveAnchor` move
 * variant's precondition — the flow refuses a section-bearing anchor
 * heading pre-mutation) the landing is the walk entry immediately after it.
 * The `append` kind's landing is the document root's last child. The
 * per-id move flow's two same-doc checks (pre-move no-op refusal,
 * post-move verification) ask this function — never their own walk
 * arithmetic; the batched section move's chain leg derives its own
 * sibling-interval form instead, to tolerate concurrent inserts between
 * anchor and run. */
export function landingId(
	walk: readonly WalkedBlock[],
	anchor: MoveAnchor,
): string | undefined {
	if (anchor.kind === "append") {
		// The doc root's last child IS the end position.
		return siblingRunOf(walk, null).at(-1)?.id;
	}
	const idx = walk.findIndex((b) => b.id === anchor.previousID);
	if (idx < 0) return undefined; // vanished anchor — caller falls back
	const byId = byIdMap(walk);
	for (let i = idx + 1; i < walk.length; i++) {
		const block = walk[i]!;
		if (!inSubtree(block, anchor.previousID, byId)) return block.id;
	}
	return undefined;
}
