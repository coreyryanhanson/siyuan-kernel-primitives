import { describe, expect, it, vi } from "vitest";
import { SiYuanApiError } from "siyuan-kernel-api";
import { queryClient, walkClient } from "./readStub.js";
import { MAX_WALK_DEPTH, partitionByAbsence, walkBlockTree } from "../walk.js";
import { walkBlock } from "./readStub.js";

describe("walkBlockTree", () => {
	it("walks document order across a nested container tree", async () => {
		// doc → [h1, list(l → i → [h2, p]), h3] — depth-first, siblings in
		// row order, every block exactly once.
		const client = walkClient({
			d1: [
				{ id: "h1", type: "h", subType: "h1", content: "one" },
				{ id: "l1", type: "l", subType: "", content: "" },
				{ id: "h3", type: "h", subType: "h2", content: "three" },
			],
			l1: [{ id: "i1", type: "i", subType: "", content: "" }],
			i1: [
				{ id: "h2", type: "h", subType: "h2", content: "two" },
				{ id: "p1", type: "p", subType: "", content: "body" },
			],
		});
		const { blocks: walk } = await walkBlockTree(client, "d1");
		expect(walk.map((b) => b.id)).toEqual(["h1", "l1", "i1", "h2", "p1", "h3"]);
		// A wire row omitting `markdown` stays absent — the field is
		// presence-preserving, never coalesced at the projection.
		expect(walk[0]).toHaveProperty("markdown", undefined);
	});

	it("carries exact parentage from the tree, not depth", async () => {
		const client = walkClient({
			d1: [
				{ id: "q1", type: "b", subType: "", content: "" },
				{ id: "h1", type: "h", subType: "h1", content: "top" },
			],
			q1: [{ id: "h2", type: "h", subType: "h2", content: "in" }],
		});
		const { blocks: walk } = await walkBlockTree(client, "d1");
		const byId = new Map(walk.map((b) => [b.id, b]));
		// Root's children: null id, type "d".
		expect(byId.get("q1")).toMatchObject({
			parentId: null,
			parentType: "d",
		});
		expect(byId.get("h1")).toMatchObject({
			parentId: null,
			parentType: "d",
		});
		// The heading inside the quote belongs to the quote, not the doc.
		expect(byId.get("h2")).toMatchObject({ parentId: "q1", parentType: "b" });
	});

	it("does not recurse into headings", async () => {
		// The kernel answers a heading with its section; the walk must not
		// re-emit those siblings out of document order.
		const getChildBlocks = vi.fn(async (id: string) =>
			id === "h1"
				? [{ id: "sneaky", type: "p", subType: "", content: "" }]
				: [{ id: "h1", type: "h", subType: "h1", content: "head" }],
		);
		const { blocks: walk } = await walkBlockTree(
			queryClient({ getChildBlocks }),
			"d1",
		);
		expect(walk.map((b) => b.id)).toEqual(["h1"]);
		expect(getChildBlocks).toHaveBeenCalledTimes(1);
	});

	it("walks into mindmap containers — the retyped legacy mindmap list", async () => {
		// A migrated legacy mindmap: list → mindmap, its items →
		// mindmap_item (kernel/model/list_mindmap_migration.go); nested
		// lists inside an item retype the same way. The kernel's
		// getChildBlocks recurses into both (model.Block.IsContainerBlock),
		// so the walk must too — a missing row here voids every absence
		// judgment over content inside a mindmap.
		const client = walkClient({
			d1: [{ id: "mm1", type: "mindmap", subType: "u", content: "" }],
			mm1: [{ id: "mi1", type: "mindmap_item", subType: "u", content: "" }],
			mi1: [
				{ id: "mm2", type: "mindmap", subType: "u", content: "" },
				{ id: "p1", type: "p", subType: "", content: "body" },
			],
			mm2: [{ id: "mi2", type: "mindmap_item", subType: "u", content: "" }],
			mi2: [{ id: "p2", type: "p", subType: "", content: "leaf" }],
		});
		const { blocks: walk, truncated } = await walkBlockTree(client, "d1");
		expect(truncated).toBe(false);
		expect(walk.map((b) => b.id)).toEqual([
			"mm1",
			"mi1",
			"mm2",
			"mi2",
			"p2",
			"p1",
		]);
		const byId = new Map(walk.map((b) => [b.id, b]));
		expect(byId.get("mi1")).toMatchObject({
			parentId: "mm1",
			parentType: "mindmap",
		});
		expect(byId.get("p2")).toMatchObject({
			parentId: "mi2",
			parentType: "mindmap_item",
		});
	});

	it("nests unnamed (empty-type) blocks — the fail-safe direction", async () => {
		const client = walkClient({
			d1: [{ id: "odd", type: "", subType: "", content: "" }],
			odd: [{ id: "h1", type: "h", subType: "h3", content: "deep" }],
		});
		const { blocks: walk } = await walkBlockTree(client, "d1");
		expect(walk.map((b) => b.id)).toEqual(["odd", "h1"]);
		expect(walk[1]).toMatchObject({ parentId: "odd", parentType: "" });
	});
});

