// Shared stubs for the verified-mutation flow tests: the WriteKernelClient
// stub keyed on route map, the mutable block tree behind the delete-family
// stubs, the probe literals, and the test control point that collapses the
// convergence window.
//
// Which stub a flow test reaches for: flows whose verification is
// assertion-driven (create / edit / insert / replace) build on
// `stubClient` alone, whose routes are inert about the tree; the section
// move's stub builds on the same `stubClient` and mutates the tree on
// `onMove`/`onTransact` (its `applyMove`); flows whose judgment reads a
// post-mutation walk (the verified deletes) seed the same `stubClient`
// routes from `mutableTree`, which mutates on deleteBlock so the walked
// evidence reflects the mutation.
import type { BlockTransaction, Transaction } from "siyuan-kernel-api";
import { withVerifyWindow } from "../convergence.js";
import type { TransactClient } from "../client.js";
import type { DeleteKernelClient } from "../delete.js";
import { statementKind } from "../testing.js";
import { sqlString } from "../sql.js";
import type { KernelProbeResult } from "../version.js";
import type { WalkedBlock } from "../walk.js";
import type { WriteKernelClient } from "../write.js";

export const okProbe: KernelProbeResult = {
	verdict: "ok",
	kernelVersion: "3.8.8",
};
export const driftProbe: KernelProbeResult = {
	verdict: "drift",
	kernelVersion: "3.9.0",
};

export interface StubRoutes {
	query?: (stmt: string) => Record<string, unknown>[];
	queryError?: Error;
	createError?: Error;
	updateError?: Error;
	onCreate?: () => void;
	getChildBlocks?: (id: string) => Record<string, unknown>[];
	moveError?: Error | undefined;
	moveDocsError?: Error;
	insertError?: Error;
	appendError?: Error;
	deleteError?: Error;
	onInsert?: () => void;
	onDelete?: (id: string) => void;
	removeDocError?: Error;
	onRemoveDoc?: (id: string) => void;
	/** Hook invoked on every updateBlock — editStub uses it to converge
	 * the tree row the kernel's synchronous write would move. */
	onUpdate?: (params: { id: string; data: string }) => void;
	/** Hook invoked on every successful moveBlock — the section-move stub
	 * uses it to apply the kernel's move semantics to the tree. */
	onMove?: (params: {
		id: string;
		previousID?: string;
		parentID?: string;
	}) => void;
	getHPathByID?: (id: string) => string;
	transactError?: Error | undefined;
	onTransact?: (transactions: Transaction[]) => void;
}

/** A mutable block tree: a successful deleteBlock prunes the id from its
 * parent the way the kernel's success does (the section batch's cascade is
 * the same op), so a post-mutation `getChildBlocks` walk reads the mutated
 * shape. `prune` returning false simulates HTTP success behind a silent
 * no-op. */
function mutableTree(
	tree: Record<string, Record<string, unknown>[]>,
	prune?: (id: string) => boolean,
): (id: string) => void {
	const parentOf = new Map<string, string>();
	for (const [parent, rows] of Object.entries(tree)) {
		for (const row of rows) parentOf.set(String(row.id), parent);
	}
	return (id) => {
		if (!(prune?.(id) ?? true)) return;
		const key = parentOf.get(id) ?? "";
		const siblings = tree[key];
		if (siblings) {
			tree[key] = siblings.filter((row) => String(row.id) !== id);
		}
	};
}

