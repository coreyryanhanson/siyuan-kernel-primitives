# Changelog

## [0.1.0] - 2026-10-22

### Added

- **Initial release of `siyuan-kernel-primitives`** — deterministic judgments
  over the [SiYuan](https://github.com/siyuan-note/siyuan) kernel HTTP API,
  built on `siyuan-kernel-api` 0.6.0 and written against one pinned kernel
  version (SiYuan **3.8.8**). Raw `.ts` sources, ESM, no build step; Node ≥ 20.
  Arm-level shapes, kernel facts, and recovery postures live on the modules'
  docstrings — this entry only names the surface.

- **Read entry** (`siyuan-kernel-primitives`) — report-only primitives,
  no write path reachable: the document-order block-tree walk and its
  presence/absence split (`partitionByAbsence`), the heading judgments, the
  section rule with its anchors and the post-delete member projection, the
  extended outline renderer, the body read, the notebook-scoped title guard,
  by-ID reads, the refs-graph read, the per-box search fan-out, notebook
  resolution, SQL string escaping, the container vocabulary, the content
  hash, the version pin + probe, and the auth-lock schedule with its dodge
  reducer. The layer-1 identity surface is re-exported here, so every install
  holds exactly one copy of `siyuan-kernel-api`.

- **Write entry** (`siyuan-kernel-primitives/write`) — the only path to the
  write verdicts: `createDocVerified`, `editVerified`, `insertVerified`,
  `replaceSectionVerified`, the `moveVerified` dispatch (row-type over the
  per-id and batched section routes), `deleteBlockVerified` /
  `deleteDocVerified`, and `deleteSectionVerified`. Each mutation returns a
  closed union carrying the evidence it was judged from — post-write walks
  where a landing judgment exists, the content the judgment observed,
  live-tree hpaths — never a bare id, never prose. Every write flow refuses
  on drift before any kernel call, and the destroy-shaped mutations take the
  session's served-baseline verdicts as a required input and judge content
  freshness internally, immediately before mutating.

- **Batched route** (`POST /api/transactions`) under the section deletes and
  the section move — one transaction, all-or-nothing at the transport (behind
  HTTP success); the post-write walk can still return a non-clean outcome
  (`members-survived`, `nothing-deleted`, `post-walk-truncated`) as evidence,
  never silence.

- **Test seam** (`siyuan-kernel-primitives/testing`) — `statementKind`, so a
  SQL-routed stub routes on statement identity instead of statement text.
  Deliberately off the read and write entries: production code has no reason
  to import it.