describe("walkBlockTree tolerateVanished", () => {
	const vanished = (
		inner: (id: string) => Promise<Record<string, unknown>[]>,
	) => queryClient({ getChildBlocks: inner });

	it("ends only the vanished branch under tolerateVanished", async () => {
		const client = vanished(async (id) => {
			if (id === "gone") {
				// The kernel's real refusal shape: HTTP 200, code -1.
				throw new SiYuanApiError(
					200,
					-1,
					"block not found or its encrypted notebook is locked",
				);
			}
			return [{ id: "gone", type: "b", subType: "", content: "" }];
		});
		const {
			blocks: walk,
			truncated,
			incomplete,
		} = await walkBlockTree(client, "d1", { tolerateVanished: true });
		// The b container vanishes mid-walk: the node itself is already in
		// the walk, its subtree is cut. Not depth truncation — truncated
		// stays false — but the walk is incomplete either way, so every
		// absence judgment over it reads unconfirmed.
		expect(walk.map((b) => b.id)).toEqual(["gone"]);
		expect(truncated).toBe(false);
		expect(incomplete).toBe(true);
	});

	it("propagates non-API errors even under tolerateVanished", async () => {
		const client = vanished(async () => {
			throw new Error("network down");
		});
		await expect(
			walkBlockTree(client, "d1", { tolerateVanished: true }),
		).rejects.toThrow("network down");
	});

	it("propagates non-refusal SiYuanApiError even under tolerateVanished", async () => {
		// A 5xx is a kernel/transport failure, not a vanished block — the
		// read must fail, not silently shorten.
		const client = vanished(async () => {
			throw new SiYuanApiError(500);
		});
		await expect(
			walkBlockTree(client, "d1", { tolerateVanished: true }),
		).rejects.toMatchObject({ status: 500 });
	});

	it("propagates SiYuanApiError in strict mode (write verification)", async () => {
		const client = vanished(async () => {
			throw new SiYuanApiError(
				200,
				-1,
				"block not found or its encrypted notebook is locked",
			);
		});
		await expect(walkBlockTree(client, "d1")).rejects.toBeInstanceOf(
			SiYuanApiError,
		);
	});

	it("propagates a vanished root even with belowRoot tolerance armed", async () => {
		// The body read's mode: the root call is the one body-corruption arm,
		// so it stays strict — a vanished root propagates rather than serving
		// an empty walk (and body) behind HTTP success.
		const client = vanished(async () => {
			throw new SiYuanApiError(
				200,
				-1,
				"block not found or its encrypted notebook is locked",
			);
		});
		await expect(
			walkBlockTree(client, "d1", { tolerateVanished: "belowRoot" }),
		).rejects.toBeInstanceOf(SiYuanApiError);
	});

	it("still tolerates a depth-2 vanish under belowRoot tolerance", async () => {
		const client = vanished(async (id) => {
			if (id === "gone") {
				throw new SiYuanApiError(
					200,
					-1,
					"block not found or its encrypted notebook is locked",
				);
			}
			return [{ id: "gone", type: "b", subType: "", content: "" }];
		});
		const {
			blocks: walk,
			truncated,
			incomplete,
		} = await walkBlockTree(client, "d1", { tolerateVanished: "belowRoot" });
		// Below the root, tolerance behaves exactly as the boolean mode: the
		// container's subtree is cut, the walk is incomplete but not
		// depth-truncated.
		expect(walk.map((b) => b.id)).toEqual(["gone"]);
		expect(truncated).toBe(false);
		expect(incomplete).toBe(true);
	});

	it("carries the depth-1 rows' markdown verbatim, absence preserved", async () => {
		const client = walkClient({
			d1: [
				{
					id: "p1",
					type: "p",
					subType: "",
					content: "one",
					markdown: "one rendered",
				},
				{
					id: "q1",
					type: "b",
					subType: "",
					content: "",
					markdown: "> quoted",
				},
			],
			q1: [{ id: "p2", type: "p", subType: "", content: "in" }],
		});
		const { blocks: walk } = await walkBlockTree(client, "d1", {
			tolerateVanished: "belowRoot",
		});
		// Present values verbatim; the wire field rides omitempty, so an
		// empty render is `undefined` — never coalesced to "" at the
		// projection (the body read judges presence off this field).
		expect(walk.map((b) => b.id)).toEqual(["p1", "q1", "p2"]);
		expect(walk[0]).toMatchObject({ markdown: "one rendered" });
		expect(walk[1]).toMatchObject({ markdown: "> quoted" });
		expect(walk[2]).toHaveProperty("markdown", undefined);
		// The depth-1 rows are the walk's own parentId === null entries — the
		// body read's selection.
		expect(walk.filter((b) => b.parentId === null).map((b) => b.id)).toEqual([
			"p1",
			"q1",
		]);
	});
});

