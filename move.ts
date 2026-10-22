// Move primitives — the verified block and doc moves, mutation and landed
// judgment as one call. The landing is verified, not trusted: a tree-level
// miss rolls back silently behind HTTP success, so the judgment reads the
// post-move walk sets (see `verifyMoveLanded`) — doc moves ride the
// live-tree hpath ground truth instead (`MoveDocLandedOutcome`).
//
// The two-route `mode: move` enters through `moveVerified`, the row-type
// dispatch over the two routes (a heading blockId rides the batched
// section sequence, a non-heading block rides the per-id core). The
// dispatch, walk and anchor rules are the entry's doc, below; the tool
// layer neither sequences kernel mutations nor re-derives placement, and
// the route (hence the codec and the anchors) is decided inside the entry.

import type {
	ChildBlocksClient,
	HPathClient,
	SqlClient,
	TransactClient,
} from "./client.js";
import { isHeadingBlock, type SectionRefusal } from "./heading.js";
import { moveSectionVerified, type MoveSectionOutcome } from "./moveSection.js";
import type { KernelProbeResult } from "./version.js";
import {
	byIdMap,
	idSet,
	inSubtree,
	walkBlockTree,
	type WalkedTree,
} from "./walk.js";
import { deriveMoveAnchor, landingId, type MoveAnchor } from "./placement.js";
import {
	foreignRefusalOf,
	hPathByID,
	rootEcho,
	type ForeignRefusal,
} from "./byId.js";
import { verifyWithinWindow } from "./convergence.js";
import {
	catchMutation,
	catchVerification,
	refuseDrift,
	type DriftFailure,
	type MutationFailure,
} from "./failure.js";

/** The per-id route's client subset (tests stub it): the block-move
 * endpoint plus the document-order walk — no SQL surface (the block
 * route's reads are walks). The write entry's WriteKernelClient extends
 * this, so the moveBlock contract is declared exactly once. The probe
 * capability lives on the write entry's composite — the flows receive
 * the probe result, not the client that produced it. */
export interface MoveBlockKernelClient extends ChildBlocksClient {
	moveBlock(params: {
		id: string;
		previousID?: string;
		parentID?: string;
	}): Promise<null>;
}

/** The doc route's client subset: the doc-move endpoint, the scoping
 * echo's SQL read, and the live-tree hpath read — no walk surface (a
 * child doc is not a block in its parent's tree). */
export interface MoveDocKernelClient extends SqlClient, HPathClient {
	moveDocsByID(params: { fromIDs: string[]; toID: string }): Promise<null>;
}

/** Outcome of the move-landed judgment over the post-move walk sets. Pure:
 * nothing here reads the kernel — the walks are captured by the caller.
 * Truncation facts (presences sound, absences unconfirmed) are the
 * `WalkedTree` invariant; the arms below name what each judgment does
 * with them.
 * - `landed` — the block is in the destination's post-move walk set and
 *   (cross-doc) gone from the source's; same-doc, it sits at the anchor's
 *   landing position. Presence facts survive a truncated walk, so the
 *   same-doc position judgment stays sound
 * - `absent-from-destination` — the block is absent from a COMPLETE
 *   destination walk (judged first: a source still holding it is reported
 *   here, not as `still-in-source`)
 * - `landing-unconfirmed` — an absence the walks cannot confirm: the block
 *   is absent from an incomplete destination walk, (cross-doc) absent from
 *   an incomplete source walk, or (same-doc) the anchor vanished from an
 *   incomplete walk, so the position fallback cannot rule out a silent
 *   no-op past the bound
 * - `still-in-source` — cross-doc only: the block appeared in the
 *   destination and is still visible in the source (a copy, not a move;
 *   a presence fact — sound even on an incomplete source walk)
 * - `misplaced` — same-doc only: the block is present but not at its
 *   landing position (`append: true` when the anchor is a doc-end append,
 *   whose landing is the doc's last top-level block) */
