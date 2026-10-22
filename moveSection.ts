// The verified section move — one call that moves a heading's whole
// section (the heading plus its member run, sub-members included) in ONE
// kernel transaction of raw `move` ops, judged from the per-touched-doc
// post-write walks. The route rides the batched-route foundation
// (`batch.ts`: `transactThenWalk`), the same foundation the batched
// delete-section consumes. The family splits:
// - moveSectionPlan.ts — the pure pre-mutation half (gates, group
//   refusals, codec); its module header is the canonical kernel-fact
//   statement (anchoring arms, scale posture; the route-wide rollback
//   facts are `batch.ts`'s).
// - this entry — the transport and the landed judgment (below, beside
//   the outcome union it arms); drift is refused by the dispatch entry
//   (`moveVerified`), before any route.

import {
	transactThenWalk,
	type BatchedUnverified,
	type TransactKernelClient,
} from "./batch.js";
import { byIdMap, idSet, siblingRunOf, type WalkedTree } from "./walk.js";
import { headingLevel, isHeadingBlock } from "./heading.js";
import { sectionOf, type AppendAnchor, type MoveAnchor } from "./placement.js";
import { sectionOwnerOf, type SectionOwner } from "./receipt.js";
import { catchMutation } from "./failure.js";
import {
	planMoveSection,
	type MoveSectionPlan,
	type MoveSectionRefusal,
} from "./moveSectionPlan.js";

/** The section-move sequence's client subset: the batched transaction
 * route plus the document-order walk. No SQL surface — the move carries
 * no fresh-content guard and every pre-mutation judgment reads the held
 * walks, so the sequence's only reads are the post-write walks. */
export type MoveSectionKernelClient = TransactKernelClient;

/** The sequence's unverified arms — the batched route's shared
 * outcome-unknown class (`batch.ts`'s `BatchedUnverified`);
 * phase-explicit so a future arm
 * cannot be added without choosing its phase (a post-mutation arm worded
 * as a refusal would invite the blind retry the failure ladder exists to
 * prevent):
 * - `kernel-refused` / `transport-unverified` — the arms' semantics are
 *   canonical on `failure.ts` (`KernelRefusal` /
 *   `JudgedTransportFailure`). Only `transport-unverified` carries the
 *   judged set — `movedIds` (members first, the heading last); a
 *   `kernel-refused` is the kernel's message alone and is NOT proof of
 *   non-application on the batched route.
 * - `walk-failed` — the batch acked but a post-write walk threw; recovery
 *   words the judged set, not a prefix (`failure.ts`'s
 *   `JudgedWalkFailure`). The `transact` throw is
 *   classified by `catchMutation`: auth/429 rethrow raw for the caller's
 *   gate, never an arm of this union. */
export type MoveSectionUnverified = BatchedUnverified;

/** Outcome of the verified section move, as a closed union — phase-explicit
 * (`refused` / `unverified` / `judged`), each arm riding its phase verbatim.
 * All-or-nothing transport — no arm ever reports a partial apply. The
 * judged arm's verdict is `MoveSectionLandedVerdict` verbatim (the judge
 * owns it); the payload details ride its field docs, the codec/rollback
 * facts live on moveSectionPlan.ts's module header.
 * - `refused` — the group refusals and the per-walk gate
 *   (`MoveSectionRefusal`), pre-mutation,
 *   zero kernel calls. Drift is absent from this union: it is refused
 *   once at `moveVerified`'s entry, before any route dispatch.
 * - `unverified` — the batched route's outcome-unknown class
 *   (`MoveSectionUnverified`).
 * - `judged` — the landed judgment rendered, clean or adverse. */
export type MoveSectionOutcome =
	| { kind: "refused"; refusal: MoveSectionRefusal }
	| { kind: "unverified"; outcome: MoveSectionUnverified }
	| { kind: "judged"; verdict: MoveSectionLandedVerdict };

