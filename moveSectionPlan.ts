// The section move's pure pre-mutation half — the transport and the
// landed judgment live in `moveSection.ts` (whose header designates this
// module the canonical home of the codec and scale-posture kernel facts;
// the route-wide rollback facts are `batch.ts`'s).
//
// Kernel facts (the live suite rehearses them in place on every upgrade
// pass):
//
// - The codec is the insert-before (`nextID`) arm: a raw `move` op reads
//   `nextID` first (`doMove`, transaction.go) and inserts immediately
//   before the anchor — the `moveBefore` branch, which the fold redirect
//   cannot reach (`!moveBefore` guards it), so any anchor is a literal
//   position, fold-blind. The per-op `moveBlock` route honours only
//   `previousID`/`parentID`, so this arm exists only as raw ops inside one
//   transaction — the property that makes the codec fold-blind,
//   order-preserving, and free of single-use-anchor hazards.
// - Boundary arm: the members issue in document order, each
//   `nextID = <the destination section's boundary>` (the next heading at
//   level ≤ the destination heading's — `sectionOf`'s boundary), then the
//   heading `nextID = <the first landed member>`; a memberless section
//   issues only the heading leg (`nextID = <the boundary>`). The members
//   accumulate in document order before the boundary and the heading lands
//   between the destination section's last pre-existing block and the
//   first member: end-of-section semantics, no reverse order.
// - Chain arm (the destination section has no following boundary — it is
//   its container's last, which includes the document's last section):
//   the members chain `previousID` in document order from
//   `deriveMoveAnchor`'s projection — the destination section's last
//   member, recursing into it while it is a heading, so the anchor is a
//   leaf, a container, or a heading with an EMPTY section (the
//   empty-destination fixed point is the destination heading itself,
//   fold-independent while its section stays empty — the redirect has no
//   target) — and the heading issues last on the boundary arm's own leg
//   (`nextID = <the first landed member>`); a memberless section issues a
//   single heading leg (`previousID = <the chain anchor>`). The chain legs
//   are explicit `previousID` ops: an op with every anchor empty rolls the
//   batch back behind code 0, so no leg is ever issued anchorless.
// - Doc-end form (no `toHeadingId`): the destination is the document's
//   end; the chain anchor is the destination doc's last root-level block
//   (`deriveMoveAnchor`'s omitted-id arm — a positive projection over the
//   root-level sibling run, which truncation cannot shorten, on a walk
//   the destination gate below has proven complete). The kernel
//   never leaves a doc childless (a deleted paragraph is re-minted), so
//   the `append`-kind anchor is unreachable — and a `parentID` batch
//   would prepend at the document's start in reversed order (live-pinned),
//   so the shape fails closed rather than issues.
// - The anchors are container-local sibling positions: a destination
//   section inside a quote, callout, list, or superblock re-nests the
//   moved members into that container (the section rule's locality, the
//   same rule `append` obeys), and the sibling insert is anchor-type-blind
//   across the whole container vocabulary. The landed judgment pins the
//   container for free — the anchor and the run read as siblings wherever
//   they landed — and the owner report says where the section attached.
// - No single-use-anchor hazard: every `nextID` anchor is addressed once,
//   after the state it names is already final; the chain arm's
//   `previousID` legs each address their anchor exactly once, and the one
//   block addressed twice (the first landed member: `previousID` by the
//   next member's leg, `nextID` by the heading leg) is fold-blind on its
//   `nextID` side. No LIFO rule and no shared-anchor hazard.
// - The moved set: `sectionOf(sourceHeading).members` in document order —
//   every block of the run issued, sub-members included (the run is flat
//   at the heading's container level, so a subsection heading and its body
//   each get their own op) — while descendants
//   below the run's blocks (a list's items) ride their container. A leg
//   whose source node is self-folded drags that node's current children
//   with it (`resolveHeadingMoveChildren` fires on any self-folded
//   heading); the drag lands at the front of that leg's run — always
//   inside the enumerated span, where the landed judgment's
//   unjudged-presence clause names it. Currency is as of the enumeration:
//   a block appended to the source section after enumeration is not in the
//   moved set (the unfolded case leaves it in the source — the receipt
//   must not overstate; the folded case is dragged and judged divergent).
// - Cross-doc is in scope: each leg is a same-kernel `move` op (block ids
//   are kernel-global; plain↔plain cross-notebook moves apply natively),
//   and the judgment is per-touched-doc. Cross-box is policy: the flows
//   resolve `toDocId` box-scoped before the primitive runs, so no box arm
//   exists here.
// - Rollback posture: the route-wide facts are `batch.ts`'s (whole-batch
//   rollback behind HTTP code 0, the cause-free failure channel, the
//   residue a rollback leaves). The move-specific consequences: a
//   same-doc rollback leaves the source ids resolvable (the root never
//   changes — self-converging on the doc's next committed write), a
//   cross-doc one leaves wrong-root rows that resolve not-found — never
//   a wrong block; the cause-free landing is the `nothing-moved` arm,
//   and the heal-then-retry-once doctrine is the consumer's wording,
//   not this module's.
// - Scale posture: move batches always take the kernel's per-op execution
//   path (the ≥32 bulk path collects only delete ops — batch.ts — and
//   every op of a move batch is non-delete), and each op runs
//   two full-tree upserts inside the kernel's global transaction lock —
//   the kernel's write queue is FIFO on client timestamp, so a large
//   section move delays every other write in the session for that window.

