// getChildBlocks walk — never SQL enumeration
// (the `sort` column is a type weight, not document order). Shared by the
// read tools and the write-verification evidence.
// The heading judgments live in `./heading.js`; the kernel container
// vocabulary in `./containers.js`. This module is the walk and its
// recursion policy.

import { SiYuanApiError } from "siyuan-kernel-api";
import { KERNEL_CONTAINER_TYPES } from "./containers.js";
import type { ChildBlocksClient } from "./client.js";

/** Extension-owned recursion bound for the getChildBlocks walk — the kernel
 * imposes no cap on block-container nesting, so this keeps the walk finite
 * (the 7-level cap counts hpath separators, a different axis). */
export const MAX_WALK_DEPTH = 32;

/** The walk's product: the document-order blocks plus the completeness
 * facts. An incomplete walk's POSITIVE facts are sound — a block in
 * `blocks` is genuinely in the tree, and every seen block's parent chain
 * is complete (ancestors are always shallower than the bound). Its
 * ABSENCES are not: anything missing may sit past the bound or behind a
 * swallowed branch. Every judgment derived from a walk must therefore
 * treat `incomplete` as evidence — a negative answer (absent / gone /
 * vanished) over an incomplete walk is unconfirmed, never a confident
 * claim about the kernel. */
export interface WalkedTree {
	blocks: WalkedBlock[];
	/** The root id the walk was taken over — the doc-membership fact a
	 * caller-held walk would otherwise not carry: the caller/derivation
	 * mismatch check (`walk.rootId !== the claimed rootId`) compares this,
	 * not an index read. */
	rootId: string;
	/** True when recursion hit MAX_WALK_DEPTH and dropped the subtree past
	 * it. Deterministic (structural depth), so a retry cannot clear it. */
	truncated: boolean;
	/** True when the walk ended any branch early for ANY reason — the depth
	 * bound above, or a tolerated vanish (the kernel's code:-1 envelope for
	 * a vanished/locked id, read paths only). The one fact every negative
	 * judgment keys on: absences are unconfirmed whenever this is set,
	 * regardless of the cause. Always true when `truncated` is. */
	incomplete: boolean;
}

/** The shared truncation-refusal arm: the walk a projection derives from
 * is incomplete (the depth bound, or a tolerated vanish), so the
 * projection's negative/absence-shaped answer would be read off
 * incomplete evidence — it refuses instead. The positive answers that
 * survive incompleteness are narrow: `resolveHeadingTarget`'s found-heading
 * arm and the omitted-id doc-end anchors. The section and anchor
 * projections refuse unconditionally even when the heading itself is seen —
 * their answer carries `closure`, which bounds a section delete, and a
 * truncated tree cannot state that bound. */
export interface WalkTruncated {
	kind: "walk-truncated";
}

export interface WalkedBlock {
	id: string;
	type: string;
	subType: string;
	content: string;
	/** The block's stored markdown form (camelCase wire field),
	 * presence-preserving: the kernel's wire field rides omitempty (`json:
	 * "markdown,omitempty"`, model/block.go — `""` is never a present
	 * value), so `undefined` means exactly "the kernel's render was empty".
	 * Comparison consumers coalesce at the site (`?? ""` — absent and ""
	 * compare equal); the body read judges presence itself (an empty
	 * export omits the block's bytes, never the row). The fresh judgment's
	 * hash input stays walk `content`; the body read consumes the same
	 * field for its joined body (a level-only or checkbox-only edit
	 * moves `markdown`/`subType`, never `content`). */
	markdown?: string | undefined;
	/** Enclosing block's id — null for the document root's children. The
	 * exact ancestry fact: no consumer derives parentage from depth. */
	parentId: string | null;
	/** Enclosing block's type — "d" for the document root's children. */
	parentType: string | null;
}

interface NestedBlock extends WalkedBlock {
	children: NestedBlock[];
}

