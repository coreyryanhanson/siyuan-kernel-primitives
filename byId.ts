// By-ID reads over the pinned block-row shape (type-'d' doc rows
// resolvable by id, doc titles verbatim in `blocks.content`, `root_id`
// the doc-membership check) plus the row-shape-adjacent report reads the
// same consumers need (`hPathByID` over the live-tree hpath endpoint,
// `firstChildContent` over child blocks). Report-only reads: the
// `scopingRefusalOf` / `foreignRefusalOf` beside their `ScopingRefusal` /
// `ForeignRefusal` arms likewise report the refusal shape the write flows
// compose — the refuse/no-refuse policy is always the caller's. The
// refs-graph read (`backlinkCheck`) lives in `./refs.js`.

import type { ChildBlocksClient, HPathClient, SqlClient } from "./client.js";
import { sqlString } from "./sql.js";
import { STMT_HEADS } from "./stmtKind.js";
import type { WalkedTree } from "./walk.js";

/** Ownership query: resolves the docId's root within a KB's notebook —
 * the `box` leg is the scoping fact (an id from another KB's notebook
 * matches no row, whatever the block tree holds). Whether a no-row
 * outcome is an error is the consumer's policy, never this file's. */
export function ownershipStmt(boxId: string, targetId: string): string {
	return (
		`${STMT_HEADS.ownership} = ${sqlString(targetId)}` +
		` AND box = ${sqlString(boxId)}`
	);
}

/** Outcome of the block-in-doc membership read, as a closed union:
 * - `in-doc` — the block's current stored row (delete receipts and the
 *   edit's `absent-target` diagnosis consume this payload)
 * - `absent` — the id matches no indexed row
 * - `doc-id` — the id names a document, not a block (its content is the
 *   title; doc ids never target block-level ops)
 * - `foreign` — the block exists but its `root_id` is not the requested
 *   doc (cross-doc or cross-KB) */
export type BlockInDocResult =
	| { kind: "in-doc"; content: string; type: string }
	| { kind: "absent" }
	| { kind: "doc-id" }
	| { kind: "foreign"; rootId: string };

/** The target read shared by the blockId-targeting consumers — the
 * block's current content and type, or its absence/foreign outcome.
 * This read judges MEMBERSHIP. Absence is never refused here: each
 * consumer's own design governs what absence does. A block that EXISTS
 * but belongs to a different doc is reported as `foreign`: the kernel
 * mutates by raw id with no doc scoping of its own, so forwarding it
 * would write outside the targeted doc, past the grant and the
 * fresh-content baseline (the SQL cannot distinguish foreign from
 * absent — the code compare can). */
export async function blockInDoc(
	client: SqlClient,
	rootId: string,
	blockId: string,
): Promise<BlockInDocResult> {
	const rows = await client.query(
		`${STMT_HEADS["block-in-doc"]} = ${sqlString(blockId)}`,
	);
	if (rows[0] === undefined) return { kind: "absent" };
	// A document row's content is its title, not a body — an id confusion
	// here would rename the doc and verify against the title hash. Doc ids
	// never target block-level ops.
	if (String(rows[0].type ?? "") === "d") return { kind: "doc-id" };
	const rowRootId = String(rows[0].root_id ?? "");
	return rowRootId === rootId
		? {
				kind: "in-doc",
				content: String(rows[0].content),
				type: String(rows[0].type ?? ""),
			}
		: { kind: "foreign", rootId: rowRootId };
}

/** The block-scoping refusal arms — the `foreign`/`doc-id` outcomes the
 * blockId-targeting write flows refuse pre-mutation, composed into their
 * outcome unions so the two arm shapes are declared once (a new field
 * lands here or fails typecheck, never silently diverges between flows).
 * `doc-id` carries no root: a doc id has no other doc to name. The
 * `foreign` arm's own name is `ForeignRefusal` — the section-shaped flows'
 * provenance refusal composes it directly. */
export type ScopingRefusal =
	| { kind: "foreign"; blockId: string; rootId: string }
	| { kind: "doc-id"; blockId: string };

/** The `foreign` arm alone, named once: the caller-provenance refusal the
 * section-shaped write flows compose into their outcome unions (the walk's
 * own root id vs the claimed root). The alias keeps the arm single-homed
 * across every union that carries it. */
export type ForeignRefusal = Extract<ScopingRefusal, { kind: "foreign" }>;

/** The refusal projection over a membership result the flow already
 * holds — `undefined` is every non-refusing kind (`in-doc` proceeds;
 * `absent` falls through — each consumer's own design governs what
 * absence does, see `blockInDoc`). Pure: no kernel call. */