export type MoveBlockLandedOutcome =
	| { kind: "landed" }
	| { kind: "absent-from-destination" }
	| { kind: "landing-unconfirmed" }
	| { kind: "still-in-source" }
	| { kind: "misplaced"; append: boolean };

/** Verified, not trusted: a tree-level miss rolls back silently behind HTTP
 * success — the moved id must appear in the destination's post-move walk
 * set (and, cross-doc, be gone from the source's). Same-doc `move` verifies
 * POSITION, not presence: the block was already in this walk before the
 * move, so set membership cannot distinguish "landed" from a silent kernel
 * no-op behind HTTP success (e.g. a stale anchor after a concurrent edit).
 * Position = the anchor's `landingId` in the post-move walk. Only a
 * vanished anchor (concurrent delete) makes the position unverifiable —
 * fall back to membership: `moveBlock` validates `previousID`
 * synchronously and rejects one that names no block
 * (api/block_op.go, `moveBlock`), so the mutation cannot ack against a
 * vanished anchor — absence from the post-move walk can only mean the
 * anchor was deleted after a valid move, the one case where membership IS
 * the landed signal; the silent-skip classes are separately pre-checked
 * (`already-at-destination`, `own-subtree`). Over a truncated walk even
 * that fallback refuses (`landing-unconfirmed`) — a silent no-op past the
 * bound would read as landed.
 * Caller contract: when `sameDoc`, `postDestWalk` IS `postSourceWalk`. */
export function verifyMoveLanded(input: {
	blockId: string;
	anchor: MoveAnchor;
	sameDoc: boolean;
	postSourceWalk: WalkedTree;
	postDestWalk: WalkedTree;
}): MoveBlockLandedOutcome {
	if (!idSet(input.postDestWalk.blocks).has(input.blockId)) {
		return input.postDestWalk.incomplete
			? { kind: "landing-unconfirmed" }
			: { kind: "absent-from-destination" };
	}
	if (!input.sameDoc) {
		const sourceTree = idSet(input.postSourceWalk.blocks);
		if (sourceTree.has(input.blockId)) {
			return { kind: "still-in-source" };
		}
		if (input.postSourceWalk.incomplete) {
			// "Gone from the source" is a negative fact — unconfirmed over an
			// incomplete walk, so landed cannot be rendered.
			return { kind: "landing-unconfirmed" };
		}
	}
	if (input.sameDoc) {
		const { anchor, blockId, postSourceWalk } = input;
		const walk = postSourceWalk.blocks;
		const anchorPresent =
			anchor.kind === "append" || walk.some((b) => b.id === anchor.previousID);
		if (anchorPresent) {
			if (landingId(walk, anchor) !== blockId) {
				return { kind: "misplaced", append: anchor.kind === "append" };
			}
		} else if (postSourceWalk.incomplete) {
			// The vanished-anchor fallback renders membership — a positive fact
			// — but only BECAUSE the position check is unrunnable; on an
			// incomplete walk the block could also be a silent no-op sitting
			// past the bound, so "landed" would outrun the evidence.
			return { kind: "landing-unconfirmed" };
		}
	}
	return { kind: "landed" };
}

