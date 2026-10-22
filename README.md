# siyuan-kernel-primitives

Deterministic primitives over [SiYuan](https://github.com/siyuan-note/siyuan)'s
kernel API, for anyone building on a SiYuan knowledge base without wanting to
re-derive its sharp edges. Built on
[`siyuan-kernel-api`](https://github.com/coreyryanhanson/siyuan-kernel-api),
a typed thin HTTP client — this package adds the layer the thin client
deliberately does not have: judgment.

Written against one pinned kernel — SiYuan **3.8.8** — and pre-1.0: names
and arm shapes may still move before 1.0.

**Contents:** [Why this exists](#why-this-exists) · [Install](#install) ·
[The surface](#the-surface) · [Usage](#usage) ·
[Version coupling and upgrades](#version-coupling-and-upgrades) ·
[Client](#client) · [Development](#development)

## Why this exists

SiYuan's kernel behaves in ways its HTTP API results don't advertise, and
getting them wrong means silently wrong data. This package encodes that
knowledge as tested, version-pinned primitives:

- **Doc identity is the doc id.** `hpath` is a derived display label, never
  an address — yet the create endpoint *takes* an hpath path. Resolving a
  parent by id, composing the mint path, and asserting what actually landed
  is one temporal judgment (`createDocVerified`), not three calls.
- **Document order lives in the block tree, not SQL.** `blocks.sort` is a
  type weight, not document position. The only faithful structure read is a
  `getChildBlocks` walk — `walkBlockTree` does it in document order, with
  true parentage, bounded depth, and a `tolerateVanished` mode (`boolean`,
  or `"belowRoot"` which keeps the root call strict) for read paths.
- **DML through `/api/query/sql` is a silent no-op.** SQL that "succeeds"
  changed nothing. Writes are verified against the live tree, never trusted
  from the HTTP result.
- **Async convergence.** `blocks.content`, `refs`, and `hpath` settle
  asynchronously behind a write (hpath last). The verify loops poll the
  pinned retry schedule (150 ms → 2000 ms, ~4 s worst case) instead of
  assuming immediacy.
- **Content has two render forms that must agree.** `blocks.content` and
  walk-form content are both rendered by the kernel's one content builder,
  so baselines seeded from either form compare equal against either read —
  and the fresh-content judgment fails closed (names `stale`) if a kernel
  ever splits the forms, instead of silently matching.
- **Titles are stored verbatim, unescaped, in `blocks.content`** — the fact
  the title guard is built on: the exact leg is a verbatim `=` equality,
  the near leg LIKE prefixes (`findTitleMatches`).
- **The body read rides the walk's own rendering, not the export
  endpoint.** `exportMdContent` renders a doc for sharing and synthesizes
  doc-level frontmatter from root IAL — a write path fed from it corrupts
  the document. The walk field's per-child `markdown` is the stored body's
  rendering; `readDoc`/`docBody` serve it with the empty-export omission
  counted in `omittedEmpty`.
- **Auth lock scheduling.** Auth failures inside the kernel's 15-minute
  sliding window arm a per-IP lock (starting at the 6th, `30 << (fail − 5)`
  s, 15-min cap, re-armed by any call made during the lock).
  `authLockSeconds` is the exported formula, and `authLockDodge` the
  exported reducer over it, so callers can dodge the lock instead of
  extending it.

Everything here is written against **one pinned kernel version**
(`PINNED_SIYUAN_VERSION`). This is the only layer in the stack coupled to a
specific SiYuan version, and it refuses rather than guesses: `probeKernel`
reports drift, and the write primitives take that verdict as a required
parameter — a drifted kernel refuses writes before any kernel call.

Deliberately not here: a SQL-routed write path, an export-endpoint body
read, and any retry or circuit-breaker helper — failure policy stays with
the consumer, which is why write outcomes are unions rather than throws.

## Install

```sh
npm install siyuan-kernel-primitives
```

No build step: the package ships raw TypeScript (`"type": "module"`, ESM;
entry points and `types` both pointing at `.ts` files).

Your runtime or bundler must transform TypeScript **inside `node_modules`**
(`tsx` does, for instance). Node's own loader deliberately does not — it
refuses type stripping under `node_modules` at every version
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — so a plain `node` process
must compile this package as part of its own build. `engines` (Node ≥ 20)
names the floor for that path, not a claim that `node` alone can load the
sources.

## The surface

Three entry points; deep imports fail by design (the exports map is the
API):

```ts
// Read barrel — reports only.
import { walkBlockTree, findTitleMatches, probeKernel } from "siyuan-kernel-primitives";

// The only path to the write verdicts.
import { createDocVerified, editVerified, insertVerified } from "siyuan-kernel-primitives/write";

// Test-only: a SQL-routed stub routes on statement identity.
import { statementKind } from "siyuan-kernel-primitives/testing";
```

The default entry exposes no write **primitives**. It provides reads, the
pin/probe, layer-1 error classification (`causeOf`, `KernelCause`), and the
re-exported `siyuan-kernel-api` identity surface. Note that while the client
is write-capable by design, the identity surface is not a write primitive.

Importing `"…/write"` is a deliberate, greppable act; a read-only consumer's
constraint is one grep away. The `"…/testing"` entry provides the SQL routing
classifier for test stubs. Every write outcome is a closed
`{ kind, …detail }` union — the primitive returns structured facts, and the
consumer words the result.

### Read barrel (`siyuan-kernel-primitives`)

- `walkBlockTree` (`WalkedTree`, `WalkedBlock`, `WalkTruncated`) — the
  document-order tree and its completeness facts.
- `docBody`, `readDoc` — the stored body and its rows;
  `renderExtendedOutlineLines` — the heading tree with containers and ids.
- `isHeadingBlock`, `headingLevel`, `headingRows`, `resolveHeadingTarget` —
  heading judgments, including the pre-mutation target check.
- `sectionOf`, `appendAnchorOf`, `deriveAppendAnchor`, `deriveMoveAnchor`,
  `TARGETABLE_CONTAINER_TYPES` — the section rule, the placement anchors,
  and the container vocabulary.
- `partitionByAbsence`, `orphanedMembersOf` — the presence/absence split and
  the members a heading still holds after a delete.
- `findTitleMatches` (with `GUARD_EXACT_CAP`, `GUARD_NEAR_CAP`,
  `guardExactStmt`, `guardNearStmt`) — the notebook-scoped title guard and
  the statement text your own probe can run.
- `keywordSearchBoxes`, `resolveNotebooks`, `backlinkCheck` — the per-box
  search fan-out, notebook resolution, and the refs-graph read.
- `blockInDoc`, `blockContents`, `firstChildContent`, `hPathByID`,
  `ownership`, `ownershipStmt`, `rootEcho` — by-ID reads; `sqlString` — the
  only way ids and titles enter SQL.
- `contentHash`, `PINNED_SIYUAN_VERSION`, `probeKernel` — the baseline
  digest, the pin, and its verdict.
- `authLockSeconds`, `authLockDodge`, `authDodgeTripped`,
  `AUTH_DODGE_THRESHOLD` — the auth-lock schedule and the dodge reducer.
- `causeOf`, `KernelCause` — layer-1 error classification.
- `SiYuanKernelClient`, the error classes, the kernel types — the layer-1
  identity surface; `SqlClient`, `ChildBlocksClient`, `SearchClient`,
  `HPathClient`, `KernelReadClient` — the capability subsets a stub can
  declare.

### Write barrel (`siyuan-kernel-primitives/write`)

- `createDocVerified` (with `mintTitleProblem`, `MINT_TITLE_MAX_RUNES`) —
  the guarded create and its pre-mutation title judgment.
- `editVerified`, `insertVerified` — the verified edit and insert.
- `replaceSectionVerified`, `moveVerified`, `moveDocVerified` — the
  replace-section sequence, the two-route move dispatch (a per-id block, or
  a batched section — the section move has no entry of its own), and the
  doc move.
- `deleteBlockVerified`, `deleteDocVerified`, `deleteSectionVerified` — the
  verified deletes.
- `WriteKernelClient` — the full client shape; `ServedBaseline`,
  `BaselineLookup`, `FreshOutcome`, `StaleFreshArm`, `FreshRefusal` — the
  fresh guard's surface.
- `MutationFailure`, `VerificationCause`, `KernelRefusal`,
  `JudgedTransportFailure`, `JudgedWalkFailure`, `BatchedRefusal`,
  `BatchedUnverified`, `ScopingRefusal`, `ForeignRefusal` — the shared
  failure and refusal taxonomy.

### Testing (`siyuan-kernel-primitives/testing`)

- `statementKind` — SQL statement routing, so a stub keys on statement
  identity rather than statement text.

Arm-level shapes are not restated here: each module's docstring is the
canonical statement of its union arms and kernel-coupled facts, and the
sources ship with the package.

## Usage

### Walk the block tree (document order, true parentage)

```ts
import { walkBlockTree } from "siyuan-kernel-primitives";

const { blocks, rootId, truncated, incomplete } = await walkBlockTree(
	client,
	docId,
);
// blocks: flat WalkedBlock[] in document order — id, type, subType, content,
// markdown?, parentId, parentType. `markdown` is the stored body render,
// presence-preserving: `undefined` means the kernel rendered nothing,
// never "".
// truncated: true when the walk's depth bound was hit — the walk's
// *presences* are sound (a seen block is genuinely there, its siblings and
// parent chain complete), but its *absences* are not. `incomplete` is the
// fact every judgment keys on — set for the depth bound AND for a tolerated
// vanish (a vanished/locked container ends that branch) — and every judgment
// over the walk names it instead of claiming absence
```

### Read the doc body (the walk's own rendering)

```ts
import { docBody, readDoc } from "siyuan-kernel-primitives";

// The standalone one-call stitch: one getChildBlocks call, body + rows.
const { body, children, omittedEmpty } = await docBody(client, docId);

// The unified read: walk facts and body in one traversal (plus rootId).
const { blocks, rootId, truncated, incomplete, body, children, omittedEmpty } =
	await readDoc(client, docId);
```

The body joins the top-level children's `markdown` with one blank line
between blocks and none trailing.

- **Rendering:** Each child's whole subtree renders fresh from the live
  tree. Refs use the stored `((id "text"))` form, query embeds are verbatim
  scripts, block IAL is suppressed (while span `style`/`custom-*` IAL is
  carried), and no frontmatter is synthesized — so write-backs re-import
  these as live blocks.
- **Empty Exports:** A child with absent `markdown` is a genuinely empty
  export — kept in `children`, omitted from `body`, and counted in
  `omittedEmpty`.
- **Identity Contract:** `readDoc` carries the walk's `rootId`. A doc root
  yields the full body, a container id yields its children, a heading id
  yields its section, and a valid leaf id yields an empty body with no
  children. An empty doc answers the same empty body but keeps its one
  empty-paragraph row.

One caveat is absorbed by design: an empty leaf inside a container rides
the container's `markdown` (the container arm does not omit), but an
import parse cannot re-create an empty paragraph, so a write-back drops
the leaf and the body changes once, then stabilizes.

### The fresh-content precondition is enforced inside the writes

You cannot forget the freshness check: the destroy-shaped write primitives
(`editVerified`, `deleteBlockVerified`, `replaceSectionVerified`,
`deleteSectionVerified`) take the session's served-baseline verdicts as a
required input and judge freshness internally, immediately before mutating.

- **A verdict** is `{ kind: "served", hash }` or `{ kind: "never-served" }`.
  The hash is `contentHash(row.content)` — the digest of a block's `content`
  as you served it, keyed by id.
- **Input shape**: a single `baseline` for `editVerified` (one target); a
  `baselineFor` lookup (`BaselineLookup`) for the walk-carriers, whose
  judged set the primitive derives from the walk it already holds. The
  lookup answers for any id that derivation can name, so the set never
  crosses the input surface and cannot be under-covered.
- **Refusal**: `fresh-refused` carries every judged arm plus the judged
  walk, and fires when a served target's content changed since it was
  served (the `stale` arm). The walk-derived flows render the absence arms
  unreachable by construction; `editVerified` additionally refuses
  `walk-truncated` when its target's absence is unconfirmed.
- **Uniform posture**: a mutation never proceeds on a judged arm it could
  not compare.

```ts
import { contentHash } from "siyuan-kernel-primitives";

// `row` is one of the walk rows you served. Seed one verdict per block id,
// hashing the `content` you served; `baselineFor` is that map's lookup.
const baseline = { kind: "served", hash: contentHash(row.content) } as const;
```

### Render the extended outline over a walk

```ts
import { renderExtendedOutlineLines, walkBlockTree } from "siyuan-kernel-primitives";

const tree = await walkBlockTree(client, docId);
const lines = renderExtendedOutlineLines(tree).lines;
// `tree.incomplete` names an incomplete walk — carry it, never render a
// partial doc as complete.
// SiYuan's heading tree plus what the kernel's own outline does not carry:
// container glyphs, write-targetability marks (`(not targetable)` on a
// refused parent), and the `→ <id>` payload the write flows echo back.
// Pure projection over the walk — no kernel calls, no session state;
// serving policy (baseline seeding, inline caps, spilling) stays with you.
```

### Ask "does this title already exist in this notebook?"

```ts
import { findTitleMatches } from "siyuan-kernel-primitives";

const { kind, rows, truncated } = await findTitleMatches(client, boxId, title);
// kind: "clear" | "duplicate" | "near" — verbatim match outranks near;
// a case-variant of a stored title classifies `near`, never `duplicate`.
// truncated: true when a leg hit its row cap (exact: GUARD_EXACT_CAP,
// near: GUARD_NEAR_CAP) — the verdict stands, the row set is partial.
// An empty title classifies `clear` with no kernel call at all (its near
// leg would degenerate to a bare `%` and match every doc in the box).
```

The guard SQL is box-scoped: a title in another notebook never stops a
create in this one.

### Search each box under its own window

```ts
import { keywordSearchBoxes } from "siyuan-kernel-primitives";

const results = await keywordSearchBoxes(client, {
	query: "kubernetes",
	boxIds: [notebookA, notebookB],
	pageSize: 64,
});
// One scoped call per box — the kernel shares ONE pageSize window across
// every paths entry of a call, so a hit-rich box silently crowds the other
// paths' matches out of a multi-path call. Each result carries its rows
// plus the window evidence: hidden (matches beyond the window) and dropped
// (response rows from outside the called box).
```

### Create a doc that you can prove landed

```ts
import { createDocVerified } from "siyuan-kernel-primitives/write";

const outcome = await createDocVerified(client, probe, {
	boxId, title, body, // parentId? for a nested doc
});
switch (outcome.kind) {
	case "created": /* outcome.docId, .content (stored title), .hpath */ break;
	case "drift": case "mint-title": case "parent-missing":
		/* refused before any kernel mutation */ break;
	case "kernel-refused":
		/* synchronous rejection — nothing was minted */ break;
	case "ghost-intermediate": case "hpath-mismatch":
		/* the mint landed somewhere else — re-read before retrying */ break;
	case "transport-unverified": case "unconfirmable": case "verification-failed":
		/* may already exist — do NOT retry blindly */ break;
}
```

The primitive reads the parent back, mints, then re-reads: ghost
intermediates (parent deleted/renamed mid-flight), kernel title
normalization, and unconfirmable/`hpath-mismatch` verification all come
back as typed refusals, not happy-path lies. On a transport failure the
doc may already exist — the outcome says so, and blind retry is on you
to rule out.

### Insert a block — with a caller-derived anchor

```ts
import { deriveAppendAnchor } from "siyuan-kernel-primitives";
import { insertVerified } from "siyuan-kernel-primitives/write";

// Placement is a pure projection over a walk you hold: the section-end
// position under `headingId`, or the doc's end when it is undefined.
// `sectionOf` + `appendAnchorOf` is the same rule when you already hold a
// Section.
const anchor = deriveAppendAnchor(walk, headingId);
if (anchor.kind === "walk-truncated" || anchor.kind === "heading-absent") {
	// refused pre-mutation — no kernel call was made
} else {
	const outcome = await insertVerified(client, probe, {
		// AppendAnchor: `append` to `containerId` (null is the doc root), or
		// `insert` before `nextID`.
		anchor,
		body,
		rootId,
		preWalk: walk, // the caller-held PRE-mutation walk
	});
	// { kind: "judged", verdict, postWalk } | walk-truncated | MutationFailure.
	// verdict: `landed` | `no-id` | `absent-from-tree` |
	// `landing-unconfirmed` | `pre-write-id` — a kernel-returned id counts as
	// landed only when it is genuinely new (present post-write, absent
	// pre-write), never on the ack alone.
}
```

The `placement` argument (`AppendPlacement`) is honored only by the append
anchor: `"section-start"` or `"section-end"`, the default. A replace-section
or a move always takes the section-end rule.

### Edit a block — and prove it landed

```ts
import { editVerified } from "siyuan-kernel-primitives/write";

const outcome = await editVerified(client, probe, {
	blockId, body, rootId,
	baseline, // ServedBaseline — the target's served-baseline verdict
});
// { kind: "judged", verdict, postWalk } — the landing judged walk-vs-walk:
// the pre-write row is the fresh guard's walk row, the post-write row is
// looked up in `postWalk`'s by-id map — the blocks index is never on the
// edit path (it lags the tree behind its periodic flush; the tree is
// synchronous at the ack). The comparison watches the row's block-local
// stored representation — (content, type, subType, markdown) — so a
// heading-level-only or checkbox-only edit reads as landed. The verdict
// arms are `EditLandedOutcome`'s — its docstring is the arm reference;
// the landed arm's `stored` row is `JudgedEditRow`, the baseline-seeding
// fact — and `absent-target` is the walk-absence pre-mutation refusal: the
// completed walk does not emit the target, and updateBlock on such a row
// can ack a destructive body wipe.
// The other arms are `absent-target` (above), `fresh-refused`,
// `walk-truncated`, and the shared failure ladder (`drift`,
// `transport-unverified`, `kernel-refused`, `verification-failed`) — never
// "it probably worked".
```

### Move a block, a doc, or a heading's section — and prove it landed

```ts
import { moveVerified, moveDocVerified } from "siyuan-kernel-primitives/write";

const outcome = await moveVerified(client, probe, {
	blockId, rootId, destRootId,
	preDestWalk, // the caller-held destination walk — served and seeded from
	toHeadingId, // the destination section's heading; omit for the doc-end form
});
// { kind: "per-id" | "section", outcome } — plus the pre-mutation `drift`
// and `foreign` refusals.

const docOutcome = await moveDocVerified(client, probe, {
	docId, boxId, destRootId, // destRootId?: omit to move to the notebook root
});
// Judged on the live-tree hpath over the STORED title (ground truth, never
// a caller-predicted form — a rename or kernel normalization cannot read a
// landed move as not-landed): a child doc is not a block in its parent's
// tree, and blocks.hpath lags the move (live-pinned) — getHPathByID (the
// live tree) is the only synchronous ground truth.
```

- **Row-type dispatch.** A heading `blockId` — memberless or not — rides the
  batched section route; any other block rides the per-id core. The dispatch
  decides inside, so you never need to know whether a heading bears a section
  before calling. Both routes derive their anchors on the walks the entry
  holds (`deriveMoveAnchor` is that same projection, for a caller that wants
  the anchor itself).
- **Section route** — ONE `/api/transactions` batch of raw `move` ops: the
  section's members in document order onto the destination section's
  boundary, the heading leg last (doc-end destinations chain the members on
  `previousID` instead). Its outcome is the batched sequences' phase union
  (`refused` / `unverified` / `judged`). All-or-nothing at the transport:
  skip-class and legality rejections roll the whole batch back behind HTTP
  success, so the verdict reads `nothing-moved`, never ok (cross-doc
  recovery heals the SOURCE doc, then re-issues once).
- **Section verdict arms:** `landed` (the run's ids, the owner report, the
  destination's own judgment in `destination`, and both post-write walks),
  `landed-divergent` (the run landed but not as enumerated — a drag-at-front
  span, a concurrent-append swallow, or a cross-doc copy that left ids in
  the source; never word it as a clean move), `nothing-moved` (the batch did
  not apply), or `post-walk-truncated` (the walk's absence facts are
  unconfirmed).
- **Per-id route** — `judged` carries a `MoveBlockLandedOutcome` verdict
  (`landed`, `absent-from-destination`, `landing-unconfirmed`,
  `still-in-source`, `misplaced`) plus both post-move walks; a tree-level
  miss rolls back silently behind HTTP success.
- **Refused before any mutation:** `not-in-source`,
  `already-at-destination`, `own-subtree`, the section refusal pair, and a
  moved heading strictly shallower than the destination section's boundary
  (it would swallow the boundary and the sections after it).
- **No fresh-content guard:** a move destroys nothing; misplacement is
  judged, not pre-gated.

### Replace a heading's section — the sequence, whole

```ts
import { replaceSectionVerified } from "siyuan-kernel-primitives/write";

const outcome = await replaceSectionVerified(client, probe, {
	rootId, walk, headingId, body,
	baselineFor, // ServedBaseline per id — the section's closure, derived inside
});
// Phase-explicit union:
//   { kind: "refused", refusal }     — provably nothing applied
//   { kind: "unverified", outcome }  — a mutation ran or may have run;
//     outcome.stage is "insert" | "delete-leg", so wording never invites a
//     blind re-issue
//   { kind: "judged", verdict }      — a judgment rendered
```

- **The verdict's arms:** `replaced` (clean — carries `insertedId`, the
  heading's stored content, the certified closure, and the post-batch walk),
  `insert-unlanded` (leg 1 failed; the old section is untouched either way,
  so no baseline refresh), or `delete-leg` (the replacement landed, the
  delete leg did not end clean; its arms are the section-delete core's
  judged arms minus `judged`).
- **Enumeration and anchor derive internally** from the caller-held
  PRE-mutation walk — never accepted as inputs, so a post-insert
  re-enumeration cannot place the replacement into the delete set. An
  incomplete walk refuses `walk-truncated` up front.
- **The delete plan refuses before the insert**, so its refusal arms mean
  nothing landed.
- **Insert lands first** — the data-loss direction: a mid-sequence failure
  costs visible duplication, never loss. Then the members delete through ONE
  batched transaction.
- **Recovery doctrine:** survivors or an intact old section mean repair
  first, then by-id cleanup — never re-run replace-section. Transport/walk
  failures leave the whole judged set unconfirmed, and an absent replacement
  on a complete walk reads as data loss (cascade-consumed).

### Delete a block or a doc — with the evidence, not trust

```ts
import { deleteBlockVerified, deleteDocVerified } from "siyuan-kernel-primitives/write";

const outcome = await deleteBlockVerified(client, probe, {
	blockId, rootId,
	baselineFor, // ServedBaseline per id — target + cascade stake
});
// { kind: "judged", verdict, content, postWalk, judgedWalk } — the verdict
// is judged from the post-delete walk ("gone" | "still-present" |
// "absence-unconfirmed"), never trusted from the HTTP success (the pinned
// kernel rejects a missing id synchronously — the kernel-refused arm;
// walk-truncated and fresh-refused refuse pre-mutation). `judgedWalk` is the
// pre-mutation stake snapshot the guard certified.
// Doc delete: { kind: "mutated", preWalk } — the pre-delete walk is the
// receipt evidence; no pinned read proves a doc's deletion.
```

### Delete a heading's section — one transaction, verified

```ts
import { deleteSectionVerified } from "siyuan-kernel-primitives/write";

const outcome = await deleteSectionVerified(client, probe, {
	rootId: docId,
	walk: preWalk, // STRICT pre-mutation walk — must be docId's tree
	headingId,
	baselineFor, // ServedBaseline per id — heading + closure, derived inside
});
// Phase-explicit union:
//   { kind: "refused", refusal }     — provably nothing applied
//   { kind: "unverified", outcome }  — a batch ran or may have run
//   { kind: "judged", verdict }      — a judgment rendered, clean or adverse
//
// `refused` arms: drift, walk-truncated, heading-absent, foreign,
// fresh-refused. `judged`'s verdict is read over the single post-write walk
// (one `/api/transactions` batch of N+1 delete ops; the walk reads final
// state at the ack):
//   `judged`              every delete-set member absent; the receipt
//                         carries the plan's heading
//   `nothing-deleted`     the whole batch rolled back — cause-free; recovery
//                         is repair-first, then one whole-section re-issue
//   `members-survived`    the sub-cliff silent no-op — some issued ids still
//                         present behind HTTP success
//   `post-walk-truncated` the walk's absence facts are unconfirmed
//
// Retry safety keys on the discriminant, never on the verdict: `refused` is
// safe to re-derive from a fresh walk; `unverified` is not safe to re-issue.
// Ordering, scoping, and the fresh judgment are documented on the primitive
// and its union in the package sources.
```

### Check the kernel version before trusting any of this

```ts
import { probeKernel } from "siyuan-kernel-primitives";

const probe = await probeKernel(client);
// Judges against this package's pin; rethrows kernel errors — the catch
// policy is yours.
if (probe.verdict === "drift") { /* warn, refuse writes, … */ }
```

## Version coupling and upgrades

The pin is not decoration: this release is written against SiYuan **3.8.8**,
and the functions here encode that kernel's behaviors (the ones listed above,
plus the transaction response shape and the walk/SQL content equivalence). If
you run a different kernel version, `probeKernel` tells you, and writes
refuse on a drifted verdict rather than mis-verify.

Re-pinning is a checklist, not a version bump: run this repo's live
integration suite (`SIYUAN_INTEGRATION=1 SIYUAN_BASE_URL=… SIYUAN_API_TOKEN=…`)
against your actual kernel **before** changing `PINNED_SIYUAN_VERSION` —
it falsifies the walk shape, title storage, by-ID reads, verify loops, and
the auth-lock schedule live. The same run confirms the no-op premises the
verdicts lean on: failed and missing deletes still answer synchronously
(never a silent no-op behind HTTP success).

## Client

Bring your own client — anything structurally satisfying `KernelReadClient`
(reads) or `WriteKernelClient` (writes) works, which makes stubbing trivial.
The capability subsets (`SqlClient`, `ChildBlocksClient`, `SearchClient`,
`HPathClient`, plus `TransactClient` and `DeleteBlockClient` for the batched
and delete paths) are exported separately, so a stub can declare exactly the
reads its flow consumes. For the real thing, use `SiYuanKernelClient` from
[`siyuan-kernel-api`](https://github.com/coreyryanhanson/siyuan-kernel-api),
re-exported from the read barrel so error-class identity checks
(`instanceof SiYuanApiError`) hold with a single copy in your tree.

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm run fmt:check && npm test   # unit
node scripts/check-pack.mjs                     # package contents
# live (mutates a real kernel — point at one you can afford to touch):
SIYUAN_INTEGRATION=1 SIYUAN_BASE_URL=… SIYUAN_API_TOKEN=… npx vitest run
# the auth-lock/throttle case additionally needs SIYUAN_INTEGRATION_THROTTLE=1
# (it arms the kernel's per-IP lock for ~8 minutes; sequenced last)
```

Flat layout, raw `.ts` published, no build step. CI runs `lint` →
`fmt:check`, then `typecheck` → `test` → `check-pack` (the tarball is
derived from `git ls-files '*.ts'`, so a new root module must also join
`package.json`'s `files`). Release history:
[CHANGELOG.md](./CHANGELOG.md). AGPL-3.0-or-later.
