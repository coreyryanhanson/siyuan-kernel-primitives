// The verified edit and its landed predicate. The landing is judged
// walk-vs-walk — the fresh guard's pre-write walk row against the
// post-write tree walk — never against the blocks index, which is
// 0–3s stale at every moment behind its periodic flush. See
// `judgeEditLanded`.

import type { ChildBlocksClient, SqlClient } from "./client.js";
import {
	checkFreshContent,
	freshRefusalOf,
	type FreshRefusal,
	type ServedBaseline,
} from "./fresh.js";
import {
	walkBlockTree,
	byIdMap,
	type WalkedBlock,
	type WalkedTree,
	type WalkTruncated,
} from "./walk.js";
import type { KernelProbeResult } from "./version.js";
import { blockInDoc, type BlockInDocResult } from "./byId.js";
import {
	catchMutation,
	catchVerification,
	refuseDrift,
	type MutationFailure,
} from "./failure.js";

/** Structural client subset the edit needs (tests stub it). The write
 * entry's WriteKernelClient extends this, so the updateBlock contract is
 * declared exactly once. The ChildBlocksClient capability is both the
 * internal fresh-content guard's walk and the post-write verification
 * walk — the judgments run inside the primitive, so the walk reads are
 * this subset's, not the caller's. */
export interface EditKernelClient extends SqlClient, ChildBlocksClient {
	updateBlock(params: { id: string; data: string }): Promise<unknown>;
}

/** The row fields the landed comparison watches, as the walk renders
 * them — the block's block-local stored representation — judged and
 * carried as evidence. `markdown` carries the walk row's coalesced form
 * (`?? ""` — absent and "" compare equal, the walk field's presence
 * rule). `parentId` is deliberately outside: it is the
 * concurrent-move signal, never a watched field. */
export interface JudgedEditRow {
	content: string;
	type: string;
	subType: string;
	markdown: string;
}

/** Outcome of the edit landed check, as a closed union — the judgment is
 * walk-vs-walk over the four watched fields (the pre-write row is the
 * fresh guard's walk row; the post-write row is looked up in the
 * verification walk's by-id map):
 * - `landed` — any watched field moved off the pre-write row, or all four
 *   stayed equal on a byte-equal body (the observed no-op — see the
 *   landed predicate). The arm carries the post-write row's watched
 *   fields as `stored`, so the consumer's baseline seeding reuses the
 *   row the verdict judged instead of re-reading it (the baseline seeds
 *   from `stored.content`). A third-party write landing between the two
 *   walks moves the watched fields too — `stored` is the tree's
 *   content, never the submitted body.
 * - `still-pre-write` — all four fields equal the pre-write row and the
 *   body is byte-different from the pre-write content: the live tree
 *   still holds the pre-write row. Conservative over a resubmit the
 *   kernel normalizes onto the stored row (no field moves; the body
 *   still differs byte-wise from the rendered content) — the envelope
 *   sends the agent to re-fetch, where the already-correct content ends
 *   the loop. `observed` is the four-field row the judgment saw.
 * - `concurrent-move` — the row is present with a different `parentId`:
 *   an intra-doc concurrent move landed between the fresh walk and the
 *   mutation (a positive tree fact; the different parent is its own
 *   evidence). Never ok.
 * - `concurrent-gone` — the row is absent from a COMPLETE post-write
 *   walk: a concurrent delete or cross-doc move landed between the fresh
 *   walk and the mutation. Tree-certified and immediate (the tree is the
 *   authority the moment the ack lands) — the arm reports the tree
 *   facts, not the cause. Never ok.
 * - `absence-unconfirmed` — the row is absent from an INCOMPLETE
 *   post-write walk: the walk cannot certify either presence or absence.
 *   Never ok.
 * The kernel normalizes submitted markdown (a ref token `((id "x"))`
 * stores as `x`, `**bold**` as `bold`, a `- [x]` checkbox as `- [X]`),
 * so equality against the submitted body is not a landed predicate. A
 * byte-equal resubmit is judged through the same comparison, never
 * assumed: stored content is rendered text, so resubmission re-parses it
 * and is not idempotent (an escaped-hash paragraph resubmits into a real
 * heading) — when the row moves, that movement is the landed verdict; a
 * still row on a byte-equal body is the observed no-op. A
 * NORMALIZED-equivalent resubmit (submitted markdown that renders to the
 * stored form, e.g. `**bold**` over stored `bold`) cannot be
 * distinguished from a silent drop without the kernel's normalizer, so it
 * answers `still-pre-write` (the conservative direction — the recovery
 * sentence lives on the arm above).
 *
 * Pure judgment — no probe parameter, no drift arm, no kernel call: the
 * flow owns the drift gate before any kernel call and fetches the walks
 * itself. */