/** The verified section move, whole: the pure pre-mutation half
 * (`planMoveSection` — gates, group refusals, codec, all zero-kernel-call),
 * then ONE transaction of the raw `move` ops over the batched-route
 * foundation, then the landed judgment over the per-touched-doc
 * post-write walks. The caller holds the destination walk (the flow
 * serves and seeds from it); the source walk arrives through the same
 * single fetch (same-doc the same object serves both roles). The walks
 * ride every post-mutation arm verbatim: the consumer never re-fetches
 * state a verdict already observed. */
export async function moveSectionVerified(
	client: MoveSectionKernelClient,
	input: {
		/** The moved heading — the moved section's root. */
		blockId: string;
		/** The source doc root; the source walk's provenance tripwire
		 * compares against it. */
		rootId: string;
		/** The destination doc root (≡ rootId when sameDoc). */
		destRootId: string;
		/** The source doc's pre-move walk — the caller's single fetch;
		 * same-doc the SAME object as `preDestWalk`. */
		sourceWalk: WalkedTree;
		/** The caller-held destination walk — the flow serves and seeds
		 * from it. */
		preDestWalk: WalkedTree;
		/** The destination section's heading, or undefined for the doc-end
		 * form. */
		toHeadingId?: string | undefined;
	},
): Promise<MoveSectionOutcome> {
	// Same-doc is the two roots' agreement — derived, never caller-supplied
	// (the walks and judgments downstream key their doc roles on it).
	const sameDoc = input.rootId === input.destRootId;
	// Drift is refused once, at `moveVerified`'s entry, with the probe
	// this sequence is dispatched under.
	const planned = planMoveSection({
		blockId: input.blockId,
		toHeadingId: input.toHeadingId,
		rootId: input.rootId,
		destRootId: input.destRootId,
		sourceWalk: input.sourceWalk,
		destWalk: input.preDestWalk,
	});
	if (planned.kind !== "planned") return { kind: "refused", refusal: planned };
	const plan = planned.plan;
	// The judged set in issued order — members first, the heading last.
	const movedIds = [...plan.memberIds, plan.headingId];
	const rootIds: [string] | [string, string] = sameDoc
		? [input.rootId]
		: [input.rootId, input.destRootId];
	const batched = await transactThenWalk(client, {
		operations: plan.ops,
		rootIds,
	});
	if (batched.kind === "transact-failed") {
		// No ack: the whole judged set is what may be gone.
		return {
			kind: "unverified",
			outcome: catchMutation(batched.error, movedIds),
		};
	}
	if (batched.kind === "walk-failed") {
		return {
			kind: "unverified",
			outcome: {
				kind: "walk-failed",
				error: batched.error,
				judgedBlockIds: movedIds,
			},
		};
	}
	// Same-doc the destination walk IS the source walk; the second slot is
	// guaranteed by the route's two-root contract.
	const postSourceWalk = batched.walks[0];
	const postDestWalk = sameDoc ? postSourceWalk : batched.walks[1]!;
	// The landed judgment runs post-ack: a throw from it (its internal
	// guards) must ride the batched route's outcome-unknown class, never
	// escape over a committed batch as a bare error.
	try {
		return {
			kind: "judged",
			verdict: judgeMoveSectionLanded({
				plan,
				sameDoc,
				toHeadingId: input.toHeadingId,
				preDestWalk: input.preDestWalk,
				postSourceWalk,
				postDestWalk,
			}),
		};
	} catch (error) {
		return {
			kind: "unverified",
			outcome: {
				kind: "walk-failed",
				error,
				judgedBlockIds: movedIds,
			},
		};
	}
}

