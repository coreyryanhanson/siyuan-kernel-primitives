// Refs-graph read tests — backlinkCheck's two-step shape over the refs
// schema, its distinct-doc count, and the named-ceiling truncation signal.

import { describe, expect, it } from "vitest";
import { backlinkCheck } from "../refs.js";
import { STMT_HEADS } from "../stmtKind.js";
import { queryClient } from "./readStub.js";

describe("backlinkCheck", () => {
	it("counts distinct referring docs and names them by hpath", async () => {
		const queries: string[] = [];
		const c = queryClient({
			query: (stmt) => {
				queries.push(stmt);
				// Route by head: leg 1 is the refs scan, leg 2 the hpath read.
				return stmt.startsWith(STMT_HEADS["refs-backlink"])
					? [
							{ root_id: "d-other" },
							{ root_id: "d-other" },
							{ root_id: "d-third" },
						]
					: [{ hpath: "/Other doc" }, { hpath: "/Third doc" }];
			},
		});
		const r = await backlinkCheck(c, ["b1"]);
		expect(r.count).toBe(2);
		expect(r.hpaths).toEqual(["/Other doc", "/Third doc"]);
		expect(r.truncated).toBe(false);
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain(STMT_HEADS["referring-hpaths"]);
		// Both legs end an explicit outer LIMIT — the kernel caps statements
		// without their own LIMIT at Conf.Search.Limit (default 64) silently.
		expect(queries[0]).toMatch(/LIMIT \d+$/);
		expect(queries[1]).toMatch(/LIMIT \d+$/);
	});

	it("no ref rows means no second query", async () => {
		const queries: string[] = [];
		const c = queryClient({
			query: (stmt) => {
				queries.push(stmt);
				return [];
			},
		});
		expect(await backlinkCheck(c, ["b1"])).toEqual({
			count: 0,
			hpaths: [],
			truncated: false,
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain(STMT_HEADS["refs-backlink"]);
	});

	it("an empty id set fires no query", async () => {
		const c = queryClient({
			query: () => {
				throw new Error("no query expected");
			},
		});
		expect(await backlinkCheck(c, [])).toEqual({
			count: 0,
			hpaths: [],
			truncated: false,
		});
	});

	it("names the ceiling when a leg returns exactly the cap — the truncation signal layer 1 cannot carry", async () => {
		// Layer 1 drops the kernel envelope's truncated marker, so a leg
		// hitting REFS_STMT_LIMIT rows is the only observable evidence that
		// count/hpaths may understate. Either leg at the cap fires the flag;
		// the 4096 literal is REFS_STMT_LIMIT — module-private, so the test
		// pins the number itself.
		const atCap = <T>(row: T): T[] => Array.from({ length: 4096 }, () => row);
		const refsLeg = queryClient({
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["refs-backlink"])
					? atCap({ root_id: "d-other" })
					: [{ hpath: "/Other doc" }],
		});
		const hpathsLeg = queryClient({
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["refs-backlink"])
					? [{ root_id: "d-other" }]
					: atCap({ hpath: "/Other doc" }),
		});
		expect((await backlinkCheck(refsLeg, ["b1"])).truncated).toBe(true);
		expect(await backlinkCheck(hpathsLeg, ["b1"])).toEqual({
			count: 1,
			hpaths: atCap("/Other doc"),
			truncated: true,
		});
	});
});