import type { TransactionOperation } from "siyuan-kernel-api";
import type { WalkedTree } from "./walk.js";
import { headingLevel, type SectionRefusal } from "./heading.js";
import {
	deriveMoveAnchor,
	sectionSubjectOf,
	type Section,
} from "./placement.js";
import { foreignRefusalOf, type ForeignRefusal } from "./byId.js";

/** The pre-mutation group refusal family — group-level (judged over the
 * moved set as a whole), pre-mutation, zero kernel calls. The source
 * walk is fetched by `rootId` itself, so the source-side `foreign` and
 * `heading-absent` arms cannot fire through `moveVerified`; the
 * destination walk's root is gated at `moveVerified`'s dispatch entry
 * before either route consumes it (the load-bearing provenance check —
 * the per-id route issues `previousID` off that walk). The plan's own
 * `foreign` arms stay as the direct-caller fail-closed tripwires
 * (`moveSectionVerified` is off the barrel); the consumer narrows
 * `kind`/`role` structurally. The refusals name conditions that would
 * otherwise only surface as the kernel's silent whole-batch rollback
 * behind HTTP success (reported cause-free by `nothing-moved`):
 * - `own-closure` — `toHeadingId` names the moved heading itself, or the
 *   destination heading lies inside what the move transports, judged over
 *   the moved section's CLOSURE (`sectionOf(sourceHeading).closure`),
 *   never the sibling-id set: a destination heading nested inside a
 *   container member's subtree is transported with the move yet invisible
 *   to the members. The refusal's value is diagnosability — a precise
 *   pre-mutation message instead of the silent rollback.
 * - `shallower-than-boundary` — the moved heading is strictly shallower
 *   than the destination section's boundary (boundary arm only): the
 *   landing would not be terminated by the boundary, so the moved section
 *   would swallow the destination's boundary heading and the sections
 *   after it into itself — the outline corruption this mode exists to
 *   prevent. The mode never rewrites levels, so it refuses rather than
 *   reports.
 * - `already-at-destination` — the group is already at the destination,
 *   derived two ways (`derivation` names which): `boundary-in-set` — the
 *   destination section's boundary is the moved heading itself, so the
 *   member legs would anchor on a block that travels with the batch;
 *   `trailing-run` — the moved section is already the destination
 *   section's trailing run (the memberless degenerate compares the
 *   heading itself), or — the doc-end form — the moved section already
 *   occupies the document's end. Either way the batch would issue only
 *   position-preserving re-inserts and the landed predicate would read a
 *   false `landed` over the no-op. The `trailing-run` derivation is also
 *   the boundary arm's rollback discriminator — the landed judge's
 *   clause (b) rests on it (moveSection.ts). `destination` carries the
 *   destination form the plan was derived under. */
export type MoveSectionRefusal =
	// The per-walk gate arm — its arms and their reachability are
	// docstringed above.
	| {
			kind: "walk-refused";
			role: "source" | "destination";
			refusal: SectionRefusal | ForeignRefusal;
	  }
	| { kind: "own-closure"; blockId: string; toHeadingId: string }
	| {
			kind: "shallower-than-boundary";
			blockId: string;
			boundaryId: string;
			headingLevel: number;
			boundaryLevel: number;
	  }
	| {
			kind: "already-at-destination";
			blockId: string;
			derivation: "boundary-in-set" | "trailing-run";
			/** The destination form the plan was derived under — the
			 * consumer's wording keys on it, never on the caller's params
			 * (the verdict carries its evidence). */
			destination: "section" | "doc-end";
	  };

/** The plan's anchoring, tagged by arm — the landed judgment's tail
 * clause keys on it, and the verdict carries the arm's codec anchor
 * (`AppendAnchor` on the boundary arm, `MoveAnchor` on the chain arm).
 * The chain arm carries the chain anchor's position (`deriveMoveAnchor`'s
 * own `at`); the boundary arm carries no position. The arms and their
 * anchor semantics: the module header. */
