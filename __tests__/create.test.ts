// Unit cases for the guarded-create core: the verified doc mint and the
// mint-title judgment, over the stubbed kernel.
import { describe, expect, it } from "vitest";
import { SiYuanApiError } from "siyuan-kernel-api";
import {
	createDocVerified,
	MINT_TITLE_MAX_RUNES,
	mintTitleProblem,
	type CreateDocOutcome,
} from "../create.js";
import { STMT_HEADS } from "../stmtKind.js";
import { withVerifyWindow } from "../convergence.js";
import { collapseWindow, okProbe, stubClient } from "./writeStub.js";

describe("createDocVerified", () => {
	const base = { boxId: "nb-r", title: "Docker Networking", body: "some body" };

	it("refuses an unmintable title before any kernel call — the flow's own judgment", async () => {
		const { client, calls } = stubClient({
			createError: new SiYuanApiError(400, -1, "no mint expected"),
		});
		// The arm shapes are pinned on mintTitleProblem below; this case
		// carries only the flow-level fact: the refusal precedes every
		// kernel contact, across the unmintable-title classes.
		for (const title of ["a/b", ".", ".."]) {
			const outcome = await createDocVerified(client, okProbe, {
				...base,
				title,
			});
			expect(outcome.kind).toBe("mint-title");
		}
		expect(calls).toEqual([]);
	});

	it("mints the trimmed form the judgment advises and returns the live tree's evidence", async () => {
		const { client, calls } = stubClient({
			getHPathByID: (id) => (id === "d-new" ? "/Docker Networking" : "/doc"),
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["verified-root"])
					? [
							{
								id: "d-new",
								root_id: "d-new",
								content: "Docker Networking",
							},
						]
					: [],
		});
		const outcome: CreateDocOutcome = await createDocVerified(client, okProbe, {
			...base,
			title: "  Docker Networking  ",
		});
		expect(outcome).toEqual({
			kind: "created",
			docId: "d-new",
			content: "Docker Networking",
			hpath: "/Docker Networking",
		});
		const mint = calls.find((c) => c.method === "createDocWithMarkdown");
		expect(mint?.args).toEqual({
			notebook: "nb-r",
			path: "/Docker Networking",
			markdown: "some body",
		});
		// The verified-create re-read rides the by-ID poll loop.
		expect(calls.filter((c) => c.method === "query").length).toBe(1);
	});

	it("composes the submission path from the parent's stored hpath", async () => {
		const { client, calls } = stubClient({
			getHPathByID: (id) =>
				id === "d-parent" ? "/Parent" : "/Parent/Docker Networking",
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					return [{ id: "d-parent", hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await createDocVerified(client, okProbe, {
			...base,
			parentId: "d-parent",
		});
		expect(outcome).toEqual({
			kind: "created",
			docId: "d-new",
			content: "Docker Networking",
			hpath: "/Parent/Docker Networking",
		});
		const mint = calls.find((c) => c.method === "createDocWithMarkdown");
		expect(mint?.args).toMatchObject({
			parentID: "d-parent",
			path: "/Parent/Docker Networking",
		});
	});

	it("refuses a parent that does not resolve to a doc row within the window", async () => {
		const { client, calls } = stubClient({ query: () => [] });
		const outcome = await collapseWindow(() =>
			createDocVerified(client, okProbe, {
				...base,
				parentId: "d-gone",
			}),
		);
		expect(outcome).toEqual({ kind: "parent-missing", parentId: "d-gone" });
		// The mint never fired.
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(false);
	});

	it("polls a parent whose blocks row has not landed yet, then mints nested", async () => {
		// The index lags a fresh doc's row; the kernel resolves the parent
		// synchronously from the live tree, so the read must poll, not refuse.
		// The post-mint asserts ride the live tree, so no further polls.
		let parentReads = 0;
		const { client, calls } = stubClient({
			getHPathByID: (id) =>
				id === "d-parent" ? "/Parent" : "/Parent/Docker Networking",
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					parentReads++;
					return parentReads === 1
						? []
						: [{ id: "d-parent", hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await withVerifyWindow([0, 0], () =>
			createDocVerified(client, okProbe, {
				...base,
				parentId: "d-parent",
			}),
		);
		expect(outcome).toEqual({
			kind: "created",
			docId: "d-new",
			content: "Docker Networking",
			hpath: "/Parent/Docker Networking",
		});
		expect(parentReads).toBe(2); // 2 polls; the ghost assert rides the live tree
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});

	it("refuses a ghost intermediate when the parent was renamed after the pre-mint read-back", async () => {
		const { client } = stubClient({
			// The live tree sees the rename immediately — an index read could
			// serve the stale hpath on both sides and pass.
			getHPathByID: (id) => (id === "d-parent" ? "/Renamed" : "unused"),
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					return [{ hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await createDocVerified(client, okProbe, {
			...base,
			parentId: "d-parent",
		});
		expect(outcome).toEqual({
			kind: "ghost-intermediate",
			parentId: "d-parent",
		});
	});

	it("refuses a ghost intermediate when the parent vanished — the kernel's tree-not-found rejection", async () => {
		const { client } = stubClient({
			getHPathByID: () => {
				throw new SiYuanApiError(500, -1, "tree not found");
			},
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					return [{ hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await createDocVerified(client, okProbe, {
			...base,
			parentId: "d-parent",
		});
		expect(outcome).toEqual({
			kind: "ghost-intermediate",
			parentId: "d-parent",
		});
	});

	it("rethrows a non-not-found parent failure into the verification fork", async () => {
		const { client } = stubClient({
			getHPathByID: () => {
				throw new SiYuanApiError(500, -1, "indexing");
			},
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					return [{ hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await createDocVerified(client, okProbe, {
			...base,
			parentId: "d-parent",
		});
		expect(outcome.kind).toBe("verification-failed");
	});

	it("refuses an hpath that diverges from ground truth (title normalization)", async () => {
		const { client } = stubClient({
			getHPathByID: (id) =>
				id === "d-parent" ? "/Parent" : "/Parent/docker networking",
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["parent-lookup"])) {
					return [{ hpath: "/Parent", content: "Parent" }];
				}
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					return [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
						},
					];
				}
				return [];
			},
		});
		const outcome = await createDocVerified(client, okProbe, {
			...base,
			parentId: "d-parent",
		});
		expect(outcome).toEqual({
			kind: "hpath-mismatch",
			stored: "/Parent/docker networking",
			expected: "/Parent/Docker Networking",
		});
	});

	it("refuses a root mint whose live hpath diverges from /title — the assert runs on both paths", async () => {
		const { client } = stubClient({
			getHPathByID: () => "/docker networking",
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["verified-root"])
					? [
							{
								id: "d-new",
								root_id: "d-new",
								content: "Docker Networking",
							},
						]
					: [],
		});
		const outcome = await createDocVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "hpath-mismatch",
			stored: "/docker networking",
			expected: "/Docker Networking",
		});
	});

	it("reports unconfirmable when the by-ID row never converges", async () => {
		const { client } = stubClient({ query: () => [] });
		const outcome = await collapseWindow(() =>
			createDocVerified(client, okProbe, base),
		);
		expect(outcome).toEqual({ kind: "unconfirmable", returnedId: "d-new" });
	});
});

describe("mintTitleProblem", () => {
	it("rejects each kernel fact as its closed-union arm", () => {
		expect(mintTitleProblem(" ")).toEqual({ kind: "empty" });
		expect(mintTitleProblem("a/b")).toEqual({
			kind: "slash",
			title: "a/b",
		});
		// The bare dot segments are the forms path.Join cleans out of the
		// mint address (root level collapses to "/" → empty base name → the
		// kernel's empty-title fallback); dotted titles survive verbatim.
		expect(mintTitleProblem(".")).toEqual({ kind: "dot-segment", title: "." });
		expect(mintTitleProblem("..")).toEqual({
			kind: "dot-segment",
			title: "..",
		});
		expect(mintTitleProblem("a..b")).toBeUndefined();
		expect(mintTitleProblem("...")).toBeUndefined();
		const long = "x".repeat(513);
		expect(mintTitleProblem(long)).toEqual({
			kind: "too-long",
			title: long,
			runes: 513,
		});
		expect(mintTitleProblem("has\ttab")).toEqual({
			kind: "control-chars",
			title: "has\ttab",
		});
		// The kernel silently strips the Unicode line/paragraph separators
		// (createDocWithMarkdown's base-name regex) — same refusal class.
		expect(mintTitleProblem("a\u2028b")).toEqual({
			kind: "control-chars",
			title: "a\u2028b",
		});
		expect(mintTitleProblem("a\u2029b")).toEqual({
			kind: "control-chars",
			title: "a\u2029b",
		});
	});

	it("accepts the exactly-512-rune boundary and plain titles", () => {
		expect(MINT_TITLE_MAX_RUNES).toBe(512);
		expect(mintTitleProblem("x".repeat(512))).toBeUndefined();
		expect(mintTitleProblem("Docker Networking")).toBeUndefined();
		expect(mintTitleProblem("R&D")).toBeUndefined();
	});

	it("trims before judging and reports rune count, not code units", () => {
		expect(mintTitleProblem(" Docker Networking ")).toBeUndefined();
		expect(mintTitleProblem("  ")).toEqual({ kind: "empty" });
		const emoji = "📘".repeat(513);
		const r = mintTitleProblem(emoji);
		expect(r).toEqual({
			kind: "too-long",
			title: emoji,
			runes: 513,
		});
	});
});
