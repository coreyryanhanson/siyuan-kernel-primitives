// Unit cases for the verified edit: the walk-vs-walk landed judgment
// and the editVerified flow over the tree-converging stub. The landing
// is judged off the fresh guard's pre-write walk row against ONE
// post-write tree walk.
import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
} from "siyuan-kernel-api";
import { contentHash } from "../fresh.js";
import { judgeEditLanded, editVerified } from "../edit.js";
import type { WalkedBlock } from "../walk.js";
import { STMT_HEADS } from "../stmtKind.js";
import { editStub, okProbe, stubClient, type EditRoutes } from "./writeStub.js";

// ---------------------------------------------------------------------------
// judgeEditLanded — pure walk-vs-walk judgment
// ---------------------------------------------------------------------------

describe("judgeEditLanded", () => {
	const pre = (over: Partial<WalkedBlock> = {}): WalkedBlock => ({
		id: "b1",
		type: "p",
		subType: "",
		content: "old",
		markdown: "old",
		parentId: null,
		parentType: "d",
		...over,
	});
	const post = (rows: WalkedBlock[], incomplete = false) => ({
		blocks: rows,
		rootId: "d-doc",
		truncated: incomplete,
		incomplete,
	});
	const base = (over: Partial<Parameters<typeof judgeEditLanded>[0]> = {}) => ({
		preWrite: pre(),
		body: "new",
		postWalk: post([pre({ content: "new", markdown: "new" })]),
		...over,
	});

	it("lands a subtype-only movement — a level-only heading edit keeps content and type byte-equal", async () => {
		// A heading's level lives in subType (and the rendered text carries
		// no level marks): a level-only edit moves subType alone, and
		// content and type stay put — the comparison must watch the four
		// fields, not a two-field equality subset.
		const outcome = judgeEditLanded(
			base({
				preWrite: pre({
					type: "h",
					subType: "h2",
					content: "Recipes (published, 8)",
					markdown: "## Recipes (published, 8)",
				}),
				body: "### Recipes (published, 8)",
				postWalk: post([
					pre({
						type: "h",
						subType: "h3",
						content: "Recipes (published, 8)",
						markdown: "## Recipes (published, 8)",
					}),
				]),
			}),
		);
		expect(outcome).toEqual({
			kind: "landed",
			stored: {
				content: "Recipes (published, 8)",
				type: "h",
				subType: "h3",
				markdown: "## Recipes (published, 8)",
			},
		});
	});

	it("lands a markdown-only movement — a checkbox toggle content never shows", async () => {
		// The stored form of `- [x]` is `- [X]` (uppercase, the kernel's
		// marker normalization): pre- and post-write rows are both of the
		// stored form, so the toggle still reads as moved. Never compare a
		// submitted body against the stored form.
		const outcome = judgeEditLanded(
			base({
				preWrite: pre({ content: " task", markdown: "- [ ] task" }),
				body: "- [x] task",
				postWalk: post([pre({ content: " task", markdown: "- [X] task" })]),
			}),
		);
		expect(outcome).toEqual({
			kind: "landed",
			stored: {
				content: " task",
				type: "p",
				subType: "",
				markdown: "- [X] task",
			},
		});
	});

	it("answers still-pre-write when all four fields equal the pre-write row on a byte-different body", async () => {
		// The true statement: the live tree still holds the pre-write row.
		// Conservative over a resubmit the kernel normalizes onto the
		// stored row — loud, never ok.
		const outcome = judgeEditLanded(base({ postWalk: post([pre()]) }));
		expect(outcome).toEqual({
			kind: "still-pre-write",
			observed: { content: "old", type: "p", subType: "", markdown: "old" },
		});
	});

	it("lands the observed no-op — a byte-equal body over an unchanged tree", async () => {
		const outcome = judgeEditLanded(
			base({ body: "old", postWalk: post([pre()]) }),
		);
		expect(outcome).toEqual({
			kind: "landed",
			stored: { content: "old", type: "p", subType: "", markdown: "old" },
		});
	});

	it("answers concurrent-move when the row re-parented — never ok, judged before the fields", async () => {
		// The row sits inside a quote now: a concurrent intra-doc move
		// landed between the fresh walk and the mutation. The different
		// parentId is the verdict's own evidence.
		const outcome = judgeEditLanded(
			base({
				postWalk: post([pre({ parentId: "q1", parentType: "b" })]),
			}),
		);
		expect(outcome).toEqual({
			kind: "concurrent-move",
			row: {
				content: "old",
				type: "p",
				subType: "",
				markdown: "old",
				parentId: "q1",
			},
		});
	});

	it("answers concurrent-gone when the row is absent from a complete post-write walk", async () => {
		// A concurrent delete or cross-doc move landed — tree-certified.
		const outcome = judgeEditLanded(base({ postWalk: post([]) }));
		expect(outcome).toEqual({ kind: "concurrent-gone" });
	});

	it("answers absence-unconfirmed when the row is absent from an incomplete post-write walk", async () => {
		const outcome = judgeEditLanded(base({ postWalk: post([], true) }));
		expect(outcome).toEqual({ kind: "absence-unconfirmed" });
	});

	it("lands a moved row present in an incomplete post-write walk — presence survives truncation", async () => {
		// The truncation split: presence is a positive fact on ANY walk —
		// only the absence arms become unconfirmed past the depth bound.
		const outcome = judgeEditLanded(
			base({
				postWalk: post([pre({ content: "new", markdown: "new" })], true),
			}),
		);
		expect(outcome).toEqual({
			kind: "landed",
			stored: { content: "new", type: "p", subType: "", markdown: "new" },
		});
	});

	it("judges a nested target off the walk's by-id map — no parent routing", async () => {
		// The target sits inside a quote; the by-id lookup finds it
		// wherever the walk emitted it.
		const outcome = judgeEditLanded(
			base({
				preWrite: pre({ parentId: "q1", parentType: "b" }),
				postWalk: post([
					pre({ id: "q1", type: "b", parentId: null }),
					pre({
						content: "new",
						markdown: "new",
						parentId: "q1",
						parentType: "b",
					}),
				]),
			}),
		);
		expect(outcome.kind).toBe("landed");
	});
});

