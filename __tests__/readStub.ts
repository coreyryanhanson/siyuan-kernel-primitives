// Shared read-side stubs and fixture vocabulary: full KernelReadClient
// implementations (never casts, so a contract change fails typecheck here
// instead of silently drifting out of the shape a stub stands in for), plus
// the tree fixtures the walk-based suites build their corpora from.

import type { KernelReadClient, SearchBlockRow } from "../client.js";
import {
	sectionOf,
	type AppendAnchor,
	type AppendPlacement,
	type Section,
} from "../placement.js";
import {
	MAX_WALK_DEPTH,
	walkBlockTree,
	type WalkedBlock,
	type WalkedTree,
} from "../walk.js";

type ChildRows = Record<string, unknown>[];

export interface QueryClientRoutes {
	query?: (stmt: string) => ChildRows | Promise<ChildRows>;
	fullTextSearch?: (params: {
		query: string;
		paths: string[];
		pageSize: number;
	}) => Promise<{ blocks: SearchBlockRow[]; matchedBlockCount: number }>;
	getHPathByID?: (id: string) => string | Promise<string>;
	getChildBlocks?: (id: string) => ChildRows | Promise<ChildRows>;
}

/** A KernelReadClient stub whose unused routes are inert: each route
 * answers from its own handler, and every method is really implemented
 * (a stub cannot gain or lose a contract member unnoticed). */
export function queryClient(routes: QueryClientRoutes = {}): KernelReadClient {
	return {
		async query(stmt) {
			return routes.query ? routes.query(stmt) : [];
		},
		async fullTextSearch(params) {
			return routes.fullTextSearch
				? await routes.fullTextSearch(params)
				: { blocks: [], matchedBlockCount: 0 };
		},
		async getHPathByID(id) {
			return routes.getHPathByID ? await routes.getHPathByID(id) : "";
		},
		async getChildBlocks(id) {
			return routes.getChildBlocks ? routes.getChildBlocks(id) : [];
		},
	};
}

/** A walk-seeded client: each entry maps a block id to its child rows
 * (missing ids walk as empty). */
export function walkClient(
	children: Record<string, Record<string, unknown>[]>,
): KernelReadClient {
	return queryClient({ getChildBlocks: (id) => children[id] ?? [] });
}

// --------------------------------------------------- fixture vocabulary

export interface FNode {
	id: string;
	type: string;
	subType: string;
	content: string;
	children: FNode[];
}

export const h = (id: string, level: number, content: string): FNode => ({
	id,
	type: "h",
	subType: `h${level}`,
	content,
	children: [],
});
export const p = (id: string, content = "body"): FNode => ({
	id,
	type: "p",
	subType: "",
	content,
	children: [],
});
export const box = (
	id: string,
	type: string,
	children: FNode[],
	subType = "",
): FNode => ({ id, type, subType, content: type, children });

/** Seed a stub client's child map from the fixture tree: the document's
 * root children plus every container's children. The real walk recurses
 * exactly into the containers, so unseeded ids never matter. */
export function childrenMap(
	root: FNode[],
	docId: string,
): Record<string, Record<string, unknown>[]> {
	const toRow = (n: FNode): Record<string, unknown> => ({
		id: n.id,
		type: n.type,
		subType: n.subType,
		content: n.content,
	});
	const map: Record<string, Record<string, unknown>[]> = {
		[docId]: root.map(toRow),
	};
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				map[node.id] = node.children.map(toRow);
				visit(node.children);
			}
		}
	};
	visit(root);
	return map;
}

/** Hang a chain off `docId` that reaches past the walk's depth bound: the
 * doc's children gain c1, each c{i}'s child is c{i + 1} up to
 * c{MAX_WALK_DEPTH}, and `leaf` becomes that container's child when given —
 * the shared fixture for the truncation judgments. Mutates `tree`. */
export function deepChain(
	tree: Record<string, Record<string, unknown>[]>,
	docId: string,
	leaf?: Record<string, unknown>,
): void {
	tree[docId] = [
		...(tree[docId] ?? []),
		{ id: "c1", type: "l", subType: "", content: "" },
	];
	for (let i = 1; i < MAX_WALK_DEPTH; i++) {
		tree[`c${i}`] = [{ id: `c${i + 1}`, type: "l", subType: "", content: "" }];
	}
	if (leaf) tree[`c${MAX_WALK_DEPTH}`] = [leaf];
}