type MoveSectionAnchoring =
	| { arm: "boundary" }
	| { arm: "chain"; anchorAt: "doc-end" | "section-end" };

/** The derived batch: the moved set, the arm, the anchors, and the op
 * array — the derived half of what the transport and the landed judgment
 * consume, all derived from the two walks the sequence already holds (the
 * caller inputs — `toHeadingId`, the walks — ride beside it). Pure: no
 * kernel calls, and the derivation IS the source-side guard (the
 * moved set is read off the source walk and never caller-supplied, so no
 * gate miss can issue raw `move` ops for another doc's blocks). */
export interface MoveSectionPlan {
	/** The moved heading — the batch's last issued op. */
	headingId: string;
	/** The moved member run in document order — the batch's first issued
	 * ops (the moved-set rule: the module header). */
	memberIds: string[];
	anchoring: MoveSectionAnchoring;
	/** The codec's anchor id — the destination section's boundary
	 * id on the boundary arm (the member legs' `nextID`), the chain anchor
	 * on the chain arm (the first member leg's `previousID`). Always
	 * defined — the codec never issues an anchorless op. It is also the
	 * landed predicate's positional discriminator: on the boundary arm the
	 * landed section's boundary must still be it (the run sits immediately
	 * before it); on the chain arm the landed run head must sit after it
	 * with only concurrent inserts between them — the check that keeps a
	 * rollback whose neighbour context a concurrent insert disturbed from
	 * reading `landed` (the neighbour-identity `nothing-moved` leg is blind
	 * to exactly that disturbance). */
	anchorId: string;
	/** The op array in issue order — members first, heading last. */
	ops: TransactionOperation[];
}

export type MoveSectionPlanResult =
	| { kind: "planned"; plan: MoveSectionPlan }
	| MoveSectionRefusal;

/** The chain arm's anchor: the destination's derived move anchor,
 * narrowed to the shape the codec issues. The refused shapes are
 * internal invariants (the doc-end form — the kernel never leaves a doc
 * childless), and the destination gate refused truncation and absence. */
function chainAnchorOf(
	walk: WalkedTree,
	toHeadingId: string | undefined,
): { anchorId: string; anchorAt: "doc-end" | "section-end" } {
	const anchor = deriveMoveAnchor(walk, toHeadingId);
	if (anchor.kind === "append") {
		throw new Error(
			"internal: doc-end move anchor on a childless destination doc",
		);
	}
	if (anchor.kind !== "move") {
		throw new Error(
			`internal: destination move anchor refused (${anchor.kind})`,
		);
	}
	return { anchorId: anchor.previousID, anchorAt: anchor.at };
}

/** The pre-mutation half, pure: the per-walk gates, the group refusals,
 * and the codec derivation, all over the two walks the sequence already
 * holds — zero kernel calls in any refusal. Judgment order: the source
 * gate, the identity leg of `own-closure`, the destination gate (its
 * `foreign` arm is the defined form's fail-closed tripwire —
 * `moveVerified`'s dispatch gate owns destination provenance), the
 * closure leg of `own-closure`, `shallower-than-boundary`, the two
 * `already-at-destination` derivations, then the codec. */
