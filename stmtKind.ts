// SQL statement heads — the single home of the SELECT prefixes the
// kernel stubs route on, one table (`STMT_HEADS`) so a head's text, its
// kind, and the pairing between them are registered exactly once. The
// builders (byId.ts, refs.ts, titleGuard.ts, create.ts) index the table; the
// `./testing` classifier (`statementKind`) derives from it, so the
// statement text stays private and a SQL rewording never re-routes a
// downstream harness. No head is a prefix of another, so a statement's
// kind is its unique prefix and the
// classification order below is irrelevant.

export const STMT_HEADS = {
	"block-in-doc": "SELECT id, content, root_id, type FROM blocks WHERE id",
	"block-contents": "SELECT id, content FROM blocks WHERE id IN",
	ownership: "SELECT root_id FROM blocks WHERE id",
	"root-echo": "SELECT root_id, content, hpath FROM blocks",
	"refs-backlink": "SELECT DISTINCT root_id FROM refs WHERE def_block_id IN",
	"referring-hpaths": "SELECT DISTINCT hpath FROM blocks WHERE root_id IN",
	guard: "SELECT id, root_id, content, updated FROM blocks",
	"parent-lookup": "SELECT id, hpath, content FROM blocks",
	"verified-root": "SELECT id, root_id, content, hpath, updated FROM blocks",
} as const;

/** What a SQL statement is — the identity a test harness routes on,
 * deliberately coarser than the statement text: a SQL rewording updates
 * the head here in the same diff and the classification is unchanged.
 * `other` keeps the union total — a statement the package does not build
 * (or a new head a harness has not learned) classifies instead of
 * mis-routing. Derived from the table, so a head and its kind can never
 * drift apart. */
export type StatementKind = keyof typeof STMT_HEADS | "other";

/** The kind of one SQL statement — the classifier the `./testing` entry
 * exposes so a consumer's SQL-routed test stub keys on identity, never on
 * statement text. Guard-leg discrimination (exact vs near) is NOT
 * absorbed here: the legs share one head by construction, and the
 * terminating near-cap LIMIT is the spoof-proof discriminator — that
 * judgment stays with the harness that owns the fixtures. */
export function statementKind(stmt: string): StatementKind {
	for (const [kind, head] of Object.entries(STMT_HEADS) as [
		keyof typeof STMT_HEADS,
		string,
	][])
		if (stmt.startsWith(head)) return kind;
	return "other";
}
