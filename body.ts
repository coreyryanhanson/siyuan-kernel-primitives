// The body read: the doc body served from the walk field's rendering, not
// the export endpoint — the export path synthesizes doc-level YFM, so a
// write-back from it corrupts the doc; the walk field renders each
// top-level child's whole subtree fresh from the live tree, so the body
// is the children's markdown joined with blank lines. One joiner and one
// omitted-empty policy serve both entry points: `docBody`, the standalone
// one-call stitch, and `readDoc`, the unified walk+body read. Report-only:
// no refusal — the consumer owns scoping and wording. The full rendering
// posture (refs/embeds form, IAL handling) is falsified live in
// __tests__/live/body.live.test.ts.

import type { ChildBlocksClient } from "./client.js";
import {
	siblingRunOf,
	walkBlockTree,
	type WalkedBlock,
	type WalkedTree,
} from "./walk.js";

/** One row of the body read's per-child evidence: the join's inputs with
 * the kernel's `type` field retained. Echo/targeting evidence — never a
 * baseline input (the fresh-content judgment hashes walk content, not a
 * markdown rendering, so baselines never seed from these bytes). */
export interface BodyChildRow {
	id: string;
	type: string;
	/** The walk field's markdown rendering of the child's whole subtree.
	 * Absent means a genuinely empty export (the field rides omitempty,
	 * and the renderer fatal-exits rather than returning a partial
	 * render): the body omits the block — no placeholder bytes to
	 * re-import — while the row keeps its place, so the omission is
	 * countable and never silent. */
	markdown?: string;
}

export interface DocBodyResult {
	/** The top-level children's markdown joined with blank lines between
	 * blocks and none trailing — one fixed rule. */
	body: string;
	/** The per-child rows the join consumed, in document order. */
	children: BodyChildRow[];
	/** How many of those rows the body omitted (absent markdown — see
	 * `BodyChildRow`): the omission policy's countable half, served with
	 * the body so no consumer re-derives the omitempty arm. */
	omittedEmpty: number;
}

/** Projection of a row to the join's row shape — served by both entry
 * points over their own row source (the standalone call's raw wire row,
 * the unified read's walk row). Presence is judged on the field's
 * existence — the walk markdown's presence rule (`WalkedBlock.markdown`):
 * present values are carried verbatim. */
function childRowOf(raw: Record<string, unknown> | WalkedBlock): BodyChildRow {
	const row: BodyChildRow = {
		id: String(raw.id),
		type: String(raw.type ?? ""),
	};
	if (raw.markdown !== undefined && raw.markdown !== null)
		row.markdown = String(raw.markdown);
	return row;
}

/** The one join policy, both entry points: present markdown fields joined
 * with a blank line between blocks and none trailing; absent fields omit
 * the row's bytes but never the row (see `BodyChildRow`). One pass serves
 * both halves of the policy — the joined body and the omission count. */
function bodyOf(rows: readonly BodyChildRow[]): {
	body: string;
	omittedEmpty: number;
} {
	const parts: string[] = [];
	let omittedEmpty = 0;
	for (const row of rows) {
		if (row.markdown === undefined) omittedEmpty += 1;
		else parts.push(row.markdown);
	}
	return { body: parts.join("\n\n"), omittedEmpty };
}

/** The standalone one-call stitch: one `getChildBlocks` call over
 * whatever id it is given — a doc root yields the full body, another
 * container id yields that container's children, a heading id yields its
 * section (the kernel maps a heading to HeadingChildren), and a valid
 * leaf id hits the kernel's `!IsContainerBlock` arm — an empty child
 * list, so it answers an empty body with an empty `children` array and
 * code 0 (an empty doc answers the same empty body but keeps its one
 * empty-paragraph child's row); doc-ness/existence guards stay the
 * caller's — the response carries no parent marker to refuse on, and a
 * read cannot corrupt anything. Kernel errors propagate verbatim, except
 * the kernel answers a failed tree load with an empty child list behind
 * code 0 — an empty body is not a proof of an empty doc; the swallow
 * policy is the caller's. */
export async function docBody(
	kernel: ChildBlocksClient,
	id: string,
): Promise<DocBodyResult> {
	const children = (await kernel.getChildBlocks(id)).map(childRowOf);
	const { body, omittedEmpty } = bodyOf(children);
	return { body, children, omittedEmpty };
}

export interface ReadDocResult extends WalkedTree, DocBodyResult {}

/** The unified walk+body read: one `getChildBlocks` call serves the
 * body and the walk's depth-1 rows from one tree snapshot; the walk's
 * deeper frames are later reads. The root call runs strict
 * (`"belowRoot"` tolerance) — a vanished root propagates, and because
 * the top-level `markdown` renders whole from the root call's snapshot
 * before any recursion, the walk's mid-walk tolerance has no arm that
 * can shorten served body bytes. `docId` is a caller contract — a
 * non-doc id makes the walk half's `parentId: null, type "d"` claims
 * false (`docBody` is the any-id entry). */
export async function readDoc(
	kernel: ChildBlocksClient,
	docId: string,
): Promise<ReadDocResult> {
	const walk = await walkBlockTree(kernel, docId, {
		tolerateVanished: "belowRoot",
	});
	// The depth-1 rows are the walk's own document-root sibling run, so
	// the projection is the walk's — no raw-wire side channel.
	const children = siblingRunOf(walk.blocks, null).map(childRowOf);
	const { body, omittedEmpty } = bodyOf(children);
	return { ...walk, body, children, omittedEmpty };
}
