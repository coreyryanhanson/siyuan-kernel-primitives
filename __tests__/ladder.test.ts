// The failure ladder — drift / transport-unverified / kernel-refused /
// auth rethrow / verification-failed — is owned by failure.ts and pinned
// by failure.test.ts. This suite pins each flow's wiring of it: the drift
// refusal precedes every kernel call, the classifier arms surface
// verbatim, and an outcome-UNKNOWN mutation runs exactly the flow's own
// reads (never a verification read). Flow arms beyond the ladder stay in
// the per-flow suites.
import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import type { WalkedTree } from "../walk.js";
import { createDocVerified } from "../create.js";
import { deleteSectionVerified } from "../deleteSection.js";
import { deleteBlockVerified, deleteDocVerified } from "../delete.js";
import { editVerified } from "../edit.js";
import { contentHash } from "../fresh.js";
import { insertVerified } from "../insert.js";
import { moveDocVerified, moveVerified } from "../move.js";
import { moveSectionVerified } from "../moveSection.js";
import { replaceSectionVerified } from "../replace.js";
import { STMT_HEADS } from "../stmtKind.js";
import type { WriteKernelClient } from "../write.js";
import {
	deleteStub,
	driftProbe,
	editStub,
	okProbe,
	stubClient,
	type StubRoutes,
} from "./writeStub.js";
import {
	baseTree,
	input as sectionInput,
	JUDGED_SET,
	preWalk,
	sectionStub,
	stakeLookup,
} from "./sectionStub.js";
import {
	DST,
	MOVED_IDS,
	SRC,
	moveSectionStub,
	preWalk as movePreWalk,
	sectionTree,
} from "./moveSectionStub.js";

type Call = { method: string; args: unknown };

/** Flat walk row; parentId mirrors the root ("d" at root level). The
 * un-annotated return stays assignable to both WalkedBlock and the raw
 * tree-row Record the stubs seed. */
const walkRow = (id: string, type = "p") => ({
	id,
	type,
	subType: type === "h" ? "h1" : "",
	content: id,
	markdown: id,
	parentId: null,
	parentType: "d",
});
const emptyWalk: WalkedTree = {
	blocks: [],
	rootId: "d-doc",
	truncated: false,
	incomplete: false,
};
const flatWalk = (...ids: string[]): WalkedTree => ({
	blocks: ids.map((id) => walkRow(id, id.startsWith("h") ? "h" : "p")),
	rootId: "d-doc",
	truncated: false,
	incomplete: false,
});

interface Flow {
	name: string;
	stub: (routes: FlowRoutes) => { client: WriteKernelClient; calls: Call[] };
	drift: (client: WriteKernelClient, routes: FlowRoutes) => Promise<unknown>;
	ok: (client: WriteKernelClient, routes: FlowRoutes) => Promise<unknown>;
}

/** The standard stub routes, widened with the delete-family routes: the
 * tree seed and walk-failure route (deleteStub consumes both; stubClient
 * ignores them), and the section flow's failed-transaction route
 * (sectionStub consumes it). */
type FlowRoutes = StubRoutes & {
	tree?: Record<string, Record<string, unknown>[]>;
	walkError?: Error | undefined;
};

const insertInput = {
	body: "new body",
	rootId: "d-doc",
	preWalk: emptyWalk,
	anchor: { kind: "insert", nextID: "h1b" } as const,
};
const editLadderRow = {
	id: "b1",
	type: "p",
	subType: "",
	content: "old",
	markdown: "old",
};
const editInput = {
	blockId: "b1",
	rootId: "d-doc",
	body: "new",
	// The served verdict mints from the fixture walk's content (the
	// fixture rule): the ladder's edit stub walks the doc, so the judged
	// target is present and the hash must genuinely match — the flow can
	// only reach the mutation through a fresh target.
	baseline: { kind: "served", hash: contentHash("old") } as const,
};
const moveDestWalk = { ...flatWalk("m", "p1", "tail"), rootId: "d" };
const moveVerifiedInput = {
	blockId: "m",
	rootId: "d",
	destRootId: "d",
	// The walk's root matches the claimed root — the provenance gate the
	// entry judges before dispatch would refuse the ladder rows otherwise.
	preDestWalk: moveDestWalk,
};
// The anchor the entry derives off the caller-held walk (doc-end form —
// the walk's last block is a non-heading) and rides on the failure arms.
const moveIssuedAnchor = {
	kind: "move",
	previousID: "tail",
	at: "doc-end",
} as const;
const echoRow = {
	id: "kid",
	root_id: "kid",
	content: "Mv Kid",
	hpath: "/Mv Kid",
};
/** The delete-batch failure rows' routes: a mutable tree the insert lands
 * into (the batch only ever runs after a landed insert), the op-pruning
 * landing behavior unused here (the batch throws), and the row's own
 * failed-transaction error. */