/** Outcome of the verified block move, as a closed union:
 * - `judged` — the mutation's transport succeeded and the landing was
 *   judged; `verdict` is the move-landed judgment, and BOTH post-move
 *   walks ride the arm (they are the judgment's evidence — the consumer's
 *   baseline seeding must consume this exact snapshot, not re-fetch
 *   around it). Same-doc, `postDestWalk` IS `postSourceWalk`.
 * - `not-in-source` — pre-mutation scoping refusal (both legs): blockId
 *   names no block of the claimed source doc `rootId`. Same-doc is judged
 *   on the caller-held `preDestWalk` (it IS the source walk); cross-doc
 *   the source walk is fetched by the dispatch entry's single fetch. The
 *   kernel mutates by raw block id with no doc scoping of its own (the
 *   foreign-gate fact homed on `sectionSubjectOf`) — so an unchecked
 *   foreign id would land in the destination and read as `landed` behind
 *   the walk-set judgment's blind spot
 * - `already-at-destination` / `own-subtree` — pre-mutation placement
 *   refusals (same-doc only; zero kernel calls, judged on `preDestWalk`):
 *   the block already sits at the anchor's landing position, or the anchor
 *   sits inside the moved block's own subtree — both are kernel no-ops
 *   acked with unconditional HTTP success (the self-anchor skips the tx
 *   and an anchor inside the moved block's subtree is the same
 *   `TxErrCodeSkipTx` skip class, `transaction.go`), while the walk-set
 *   judgment would read the ignored request as `misplaced`
 * - `heading-absent` — pre-mutation anchor-derivation refusal, zero
 *   kernel calls: the `toHeadingId` the entry derives the per-id anchor
 *   from names no heading of the caller-held destination walk.
 *   The arm carries the judged-absent id — the consumer words the
 *   subject from the verdict, never its own parameter
 * - `walk-truncated` — pre-mutation refusal, zero kernel calls: a walk
 *   the pre-mutation judgments depend on hit the depth bound (same-doc:
 *   the caller-held destination walk; cross-doc: the fetched source
 *   walk), so the scoping and placement judgments would read absences
 *   from incomplete evidence. The drift gate rides the dispatch entry's
 *   top level, before any route dispatch — this union never carries it.
 * - `transport-unverified` / `kernel-refused` /
 *   `verification-failed` — the shared pre-judgment ladder's
 *   post-derivation arms; each carries the `anchor` the move issued, so
 *   the consumer's failure ladder spreads the verdict's anchor instead of
 *   a pre-derived one (the drift arm precedes the derivation and carries
 *   none). A transport failure is never renderable as "unreachable"; a
 *   kernel refusal is kernel-verbatim (e.g. the ancestor-move class,
 *   rejected synchronously with no pre-check); a verification failure
 *   means the move may already be applied — the cause leg carries the
 *   recovery evidence */
export type MoveBlockOutcome =
	| {
			kind: "judged";
			verdict: MoveBlockLandedOutcome;
			/** The anchor the move issued — the entry derives it on held
			 * walks; the consumer's echoes spread this, never a pre-derived
			 * one. */
			anchor: MoveAnchor;
			postSourceWalk: WalkedTree;
			postDestWalk: WalkedTree;
	  }
	| { kind: "not-in-source"; blockId: string }
	| { kind: "already-at-destination"; blockId: string }
	| { kind: "own-subtree"; blockId: string }
	| SectionRefusal
	// The three post-derivation ladder arms carry the issued anchor.
	| (Exclude<MutationFailure, DriftFailure> & { anchor: MoveAnchor });

/** The per-id core: scoping → placement refusals → mutation → post-move
 * walks → `verifyMoveLanded`, over the walks the entry hands in. The
 * dispatch entry fetches the source walk ONCE for both routes (the
 * section sequence reads its row type and its enumeration off the same
 * fetch), owns the drift gate and the destination-walk provenance gate
 * before dispatch, and derives the anchor on the caller-held destination
 * walk — so the core trusts `sourceWalk`'s root (it fetched it) and
 * `preDestWalk`'s (it gated it). Module-level export for this repo's
 * suites; the public surface is `moveVerified`'s per-id route. The arm
 * rationales live on `MoveBlockOutcome`; classification rides the shared
 * fork (`catchMutation` / `catchVerification` in failure.ts). */