/** A complete tree over a block list — the fixture default. */
export const treeOf = (blocks: WalkedBlock[]): WalkedTree => ({
	blocks,
	rootId: "d-doc",
	truncated: false,
	incomplete: false,
});

/** A deliberately truncated walk over a block list — the incompleteness
 * fixtures. */
export const truncatedOf = (blocks: WalkedBlock[]): WalkedTree => ({
	blocks,
	rootId: "d-doc",
	truncated: true,
	incomplete: true,
});

/** A walked row with the stored representation the projections watch —
 * `markdown` mirrors `content` (the walk field's rendering posture). */
export const walkBlock = (
	id: string,
	type: string,
	subType: string,
	content: string,
	parentId: string | null = null,
	parentType: string | null = "d",
): WalkedBlock => ({
	id,
	type,
	subType,
	content,
	markdown: content,
	parentId,
	parentType,
});

/** Build a real walk over a fixture tree through the real walkBlockTree —
 * the projections' input and the oracle's counterpart (the two cannot
 * share a bug). */
export interface Built {
	walk: WalkedBlock[];
	/** The walked tree as one object — the projections' input. */
	tree: WalkedTree;
	/** parentId → the child list the fixture stored under it (root = null).
	 * The oracle's only input. */
	siblings: Map<string | null, FNode[]>;
}

export async function build(root: FNode[]): Promise<Built> {
	const siblings = new Map<string | null, FNode[]>();
	siblings.set(null, root);
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				siblings.set(node.id, node.children);
				visit(node.children);
			}
		}
	};
	visit(root);
	const client = walkClient(childrenMap(root, "d-doc"));
	const walked = await walkBlockTree(client, "d-doc");
	return { walk: walked.blocks, tree: walked, siblings };
}

/** Every corpus tree is complete, so the truncation arm is unreachable —
 * narrow it away for property reads. */
export function unwrapSection(result: ReturnType<typeof sectionOf>): Section {
	if (result.kind !== "section") {
		throw new Error(`expected a section, got ${result.kind}`);
	}
	return result.section;
}

// ------------------------------------------------------------ the corpus

export interface Row {
	label: string;
	fixture: FNode[];
	target: string;
	members: string[];
	boundary: string | null;
	insert: AppendAnchor;
	movePreviousID: string;
	placement?: AppendPlacement;
}

const S1: FNode[] = [h("hA", 1, "A"), p("p1"), h("hB", 1, "B")];
const S2: FNode[] = [
	h("hA", 1, "A"),
	p("p1"),
	h("hA1", 2, "A1"),
	p("p2"),
	h("hB", 1, "B"),
];
const S13: FNode[] = [h("hA", 1, "A")];