const replaceBatchRoutes = (transactError: Error): FlowRoutes => {
	const tree: Record<string, Record<string, unknown>[]> = {
		"d-doc": [walkRow("h1", "h"), walkRow("p1"), walkRow("p2"), walkRow("h2")],
	};
	return {
		getChildBlocks: (id) => tree[id] ?? [],
		onInsert: () => {
			const siblings = tree["d-doc"] ?? [];
			tree["d-doc"] = [
				...siblings.slice(0, 3),
				{ id: "b-new", type: "p", subType: "", content: "repl" },
				...siblings.slice(3),
			];
		},
		transactError,
	};
};
const batchRejectErr = new SiYuanApiError(500, -1, "tree not found");
const insertBeforeBatch = (calls: Call[]) => {
	expect(calls.findIndex((c) => c.method === "insertBlock")).toBeLessThan(
		calls.findIndex((c) => c.method === "transact"),
	);
};
const moveDocInput = { boxId: "box", docId: "kid", destRootId: "dest" };
const freshTree = (): Record<string, Record<string, unknown>[]> => ({
	"d-doc": [walkRow("h1", "h"), walkRow("b1"), walkRow("b2")],
});
const REPLACE_WALK = flatWalk("h1", "p1", "p2", "h2");
const replaceInput = { rootId: "d-doc", headingId: "h1", body: "repl" };
const createInput = {
	boxId: "nb-r",
	title: "Docker Networking",
	body: "some body",
};

/** Derive the drift/ok pair from one per-flow call: the only difference
 * is which probe the flow refuses on. Drift sees empty routes (its stub
 * is always built from `{}`); ok sees the row's own routes, so a flow
 * body can derive its inputs from the same routes its stub seeded. */
const call = (
	fn: (
		c: WriteKernelClient,
		probe: typeof okProbe,
		routes: FlowRoutes,
	) => Promise<unknown>,
) => ({
	drift: (c: WriteKernelClient, routes: FlowRoutes) =>
		fn(c, driftProbe, routes),
	ok: (c: WriteKernelClient, routes: FlowRoutes) => fn(c, okProbe, routes),
});

const INSERT: Flow = {
	name: "insert",
	stub: (routes) => stubClient(routes),
	...call((c, p) => insertVerified(c, p, insertInput)),
};
const EDIT: Flow = {
	name: "edit",
	// The edit stub walks the doc — the flow must see the target to
	// reach the mutation (a walk-absent target refuses pre-mutation).
	stub: (routes) =>
		editStub({
			tree: { "d-doc": [editLadderRow] },
			...(routes.updateError !== undefined && {
				updateError: routes.updateError,
			}),
		}),
	...call((c, p) => editVerified(c, p, editInput)),
};
const MOVE_BLOCK: Flow = {
	name: "moveBlock",
	stub: (routes) => stubClient(routes),
	...call(async (c, p) => {
		// The two-route entry's pre-dispatch refusals (drift, foreign) ride the
		// wrapper's top level; the per-id route's ladder arms unwrap.
		const outcome = await moveVerified(c, p, moveVerifiedInput);
		return outcome.kind === "per-id" ? outcome.outcome : outcome;
	}),
};
const MOVE_DOC: Flow = {
	name: "moveDoc",
	stub: (routes) => stubClient(routes),
	...call((c, p) => moveDocVerified(c, p, moveDocInput)),
};
/** The delete flows' stub: deleteStub's declared return narrows to
 * DeleteKernelClient; the underlying object is stubClient's full
 * WriteKernelClient stub. */
