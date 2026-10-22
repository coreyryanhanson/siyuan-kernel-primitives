// Title-guard primitive tests — the re-homed pure pattern cases (LIKE
// escaping, verbatim stored-form patterns, near-match variants,
// separator-only fallback), the statement shapes consumer harnesses'
// SQL-routed stubs key on (the exact leg ends LIMIT GUARD_EXACT_CAP + 1,
// the near scan always ends LIMIT GUARD_NEAR_CAP + 1 — distinct endings
// are the routing discriminator), and the findTitleMatches fold:
// clear/duplicate/near classification, exact-precedes-near precedence,
// the at-cap `truncated` flag, foreign-box scoping.

import { describe, expect, it } from "vitest";
import { STMT_HEADS } from "../stmtKind.js";
import {
	GUARD_EXACT_CAP,
	GUARD_NEAR_CAP,
	findTitleMatches,
	guardExactStmt,
	guardNearPatterns,
	guardNearStmt,
	type GuardRow,
} from "../titleGuard.js";
import { queryClient } from "./readStub.js";

const BOX = "nb-r";

/** SQL-routed stub: exact-leg rows / near-leg rows discriminated the same
 * way the production harness discriminates — by the terminating LIMIT,
 * whose two cap values are distinct, so a title's own text can never
 * imitate either ending. */
function stubClient(opts: {
	exact?: Record<string, unknown>[];
	near?: Record<string, unknown>[];
	queries?: string[];
}) {
	return queryClient({
		query: (stmt: string) => {
			opts.queries?.push(stmt);
			return stmt.endsWith(`LIMIT ${GUARD_NEAR_CAP + 1}`)
				? (opts.near ?? [])
				: (opts.exact ?? []);
		},
	});
}

function row(id: string, content: string): Record<string, unknown> {
	return { id, root_id: id, content, updated: "20260101120000" };
}

describe("guard patterns", () => {
	it("escapes % and _ in the near-match patterns", () => {
		// The `_` is also a separator, so the title splits into two words and
		// each variant leg escapes the remaining literal `%`.
		expect(guardNearPatterns("100%_devops")).toEqual([
			"100\\% devops%",
			"100\\%-devops%",
			"100\\%\\_devops%",
		]);
	});

	it("leaves double quotes verbatim — the kernel stores content unescaped", () => {
		expect(guardNearPatterns('a"b')).toEqual(['a"b%']);
	});

	it("leaves the apostrophe verbatim — the kernel does not escape it", () => {
		expect(guardNearPatterns("it's")).toEqual(["it's%"]);
	});

	it("near-match legs include the underscore variant (kebab-vs-snake)", () => {
		expect(guardNearPatterns("docker networking")).toEqual([
			"docker networking%",
			"docker-networking%",
			"docker\\_networking%",
		]);
	});

	it("near-match fragments are built from the verbatim title", () => {
		// One-word titles dedupe to a single leg.
		expect(guardNearPatterns("R&D")).toEqual(["R&D%"]);
	});

	it("separator-only titles still yield a well-formed near leg (no empty parens)", () => {
		for (const title of ["-", "_", "---", "- _ -"]) {
			expect(guardNearPatterns(title).length).toBeGreaterThan(0);
			expect(guardNearStmt(BOX, title)).not.toContain("AND ()");
		}
	});
});

describe("guard statement shapes", () => {
	it("the exact leg is a verbatim box-scoped equality ending at its cap", () => {
		const stmt = guardExactStmt(BOX, "Docker Networking");
		expect(stmt.startsWith(STMT_HEADS.guard)).toBe(true);
		expect(stmt).toContain(`box = '${BOX}'`);
		expect(stmt).toContain("type = 'd'");
		expect(stmt).toContain("content = 'Docker Networking'");
		expect(stmt).not.toContain("LIKE");
		expect(stmt).not.toContain("ESCAPE");
		// Explicit LIMIT opts out of the kernel's silent statement cap; the
		// value is distinct from the near leg's so stub routing stays sound.
		expect(stmt.endsWith(`LIMIT ${GUARD_EXACT_CAP + 1}`)).toBe(true);
	});

	it("exact-leg wildcards are literals — % and _ match only themselves", () => {
		const stmt = guardExactStmt(BOX, "100%_devops");
		expect(stmt).toContain("content = '100%_devops'");
		expect(stmt).not.toContain("ESCAPE");
	});

	it("a case-variant title is not an exact duplicate — the near leg owns it", () => {
		// SQLite `=` is BINARY (case-sensitive); only the near leg's LIKE
		// patterns fold ASCII case, so `docker networking` against a stored
		// `Docker Networking` misses the exact leg and classifies `near`.
		expect(guardExactStmt(BOX, "docker networking")).toContain(
			"content = 'docker networking'",
		);
		expect(guardNearPatterns("docker networking")).toContain(
			"docker networking%",
		);
	});

	it("the near scan always ends LIMIT (cap + 1)", () => {
		const stmt = guardNearStmt(BOX, "docker networking");
		expect(stmt.startsWith(STMT_HEADS.guard)).toBe(true);
		expect(stmt).toContain(`box = '${BOX}'`);
		expect(stmt).toContain("OR content LIKE");
		expect(stmt.endsWith(`LIMIT ${GUARD_NEAR_CAP + 1}`)).toBe(true);
	});
});

