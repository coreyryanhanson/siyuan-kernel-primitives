// The refs-graph read — "who cites these" over the kernel's refs schema
// (`refs.def_block_id` → referring blocks' doc roots → `blocks.hpath`).
// Distinct from the by-ID reads in `byId.ts`: a different table, a
// two-step shape, and its own convergence lag behind writes. Report-only:
// the refusal/wording policy is always the caller's.

import type { SqlClient } from "./client.js";
import { sqlString } from "./sql.js";
import { STMT_HEADS } from "./stmtKind.js";

/** Explicit outer LIMIT for the refs legs — unlike `blockContents` their
 * row counts are not bounded by the id set (any number of docs may cite
 * the targets), so this is a named, KB-scale ceiling rather than an exact
 * bound; without their own LIMIT the kernel caps these statements at
 * Conf.Search.Limit (default 64) silently. */
const REFS_STMT_LIMIT = 4096;

function refsBacklinkStmt(ids: string[]): string {
	return (
		`${STMT_HEADS["refs-backlink"]} (${ids.map(sqlString).join(", ")})` +
		` LIMIT ${REFS_STMT_LIMIT}`
	);
}

function referringHpathsStmt(rootIds: string[]): string {
	return (
		`${STMT_HEADS["referring-hpaths"]} ` +
		`(${rootIds.map(sqlString).join(", ")}) LIMIT ${REFS_STMT_LIMIT}`
	);
}

/** Inbound block-refs over a set of block ids — "who cites these". The
 * two-step shape is the refs schema's own: `refs.def_block_id` yields the
 * referring blocks' doc roots, whose `blocks.hpath` rows name them. The
 * count is distinct referring docs (a doc citing twice counts once). The
 * refs index is derived and converges asynchronously behind a write
 * (bounded wait), so a just-written ref can be missing here;
 * the result is advisory data — any refusal/wording policy is the
 * consumer's.
 *
 * `truncated` is the truncation-as-evidence fact for the legs' named
 * ceiling: layer 1 drops the kernel envelope's own truncation marker, so
 * a leg returning exactly REFS_STMT_LIMIT rows is the only observable
 * signal. True means count and/or hpaths may understate a KB-scale refs
 * graph; a smaller KB can never read truncated (the flag can only fire
 * at the cap, so a false positive needs exactly-cap rows). */
export async function backlinkCheck(
	client: SqlClient,
	ids: string[],
): Promise<{ count: number; hpaths: string[]; truncated: boolean }> {
	if (ids.length === 0) return { count: 0, hpaths: [], truncated: false };
	const rows = await client.query(refsBacklinkStmt(ids));
	const refsTruncated = rows.length >= REFS_STMT_LIMIT;
	const rootIds = [...new Set(rows.map((r) => String(r.root_id)))];
	if (rootIds.length === 0) return { count: 0, hpaths: [], truncated: false };
	const hpathRows = await client.query(referringHpathsStmt(rootIds));
	return {
		count: rootIds.length,
		hpaths: hpathRows.map((r) => String(r.hpath)),
		truncated: refsTruncated || hpathRows.length >= REFS_STMT_LIMIT,
	};
}
