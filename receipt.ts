// Post-mutation receipt projections over the walk: where a landed
// section attached (`sectionOwnerOf`) and the members a heading's
// section still holds after a deletion (`orphanedMembersOf`). Pure walk
// projections — no kernel calls; both run against walks the caller
// already holds. The incompleteness policy is per-projection: the owner
// read's `null` is a negative claim, so it refuses an incomplete walk
// unconditionally (`walk-truncated`, pre-mutation semantics); the
// orphaned-members read runs after the caller's delete has already
// acked, so its incompleteness arm is the unconfirmed family
// (`bound-unconfirmed`) — never the payload-free `walk-truncated`
// discriminant.

import {
	isHeadingBlock,
	headingLevel,
	type SectionRefusal,
} from "./heading.js";
import { sectionOf } from "./placement.js";
import {
	partitionByAbsence,
	type WalkedBlock,
	type WalkedTree,
} from "./walk.js";

/** The landed heading's owner: the heading whose section the landed
 * heading nests under, or `null` when no heading's section contains the
 * landing — the landing is a top-level section of its container, and
 * `null` names that container (the doc root at doc level). `content`
 * carries the owner heading's own title so consumers can name it
 * without re-scanning the walk (verdicts carry their evidence). */
export type SectionOwner = {
	headingId: string;
	level: number;
	content: string;
} | null;

/** The moved heading's new owner after a landing — the receipt's answer
 * to "where did the section actually attach". Pure walk projection over
 * a walk the caller already holds; no kernel calls.
 *
 * The formulation is a container-local sibling scan: within one
 * container, the owner is the nearest preceding sibling heading of
 * strictly smaller level (a following sibling heading of level ≤ ends
 * the section; for a non-heading placed position the nearest preceding
 * sibling heading of any level qualifies). The scan is container-LOCAL:
 * a whole-walk closure scan would name a heading OUTSIDE the landed
 * heading's container for a landing that is a top-level section OF that
 * container. So: a qualifying heading in the container wins; otherwise,
 * when the container carries other heading context, the container is
 * the answer (`null`); otherwise the position falls outward and the
 * container's own placement is judged in its enclosing container,
 * recursing to the doc root. The result is `null` exactly when the
 * walk's own heading structure claims nothing further. The owner answer
 * rides a `kind: "owner"` wrapper so consumers narrow on `kind` alone
 * — `null` is an owner answer (the doc root), not a refusal.
 *
 * Refuses on an incomplete walk (a `null` owner is a negative claim —
 * the same unconditional refusal `sectionOf` makes) and on an id that
 * names no heading row of the supplied walk (`heading-absent`, which
 * also covers a non-heading id — the section rule's targeting
 * semantics). */
export function sectionOwnerOf(
	walk: WalkedTree,
	landedHeadingId: string,
): { kind: "owner"; owner: SectionOwner } | SectionRefusal {
	if (walk.incomplete) return { kind: "walk-truncated" };
	const blocks = walk.blocks;
	const startIndex = blocks.findIndex(
		(b) => b.id === landedHeadingId && isHeadingBlock(b),
	);
	if (startIndex < 0)
		return { kind: "heading-absent", headingId: landedHeadingId };
	// The position being placed: the landed heading first; when its
	// container carries no heading context of its own, the container's
	// own position takes its place (the enclosing-container rule).
	let placedIdx = startIndex;
	for (;;) {
		const placed = blocks[placedIdx]!;
		const containerId = placed.parentId;
		const placedHeading = isHeadingBlock(placed);
		const placedLevel = placedHeading ? headingLevel(placed) : 0;
		// The pre-order walk keeps each container's subtree contiguous, so
		// the backward scan stays inside the placed position's container
		// (the container's own row ends it) and `parentId !== containerId`
		// rows in between are members' descendants, never siblings.
		let owner: WalkedBlock | undefined;
		for (let i = placedIdx - 1; i >= 0; i--) {
			const block = blocks[i]!;
			if (containerId !== null && block.id === containerId) break;
			if (block.parentId !== containerId) continue;
			if (!isHeadingBlock(block)) continue;
			if (placedHeading && headingLevel(block) >= placedLevel) continue;
			owner = block;
			break;
		}
		if (owner !== undefined) {
			return {
				kind: "owner",
				owner: {
					headingId: owner.id,
					level: headingLevel(owner),
					content: owner.content,
				},
			};
		}
		if (containerId === null) return { kind: "owner", owner: null }; // the doc root
		const containerIdx = blocks.findIndex((b) => b.id === containerId);
		// Unreachable (the parent chain of a walked row is complete);
		// fail-safe toward the container answer.
		if (containerIdx < 0) return { kind: "owner", owner: null };
		const hasHeadingContext = blocks.some(
			(b) =>
				b.parentId === containerId && isHeadingBlock(b) && b.id !== placed.id,
		);
		if (hasHeadingContext) return { kind: "owner", owner: null };
		placedIdx = containerIdx;
	}
}

