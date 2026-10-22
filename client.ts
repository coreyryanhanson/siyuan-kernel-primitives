// Structural capability subsets over siyuan-kernel-api — what the
// primitives consume, no more. Tests stub these; no endpoint is re-wrapped.
// The capability splits (SQL, child-block reads, search, the live-tree
// hpath, the shared block delete) are the narrow pieces each primitive
// declares; KernelReadClient is the read composition, so a consumer holding
// the full read client satisfies every read subset — and the write entry's
// WriteKernelClient keeps the whole surface.

import type { BlockTransaction, Transaction } from "siyuan-kernel-api";

/** One row of the kernel's full-text search response — kernel field
 * names (`rootID`/`hPath`/`box`); consumers own any echo renames. */
export interface SearchBlockRow {
	id: string;
	rootID: string;
	box: string;
	hPath: string;
	updated: string;
}

/** SQL statement execution over the kernel's blocks index. */
export interface SqlClient {
	query(stmt: string): Promise<Record<string, unknown>[]>;
}

/** Child-block reads — the document-order walk's only endpoint. */
export interface ChildBlocksClient {
	getChildBlocks(id: string): Promise<Record<string, unknown>[]>;
}

/** Block deletion — consumed by the verified block delete (delete.ts). */
export interface DeleteBlockClient extends ChildBlocksClient {
	deleteBlock(id: string): Promise<BlockTransaction[]>;
}

/** The batched transaction route (`transact`) — the shared write
 * foundation of the batched sequences (each issues one transaction over a
 * pre-derived op array, then judges over fresh walks; batch.ts composes it
 * with the walk). The return is the kernel's post-commit echo: a
 * re-marshalled copy of the committed transactions — a hint, never
 * evidence (a rollback still acks success). */
export interface TransactClient {
	transact(transactions: Transaction[]): Promise<Transaction[]>;
}

/** Full-text search (per-box fan-out; search.ts owns the windowing). */
export interface SearchClient {
	fullTextSearch(params: {
		query: string;
		paths: string[];
		pageSize: number;
	}): Promise<{
		blocks: SearchBlockRow[];
		matchedBlockCount: number;
	}>;
}

/** Live-tree hpath resolution (hPathByID; the doc-move judgment rides it
 * instead of the SQL index's lagging blocks.hpath). */
export interface HPathClient {
	getHPathByID(id: string): Promise<string>;
}

/** The full read surface — the capability subsets composed. */
export type KernelReadClient = SqlClient &
	ChildBlocksClient &
	SearchClient &
	HPathClient;
