// By-ID read primitive tests — blockInDoc's four outcomes (in-doc /
// absent / doc-id / foreign-root), blockContents' batch mapping,
// firstChildContent's excerpt read, and rootEcho's row / absent
// branches, over the pinned row semantics (type-'d' doc rows, root_id
// as the doc-membership check). The refs-graph read's suite is
// refs.test.ts.

import { describe, expect, it } from "vitest";
import {
	blockContents,
	blockInDoc,
	firstChildContent,
	ownership,
	ownershipStmt,
	rootEcho,
	scopingRefusalOf,
} from "../byId.js";
import { STMT_HEADS } from "../stmtKind.js";
import { SiYuanApiError } from "siyuan-kernel-api";
import type { KernelReadClient } from "../client.js";
import { queryClient } from "./readStub.js";

const ROOT = "d-doc";

function client(rows: Record<string, unknown>[]): KernelReadClient {
	return queryClient({ query: () => rows });
}

describe("blockInDoc", () => {
	it("reports the in-doc payload for a row of the requested doc", async () => {
		const r = await blockInDoc(
			client([{ id: "b1", content: "hello", root_id: ROOT, type: "p" }]),
			ROOT,
			"b1",
		);
		expect(r).toEqual({ kind: "in-doc", content: "hello", type: "p" });
	});

	it("reports absent when the id matches no row", async () => {
		expect(await blockInDoc(client([]), ROOT, "b1")).toEqual({
			kind: "absent",
		});
	});

	it("reports doc-id for a document row — doc ids never target block ops", async () => {
		const r = await blockInDoc(
			client([
				{ id: "d-doc", content: "the title", root_id: "d-doc", type: "d" },
			]),
			ROOT,
			"d-doc",
		);
		expect(r).toEqual({ kind: "doc-id" });
	});

	it("reports foreign with the actual root for another doc's block", async () => {
		const r = await blockInDoc(
			client([{ id: "b2", content: "x", root_id: "d-other", type: "p" }]),
			ROOT,
			"b2",
		);
		expect(r).toEqual({ kind: "foreign", rootId: "d-other" });
	});

	it("the stmt is the by-ID read the harness routes on", async () => {
		const stmts: string[] = [];
		const c = queryClient({
			query: (stmt) => {
				stmts.push(stmt);
				return [];
			},
		});
		await blockInDoc(c, ROOT, "b'1");
		expect(stmts[0]).toContain(STMT_HEADS["block-in-doc"]);
		expect(stmts[0]).toContain("'b''1'");
	});
});

describe("scopingRefusalOf", () => {
	it("projects the refusing kinds into the shared shape", () => {
		expect(
			scopingRefusalOf({ kind: "foreign", rootId: "d-other" }, "b1"),
		).toEqual({
			kind: "foreign",
			blockId: "b1",
			rootId: "d-other",
		});
		expect(scopingRefusalOf({ kind: "doc-id" }, "b1")).toEqual({
			kind: "doc-id",
			blockId: "b1",
		});
	});

	it("leaves every non-refusing kind to the flow's own policy", () => {
		expect(
			scopingRefusalOf({ kind: "in-doc", content: "x", type: "p" }, "b1"),
		).toBeUndefined();
		expect(scopingRefusalOf({ kind: "absent" }, "b1")).toBeUndefined();
	});
});

describe("rootEcho", () => {
	it("returns the root row's docId, stored title, and hpath", async () => {
		const r = await rootEcho(
			client([
				{
					root_id: "d-doc",
					content: "Docker Networking",
					hpath: "/Docker Networking",
				},
			]),
			"nb-r",
			"d-doc",
		);
		expect(r).toEqual({
			docId: "d-doc",
			title: "Docker Networking",
			hpath: "/Docker Networking",
		});
	});

	it("returns undefined when no type-'d' row resolves", async () => {
		expect(await rootEcho(client([]), "nb-r", "d-doc")).toBeUndefined();
	});

	it("the stmt is box-scoped, by-id, and type-'d'", async () => {
		const stmts: string[] = [];
		const c = queryClient({
			query: (stmt) => {
				stmts.push(stmt);
				return [];
			},
		});
		await rootEcho(c, "nb-r", "d-doc");
		expect(stmts[0]).toContain(STMT_HEADS["root-echo"]);
		expect(stmts[0]).toContain("box = 'nb-r'");
		expect(stmts[0]).toContain("type = 'd'");
	});
});

