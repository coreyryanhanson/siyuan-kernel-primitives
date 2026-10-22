// Batched-route foundation — the judgment-free shared code behind the
// batched write sequences: `transact` plus the fresh post-write walk(s).
// Each batched mode owns its judgment over the returned walks; the only
// structure this helper adds is the transport-phase fact carried by the
// two failure arms of `TransactThenWalkOutcome`: a `transact` throw is
// `transact-failed` — no ack, so the commit-wait guarantee does not apply
// (the batch may still be committing or already committed) and the
// caller's gate classifies the error; a walk failure after the ack is
// `walk-failed` — the batch HAS committed or rolled back by the
// commit-wait fact, only the judgment is missing.

import type { TransactionOperation } from "siyuan-kernel-api";
import type { ForeignRefusal } from "./byId.js";
import type { ChildBlocksClient, TransactClient } from "./client.js";
import type {
	DriftFailure,
	JudgedTransportFailure,
	JudgedWalkFailure,
	KernelRefusal,
} from "./failure.js";
import type { FreshRefusal } from "./fresh.js";
import type { SectionRefusal } from "./heading.js";
import { walkBlockTree, type WalkedTree } from "./walk.js";

/** The batched-sequence foundation's client subset: the shared `transact`
 * contract plus the document-order walk's endpoint. */
export type TransactKernelClient = TransactClient & ChildBlocksClient;

/** The batched sequences' phase unions — the arms every batched mode's
 * `refused` / `unverified` phase carries, declared once (the delete /
 * move / replace entries alias these under their phase-explicit names).
 * Both are type-level compositions
 * over the arms' own homes — the route adds no arms of its own:
 * - `BatchedRefusal` — pre-mutation, provably nothing applied: the drift
 *   gate, the enumeration pair (`SectionRefusal`), the caller-provenance
 *   refusal (`ForeignRefusal`), the fresh-content guard's refusal
 *   (`FreshRefusal`).
 * - `BatchedUnverified` — the batched route's outcome-unknown class:
 *   a `KernelRefusal` (NOT proof of non-application — failure.ts's doc),
 *   a `JudgedTransportFailure` (no ack — the whole judged set is what
 *   may be gone), or the apply's `walk-failed` arm (`JudgedWalkFailure`
 *   — acked, judgment missing). `mutation-failed` never appears raw: a
 *   `transact` throw classifies through `catchMutation` into the first
 *   two.
 *
 * A sequence whose phase genuinely diverges declares its own union —
 * the section move's refusal family does — but the shared class is the
 * default, and a consumer keying on the batched route's retry-safety
 * posture reads these names. */
export type BatchedRefusal =
	| DriftFailure
	| SectionRefusal
	| ForeignRefusal
	| FreshRefusal;

export type BatchedUnverified =
	| KernelRefusal
	| JudgedTransportFailure
	| JudgedWalkFailure;

/** `transactThenWalk`'s outcome — the transport-phase fact, not a verdict:
 * - `walked` — the batch was acked and every touched doc walked fresh;
 *   `walks` ride in `rootIds` order, each with its own completeness facts
 * - `transact-failed` — the `transact` call threw (no ack): the caller's
 *   gate classifies the raw error; the whole judged set is what may be
 *   gone
 * - `walk-failed` — the batch was acked but a walk threw; the mutation
 *   phase is over, the judgment is missing, and the error instance rides
 *   the arm — no partial-walk payload: no consumer reads a certified
 *   prefix. */
export type TransactThenWalkOutcome =
	| { kind: "walked"; walks: [WalkedTree, ...WalkedTree[]] }
	| { kind: "transact-failed"; error: unknown }
	| { kind: "walk-failed"; error: unknown };

/** The batched route, judgment-free: one transaction over the pre-derived
 * op array, then a strict post-write walk of each touched doc —
 * `transact`'s commit-wait makes the walk read final state at the ack.
 * Strict (write verification stays strict): a vanished root propagates
 * into `walk-failed`, never a tolerated empty tree behind HTTP success.
 *
 * The ≥32-op bulk path is single-doc territory, and only for deletes:
 * the kernel's `doLargeDelete` loads ONE tree — from the first op's id
 * (an unresolvable first id aborts the batch; every op must resolve
 * inside that one tree) — so a multi-doc all-delete batch would silently
 * apply to that one tree only. Single-doc delete batches are route
 * hygiene, not a batch constraint: the kernel collects every `delete` op
 * into the bulk path and only falls back to per-op execution when a
 * non-delete op sits BEFORE the last position (a trailing non-delete op
 * is excluded and run per-op afterwards), so all-delete is sufficient,
 * not necessary. The bulk path's failure shape is not the per-op one:
 * an id absent from its tree nils `doDelete0`'s value, whose
 * `BlockIDs()` call panics into the transaction's `recover()` and rolls
 * the WHOLE batch back behind an HTTP success ack — silently voiding
 * the batch, never a kernel error. The 31/32 boundary is pinned by the
 * layer-1 probe suite.
 *
 * Rollback posture, route-wide: every skip-class and legality rejection
 * (`TxErrCodeSkipTx` / `TxErrCodeReloadUI`) rolls the batch back WHOLE
 * behind HTTP code 0 — cause-free over HTTP; no batch-failure channel
 * exists on this route (the kernel publishes reasons only on the editor
 * websocket's `txerr` push, which a zero-dep HTTP client does not
 * speak). Below the cliff, per-op execution has a silent face of its
 * own: a delete op whose id cannot resolve is skipped behind the same
 * success ack — the sub-cliff silent no-op, read off the post-write
 * walk (the sequences' survivor arms), never off the echo. A rolled-back
 * batch can leave blocks-index residue (rows resolving not-found until a
 * committed write re-upserts them); recovery is repair-first — re-issue
 * only after a committed write has healed the tree, never by-id cleanup.
 *
 * The HTTP body is an echo and is never trusted — `transact` surfaces it
 * as a hint, never evidence; the fresh walks are the evidence.
 *
 * Queue ordering: the kernel takes the transaction `Timestamp` from the
 * request's `reqId` and FIFOs the queue on it — layer 1 sends a
 * monotonic client timestamp, preserving arrival order. */
export async function transactThenWalk(
	client: TransactKernelClient,
	input: {
		/** The pre-derived ops, in issue order — the mode's own derivation,
		 * never caller ids. One `Transaction` carries them all. */
		operations: TransactionOperation[];
		/** The touched docs, walked fresh in order after the ack — at
		 * least one, the walked arm's non-empty tuple keys on. */
		rootIds: [string, ...string[]];
	},
): Promise<TransactThenWalkOutcome> {
	try {
		await client.transact([{ doOperations: input.operations }]);
	} catch (err) {
		// No ack — the raw error rides the arm for the caller's gate.
		return { kind: "transact-failed", error: err };
	}
	try {
		const walks: WalkedTree[] = [];
		for (const rootId of input.rootIds) {
			walks.push(await walkBlockTree(client, rootId));
		}
		// Every rootIds entry walked, so the tuple is non-empty.
		return { kind: "walked", walks: walks as [WalkedTree, ...WalkedTree[]] };
	} catch (err) {
		return { kind: "walk-failed", error: err };
	}
}