describe("findTitleMatches", () => {
	it("classifies clear when both legs come back empty", async () => {
		const queries: string[] = [];
		const r = await findTitleMatches(
			stubClient({ queries }),
			BOX,
			"Docker Networking",
		);
		expect(r).toEqual({ kind: "clear", rows: [], truncated: false });
		expect(queries).toHaveLength(2);
	});

	it("classifies the empty title clear without any kernel call", async () => {
		// A zero-word near leg would degenerate to a bare `%` pattern and
		// match every doc in the box — not a fact about the title.
		const queries: string[] = [];
		const r = await findTitleMatches(stubClient({ queries }), BOX, "");
		expect(r).toEqual({ kind: "clear", rows: [], truncated: false });
		expect(queries).toHaveLength(0);
	});

	it("classifies duplicate on exact rows and never runs the near scan", async () => {
		const queries: string[] = [];
		const r = await findTitleMatches(
			stubClient({ exact: [row("d1", "docker networking")], queries }),
			BOX,
			"Docker Networking",
		);
		expect(r.kind).toBe("duplicate");
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0]?.root_id).toBe("d1");
		// Precedence: the near scan never fires behind a non-empty exact leg.
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain(`LIMIT ${GUARD_EXACT_CAP + 1}`);
	});

	it("classifies near only on an empty exact leg", async () => {
		const queries: string[] = [];
		const r = await findTitleMatches(
			stubClient({ near: [row("d2", "docker networking guide")], queries }),
			BOX,
			"Docker Networking",
		);
		expect(r.kind).toBe("near");
		expect(queries).toHaveLength(2);
		// Second query is the near scan.
		expect(queries[1]).toContain("LIMIT");
	});

	it("stub routing survives a title that embeds the near-cap LIMIT text", async () => {
		// The exact leg embeds the title verbatim, so a title carrying
		// "LIMIT 21" text must still route to the exact leg — the two legs'
		// terminating LIMIT values differ, and the exact statement ends
		// `LIMIT 65` regardless of title text.
		const r = await findTitleMatches(
			stubClient({ exact: [row("d1", "Chapter LIMIT 21")] }),
			BOX,
			"Chapter LIMIT 21",
		);
		expect(r.kind).toBe("duplicate");
		expect(r.rows[0]?.content).toBe("Chapter LIMIT 21");
	});

	it("flags truncation at the exact-leg cap without changing the verdict", async () => {
		const atCap = Array.from({ length: GUARD_EXACT_CAP }, (_, i) =>
			row(`d${i}`, "Docker Networking"),
		);
		const overCap = [...atCap, row("d-x", "Docker Networking")];
		const below = await findTitleMatches(
			stubClient({ exact: atCap }),
			BOX,
			"Docker Networking",
		);
		const over = await findTitleMatches(
			stubClient({ exact: overCap }),
			BOX,
			"Docker Networking",
		);
		expect(below).toMatchObject({ kind: "duplicate", truncated: false });
		expect(below.rows).toHaveLength(GUARD_EXACT_CAP);
		expect(over).toMatchObject({ kind: "duplicate", truncated: true });
		expect(over.rows).toHaveLength(GUARD_EXACT_CAP + 1);
	});

	it("flags truncation at the near-leg cap too", async () => {
		const r = await findTitleMatches(
			stubClient({
				near: Array.from({ length: GUARD_NEAR_CAP + 1 }, (_, i) =>
					row(`d${i}`, `docker networking ${i}`),
				),
			}),
			BOX,
			"Docker Networking",
		);
		expect(r).toMatchObject({ kind: "near", truncated: true });
		expect(r.rows).toHaveLength(GUARD_NEAR_CAP + 1);
	});

	it("a title matching both legs classifies duplicate — exact precedes near", async () => {
		const both: Record<string, unknown>[] = [
			row("d1", "Docker Networking"),
			row("d2", "Docker Networking Guide"),
		];
		const r = await findTitleMatches(
			stubClient({ exact: both }),
			BOX,
			"Docker Networking",
		);
		expect(r.kind).toBe("duplicate");
	});

	it("the guard SQL is box-scoped — a foreign-box title never surfaces", async () => {
		const queries: string[] = [];
		await findTitleMatches(stubClient({ queries }), BOX, "R&D");
		for (const stmt of queries) {
			expect(stmt).toContain(`WHERE box = '${BOX}'`);
		}
	});

	it("shapes guard rows through the private fold (GuardRow contract)", async () => {
		const rows = await findTitleMatches(
			stubClient({
				exact: [
					{
						id: 1,
						root_id: 2,
						content: 3,
						updated: undefined,
					},
				],
			}),
			BOX,
			"t",
		);
		expect(rows.rows).toEqual([
			{ id: "1", root_id: "2", content: "3", updated: "" } satisfies GuardRow,
		]);
	});
});