/** `orphanedMembersOf`'s outcome as a closed union, declared explicitly.
 * The projection runs AFTER the caller's delete has already acked, so its
 * incompleteness arm is the unconfirmed family — never the payload-free
 * pre-mutation `walk-truncated` discriminant, whose meaning ("nothing
 * applied, safe to retry") is false here:
 * - `ids` — the surviving member ids, sound on ANY post-walk (presence is
 *   a positive fact and survives truncation); `unconfirmedIds` carries
 *   the members absent from an incomplete post-walk's seen prefix —
 *   never claimed deleted, the consumer words them as uncounted
 * - `not-a-heading` — the headingId names a non-heading row of the
 *   pre-walk: a plain block holds no section members, so there is
 *   nothing to report and the consumer suppresses
 * - `not-in-pre-walk` — the headingId names no row of the COMPLETE
 *   pre-walk: the walk saw the whole document and the deleted block
 *   still was not in it, so no member set can be stated
 * - `bound-unconfirmed` — the pre-walk is incomplete, so the section's
 *   bound cannot be stated and there is no trustworthy member set to
 *   partition (an id absent from an INCOMPLETE pre-walk lands here too:
 *   the walk's silence is unconfirmed, never a confident absence) */
export type OrphanedMembers =
	| { kind: "ids"; ids: string[]; unconfirmedIds: string[] }
	| { kind: "not-a-heading" }
	| { kind: "not-in-pre-walk" }
	| { kind: "bound-unconfirmed" };

/** The members a heading's section still holds after a deletion, judged
 * against a post-delete walk — the projection behind the heading-delete
 * report ("these members stayed behind"). A pure walk projection:
 * `sectionOf(preWalk)`'s member set partitioned against `postWalk` via
 * `partitionByAbsence`. It encodes nothing about WHY the members
 * survived — the inference lives at the consumer, as wording policy.
 * A section-bearing heading with an empty member set yields `ids: []`,
 * never a refusal — suppression of an empty-member report keys on the
 * empty ids, not on an arm. */
export function orphanedMembersOf(
	preWalk: WalkedTree,
	headingId: string,
	postWalk: WalkedTree,
): OrphanedMembers {
	if (preWalk.incomplete) {
		// On an incomplete walk an absent id is unconfirmed silence, not a
		// confident absence.
		return { kind: "bound-unconfirmed" };
	}
	const row = preWalk.blocks.find((b) => b.id === headingId);
	if (row === undefined) return { kind: "not-in-pre-walk" };
	if (!isHeadingBlock(row)) return { kind: "not-a-heading" };
	const section = sectionOf(preWalk, headingId);
	// Unreachable after the guards above — remapped fail-closed; the
	// payload-free pre-mutation discriminant must not surface here.
	if (section.kind !== "section") return { kind: "bound-unconfirmed" };
	const split = partitionByAbsence(
		section.section.members.map((b) => b.id),
		postWalk,
	);
	if (split.kind === "complete") {
		return { kind: "ids", ids: split.presentIds, unconfirmedIds: [] };
	}
	return {
		kind: "ids",
		ids: split.presentIds,
		unconfirmedIds: split.unconfirmedAbsentIds,
	};
}
