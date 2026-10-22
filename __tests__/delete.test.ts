// Unit cases for the verified deletes — the block delete's pre-mutation
// scoping refusal (foreign / doc-id refuse before the mutation; an
// absent target falls through to the kernel's synchronous "tree not
// found" rejection, pinned live in delete.live.test.ts), the internal
// fresh-content guard (the stake walk refuses truncated before any arm
// is judged; the served target and the derived cascade descendants judge
// against it; a stale arm refuses before the mutation), and the
// target-gone judgment over the post-delete walk (an acked delete that
// left the block in place reads as still-present, never as a receipt for
// a surviving block; a truncated walk answers absence-unconfirmed, never
// a confident absence), plus the doc delete's pre-mutation evidence
// capture. The stub tree mutates exactly like the kernel: a successful
// deleteBlock prunes the block from its parent, so the judgment's
// evidence is walked the way the live tree is.

import { describe, expect, it } from "vitest";
import { SiYuanApiError, SiYuanNetworkError } from "siyuan-kernel-api";
import {
	deleteBlockVerified,
	deleteDocVerified,
	deleteLanded,
} from "../delete.js";
import { contentHash } from "../fresh.js";
import type { WalkedTree } from "../walk.js";
import { deepChain } from "./readStub.js";
import { deleteStub, okProbe } from "./writeStub.js";

const row = (id: string, type = "p"): Record<string, unknown> => ({
	id,
	type,
	subType: type === "h" ? "h1" : "",
	content: `content of ${id}`,
	markdown: `content of ${id}`,
	parentId: null,
	parentType: "d",
});

/** Fresh fixture per test — deleteBlock prunes the tree it is given, so a
 * shared object would leak a prior test's mutation into the next walk. */
const freshTree = (): Record<string, Record<string, unknown>[]> => ({
	"d-doc": [row("h1", "h"), row("b1"), row("b2")],
});

describe("deleteLanded", () => {
	const walk = (ids: string[], incomplete = false): WalkedTree => ({
		blocks: ids.map((id) => ({
			id,
			type: "p",
			subType: "",
			content: id,
			markdown: "",
			parentId: null,
			parentType: "d",
		})),
		rootId: "d-doc",
		truncated: incomplete,
		incomplete,
	});

	it("judges gone when the complete walk no longer holds the target", () => {
		expect(
			deleteLanded({ blockId: "b1", postWalk: walk(["h1", "b2"]) }),
		).toEqual({
			kind: "gone",
		});
	});

	it("judges still-present on an incomplete walk — presence is sound evidence", () => {
		expect(
			deleteLanded({ blockId: "b1", postWalk: walk(["h1", "b1"], true) }),
		).toEqual({ kind: "still-present" });
	});

	it("answers absence-unconfirmed when only an incomplete walk saw the target absent", () => {
		expect(
			deleteLanded({ blockId: "b1", postWalk: walk(["h1"], true) }),
		).toEqual({
			kind: "absence-unconfirmed",
		});
	});
});

