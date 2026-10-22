import { describe, expect, it, vi } from "vitest";
import { SiYuanApiError } from "siyuan-kernel-api";
import { deepChain, queryClient, walkClient } from "./readStub.js";
import { docBody, readDoc } from "../body.js";

// The one-call stitch and the unified walk+body read, over stub clients.
// The kernel-side rendering facts (refs/embed verbatim, IAL suppression,
// the omitempty arm) are falsified by the live suite; these pins cover
// the join policy, the row evidence, and the seam composition.

const vanishedErr = () =>
	new SiYuanApiError(
		200,
		-1,
		"block not found or its encrypted notebook is locked",
	);

describe("docBody", () => {
	it("joins the top-level children's markdown in document order", async () => {
		const getChildBlocks = vi.fn(async (id: string) =>
			id === "d1"
				? [
						{
							id: "p1",
							type: "p",
							subType: "",
							content: "first",
							markdown: "first paragraph",
						},
						{
							id: "l1",
							type: "l",
							subType: "",
							content: "",
							markdown: "- item one\n- item two",
						},
						{
							id: "p2",
							type: "p",
							subType: "",
							content: "last",
							markdown: "last paragraph",
						},
					]
				: [],
		);
		const { body, children } = await docBody(
			queryClient({ getChildBlocks }),
			"d1",
		);
		// The joiner's byte rule: a blank line between blocks, none
		// trailing — one fixed rule, pinned byte-exact here.
		expect(body).toBe(
			"first paragraph\n\n- item one\n- item two\n\nlast paragraph",
		);
		// Per-child row evidence: the rows the join consumed, with `type`
		// retained. No per-child `content` — the walk-content representation
		// must not make a baseline seed from a read representable.
		expect(children).toEqual([
			{ id: "p1", type: "p", markdown: "first paragraph" },
			{ id: "l1", type: "l", markdown: "- item one\n- item two" },
			{ id: "p2", type: "p", markdown: "last paragraph" },
		]);
		expect(getChildBlocks).toHaveBeenCalledTimes(1);
	});

	it("keeps an absent-markdown row and omits the block from the body", async () => {
		// The omitempty arm: the kernel omits the field for an empty export
		// (empty leaf blocks). The row keeps its place — the omission stays
		// countable from the returned evidence — and the body omits the
		// block, which carries no content and no placeholder bytes.
		const client = queryClient({
			getChildBlocks: (id) =>
				id === "d1"
					? [
							{
								id: "p1",
								type: "p",
								subType: "",
								content: "kept",
								markdown: "kept paragraph",
							},
							{ id: "e1", type: "p", subType: "", content: "" },
						]
					: [],
		});
		const { body, children, omittedEmpty } = await docBody(client, "d1");
		expect(body).toBe("kept paragraph");
		expect(children).toEqual([
			{ id: "p1", type: "p", markdown: "kept paragraph" },
			{ id: "e1", type: "p" },
		]);
		// The countable half of the omitted-empty policy rides the result —
		// the caller never re-derives the omitempty arm from the rows.
		expect(omittedEmpty).toBe(1);
	});

	it("serves an empty body for an empty child list", async () => {
		const { body, children } = await docBody(walkClient({}), "d1");
		expect(body).toBe("");
		expect(children).toEqual([]);
	});

	it("propagates the kernel's not-found envelope verbatim", async () => {
		const client = queryClient({
			getChildBlocks: async () => {
				throw vanishedErr();
			},
		});
		await expect(docBody(client, "gone")).rejects.toBeInstanceOf(
			SiYuanApiError,
		);
	});
});

