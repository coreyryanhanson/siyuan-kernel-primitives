// The verified insert — the anchor-addressed mutation and the
// insert-landed judgment, one home for the insert-bearing modes: the
// append flow and replace-section's insert leg both call it, so the
// landed predicate cannot drift between them. A markdown insert lands as
// exactly one doOperations entry with the whole body embedded in its
// data — the kernel DOM-serializes the markdown into the op's data
// (an N-paragraph body still inserts as one op) — and doOperations[0].id
// names the body's FIRST block (the kernel inserts the DOM subtree under
// that id), so the landed judgment certifies the payload's first block;
// the rest of the body is unverified.

import { type BlockTransaction } from "siyuan-kernel-api";
import type { ChildBlocksClient } from "./client.js";
import type { KernelProbeResult } from "./version.js";
import {
	idSet,
	walkBlockTree,
	type WalkTruncated,
	type WalkedTree,
} from "./walk.js";
import type { AppendAnchor } from "./placement.js";
import {
	catchMutation,
	catchVerification,
	refuseDrift,
	type MutationFailure,
} from "./failure.js";

/** Structural client subset the insert needs (tests stub it). The write
 * entry's WriteKernelClient extends this, so the insertBlock /
 * appendBlock contracts are declared exactly once. */
export interface InsertKernelClient extends ChildBlocksClient {
	insertBlock(params: {
		data: string;
		nextID?: string;
	}): Promise<BlockTransaction[]>;
	appendBlock(params: {
		data: string;
		parentID: string;
	}): Promise<BlockTransaction[]>;
}

/** `data[0].doOperations[0].id` — the pinned response shape (write-result
 * contract; the minted ID serializes as the first insert operation's id). */
export function newBlockIdFrom(tx: BlockTransaction[]): string | undefined {
	return tx[0]?.doOperations[0]?.id;
}

/** Outcome of the insert-landed judgment over a kernel transaction and
 * the pre-/post-write walks. Pure: nothing here reads the kernel, so
 * there is no drift arm and no probe parameter — the walks are captured
 * from state the caller already holds. The whole trees ride in (never
 * bare id sets): the post tree's incompleteness fact taints the negative
 * arms (`WalkedTree` invariant — `absent-from-tree` is only rendered
 * off a COMPLETE post-write walk). */
export type InsertLandedOutcome =
	| { kind: "landed"; blockId: string }
	| { kind: "no-id" }
	| { kind: "absent-from-tree"; blockId: string }
	| { kind: "landing-unconfirmed"; blockId: string }
	| { kind: "pre-write-id"; blockId: string };

/** The verdicts the `insert-unlanded` arm can carry — every
 * insertLanded outcome but `landed`, which is unreachable there by
 * construction, so consumers never word it. Declared explicitly, not as
 * an `Exclude` complement — a new arm must be added here, not silently
 * ride. Named for the ABSENCE of a landing, not a rollback:
 * `landing-unconfirmed` means the insert may have landed. */
export type InsertUnlandedVerdict =
	| Extract<InsertLandedOutcome, { kind: "no-id" }>
	| Extract<InsertLandedOutcome, { kind: "absent-from-tree" }>
	| Extract<InsertLandedOutcome, { kind: "landing-unconfirmed" }>
	| Extract<InsertLandedOutcome, { kind: "pre-write-id" }>;

/** Verified, not trusted: a kernel-returned insert id counts as landed
 * only when it is genuinely new — present in the post-write walk set and
 * absent from the pre-write set. The misses are distinct facts with
 * distinct arms: `absent-from-tree` is the silent rollback (the id is
 * nowhere in a COMPLETE post-write tree), `landing-unconfirmed` is the
 * incomplete-walk shape (the id was not seen, but the walk could not see
 * past the depth bound — a landed insert may hide there; never renderable
 * as a rollback), `pre-write-id` is the kernel returning an id that
 * already existed (present, but not newly created). */
export function insertLanded(input: {
	tx: BlockTransaction[];
	/** The caller-held PRE-mutation walk — its id set is derived here, so
	 * no caller can hand over a set that disagrees with a walk. */
	preWalk: WalkedTree;
	/** The post-write walk — the incompleteness fact travels with the
	 * tree, never as a separate forgeable flag. */
	postWalk: WalkedTree;
}): InsertLandedOutcome {
	const newBlockId = newBlockIdFrom(input.tx);
	if (newBlockId === undefined) return { kind: "no-id" };
	const postIds = idSet(input.postWalk.blocks);
	if (!postIds.has(newBlockId)) {
		return input.postWalk.incomplete
			? { kind: "landing-unconfirmed", blockId: newBlockId }
			: { kind: "absent-from-tree", blockId: newBlockId };
	}
	if (idSet(input.preWalk.blocks).has(newBlockId)) {
		return { kind: "pre-write-id", blockId: newBlockId };
	}
	return { kind: "landed", blockId: newBlockId };
}

/** Outcome of the verified insert — same closed-union shape and phase
 * discipline as EditOutcome: `judged` (with the insertLanded verdict and
 * the post-write walk as its evidence — the insert changes tree shape, so
 * the walk rides the arm and the consumer's echo reuses it, never
 * re-traverses), plus the shared ladder arms (failure.ts) and the
 * pre-mutation `walk-truncated` refusal. */
export type InsertOutcome =
	| { kind: "judged"; verdict: InsertLandedOutcome; postWalk: WalkedTree }
	| WalkTruncated
	| MutationFailure;

/** The verified insert, whole: the anchor-addressed mutation (insertBlock
 * before a boundary sibling, else appendBlock to the container — the
 * container-less doc-end fallback rides the doc root) → the insert-landed
 * judgment. The pre-mutation truncation gate rides the walk (a bare id
 * set could not carry the fact). Classification rides the shared fork in
 * failure.ts. */
export async function insertVerified(
	client: InsertKernelClient,
	probe: KernelProbeResult,
	input: {
		anchor: AppendAnchor;
		body: string;
		/** The doc root — the append fallback parent when the anchor names
		 * no container, and the post-write walk's root. */
		rootId: string;
		/** The caller-held PRE-mutation walk — the landed judgment diffs
		 * against the id set derived from it here, never a bare set: the
		 * set's type cannot carry the walk's incompleteness fact (the
		 * `WalkedTree` invariant). */
		preWalk: WalkedTree;
	},
): Promise<InsertOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// Zero kernel calls, before any judgment runs. Redundant with
	// replace-section's own gate by intent: the backstop lives here so no
	// caller can bypass it.
	if (input.preWalk.incomplete) return { kind: "walk-truncated" };
	let tx: BlockTransaction[];
	try {
		tx =
			input.anchor.kind === "append"
				? await client.appendBlock({
						data: input.body,
						parentID: input.anchor.containerId ?? input.rootId,
					})
				: await client.insertBlock({
						data: input.body,
						nextID: input.anchor.nextID,
					});
	} catch (err) {
		return catchMutation(err);
	}
	try {
		const postTree = await walkBlockTree(client, input.rootId);
		const verdict = insertLanded({
			tx,
			preWalk: input.preWalk,
			postWalk: postTree,
		});
		return { kind: "judged", verdict, postWalk: postTree };
	} catch (err) {
		return catchVerification(err);
	}
}