/** Wire block types whose getChildBlocks returns real tree children.
 * The vocabulary is the one kernel declaration in `./containers.js`
 * (`KERNEL_CONTAINER_TYPES` — the targetable set plus lute's `tabs`
 * wrapper; the endpoint's actual recursion gate is lute's ast-level
 * `IsContainerBlock`, model/block.go, not the locally readable
 * predicates).
 * The empty type — a block the kernel's abbreviation map does not name, e.g.
 * a footnote definition — nests too: the fail-safe direction.
 *
 * `"d"` stays in the recursion set even though a child doc is never a
 * block in its parent's tree under this pin: a `"d"` row inside a tree
 * would mean that premise broke, and recursing is the sound response —
 * excluding it would truncate that subtree silently with `incomplete`
 * unset.
 *
 * Heading (`h`) is deliberately absent even though the kernel answers a
 * heading with its SECTION (following siblings up to the next heading of
 * same-or-higher level): every one of those blocks is already returned by
 * the loop over the container that owns the heading, so recursing into `h`
 * re-emits them out of document order. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set(KERNEL_CONTAINER_TYPES);

function nests(type: string): boolean {
	return CONTAINER_TYPES.has(type) || type === "";
}

/** getChildBlocks walk preserving container structure: recursion follows
 * `nests` (the kernel's container types), so every block is visited exactly
 * once, in document order.
 *
 * Errors propagate — including SiYuanApiError (unknown/locked block id):
 * this walk is the post-write verification evidence, and a swallowed
 * error would read an empty walk as "target gone" behind HTTP success.
 * The read outline opts into tolerance: a container deleted concurrently
 * mid-kb_read shortens the outline instead of failing the read.
 *
 * Tolerance is judged per depth, not passed down as a flat flag: mode
 * `"belowRoot"` keeps the depth-1 root call strict (a vanished root
 * propagates) while every deeper branch tolerates exactly as the boolean
 * mode does — the seam the body read composes, whose soundness rests on
 * the root call alone. */
async function walkBlockTreeNested(
	kernel: ChildBlocksClient,
	rootId: string,
	depth: number,
	tolerateVanished: boolean | "belowRoot",
	parentId: string | null,
	parentType: string | null,
): Promise<{ nodes: NestedBlock[]; truncated: boolean; vanished: boolean }> {
	if (depth > MAX_WALK_DEPTH)
		return { nodes: [], truncated: true, vanished: false };
	let children: Record<string, unknown>[];
	try {
		children = await kernel.getChildBlocks(rootId);
	} catch (err) {
		const toleratedHere =
			tolerateVanished === "belowRoot" ? depth > 1 : tolerateVanished;
		// A vanished container mid-walk ends that branch, not the doc — but
		// only for the kernel's own envelope refusal: the kernel answers a
		// vanished/locked id with HTTP 200 and code -1 ("block not found or
		// its encrypted notebook is locked"). NOTE: that same 200/code:-1
		// envelope is also what the kernel returns for a malformed id
		// ("invalid ID argument", util.InvalidIDPattern) — so with
		// tolerateVanished, any code:-1 outcome ends the branch silently,
		// and id validation stays the caller's job. Any other SiYuanApiError — a
		// 5xx, an unparseable body — is a kernel/transport failure and must
		// fail the read, not silently truncate it. (Auth/rate-limit are
		// siblings of SiYuanApiError, never subclasses — the instanceof arm
		// already lets them propagate; network/timeout are not
		// SiYuanApiErrors at all.)
		if (
			!toleratedHere ||
			!(err instanceof SiYuanApiError) ||
			err.status !== 200 ||
			err.code !== -1
		) {
			throw err;
		}
		return { nodes: [], truncated: false, vanished: true };
	}
	const nodes: NestedBlock[] = [];
	let truncated = false;
	let vanished = false;
	for (const child of children) {
		const node: NestedBlock = {
			id: String(child.id),
			type: String(child.type ?? ""),
			subType: String(child.subType ?? ""),
			content: String(child.content ?? ""),
			// Presence-preserving: the wire field rides omitempty, so both
			// undefined and null mean the render was empty — never coalesce
			// here; the consumers that compare coalesce at their site.
			markdown:
				child.markdown === undefined || child.markdown === null
					? undefined
					: String(child.markdown),
			parentId,
			parentType,
			children: [],
		};
		if (nests(node.type)) {
			const nested = await walkBlockTreeNested(
				kernel,
				node.id,
				depth + 1,
				tolerateVanished,
				node.id,
				node.type,
			);
			node.children = nested.nodes;
			truncated ||= nested.truncated;
			vanished ||= nested.vanished;
		}
		nodes.push(node);
	}
	return { nodes, truncated, vanished };
}

/** Depth-first flatten of the nested walk into the flat `WalkedTree`
 * blocks list — pre-order, so document order survives and every depth-1
 * row keeps its place. Accumulator form: argument spread would overflow
 * the call stack on a single container with many children. */
function flatten(nodes: NestedBlock[], into: WalkedBlock[]): void {
	for (const node of nodes) {
		const { children: _children, ...block } = node;
		into.push(block);
		flatten(node.children, into);
	}
}

