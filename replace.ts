// The replace-section sequence — enumeration, anchor, insert, then the
// batched delete leg. The delete half rides the shared section-delete core
// (`sectionDeleteCore.ts`) composed with `includeHeading: false` — the
// plan phase runs BEFORE the insert (its refusals keep their
// pre-first-mutation position, so the fresh refusal keeps its "nothing
// landed" meaning), the apply phase runs after the insert has landed and
// been certified. The ordering rationale lives in the entry point's doc
// below.

import type { KernelProbeResult } from "./version.js";
import { idSet, type WalkedTree } from "./walk.js";
import type { BatchedRefusal } from "./batch.js";
import type { BaselineLookup } from "./fresh.js";
import { appendAnchorOf, type AppendAnchor } from "./placement.js";
import {
	type InsertKernelClient,
	insertVerified,
	type InsertUnlandedVerdict,
} from "./insert.js";
import {
	sectionDeleteApply,
	sectionDeletePlan,
	type SectionDeleteApplyJudgedPhase,
	type SectionDeleteApplyUnverifiedPhase,
	type JudgedSectionBlock,
} from "./sectionDeleteCore.js";
import type { SqlClient, TransactClient } from "./client.js";
import {
	refuseDrift,
	type DriftFailure,
	type MutationFailure,
} from "./failure.js";

/** The client subset the sequence needs: the insert leg's client, the
 * batched route the delete leg rides (the shared transact contract,
 * single-homed in client.ts), and the SQL surface the fresh-content
 * guard's seed read rides (the judgment runs inside the core, over the
 * caller-held walk). WriteKernelClient satisfies it. */
export type ReplaceKernelClient = InsertKernelClient &
	TransactClient &
	SqlClient;

/** The replacement-survival reading `replacementSurvivalOf` produces when
 * the replacement is NOT in the post-write walk: `cascade-consumed` on a
 * complete walk (data loss — the cascade explanation is live), or
 * `unconfirmed` on a truncated one (absence is not sound evidence there).
 * A present replacement reads `undefined` — positively certified, not
 * merely unrefused. */
export type ReplacementSurvivalReading = "cascade-consumed" | "unconfirmed";

/** The replacement-survival judgment over a post-write walk and the
 * replacement's id: absent from a COMPLETE walk reads `cascade-consumed`
 * (data loss, never renderable as ok — the cascade explanation is live
 * even when survivors ride the same walk), absent from a TRUNCATED walk
 * reads `unconfirmed` (absence is unsound on an incomplete walk), present
 * reads `undefined`. Pure judgment, no probe — the module-internal receipt
 * wording consumes it, and its unit and live suites falsify the judgment
 * by driving it directly over a walked post state. */
export function replacementSurvivalOf(
	postWalk: WalkedTree,
	insertedId: string,
): ReplacementSurvivalReading | undefined {
	if (idSet(postWalk.blocks).has(insertedId)) return undefined;
	return postWalk.incomplete ? "unconfirmed" : "cascade-consumed";
}

/** The sequence's refusal phase — the batched sequences' shared arm set
 * (`batch.ts`'s `BatchedRefusal`): pre-mutation, provably nothing applied. */
export type ReplaceSectionRefusal = BatchedRefusal;

/** The insert leg's outcome unknown — the shared ladder arms verbatim
 * minus `drift`: the entry refuses drift before any leg runs, so a drift
 * arm here would sit in the unverified phase while naming a refusal —
 * excluded so a future in-leg drift re-check fails typecheck instead.
 * The insert may or may not be applied; the old section is untouched
 * either way. */
export type ReplaceInsertUnverified = Exclude<MutationFailure, DriftFailure>;

/** The delete leg's outcome unknown — the raw-error arms verbatim, the
 * replacement's identity riding the wrapper beside them (the partial
 * state the consumer's classifier merges). */
export type ReplaceDeleteLegUnverified = SectionDeleteApplyUnverifiedPhase;

/** The sequence's unverified arms, phase-explicit so a future arm cannot
 * be added without choosing its phase (a post-mutation arm worded as a
 * refusal would invite the blind retry the failure ladder exists to
 * prevent). The `stage` discriminant names which mutation the unknown
 * outcome belongs to: the insert leg's arms carry no partial state, the
 * delete leg's carry the replacement's identity. */
