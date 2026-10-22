// The verified section delete — one call that removes a section (the
// heading plus every member block) in ONE kernel transaction, judged from
// the single post-write walk. The mutation sequence is the shared
// section-delete core (`sectionDeleteCore.ts`) composed with
// `includeHeading: true` — this module keeps the tool-facing union and
// the drift gate; the plan and apply phases live in the core.
//
// Kernel facts unique here: a delete leaving a list-item parent empty
// appends a fresh empty paragraph (kernel/model/transaction.go) —
// outside the judged set, no effect on the absence judgment. The rest
// (the delete path's fold-blind and cascade facts, the ≥32 bulk-path
// void) is the core's and `batch.ts`'s; recovery wording is the
// consumer's.

import type { KernelProbeResult } from "./version.js";
import type { SqlClient } from "./client.js";
import type { WalkedTree } from "./walk.js";
import type {
	SectionDeleteApplyJudgedPhase,
	JudgedSectionBlock,
} from "./sectionDeleteCore.js";
import type { BaselineLookup } from "./fresh.js";
import type {
	BatchedRefusal,
	BatchedUnverified,
	TransactKernelClient,
} from "./batch.js";
import { sectionDeleteApply, sectionDeletePlan } from "./sectionDeleteCore.js";
import { catchMutation, refuseDrift } from "./failure.js";

/** The section-delete flow's client subset: the batched transaction route
 * plus the document-order walk, and the SQL surface the fresh-content
 * guard's seed read rides (the judgment runs inside the core, over the
 * caller-held walk — the seed read is inherent to it). The pre-mutation
 * scoping check needs no read of its own — the caller-held walk carries
 * its root id (`WalkedTree.rootId`). */
export type DeleteSectionKernelClient = TransactKernelClient & SqlClient;

/** The sequence's phase unions — the batched sequences' shared arm sets
 * (`batch.ts`'s `BatchedRefusal` / `BatchedUnverified`). The phase
 * semantics (pre-mutation refusal vs outcome-unknown, and why a
 * post-mutation arm can never be worded as a refusal) are canonical
 * there. */
export type DeleteSectionRefusal = BatchedRefusal;

export type DeleteSectionUnverified = BatchedUnverified;

/** The judged arms — the core's judged phase (`...JudgedPhase`) split
 * structurally: the clean `judged` arm gains the receipt's named
 * `heading` field, the adverse arms ride verbatim. The judged set —
 * heading + closure — is wider than the issued set: members + heading;
 * the closure's absence rides the cascade fact, not a per-block probe. */
export type DeleteSectionVerdict =
	| (Extract<SectionDeleteApplyJudgedPhase, { kind: "judged" }> & {
			heading: JudgedSectionBlock;
	  })
	| Exclude<SectionDeleteApplyJudgedPhase, { kind: "judged" }>;

/** Outcome of the verified section delete, as a closed union —
 * phase-explicit (`refused` / `unverified` / `judged`), each arm riding
 * its phase verbatim. The apply arms' canonical statement is
 * `SectionDeleteApplyOutcome`'s doc on `sectionDeleteCore.ts`; this
 * union adds the sequence's own refusals:
 * - `drift` — the required probe says the kernel is drifted, checked
 *   before any kernel call (the batched route has no drift arm of its
 *   own; the drift gate is this sequence's first-mutation position).
 * - the enumeration refusal pair (`SectionRefusal`):
 *   `walk-truncated` — the caller-held walk is incomplete, so the delete
 *   set's bound would derive from incomplete evidence; `heading-absent`
 *   — the headingId names no heading of that walk (fail-closed
 *   tripwire, unreachable when the caller resolved the target from the
 *   same walk). Not `resolveHeadingTarget`'s `untargetable` arm —
 *   `CheckContainerParent` applies to insert/append actions, not delete,
 *   so a heading inside `tabs` or an unnamed container is legally
 *   deletable.
 * - `foreign` — the caller-provenance refusal: the enumeration walk's
 *   own root id (`walk.rootId`) is not the claimed `rootId`, so the
 *   caller resolved the target from a walk of another doc; checked
 *   pre-mutation, zero kernel calls. The walk check is exact where the
 *   blocks index is not: an index read fails open inside a minted doc's
 *   convergence window (`absent` falls through), while the walk-derived
 *   heading cannot lie about its doc — `sectionOf` requires a `type:"h"`
 *   row of this very walk, so a mismatch can only mean the walk is not
 *   `rootId`'s tree. (`doc-id` is unreachable here: `sectionOf`
 *   requires a heading row, so a document id is `heading-absent`.)
 * - `fresh-refused` — the fresh-content guard over the
 *   heading-plus-closure judged set, run inside the core over the
 *   caller-held walk (the mechanics are fresh.ts's).
 *
 * All-or-nothing at the transport — one transaction behind the success
 * ack; the post-write walk over the judged set can still return a
 * non-clean outcome (`members-survived`, `nothing-deleted`,
 * `post-walk-truncated` — the core's adverse arms), carried as evidence,
 * never silence. */