/** Full unfiltered getChildBlocks walk in document order, with the
 * completeness facts (`WalkedTree`). The heading filter is rendering-only —
 * callers keep the full set as write-verification evidence.
 * tolerateVanished: a SiYuanApiError (unknown/locked id, e.g. a container
 * deleted concurrently) ends that branch instead of propagating — the
 * read paths that judge absence over the result (the extended outline,
 * the fresh-content judgment) tolerate, and so does the verified edit's
 * post-write verification walk: a mid-walk vanish shortens the walk and
 * its incompleteness is judged, never discarding the post-write snapshot
 * behind a throw. Mode
 * `"belowRoot"` keeps the root call itself strict — a vanished root
 * propagates while deeper branches tolerate. */
export async function walkBlockTree(
	kernel: ChildBlocksClient,
	rootId: string,
	opts?: { tolerateVanished?: boolean | "belowRoot" },
): Promise<WalkedTree> {
	// Entry depth is always 1 (root's direct children); the recursion
	// drives it deeper and bounds the walk. Every entry call roots at a
	// document (the callers pass doc ids), so the root's children carry
	// the document root's parentage: null id, type "d". The depth-1 rows
	// are the walk's own `parentId === null` rows — the body read selects
	// them directly, no raw-wire side channel.
	const { nodes, truncated, vanished } = await walkBlockTreeNested(
		kernel,
		rootId,
		1,
		opts?.tolerateVanished ?? false,
		null,
		"d",
	);
	const flat: WalkedBlock[] = [];
	flatten(nodes, flat);
	return {
		blocks: flat,
		rootId,
		truncated,
		incomplete: truncated || vanished,
	};
}

/** The walk's id set — the membership surface the write-verification
 * judgments diff against (landed = present in the post-write set, gone =
 * absent from it). */
export function idSet(walk: readonly WalkedBlock[]): Set<string> {
	return new Set(walk.map((b) => b.id));
}

/** The walk's id→block map — the exact-parentage lookup the placement
 * projections, the outline, and the move's same-doc guard all build.
 * `inSubtree` walks the same map's parent chains. */
export function byIdMap(
	walk: readonly WalkedBlock[],
): Map<string, WalkedBlock> {
	return new Map(walk.map((b) => [b.id, b] as const));
}

/** True when `block` sits inside `ancestorId`'s subtree (its parent chain
 * reaches the ancestor). Missing parent ids (a vanished container) read as
 * outside — the fail-safe direction for placement checks. Shared by the
 * same-doc move guard: an anchor inside the moved block's own subtree
 * would re-parent the block into itself. */
export function inSubtree(
	block: WalkedBlock,
	ancestorId: string,
	byId: ReadonlyMap<string, WalkedBlock>,
): boolean {
	let parent = block.parentId;
	let hops = 0;
	while (parent !== null && hops++ < byId.size) {
		if (parent === ancestorId) return true;
		const next = byId.get(parent);
		if (next === undefined) return false;
		parent = next.parentId;
	}
	return false;
}

/** A container's sibling run in document order — the entries sharing the
 * container's id (null = the document root). The pre-order walk keeps
 * each member's descendants contiguous BEHIND it, so the filtered run is
 * the sibling order. Bare-list helper: sound because every seen row's
 * sibling run is complete, even on an incomplete walk. */
export function siblingRunOf(
	walk: readonly WalkedBlock[],
	containerId: string | null,
): WalkedBlock[] {
	return walk.filter((b) => b.parentId === containerId);
}

/** `partitionByAbsence`'s outcome as a closed union, tagged on `kind`:
 * `absentIds` exists only on the `complete` arm, so reading it off an
 * incomplete walk's split is a compile error — a consumer can never
 * render an absence claim the walk does not certify. */
export type PartitionByAbsence =
	| {
			kind: "complete";
			presentIds: string[];
			absentIds: string[];
	  }
	| {
			kind: "unconfirmed";
			presentIds: string[];
			unconfirmedAbsentIds: string[];
	  };

/** Split a caller-supplied id set against a walk: presence is sound on
 * any walk; absence only on a complete one. On an incomplete walk, ids
 * absent from the seen prefix ride `unconfirmedAbsentIds` — never claimed
 * absent. `orphanedMembersOf` composes this over the post-delete walk;
 * the downstream write flows (gnubrain) split their acked sets with it
 * too. Pure walk projection, walks taken as data, no kernel calls. */
export function partitionByAbsence(
	ids: string[],
	walk: WalkedTree,
): PartitionByAbsence {
	const present = idSet(walk.blocks);
	const presentIds = ids.filter((id) => present.has(id));
	const absent = ids.filter((id) => !present.has(id));
	if (!walk.incomplete) {
		return { kind: "complete", presentIds, absentIds: absent };
	}
	return { kind: "unconfirmed", presentIds, unconfirmedAbsentIds: absent };
}
