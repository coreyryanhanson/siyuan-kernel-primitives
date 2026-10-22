# AGENTS.md

Deterministic primitives over SiYuan's kernel HTTP API. Single flat npm
package; **no build step** — raw `.ts` is published and the entry points
point straight at `.ts` files. Typechecking is `tsc --noEmit` only. Do not
add an emit/build pipeline. Node ≥ 20; the one runtime dep is
`siyuan-kernel-api`, pinned exact (`0.6.0`).

## Commands

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint --deny-warnings
npm run fmt         # oxfmt (fmt:check to verify)
npm test            # vitest; live suites skip unless SIYUAN_INTEGRATION=1
node scripts/check-pack.mjs   # tarball == tracked production sources
```

- CI order: `lint` → `fmt:check`, then `typecheck` → `test` → `check-pack`.
- Pre-commit runs lint-staged: `oxfmt` then `oxlint --fix --deny-warnings`.
- Linting/formatting are **oxlint/oxfmt**, not eslint/prettier. Tabs, print
  width 80 (`.oxfmtrc.json`).
- `tsconfig` is strict plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; optional props are typed `?: T | undefined`
  and spread conditionally. `.js` import specifiers resolve to the `.ts`
  files (nodenext) — that is why sources import `"./walk.js"`.
- When `package.json` carries a `file:` link to `siyuan-kernel-api` (the
  co-development link), the LSP's snapshot of that sibling's modules goes
  stale; `tsc --noEmit` re-reads disk and is the authority — mark a
  contradicting LSP finding false-positive instead of re-deriving it.
- `check-pack.mjs` derives the expected tarball from `git ls-files '*.ts'`
  (minus `*.test.ts`, nested test helpers, `vitest.config.ts`), so adding a
  root module means adding it to `package.json` `files` or CI fails.

## Public API = the exports map

Deep imports deliberately fail; `index.test.ts` asserts it. Anything absent
from `package.json` `exports` is unreachable — which is why the barrels are
also completeness-guarded there: every root-module export (value and type)
is derived from source and must ride a barrel or sit on that test's explicit
internal allow-list, so a public function whose result type is not nameable
fails CI instead of waiting for review. The allow-list is two-sided: an
internal name that later rides a barrel, or a stale entry, fails too.
The public/internal line over that list: SQL **text** is public because no
verdict carries it (a consumer's own independent probe must not re-derive
it); a **judgment** is internal because the verdict already rendered it and
carries its evidence.

- `siyuan-kernel-primitives` (`index.ts`) — **read barrel, report-only**: the
  block-tree walk (`walkBlockTree` in `walk.ts`), the body read
  (`body.ts`: `docBody` the standalone one-call stitch, `readDoc` the
  unified walk+body read — one joiner and one omitted-empty policy, the
  per-child `{ id, type, markdown? }` rows alongside the body), the heading judgments and
  the heading-target judgment (`heading.ts`: `isHeadingBlock`,
  `headingLevel`, `headingRows`, `resolveHeadingTarget`), the kernel's
  container vocabulary (`containers.ts`: `TARGETABLE_CONTAINER_TYPES`),
  by-ID reads (`byId.ts`), the refs-graph read (`refs.ts`: `backlinkCheck`),
  the title guard incl. its assembled statement builders and the legs'
  scan caps (`titleGuard.ts`: `GUARD_EXACT_CAP`, `GUARD_NEAR_CAP`),
  the content hash (`contentHash`, `fresh.ts` — the fresh-content judgment
  itself is internal to the write primitives), the extended-outline renderer
  (`outline.ts`), the search fan-out (`keywordSearchBoxes`, `search.ts`), notebook
  resolution (`resolveNotebooks`, `notebooks.ts`), SQL string escaping
  (`sqlString`, `sql.ts`), the placement projections (`placement.ts`:
  `sectionOf`, the append/replace anchors `appendAnchorOf` /
  `deriveAppendAnchor`, `deriveMoveAnchor`) and the post-delete receipt
  projection (`receipt.ts`: `orphanedMembersOf`), the version pin + probe
  (`version.ts`), the auth-lock schedule and the consumer-side dodge over it
  (`authLock.ts`: `authLockSeconds`, `authLockDodge`, the trip threshold
  `AUTH_DODGE_THRESHOLD` beside its judgment `authDodgeTripped`), and the re-exported
  layer-1 identity surface. Exports **no write primitive** (the re-exported
  layer-1 client is write-capable by design — that is the identity surface).
- `siyuan-kernel-primitives/write` (`write.ts`) — **the only path to the write
  verdicts and their kernels of mutation**: `createDocVerified` (the
  guarded-create core; refuses an unmintable title before any kernel call
  and mints the trimmed form), `editVerified`, `insertVerified`,
  `replaceSectionVerified`, `moveDocVerified`, the two-route `moveVerified`
  dispatch entry (row-type over the two routes; heading `blockId` → the
  batched section route, memberless or not), `deleteBlockVerified` /
  `deleteDocVerified`, `deleteSectionVerified` (heading plus every
  member, ONE kernel transaction, judged from the single post-write
  walk), plus the shared `MutationFailure` / `VerificationCause` types,
  `KernelRefusal` / `JudgedTransportFailure` (the post-mutation failure
  arms the batched sequences surface), `BatchedRefusal` /
  `BatchedUnverified` (the batched sequences' shared phase unions,
  declared once on `batch.ts`),
  `ScopingRefusal` (and its `foreign` arm's own name, `ForeignRefusal`),
  and the fresh guard's surface types (`ServedBaseline`, `FreshOutcome`,
  `StaleFreshArm`, `FreshRefusal`, `BaselineLookup`).
  Importing it is the deliberate, greppable act.
- `siyuan-kernel-primitives/testing` (`testing.ts`) — the SQL routing
  classifier (`statementKind`, `stmtKind.ts`), deliberately off the
  read/write barrels. A SQL-routed test stub routes on `statementKind`
  instead of matching statement text.

Invariants over the surface:

- **Verdicts carry their evidence.** A write primitive returns every
  post-write fact its consumer depends on (walks, ids, hpaths) as verdict
  detail, so consumers never re-fetch state the verdict already observed —
  new write primitives follow this rule rather than returning bare ids.
- **Truncation is evidence, never silence.** `walkBlockTree` returns a
  `WalkedTree` (`{ blocks, rootId, truncated, incomplete }` — the root id
  the walk was taken over, the caller-provenance fact): past `MAX_WALK_DEPTH`
  the walk stops and NAMES it — a truncated walk's presences are sound (a
  seen block is genuinely there; every seen block's sibling run and parent
  chain are complete), but its absences are not. `incomplete` is set for the
  depth bound AND for a tolerated vanish (the kernel's code:-1 envelope on a
  read-path walk). Every judgment follows the split: positive arms
  (`landed`, "still present") survive truncation; negative arms
  (`absent-from-tree`, gone, `vanished`) become explicit unconfirmed arms
  (`landing-unconfirmed`, `absence-unconfirmed`, `post-walk-truncated`). The
  payload-free `walk-truncated` discriminant means exclusively the
  pre-mutation refusal (nothing applied), so an unconfirmed post-write
  outcome can never be reworded as a safe-to-retry refusal. The write-feeding
  projections enforce it structurally: they take the whole `WalkedTree` and
  refuse `walk-truncated` before any kernel call. The bare-list helpers
  (`inSubtree` in `walk.ts`; `landingId`, `idSet`, `byIdMap`,
  `siblingRunOf`) are the
  deliberate exception — each caller derives from a whole `WalkedTree`
  immediately after a truncation gate, runs over an anchor's sibling
  run, which truncation cannot shorten, or judges presence/identity over
  a possibly incomplete walk — sound because every seen row's sibling run
  is complete. `partitionByAbsence` (same module, read
  barrel) is the walk's presence/absence split — presence sound on any
  walk, absence only on a complete one — the one home of the split. Its
  union is tagged (`complete` / `unconfirmed`, the exported
  `PartitionByAbsence` type), so reading `absentIds`
  off an incomplete walk's split is a compile error:
  `orphanedMembersOf` composes it over the post-delete
  walk, and the downstream write flows (gnubrain) partition their acked set
  through it. The in-repo write verdicts deliberately do NOT route through
  it — each re-encodes the split under a phase-explicit name
  (`absence-unconfirmed`, `landing-unconfirmed`, `walk-truncated`), a
  documented decision.
- Consumers must import the `siyuan-kernel-api` identity surface (client,
  error classes, types) **from this package's read barrel**, never the
  dependency directly — this package is the sole requirer of layer 1, and
  that is what keeps `instanceof` error checks on a single copy. This repo's
  own tests import `siyuan-kernel-api` directly, which is fine: the rule
  binds consumers, not the requirer.
- The assembled statement builders (`guardExactStmt`, `guardNearStmt`,
  `ownershipStmt`) are deliberate public surface — the text a consumer's own
  independent probe or live suite runs against the kernel, so it never
  re-derives the SQL.
- Tests resolve `siyuan-kernel-primitives` by package self-reference through the
  exports map — there is no `node_modules/siyuan-kernel-primitives` symlink.

## Kernel-version coupling

- `PINNED_SIYUAN_VERSION` in `version.ts` is **3.8.8**; the primitives encode
  that kernel's behaviors and are falsified by this repo's suites.
- The public write entries take a required `KernelProbeResult` and refuse on
  `drift` *before* any kernel call — exceptionless. `probeKernel` **rethrows**
  kernel errors — each caller owns its failure policy. The destroy-shaped
  mutations
  (`editVerified`, `deleteBlockVerified`, `replaceSectionVerified`,
  `deleteSectionVerified`) add a second required input of the same class —
  the served-baseline verdicts their internal fresh-content guard judges
  against — so omitting either precondition is a compile error, and both
  refuse iff served content provably diverged, deterministic, no caller
  policy. The guard's mechanics, arm shapes, and `BaselineLookup` live on
  `fresh.ts` and its docstring; the judged set never crosses the input
  surface, and `contentHash` stays on the read barrel. The internal cores
  carry no probe and no drift arm of their own — the section-delete core,
  and the section-move sequence (its gate sits once at `moveVerified`'s
  dispatch entry, before any route) — the drift gate stays with each
  sequence at its own first-mutation position.
- The batched route (`POST /api/transactions`, consumed through
  `batch.ts`, `sectionDeleteCore.ts`/`deleteSection.ts`/`replace.ts`,
  and `moveSection.ts`) rides 3.8.8 kernel facts — ack-time commit-wait,
  whole-group rollback behind HTTP success (cause-free over HTTP), the
  sub-cliff silent no-op, the ≥32-op single-tree bulk path (whole-batch
  void behind the success ack, no partial apply), rollback index residue
  (repair-first recovery, never a by-id delete), and queue ordering.
  Their full statements live on the module docstrings — `batch.ts` for
  the transport facts, `sectionDeleteCore.ts` for the delete judgment
  arms, `moveSectionPlan.ts` for the move codec's — keep them there when
  editing; live-pinned by `siyuan-kernel-api`'s
  `transactions.probe.si.test.ts`, exercised transitively by this repo's
  `delete.live`, `replace.live`, `move.live`, and `moveSection.live`; arm shapes pinned by
  `sectionDeleteCore.test.ts`, `deleteSection.test.ts`,
  `replace.test.ts`, and `moveSection.test.ts`.
- Re-pinning is a checklist, not a version bump: run the live suite against
  the new kernel first (see README).
- Index reads that must survive the blocks index's async convergence poll the
  convergence window (`convergence.ts`): `VERIFY_RETRY_DELAYS_MS` is the
  fixed table, `verifyWithinWindow` the poll loop — the blocks index settles
  asynchronously (content/refs/hpath, hpath last). Extend the table if a live
  run races it; don't add sleep/backoff knobs. Tests collapse the window
  through the `withVerifyWindow` seam — import `convergence.ts` directly,
  it rides no barrel — never by mutating the table in place (the exported
  table is frozen — in-process mutation is the seam's job alone). The
  window's consumers are create and the doc-move.
- The verified edit judges its landing walk-vs-walk (`edit.ts`,
  `judgeEditLanded`), never against the blocks index — the index is
  0–3s stale behind its periodic flush while `getChildBlocks` reads the
  document tree synchronously after the ack (live-pinned in
  `writePins.live`). The comparison watches `(content, type, subType,
  markdown)` — `parentId` is the concurrent-move signal, never a
  watched field, and the absence legs ride the walk: a re-parented row
  is a concurrent intra-doc move, absent from a complete walk is a
  concurrent delete or cross-doc move, absent from an incomplete walk
  is `absence-unconfirmed`. Coverage is route-scoped: a submitted
  `{: …}` suffix stores as literal block text, so `setBlockAttrs`
  attribute state is invisible to the comparison and unreachable from
  the edit flow's markdown-only route (live-pinned), and the stored
  checkbox form is uppercase (`- [X]`) — no comparison may byte-match a
  submitted markdown body against the stored form. The `absent-target`
  refusal fires pre-mutation when the target is absent from the
  completed fresh walk: the walk emits every blocks row except the
  `d` root and doc/block ids are format-indistinguishable through the
  flush window, so `updateBlock` on a walk-invisible row acks a
  destructive body wipe where `deleteBlock` refuses synchronously
  through the tree (live-pinned beside its negative) — the guard is
  edit-only, and the delete flow's `kernel-refused` arm carries the
  `d`-row case.
- The body read's rendering posture (`body.ts`, falsified in
  `__tests__/live/body.live.test.ts` + `body.test.ts`): the walk field's
  `markdown` renders each top-level child's whole subtree fresh from the
  live tree; a child whose `markdown` is absent is a genuinely empty
  export — kept in the rows, omitted from the joined body. One rendering
  divergence is absorbed: an empty leaf INSIDE a container rides the
  container's markdown, so a write-back drops the leaf and the body
  changes once, then stabilizes. The default-posture assert is
  config-aware (reads the live `Conf.Editor.Markdown` flags and asserts
  each construct parses as markup iff its flag is on) — re-check on
  every kernel upgrade alongside the pin checklist.

## Testing

- Unit: `__tests__/*.test.ts` plus root `index.test.ts`. Live:
  `__tests__/live/**` (never in CI). Shared unit helpers (`readStub.ts`,
  `writeStub.ts`, `sectionStub.ts`, `moveSectionStub.ts`,
  `surfaceScanner.ts`) live beside the
  tests and are imported relatively.
- `npm test` runs both vitest projects (unit default-parallel; integration
  `fileParallelism: false`); live cases are env-gated and skip by default, so
  no kernel is needed. Focused runs: `npx vitest run __tests__/walk.test.ts`,
  add `-t "name"`, or filter projects with `--project unit|integration`. The
  reporter is `verbose` by default (runs tee to logs, so per-case lines stay
  greppable).
- Live runs need a real kernel and **mutate it**:
  `SIYUAN_INTEGRATION=1 SIYUAN_BASE_URL=… SIYUAN_API_TOKEN=… npx vitest run`.
  `SIYUAN_BASE_URL` is required (no baked default); setup asserts the kernel
  version **exactly equals** the pin and teardown asserts zero stray
  notebooks. Every live file also skips when the token is empty.
- Live files run serially in a fixed order (`INTEGRATION_ORDER` in
  `vitest.config.ts`); the order is exported for a unit guard
  (`__tests__/liveOrder.test.ts`) that fails when a live file is missing from
  the list. **The throttle file must stay last** — it arms the kernel's
  per-IP lock (~8 min), and an unlisted file sorts after it and would ride
  the armed lock. Add any new live file to that list.
- `SIYUAN_INTEGRATION_THROTTLE=1` additionally enables the throttle case;
  don't run it twice in quick succession (it 429-locks every client on that
  IP).

## Architecture

The module map. Every module's docstring is the canonical statement of its
arm shapes and kernel-coupled facts (the live suite rehearses them in place
on upgrade passes) — read the module for depth. Stated here: one line per
module, plus the cross-module invariants no single module owns.

- `client.ts` — the kernel capability subsets (`SqlClient`,
  `ChildBlocksClient`, `SearchClient`, `TransactClient`, `HPathClient`,
  `DeleteBlockClient`) composed into `KernelReadClient`; no endpoint is
  re-wrapped, and each flow module declares only the subset it consumes.
- `walk.ts` — the document-order `getChildBlocks` walk and its recursion
  policy; never SQL enumeration. Its product `WalkedTree` carries the
  truncation split (the invariant above).
- `containers.ts` — the one declaration of the kernel's container
  vocabulary (`TARGETABLE_CONTAINER_TYPES`, exported frozen, membership
  module-private); the walk's recursion gate derives from it.
- `heading.ts` — the heading judgments over a walk plus
  `resolveHeadingTarget`, the pure pre-mutation heading-target judgment
  (no kernel client).
- `search.ts` — the per-box search fan-out (`keywordSearchBoxes`);
  report-only, never a refusal.
- `outline.ts` — the canonical extended-outline notation over a walk;
  pure projection, serving policy stays with the consumer.
- `fresh.ts` — the fresh-content judgment (`judgeFreshOverWalk`,
  `contentHash`); internal to the write primitives — `ServedBaseline` /
  `FreshOutcome` / `StaleFreshArm` / `FreshRefusal` / `BaselineLookup`
  ride `./write`.
- `byId.ts` / `titleGuard.ts` — report-only reads, never refuse;
  `scopingRefusalOf` and the walk-provenance gate `foreignRefusalOf` are
  the pure refusal projections the
  flow unions compose, each homed beside its arm. Two facts worth carrying: `hPathByID` reads the
  live tree synchronously (the doc-move judgment's ground truth; the
  blocks index lags), and `sqlString` is the only way ids/titles enter SQL.
- `refs.ts` — the refs-graph read (`backlinkCheck`); report-only and
  advisory — the refs index converges asynchronously behind a write.
- `stmtKind.ts` — the single home of the SQL statement heads; the public
  face is `statementKind` on the `./testing` entry, so a SQL-routed stub
  keys on statement identity, never statement text.
- `placement.ts` — the section rule and the append/move anchors derived
  from it, pure over the walk. Its flow seams (`sectionSubjectOf`,
  `cascadeDescendantsOf`) sit off the barrel on the
  internal allow-list; the caller-provenance gate `foreignRefusalOf`
  lives beside its `ForeignRefusal` arm in `byId.ts`.
- `receipt.ts` — the post-mutation receipt projections over the walk:
  the landed heading's owner (`sectionOwnerOf`, internal allow-list) and
  the members a heading still holds after a delete (`orphanedMembersOf`,
  read barrel). Per-projection incompleteness policy: the owner read
  refuses incomplete walks pre-mutation-style; the orphaned read runs
  post-ack and reports the unconfirmed family.
- `notebooks.ts` — the notebook-resolution judgment; pure over a held
  read, no kernel client.
- `failure.ts` — the shared pre-judgment failure taxonomy: the
  `MutationFailure` ladder, `refuseDrift`, the phase catch bodies
  (`catchMutation` / `catchVerification`), and `causeOf` + `KernelCause`
  (the read barrel's classification half of the layer-1 identity
  surface). The auth/429 policy is phase-split, both halves justified by
  kernel facts on its docstrings.
- `create.ts` — the guarded-create core: the mint-title judgment, the
  parent read-back, and the live-tree hpath asserts over the convergence
  window (the outcome union's arm shapes are the module docstring's).
- `insert.ts` — the verified insert: one `doOperations` entry per
  markdown insert, the whole body in its `data`, and the insert-landed
  predicate (a kernel-returned id counts as landed only when genuinely
  new — present post-write, absent pre-write) shared by every insert
  consumer.
- `edit.ts` — the verified edit: the walk-vs-walk landed judgment over
  the four watched fields and the edit-only `absent-target` guard (a
  complete walk emits every blocks row except the `d` root, so an absent
  target refuses pre-mutation).
- `move.ts` — the verified block/doc moves and the two-route
  `moveVerified` dispatch. The fold-blind rule it structurally enforces,
  stated here because no single module owns it: *a move target must not
  be a section-bearing heading unless the operation is explicitly
  section-scoped* — never the append/replace anchors, which legitimately
  address section-bearing headings. The two structural gates: the
  dispatch routes EVERY heading row (memberless or not) to the section
  sequence, and the per-id core's own incomplete-source-walk refusal is
  the second half.
- `moveSection.ts` / `moveSectionPlan.ts` — the verified section move:
  the pure plan (gates, group refusals, codec — the plan header is the
  canonical kernel-fact statement), the batched transport, and the landed
  judgment declared beside the outcome union it arms. No fresh-content
  guard: a move destroys nothing; misplacement is judged, not pre-gated.
- `sectionDeleteCore.ts` / `deleteSection.ts` / `replace.ts` — the
  batched section-delete core (plan/apply split; `includeHeading` is
  plan-phase only, selecting sets, never arms; no probe — each sequence
  gates drift at its own first-mutation position) and its two consumers:
  the verified section delete (tool-facing union + drift gate) and the
  replace-section sequence (plan phase before the insert, drift refused
  at entry and again inside the insert leg, idempotent). The three
  batched sequences' outcome unions are phase-explicit — `refused`
  (pre-mutation, provably nothing applied) / `unverified` (a mutation
  ran or may have run; outcome unknown or judgment missing —
  `KernelRefusal` is NOT proof of non-application on the batched route)
  / `judged` (a verdict rendered, clean or adverse) — so a new arm
  cannot be added without its phase, and the consumer's retry-safety
  posture keys on the discriminant, not a hand-maintained kind list.
- `batch.ts` — the batched-route foundation, judgment-free:
  `transactThenWalk`. The transport-phase facts and the ≥32 bulk path's
  single-tree constraint live on its docstring. Internal to the write
  path, on the internal allow-list.
- `delete.ts` — the verified block/doc deletes; the doc-delete receipt
  itemizes every lost block and carries no landing judgment.
- `write.ts` — the write barrel: every write verdict is a closed union
  carrying evidence, never prose (the consumer words the result),
  composed over the shared ladder declared once in `failure.ts`.
- **Auth-lock dodge:** any authed call into an active per-IP lock re-arms
  it — never retry into a lock; wait it out using the exported
  `authLockSeconds` schedule and the `authLockDodge` reducer beside it
  (the consumer's circuit breaker is that reducer plus session-lifetime
  state).
- Comments carry the kernel-coupled rationale (why a pin exists, why a
  shape is safe). Keep them when editing.

## Release

`npm run release:patch|minor|major` (or an explicit `x.y.z`) commits, tags,
publishes to npm, and pushes `main` + tag. It refuses a dirty tree and any
`file:` dependency spec (the co-development link must be swapped back to an
exact pin first), runs `npm test` (unit only — the live suite is not part of
a release), promotes `CHANGELOG.md` `[Unreleased]` and reinstates it in a
second commit. Draft `[Unreleased]` entries first, and run it deliberately.