describe("readDoc", () => {
	// doc → [p1, quote(q1 → p2)]: the walk recurses into the container,
	// the body joins the top-level rows only.
	const nestedClient = () =>
		queryClient({
			getChildBlocks: (id) => {
				if (id === "d1")
					return [
						{
							id: "p1",
							type: "p",
							subType: "",
							content: "one",
							markdown: "top paragraph",
						},
						{
							id: "q1",
							type: "b",
							subType: "",
							content: "",
							markdown: "> quoted top",
						},
					];
				if (id === "q1")
					return [
						{
							id: "p2",
							type: "p",
							subType: "",
							content: "in",
							markdown: "inside quote",
						},
					];
				return [];
			},
		});

	it("carries the lean walk plus the body and children from one root call", async () => {
		const getChildBlocks = vi.fn(nestedClient().getChildBlocks);
		const result = await readDoc(queryClient({ getChildBlocks }), "d1");
		// The walk contract holds: document order, exact parentage,
		// the completeness facts — and no markdown on the evidence type.
		expect(result.blocks.map((b) => b.id)).toEqual(["p1", "q1", "p2"]);
		expect(result.blocks[2]).toMatchObject({
			parentId: "q1",
			parentType: "b",
		});
		expect(result.truncated).toBe(false);
		expect(result.incomplete).toBe(false);
		// Body and rows derive from the root call's rows; the deep block's
		// markdown does not enter the top-level body.
		expect(result.body).toBe("top paragraph\n\n> quoted top");
		expect(result.children).toEqual([
			{ id: "p1", type: "p", markdown: "top paragraph" },
			{ id: "q1", type: "b", markdown: "> quoted top" },
		]);
		// One traversal: the recursion's two calls serve walk AND body —
		// no separate body fetch.
		expect(getChildBlocks).toHaveBeenCalledTimes(2);
	});

	it("propagates a vanished root instead of serving an empty body", async () => {
		const client = queryClient({
			getChildBlocks: async () => {
				throw vanishedErr();
			},
		});
		await expect(readDoc(client, "d1")).rejects.toBeInstanceOf(SiYuanApiError);
	});

	it("tolerates a mid-walk vanish without shortening the body", async () => {
		// The soundness shape: the top-level markdown rendered whole from
		// the root call's snapshot before any recursion, so the walk's
		// mid-walk tolerance has no arm that reaches the served body — the
		// deep branch is cut (incomplete), the body bytes are intact.
		const base = nestedClient();
		const client = queryClient({
			getChildBlocks: (id) => {
				if (id === "q1") throw vanishedErr();
				return base.getChildBlocks(id);
			},
		});
		const { blocks, truncated, incomplete, body, children } = await readDoc(
			client,
			"d1",
		);
		expect(blocks.map((b) => b.id)).toEqual(["p1", "q1"]);
		expect(truncated).toBe(false);
		expect(incomplete).toBe(true);
		expect(body).toBe("top paragraph\n\n> quoted top");
		expect(children).toHaveLength(2);
	});

	it("keeps the body whole over a depth-truncated walk", async () => {
		// The load-bearing claim's second arm: a walk truncated at the
		// depth bound still serves the whole body — the top-level
		// markdown renders from the root call before any recursion, so
		// the bound can only shorten the walk's absences, never the
		// served bytes.
		const tree = {
			d1: [
				{
					id: "p1",
					type: "p",
					subType: "",
					content: "top",
					markdown: "top paragraph",
				},
			],
		};
		deepChain(tree, "d1");
		// The chain root carries a rendering — without it the truncated row
		// would omit from the body regardless of implementation, and the
		// claim below could not fail.
		tree.d1[1]!.markdown = "- chain";
		const result = await readDoc(walkClient(tree), "d1");
		expect(result.truncated).toBe(true);
		expect(result.incomplete).toBe(true);
		expect(result.body).toBe("top paragraph\n\n- chain");
		expect(result.children.map((c) => c.id)).toEqual(["p1", "c1"]);
	});

	it("serves an empty doc as an empty body with the walk facts intact", async () => {
		const result = await readDoc(walkClient({}), "d1");
		expect(result.body).toBe("");
		expect(result.children).toEqual([]);
		expect(result.blocks).toEqual([]);
		expect(result.incomplete).toBe(false);
	});
});