/** The landed arm's destination payload — the relation beside the two
 * compared walked levels it was judged from: the level comparison
 * alone, judged off the post-write destination walk on BOTH anchoring
 * arms (the boundary arm's guard is only
 * `movedLevel < boundaryLevel`, so a boundary shallower than the
 * destination can still land the run at the destination's level or
 * deeper):
 * - `nested` — the moved heading is deeper than the destination: it sits
 *   inside the destination section;
 * - `sibling-after` — the same level: the landing terminates the
 *   destination section and sits after it as a sibling section of the
 *   same container, not inside it (the primary way to reorder sibling
 *   sections — a capability, never a refusal);
 * - `shallower-after` — shallower than the destination: the landing
 *   terminates the destination section at the moved heading's own
 *   level, so it sits after the section rather than beside it (the
 *   `sibling-after` sentence would be untrue there);
 * - `destination-gone` — the destination heading is absent from the
 *   complete post-write destination walk, or present but no longer a
 *   heading row there (a concurrent delete or retype landed between the
 *   walk and the batch): the landed clauses never read the
 *   destination heading itself, so both anchoring arms can stay
 *   satisfiable while the level relation goes unjudgeable — named,
 *   never silently omitted and never a refusal (the move itself
 *   landed).
 *
 * Discriminated on `relation` so `destinationLevel` is structurally
 * absent on `destination-gone` — the destination row is what is gone. */
export type MoveSectionDestination =
	| {
			relation: "nested" | "sibling-after" | "shallower-after";
			/** The moved heading's walked level — the receipt's diagnosis pair
			 * (the arm carries the levels it words). */
			movedLevel: number;
			/** The destination heading's walked level — the comparison's other
			 * half. Present exactly when the destination row was judged. */
			destinationLevel: number;
	  }
	| { relation: "destination-gone" };

/** The landed judgment's return — the outcome union's post-mutation arms,
 * declared here so the judge owns them: the judged phase's `verdict` is
 * this union verbatim, so a post-mutation arm exists only if this judge
 * can return it. */
export type MoveSectionLandedVerdict =
	| {
			kind: "landed";
			/** The landed run in document order as the post-write destination
			 * walk holds it: the heading, then the members. */
			landedIds: string[];
			/** The moved heading's own words — the receipt names the section
			 * by its title (the id stays beside it in the payload). */
			headingContent: string;
			/** The moved heading's new owner — `null` names the container/doc
			 * root (the landing terminates its container's section and owns
			 * only its members). */
			owner: SectionOwner;
			/** The codec's own anchor, in placement's vocabulary — the
			 * boundary arm the append codec's insert anchor (the run sits
			 * immediately before it), the chain arm the move codec's anchor
			 * (the `at` position rides it). */
			anchor: AppendAnchor | MoveAnchor;
			/** The chain arm's benign tail extension: a concurrent append
			 * heading that now bounds the landed run (the pre-move boundary
			 * was null — nothing of the pre-move account sits there). */
			tailExtensionId?: string | undefined;
			/** The landing's relation to a targeted destination heading —
			 * present only when the move carried a `toHeadingId` (the doc-end
			 * form carries no relation and the receipt words no sentence for
			 * it). The arms, the levels, and the comparison live on
			 * `MoveSectionDestination`. */
			destination?: MoveSectionDestination | undefined;
			postSourceWalk: WalkedTree;
			postDestWalk: WalkedTree;
	  }
	| {
			kind: "landed-divergent";
			/** The whole judged set (members, then the heading) — what recovery
			 * re-issues when wording a break, without re-deriving the plan. */
			judgedBlockIds: string[];
			/** The run head's pre-order index into the post-write destination
			 * walk's blocks, or null when the run is absent from the complete
			 * walk (destination complete, a source-side member vanished). */
			landedAtIndex: number | null;
			/** Landed members outside the enumerated set — span (the
			 * drag-at-front shape) and tail (the concurrent-append swallow)
			 * alike. */
			unjudgedIds: string[];
			/** Cross-doc only: enumerated ids still visible in the complete
			 * post-write source walk — the copy case (a copy means the move
			 * did not land). Empty same-doc. */
			stillInSourceIds: string[];
			postSourceWalk: WalkedTree;
			postDestWalk: WalkedTree;
	  }
	| {
			kind: "nothing-moved";
			judgedBlockIds: string[];
			postSourceWalk: WalkedTree;
			postDestWalk: WalkedTree;
	  }
	| {
			kind: "post-walk-truncated";
			judgedBlockIds: string[];
			postSourceWalk: WalkedTree;
			postDestWalk: WalkedTree;
	  };

