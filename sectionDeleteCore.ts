// The shared section-delete core — the phase-split behind both section
// flows that delete through the batched route: `sectionDeletePlan`
// (derivation from the caller-held walk plus the fresh-content guard)
// and `sectionDeleteApply` (one transaction of the plan's ops, then the
// walk partition over the single post-write walk). `deleteSection.ts`
// composes them with `includeHeading: true`; `replace.ts` with
// `includeHeading: false` around its insert leg. Internal module: the
// tool-facing outcome unions stay with the composing sequences.
//
// The flag is structural: it selects the two derivations the plan makes
// from the ONE section it derives —
//
//   includeHeading  judged set (fresh guard + receipt)   issued set (ops)
//   true            heading + closure                    members + heading
//   false           closure only                         members only
//
// It never reaches `sectionDeleteApply`, and the plan arm's shape is
// flag-independent (the heading rides the plan either way — replace-section
// projects its anchor from `plan.section` and its receipt content from
// `plan.heading`).
//
// Kernel facts the arms rest on: the delete path is fold-blind — a raw
// `delete` op on a heading removes ONLY the heading — so the issued set
// is the enumerated members plus, when `includeHeading`, the heading;
// the cascade removes a container member's descendants with it, so
// cascade-covered descendants are NEVER issued (the batched route's
// cliff and rollback mechanics are batch.ts's). Members go in document
// order, heading last.
//
// Single-tree is a batch assumption, not a walk conclusion: the plan's
// `foreign` gate proves the enumeration walk is the claimed doc's tree;
// it does not prove the issued ids share one tree at issue time. A
// member moved to another doc inside the enumeration→issue window
// deletes in that other doc — invisible to this doc's post-walk, a
// false `judged` below the cliff (at ≥32 the batch rolls back instead —
// batch.ts). Single-doc hygiene is enforced by the deployment
// posture (one kernel per workspace, one writer), not by the walk
// check.
//
// No probe: the core carries no `KernelProbeResult` and no drift arm —
// the drift gate stays with each sequence at its own first-mutation
// position (delete-section probes before the batch; replace-section
// probes before the insert, and the plan's refusals refuse pre-insert).

import type { SqlClient } from "./client.js";
import type { JudgedWalkFailure } from "./failure.js";
import {
	freshRefusalOf,
	judgeFreshOverWalk,
	type BaselineLookup,
	type FreshRefusal,
} from "./fresh.js";
import type { SectionRefusal } from "./heading.js";
import { sectionSubjectOf, type Section } from "./placement.js";
import type { ForeignRefusal } from "./byId.js";
import { transactThenWalk, type TransactKernelClient } from "./batch.js";
import { idSet, walkBlockTree, type WalkedTree } from "./walk.js";

/** A judged block as the post-mutation arms carry it: the id plus the
 * content the enumeration walk observed (the receipt's itemization). */
export type JudgedSectionBlock = { blockId: string; content: string };

/** One delete op the plan issues — the route's payload contract narrowed
 * to the only action the core ever derives (the kernel fills anchors and
 * undo ops itself). Typed as its own shape, not the layer-1
 * `TransactionOperation` catch-all, so the issued ids stay first-class
 * strings for the partition and the consumers' mapping. */
export type DeleteOp = { action: "delete"; id: string };

/** The plan's refusal arms — the three pre-mutation refusals
 * `sectionDeletePlan` can return, named once for the composing sequences'
 * unions (the plan arm must stay the refusal source of truth, never an
 * `Exclude` complement). */
export type SectionDeletePlanRefusal =
	| SectionRefusal
	| ForeignRefusal
	| FreshRefusal;

/** `sectionDeletePlan`'s outcome: the plan — derivation, fresh judgment, and
 * the derived ops in one value — or a refusal. The plan arm carries
 * `rootId` so `sectionDeleteApply` needs nothing but the plan, and `section`,
 * the derived `Section` itself, so a consumer can project from the same
 * derivation the fresh guard judged (replace-section projects its anchor
 * between the plan and the insert — never a second derivation). */
export type SectionDeletePlanOutcome =
	| {
			kind: "plan";
			rootId: string;
			/** The section's heading — always on the plan (the flag only
			 * selects the judged and issued sets). `includeHeading: false`
			 * consumers read their receipt content from here; it is a
			 * judged-set member only under `includeHeading: true`. */
			heading: JudgedSectionBlock;
			/** The judged set in judged order: the heading first when
			 * `includeHeading`, then the closure in document order. The
			 * flag selects exactly this — the cascade makes descendants
			 * part of what is at stake, so the closure is judged either
			 * way; the heading is judged only when it does not survive
			 * the sequence. */
			judgedBlocks: JudgedSectionBlock[];
			section: Section;
			/** The issued ops: members in document order, the heading
			 * last (when `includeHeading`) — cascade-covered descendants
			 * are never issued. */
			ops: DeleteOp[];
	  }
	| SectionDeletePlanRefusal;