export function stubClient(routes: StubRoutes = {}): {
	client: WriteKernelClient;
	calls: { method: string; args: unknown }[];
} {
	const calls: { method: string; args: unknown }[] = [];
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => "3.8.8",
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (routes.queryError) throw routes.queryError;
			return routes.query ? routes.query(stmt) : [];
		},
		fullTextSearch: async () => {
			throw new Error("write primitives never search");
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			return routes.getChildBlocks ? routes.getChildBlocks(id) : [];
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			routes.onCreate?.();
			if (routes.createError) throw routes.createError;
			return "d-new";
		},
		async updateBlock(params) {
			calls.push({ method: "updateBlock", args: params });
			routes.onUpdate?.(params);
			if (routes.updateError) throw routes.updateError;
		},
		async insertBlock(params) {
			calls.push({ method: "insertBlock", args: params });
			routes.onInsert?.();
			if (routes.insertError) throw routes.insertError;
			return [{ doOperations: [{ id: "b-new" }] }];
		},
		async appendBlock(params) {
			calls.push({ method: "appendBlock", args: params });
			if (routes.appendError) throw routes.appendError;
			return [{ doOperations: [{ id: "b-new" }] }];
		},
		async deleteBlock(id) {
			calls.push({ method: "deleteBlock", args: id });
			routes.onDelete?.(id);
			if (routes.deleteError) throw routes.deleteError;
			return [{ doOperations: [{ id }] }];
		},
		async removeDocByID(id) {
			calls.push({ method: "removeDocByID", args: id });
			routes.onRemoveDoc?.(id);
			if (routes.removeDocError) throw routes.removeDocError;
			return null;
		},
		async moveBlock(params) {
			calls.push({ method: "moveBlock", args: params });
			if (routes.moveError) throw routes.moveError;
			routes.onMove?.(params);
			return null;
		},
		async moveDocsByID(params) {
			calls.push({ method: "moveDocsByID", args: params });
			if (routes.moveDocsError) throw routes.moveDocsError;
			return null;
		},
		async transact(transactions) {
			calls.push({ method: "transact", args: transactions });
			if (routes.transactError) throw routes.transactError;
			routes.onTransact?.(transactions);
			// The kernel's echo is a hint, never evidence — the stub serves an
			// empty one (nothing consumes it).
			return [];
		},
		getHPathByID: async (id) => {
			calls.push({ method: "getHPathByID", args: id });
			return routes.getHPathByID?.(id) ?? "/doc";
		},
	};
	return { client, calls };
}

// The test control point: run a flow with the convergence window collapsed
// to a single immediate attempt, so the exhaustion judgments resolve
// instantly. The swap rides the primitives' own `withVerifyWindow` seam —
// restore is structural (finally), so no per-file afterEach bookkeeping and
// no cross-package in-place mutation of a production table.
export function collapseWindow<T>(fn: () => Promise<T>): Promise<T> {
	return withVerifyWindow([0], fn);
}

export const txFor = (id: string): BlockTransaction[] => [
	{ doOperations: [{ id }] },
];

export const walked = (id: string): WalkedBlock => ({
	id,
	type: "p",
	subType: "",
	content: "",
	markdown: "",
	parentId: "doc",
	parentType: "d",
});

/** The blocks-index rows the membership reads route on, derived from the
 * same fixture tree the walk reads (each key is a doc root) — fixture and
 * membership index cannot drift apart. */
export function blockRowsOf(
	tree: Record<string, Record<string, unknown>[]>,
): Record<string, unknown>[] {
	return Object.entries(tree).flatMap(([rootId, rows]) =>
		rows.map((r) => ({
			id: r.id,
			content: r.content,
			root_id: rootId,
			type: r.type,
		})),
	);
}

export interface DeleteRoutes {
	/** parentId → child rows; the walk reads this, deleteBlock prunes it. */
	tree: Record<string, Record<string, unknown>[]>;
	/** The blocks-index rows the membership read routes on. Derived from
	 * the tree by default (each key is a doc root); an explicit array
	 * replaces it — [] reads the target absent (the fall-through). */
	blockRows?: Record<string, unknown>[] | undefined;
	/** Default: prune the block from its parent (the kernel's success).
	 * Return false to simulate an acked delete that left the block in
	 * place — the judgment must answer still-present, never gone. */
	prune?: ((id: string) => boolean) | undefined;
	/** Throw to fail the mutation (deleteBlock / removeDocByID). A per-id
	 * predicate returns the error for the id that must fail — the delete
	 * stops at that id; every other id deletes cleanly. For the
	 * batched route (`transact`), the throw models the failed transaction
	 * call — nothing has landed either way. */
	deleteError?: Error | ((id: string) => Error | undefined) | undefined;
	/** Throw to fail the post-delete walk (verification leg), or the doc
	 * path's pre-delete walk (propagates raw). */
	walkError?: Error | undefined;
	/** Throw to fail a SQL read (the scoping read propagates raw —
	 * nothing is in flight). */
	queryError?: Error | undefined;
	/** Throw to fail the batched transaction route — nothing has landed
	 * either way (the batch is whole). */
	transactError?: Error | undefined;
}

/** The index-row router both SQL-consuming stubs share — routes on
 * `statementKind` (statement identity, never text), answering the
 * `block-in-doc` scoping read and the fresh guard's `block-contents`
 * seed read from the same rows, keyed by the id(s) in the statement. */
function indexRowsQuery(
	blockRows: Record<string, unknown>[],
	routes: { queryError?: Error | undefined },
): (stmt: string) => Record<string, unknown>[] {
	return (stmt) => {
		if (routes.queryError) throw routes.queryError;
		const kind = statementKind(stmt);
		if (kind === "block-in-doc" || kind === "block-contents") {
			return blockRows.filter((r) => stmt.includes(sqlString(String(r.id))));
		}
		return [];
	};
}