describe("ownershipStmt", () => {
	it("the stmt is box-scoped and by-id", () => {
		const stmt = ownershipStmt("nb-r", "d-doc");
		expect(stmt.startsWith(STMT_HEADS.ownership)).toBe(true);
		expect(stmt).toContain("id = 'd-doc'");
		expect(stmt).toContain("box = 'nb-r'");
	});
});

describe("ownership", () => {
	it("a block id exports its containing doc's root", async () => {
		expect(await ownership(client([{ root_id: ROOT }]), "nb-r", "b1")).toBe(
			ROOT,
		);
	});

	it("a doc id is its own root", async () => {
		expect(
			await ownership(client([{ root_id: "d-doc" }]), "nb-r", "d-doc"),
		).toBe("d-doc");
	});

	it("a no-row outcome is undefined — the whole story", async () => {
		expect(await ownership(client([]), "nb-r", "d-doc")).toBeUndefined();
	});

	it("the read rides ownershipStmt (box-scoped, by-id)", async () => {
		const stmts: string[] = [];
		const c = queryClient({
			query: (stmt) => {
				stmts.push(stmt);
				return [];
			},
		});
		await ownership(c, "nb-r", "d-doc");
		expect(stmts[0]).toBe(ownershipStmt("nb-r", "d-doc"));
	});
});

describe("firstChildContent", () => {
	it("returns the first child's content — the document-order read", async () => {
		let seen: string | undefined;
		const c = queryClient({
			getChildBlocks: (id) => {
				seen = id;
				return [
					{ id: "p1", type: "p", content: "first para" },
					{ id: "p2", type: "p", content: "second para" },
				];
			},
		});
		expect(await firstChildContent(c, "d1")).toBe("first para");
		expect(seen).toBe("d1");
	});

	it("returns undefined on an empty child list", async () => {
		const c = queryClient({});
		expect(await firstChildContent(c, "d1")).toBeUndefined();
	});

	it("rethrows kernel failures verbatim — the swallow is the caller's", async () => {
		const c = queryClient({
			getChildBlocks: () => {
				throw new SiYuanApiError(500);
			},
		});
		await expect(firstChildContent(c, "d1")).rejects.toThrow(SiYuanApiError);
	});
});

describe("blockContents", () => {
	it("maps rows to id/content pairs over the IN-list statement", async () => {
		let seen: string | undefined;
		const c = queryClient({
			query: (stmt) => {
				seen = stmt;
				return [
					{ id: "b1", content: "first", root_id: ROOT, type: "p" },
					{ id: "b2", content: "second", root_id: "other", type: "p" },
				];
			},
		});
		expect(await blockContents(c, ["b1", "b2"])).toEqual([
			{ id: "b1", content: "first" },
			{ id: "b2", content: "second" },
		]);
		// The explicit outer LIMIT opts out of the kernel's statement row cap
		// (Conf.Search.Limit, default 64); one row per id makes the id count
		// the exact bound.
		expect(seen).toBe(`${STMT_HEADS["block-contents"]} ('b1', 'b2') LIMIT 2`);
	});

	it("issues no query for an empty id set", async () => {
		let called = false;
		const c = queryClient({
			query: () => {
				called = true;
				return [];
			},
		});
		expect(await blockContents(c, [])).toEqual([]);
		expect(called).toBe(false);
	});
});