export async function moveBlockCore(
	client: MoveBlockKernelClient,
	input: {
		blockId: string;
		anchor: MoveAnchor;
		rootId: string;
		destRootId: string;
		/** The source doc's pre-move walk — the entry's single fetch. */
		sourceWalk: WalkedTree;
		/** The pre-move destination walk — same-doc it IS `sourceWalk`
		 * (one object serves both roles). */
		preDestWalk: WalkedTree;
		sameDoc: boolean;
	},
): Promise<MoveBlockOutcome> {
	// Pre-mutation scoping refusal — the `not-in-source` arm. The
	// truncation refusal here is also the fold-blind rule's second half:
	// the entry's dispatch reads the row type off the walk, so a
	// section-bearing heading past the depth bound reaches only this
	// route, and this refusal is what stops it.
	if (input.sourceWalk.incomplete) return { kind: "walk-truncated" };
	if (!input.sourceWalk.blocks.some((b) => b.id === input.blockId)) {
		return { kind: "not-in-source", blockId: input.blockId };
	}
	// Pre-mutation placement refusals, same-doc only (cross-doc the docs'
	// subtrees are disjoint and the moved id is not yet in the
	// destination's tree, so neither check can fire).
	if (input.sameDoc) {
		const { anchor, blockId } = input;
		const destWalk = input.preDestWalk.blocks;
		if (
			(anchor.kind === "move" && anchor.previousID === blockId) ||
			landingId(destWalk, anchor) === blockId
		) {
			return { kind: "already-at-destination", blockId };
		}
		const previousID = anchor.kind === "move" ? anchor.previousID : undefined;
		const anchorBlock =
			previousID === undefined
				? undefined
				: destWalk.find((b) => b.id === previousID);
		if (
			anchorBlock !== undefined &&
			inSubtree(anchorBlock, blockId, byIdMap(destWalk))
		) {
			return { kind: "own-subtree", blockId };
		}
	}
	try {
		if (input.anchor.kind === "append") {
			// Empty destination: moveBlock's parentID branch prepends, which IS
			// the end position when there is nothing to be after.
			await client.moveBlock({
				id: input.blockId,
				parentID: input.destRootId,
			});
		} else {
			await client.moveBlock({
				id: input.blockId,
				previousID: input.anchor.previousID,
			});
		}
	} catch (err) {
		return { ...catchMutation(err), anchor: input.anchor };
	}
	// A network drop here must never read as "unreachable" — the move may
	// already be applied; the walks ride the `judged` arm as evidence.
	try {
		const postSourceWalk = await walkBlockTree(client, input.rootId);
		const postDestWalk = input.sameDoc
			? postSourceWalk
			: await walkBlockTree(client, input.destRootId);
		const verdict = verifyMoveLanded({
			blockId: input.blockId,
			anchor: input.anchor,
			sameDoc: input.sameDoc,
			postSourceWalk,
			postDestWalk,
		});
		return {
			kind: "judged",
			verdict,
			anchor: input.anchor,
			postSourceWalk,
			postDestWalk,
		};
	} catch (err) {
		return { ...catchVerification(err), anchor: input.anchor };
	}
}

/** The dispatch entry's client subset: the per-id route's subset plus the
 * batched route's transaction — the section route consumes no doc-move
 * surface. `WriteKernelClient` composes the whole subset. */
export type MoveVerifiedKernelClient = MoveBlockKernelClient & TransactClient;

/** The two-route move's closed wrapper over the two routes' outcome unions:
 * the `kind` discriminant names which sequence ran, and the consumer
 * switches exhaustively at both levels — the wrapper's kind, then the
 * route's own union. The pre-dispatch refusals — drift (the probe gate
 * precedes any route dispatch) and the destination-walk provenance gate —
 * ride the wrapper's top level: they are route-agnostic, and wrapping
 * them in a route arm would name a route that never ran. */
export type MoveVerifiedOutcome =
	| DriftFailure
	| ForeignRefusal
	| { kind: "per-id"; outcome: MoveBlockOutcome }
	| { kind: "section"; outcome: MoveSectionOutcome };

