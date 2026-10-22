// Shared stub and fixtures for the section-move sequence's suites:
// moveSection.test.ts owns the sequence's own semantics (the group refusals'
// zero-call posture, the codec's op array, the landed judgment's arms over
// real walked post states, the walk partition), ladder.test.ts rides the
// same stub in the shared failure-ladder corpus, and move.test.ts's
// `moveVerified` suite drives the dispatch entry's both routes over it.
// The stub builds on `writeStub.ts`'s `stubClient` — the shared calls
// record, error routes, and empty echo — and mutates the tree through its
// `onMove`/`onTransact` hooks. The tree mutates exactly like the kernel's
// raw move ops — insert immediately before `nextID` (as its previous
// sibling), immediately after `previousID`, or prepended under `parentID`
// — and the walks are derived by the real `walkBlockTree`, so fixture and
// walk cannot drift apart.

import type { TransactionOperation } from "siyuan-kernel-api";
import type { MoveVerifiedKernelClient } from "../move.js";
import { walkBlockTree, type WalkedTree } from "../walk.js";
import { stubClient } from "./writeStub.js";
import { row, type Tree } from "./sectionStub.js";

export { row };
export type { Tree };

export interface MoveSectionRoutes {
	/** parentId → child rows; the walk reads this, the transaction's and
	 * the per-id route's move ops reposition rows inside it. */
	tree: Tree;
	/** Ack the transaction without applying it — the silent whole-batch
	 * rollback behind HTTP success (the `nothing-moved` arm's input). */
	rollback?: boolean | undefined;
	/** Throw to fail the transaction call (the mutation-phase
	 * classification rows). */
	transactError?: Error | undefined;
	/** Throw to fail a per-id `moveBlock` call (the per-id route's
	 * mutation-phase classification rows). */
	moveError?: Error | undefined;
	/** Throw to fail the post-write walk of the named root id — the root
	 * call of that doc's walk, so the whole walk fails (the walk-failed
	 * arm's input). */
	walkErrorFor?: ((rootId: string) => Error | undefined) | undefined;
}