/** The delete flows' stub: the shared WriteKernelClient stub seeded from a
 * mutable tree — the walk route answers from the tree, the mutation route
 * prunes it the way the kernel's success (or its cascade) does. `deleted`
 * records the ids deleteBlock acked, in issue order — the issued sequence
 * the ordering assertions read. */
export function deleteStub(routes: DeleteRoutes): {
	client: DeleteKernelClient & TransactClient;
	deleted: string[];
	batched: string[];
	calls: { method: string; args: unknown }[];
} {
	const deleteFromTree = mutableTree(routes.tree, routes.prune);
	const blockRows = routes.blockRows ?? blockRowsOf(routes.tree);
	const deleted: string[] = [];
	const batched: string[] = [];
	const deleteErr = (id: string): Error | undefined =>
		typeof routes.deleteError === "function"
			? routes.deleteError(id)
			: routes.deleteError;
	const { client, calls } = stubClient({
		query: indexRowsQuery(blockRows, routes),
		getChildBlocks: (id) => {
			if (routes.walkError) throw routes.walkError;
			return routes.tree[id] ?? [];
		},
		onDelete: (id) => {
			const err = deleteErr(id);
			if (err) throw err;
			deleteFromTree(id);
			deleted.push(id);
		},
		transactError: routes.transactError,
		onRemoveDoc: (id) => {
			const err = deleteErr(id);
			if (err) throw err;
		},
		onTransact: (transactions) => {
			// The batch lands whole (the commit-wait fact): every op prunes
			// its id, `prune` returning false simulating the sub-cliff silent
			// no-op — acked but the block stays (the survivor arm's input).
			for (const tx of transactions) {
				for (const op of tx.doOperations) {
					const id = String(op.id);
					batched.push(id);
					if (routes.prune?.(id) ?? true) deleteFromTree(id);
				}
			}
		},
	});
	return { client, deleted, batched, calls };
}

export interface EditRoutes {
	/** parentId → child rows; the walk reads this, updateBlock converges
	 * the target's row through `onUpdate` — the kernel's synchronous tree
	 * write. */
	tree: Record<string, Record<string, unknown>[]>;
	/** The blocks-index rows the membership read routes on. Derived from
	 * the tree by default (each key is a doc root); an explicit array
	 * replaces it. */
	blockRows?: Record<string, unknown>[] | undefined;
	/** Converge the tree: mutate the EXACT row object the stub hands you
	 * (subtype / markdown / content) — the kernel's synchronous `.sy`
	 * write, never a re-derivation of the block's form. A throw models
	 * the kernel's synchronous rejection; arming `walkError` here fails
	 * only the post-mutation walk (the verification-phase classifier
	 * cases — the fresh guard's pre-write walk has already succeeded). */
	onUpdate?: (
		row: Record<string, unknown>,
		params: { id: string; data: string },
	) => void;
	/** Throw to fail the mutation. */
	updateError?: Error | undefined;
	/** Throw to fail a SQL read (the edit's absent-target diagnosis
	 * read — propagates raw, nothing is in flight). */
	queryError?: Error | undefined;
	/** Throw to fail a walk read — post-mutation for the classifier
	 * cases (arm it inside `onUpdate`), pre-mutation only when the case
	 * means the fresh guard's walk itself to fail. */
	walkError?: Error | undefined;
}

/** The edit flows' stub: the shared WriteKernelClient stub seeded from a
 * tree — the walk route reads it, and updateBlock converges the exact
 * tree row through `onUpdate` (the deleteStub pattern, mutation side).
 * The stub never parses markdown or heading levels — the hook applies
 * the stored form, so a movement case passes only if the judgment reads
 * the moved fields off the walk. */
export function editStub(routes: EditRoutes): {
	client: WriteKernelClient;
	calls: { method: string; args: unknown }[];
} {
	const blockRows = routes.blockRows ?? blockRowsOf(routes.tree);
	const { client, calls } = stubClient({
		query: indexRowsQuery(blockRows, routes),
		getChildBlocks: (id) => {
			if (routes.walkError) throw routes.walkError;
			return routes.tree[id] ?? [];
		},
		onUpdate: (params) => {
			for (const rows of Object.values(routes.tree)) {
				const row = rows.find((r) => String(r.id) === params.id);
				if (row !== undefined) {
					routes.onUpdate?.(row, params);
					return;
				}
			}
			// A row the tree does not hold (the walk-invisible `d` root) acks
			// with no tree change — the destructive-wipe shape is not modeled;
			// its targets refuse pre-mutation and never reach the stub.
		},
		...(routes.updateError !== undefined && {
			updateError: routes.updateError,
		}),
	});
	return { client, calls };
}