const deleteRoutes = (): Flow["stub"] => (routes) =>
	deleteStub({
		tree: routes.tree ?? freshTree(),
		deleteError: routes.deleteError,
		walkError: routes.walkError,
	}) as unknown as { client: WriteKernelClient; calls: Call[] };
const DELETE_BLOCK: Flow = {
	name: "deleteBlock",
	stub: deleteRoutes(),
	...call((c, p) =>
		deleteBlockVerified(c, p, {
			blockId: "b1",
			rootId: "d-doc",
			// The fixture rule: the target is present in the fixture walk, so
			// the verdict mints served from that walk's content — the
			// judgment rides hash comparison and adds no seed read to the
			// wiring pins' ledgers.
			baselineFor: (id) => ({ kind: "served", hash: contentHash(id) }),
		}),
	),
};
const DELETE_DOC: Flow = {
	name: "deleteDoc",
	stub: deleteRoutes(),
	...call((c, p) => deleteDocVerified(c, p, { docId: "d-doc" })),
};
/** The section flow's stub rides the shared sectionStub; the corpus's
 * route key is the failed-transaction route — the batched flow's only
 * mutation call. */
const DELETE_SECTION: Flow = {
	name: "deleteSection",
	stub: (routes) =>
		sectionStub({
			tree: routes.tree ?? baseTree(),
			transactError: routes.transactError,
		}) as unknown as { client: WriteKernelClient; calls: Call[] },
	...call(async (c, p, routes) => {
		const walk = await preWalk(routes.tree ?? baseTree());
		return deleteSectionVerified(c, p, {
			...sectionInput,
			walk,
			// The fixture rule: every walk-present judged id mints `served`
			// from the walk's content — the guard rides hash comparison and
			// adds no seed read to the wiring pins' ledgers.
			baselineFor: stakeLookup(walk),
		});
	}),
};
/** The section-move flow's stub rides the shared moveSectionStub; the
 * corpus's route key is the failed-transaction route — the batched flow's
 * only mutation call. The input walks derive from a throwaway stub (the
 * moveSectionStub convention), so the drift case's calls record stays
 * empty. */
const MOVE_SECTION: Flow = {
	name: "moveSection",
	stub: (routes) =>
		moveSectionStub({
			tree: routes.tree ?? sectionTree(),
			transactError: routes.transactError,
		}) as unknown as { client: WriteKernelClient; calls: Call[] },
	...call(async (c, _p, routes) => {
		const tree = routes.tree ?? sectionTree();
		return moveSectionVerified(c, {
			blockId: "H",
			rootId: SRC,
			destRootId: DST,
			sourceWalk: await movePreWalk(tree, SRC),
			preDestWalk: await movePreWalk(tree, DST),
			toHeadingId: "B",
		});
	}),
	// Drift is the wrapper's arm — moveVerified refuses before any route
	// dispatch; the section sequence takes no probe of its own (one probe,
	// refused once). The classifier rows above keep driving the sequence
	// directly, so their wiring asserts stay scoped to the sequence.
	drift: async (c) =>
		moveVerified(c, driftProbe, {
			blockId: "H",
			rootId: SRC,
			destRootId: DST,
			preDestWalk: await movePreWalk(sectionTree(), DST),
			toHeadingId: "B",
		}),
};
const REPLACE: Flow = {
	name: "replace",
	stub: (routes) => stubClient(routes),
	...call((c, p) => {
		// Same fixture rule over the static walk: the closure (p1, p2 — the
		// members, walkRow content = id) mints `served`, so the judgment
		// issues no seed read.
		return replaceSectionVerified(c, p, {
			...replaceInput,
			walk: REPLACE_WALK,
			baselineFor: stakeLookup(REPLACE_WALK),
		});
	}),
};
const CREATE: Flow = {
	name: "create",
	stub: (routes) => stubClient(routes),
	...call((c, p) => createDocVerified(c, p, createInput)),
};