export function moveSectionStub(routes: MoveSectionRoutes): {
	/** The composite client: the section sequence's subset plus the per-id
	 * endpoints, so the same stub serves the dispatch entry's both routes
	 * (move.test.ts's `moveVerified` suite). `moveBlock` applies the same
	 * tree semantics — per-id honours `previousID`/`parentID` only, the
	 * exact branch split `applyMove` already encodes. */
	client: MoveVerifiedKernelClient;
	/** The ops the transaction carried, in issue order — recorded even on
	 * a rollback ack (the batch carried them either way). */
	issued: TransactionOperation[];
	calls: { method: string; args: unknown }[];
} {
	const tree = routes.tree;
	const issued: TransactionOperation[] = [];
	const parentOf = (): Map<string, string> => {
		const map = new Map<string, string>();
		for (const [parent, rows] of Object.entries(tree)) {
			for (const r of rows) map.set(String(r.id), parent);
		}
		return map;
	};
	const takeRow = (id: string): Record<string, unknown> | undefined => {
		const parent = parentOf().get(id);
		if (parent === undefined) return undefined;
		const siblings = tree[parent] ?? [];
		const idx = siblings.findIndex((r) => String(r.id) === id);
		if (idx < 0) return undefined;
		return siblings.splice(idx, 1)[0];
	};
	// The op shape stays loose so both a transaction op and a moveBlock
	// param feed the same kernel move semantics without re-spreading.
	const applyMove = (op: {
		action?: unknown;
		id?: unknown;
		nextID?: unknown;
		previousID?: unknown;
		parentID?: unknown;
	}): void => {
		const nextID = typeof op.nextID === "string" ? op.nextID : "";
		const previousID = typeof op.previousID === "string" ? op.previousID : "";
		const parentID = typeof op.parentID === "string" ? op.parentID : "";
		if (nextID === "" && previousID === "" && parentID === "") {
			// The kernel rolls the batch back behind code 0 for an
			// anchorless op — the codec never issues one; fail loud rather
			// than simulate a lie.
			throw new Error("stub: anchorless move op");
		}
		if (
			(nextID !== "" && nextID === String(op.id)) ||
			(previousID !== "" && previousID === String(op.id))
		) {
			// The kernel skips a self-anchoring op (rolling the batch back
			// whole) — the group refusals derive every anchor outside the moved
			// set; fail loud rather than silently drop the block.
			throw new Error("stub: self-anchoring move op");
		}
		const moved = takeRow(String(op.id));
		if (moved === undefined) return;
		const parents = parentOf();
		if (nextID !== "") {
			const anchorParent = parents.get(nextID);
			if (anchorParent === undefined) return;
			const siblings = tree[anchorParent] ?? (tree[anchorParent] = []);
			const idx = siblings.findIndex((r) => String(r.id) === nextID);
			siblings.splice(idx < 0 ? siblings.length : idx, 0, moved);
		} else if (previousID !== "") {
			const anchorParent = parents.get(previousID);
			if (anchorParent === undefined) return;
			const siblings = tree[anchorParent] ?? (tree[anchorParent] = []);
			const idx = siblings.findIndex((r) => String(r.id) === previousID);
			siblings.splice(idx < 0 ? 0 : idx + 1, 0, moved);
		} else {
			const siblings = tree[parentID] ?? (tree[parentID] = []);
			siblings.unshift(moved);
		}
	};
	// The composite client rides `stubClient` — the shared calls record,
	// error routes, and empty echo; the hooks apply the kernel's real
	// move semantics.
	const { client, calls } = stubClient({
		moveError: routes.moveError,
		transactError: routes.transactError,
		getChildBlocks: (id) => {
			const walkErr = routes.walkErrorFor?.(id);
			if (walkErr) throw walkErr;
			return tree[id] ?? [];
		},
		onMove: applyMove,
		onTransact: (transactions) => {
			for (const tx of transactions) {
				for (const op of tx.doOperations) {
					issued.push(op);
					if (routes.rollback) continue;
					applyMove(op);
				}
			}
		},
	});
	return { client, issued, calls };
}

/** The strict pre-mutation walk over a fixture tree, derived by the real
 * `walkBlockTree` over a throwaway stub — the derivation stays off the
 * test's own calls record, and tree and walk cannot share a bug (the
 * sectionStub convention). */
export async function preWalk(tree: Tree, rootId: string): Promise<WalkedTree> {
	const { client } = moveSectionStub({ tree });
	return walkBlockTree(client, rootId);
}

// ---------------------------------------------------------------- fixture

export const SRC = "d-src";
export const DST = "d-dst";

/** The fixture, both docs: source
 * `# S / s0 / ## H / m1 / m2 / ### H2 / sub1 / m3 / ## T / t1` (H's run:
 * m1, m2, H2, sub1, m3 — the subsection heading and its body are run-level
 * siblings, each issued its own op), destination
 * `# D / d1 / ## B / b1 / ## Z / z1` (B's section: [b1], boundary Z — the
 * boundary arm's canonical shape). */
export function sectionTree(): Tree {
	return {
		[SRC]: [
			row("s0", "h", "h1"),
			row("H", "h", "h2"),
			row("m1"),
			row("m2"),
			row("H2", "h", "h3"),
			row("sub1"),
			row("m3"),
			row("T", "h", "h2"),
			row("t1"),
		],
		[DST]: [
			row("d1", "h", "h1"),
			row("B", "h", "h2"),
			row("b1"),
			row("Z", "h", "h2"),
			row("z1"),
		],
	};
}

/** H's enumerated member run, document order. */
export const MEMBER_IDS = ["m1", "m2", "H2", "sub1", "m3"];
/** The judged set in issued order — members first, the heading last. */
export const MOVED_IDS = [...MEMBER_IDS, "H"];
/** The correct landing: the run at the end of B's section, the
 * boundary still bounding after it. */
export const LANDED_DST = [
	"d1",
	"B",
	"b1",
	"H",
	"m1",
	"m2",
	"H2",
	"sub1",
	"m3",
	"Z",
	"z1",
];
