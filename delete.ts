// Delete primitives — the verified block delete and the doc delete. The
// landing is verified from the post-delete walk, not trusted from the
// mutation's result (see `deleteLanded`); the block delete owns its
// scoping precondition and its fresh-content guard — the judgment runs
// inside the primitive over the stake walk it fetches itself (see the
// `fresh-refused`/`walk-truncated` arms) — because the kernel mutates by
// raw id (the `foreign`/`doc-id` arms on `DeleteBlockOutcome`).

import type { DeleteBlockClient, SqlClient } from "./client.js";
import { blockInDoc, scopingRefusalOf, type ScopingRefusal } from "./byId.js";
import {
	freshRefusalOf,
	judgeFreshOverWalk,
	type BaselineLookup,
	type FreshRefusal,
} from "./fresh.js";
import { cascadeDescendantsOf } from "./placement.js";
import type { KernelProbeResult } from "./version.js";
import {
	idSet,
	walkBlockTree,
	type WalkedTree,
	type WalkTruncated,
} from "./walk.js";
import {
	catchMutation,
	catchVerification,
	refuseDrift,
	type DriftFailure,
	type MutationPhaseFailure,
	type MutationFailure,
} from "./failure.js";

/** Structural client subset the delete primitives need (tests stub it).
 * The write entry's WriteKernelClient extends this. deleteBlock's contract
 * lives once in client.ts's DeleteBlockClient — the block delete is its
 * only write-path consumer (the section flows delete through the
 * batched route); the SQL surface (the pre-mutation membership
 * read) is this interface's alone, as is removeDocByID. */
export interface DeleteKernelClient extends DeleteBlockClient, SqlClient {
	removeDocByID(id: string): Promise<null>;
}

/** The delete-landed judgment over the post-delete walk set. Pure:
 * nothing here reads the kernel — the walk is captured by the caller.
 * - `gone` — the target is absent from the post-delete walk set (a
 *   complete walk's absence is the confident receipt)
 * - `still-present` — the target is still in the walk set (still present
 *   behind HTTP success — the silent-no-op outcome the walk-set judgment
 *   catches; presence is sound even on an incomplete walk)
 * - `absence-unconfirmed` — the post-delete walk is incomplete (the
 *   depth bound, or a tolerated vanish), so the target's absence from
 *   it is unconfirmed (`WalkedTree` invariant) — never renderable as a
 *   confident gone-or-present claim */
export type DeleteLandedOutcome =
	| { kind: "gone" }
	| { kind: "still-present" }
	| { kind: "absence-unconfirmed" };

/** Verified, not trusted: HTTP success is not a receipt, so the landing
 * is judged from the post-delete walk set — the judgment a silent no-op
 * behind success would defeat. An incomplete walk answers
 * `absence-unconfirmed`, never a confident gone-or-present claim (the
 * `WalkedTree` invariant). */
export function deleteLanded(input: {
	blockId: string;
	/** The post-delete walk — the incompleteness fact travels with the
	 * tree, never as a separate forgeable flag. */
	postWalk: WalkedTree;
}): DeleteLandedOutcome {
	const gone = !idSet(input.postWalk.blocks).has(input.blockId);
	if (gone && input.postWalk.incomplete) {
		// Phase-explicit name (the delete acked, the absence is what is
		// unconfirmed) — the `WalkTruncated` discriminant stays pre-mutation.
		return { kind: "absence-unconfirmed" };
	}
	return gone ? { kind: "gone" } : { kind: "still-present" };
}

/** Outcome of the verified block delete, as a closed union:
 * - `judged` — the mutation's transport succeeded and the landing was
 *   judged from the post-delete walk; `verdict` is the delete-landed
 *   judgment, `content` is the deleted block's stored content off the
 *   pre-mutation membership read (null when that read did not see the
 *   target — the absent fall-through, including an index-lag false
 *   absent, where the delete still lands without content to itemize),
 *   and `postWalk` is the judgment's evidence and the consumer's echo
 *   snapshot
 * - `foreign` / `doc-id` — pre-mutation scoping refusal (the shared
 *   `ScopingRefusal` shape, declared once in byId.ts beside the
 *   blockInDoc judgment both flows compose). `foreign`: the id names a
 *   block of another doc (`rootId` is where it actually lives) — the
 *   raw-id scoping fact `blockInDoc` refuses on, so an unchecked foreign
 *   id would be destroyed outside the targeted doc
 *   while the walk-set judgment reads the target gone (the id was never
 *   in rootId's tree), a confident receipt for a block this doc never
 *   held. `doc-id`: the id names a document, not a block — the pinned
 *   kernel itself refuses a root id in this endpoint
 *   ("document cannot be deleted as a block", model/block_operation.go
 *   :46-48), and a post-delete walk of a doc root would throw the
 *   ambiguous "block not found" error class — the arm pins the same rule
 *   pre-mutation so the refusal is typed instead of kernel-verbatim prose
 * - `drift` — the required probe says the kernel is drifted (checked
 *   before any kernel call)
 * - `fresh-refused` — the internal fresh-content guard: the judgment runs
 *   inside the primitive, over the stake walk it fetches itself
 *   immediately before the mutation, and refuses when any judged block's
 *   content diverges from its baseline verdict (the judged arms and the
 *   judged walk ride the refusal — fresh.ts)
 * - `walk-truncated` — the stake walk is incomplete (the depth bound, or
 *   a tolerated vanish), so the cascade stake cannot be enumerated from
 *   complete evidence; refused before the mutation (this also makes the
 *   judgment's `absence-unconfirmed` arm unreachable here)
 * - `transport-unverified` — the delete's transport failed after the
 *   request may have been delivered
 * - `kernel-refused` — a synchronous kernel rejection (kernel-verbatim;
 *   on the pinned kernel, "tree not found" for an absent/stale target
 *   — the absent fall-through rides this arm by design)
 * - `verification-failed` — the post-delete walk itself failed; the
 *   delete may already be applied */