/** The landed judgment over the post-write walks — the stated predicate,
 * not a phrase. Fixed arm order: `nothing-moved` first (positive facts
 * over the seen span — presence is sound on an incomplete walk, so
 * survivors/pre-move state outrank truncation), then
 * `post-walk-truncated` (a truncated walk grounds neither landing nor
 * absence), then the landed arms over the complete walks.
 *
 * - `nothing-moved` — the batch did not apply: cross-doc, every
 *   enumerated id still present in the post-write source walk AND the
 *   run head absent from a COMPLETE post-write destination walk (its
 *   presence there means the batch copied — a divergent arm, never a
 *   rollback; the rollback recovery's re-issue would duplicate the
 *   section; absence over a truncated walk is unconfirmed and falls to
 *   `post-walk-truncated`); same-doc, neighbour identity over the
 *   single walk (`neighborRunIntact`). Set membership alone cannot
 *   distinguish landed from a silent no-op same-doc, and the positional
 *   clauses alone would read a false `landed` over a rollback of a
 *   mid-section move — hence the fixed order.
 * - `post-walk-truncated` — a needed post-write walk is incomplete: the
 *   absence facts are unconfirmed. The nothing-moved arms that read
 *   only presence already returned where they applied.
 * - `landed` — the codec mechanics the judgment reads are the plan
 *   header's (its boundary arm's insert-before anchor, its chain arm's
 *   `previousID` anchor). Clause (a): the landed section's member run
 *   equals the enumerated run exactly, in landed order (the
 *   strictly-shallower swallow is refused pre-mutation, so the landed
 *   section claims nothing beyond the moved members); clause (b): on
 *   the boundary arm, the landed section's boundary is the pre-move
 *   boundary — the plan's boundary anchor, the run it leaves
 *   immediately before. Clause (b) is sound only because the plan's
 *   `trailing-run` refusal stands: a silent rollback can satisfy both
 *   clauses only where the run already trailed the destination section.
 *   On the chain arm, the landed section's boundary is null (the
 *   container's end) or a concurrent append heading (the tail
 *   extension), and the landed run head sits after the plan's chain
 *   anchor with only concurrent inserts between them — the rollback
 *   discriminator the neighbour-identity leg cannot supply once a
 *   concurrent insert precedes the run. The owner certification rides
 *   the landed arm (`sectionOwnerOf`) — reporting, never a level
 *   rewrite.
 * - `landed-divergent` — the run broke: exact equality failed (a drag
 *   landed inside the span, a concurrent append was swallowed into the
 *   tail), a still-in-source member (cross-doc copy), the run's head is
 *   absent from the complete destination walk, the boundary arm's
 *   boundary changed, or the chain arm's interval check failed (the
 *   payload fields carry the extras and the head's index). */
