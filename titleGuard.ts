// Title-guard primitives — the guard SQL that answers "does this title
// already exist in this KB". The exact leg is a verbatim `content =`
// equality against the kernel's stored form — `blocks.content` carries the
// title verbatim (on the pinned kernel: `A & B`,
// `say "hi"`, `a < b > c` all store unescaped; the HTML-escaped form lives
// only in the title IAL, `blocks.ial`, which the guard does not query).
// SQLite `=` uses BINARY collation, so a case-variant title (`foo` vs a
// stored `FOO`) is not an exact duplicate — it misses the exact leg and
// falls to the near-match leg, whose LIKE patterns fold ASCII case and
// classify it `near`. The near leg scans separator-variant prefixes,
// capped at GUARD_NEAR_CAP.
//
// This is a read primitive: it reports (kind + rows), never refuses. The
// caller decides whether a duplicate/near answer stops a create.

import type { SqlClient } from "./client.js";
import { sqlString } from "./sql.js";
import { STMT_HEADS } from "./stmtKind.js";

/** LIKE-wildcard escaping for the guard patterns (ESCAPE '\\'): a literal
 * `%`/`_` in a title must not widen the match. */
function likeEscape(fragment: string): string {
	return fragment
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

/** Near-match prefix variants: the title's separator runs canonicalized
 * to space / hyphen / underscore. The intentional `_` is LIKE-escaped like
 * any other wildcard (`docker\_networking%`). A separator-only title (no
 * words) has no variant to build, so it falls back to its own prefix —
 * never an empty leg list, which would emit malformed SQL (`AND ()`). */
export function guardNearPatterns(title: string): string[] {
	const words = title.split(/[ \-_]+/).filter((w) => w !== "");
	if (words.length === 0) {
		return [`${likeEscape(title)}%`];
	}
	// One-word titles produce three identical legs — dedupe.
	return [
		...new Set([" ", "-", "_"].map((sep) => `${likeEscape(words.join(sep))}%`)),
	];
}

/** Rows at a guard stop are few; the near-match scan is capped at 20. */
export const GUARD_NEAR_CAP = 20;

/** Exact-leg row cap. Set at the kernel's own silent-cap scale
 * (Conf.Search.Limit, default 64) so the guard takes over exactly the
 * truncation point a LIMIT-less statement would have hit silently —
 * without its own LIMIT the kernel caps at that number and reports the
 * truncation only at the envelope top level, which the client drops.
 * Deliberately distinct from the near leg's terminating LIMIT
 * (`GUARD_NEAR_CAP + 1`) so SQL-routed consumer stubs can still tell the
 * two legs apart by their endings. */
export const GUARD_EXACT_CAP = 64;

export interface GuardRow {
	id: string;
	root_id: string;
	content: string;
	updated: string;
}

function toGuardRows(rows: Record<string, unknown>[]): GuardRow[] {
	return rows.map((r) => ({
		id: String(r.id),
		root_id: String(r.root_id),
		content: String(r.content),
		updated: String(r.updated ?? ""),
	}));
}

/** Exact leg: verbatim equality — BINARY collation keeps it
 * case-sensitive, and `%`/`_`/`\` are literals here, so no LIKE-escaping
 * or ESCAPE clause. The explicit LIMIT opts out of the kernel's silent
 * statement cap (same fact as `blockContents`/the refs legs): same-titled
 * docs under different parents share a box, so the leg can legitimately
 * match many rows; +1 lets the caller distinguish "exactly 64" from
 * "64+" via the `truncated` flag. */
export function guardExactStmt(boxId: string, title: string): string {
	return (
		`${STMT_HEADS.guard} ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' ` +
		`AND content = ${sqlString(title)} ` +
		`LIMIT ${GUARD_EXACT_CAP + 1}`
	);
}

export function guardNearStmt(boxId: string, title: string): string {
	const legs = guardNearPatterns(title)
		.map((p) => `content LIKE ${sqlString(p)} ESCAPE ${sqlString("\\")}`)
		.join(" OR ");
	// LIMIT caps returned rows, not scan work (content has no index);
	// +1 so the caller can distinguish "exactly 20" from "20+".
	return (
		`${STMT_HEADS.guard} ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' AND (${legs}) ` +
		`LIMIT ${GUARD_NEAR_CAP + 1}`
	);
}

/** The guard's blocking outcome, named so a consumer can switch over it
 * (`duplicate` beats `near` — exact leg first; `rows` carries the stored
 * titles). `truncated` is the at-cap flag both legs share: layer 1 drops
 * the envelope's own truncation marker, so at-cap row count is the only
 * signal — the consumer renders it, never
 * re-derives it from row-count arithmetic. */
export type TitleMatchResult = {
	kind: "clear" | "duplicate" | "near";
	rows: GuardRow[];
	truncated: boolean;
};

/** Does this title already exist in this KB? A factual read of pinned
 * storage (doc titles verbatim, unescaped, in `blocks.content`), scoped to
 * one notebook — a matching title in any other box never surfaces.
 *
 * Two-leg sequencing is the semantic: the exact leg runs first (verbatim
 * `=`, ends `LIMIT GUARD_EXACT_CAP + 1`); the near scan runs only when
 * the exact leg is empty (always ends `LIMIT GUARD_NEAR_CAP + 1`). Exact
 * precedence is what makes a verbatim title classify `duplicate`, never
 * `near` — while a case variant of a stored title (`foo` vs `FOO`)
 * misses the exact leg and classifies `near` through the near leg's
 * ASCII-folding LIKE patterns. Truncation never changes the verdict — a
 * capped leg still classifies from its rows — it only marks the row set
 * as partial (`truncated`).
 *
 * The empty title classifies `clear` without any kernel call: its near
 * leg would degenerate to a bare `%` pattern and match every doc in the
 * box, which is not a fact about the title. */
export async function findTitleMatches(
	client: SqlClient,
	boxId: string,
	title: string,
): Promise<TitleMatchResult> {
	if (title === "") return { kind: "clear", rows: [], truncated: false };
	const exact = toGuardRows(await client.query(guardExactStmt(boxId, title)));
	if (exact.length > 0)
		return {
			kind: "duplicate",
			rows: exact,
			truncated: exact.length > GUARD_EXACT_CAP,
		};
	const near = toGuardRows(await client.query(guardNearStmt(boxId, title)));
	if (near.length > 0)
		return {
			kind: "near",
			rows: near,
			truncated: near.length > GUARD_NEAR_CAP,
		};
	return { kind: "clear", rows: [], truncated: false };
}