// ---------------------------------------------------------------------------
// editVerified — the flow over the tree-converging stub
// ---------------------------------------------------------------------------

describe("editVerified", () => {
	const treeRow = (
		id: string,
		content: string,
		over: Record<string, unknown> = {},
	): Record<string, unknown> => ({
		id,
		type: "p",
		subType: "",
		content,
		markdown: content,
		...over,
	});
	const base = {
		blockId: "b1",
		body: "new",
		rootId: "d-doc",
		baseline: { kind: "served", hash: contentHash("old") } as const,
	};

	it("judges landed off the post-write walk when the row moved", async () => {
		const routes = {
			tree: { "d-doc": [treeRow("b1", "old")] },
			onUpdate: (row: Record<string, unknown>) => {
				row.content = "new";
				row.markdown = "new";
			},
		};
		const { client, calls } = editStub(routes);
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "judged",
			verdict: {
				kind: "landed",
				stored: { content: "new", type: "p", subType: "", markdown: "new" },
			},
			postWalk: expect.objectContaining({ rootId: "d-doc" }),
		});
		expect(calls.find((c) => c.method === "updateBlock")?.args).toEqual({
			id: "b1",
			data: "new",
		});
	});

	it("the judgment is ONE walk read — no poll, no window, no SQL after the mutation, on any arm", async () => {
		// Landed arm: exactly two walk reads total (the fresh guard's
		// pre-write walk + the post-write verification walk), and no SQL
		// read after the mutation acked.
		const landed = editStub({
			tree: { "d-doc": [treeRow("b1", "old")] },
			onUpdate: (row) => {
				row.content = "new";
				row.markdown = "new";
			},
		});
		const landedOutcome = await editVerified(landed.client, okProbe, base);
		expect(landedOutcome.kind).toBe("judged");
		expect(
			landed.calls.filter((c) => c.method === "getChildBlocks"),
		).toHaveLength(2);
		const landedAfter = landed.calls.slice(
			landed.calls.findIndex((c) => c.method === "updateBlock") + 1,
		);
		expect(landedAfter.some((c) => c.method === "query")).toBe(false);
		// The guard's walk preceded the mutation — the guard's adjacency.
		const landedMethods = landed.calls.map((c) => c.method);
		expect(landedMethods.indexOf("updateBlock")).toBeGreaterThan(
			landedMethods.indexOf("getChildBlocks"),
		);

		// Failure arm (still-pre-write — the tree no-op): same shape.
		const stuck = editStub({ tree: { "d-doc": [treeRow("b1", "old")] } });
		const stuckOutcome = await editVerified(stuck.client, okProbe, base);
		expect(stuckOutcome).toMatchObject({
			kind: "judged",
			verdict: { kind: "still-pre-write" },
		});
		const stuckAfter = stuck.calls.slice(
			stuck.calls.findIndex((c) => c.method === "updateBlock") + 1,
		);
		expect(
			stuckAfter.filter((c) => c.method === "getChildBlocks"),
		).toHaveLength(1);
		expect(stuckAfter.some((c) => c.method === "query")).toBe(false);
	});

	it("lands a subtype-only heading edit — the level moves in subType/markdown, content carries no level marks", async () => {
		const routes = {
			tree: {
				"d-doc": [
					treeRow("h1", "Recipes (published, 8)", {
						type: "h",
						subType: "h2",
						markdown: "## Recipes (published, 8)",
					}),
				],
			},
			onUpdate: (row: Record<string, unknown>) => {
				row.subType = "h3";
				row.markdown = "### Recipes (published, 8)";
			},
		};
		const { client } = editStub(routes);
		const outcome = await editVerified(client, okProbe, {
			blockId: "h1",
			body: "### Recipes (published, 8)",
			rootId: "d-doc",
			baseline: {
				kind: "served",
				hash: contentHash("Recipes (published, 8)"),
			},
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: {
				kind: "landed",
				stored: {
					content: "Recipes (published, 8)",
					type: "h",
					subType: "h3",
					markdown: "### Recipes (published, 8)",
				},
			},
		});
	});

	it("answers absence-unconfirmed when the post-write walk truncates past the row", async () => {
		// A 33-deep nesting chain: the walk's depth bound drops everything
		// past it, so the row the update moved into the chain's tail is
		// absent from an INCOMPLETE walk — unconfirmed, never ok.
		const docRows = [treeRow("b1", "old"), treeRow("n0", "", { type: "" })];
		const chain: Record<string, Record<string, unknown>[]> = {
			"d-doc": docRows,
		};
		for (let i = 0; i < 32; i++) {
			chain[`n${i}`] = [treeRow(`n${i + 1}`, "", { type: "" })];
		}
		const tail: Record<string, unknown>[] = [treeRow("b1", "old")];
		chain.n32 = tail;
		const routes = {
			tree: chain,
			onUpdate: (row: Record<string, unknown>) => {
				row.content = "new";
				row.markdown = "new";
				// The concurrent re-parent: the row moves to the chain's
				// unseen tail.
				const idx = docRows.findIndex((r) => r === row);
				if (idx >= 0) {
					docRows.splice(idx, 1);
					tail.push(row);
				}
			},
		};
		const { client } = editStub(routes);
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: { kind: "absence-unconfirmed" },
		});
	});

	it("refuses absent-target before any mutation — the walk-invisible doc root, whatever the index says", async () => {
		// An unindexed doc id is format-indistinguishable from a block id
		// through the index flush window, and the walk never emits the `d`
		// root: the refusal fires on walk absence, membership absent.
		const { client, calls } = editStub({
			tree: { "d-doc": [treeRow("b1", "old")] },
		});
		const outcome = await editVerified(client, okProbe, {
			...base,
			blockId: "d-doc",
		});
		expect(outcome).toEqual({
			kind: "absent-target",
			blockId: "d-doc",
			membership: { kind: "absent" },
			walk: expect.objectContaining({ rootId: "d-doc" }),
		});
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	it("refuses absent-target before any mutation — a tree that failed to load serves an empty complete walk", async () => {
		// The index still lists the target (membership in-doc) but the
		// tree read served nothing: the two reads disagree, the refusal
		// names both, and the destructive updateBlock arm stays
		// unreachable.
		const { client, calls } = editStub({
			tree: { "d-doc": [] },
			blockRows: [{ id: "b1", content: "old", root_id: "d-doc", type: "p" }],
		});
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "absent-target",
			blockId: "b1",
			membership: { kind: "in-doc", content: "old", type: "p" },
			walk: expect.objectContaining({ rootId: "d-doc" }),
		});
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	/** The kernel-refused / verification-failed classifier cases: the
	 * patch throws on the post-write walk read (the fresh guard's
	 * pre-write walk has already succeeded — the edit has acked by the
	 * time these fire). */
	const failingAfterMutation = (err: Error) => {
		const routes: EditRoutes = {
			tree: { "d-doc": [treeRow("b1", "old")] },
			onUpdate: () => {
				routes.walkError = err;
			},
		};
		return editStub(routes);
	};

	it("reports verification-failed when the post-write walk read fails — the edit has already acked", async () => {
		const { client } = failingAfterMutation(
			new SiYuanApiError(500, undefined, "locked"),
		);
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "verification-failed",
			cause: { kind: "kernel" },
			detail: "SiYuan API error (HTTP 500: locked)",
		});
	});

	it("a verification-phase auth failure classifies with its cause — the edit has already acked", async () => {
		const { client } = failingAfterMutation(new SiYuanAuthError(401));
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "verification-failed",
			cause: { kind: "auth", status: 401 },
			detail: "SiYuan auth rejected the request (HTTP 401)",
		});
	});

	it("a verification-phase 429 classifies with its cause — never a raw rethrow", async () => {
		const { client } = failingAfterMutation(new SiYuanRateLimitError(429, 60));
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toEqual({
			kind: "verification-failed",
			cause: { kind: "rate-limit", retryAfterSeconds: 60 },
			detail: "SiYuan rate-limited the request (HTTP 429, Retry-After 60s)",
		});
	});

	it("refuses fresh-refused before the mutation when the walk content diverges from the served baseline", async () => {
		const { client, calls } = editStub({
			tree: { "d-doc": [treeRow("b1", "edited elsewhere")] },
		});
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome.kind).toBe("fresh-refused");
		if (outcome.kind !== "fresh-refused") return;
		expect(outcome.arms).toEqual([
			{
				kind: "stale",
				blockId: "b1",
				currentContent: "edited elsewhere",
				compared: "baseline",
			},
		]);
		// The judged walk rides the refusal — the consumer's outline and
		// re-baseline render from this snapshot, not a second read.
		expect(outcome.walk.blocks.map((b) => b.id)).toEqual(["b1"]);
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	it("refuses walk-truncated when the guard's walk cannot see the target — an unconfirmed absence never mutates", async () => {
		// The target sits inside a container whose branch the walk cuts
		// (the kernel's vanished-container envelope): the walk comes back
		// incomplete, the target's content was never compared, and the
		// destroy-shaped posture is fail-closed — refused pre-mutation.
		const { client, calls } = stubClient({
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["block-in-doc"])
					? [{ id: "b1", content: "old", root_id: "d-doc", type: "p" }]
					: [],
			getChildBlocks: (id) => {
				if (id === "d-doc")
					return [
						{
							id: "box",
							type: "b",
							subType: "",
							content: "",
							markdown: "",
							parentId: "d-doc",
							parentType: "d",
						},
					];
				if (id === "box")
					throw new SiYuanApiError(
						200,
						-1,
						"block not found or its encrypted notebook is locked",
					);
				return [];
			},
		});
		const outcome = await editVerified(client, okProbe, {
			...base,
			baseline: { kind: "never-served" },
		});
		expect(outcome).toEqual({ kind: "walk-truncated" });
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	it("lands through a tolerated mid-walk vanish — the evidence walk shortens, it never throws away", async () => {
		// A container's read fails with the kernel's vanished envelope between
		// the ack and the post-write walk: the walk tolerates it (incomplete),
		// the moved row is still present and POSITIVE — landed, carrying the
		// evidence the strict walk would have discarded behind a throw.
		let armed = false;
		const b1 = {
			id: "b1",
			type: "p",
			subType: "",
			content: "old",
			markdown: "old",
			parentId: "d-doc",
			parentType: "d",
		};
		const { client, calls } = stubClient({
			query: (stmt) =>
				stmt.startsWith(STMT_HEADS["block-in-doc"])
					? [{ id: "b1", content: "old", root_id: "d-doc", type: "p" }]
					: [],
			getChildBlocks: (id) => {
				if (id === "q1" && armed)
					throw new SiYuanApiError(
						200,
						-1,
						"block not found or its encrypted notebook is locked",
					);
				if (id === "d-doc")
					return [
						b1,
						{
							id: "q1",
							type: "b",
							subType: "",
							content: "",
							markdown: "",
							parentId: "d-doc",
							parentType: "d",
						},
					];
				if (id === "q1")
					return [
						{
							id: "c1",
							type: "p",
							subType: "",
							content: "inside",
							markdown: "inside",
							parentId: "q1",
							parentType: "b",
						},
					];
				return [];
			},
			onUpdate: () => {
				armed = true;
				b1.content = "new";
				b1.markdown = "new";
			},
		});
		const outcome = await editVerified(client, okProbe, base);
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: {
				kind: "landed",
				stored: { content: "new", type: "p", subType: "", markdown: "new" },
			},
		});
		if (outcome.kind !== "judged") return;
		// The vanish is named on the evidence walk, never swallowed.
		expect(outcome.postWalk.incomplete).toBe(true);
		expect(calls.some((c) => c.method === "updateBlock")).toBe(true);
	});

	it("judges the pre-write row off the WALK, not the blocks index — the two reads disagree", async () => {
		// A synthetic disagreement (the index read ahead of the tree): the
		// index row already holds the post-edit content while the tree still
		// holds the pre-write row, and the render stays empty (markdown
		// absent from the wire on both sides). If a regression seeded the
		// pre-write row from the index read, every watched field would equal
		// the post-write row and the byte-different body would answer
		// still-pre-write. The walk is the authority: the pre-write content
		// "old" vs the stored "new" is a movement — landed.
		const routes = {
			tree: {
				"d-doc": [
					{
						id: "b1",
						type: "p",
						subType: "",
						content: "old",
						parentId: "d-doc",
						parentType: "d",
					},
				],
			},
			blockRows: [{ id: "b1", content: "new", root_id: "d-doc", type: "p" }],
			onUpdate: (row: Record<string, unknown>) => {
				row.content = "new";
			},
		};
		const { client } = editStub(routes);
		const outcome = await editVerified(client, okProbe, {
			...base,
			body: "other",
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: {
				kind: "landed",
				stored: { content: "new", type: "p", subType: "", markdown: "" },
			},
		});
	});

	it("folds the foreign membership into the absent-target refusal — the walk is the presence authority", async () => {
		const { client, calls } = editStub({
			tree: {},
			blockRows: [{ id: "b1", content: "x", root_id: "d-other", type: "p" }],
		});
		expect(await editVerified(client, okProbe, base)).toEqual({
			kind: "absent-target",
			blockId: "b1",
			membership: { kind: "foreign", rootId: "d-other" },
			walk: expect.objectContaining({ rootId: "d-doc" }),
		});
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	it("folds the doc-id membership into the absent-target refusal — a doc row's content is its title, not a body", async () => {
		const { client, calls } = editStub({
			tree: {},
			blockRows: [{ id: "b1", content: "x", root_id: "d-doc", type: "d" }],
		});
		expect(await editVerified(client, okProbe, base)).toEqual({
			kind: "absent-target",
			blockId: "b1",
			membership: { kind: "doc-id" },
			walk: expect.objectContaining({ rootId: "d-doc" }),
		});
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});

	it("rethrows a pre-write read failure verbatim — the mutation never ran, no outcome-unknown to launder", async () => {
		const { client, calls } = editStub({
			tree: { "d-doc": [treeRow("b1", "old")] },
			walkError: new SiYuanNetworkError(),
		});
		await expect(editVerified(client, okProbe, base)).rejects.toBeInstanceOf(
			SiYuanNetworkError,
		);
		expect(calls.some((c) => c.method === "updateBlock")).toBe(false);
	});
});