export type ReplaceSectionUnverified =
	| { stage: "insert"; failure: ReplaceInsertUnverified }
	| {
			stage: "delete-leg";
			anchor: AppendAnchor;
			insertedId: string;
			memberIds: string[];
			failure: ReplaceDeleteLegUnverified;
	  };

/** The delete leg's judged arms — the core's judged phase minus its
 * clean `judged` arm (the replacement's identity and the survival
 * reading ride the wrapper beside them). */
export type ReplaceDeleteLegJudged = Exclude<
	SectionDeleteApplyJudgedPhase,
	{ kind: "judged" }
>;

export type ReplaceSectionVerdict =
	| {
			kind: "replaced";
			anchor: AppendAnchor;
			/** The replacement block the insert landed (minted id, certified
			 * by the insert's landed judgment; the delete leg's walk arms
			 * re-check it defensively — `delete-leg`'s
			 * `replacementSurvival`). Its anchor cannot land inside a
			 * member's subtree, so the delete cascade cannot consume it —
			 * the landed certification is the arm's whole proof. */
			insertedId: string;
			/** The section heading's stored content — receipt material,
			 * evidence only. */
			headingContent: string;
			/** The judged set the apply certified absent — the old section's
			 * closure (the members plus everything their cascade removed,
			 * from the caller-held walk; the heading is not part of it — it
			 * survives the replace). */
			closure: JudgedSectionBlock[];
			/** The post-batch tree — the echo snapshot; reused, never
			 * re-traversed. The empty-issued-set path (a section-less
			 * heading) certifies over the fresh walk the apply took
			 * itself. */
			postWalk: WalkedTree;
	  }
	| {
			kind: "insert-unlanded";
			/** The insert failed its landed judgment — `InsertUnlandedVerdict`'s
			 * arm shapes. No delete batch was issued on this arm — the old
			 * section is untouched either way, so the consumer refuses
			 * WITHOUT a baseline refresh (the pinned timeline contract). */
			verdict: InsertUnlandedVerdict;
			anchor: AppendAnchor;
	  }
	| {
			kind: "delete-leg";
			anchor: AppendAnchor;
			insertedId: string;
			/** The plan's issued set — the pre-insert member ids the batch
			 * was given (the inner arms' `judgedBlockIds` stay the judged
			 * set: the closure, cascade-covered descendants included). */
			memberIds: string[];
			outcome: ReplaceDeleteLegJudged;
			/** The replacement-survival reading over the arm's own postWalk
			 * (`replacementSurvivalOf`) — set only when the reading is
			 * adverse. A present replacement certifies positively, and the
			 * arms without a walk leave the insert leg's landed certification
			 * standing: only a subsequent mutation could revoke it, which is
			 * exactly what these arms report. */
			replacementSurvival?: ReplacementSurvivalReading | undefined;
	  };

/** Outcome of the verified replace-section sequence, as a closed union —
 * phase-explicit (`refused` / `unverified` / `judged`), each arm riding
 * its phase verbatim. Two mutations, so the unverified phase carries a
 * `stage` (see `ReplaceSectionUnverified`): `refused` is provably
 * nothing applied (safe to re-derive from a fresh walk); `unverified` is
 * a mutation ran or may have run with its outcome unknown — wording must
 * never invite a blind re-issue; `judged` is a judgment rendered, clean
 * or adverse. The per-arm membership and semantics ride the arm types
 * above (`ReplaceSectionRefusal` / `ReplaceSectionUnverified` /
 * `ReplaceSectionVerdict`). */
export type ReplaceSectionOutcome =
	| { kind: "refused"; refusal: ReplaceSectionRefusal }
	| { kind: "unverified"; outcome: ReplaceSectionUnverified }
	| { kind: "judged"; verdict: ReplaceSectionVerdict };

/** The verified replace-section sequence, whole. The `foreign`
 * refusal's replace-specific consequence: the kernel's mutations address
 * raw ids doc-agnostically, so a foreign walk's insert would LAND in the
 * other doc — a mismatch could not be detected post-hoc.
 *
 * The ordering knowledge lives HERE, not with the caller: enumeration
 * (`sectionOf`) and the anchor are derived internally from the supplied
 * pre-mutation walk — never accepted as inputs. Insert-before-delete is
 * the data-loss direction (a mid-sequence failure must cost visible
 * duplication, never loss), and a post-insert re-enumeration would put
 * the replacement into the delete set — deriving internally (the plan
 * runs pre-insert and its ops are the pre-insert member ids) makes both
 * structural. The delete set is the PRE-insert member set as enumerated
 * before leg 1; a post-insert walk is judgment evidence only, never the
 * delete-set source. Drift is refused at the sequence entry and again
 * inside the insert leg (same probe result — the re-check is idempotent). */