describe("walk recursion bound", () => {
	it("walks the container chain exactly to MAX_WALK_DEPTH", async () => {
		const chainClient = (leafAfter: number) =>
			queryClient({
				async getChildBlocks(id) {
					if (id === "d1")
						return [{ id: "c1", type: "l", subType: "", content: "" }];
					const m = /^c(\d+)$/.exec(id);
					if (m === null) return [];
					const d = Number(m[1]);
					return d < leafAfter
						? [{ id: `c${d + 1}`, type: "l", subType: "", content: "" }]
						: [{ id: "leaf", type: "h", subType: "h1", content: "deep" }];
				},
			});
		const fullTree = await walkBlockTree(chainClient(MAX_WALK_DEPTH - 1), "d1");
		const full = fullTree.blocks;
		expect(fullTree.truncated).toBe(false);
		expect(full.map((b) => b.id)).toEqual([
			...Array.from({ length: MAX_WALK_DEPTH - 1 }, (_, i) => `c${i + 1}`),
			"leaf",
		]);
		expect(full.at(-1)?.parentId).toBe(`c${MAX_WALK_DEPTH - 1}`);
		const overTree = await walkBlockTree(chainClient(MAX_WALK_DEPTH), "d1");
		const over = overTree.blocks;
		// The bound drops the leaf past depth 32 — and names it: truncated
		// rides the tree so no consumer mistakes the prefix for the whole.
		expect(overTree.truncated).toBe(true);
		expect(over.map((b) => b.id)).toEqual(
			Array.from({ length: MAX_WALK_DEPTH }, (_, i) => `c${i + 1}`),
		);
	});
});

// ------------------------------------------------- partitionByAbsence

describe("partitionByAbsence", () => {
	it("publishes absent ids on a complete walk", () => {
		const walk = {
			blocks: [walkBlock("p1", "p", "", "kept")],
			rootId: "d1",
			truncated: false,
			incomplete: false,
		};
		expect(partitionByAbsence(["p1", "d1", "d2"], walk)).toEqual({
			kind: "complete",
			presentIds: ["p1"],
			absentIds: ["d1", "d2"],
		});
	});

	it("withholds absent ids on an incomplete walk — absence past the seen prefix is unconfirmed, never claimed", () => {
		const walk = {
			blocks: [walkBlock("p1", "p", "", "kept")],
			rootId: "d1",
			truncated: true,
			incomplete: true,
		};
		expect(partitionByAbsence(["p1", "d1", "d2"], walk)).toEqual({
			kind: "unconfirmed",
			presentIds: ["p1"],
			unconfirmedAbsentIds: ["d1", "d2"],
		});
	});
});