export const CORPUS: Row[] = [
	{
		label: "a plain section — insert before the boundary, move after the body",
		fixture: S1,
		target: "hA",
		members: ["p1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "p1",
	},
	{
		label:
			"a deeper heading belongs to the section — the run runs past it to the boundary",
		fixture: S2,
		target: "hA",
		members: ["p1", "hA1", "p2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "p2",
	},
	{
		label:
			"a list member ends the sibling run — the insert is never anchored inside it",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("l2", "l", [box("i3", "i", [p("i3a")]), box("i4", "i", [p("i4a")])]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "l2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "l2",
	},
	{
		label:
			"a quote member is a member — its descendants are closure, not members",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("b2", "b", [p("p3")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "b2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "b2",
	},
	{
		label:
			"a callout-nested section closes only inside the callout — the container's following sibling survives",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [h("hN", 2, "N"), p("p2")]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hN",
		members: ["p2"],
		boundary: null,
		insert: { kind: "append", containerId: "c1" },
		movePreviousID: "p2",
	},
	{
		label:
			"a sibling heading inside one callout bounds the run — the insert lands inside the container",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [
				h("hA2", 2, "A"),
				p("pA"),
				h("hB2", 2, "B"),
				p("pB"),
			]),
			h("hNext", 1, "Next"),
		],
		target: "hA2",
		members: ["pA"],
		boundary: "hB2",
		insert: { kind: "insert", nextID: "hB2" },
		movePreviousID: "pA",
	},
	{
		label:
			"a heading inside a list item is container-local — the sibling list item survives",
		fixture: [
			h("hTop", 1, "Top"),
			box("l1", "l", [
				box("i1", "i", [h("hH", 2, "H"), p("p3")]),
				box("i2", "i", [p("i2p")]),
			]),
			h("hNext", 1, "Next"),
		],
		target: "hH",
		members: ["p3"],
		boundary: null,
		insert: { kind: "append", containerId: "i1" },
		movePreviousID: "p3",
	},
	{
		label:
			"an empty section between two headings — the move anchors on the target heading itself",
		fixture: [h("hA", 1, "A"), h("hB", 1, "B")],
		target: "hA",
		members: [],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "hA",
	},
	{
		label: "a section running to the doc end — the doc-root append",
		fixture: S1.slice(0, 2),
		target: "hA",
		members: ["p1"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		movePreviousID: "p1",
	},
	{
		label:
			"a trailing list container runs to the doc end — the move anchors on the container, never inside it",
		fixture: [h("hA", 1, "A"), box("l2", "l", [box("i3", "i", [p("i3a")])])],
		target: "hA",
		members: ["l2"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		movePreviousID: "l2",
	},
	{
		label: "a superblock-nested section appends inside the superblock",
		fixture: [
			h("hTop", 1, "Top"),
			box("s1", "s", [h("hH", 2, "H"), p("p3")]),
			h("hNext", 1, "Next"),
		],
		target: "hH",
		members: ["p3"],
		boundary: null,
		insert: { kind: "append", containerId: "s1" },
		movePreviousID: "p3",
	},
	{
		label:
			"a heading nested inside a quote member is closure — the anchor stays at doc level",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("b2", "b", [p("pA"), h("hH", 2, "H")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "b2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "b2",
	},
	{
		label: "a lone heading — an empty section running to the doc end",
		fixture: S13,
		target: "hA",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: null },
		movePreviousID: "hA",
	},
	{
		label:
			"sibling headings inside a callout, with the doc's trailing blocks outside — nothing past the container is touched",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [
				h("hA2", 2, "A"),
				p("pA"),
				h("hB2", 2, "B"),
				p("pB"),
			]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hA2",
		members: ["pA"],
		boundary: "hB2",
		insert: { kind: "insert", nextID: "hB2" },
		movePreviousID: "pA",
	},
	{
		label:
			"a section ending in an empty subheading — the move anchors on that subheading",
		fixture: [h("hA", 1, "A"), p("p1"), h("hA1", 2, "A1")],
		target: "hA",
		members: ["p1", "hA1"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		movePreviousID: "hA1",
	},
	{
		label:
			"a container-nested empty section — the member set is empty, the doc's trailing blocks survive",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [h("hN", 2, "N")]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hN",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: "c1" },
		movePreviousID: "hN",
	},
	// placement: "section-start" — a second projection of the same Section.
	{
		label:
			"section-start inserts before the first subsection, after the leading run",
		fixture: S2,
		target: "hA",
		members: ["p1", "hA1", "p2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hA1" },
		movePreviousID: "p2",
		placement: "section-start",
	},
	{
		label: "section-start on an empty section is identical to the default",
		fixture: S13,
		target: "hA",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: null },
		movePreviousID: "hA",
		placement: "section-start",
	},
	{
		label:
			"section-start with no deeper sibling heading falls to the boundary — identical to the default",
		fixture: S1,
		target: "hA",
		members: ["p1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "p1",
		placement: "section-start",
	},
	{
		label:
			"section-start ignores a deeper heading nested inside a container member — the body never lands above it",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("c1", "callout", [h("hX", 2, "X")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "c1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		movePreviousID: "c1",
		placement: "section-start",
	},
];

// Every fixture the properties range over.
export const ALL_FIXTURES: FNode[][] = [
	...CORPUS.map((row) => row.fixture),
	[
		h("hA", 1, "A"),
		box("tabs1", "tabs", [h("hT", 1, "In tabs")]),
		box("fn1", "", [h("hF", 2, "In footnote")]),
		h("hB", 1, "B"),
	],
];