export type EditLandedOutcome =
	| { kind: "landed"; stored: JudgedEditRow }
	| { kind: "still-pre-write"; observed: JudgedEditRow }
	| {
			kind: "concurrent-move";
			row: JudgedEditRow & { parentId: string | null };
	  }
	| { kind: "concurrent-gone" }
	| { kind: "absence-unconfirmed" };

const judgedRowOf = (row: WalkedBlock): JudgedEditRow => ({
	content: row.content,
	type: row.type,
	subType: row.subType,
	markdown: row.markdown ?? "",
});

/** The edit landed judgment, pure over the two walks: the pre-write row
 * is the fresh guard's walk row (in hand by construction — an absent
 * target refuses pre-mutation, never reaches the mutation), the
 * post-write row is looked up in the verification walk's by-id map. The
 * comparison watches exactly `(type, subType, content, markdown)` —
 * the walk row's block-local stored representation — and nothing else;
 * the arm semantics and the normalization hazard live on
 * `EditLandedOutcome`.
 *
 * Coverage is route-scoped: a submitted `{: …}`
 * suffix stores as literal block text (it moves `content`/`markdown`
 * verbatim), so there is no attribute
 * state `updateBlock` can move that the watched fields miss, while
 * `setBlockAttrs` attribute changes (custom attrs, fold) are invisible to
 * the comparison and unreachable from the edit flow's markdown-only
 * mutation route. */
export function judgeEditLanded(input: {
	/** The pre-write walk row — the fresh guard's walk, threaded in by the
	 * flow. Its `id` is the target identity: the post-write row is looked
	 * up by it, so the two rows cannot be different blocks. */
	preWrite: WalkedBlock;
	/** The requested body — byte-equality with the pre-write content only
	 * marks the observed no-op. */
	body: string;
	postWalk: WalkedTree;
}): EditLandedOutcome {
	const row = byIdMap(input.postWalk.blocks).get(input.preWrite.id);
	if (row === undefined) {
		// Absence is a negative fact: only a complete walk certifies it —
		// a concurrent delete or cross-doc move; an incomplete walk's
		// unseen tail is unconfirmed, never a verdict.
		return input.postWalk.incomplete
			? { kind: "absence-unconfirmed" }
			: { kind: "concurrent-gone" };
	}
	const post = judgedRowOf(row);
	const pre = judgedRowOf(input.preWrite);
	// `parentId` is the concurrent-move signal, never a watched field: the
	// edit moves no block, so a different parent is a concurrent intra-doc
	// move — a positive tree fact, judged before the field comparison.
	if (row.parentId !== input.preWrite.parentId) {
		return {
			kind: "concurrent-move",
			row: { ...post, parentId: row.parentId },
		};
	}
	const moved =
		post.content !== pre.content ||
		post.type !== pre.type ||
		post.subType !== pre.subType ||
		post.markdown !== pre.markdown;
	if (moved) return { kind: "landed", stored: post };
	// All four fields equal: a byte-equal body is the observed no-op (the
	// hazard is documented at the landed predicate above); a byte-different
	// body means the live tree still holds the pre-write row.
	if (input.body === input.preWrite.content) {
		return { kind: "landed", stored: post };
	}
	return { kind: "still-pre-write", observed: post };
}

/** Outcome of the verified edit — same closed-union shape and phase
 * discipline as MoveBlockOutcome: `judged` (with the landed verdict and
 * the post-write walk the judgment judged over — the consumer's echo
 * rides this walk, one read for verdict and outline), `drift` (checked
 * before any kernel call), `transport-unverified` (mutation phase,
 * outcome UNKNOWN — the edit may already be applied), `kernel-refused`
 * (synchronous rejection verbatim), and `verification-failed` (the
 * post-write walk read failed; the edit may already be applied).
 * `fresh-refused` is the internal fresh-content guard: the
 * judgment runs inside the primitive, immediately before the mutation,
 * and refuses when the target's live content diverges from the
 * caller-supplied served-baseline verdict (fresh.ts). `walk-truncated`
 * is the same guard's fail-closed posture over an incomplete walk: a
 * target absent from an incomplete walk is an unconfirmed absence —
 * content the guard could not compare — so the edit refuses before any
 * mutation. `absent-target` is the complete-walk companion: a target the
 * completed walk does not emit refuses pre-mutation — the walk emits
 * every blocks row except the `d` root (table cells are not separate
 * rows; nested headings' sections are flattened into their container's
 * children), so the arm covers the doc root itself, any unindexed doc id
 * (format-indistinguishable from a block id through the index flush
 * window), and any future walk-invisible row. `updateBlock` on such a
 * row does not reliably refuse — on the `d` row it acks code 0 and wipes
 * the document's body. The membership read is this arm's lazily-taken
 * diagnosis — the walk is the presence authority, so the read runs only
 * when the walk lacked the target — and its full answer rides beside the
 * walk for the wording (an incomplete walk refuses `walk-truncated`
 * first). The one absence this arm cannot close is the TOCTOU race — a
 * concurrent delete between the fresh walk and the mutation still
 * reaches `updateBlock`'s synchronous not-found and surfaces
 * `kernel-refused`. */
