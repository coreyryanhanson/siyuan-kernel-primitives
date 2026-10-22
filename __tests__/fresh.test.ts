// Fresh-content judgment tests — the per-target arms (fresh / vanished /
// unseen / stale) over a stubbed kernel: walk-absence as the vanished
// decision (regardless of a lingering SQL row, with or without a supplied
// baseline), the seed-read gating (skipped entirely for baseline-held or
// vanished targets; scoped to the seed-and-check ids in mixed lists), the
// seed-and-check pair for baseline-less targets (diverging seed → stale
// fail-closed, absent row → unseen), every-stale-named ordering, and the
// single-walk shape.

import { describe, expect, it } from "vitest";
import { STMT_HEADS } from "../stmtKind.js";
import type { KernelReadClient } from "../client.js";
import {
	checkFreshContent,
	contentHash,
	freshRefusalOf,
	type ServedBaseline,
} from "../fresh.js";
import type { WalkedTree } from "../walk.js";
import { SiYuanApiError } from "siyuan-kernel-api";
import { deepChain, queryClient } from "./readStub.js";

interface CallLog {
	childBlocks: string[];
	queries: string[];
}

/** KernelReadClient stub: `tree` maps parent id → getChildBlocks children
 * (missing ids walk as empty), `rows` answers every query. Both call
 * kinds are logged. */
function stubClient(
	tree: Record<string, Record<string, unknown>[]>,
	rows: Record<string, unknown>[],
	log: CallLog = blankLog(),
): KernelReadClient {
	return queryClient({
		getChildBlocks: (id) => {
			log.childBlocks.push(id);
			return tree[id] ?? [];
		},
		query: (stmt) => {
			log.queries.push(stmt);
			return rows;
		},
	});
}

function blankLog(): CallLog {
	return { childBlocks: [], queries: [] };
}

/** Named baseline verdicts: a served hash rides as the `served` verdict,
 * its absence as the chosen `never-served` value. */
const served = (hash: string): ServedBaseline => ({ kind: "served", hash });
const neverServed: ServedBaseline = { kind: "never-served" };

/** One paragraph child under the doc root. */
function para(id: string, content: string): Record<string, unknown> {
	return { id, type: "p", subType: "", content };
}