/** The plan arm, as `sectionDeleteApply`'s input type names it — "typed to
 * accept only a judged plan" keeps "judged before the first mutation"
 * structural: the composing sequences refuse on the plan's refusal arms
 * before their own first mutations. */
export type SectionDeletePlan = Extract<
	SectionDeletePlanOutcome,
	{ kind: "plan" }
>;

/** `sectionDeleteApply`'s outcome — the walk partition over the single
 * post-write walk, judged against the sets the plan derived and nothing
 * else (absent-set-only: no must-survive input, no arm only one consumer
 * can produce):
 * - `judged` — every issued id is absent from the post-write walk; the
 *   walk is the evidence and the judged set rides the verdict (`id`
 *   plus observed content each, judged order). The empty-issued-set
 *   path returns this arm over the fresh walk it took itself — never
 *   the caller-held plan walk, which for replace-section predates the
 *   insert.
 * - `nothing-deleted` — every ISSUED id is still present: the batch
 *   rolled back whole behind an HTTP success (or every op silently
 *   no-oped). The all-present inference certifies the closure present
 *   too — the cascade never ran — and it is guarded on the plan's op
 *   count: an empty issued set short-circuits to `judged`, so the arm
 *   cannot fire vacuously on a section-less heading. Cause-free by
 *   design — the kernel reports no batch failure reason over HTTP, and
 *   the walk cannot distinguish a clean rollback from damaged-index
 *   residue.
 * - `members-survived` — the batch acked but some issued ids are still
 *   present: the sub-cliff silent no-op behind HTTP success.
 *   `survivedIds` rides in issued order; presence is sound even on an
 *   incomplete walk, so the arm outranks `post-walk-truncated`.
 * - `walk-failed` — the batch acked (or the empty-set path's walk ran)
 *   but the post-write walk threw; the judged set rides
 *   `judgedBlockIds` — a committed batch takes the closure with the
 *   members, so the issued ids alone would under-report it.
 * - `post-walk-truncated` — the post-write walk is incomplete: the
 *   absence facts `judged` rests on are unconfirmed. Presence facts
 *   stay sound: survivors visible in the seen prefix already returned
 *   as `members-survived`/`nothing-deleted`.
 * - `mutation-failed` — the transaction call threw; the RAW error
 *   instance rides the arm with the judged set attached. This is the
 *   documented transport fact, not a verdict: the arm is deliberately
 *   raw, and each consuming sequence classifies at its own posture
 *   (`catchMutation` rethrows auth/429 raw — they belong to the
 *   breaker and 429-cooldown paths, not a verdict — so classifying
 *   inside the core would drop exactly the errors whose partial state
 *   must survive). */
export type SectionDeleteApplyJudgedPhase =
	| {
			kind: "judged";
			postWalk: WalkedTree;
			judgedBlocks: JudgedSectionBlock[];
	  }
	| { kind: "nothing-deleted"; postWalk: WalkedTree; judgedBlockIds: string[] }
	| {
			kind: "members-survived";
			survivedIds: string[];
			postWalk: WalkedTree;
			judgedBlockIds: string[];
	  }
	| {
			kind: "post-walk-truncated";
			postWalk: WalkedTree;
			judgedBlockIds: string[];
	  };

/** The unverified arms — a mutation ran or may have run with the
 * outcome unknown (see `mutation-failed`'s classification note above);
 * the walk arm is `failure.ts`'s `JudgedWalkFailure` verbatim. */
export type SectionDeleteApplyUnverifiedPhase =
	| JudgedWalkFailure
	| { kind: "mutation-failed"; error: unknown; judgedBlockIds: string[] };

export type SectionDeleteApplyOutcome =
	| SectionDeleteApplyJudgedPhase
	| SectionDeleteApplyUnverifiedPhase;

/** The plan phase — derive the section from the caller-held
 * pre-mutation walk, run the fresh-content judgment over the flag's
 * judged set, and return the plan the apply consumes. Derivation, never
 * caller ids: the section (and every set the flag selects from it)
 * derives from the walk via `sectionSubjectOf`, which also carries the
 * `foreign` gate — the caller's own projections are never consumed, so
 * judgment inputs cannot drift from the walk they are judged over. The
 * client is the SQL surface only — the seed read the fresh judgment
 * rides; no mutation, no probe, zero kernel calls when every judged
 * target carries a served baseline. */