export function planMoveSection(input: {
	blockId: string;
	/** The destination section's heading, or undefined for the doc-end
	 * form (the document's end is the destination). */
	toHeadingId: string | undefined;
	rootId: string;
	destRootId: string;
	/** The source doc's pre-move walk — the caller's single fetch. Its
	 * root id is checked against `rootId` (the tripwire: unreachable when
	 * the caller fetched it by that same root). */
	sourceWalk: WalkedTree;
	/** The caller-held destination walk — same-doc the SAME walk object
	 * (one walk serves both roles). */
	destWalk: WalkedTree;
}): MoveSectionPlanResult {
	const source = sectionSubjectOf(
		input.sourceWalk,
		input.rootId,
		input.blockId,
	);
	if (source.kind !== "section") {
		return { kind: "walk-refused", role: "source", refusal: source };
	}
	if (input.toHeadingId === input.blockId) {
		return {
			kind: "own-closure",
			blockId: input.blockId,
			toHeadingId: input.toHeadingId,
		};
	}
	// Doc-end form: the destination walk is consumed only for the chain
	// anchor's derivation; its root and completeness are gated here
	// (without the completeness gate an empty span would reach the anchor
	// tripwire as a throw). The defined form's destination gate below
	// rides `sectionOf`, which carries both arms itself.
	if (input.toHeadingId === undefined) {
		const foreign = foreignRefusalOf(
			input.destWalk,
			input.destRootId,
			input.destRootId,
		);
		if (foreign !== undefined) {
			return {
				kind: "walk-refused",
				role: "destination",
				refusal: foreign,
			};
		}
		if (input.destWalk.incomplete) {
			return {
				kind: "walk-refused",
				role: "destination",
				refusal: { kind: "walk-truncated" },
			};
		}
	}
	let destSection: Section | null = null;
	if (input.toHeadingId !== undefined) {
		const dest = sectionSubjectOf(
			input.destWalk,
			input.destRootId,
			input.toHeadingId,
		);
		if (dest.kind !== "section") {
			return { kind: "walk-refused", role: "destination", refusal: dest };
		}
		// The closure leg: the destination heading inside what the move
		// transports (the closure containment shape — invisible to the
		// sibling-id set).
		if (source.section.closure.some((b) => b.id === input.toHeadingId)) {
			return {
				kind: "own-closure",
				blockId: input.blockId,
				toHeadingId: input.toHeadingId,
			};
		}
		destSection = dest.section;
	}
	const boundary = destSection === null ? null : destSection.boundary;
	// The anchoring, tagged by arm: the boundary arm anchors on the
	// destination section's boundary heading, the chain arm on the
	// destination's derived move anchor. The tag makes the codec's anchor
	// reads total — no non-null assertions.
	const anchoring =
		boundary !== null
			? { arm: "boundary" as const, anchorId: boundary.id }
			: {
					arm: "chain" as const,
					...chainAnchorOf(input.destWalk, input.toHeadingId),
				};
	if (boundary !== null) {
		const movedLevel = headingLevel(source.section.heading);
		const boundaryLevel = headingLevel(boundary);
		if (movedLevel < boundaryLevel) {
			return {
				kind: "shallower-than-boundary",
				blockId: input.blockId,
				boundaryId: boundary.id,
				headingLevel: movedLevel,
				boundaryLevel,
			};
		}
	}
	const destination = input.toHeadingId === undefined ? "doc-end" : "section";
	// `already-at-destination`, derivation 1 (`boundary-in-set`). The
	// transported-closure leg is unreachable:
	// the boundary is a sibling of the destination heading, so a boundary
	// inside the moved closure forces the destination heading into it too,
	// which the `own-closure` arm refuses above.
	if (boundary?.id === input.blockId) {
		return {
			kind: "already-at-destination",
			blockId: input.blockId,
			derivation: "boundary-in-set",
			destination,
		};
	}
	// Derivation 2 (`trailing-run`) — the union arm's reads; on the
	// doc-end form the chain anchor inside the transported set (the moved
	// run already occupies the document's end).
	const lastMovedId = source.section.members.at(-1)?.id ?? input.blockId;
	if (destSection !== null) {
		const destMembers = destSection.members;
		if (
			destMembers.some((m) => m.id === input.blockId) &&
			destMembers.at(-1)?.id === lastMovedId
		) {
			return {
				kind: "already-at-destination",
				blockId: input.blockId,
				derivation: "trailing-run",
				destination,
			};
		}
	} else if (
		anchoring.anchorId === input.blockId ||
		source.section.closure.some((b) => b.id === anchoring.anchorId)
	) {
		return {
			kind: "already-at-destination",
			blockId: input.blockId,
			derivation: "trailing-run",
			destination,
		};
	}
	// The codec. Members first (document order), heading last; every leg
	// carries exactly one anchor, and no anchor is ever empty.
	const members = source.section.members;
	const firstMemberId = members[0]?.id;
	const anchorId = anchoring.anchorId;
	const ops: TransactionOperation[] = [];
	if (anchoring.arm === "boundary") {
		for (const member of members) {
			ops.push({ action: "move", id: member.id, nextID: anchorId });
		}
		ops.push(
			firstMemberId === undefined
				? { action: "move", id: input.blockId, nextID: anchorId }
				: { action: "move", id: input.blockId, nextID: firstMemberId },
		);
	} else {
		let previousID = anchorId;
		for (const member of members) {
			ops.push({ action: "move", id: member.id, previousID });
			previousID = member.id;
		}
		ops.push(
			firstMemberId === undefined
				? { action: "move", id: input.blockId, previousID: anchorId }
				: { action: "move", id: input.blockId, nextID: firstMemberId },
		);
	}
	return {
		kind: "planned",
		plan: {
			headingId: input.blockId,
			memberIds: members.map((b) => b.id),
			anchoring:
				anchoring.arm === "boundary"
					? { arm: "boundary" as const }
					: {
							arm: "chain" as const,
							anchorAt: anchoring.anchorAt,
						},
			anchorId,
			ops,
		},
	};
}