export type EditOutcome =
	| { kind: "judged"; verdict: EditLandedOutcome; postWalk: WalkedTree }
	| {
			kind: "absent-target";
			blockId: string;
			/** The membership read's full answer for the target, taken only
			 * when the walk lacked it — `foreign`/`doc-id` name the scoping
			 * fact, `in-doc` that the index still lists the target, `absent`
			 * that neither read sees it; the wording names which read
			 * disagreed. */
			membership: BlockInDocResult;
			/** The completed walk the absence was judged from — the
			 * consumer's outline serves from this snapshot, never a re-fetch
			 * of state the verdict already paid for. */
			walk: WalkedTree;
	  }
	| FreshRefusal
	| WalkTruncated
	| MutationFailure;

/** The verified edit, whole: the internal fresh-content judgment (whose
 * walk is the pre-write evidence; a walk-absent target takes the
 * membership read as its diagnosis) → updateBlock → one post-write tree
 * walk → `judgeEditLanded`. Arm rationales live on `EditOutcome`; the
 * classification rides the shared fork in failure.ts. */
export async function editVerified(
	client: EditKernelClient,
	probe: KernelProbeResult,
	input: {
		blockId: string;
		/** The requested body; byte-equality only marks the observed no-op
		 * (see `judgeEditLanded`). */
		body: string;
		rootId: string;
		/** The target's served-baseline verdict — `served` with the hash the
		 * session last served it under, or `never-served` when the session
		 * never served it. Required: the fresh-content precondition is the
		 * primitive's, not the caller's discipline. The judgment
		 * runs immediately before the mutation; the single
		 * target is the whole judged set, so the verdict slot is the whole
		 * input — a content replacement cascades nothing. */
		baseline: ServedBaseline;
	},
): Promise<EditOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// The fresh-content guard takes its own walk immediately before the
	// mutation — no kernel read can interpose between its view and the
	// mutation. An absence on an incomplete walk is unconfirmed and refuses
	// `walk-truncated` before any kernel call.
	const judged = await checkFreshContent(client, {
		docId: input.rootId,
		targets: [{ blockId: input.blockId, baseline: input.baseline }],
	});
	if (judged.arms.some((arm) => arm.kind === "absence-unconfirmed"))
		return { kind: "walk-truncated" };
	const freshRefusal = freshRefusalOf(judged.arms, judged.walk);
	if (freshRefusal !== undefined) return freshRefusal;
	const preWrite = byIdMap(judged.walk.blocks).get(input.blockId);
	if (preWrite === undefined) {
		// The membership read is the refusal's lazily-taken diagnosis, not a
		// second gate — its answer rides the verdict for the wording.
		// Failures propagate raw: nothing is in flight.
		const membership = await blockInDoc(client, input.rootId, input.blockId);
		return {
			kind: "absent-target",
			blockId: input.blockId,
			membership,
			walk: judged.walk,
		};
	}
	try {
		await client.updateBlock({ id: input.blockId, data: input.body });
	} catch (err) {
		return catchMutation(err);
	}
	// The post-write evidence is ONE tree walk; the consumer's echo reuses
	// it.
	try {
		// Tolerating a vanished container keeps the evidence answering: a
		// mid-walk vanish shortens the walk (its incompleteness judged), it
		// never discards the snapshot behind a throw.
		const postWalk = await walkBlockTree(client, input.rootId, {
			tolerateVanished: true,
		});
		const verdict = judgeEditLanded({
			preWrite,
			body: input.body,
			postWalk,
		});
		return { kind: "judged", verdict, postWalk };
	} catch (err) {
		return catchVerification(err);
	}
}