export async function sectionDeletePlan(
	client: SqlClient,
	input: {
		/** The document root — checked against the walk's own root id
		 * (the `foreign` gate) and carried on the plan arm for the
		 * apply's walk and transaction. */
		rootId: string;
		/** The caller-held STRICT pre-mutation walk: the enumeration's
		 * source and the judged set's bound in one. */
		walk: WalkedTree;
		headingId: string;
		/** The structural flag — see the module doc's table. */
		includeHeading: boolean;
		/** The session's served-baseline verdict per block id. The judged
		 * set derives inside this function; the lookup is consulted only
		 * for the ids the derivation names. */
		baselineFor: BaselineLookup;
	},
): Promise<SectionDeletePlanOutcome> {
	const section = sectionSubjectOf(input.walk, input.rootId, input.headingId);
	if (section.kind !== "section") return section;
	const headingBlock: JudgedSectionBlock = {
		blockId: section.section.heading.id,
		content: section.section.heading.content,
	};
	const closureRows = section.section.closure.map((b) => ({
		blockId: b.id,
		content: b.content,
	}));
	const judgedBlocks: JudgedSectionBlock[] = input.includeHeading
		? [headingBlock, ...closureRows]
		: closureRows;
	const judged = await judgeFreshOverWalk(
		client,
		judgedBlocks.map((b) => ({
			blockId: b.blockId,
			baseline: input.baselineFor(b.blockId),
		})),
		input.walk,
	);
	const freshRefusal = freshRefusalOf(judged, input.walk);
	if (freshRefusal !== undefined) return freshRefusal;
	const ops: DeleteOp[] = [
		...section.section.members.map((b): DeleteOp => ({
			action: "delete",
			id: b.id,
		})),
		...(input.includeHeading
			? [{ action: "delete" as const, id: section.section.heading.id }]
			: []),
	];
	return {
		kind: "plan",
		rootId: input.rootId,
		heading: headingBlock,
		judgedBlocks,
		section: section.section,
		ops,
	};
}

/** The apply phase — issue the plan's ops through the batched route and
 * partition the single post-write walk. Takes the client (the
 * transaction route plus the walk's endpoint) and NOTHING else: the
 * plan is the whole judgment input, judged before this call by
 * construction. The empty-issued-set path (a section-less heading
 * judged under `includeHeading: false`) skips the transaction entirely
 * — the route is never sent an empty op list — but still takes the
 * fresh post-write walk and returns `judged` over it, so the
 * replacement's survival is judged against post-insert reality, never
 * the pre-insert plan walk. */
export async function sectionDeleteApply(
	client: TransactKernelClient,
	plan: SectionDeletePlan,
): Promise<SectionDeleteApplyOutcome> {
	const judgedIds = plan.judgedBlocks.map((b) => b.blockId);
	if (plan.ops.length === 0) {
		try {
			const postWalk = await walkBlockTree(client, plan.rootId);
			return { kind: "judged", postWalk, judgedBlocks: plan.judgedBlocks };
		} catch (err) {
			return { kind: "walk-failed", error: err, judgedBlockIds: judgedIds };
		}
	}
	const issuedIds = plan.ops.map((op) => op.id);
	const batched = await transactThenWalk(client, {
		operations: plan.ops,
		rootIds: [plan.rootId],
	});
	if (batched.kind === "transact-failed") {
		return {
			kind: "mutation-failed",
			error: batched.error,
			judgedBlockIds: judgedIds,
		};
	}
	if (batched.kind === "walk-failed") {
		return {
			kind: "walk-failed",
			error: batched.error,
			judgedBlockIds: judgedIds,
		};
	}
	// Single-doc batch: the plan carries this one touched doc; the
	// route's non-empty walk contract makes the read total.
	const postWalk = batched.walks[0];
	const present = idSet(postWalk.blocks);
	const survivedIds = issuedIds.filter((id) => present.has(id));
	if (survivedIds.length === issuedIds.length) {
		// Every issued id present ⇒ the cascade never ran ⇒ the closure is
		// present too; non-empty by the empty-set path's early return.
		return { kind: "nothing-deleted", postWalk, judgedBlockIds: judgedIds };
	}
	if (survivedIds.length > 0) {
		// Presence is sound even on an incomplete walk — survivors outrank
		// truncation.
		return {
			kind: "members-survived",
			survivedIds,
			postWalk,
			judgedBlockIds: judgedIds,
		};
	}
	if (postWalk.incomplete) {
		return { kind: "post-walk-truncated", postWalk, judgedBlockIds: judgedIds };
	}
	return { kind: "judged", postWalk, judgedBlocks: plan.judgedBlocks };
}