const FLOWS = [
	INSERT,
	EDIT,
	MOVE_BLOCK,
	MOVE_DOC,
	DELETE_BLOCK,
	DELETE_DOC,
	DELETE_SECTION,
	MOVE_SECTION,
	REPLACE,
	CREATE,
];

// Shared error instances and their classified outcomes — the detail text
// is layer 1's own message, surfaced verbatim by the flows.
const netErr = new SiYuanNetworkError();
const timeoutErr = new SiYuanTimeoutError(5000);
const UNVERIFIED = { kind: "transport-unverified", detail: netErr.message };
const UNVERIFIED_TIMEOUT = {
	kind: "transport-unverified",
	detail: timeoutErr.message,
};
const none = (method: string) => (calls: Call[]) =>
	expect(calls.filter((c) => c.method === method)).toEqual([]);

interface ArmRow {
	name: string;
	flow: Flow;
	routes: FlowRoutes;
	outcome: unknown;
	wiring?: (calls: Call[]) => void;
}

// One table per arm class; each row carries the arm's exact outcome and
// (where the flow's own read ordering is the point) a wiring check.
const ARMS: ArmRow[] = [
	{
		name: "insert — the insert fails in flight",
		flow: INSERT,
		routes: { insertError: netErr },
		outcome: UNVERIFIED,
		wiring: none("getChildBlocks"),
	},
	{
		name: "edit — the update fails in flight",
		flow: EDIT,
		routes: { updateError: netErr },
		outcome: UNVERIFIED,
		// No query on record — the walk is the pre-write evidence and the
		// membership read only runs on the absent-target refusal path, and
		// no verification reads after an outcome-UNKNOWN mutation. The
		// judgment's walk precedes the mutation (the guard's adjacency
		// invariant).
		wiring: (calls) => {
			expect(calls.filter((c) => c.method === "query")).toHaveLength(0);
			const walk = calls.findIndex((c) => c.method === "getChildBlocks");
			const mutate = calls.findIndex((c) => c.method === "updateBlock");
			expect(walk).toBeGreaterThanOrEqual(0);
			expect(mutate).toBeGreaterThan(walk);
		},
	},
	{
		name: "moveBlock — the move fails in flight (network)",
		flow: MOVE_BLOCK,
		routes: { moveError: netErr },
		// The issued anchor rides the arm (verdicts carry their evidence).
		outcome: { ...UNVERIFIED, anchor: moveIssuedAnchor },
		wiring: none("getChildBlocks"),
	},
	{
		name: "moveBlock — the move fails in flight (timeout)",
		flow: MOVE_BLOCK,
		routes: { moveError: timeoutErr },
		outcome: { ...UNVERIFIED_TIMEOUT, anchor: moveIssuedAnchor },
		wiring: none("getChildBlocks"),
	},
	{
		name: "moveDoc — the move fails in flight (network)",
		flow: MOVE_DOC,
		routes: { query: () => [echoRow], moveDocsError: netErr },
		outcome: UNVERIFIED,
		wiring: none("getHPathByID"),
	},
	{
		name: "moveDoc — the move fails in flight (timeout)",
		flow: MOVE_DOC,
		routes: { query: () => [echoRow], moveDocsError: timeoutErr },
		outcome: UNVERIFIED_TIMEOUT,
		wiring: none("getHPathByID"),
	},
	{
		name: "deleteBlock — the delete fails in flight",
		flow: DELETE_BLOCK,
		routes: { deleteError: netErr },
		outcome: UNVERIFIED,
		// The guard's stake walk precedes the mutation — the judgment walk
		// is on record before the delete fires.
		wiring: (calls) => {
			const walk = calls.findIndex((c) => c.method === "getChildBlocks");
			const mutate = calls.findIndex((c) => c.method === "deleteBlock");
			expect(walk).toBeGreaterThanOrEqual(0);
			expect(mutate).toBeGreaterThan(walk);
		},
	},
	{
		name: "deleteDoc — the delete fails in flight",
		flow: DELETE_DOC,
		routes: { deleteError: timeoutErr },
		outcome: UNVERIFIED_TIMEOUT,
		// The pre-delete walk DID run — it precedes the mutation.
		wiring: (calls) =>
			expect(calls.filter((c) => c.method === "getChildBlocks")).toHaveLength(
				1,
			),
	},
	{
		name: "replace — the insert leg fails in flight",
		flow: REPLACE,
		routes: { insertError: netErr },
		outcome: {
			kind: "unverified",
			outcome: { stage: "insert", failure: UNVERIFIED },
		},
		// No delete batch after an outcome-UNKNOWN insert.
		wiring: none("transact"),
	},
	{
		name: "create — the create fails in flight (network)",
		flow: CREATE,
		routes: { createError: netErr },
		outcome: UNVERIFIED,
	},
	{
		name: "create — the create fails in flight (timeout)",
		flow: CREATE,
		routes: { createError: timeoutErr },
		outcome: UNVERIFIED_TIMEOUT,
	},
	{
		name: "insert — insertBlock rejects",
		flow: INSERT,
		routes: {
			insertError: new SiYuanApiError(500, undefined, "block not found"),
		},
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 500: block not found)",
		},
	},
	{
		name: "edit — updateBlock rejects",
		flow: EDIT,
		routes: {
			updateError: new SiYuanApiError(500, undefined, "block not found"),
		},
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 500: block not found)",
		},
	},
	{
		name: "moveDoc — moveDocsByID rejects",
		flow: MOVE_DOC,
		routes: {
			query: () => [echoRow],
			moveDocsError: new SiYuanApiError(500, undefined, "no such notebook"),
		},
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 500: no such notebook)",
		},
	},
	{
		name: "deleteBlock — deleteBlock rejects (tree not found)",
		flow: DELETE_BLOCK,
		routes: {
			deleteError: new SiYuanApiError(404, undefined, "tree not found"),
		},
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 404: tree not found)",
		},
	},
	{
		name: "deleteDoc — removeDocByID rejects",
		flow: DELETE_DOC,
		routes: {
			deleteError: new SiYuanApiError(500, undefined, "tree not found"),
		},
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 500: tree not found)",
		},
	},
	{
		name: "deleteSection — the transaction fails in flight",
		flow: DELETE_SECTION,
		routes: { transactError: netErr },
		// The judged set rides the transport arm — the whole set is what
		// may be gone.
		outcome: {
			kind: "unverified",
			outcome: { ...UNVERIFIED, judgedBlockIds: JUDGED_SET },
		},
		// No post-write walk after an outcome-UNKNOWN transaction —
		// nothing to verify yet.
		wiring: none("getChildBlocks"),
	},
	{
		name: "moveSection — the transaction fails in flight",
		flow: MOVE_SECTION,
		routes: { transactError: netErr },
		// The judged set rides the transport arm — the whole enumerated set
		// (members first, the heading last) is what may be gone.
		outcome: {
			kind: "unverified",
			outcome: { ...UNVERIFIED, judgedBlockIds: MOVED_IDS },
		},
		wiring: none("getChildBlocks"),
	},
	{
		name: "moveSection — the transaction rejects",
		flow: MOVE_SECTION,
		routes: {
			transactError: new SiYuanApiError(500, -1, "tree not found"),
		},
		outcome: {
			kind: "unverified",
			outcome: {
				kind: "kernel-refused",
				message: "SiYuan API error (HTTP 500, code -1: tree not found)",
			},
		},
		wiring: none("getChildBlocks"),
	},
	{
		name: "deleteSection — the transaction rejects",
		flow: DELETE_SECTION,
		routes: {
			transactError: new SiYuanApiError(500, -1, "tree not found"),
		},
		outcome: {
			kind: "unverified",
			outcome: {
				kind: "kernel-refused",
				message: "SiYuan API error (HTTP 500, code -1: tree not found)",
			},
		},
		// Nothing landed — the unapplied write must not wear a receipt, and
		// no verification walk runs.
		wiring: none("getChildBlocks"),
	},
	{
		name: "replace — the insert leg rejects",
		flow: REPLACE,
		routes: { insertError: new SiYuanApiError(500, undefined, "bad anchor") },
		outcome: {
			kind: "unverified",
			outcome: {
				stage: "insert",
				failure: {
					kind: "kernel-refused",
					message: "SiYuan API error (HTTP 500: bad anchor)",
				},
			},
		},
		wiring: none("transact"),
	},
	{
		name: "replace — the delete batch fails in flight",
		flow: REPLACE,
		routes: replaceBatchRoutes(netErr),
		// The batch runs after a COMMITTED insert — no ack, so the whole
		// judged set (the closure) is what may be gone, and the RAW error
		// rides the unverified arm for the consumer's post-insert
		// classification (the post-insert phase posture, preserved).
		outcome: {
			kind: "unverified",
			outcome: {
				stage: "delete-leg",
				failure: {
					kind: "mutation-failed",
					error: netErr,
					judgedBlockIds: ["p1", "p2"],
				},
				anchor: { kind: "insert", nextID: "h2" },
				insertedId: "b-new",
				memberIds: ["p1", "p2"],
			},
		},
		wiring: insertBeforeBatch,
	},
	{
		name: "replace — the delete batch rejects",
		flow: REPLACE,
		routes: replaceBatchRoutes(batchRejectErr),
		outcome: {
			kind: "unverified",
			outcome: {
				stage: "delete-leg",
				failure: {
					kind: "mutation-failed",
					error: batchRejectErr,
					judgedBlockIds: ["p1", "p2"],
				},
				anchor: { kind: "insert", nextID: "h2" },
				insertedId: "b-new",
				memberIds: ["p1", "p2"],
			},
		},
		wiring: insertBeforeBatch,
	},
	{
		name: "create — createDocWithMarkdown rejects synchronously",
		flow: CREATE,
		routes: { createError: new SiYuanApiError(400, -1, "bad path") },
		outcome: {
			kind: "kernel-refused",
			message: "SiYuan API error (HTTP 400, code -1: bad path)",
		},
	},
	{
		name: "insert — the post-write walk read fails",
		flow: INSERT,
		routes: {
			getChildBlocks: () => {
				throw new SiYuanApiError(500, undefined, "locked");
			},
		},
		outcome: {
			kind: "verification-failed",
			cause: { kind: "kernel" },
			detail: "SiYuan API error (HTTP 500: locked)",
		},
	},
	{
		name: "moveBlock — the post-move walk read fails",
		flow: MOVE_BLOCK,
		routes: {
			getChildBlocks: () => {
				throw netErr;
			},
		},
		// The issued anchor rides the arm (verdicts carry their evidence).
		outcome: {
			kind: "verification-failed",
			cause: { kind: "transport" },
			detail: netErr.message,
			anchor: moveIssuedAnchor,
		},
	},
	{
		name: "moveDoc — the hpath evidence read fails",
		flow: MOVE_DOC,
		routes: {
			query: () => [echoRow],
			getHPathByID: () => {
				throw netErr;
			},
		},
		outcome: {
			kind: "verification-failed",
			cause: { kind: "transport" },
			detail: netErr.message,
		},
	},
	{
		name: "create — the verified-root read fails",
		flow: CREATE,
		routes: {
			query: (stmt) => {
				if (stmt.startsWith(STMT_HEADS["verified-root"])) {
					throw netErr;
				}
				return [];
			},
		},
		outcome: {
			kind: "verification-failed",
			cause: { kind: "transport" },
			returnedId: "d-new",
			detail: netErr.message,
		},
	},
];