/** The verified move, whole — the two-route `mode: move`'s one primitive
 * call and the flow's one entry. The route is a row-type judgment read off
 * the source walk the entry fetches once ("is `blockId` a heading?"): a
 * heading — memberless or not — rides the batched section sequence, a
 * non-heading block rides the per-id core. The dispatch keys on the row
 * type, never on section-bearingness, so the caller never needs to know
 * whether a heading bears a section before calling.
 *
 * Walk rule: the entry takes the caller's destination walk and owns the
 * source walk's single fetch — same-doc the caller's walk IS the source
 * walk, cross-doc the entry fetches it by `rootId` and no path fetches it
 * twice. Anchor rule: both routes' anchors derive inside on held walks,
 * and every verdict carries the anchor its route used (`judged` and the
 * post-derivation failure arms) — the consumer's echoes spread the
 * verdict's anchor, never a pre-derived one. The derivation's two
 * refusal arms ride the per-id union (`walk-truncated`,
 * `heading-absent`).
 *
 * A `blockId` absent from the source walk dispatches per-id: the scoping
 * arm's wording ("not a block of the source doc") is route-neutral, and
 * over a truncated walk the absence is unconfirmed — the core's
 * `walk-truncated` arm refuses it. The drift gate precedes the
 * source-walk fetch (no kernel contact on a drifted kernel) and both
 * pre-dispatch refusals ride the wrapper's top level, route-agnostic
 * (these arms are defence-in-depth beside the caller's cached-verdict
 * gate). */
export async function moveVerified(
	client: MoveVerifiedKernelClient,
	probe: KernelProbeResult,
	input: {
		blockId: string;
		/** Source doc root — the moved block's doc before the move. */
		rootId: string;
		/** Destination doc root (≡ rootId when sameDoc). */
		destRootId: string;
		/** The caller-held destination walk — the flow serves and seeds
		 * from it; same-doc it IS the source walk. */
		preDestWalk: WalkedTree;
		/** The destination section's heading, or undefined for the doc-end
		 * form. */
		toHeadingId?: string | undefined;
	},
): Promise<MoveVerifiedOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// Same-doc is the two roots' agreement, never a caller-supplied flag.
	const sameDoc = input.rootId === input.destRootId;
	// The destination walk is provenance-gated before either route
	// consumes it (`foreignRefusalOf` carries the rationale).
	const foreign = foreignRefusalOf(
		input.preDestWalk,
		input.destRootId,
		input.blockId,
	);
	if (foreign !== undefined) return foreign;
	// The entry's single source-walk fetch — both routes read off it;
	// same-doc the caller-held walk serves.
	const sourceWalk = sameDoc
		? input.preDestWalk
		: await walkBlockTree(client, input.rootId);
	const row = sourceWalk.blocks.find((b) => b.id === input.blockId);
	if (row !== undefined && isHeadingBlock(row)) {
		return {
			kind: "section",
			outcome: await moveSectionVerified(client, {
				blockId: input.blockId,
				rootId: input.rootId,
				destRootId: input.destRootId,
				sourceWalk,
				preDestWalk: input.preDestWalk,
				...(input.toHeadingId !== undefined
					? { toHeadingId: input.toHeadingId }
					: {}),
			}),
		};
	}
	// Per-id route: the row is absent (the core's scoping/truncation arms
	// word it) or a non-heading block. The anchor derives on the caller-held
	// destination walk — zero kernel calls in the derivation or its
	// refusals.
	const anchor = deriveMoveAnchor(input.preDestWalk, input.toHeadingId);
	if (anchor.kind === "walk-truncated" || anchor.kind === "heading-absent") {
		return { kind: "per-id", outcome: anchor };
	}
	return {
		kind: "per-id",
		outcome: await moveBlockCore(client, {
			blockId: input.blockId,
			anchor,
			rootId: input.rootId,
			destRootId: input.destRootId,
			sourceWalk,
			sameDoc,
			preDestWalk: input.preDestWalk,
		}),
	};
}