export type DeleteSectionOutcome =
	| { kind: "refused"; refusal: DeleteSectionRefusal }
	| { kind: "unverified"; outcome: DeleteSectionUnverified }
	| { kind: "judged"; verdict: DeleteSectionVerdict };

/** The verified section delete, whole: the core's plan phase
 * (`sectionDeletePlan` — enumeration from the caller-held strict pre-mutation
 * walk, the caller-provenance gate, and the fresh-content guard over the
 * heading-plus-closure judged set), then the apply phase through
 * `sectionDeleteApply` (one transaction of the N+1 delete ops, then the
 * walk partition over the single post-write walk), with the `transact`
 * throw classified here — auth/429 rethrow raw for the caller's gate;
 * transport/kernel refusal becomes an arm with the whole judged set
 * attached. The `judged` arm gains the plan's heading — the receipt's
 * named field.
 *
 * Membership: the delete set is derived from the walk, not
 * caller-supplied ids — the derivation bounds the walk partition's
 * judged ids and keeps caller ids out of the op array (an absent id
 * silently no-ops below the cliff; the derivation, not post-hoc
 * validation, is the guard). The `foreign` gate's second effect is the
 * batch's single-doc hygiene — the bulk path's one-tree assumption. */
export async function deleteSectionVerified(
	client: DeleteSectionKernelClient,
	probe: KernelProbeResult,
	input: {
		/** The document root — the post-write verification walk's target
		 * (the `WalkedTree` carries no doc id) and the batch's only touched
		 * doc. */
		rootId: string;
		/** The caller-held STRICT pre-mutation document-order walk: the
		 * enumeration's source and the delete set's bound in one; its root
		 * id is checked against `rootId` before any kernel call. */
		walk: WalkedTree;
		headingId: string;
		/** The session's served-baseline verdict per block id, as a lookup
		 * (`BaselineLookup`). The judged set is derived from `walk` (the
		 * heading first, then the closure in document order — the cascade
		 * consumes descendants, so the closure is part of the stake, not
		 * just the issued members); the core consults the lookup only for
		 * the ids its own derivation derives, so the judged set never
		 * crosses the input surface and cannot be under-covered or
		 * re-derived. */
		baselineFor: BaselineLookup;
	},
): Promise<DeleteSectionOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return { kind: "refused", refusal: drift };
	const plan = await sectionDeletePlan(client, {
		rootId: input.rootId,
		walk: input.walk,
		headingId: input.headingId,
		includeHeading: true,
		baselineFor: input.baselineFor,
	});
	if (plan.kind !== "plan") return { kind: "refused", refusal: plan };
	const applied = await sectionDeleteApply(client, plan);
	if (applied.kind === "mutation-failed") {
		return {
			kind: "unverified",
			outcome: catchMutation(applied.error, applied.judgedBlockIds),
		};
	}
	// The receipt's named field — judged-set member under this flag.
	if (applied.kind === "judged") {
		return {
			kind: "judged",
			verdict: { ...applied, heading: plan.heading },
		};
	}
	if (applied.kind === "walk-failed") {
		return { kind: "unverified", outcome: applied };
	}
	return { kind: "judged", verdict: applied };
}