export function scopingRefusalOf(
	membership: BlockInDocResult,
	blockId: string,
): ScopingRefusal | undefined {
	switch (membership.kind) {
		case "in-doc":
		case "absent":
			return undefined;
		case "foreign":
			return { kind: "foreign", blockId, rootId: membership.rootId };
		case "doc-id":
			return { kind: "doc-id", blockId };
	}
	membership satisfies never;
	return undefined;
}

/** The caller-provenance gate: `undefined` when the held walk is
 * `claimedRoot`'s tree, the `ForeignRefusal` arm otherwise. Single-homed
 * beside the arm so the flows cannot restate the gate and a future one
 * cannot silently omit the provenance check — the kernel mutates by raw
 * block id with no doc scoping of its own, so a foreign walk's derived ids
 * would be destroyed in the other doc behind a clean receipt, a mismatch
 * undetectable post-hoc. */
export function foreignRefusalOf(
	walk: WalkedTree,
	claimedRoot: string,
	blockId: string,
): ForeignRefusal | undefined {
	if (walk.rootId === claimedRoot) return undefined;
	return { kind: "foreign", blockId, rootId: walk.rootId };
}

/** Stored content for a set of block ids — the batch form of
 * `blockInDoc`'s read (no root_id, no membership judgment): each returned
 * row is the raw `{id, content}` pair the index holds. Absent ids are
 * simply missing from the result; scoping, freshness, and baseline policy
 * are the consumer's, never this file's. */
export async function blockContents(
	client: SqlClient,
	ids: string[],
): Promise<{ id: string; content: string }[]> {
	if (ids.length === 0) return [];
	// The explicit outer LIMIT opts out of the kernel's statement row cap
	// (statements without their own LIMIT cap at Conf.Search.Limit, and
	// the truncation is reported only at the envelope top level, which
	// the client drops): one row per id makes the id count the exact
	// bound.
	const rows = await client.query(
		`${STMT_HEADS["block-contents"]} (${ids.map(sqlString).join(", ")})` +
			` LIMIT ${ids.length}`,
	);
	return rows.map((r) => ({ id: String(r.id), content: String(r.content) }));
}

/** First child block's content of a parent id (near-match enrichment's
 * excerpt read), in document order — the walk's order premise on one
 * shallow call: `getChildBlocks` returns the parent's children in
 * document order, so the first element is the
 * doc's first block. Kernel failures rethrow verbatim — the swallow
 * policy is the caller's. */
export async function firstChildContent(
	client: ChildBlocksClient,
	parentId: string,
): Promise<string | undefined> {
	const children = await client.getChildBlocks(parentId);
	const first = children[0];
	return first === undefined ? undefined : String(first.content ?? "");
}

export interface RootEchoRow {
	docId: string;
	title: string;
	hpath: string;
}

/** Root row echo: the doc's stored title and real hpath by id — the
 * doc-level sibling of `blockInDoc`. `undefined` is the whole story for a
 * missing row; no verdict union. */
export async function rootEcho(
	client: SqlClient,
	boxId: string,
	docId: string,
): Promise<RootEchoRow | undefined> {
	const rows = await client.query(
		`${STMT_HEADS["root-echo"]} ` +
			`WHERE box = ${sqlString(boxId)} ` +
			`AND id = ${sqlString(docId)} AND type = 'd'`,
	);
	const row = rows[0];
	return row === undefined
		? undefined
		: {
				docId: String(row.root_id),
				title: String(row.content),
				hpath: String(row.hpath),
			};
}

/** The containing doc's root id for an id within a KB's notebook — the
 * consumer-side doc-target resolution read (`ownershipStmt`): a block id
 * exports its containing doc, a doc id is its own root. `undefined` is
 * the whole story for a no-row outcome (id absent, foreign KB, or type
 * mismatch) — the row shape is the consumer's refusal policy, never
 * this file's. */
export async function ownership(
	client: SqlClient,
	boxId: string,
	targetId: string,
): Promise<string | undefined> {
	const rows = await client.query(ownershipStmt(boxId, targetId));
	const row = rows[0];
	return row === undefined ? undefined : String(row.root_id);
}

/** Live-tree hpath of the block id's containing doc — `getHPathByID`
 * verbatim. Synchronous ground truth where the blocks index lags
 * (post-move, post-rename). Any block id resolves to its containing
 * doc's hpath; the box-doc feature's virtual doc returns "/" — a
 * doc-move judgment must not be handed one as a destination root (it is
 * the virtual doc itself, not an address into a tree). Kernel errors
 * propagate verbatim. */
export async function hPathByID(
	client: HPathClient,
	id: string,
): Promise<string> {
	return client.getHPathByID(id);
}