describe("deleteBlockVerified", () => {
	const base = { blockId: "b1", rootId: "d-doc" };
	// The fixture rule: a judged id present in the fixture walk mints
	// `served` from that walk's content, so the judgment rides hash
	// comparison and adds no seed read; the absent fall-through is the
	// deliberate exception — its target mints `never-served` and exercises
	// the seed path.
	const served = (content: string) =>
		({ kind: "served", hash: contentHash(content) }) as const;
	const NEVER_SERVED = { kind: "never-served" } as const;
	// The flow-shaped lookup: the named target mints `served` from its
	// content; every other judged id (the derived cascade descendants)
	// rides the seed path — the fixture's descendants are session-unserved.
	const lookupFor = (id: string, content: string) => (blockId: string) =>
		blockId === id ? served(content) : NEVER_SERVED;

	it("judges the target gone from the post-delete walk and carries the verdict as evidence", async () => {
		const { client, calls } = deleteStub({ tree: freshTree() });
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			baselineFor: lookupFor("b1", "content of b1"),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		expect(outcome.verdict).toEqual({ kind: "gone" });
		// The deleted block's stored content rides the verdict — the
		// receipt's payload, never re-read by the consumer.
		expect(outcome.content).toBe("content of b1");
		// The post-delete walk is the snapshot: b1 absent, siblings intact.
		expect(outcome.postWalk.blocks.map((b) => b.id)).toEqual(["h1", "b2"]);
		// The judged walk is the pre-delete snapshot the guard certified —
		// the heading-delete report's evidence, complete by the guard's
		// own truncation refusal.
		expect(outcome.judgedWalk.blocks.map((b) => b.id)).toEqual([
			"h1",
			"b1",
			"b2",
		]);
		// The scoping read, the guard's stake walk, one mutation, then the
		// verification walk — no other reads (the served verdict mints no
		// seed read).
		expect(calls.map((c) => c.method)).toEqual([
			"query",
			"getChildBlocks",
			"deleteBlock",
			"getChildBlocks",
		]);
	});

	it("refuses a foreign target before the mutation — the id lives in another doc", async () => {
		const { client, calls } = deleteStub({
			tree: freshTree(),
			// Explicit rows replace the tree-derived ones: b1's indexed root
			// is another doc. The walk would have found b1 in d-doc — the
			// refusal is what keeps the raw-id mutation from destroying it.
			blockRows: [{ id: "b1", content: "x", root_id: "d-other", type: "p" }],
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			// Inert: the scoping refusal precedes the judgment entirely.
			baselineFor: () => NEVER_SERVED,
		});
		expect(outcome).toEqual({
			kind: "foreign",
			blockId: "b1",
			rootId: "d-other",
		});
		// Refused before the mutation: no delete fired, no walk run.
		expect(calls.map((c) => c.method)).toEqual(["query"]);
	});

	it("refuses a doc-id target before the mutation", async () => {
		const { client, calls } = deleteStub({
			tree: freshTree(),
			blockRows: [
				{ id: "b1", content: "Doc Title", root_id: "d-doc", type: "d" },
			],
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			baselineFor: () => NEVER_SERVED,
		});
		expect(outcome).toEqual({ kind: "doc-id", blockId: "b1" });
		expect(calls.map((c) => c.method)).toEqual(["query"]);
	});

	it("lets an absent target fall through to the kernel's synchronous rejection — asked, never refused pre-mutation", async () => {
		const { client, calls } = deleteStub({
			tree: freshTree(),
			blockRows: [], // the target matches no indexed row
			deleteError: new SiYuanApiError(-1, -1, "tree not found"),
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			// The deliberate fixture exception: the target is absent from the
			// index (the session could never have served it), so it mints
			// `never-served` and judges on the seed path — the seed read sees
			// no row either, so the arm is `unseen` and the delete is asked.
			baselineFor: () => NEVER_SERVED,
		});
		// The kernel was asked — the absent fall-through's designed route —
		// and the pinned kernel answers an absent target synchronously, so
		// the verdict is the kernel's error, not a judged landing.
		expect(outcome.kind).toBe("kernel-refused");
		if (outcome.kind !== "kernel-refused") return;
		expect(outcome.message).toContain("tree not found");
		expect(calls.map((c) => c.method)).toEqual([
			"query",
			"getChildBlocks",
			"query",
			"deleteBlock",
		]);
	});

	it("an index-lag false absent still lands judged: the kernel deletes the real block, the receipt has no content", async () => {
		const { client, calls } = deleteStub({
			tree: freshTree(),
			blockRows: [], // the membership index has not caught up with b1
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			// The walk still sees the block (the index is what lags), so the
			// fixture rule mints `served` from the walk content — no seed read.
			baselineFor: lookupFor("b1", "content of b1"),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		// The membership read saw no row, so the verdict carries no stored
		// content to itemize — the null-content arm of the judged shape.
		expect(outcome.verdict).toEqual({ kind: "gone" });
		expect(outcome.content).toBeNull();
		expect(calls.map((c) => c.method)).toEqual([
			"query",
			"getChildBlocks",
			"deleteBlock",
			"getChildBlocks",
		]);
	});

	it("judges still-present when the block survives behind HTTP success", async () => {
		const { client } = deleteStub({
			tree: freshTree(),
			prune: () => false,
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			baselineFor: lookupFor("b1", "content of b1"),
		});
		expect(outcome).toMatchObject({
			kind: "judged",
			verdict: { kind: "still-present" },
		});
		if (outcome.kind !== "judged") return;
		expect(outcome.postWalk.blocks.map((b) => b.id)).toContain("b1");
		// The no-op deleted nothing, but the block's stored content is
		// still the read's payload.
		expect(outcome.content).toBe("content of b1");
	});

	it("refuses walk-truncated on a truncated stake walk — the refusal is unconditional, seen target or not", async () => {
		// Presence is sound evidence even on a truncated walk — but the
		// stake enumeration is not: a descendant may sit past the bound and
		// the cascade would consume it unjudged. The truncation refusal is
		// judged before any verdict is consulted, so it fires whether the
		// target itself is visible in the seen prefix or hangs past the
		// bound (the unseen-target absence arms are the deleteLanded unit
		// rows' coverage, not this primitive's).
		const tree: Record<string, Record<string, unknown>[]> = {
			"d-doc": [
				{ id: "b1", type: "p", subType: "", content: "shallow survivor" },
			],
		};
		deepChain(tree, "d-doc");
		const { client, calls } = deleteStub({
			tree,
			blockRows: [{ id: "b1", content: "shallow survivor", root_id: "d-doc" }],
			prune: () => false,
		});
		const outcome = await deleteBlockVerified(client, okProbe, {
			...base,
			baselineFor: lookupFor("b1", "shallow survivor"),
		});
		expect(outcome).toEqual({ kind: "walk-truncated" });
		expect(calls.some((c) => c.method === "deleteBlock")).toBe(false);
	});

	it("a heading's cascade stake is the heading alone — the delete path is fold-blind, the members survive it", async () => {
		// The section members are tree siblings of the heading, not its
		// descendants, and the kernel's heading delete removes only the
		// heading — so the stake derivation must not pull them in: they are
		// never judged (no seed read for them), and the delete proceeds.
		const tree: Record<string, Record<string, unknown>[]> = {
			"d-doc": [row("h1", "h"), row("p1"), row("h2", "h"), row("p2")],
		};
		const { client, calls } = deleteStub({ tree });
		const outcome = await deleteBlockVerified(client, okProbe, {
			blockId: "h1",
			rootId: "d-doc",
			baselineFor: lookupFor("h1", "content of h1"),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		expect(outcome.verdict).toEqual({ kind: "gone" });
		// The judged walk is the full pre-delete snapshot — the report's
		// evidence rides the ok arm verbatim.
		expect(outcome.judgedWalk.blocks.map((b) => b.id)).toEqual([
			"h1",
			"p1",
			"h2",
			"p2",
		]);
		// One query on record — the scoping read. The members were never
		// judged, so no seed read fired.
		expect(calls.filter((c) => c.method === "query")).toHaveLength(1);
	});

	it("a container's cascade stake judges its descendants on the seed path and the delete proceeds", async () => {
		// The kernel's cascade consumes a non-heading container's
		// descendants with it, so the stake is the target plus its subtree:
		// the descendants judge through the lookup — the fixture's are
		// session-unserved, so their seed read fires once.
		const tree: Record<string, Record<string, unknown>[]> = {
			"d-doc": [row("q1", "b")],
			q1: [row("p1")],
		};
		const { client, calls } = deleteStub({ tree });
		const outcome = await deleteBlockVerified(client, okProbe, {
			blockId: "q1",
			rootId: "d-doc",
			baselineFor: lookupFor("q1", "content of q1"),
		});
		expect(outcome.kind).toBe("judged");
		if (outcome.kind !== "judged") return;
		expect(outcome.verdict).toEqual({ kind: "gone" });
		expect(outcome.judgedWalk.blocks.map((b) => b.id)).toEqual(["q1", "p1"]);
		expect(calls.map((c) => c.method)).toEqual([
			"query",
			"getChildBlocks",
			"getChildBlocks",
			"query",
			"deleteBlock",
			"getChildBlocks",
		]);
	});

	it("a served cascade descendant whose content diverged refuses the delete — the stake is judged, not just the target", async () => {
		// The same fact the section flows pin over their closure: a judged
		// id the session served is compared against its stored hash — a
		// diverging walk content refuses pre-mutation, no seed read needed.
		const tree: Record<string, Record<string, unknown>[]> = {
			"d-doc": [row("q1", "b"), row("q2", "b")],
			q1: [row("p1")],
		};
		const { client, calls } = deleteStub({ tree });
		const lookup = lookupFor("q1", "content of q1");
		const outcome = await deleteBlockVerified(client, okProbe, {
			blockId: "q1",
			rootId: "d-doc",
			baselineFor: (id) => (id === "p1" ? served("older content") : lookup(id)),
		});
		expect(outcome.kind).toBe("fresh-refused");
		if (outcome.kind !== "fresh-refused") return;
		expect(outcome.arms).toEqual([
			{
				kind: "fresh",
				blockId: "q1",
				currentContent: "content of q1",
			},
			{
				kind: "stale",
				blockId: "p1",
				currentContent: "content of p1",
				compared: "baseline",
			},
		]);
		// The refusal predates any mutation, and both judged ids rode hash
		// comparison — no seed read fired beyond the scoping read.
		expect(calls.some((c) => c.method === "deleteBlock")).toBe(false);
		expect(calls.filter((c) => c.method === "query")).toHaveLength(1);
	});
});

describe("deleteDocVerified", () => {
	const docId = "d-doc";

	it("captures the pre-delete walk before the mutation and rides it on the mutated arm", async () => {
		const { client, calls } = deleteStub({
			tree: { [docId]: [row("b1"), row("b2", "h")] },
		});
		const outcome = await deleteDocVerified(client, okProbe, { docId });
		expect(outcome).toEqual({
			kind: "mutated",
			preWalk: {
				blocks: [
					{ ...row("b1"), parentType: "d" },
					{ ...row("b2", "h"), parentType: "d" },
				],
				rootId: docId,
				truncated: false,
				incomplete: false,
			},
		});
		// Evidence read strictly before the mutation — the walk is the doc's
		// full block set, unobtainable after removeDocByID.
		expect(calls.map((c) => c.method)).toEqual([
			"getChildBlocks",
			"removeDocByID",
		]);
	});

	it("propagates a pre-delete walk failure raw with no mutation fired", async () => {
		const err = new SiYuanNetworkError();
		const { client, calls } = deleteStub({
			tree: { [docId]: [row("b1")] },
			walkError: err,
		});
		// Pre-mutation nothing is in flight — the raw error keeps the
		// caller's "unreachable" classification.
		await expect(deleteDocVerified(client, okProbe, { docId })).rejects.toBe(
			err,
		);
		expect(calls.filter((c) => c.method === "removeDocByID")).toEqual([]);
	});
});
