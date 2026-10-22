// Unit cases for the verified insert: the landed judgment and the
// insertVerified flow over the stubbed kernel.
import { describe, expect, it } from "vitest";
import { SiYuanTimeoutError } from "siyuan-kernel-api";
import { MAX_WALK_DEPTH } from "../walk.js";
import { insertLanded, insertVerified, newBlockIdFrom } from "../insert.js";
import { deepChain } from "./readStub.js";
import { okProbe, stubClient, txFor, walked } from "./writeStub.js";

describe("newBlockIdFrom", () => {
	it("decodes data[0].doOperations[0].id — the pinned transaction shape", () => {
		expect(newBlockIdFrom(txFor("b-new"))).toBe("b-new");
	});
	it("returns undefined when the transaction carries no operations", () => {
		expect(newBlockIdFrom([{ doOperations: [] }])).toBeUndefined();
		expect(newBlockIdFrom([])).toBeUndefined();
	});
});

describe("insertLanded", () => {
	const tx = txFor("b-new");
	// The judgment takes whole trees, never bare sets — the tree's
	// incompleteness fact travels with it.
	const tree = (ids: string[], incomplete = false) => ({
		blocks: ids.map((id) => walked(id)),
		rootId: "d-doc",
		truncated: false,
		incomplete,
	});
	it("reports landed when the returned id is new in the post-write tree", () => {
		expect(
			insertLanded({
				tx,
				preWalk: tree(["a"]),
				postWalk: tree(["a", "b-new"]),
			}),
		).toEqual({ kind: "landed", blockId: "b-new" });
	});
	it("reports no-id when the kernel returned no block id", () => {
		expect(
			insertLanded({
				tx: [{ doOperations: [] }],
				preWalk: tree([]),
				postWalk: tree([]),
			}),
		).toEqual({ kind: "no-id" });
	});
	it("reports absent-from-tree when the id is missing from the post-write tree", () => {
		expect(
			insertLanded({
				tx,
				preWalk: tree([]),
				postWalk: tree(["a"]),
			}),
		).toEqual({ kind: "absent-from-tree", blockId: "b-new" });
	});
	it("reports landing-unconfirmed when the id is missing from a truncated post-write walk", () => {
		expect(
			insertLanded({
				tx,
				preWalk: tree([]),
				postWalk: tree(["a"], true),
			}),
		).toEqual({ kind: "landing-unconfirmed", blockId: "b-new" });
	});
	it("still reports landed from a truncated walk when the id is seen", () => {
		// Presence is sound evidence even on a truncated walk.
		expect(
			insertLanded({
				tx,
				preWalk: tree([]),
				postWalk: tree(["b-new"], true),
			}),
		).toEqual({ kind: "landed", blockId: "b-new" });
	});
	it("reports pre-write-id when the id already existed pre-write", () => {
		expect(
			insertLanded({
				tx,
				preWalk: tree(["b-new"]),
				postWalk: tree(["b-new"]),
			}),
		).toEqual({ kind: "pre-write-id", blockId: "b-new" });
	});
});

describe("insertVerified", () => {
	const base = {
		body: "new body",
		rootId: "d-doc",
		preWalk: {
			blocks: [],
			rootId: "d-doc",
			truncated: false,
			incomplete: false,
		},
	};
	const insertAnchor = { kind: "insert", nextID: "h1b" } as const;
	// The post-write tree the primitive's walk sees — b-new present unless
	// the test leaves the tree unchanged (the silent-rollback case).
	const grownTree = (): Record<string, unknown>[] => [
		{
			id: "b-new",
			type: "p",
			subType: "",
			content: "new body",
			parentId: "d-doc",
			parentType: "d",
		},
	];

	it("refuses a truncated pre-write walk before any kernel call", async () => {
		const { client, calls } = stubClient();
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: insertAnchor,
			preWalk: {
				blocks: [],
				rootId: "d-doc",
				truncated: true,
				incomplete: true,
			},
		});
		// A truncated walk's absences are unconfirmed evidence — `landed`
		// must never rest on one.
		expect(outcome).toEqual({ kind: "walk-truncated" });
		expect(calls).toEqual([]);
	});

	it("inserts before the anchor's nextID and judges landed, carrying the post-write walk", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: () => grownTree(),
		});
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: insertAnchor,
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		expect(outcome.verdict).toEqual({ kind: "landed", blockId: "b-new" });
		expect(outcome.postWalk.blocks.map((b) => b.id)).toEqual(["b-new"]);
		expect(calls.find((c) => c.method === "insertBlock")?.args).toEqual({
			data: "new body",
			nextID: "h1b",
		});
	});

	it("judges landing-unconfirmed when the landed id hides past the depth bound", async () => {
		// d-doc → c1 … c32 → b-new: the post-write walk emits the chain,
		// truncates at the bound, and never sees the inserted block — the
		// write landed, but the evidence cannot say so.
		const routes: Record<string, Record<string, unknown>[]> = {};
		deepChain(routes, "d-doc", {
			id: "b-new",
			type: "p",
			subType: "",
			content: "new body",
			parentId: `c${MAX_WALK_DEPTH}`,
			parentType: "l",
		});
		const { client } = stubClient({ getChildBlocks: (id) => routes[id] ?? [] });
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: insertAnchor,
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landing-unconfirmed", blockId: "b-new" },
			postWalk: expect.objectContaining({ truncated: true, incomplete: true }),
		});
	});

	it("append anchor falls back to the doc root when the anchor names no container", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: () => grownTree(),
		});
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: { kind: "append", containerId: null },
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "landed", blockId: "b-new" },
			postWalk: expect.anything(),
		});
		expect(calls.find((c) => c.method === "appendBlock")?.args).toEqual({
			data: "new body",
			parentID: "d-doc",
		});
	});

	it("append anchor uses the anchor's container when it has one", async () => {
		const { client, calls } = stubClient({
			getChildBlocks: () => grownTree(),
		});
		await insertVerified(client, okProbe, {
			...base,
			anchor: { kind: "append", containerId: "list1" },
		});
		expect(calls.find((c) => c.method === "appendBlock")?.args).toEqual({
			data: "new body",
			parentID: "list1",
		});
	});

	it("judges the failure arms verbatim from insertLanded — a tree that never changed is absent-from-tree", async () => {
		const { client } = stubClient({
			getChildBlocks: () => [
				{
					id: "h1",
					type: "h",
					subType: "",
					content: "h",
					parentId: "d-doc",
					parentType: "d",
				},
			],
		});
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: insertAnchor,
		});
		expect(outcome).toEqual({
			kind: "judged",
			verdict: { kind: "absent-from-tree", blockId: "b-new" },
			postWalk: expect.anything(),
		});
	});

	it("classifies an append-anchor transport failure identically", async () => {
		const { client } = stubClient({
			appendError: new SiYuanTimeoutError(1000),
		});
		const outcome = await insertVerified(client, okProbe, {
			...base,
			anchor: { kind: "append", containerId: null },
		});
		expect(outcome).toEqual({
			kind: "transport-unverified",
			detail: "SiYuan request timed out after 1000ms",
		});
	});
});