/** The doc-level landed judgment. A child doc is NOT a block in its
 * parent's tree (the destination's walk never contains the
 * moved doc's id), so the block move's walk-membership judgment is
 * meaningless for doc nesting. The judgment rides the live-tree hpath
 * ground truth instead: the kernel resolves getHPathByID from the live
 * tree synchronously, while the blocks index lags (still the pre-move
 * value immediately after moveDocsByID — never a valid landing signal).
 * Doc destination: the moved doc's hpath must equal the
 * destination's hpath + "/" + title. Notebook root: "/" + title. The
 * observed hpath rides both arms — it is the judgment's evidence and the
 * consumer's echo. */
export type MoveDocLandedOutcome =
	| { kind: "landed"; hpath: string }
	| { kind: "not-landed"; hpath: string };

/** Outcome of the verified doc-level move — same closed-union shape and
 * phase discipline as MoveBlockOutcome: `judged` (with the landed judgment
 * whose hpath evidence the echo consumes), `not-in-source` (pre-mutation
 * scoping refusal: docId names no doc row of the claimed notebook in the
 * blocks index), `drift` (checked before any kernel call),
 * `transport-unverified` (mutation phase, outcome UNKNOWN),
 * `kernel-refused` (synchronous rejection verbatim — the ancestor-move
 * class (its identity member, fromID ≡ toID, included) and the depth cap
 * reject synchronously, no pre-check), and `verification-failed` (the
 * hpath evidence read itself failed; the move may already be applied). */
export type MoveDocOutcome =
	| { kind: "judged"; verdict: MoveDocLandedOutcome }
	| { kind: "not-in-source"; docId: string }
	| MutationFailure;

/** The verified doc-level move, whole: scoping + ground-truth title capture
 * → moveDocsByID → the live-tree hpath judgment. The judgment composes
 * its expected hpath over the STORED title (`rootEcho` row — the kernel
 * normalizes titles at storage, and a concurrent rename must not read as
 * a failed move). The scoping read polls the convergence window (kb_read
 * serves doc ids from the LIVE walk, so a doc minted moments ago inside
 * the index-convergence window must be polled, not refused); window
 * exhaustion is exactly the `not-in-source` refusal, and a transport
 * failure in the attempt still rethrows verbatim (pre-mutation, nothing
 * applied). Classification mirrors the block move (the shared fork in
 * failure.ts). */
export async function moveDocVerified(
	client: MoveDocKernelClient,
	probe: KernelProbeResult,
	input: {
		docId: string;
		/** The moved doc's notebook — the notebook-root destination's toID
		 * and the scoping read's box. */
		boxId: string;
		/** Destination doc root id; undefined moves the doc to its notebook
		 * root (the kernel's un-nest). */
		destRootId?: string | undefined;
	},
): Promise<MoveDocOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// Scoping + ground-truth capture in one read — the `not-in-source`
	// arm; transport failures propagate verbatim (pre-mutation).
	const movedEcho = await verifyWithinWindow(() =>
		rootEcho(client, input.boxId, input.docId),
	);
	if (movedEcho === undefined) {
		return { kind: "not-in-source", docId: input.docId };
	}
	try {
		await client.moveDocsByID({
			fromIDs: [input.docId],
			toID: input.destRootId ?? input.boxId,
		});
	} catch (err) {
		return catchMutation(err);
	}
	// The moved doc's live-tree hpath is both the judgment and the echo;
	// the destination's rides the live tree too (the same source the
	// judgment compares against — a settled index is not a precondition).
	try {
		const moved = await hPathByID(client, input.docId);
		const expected =
			input.destRootId === undefined
				? `/${movedEcho.title}`
				: `${await hPathByID(client, input.destRootId)}/${movedEcho.title}`;
		const verdict: MoveDocLandedOutcome =
			moved === expected
				? { kind: "landed", hpath: moved }
				: { kind: "not-landed", hpath: moved };
		return { kind: "judged", verdict };
	} catch (err) {
		return catchVerification(err);
	}
}