export function judgeMoveSectionLanded(input: {
	/** The plan the transport issued — the moved set, the anchoring, and
	 * the anchor the predicate judges against, structurally the plan's own
	 * fields. */
	plan: MoveSectionPlan;
	sameDoc: boolean;
	/** The pre-move destination walk — same-doc the single shared walk
	 * (the same-doc neighbour check reads the run's pre-move shape off
	 * it); cross-doc the chain arm's interval reads its membership (the
	 * siblings between the anchor and the run head must all be
	 * concurrent inserts). */
	preDestWalk: WalkedTree;
	/** The destination heading the move targeted, when it did — the
	 * destination relation's subject. Absent on the doc-end form. The
	 * plan refuses `toHeadingId === headingId` pre-mutation
	 * (`own-closure`), so a present `toHeadingId` always names a heading
	 * other than the moved one. */
	toHeadingId?: string | undefined;
	postSourceWalk: WalkedTree;
	postDestWalk: WalkedTree;
}): MoveSectionLandedVerdict {
	// The predicate's own set — heading first; the arms' `judgedBlockIds`
	// attach in the sequence's issued order (members first, heading last).
	const movedIds = [input.plan.headingId, ...input.plan.memberIds];
	const judgedBlockIds = [...input.plan.memberIds, input.plan.headingId];
	const sourceIds = input.sameDoc
		? undefined
		: idSet(input.postSourceWalk.blocks);
	if (input.sameDoc) {
		if (
			neighborRunIntact(
				input.preDestWalk,
				input.postDestWalk,
				input.plan.headingId,
				input.plan.memberIds,
			)
		) {
			return {
				kind: "nothing-moved",
				judgedBlockIds,
				postSourceWalk: input.postSourceWalk,
				postDestWalk: input.postDestWalk,
			};
		}
	} else if (
		movedIds.every((id) => sourceIds!.has(id)) &&
		// Head absence is a negative fact — sound only over a complete
		// walk; past MAX_WALK_DEPTH the head may sit below the cut.
		!input.postDestWalk.incomplete &&
		!idSet(input.postDestWalk.blocks).has(input.plan.headingId)
	) {
		return {
			kind: "nothing-moved",
			judgedBlockIds,
			postSourceWalk: input.postSourceWalk,
			postDestWalk: input.postDestWalk,
		};
	}
	// Truncation: a truncated walk grounds neither landing nor absence.
	if (input.postSourceWalk.incomplete || input.postDestWalk.incomplete) {
		return {
			kind: "post-walk-truncated",
			judgedBlockIds,
			postSourceWalk: input.postSourceWalk,
			postDestWalk: input.postDestWalk,
		};
	}
	// Cross-doc copy check — presence in the complete source walk.
	const stillInSourceIds =
		sourceIds === undefined ? [] : movedIds.filter((id) => sourceIds.has(id));
	// The landed arms, over the complete walks. The four landed-divergent
	// returns share every field but the index.
	const landedAtIndex = input.postDestWalk.blocks.findIndex(
		(b) => b.id === input.plan.headingId && isHeadingBlock(b),
	);
	const divergent = (
		index: number | null,
		unjudged: string[] = [],
		stillIn: string[] = [],
	) => ({
		kind: "landed-divergent" as const,
		judgedBlockIds,
		landedAtIndex: index,
		unjudgedIds: unjudged,
		stillInSourceIds: stillIn,
		postSourceWalk: input.postSourceWalk,
		postDestWalk: input.postDestWalk,
	});
	if (landedAtIndex < 0) {
		return divergent(null, [], stillInSourceIds);
	}
	const postSection = sectionOf(input.postDestWalk, input.plan.headingId);
	// Unreachable on a complete walk with the heading row present.
	if (postSection.kind !== "section") {
		throw new Error(
			`internal: landed judgment over an unwalkable section (${postSection.kind})`,
		);
	}
	const landedMemberIds = postSection.section.members.map((b) => b.id);
	const runExact =
		landedMemberIds.length === input.plan.memberIds.length &&
		input.plan.memberIds.every((id, i) => landedMemberIds[i] === id);
	// `runExact` already covers the unjudged presences: exact equality
	// means the landed span is exactly the enumerated run. The extras stay
	// the divergent report's evidence.
	const unjudgedIds = landedMemberIds.filter((id) => !movedIds.includes(id));
	if (!runExact || stillInSourceIds.length > 0) {
		return divergent(landedAtIndex, unjudgedIds, stillInSourceIds);
	}
	if (input.plan.anchoring.arm === "boundary") {
		const postBoundaryId = postSection.section.boundary?.id ?? null;
		if (postBoundaryId !== input.plan.anchorId) {
			return divergent(landedAtIndex);
		}
	} else {
		// Chain arm: the landed run head must sit after the anchor in the
		// same sibling run, and every sibling between them must be absent
		// from the pre-move destination walk (a concurrent insert). A
		// rollback whose neighbour context a concurrent insert disturbed
		// fails: pre-move blocks still sit between the anchor and the head.
		// The interval form, not strict adjacency, is what the fold redirect
		// needs — a folded anchor heading displaces the landing past blocks
		// appended after it, while the codec's anchor recursion keeps the
		// interval empty on every clean landing.
		const headRow = input.postDestWalk.blocks[landedAtIndex];
		const run =
			headRow === undefined
				? []
				: siblingRunOf(input.postDestWalk.blocks, headRow.parentId);
		const headIdx = run.findIndex((b) => b.id === input.plan.headingId);
		const anchorIdx = run.findIndex((b) => b.id === input.plan.anchorId);
		const preDestIds = idSet(input.preDestWalk.blocks);
		if (
			headIdx < 0 ||
			anchorIdx < 0 ||
			anchorIdx >= headIdx ||
			run.slice(anchorIdx + 1, headIdx).some((b) => preDestIds.has(b.id))
		) {
			return divergent(landedAtIndex);
		}
	}
	const owner = sectionOwnerOf(input.postDestWalk, input.plan.headingId);
	// Unreachable — the landed clause read the heading off this same
	// complete walk.
	if (owner.kind !== "owner") {
		throw new Error(`internal: owner projection refused (${owner.kind})`);
	}
	// The moved heading's own walked level against the destination
	// heading's — the comparison alone.
	let destination: MoveSectionDestination | undefined;
	if (input.toHeadingId !== undefined) {
		const movedLvl = headingLevel(postSection.section.heading);
		const destRow = byIdMap(input.postDestWalk.blocks).get(input.toHeadingId);
		if (destRow === undefined || !isHeadingBlock(destRow)) {
			destination = { relation: "destination-gone" };
		} else {
			const destLvl = headingLevel(destRow);
			destination = {
				relation:
					movedLvl > destLvl
						? "nested"
						: movedLvl === destLvl
							? "sibling-after"
							: "shallower-after",
				movedLevel: movedLvl,
				destinationLevel: destLvl,
			};
		}
	}
	return {
		kind: "landed",
		landedIds: [input.plan.headingId, ...landedMemberIds],
		headingContent: postSection.section.heading.content,
		owner: owner.owner,
		anchor:
			input.plan.anchoring.arm === "boundary"
				? { kind: "insert", nextID: input.plan.anchorId }
				: {
						kind: "move",
						previousID: input.plan.anchorId,
						at: input.plan.anchoring.anchorAt,
					},
		tailExtensionId:
			input.plan.anchoring.arm === "chain"
				? (postSection.section.boundary?.id ?? undefined)
				: undefined,
		destination,
		postSourceWalk: input.postSourceWalk,
		postDestWalk: input.postDestWalk,
	};
}