const AUTH: { name: string; flow: Flow; routes: FlowRoutes }[] = [
	{
		name: "insert",
		flow: INSERT,
		routes: { insertError: new SiYuanAuthError(401) },
	},
	{
		name: "edit",
		flow: EDIT,
		routes: { updateError: new SiYuanAuthError(401) },
	},
	{
		name: "moveBlock",
		flow: MOVE_BLOCK,
		routes: { moveError: new SiYuanAuthError(401) },
	},
	{
		name: "moveDoc",
		flow: MOVE_DOC,
		routes: { query: () => [echoRow], moveDocsError: new SiYuanAuthError(401) },
	},
	{
		name: "deleteBlock",
		flow: DELETE_BLOCK,
		routes: { deleteError: new SiYuanAuthError(401) },
	},
	{
		name: "deleteDoc",
		flow: DELETE_DOC,
		routes: { deleteError: new SiYuanAuthError(401) },
	},
	{
		name: "deleteSection",
		flow: DELETE_SECTION,
		routes: { transactError: new SiYuanAuthError(401) },
	},
	{
		name: "moveSection",
		flow: MOVE_SECTION,
		routes: { transactError: new SiYuanAuthError(401) },
	},
	{
		name: "replace",
		flow: REPLACE,
		routes: { insertError: new SiYuanAuthError(401) },
	},
	{
		name: "create",
		flow: CREATE,
		routes: { createError: new SiYuanAuthError(401) },
	},
];