describe("checkFreshContent", () => {
	it("reports fresh for walk content hashing to the baseline", async () => {
		const log = blankLog();
		const c = stubClient({ "d-doc": [para("b1", "served body")] }, [], log);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("served body")) },
			],
		});
		expect(r.arms).toEqual([
			{ kind: "fresh", blockId: "b1", currentContent: "served body" },
		]);
	});

	it("reports stale, with current content, when the baseline diverges", async () => {
		const c = stubClient({ "d-doc": [para("b1", "edited elsewhere")] }, []);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("served body")) },
			],
		});
		expect(r.arms).toEqual([
			{
				kind: "stale",
				blockId: "b1",
				currentContent: "edited elsewhere",
				compared: "baseline",
			},
		]);
	});

	it("names every stale target, in input order, never short-circuiting", async () => {
		const c = stubClient(
			{
				"d-doc": [
					para("b1", "changed one"),
					para("b2", "unchanged"),
					para("b3", "changed two"),
				],
			},
			[],
		);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("old one")) },
				{ blockId: "b2", baseline: served(contentHash("unchanged")) },
				{ blockId: "b3", baseline: served(contentHash("old two")) },
			],
		});
		expect(r.arms).toEqual([
			{
				kind: "stale",
				blockId: "b1",
				currentContent: "changed one",
				compared: "baseline",
			},
			{ kind: "fresh", blockId: "b2", currentContent: "unchanged" },
			{
				kind: "stale",
				blockId: "b3",
				currentContent: "changed two",
				compared: "baseline",
			},
		]);
	});

	it("reports vanished for an id absent from the walk even with a SQL row", async () => {
		// The mixed case: a concurrent delete inside the index-convergence
		// window — the walk no longer holds the block, blocks.content still
		// does. Walk-absence decides, never the SQL read.
		const c = stubClient({ "d-doc": [para("b2", "survivor")] }, [
			{ id: "b1", content: "lingering row" },
		]);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("lingering row")) },
			],
		});
		expect(r.arms).toEqual([{ kind: "vanished", blockId: "b1" }]);
	});

	it("vanished with no supplied baseline consults no SQL row", async () => {
		// The seed-read filter's walk-present conjunct: a vanished target is
		// judged off the walk alone, so a baseline-less target with a
		// lingering blocks.content row fires no seed read.
		const log = blankLog();
		const c = stubClient(
			{ "d-doc": [para("b2", "survivor")] },
			[{ id: "b1", content: "lingering row" }],
			log,
		);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: neverServed }],
		});
		expect(r.arms).toEqual([{ kind: "vanished", blockId: "b1" }]);
		expect(log.queries).toEqual([]);
	});

	it("scopes the seed read to the never-served survivors only", async () => {
		// Mixed list, one baseline-held and one seed-and-check target: the
		// seed statement names only the latter.
		const log = blankLog();
		const c = stubClient(
			{ "d-doc": [para("b1", "held"), para("b2", "seeded")] },
			[{ id: "b2", content: "seeded" }],
			log,
		);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("held")) },
				{ blockId: "b2", baseline: neverServed },
			],
		});
		expect(log.queries).toHaveLength(1);
		expect(log.queries[0]).toContain(STMT_HEADS["block-contents"]);
		expect(log.queries[0]).toContain("'b2'");
		expect(log.queries[0]).not.toContain("'b1'");
		expect(r.arms).toEqual([
			{ kind: "fresh", blockId: "b1", currentContent: "held" },
			{ kind: "unseen", blockId: "b2", currentContent: "seeded" },
		]);
	});

	it("reports unseen for a never-served survivor with an absent seed row", async () => {
		const log = blankLog();
		const c = stubClient({ "d-doc": [para("b1", "never served")] }, [], log);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: neverServed }],
		});
		expect(r.arms).toEqual([
			{ kind: "unseen", blockId: "b1", currentContent: "never served" },
		]);
		expect(log.queries[0]).toContain(STMT_HEADS["block-contents"]);
	});

	it("fails closed to stale when a present seed row diverges from the walk", async () => {
		// The walk ≡ blocks.content split: a kernel that ever rendered the
		// two forms differently surfaces here as stale, named — never as a
		// silent match.
		const c = stubClient({ "d-doc": [para("b1", "walk form")] }, [
			{ id: "b1", content: "sql form" },
		]);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: neverServed }],
		});
		expect(r.arms).toEqual([
			{
				kind: "stale",
				blockId: "b1",
				currentContent: "walk form",
				compared: "seed",
			},
		]);
	});

	it("reports unseen when a present seed row matches the walk", async () => {
		const c = stubClient({ "d-doc": [para("b1", "same both ways")] }, [
			{ id: "b1", content: "same both ways" },
		]);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: neverServed }],
		});
		expect(r.arms).toEqual([
			{ kind: "unseen", blockId: "b1", currentContent: "same both ways" },
		]);
	});

	it("skips the seed read entirely when every target holds a baseline", async () => {
		const log = blankLog();
		const c = stubClient(
			{ "d-doc": [para("b1", "served body")] },
			[{ id: "b1", content: "served body" }],
			log,
		);
		await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "b1", baseline: served(contentHash("served body")) },
			],
		});
		expect(log.queries).toEqual([]);
	});

	it("reports absence-unconfirmed for targets the truncated walk could not see", async () => {
		// d-doc → b1 … and a 33-deep chain with "deep" at its end: the seen
		// target judges fresh (presence is sound), the unseen one cannot
		// render vanished — it is unconfirmed.
		const tree: Record<string, Record<string, unknown>[]> = {
			"d-doc": [para("b1", "body")],
		};
		deepChain(tree, "d-doc", para("deep", "past the bound"));
		const log = blankLog();
		const c = stubClient(tree, [], log);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [
				{ blockId: "deep", baseline: served("whatever") },
				{ blockId: "b1", baseline: served(contentHash("body")) },
			],
		});
		expect(r.walk.truncated).toBe(true);
		expect(r.arms).toEqual([
			{ kind: "absence-unconfirmed", blockId: "deep" },
			{ kind: "fresh", blockId: "b1", currentContent: "body" },
		]);
		// No seed read: neither arm consults SQL.
		expect(log.queries).toEqual([]);
	});

	it("tolerates a vanished container: the walk ends incomplete and absent targets are absence-unconfirmed", async () => {
		// The kernel answers a vanished/locked id with HTTP 200 and code -1;
		// the walk's tolerated-vanish mode ends that branch instead of
		// throwing, so the judgment renders the fail-closed arm rather than
		// a raw SiYuanApiError the consumer would misword as a transport
		// failure.
		const log = blankLog();
		const c: KernelReadClient = queryClient({
			getChildBlocks: (id) => {
				log.childBlocks.push(id);
				throw new SiYuanApiError(200, -1, "block not found");
			},
			query: (stmt) => {
				log.queries.push(stmt);
				return [];
			},
		});
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: served(contentHash("body")) }],
		});
		expect(r.walk).toEqual({
			blocks: [],
			rootId: "d-doc",
			truncated: false,
			incomplete: true,
		});
		expect(r.arms).toEqual([{ kind: "absence-unconfirmed", blockId: "b1" }]);
		// The vanished doc needs no SQL row: walk-absence already decided.
		expect(log.queries).toEqual([]);
	});

	it("carries the judged walk as evidence alongside the arms", async () => {
		const c = stubClient({ "d-doc": [para("b1", "body")] }, []);
		const r = await checkFreshContent(c, {
			docId: "d-doc",
			targets: [{ blockId: "b1", baseline: neverServed }],
		});
		expect(r.walk).toEqual({
			blocks: [
				{
					id: "b1",
					type: "p",
					subType: "",
					content: "body",
					markdown: undefined,
					parentId: null,
					parentType: "d",
				},
			],
			rootId: "d-doc",
			truncated: false,
			incomplete: false,
		});
	});
});

describe("freshRefusalOf", () => {
	const walk: WalkedTree = {
		blocks: [
			{
				id: "b1",
				type: "p",
				subType: "",
				content: "body",
				markdown: "",
				parentId: null,
				parentType: "d",
			},
		],
		rootId: "d-doc",
		truncated: false,
		incomplete: false,
	};

	it("proceeds on every proceeding arm — none of them refuses", () => {
		const arms = [
			{ kind: "fresh", blockId: "b1", currentContent: "body" },
			{ kind: "unseen", blockId: "b2", currentContent: "x" },
			{ kind: "vanished", blockId: "b3" },
			{ kind: "absence-unconfirmed", blockId: "b4" },
		] as const;
		expect(freshRefusalOf([...arms], walk)).toBeUndefined();
	});

	it("refuses on a stale arm, carrying every judged arm in judged order plus the judged-order stale tuple and the walk", () => {
		const arms = [
			{ kind: "fresh", blockId: "b1", currentContent: "body" },
			{
				kind: "stale",
				blockId: "b2",
				currentContent: "changed",
				compared: "baseline",
			},
			{ kind: "unseen", blockId: "b3", currentContent: "x" },
		] as const;
		expect(freshRefusalOf([...arms], walk)).toEqual({
			kind: "fresh-refused",
			arms: [...arms],
			stale: [arms[1]],
			walk,
		});
	});
});