/** The same-doc `nothing-moved` leg: sibling-run neighbour identity. The
 * run's pre-move predecessor (its previous SIBLING in its container, or
 * null when the run head is first) must still immediately precede the
 * heading among
 * the post-move siblings, and the enumerated members must follow in
 * enumerated order. Sibling-shaped, not index-shaped: a concurrent
 * earlier insertion (a new sibling between the predecessor and the run)
 * must not break the check — the layout the batch would have to have
 * changed is the run's own position relative to its neighbours. */
function neighborRunIntact(
	preWalk: WalkedTree,
	postWalk: WalkedTree,
	headingId: string,
	memberIds: string[],
): boolean {
	const preRow = preWalk.blocks.find((b) => b.id === headingId);
	if (preRow === undefined) return false;
	const containerId = preRow.parentId;
	const preRun = siblingRunOf(preWalk.blocks, containerId);
	const preIdx = preRun.findIndex((b) => b.id === headingId);
	// The enumerated run derives from this very walk — unreachable;
	// fail-closed toward the landed arms.
	if (preIdx < 0) return false;
	const prePrevId = preIdx > 0 ? (preRun[preIdx - 1]?.id ?? null) : null;
	const postRun = siblingRunOf(postWalk.blocks, containerId);
	const postIdx = postRun.findIndex((b) => b.id === headingId);
	if (postIdx < 0) return false;
	const postPrevId = postIdx > 0 ? (postRun[postIdx - 1]?.id ?? null) : null;
	if (postPrevId !== prePrevId) return false;
	const following = postRun.slice(postIdx + 1, postIdx + 1 + memberIds.length);
	return memberIds.every((id, i) => following[i]?.id === id);
}
