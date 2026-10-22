// Write entry — the "./write" subpath of siyuan-kernel-primitives: the
// barrel over the verified mutation flows (one module per flow — create,
// edit, insert, replace, move (with moveSection, the batched section arm
// the move entry dispatches to), delete, deleteSection; the section flows'
// shared delete core stays internal to sectionDeleteCore.ts, and
// failure.ts owns the shared pre-judgment ladder).
// Mutation and landing judgment as one call, each self-refusing on
// version-coupled grounds (drift, silent rollback): the drift arm is
// produced solely by `refuseDrift`, which every flow calls before any
// kernel call — the phase classifiers (`catchMutation`/
// `catchVerification`) never emit it. Every outcome is a closed
// `{ kind, …detail }` union carrying the evidence the consumer needs —
// never agent-facing sentences; the consumer owns every word.
// Read-only consumers import the default entry point instead; reaching
// this specifier is a deliberate, greppable act.

import type { KernelReadClient, TransactClient } from "./client.js";
import type { MoveBlockKernelClient, MoveDocKernelClient } from "./move.js";
import type { DeleteKernelClient } from "./delete.js";
import type { InsertKernelClient } from "./insert.js";
import type { EditKernelClient } from "./edit.js";
import type { CreateKernelClient } from "./create.js";
import type { KernelProbeClient } from "./version.js";

/** The caller's single write-side handle: every write flow's client
 * subset, plus the probe base the caller drives before any flow runs.
 * The flow subsets stay narrow (each declares only the endpoints it
 * consumes — the read capabilities they extend are client.ts's capability
 * subsets, not the full KernelReadClient; this composite keeps the whole
 * read surface); the probe capability rides here because no one can run
 * the write path without a client that can both probe and mutate — the
 * flows receive the probe RESULT, never the client that produced it.
 * Each subset's endpoint contracts are declared by its own flow module;
 * deleteBlock's is single-homed in client.ts's DeleteBlockClient (the
 * block delete consumes it) and transact's in TransactClient (the
 * batched sequences' shared foundation). */
export interface WriteKernelClient
	extends
		KernelReadClient,
		MoveBlockKernelClient,
		MoveDocKernelClient,
		DeleteKernelClient,
		InsertKernelClient,
		EditKernelClient,
		CreateKernelClient,
		TransactClient,
		KernelProbeClient {}

// The shared pre-judgment failure ladder — declared once in failure.ts
// (a leaf, so the flow modules can depend on it without a cycle) and
// composed by each flow's outcome union. VerificationCause names the
// recovery evidence the verification-failed arm carries.
export type { MutationFailure, VerificationCause } from "./failure.js";
export type {
	KernelRefusal,
	JudgedTransportFailure,
	JudgedWalkFailure,
} from "./failure.js";

// The block-scoping refusal arms — declared once in byId.ts beside the
// blockInDoc judgment they project, composed into the block delete
// outcome union. ForeignRefusal is the `foreign` arm's own name — the
// section-shaped flows' caller-provenance refusal composes it directly.
export type { ScopingRefusal, ForeignRefusal } from "./byId.js";

// The fresh-content guard's shared refusal arm and its verdict
// vocabulary — declared in fresh.ts beside the judgment that renders
// them; the judgment functions themselves are internal to the
// primitives (the guards are their only consumers).
export type {
	FreshOutcome,
	StaleFreshArm,
	FreshRefusal,
	ServedBaseline,
	BaselineLookup,
} from "./fresh.js";

// Verified block and doc moves — see move.ts for the kernel facts. The
// two-route `mode: move` enters through moveVerified: the row-type dispatch
// over the per-id and batched section routes, one call, the route and the
// anchors decided inside on the walks it holds.
export { moveDocVerified, moveVerified } from "./move.js";
export type {
	MoveBlockOutcome,
	MoveDocLandedOutcome,
	MoveDocOutcome,
	MoveBlockLandedOutcome,
	MoveVerifiedOutcome,
} from "./move.js";

// The verified section move — the batched route's raw-move codec, judged
// from the per-touched-doc post-write walks (see moveSectionPlan.ts for
// the kernel facts). moveVerified dispatches every heading here,
// memberless or not; the sequence itself stays internal — the dispatch is
// the one entry, and a public second entrance would bypass the row-type
// decision the fold-blind rule rests on.
export type {
	MoveSectionOutcome,
	MoveSectionUnverified,
} from "./moveSection.js";
export type { MoveSectionRefusal } from "./moveSectionPlan.js";
// The landed arm's payload types — exported so a consumer can name the
// public verdict's field shapes instead of re-declaring them inline.
export type { MoveSectionDestination } from "./moveSection.js";
export type { SectionOwner } from "./receipt.js";

// The batched sequences' shared phase unions, re-exported from
// `batch.ts`; the per-sequence names above alias these for their own
// docstrings.
export type { BatchedRefusal, BatchedUnverified } from "./batch.js";

// The verified section delete — heading plus every member, ONE kernel
// transaction over the batched-route foundation (see deleteSection.ts for
// the kernel facts: the fold-blind heading delete, the cascade-bounded
// set, the walk partition and its cause-free all-or-nothing arm).
export { deleteSectionVerified } from "./deleteSection.js";
export type {
	DeleteSectionOutcome,
	DeleteSectionRefusal,
	DeleteSectionUnverified,
	DeleteSectionVerdict,
} from "./deleteSection.js";

// Verified block and doc deletes — see delete.ts for the kernel facts.
export { deleteBlockVerified, deleteDocVerified } from "./delete.js";
export type {
	DeleteBlockOutcome,
	DeleteDocOutcome,
	DeleteLandedOutcome,
} from "./delete.js";

// The verified insert — the mutation the append flow and the replace
// sequence's insert leg both serve.
export { insertVerified } from "./insert.js";
export type {
	InsertLandedOutcome,
	InsertOutcome,
	InsertUnlandedVerdict,
} from "./insert.js";

// The verified edit and its edit-landed judgment — mechanics in edit.ts.
export { editVerified } from "./edit.js";
export type { EditOutcome, EditLandedOutcome, JudgedEditRow } from "./edit.js";

// The replace-section sequence, whole: enumeration and anchor derived
// internally from the caller-held pre-mutation walk, insert before the
// batched delete leg (the plan phase runs pre-insert, the apply phase
// after the landed insert).
export { replaceSectionVerified } from "./replace.js";
export type {
	ReplaceSectionOutcome,
	ReplaceSectionRefusal,
	ReplaceSectionUnverified,
	ReplaceSectionVerdict,
} from "./replace.js";

// The guarded-create core.
export {
	MINT_TITLE_MAX_RUNES,
	createDocVerified,
	mintTitleProblem,
} from "./create.js";
export type { CreateDocOutcome, MintTitleProblem } from "./create.js";