export type DeleteBlockOutcome =
	| {
			kind: "judged";
			verdict: DeleteLandedOutcome;
			content: string | null;
			postWalk: WalkedTree;
			/** The pre-mutation walk the fresh-content guard judged over —
			 * the stake snapshot. The ok path's one carried piece of the
			 * guard's evidence: the consumer's heading-delete report derives
			 * from exactly the snapshot the precondition certified, never a
			 * second read. Always complete — an incomplete walk refuses
			 * `walk-truncated` before the mutation. */
			judgedWalk: WalkedTree;
	  }
	| ScopingRefusal
	| FreshRefusal
	| WalkTruncated
	| MutationFailure;

/** The verified block delete, whole: the pre-mutation scoping read → the
 * internal fresh-content guard (stake walk → truncation refusal →
 * judgment) → deleteBlock → post-delete walk → `deleteLanded`. Arm
 * rationales live on `DeleteBlockOutcome`; classification rides the
 * shared fork in failure.ts. The pre-mutation reads and their failures
 * stay outside both catch arms — nothing is in flight, so the caller's
 * kernel-call classifier owns them (the same policy as the doc path's
 * pre-delete walk). */
export async function deleteBlockVerified(
	client: DeleteKernelClient,
	probe: KernelProbeResult,
	input: {
		blockId: string;
		rootId: string;
		/** The session's served-baseline verdict per block id, as a lookup
		 * (`BaselineLookup`). Required: the fresh-content precondition is
		 * the primitive's, not the caller's discipline. The judged stake —
		 * the target first, then the cascade stake's descendants, derived
		 * inside (enumerating them flow-side would re-encode the cascade
		 * and fold-blindness facts in the tool layer). A served descendant
		 * whose content diverged reads `stale` and refuses, like any other
		 * judged target. */
		baselineFor: BaselineLookup;
	},
): Promise<DeleteBlockOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// Pre-mutation scoping read: the shared membership judgment over the
	// blocks index — the only read that can distinguish
	// `foreign`/`doc-id` from `absent` (a walk of rootId lumps the other
	// two into "not here"). Failures propagate raw: nothing is in flight.
	const membership = await blockInDoc(client, input.rootId, input.blockId);
	const refusal = scopingRefusalOf(membership, input.blockId);
	if (refusal !== undefined) return refusal;
	// `absent` proceeds by design: the kernel answers it synchronously —
	// the kernel-refused arm surfaces verbatim, with the consumer's fresh
	// outline for re-targeting.
	// The fresh-content guard's stake walk, fetched here so the truncation
	// refusal precedes any judged arm. Tolerated vanish reads as
	// incompleteness (refused pre-mutation), never a raw throw
	// mid-precondition.
	const judgedWalk = await walkBlockTree(client, input.rootId, {
		tolerateVanished: true,
	});
	if (judgedWalk.incomplete) return { kind: "walk-truncated" };
	// Stake derivation: the cascade's descendants from
	// `cascadeDescendantsOf`, target first, then descendants in document
	// order (the pinned judged order).
	const judged = await judgeFreshOverWalk(
		client,
		[
			{ blockId: input.blockId, baseline: input.baselineFor(input.blockId) },
			...cascadeDescendantsOf(judgedWalk, input.blockId).map((b) => ({
				blockId: b.id,
				baseline: input.baselineFor(b.id),
			})),
		],
		judgedWalk,
	);
	const freshRefusal = freshRefusalOf(judged, judgedWalk);
	if (freshRefusal !== undefined) return freshRefusal;
	try {
		await client.deleteBlock(input.blockId);
	} catch (err) {
		return catchMutation(err);
	}
	try {
		const postWalk = await walkBlockTree(client, input.rootId);
		return {
			kind: "judged",
			verdict: deleteLanded({ blockId: input.blockId, postWalk }),
			content: membership.kind === "in-doc" ? membership.content : null,
			postWalk,
			judgedWalk,
		};
	} catch (err) {
		return catchVerification(err);
	}
}

/** Outcome of the doc delete. No landing judgment: the one read that could
 * prove a doc's deletion (a post-delete walk of
 * the deleted root) throws the ambiguous "block not found" error class —
 * the same message an encrypted-locked notebook produces — so an
 * error-means-landed judgment would false-positive on lock states
 * (exportMarkdown answers an empty
 * success, and the SQL index lags). "mutated" is the honest terminal
 * state. The pre-delete walk rides the `mutated` arm: it is the evidence
 * the consumer's invalidRefs payload and receipt consume, captured before
 * the doc (and its block set) vanished. */
export type DeleteDocOutcome =
	| { kind: "mutated"; preWalk: WalkedTree }
	| DriftFailure
	| MutationPhaseFailure;

/** The doc delete: pre-delete walk (evidence — the doc's full block set,
 * gone after the mutation) → removeDocByID. No landing judgment exists —
 * the rationale lives on `DeleteDocOutcome`. Pre-mutation failures
 * propagate raw — nothing is in flight. */
export async function deleteDocVerified(
	client: DeleteKernelClient,
	probe: KernelProbeResult,
	input: { docId: string },
): Promise<DeleteDocOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// Failures propagate raw — nothing in flight; the truncated receipt
	// just covers the seen prefix.
	const preWalk = await walkBlockTree(client, input.docId);
	try {
		await client.removeDocByID(input.docId);
	} catch (err) {
		return catchMutation(err);
	}
	return { kind: "mutated", preWalk };
}
