/**
 * Read barrel — the default entry point of siyuan-kernel-primitives.
 *
 * Reports only: read primitives (block-tree walk, by-ID reads,
 * title-guard reads, the content hash, the extended-outline
 * renderer, the search fan-out, notebook resolution, SQL string
 * escaping), the version pin and probe, and the re-exported layer-1
 * identity surface. No write primitive is reachable from here;
 * kernel mutations live exclusively behind "./write" — the
 * fresh-content judgment rides the write path too (the internal guard
 * composes it), so only its pure hash function stays here.
 *
 * Outcome unions carry evidence — kinds, ids, rows — never agent-facing
 * prose; the consumer owns every word.
 *
 * The public surface is hand-maintained — kept in sync with the modules'
 * exports and the package's public API, which is the source of truth, not
 * any one consumer's import list. Barrel completeness over the modules'
 * exports is enforced by index.test.ts.
 */

// Layer-1 identity surface: consumers take the client constructor, the
// error classes, and the kernel types through this barrel — never from
// siyuan-kernel-api directly — so every install holds exactly one
// layer-1 copy and instanceof checks cannot see a second.
export { SiYuanKernelClient } from "siyuan-kernel-api";
export {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanKernelError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
export type {
	BlockTransaction,
	ChildBlock,
	EncryptedBoxStatus,
	EncryptedNotebookStatus,
	ExportMarkdownResult,
	NotebookInfo,
	NotebookList,
	SearchBlock,
	SearchResult,
	SiYuanKernelClientOptions,
} from "siyuan-kernel-api";

// The layer-1 classification — the class list's one home is failure.ts
// (whose write-verdict vocabulary rides ./write); the classifier and its
// cause union are the identity surface's classification half, so read-path
// consumers (the gate, session validation) classify without reaching
// ./write.
export { causeOf } from "./failure.js";
export type { KernelCause } from "./failure.js";

// The capability subsets are nameable so a consumer can type a stub
// against exactly the reads its flow consumes; KernelReadClient is their
// composition.
export type {
	ChildBlocksClient,
	HPathClient,
	KernelReadClient,
	SearchBlockRow,
	SearchClient,
	SqlClient,
} from "./client.js";
export { TARGETABLE_CONTAINER_TYPES } from "./containers.js";
export {
	headingLevel,
	headingRows,
	isHeadingBlock,
	resolveHeadingTarget,
	type HeadingTarget,
	type SectionRefusal,
} from "./heading.js";
export {
	partitionByAbsence,
	walkBlockTree,
	type WalkedBlock,
	type WalkedTree,
	type WalkTruncated,
} from "./walk.js";
export {
	docBody,
	readDoc,
	type BodyChildRow,
	type DocBodyResult,
	type ReadDocResult,
} from "./body.js";
export { renderExtendedOutlineLines } from "./outline.js";
// The placement projections (the section rule and the projections derived
// from it) are pure over a walk the caller already holds — zero kernel
// calls, no mutation — so they ride the read barrel, like
// resolveHeadingTarget; `./write` stays exactly the mutation-capable
// specifier.
export {
	appendAnchorOf,
	deriveAppendAnchor,
	deriveMoveAnchor,
	sectionOf,
} from "./placement.js";
export { orphanedMembersOf } from "./receipt.js";
export type {
	AppendAnchor,
	AppendPlacement,
	MoveAnchor,
	Section,
	SectionResult,
} from "./placement.js";
export type { OrphanedMembers } from "./receipt.js";
export type { PartitionByAbsence } from "./walk.js";
export { sqlString } from "./sql.js";
export { contentHash } from "./fresh.js";
export {
	PINNED_SIYUAN_VERSION,
	probeKernel,
	type KernelProbeClient,
	type KernelProbeResult,
} from "./version.js";
export {
	AUTH_DODGE_THRESHOLD,
	authLockSeconds,
	authLockDodge,
	authDodgeTripped,
	type AuthDodgeState,
	type AuthDodgeEvent,
} from "./authLock.js";
export { keywordSearchBoxes, type BoxSearchResult } from "./search.js";
export {
	blockContents,
	blockInDoc,
	firstChildContent,
	hPathByID,
	ownership,
	ownershipStmt,
	rootEcho,
	type BlockInDocResult,
	type RootEchoRow,
} from "./byId.js";
export { backlinkCheck } from "./refs.js";
export {
	GUARD_EXACT_CAP,
	GUARD_NEAR_CAP,
	findTitleMatches,
	guardExactStmt,
	guardNearStmt,
	type GuardRow,
	type TitleMatchResult,
} from "./titleGuard.js";
export {
	resolveNotebooks,
	type NotebookProblem,
	type ResolvedNotebooks,
} from "./notebooks.js";