export async function replaceSectionVerified(
	client: ReplaceKernelClient,
	probe: KernelProbeResult,
	input: {
		rootId: string;
		/** The caller-held PRE-mutation document-order walk: the
		 * enumeration's source, the anchor's source, and the insert's
		 * pre-write id set in one. A walk captured after the insert would
		 * enumerate the replacement into the delete set; an incomplete
		 * walk refuses (`walk-truncated`, the `WalkedTree` invariant). */
		walk: WalkedTree;
		headingId: string;
		body: string;
		/** The session's served-baseline verdict per block id, as a lookup
		 * (`BaselineLookup`). The judged set is derived from `walk` — the
		 * section's closure (members plus every descendant the cascade
		 * consumes), NOT the heading: the target heading survives the
		 * replace, so it has no stake. An empty closure (a section-less
		 * heading) legitimately judges nothing — the plan issues no ops
		 * there and the apply short-circuits to its judged arm over a
		 * fresh walk. */
		baselineFor: BaselineLookup;
	},
): Promise<ReplaceSectionOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return { kind: "refused", refusal: drift };
	// The plan phase, before the first mutation; zero kernel calls on any
	// refusal arm. The plan's ops are the pre-insert member ids — the
	// delete set is fixed before leg 1.
	const plan = await sectionDeletePlan(client, {
		rootId: input.rootId,
		walk: input.walk,
		headingId: input.headingId,
		includeHeading: false,
		baselineFor: input.baselineFor,
	});
	if (plan.kind !== "plan") return { kind: "refused", refusal: plan };
	// The anchor projects from the same derivation the fresh guard judged.
	const anchor = appendAnchorOf(plan.section);
	// The verified insert is the first mutation. The anchor is never inside
	// a member's subtree, so the kernel's delete cascade can never consume
	// the replacement.
	const insert = await insertVerified(client, probe, {
		anchor,
		body: input.body,
		rootId: input.rootId,
		preWalk: input.walk,
	});
	if (insert.kind !== "judged") {
		// Pre-mutation refusals. Drift cannot fire here (the entry
		// refused the same probe) but routes to the refusal phase, not
		// the unverified one, if it ever did.
		if (insert.kind === "walk-truncated" || insert.kind === "drift") {
			return { kind: "refused", refusal: insert };
		}
		return {
			kind: "unverified",
			outcome: { stage: "insert", failure: insert },
		};
	}
	if (insert.verdict.kind !== "landed") {
		return {
			kind: "judged",
			verdict: {
				kind: "insert-unlanded",
				verdict: insert.verdict,
				anchor,
			},
		};
	}
	const insertedId = insert.verdict.blockId;
	// The sequence's second mutation — one transaction of the plan's ops,
	// then the walk partition. The replacement's presence is not re-read on
	// the clean path — the anchor is never inside a member's subtree, so
	// the insert leg's landed judgment certifies it.
	const applied = await sectionDeleteApply(client, plan);
	if (applied.kind === "judged") {
		return {
			kind: "judged",
			verdict: {
				kind: "replaced",
				anchor,
				insertedId,
				headingContent: plan.heading.content,
				closure: applied.judgedBlocks,
				postWalk: applied.postWalk,
			},
		};
	}
	if (applied.kind === "mutation-failed" || applied.kind === "walk-failed") {
		return {
			kind: "unverified",
			outcome: {
				stage: "delete-leg",
				anchor,
				insertedId,
				memberIds: plan.ops.map((op) => op.id),
				failure: applied,
			},
		};
	}
	const replacementSurvival = replacementSurvivalOf(
		applied.postWalk,
		insertedId,
	);
	return {
		kind: "judged",
		verdict: {
			kind: "delete-leg",
			anchor,
			insertedId,
			memberIds: plan.ops.map((op) => op.id),
			outcome: applied,
			...(replacementSurvival !== undefined ? { replacementSurvival } : {}),
		},
	};
}