const RATE_LIMIT: { name: string; flow: Flow; routes: FlowRoutes }[] = [
	{
		name: "create",
		flow: CREATE,
		routes: { createError: new SiYuanRateLimitError(429, 60) },
	},
	{
		name: "deleteSection",
		flow: DELETE_SECTION,
		routes: { transactError: new SiYuanRateLimitError(429, 30) },
	},
	{
		name: "moveSection",
		flow: MOVE_SECTION,
		routes: { transactError: new SiYuanRateLimitError(429, 30) },
	},
];

describe("the failure ladder wired through every flow", () => {
	describe("a drifted probe refuses before any kernel call", () => {
		for (const flow of FLOWS) {
			it(flow.name, async () => {
				const { client, calls } = flow.stub({});
				const outcome = await flow.drift(client, {});
				// The phase-wrapped sequences refuse drift under the refused
				// phase; the unwrapped flows return the bare arm.
				const arm =
					(outcome as { kind?: string } | null)?.kind === "refused"
						? (outcome as { refusal: unknown }).refusal
						: outcome;
				expect(arm).toEqual({ kind: "drift", observed: "3.9.0" });
				expect(calls).toEqual([]);
			});
		}
	});

	describe("the classifier arms surface verbatim", () => {
		for (const row of ARMS) {
			it(row.name, async () => {
				const { client, calls } = row.flow.stub(row.routes);
				const outcome = await row.flow.ok(client, row.routes);
				expect(outcome).toEqual(row.outcome);
				row.wiring?.(calls);
			});
		}

		// The raw-propagation rule's standing pin: deleteBlock's guard walk
		// is a PRE-mutation read, so its failure is the caller's
		// classification (nothing is in flight, and no read was ever owed a
		// verdict) — a raw throw, never verification-failed. The post-delete
		// walk's own failure arm stays covered by the delete suite.
		it("deleteBlock — the guard walk read fails pre-mutation, propagating raw", async () => {
			const { client, calls } = deleteStub({
				tree: freshTree(),
				walkError: netErr,
			});
			await expect(
				deleteBlockVerified(client, okProbe, {
					blockId: "b1",
					rootId: "d-doc",
					baselineFor: (id) => ({ kind: "served", hash: contentHash(id) }),
				}),
			).rejects.toBe(netErr);
			expect(calls.some((c) => c.method === "deleteBlock")).toBe(false);
		});
	});

	describe("mutation-phase auth and rate-limit errors rethrow for the caller's gate", () => {
		for (const row of AUTH) {
			it(row.name, async () => {
				const { client } = row.flow.stub(row.routes);
				await expect(row.flow.ok(client, row.routes)).rejects.toBeInstanceOf(
					SiYuanAuthError,
				);
			});
		}
		for (const row of RATE_LIMIT) {
			it(`${row.name} — rate-limit`, async () => {
				const { client } = row.flow.stub(row.routes);
				await expect(row.flow.ok(client, row.routes)).rejects.toBeInstanceOf(
					SiYuanRateLimitError,
				);
			});
		}
	});
});
