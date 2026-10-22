// Live walk pins — document order, container nesting, and heading
// non-recursion over the real kernel's getChildBlocks. Every kind in
// TARGETABLE_CONTAINER_TYPES has a live pin here: tabs (`::: tabs` /
// `@tab`), callout (`> [!NOTE]`), superblock (`{{{row … }}}`), and the
// rich-table hazard case below; blockquote/list pin with the first case,
// mindmap/mindmap_item with the migrated-mindmap case. The empty-type
// branch in nests() has no mintable fixture (a footnote definition never
// becomes a block row — the kernel keeps it literal text) and stays
// unit-pinned against hand-built walks. Opt-in with SIYUAN_INTEGRATION=1,
// never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { sqlString } from "../../sql.js";
import { sectionOf } from "../../placement.js";
import { headingLevel } from "../../heading.js";
import { byIdMap, walkBlockTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	rawKernelCall,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("block-tree walk", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let docId: string;
	let boxId: string;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		boxId = fixtures.notebookIds.fixtureA;
		docId = await mintDoc(
			client,
			boxId,
			"/walk live",
			[
				"# Section One",
				"",
				"para under h",
				"",
				"::: tabs",
				"@tab First",
				"",
				"inside tab",
				"",
				"@tab Second",
				"",
				"inside tab two",
				":::",
				"",
				"quote line",
				"",
				"- list item one",
				"- list item two",
				"",
			].join("\n"),
		);
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"every block appears exactly once, in document order, with exact parentage",
		async () => {
			const { blocks: walk } = await walkBlockTree(client, docId);
			// Document order as minted: the heading, its section para, the tabs
			// structure with its two items and bodies, the quote, the list —
			// each visited exactly once.
			const types = walk.map((b) => b.type);
			expect(types).toEqual([
				"h",
				"p",
				"tabs",
				"tab",
				"p",
				"tab",
				"p",
				"p",
				"l",
				"i",
				"p",
				"i",
				"p",
			]);
			expect(types.indexOf("tabs")).toBe(2);
			// Exact ancestry: the section para is a child of the doc (null id,
			// type "d"), never re-parented under the heading.
			const sectionPara = walk[1]!;
			expect(sectionPara.content).toBe("para under h");
			expect(sectionPara.parentId).toBeNull();
			expect(sectionPara.parentType).toBe("d");
		},
		LIVE_TIMEOUT,
	);

	it(
		"tabs/tab structures nest in document order alongside ordinary containers",
		async () => {
			const { blocks: walk } = await walkBlockTree(client, docId);
			const tabs = walk.find((b) => b.type === "tabs");
			expect(tabs).toBeDefined();
			const items = walk.filter((b) => b.type === "tab");
			expect(items).toHaveLength(2);
			// Each tab item hangs directly off the tabs container; each body
			// paragraph hangs off its own tab item.
			const firstBody = walk.find((b) => b.content === "inside tab");
			const secondBody = walk.find((b) => b.content === "inside tab two");
			for (const [body, item] of [
				[firstBody, items[0]!],
				[secondBody, items[1]!],
			] as const) {
				expect(body).toBeDefined();
				expect(body!.parentId).toBe(item.id);
				expect(body!.parentType).toBe("tab");
			}
			// Both items appear AFTER the tabs container (document order).
			const first = walk.findIndex((b) => b.type === "tab");
			expect(first).toBeGreaterThan(walk.findIndex((b) => b.type === "tabs"));
		},
		LIVE_TIMEOUT,
	);

	it(
		"a heading is never recursed into — its section blocks appear once, as the owning container's children",
		async () => {
			const { blocks: walk } = await walkBlockTree(client, docId);
			// The section para is emitted exactly once with doc parentage; if the
			// walk recursed into `h`, it would reappear parented to the heading.
			const paras = walk.filter((b) => b.content === "para under h");
			expect(paras).toHaveLength(1);
			expect(paras[0]!.parentId).toBeNull();
		},
		LIVE_TIMEOUT,
	);

	it(
		"walk content equals blocks.content for every block (both built via nodeStaticContent — the fresh-content equivalence)",
		async () => {
			const { blocks: walk } = await walkBlockTree(client, docId);
			expect(walk.length).toBeGreaterThan(0);
			for (const block of walk) {
				const rows = await client.query(
					`SELECT content FROM blocks WHERE id = ${sqlString(block.id)}`,
				);
				const stored = String(rows[0]?.content);
				expect(stored).toBe(block.content);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"headingLevel reads h1–h6 from the walked subTypes",
		async () => {
			const nested = await mintDoc(
				client,
				boxId,
				"/walk live heading levels",
				[
					"# one",
					"## two",
					"### three",
					"#### four",
					"##### five",
					"###### six",
					"",
					"body",
				].join("\n"),
			);
			const { blocks: walk } = await walkBlockTree(client, nested);
			const levels = walk
				.filter((b) => b.type === "h")
				.map((b) => headingLevel(b));
			expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"sectionOf().members equals getChildBlocks for every heading, flat and container-nested (the membership oracle)",
		async () => {
			const oracleDoc = await mintDoc(
				client,
				boxId,
				"/walk live membership oracle",
				[
					"# Alpha",
					"",
					"lead paragraph",
					"",
					"## Sub",
					"",
					"sub body",
					"",
					"> ## Quoted",
					"> quote body",
					"",
					"# Beta",
					"",
					"beta body",
					"",
				].join("\n"),
			);
			const oracleTree = await walkBlockTree(client, oracleDoc);
			const walk = oracleTree.blocks;
			const headings = walk.filter((b) => b.type === "h");
			// The quoted heading exercises the container-nested half of the
			// equivalence: its members are its siblings INSIDE the quote, which is
			// also what the kernel answers getChildBlocks with.
			expect(headings.length).toBe(4);
			expect(headings.some((h) => (h.parentType ?? "") === "b")).toBe(true);
			for (const h of headings) {
				const kernelIds = (await client.getChildBlocks(h.id)).map((b) =>
					String(b.id),
				);
				const oracleSection = sectionOf(oracleTree, h.id);
				if (oracleSection.kind !== "section") continue;
				expect(oracleSection.section.members.map((m) => m.id)).toEqual(
					kernelIds,
				);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"tolerateVanished swallows only the kernel's envelope refusal (HTTP 200, code -1) — a 5xx still fails the read",
		async () => {
			// The kernel answers an unknown id with HTTP 200 / code -1, not a
			// 404 — the tolerance branch must key on exactly that shape, so a
			// vanished id shortens the walk while a transport failure throws.
			const gone = "20990101000000-gone0001";
			await expect(
				walkBlockTree(client, gone, { tolerateVanished: true }),
			).resolves.toEqual({
				blocks: [],
				rootId: gone,
				truncated: false,
				incomplete: true,
			});
			await expect(walkBlockTree(client, gone)).rejects.toMatchObject({
				status: 200,
				code: -1,
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"every container kind the walk recurses into emits its children; a rich table emits no phantom rows",
		async () => {
			// The walk's recursion gate derives from the kernel's container
			// vocabulary; the endpoint recurses on lute's ast-level
			// IsContainerBlock — not locally readable. Every absence-shaped
			// judgment in the package rides the two agreeing, so each mintable
			// kind gets a live pin. The rich-table leg is the one
			// indexed-but-unwalkable hazard: cells carry NO block identity
			// (kernel/treenode/table_cell_rich_test.go pins the projection
			// id-free), so the doc's index rows must equal the walk's id set —
			// a cell with identity would be absent from the walk and read as a
			// confident false `vanished`. Mint syntaxes are the app's own hint
			// fixtures (app/src/protyle/hint/extend.ts,
			// agent/AgentMarkdownBlocks.test.ts).
			const kindsDoc = await mintDoc(
				client,
				boxId,
				"/walk live container kinds",
				[
					"# Container kinds",
					"",
					"> [!NOTE]",
					"> inside callout",
					"",
					"{{{row",
					"",
					"left of superblock",
					"",
					"right of superblock",
					"",
					"}}}",
					"",
					"::: tabs",
					"@tab",
					"",
					"inside first tab",
					"",
					"@tab",
					"",
					"inside second tab",
					"",
					":::",
					"",
					"| A | B |",
					"| --- | --- |",
					"| cell one | cell two |",
					"",
					"tail para",
					"",
				].join("\n"),
			);
			const tree = await walkBlockTree(client, kindsDoc);
			const walk = tree.blocks;
			// Document order as minted: heading, callout + its body, superblock
			// + its two paragraphs, the tabs container + its two tab panes,
			// the table (a leaf here — no recursion), and the doc-level tail.
			expect(walk.map((b) => b.type)).toEqual([
				"h",
				"callout",
				"p",
				"s",
				"p",
				"p",
				"tabs",
				"tab",
				"p",
				"tab",
				"p",
				"t",
				"p",
			]);
			// The completeness fact every absence judgment over this doc keys
			// on: the walk ended no branch early.
			expect(tree).toMatchObject({ truncated: false, incomplete: false });
			// Exact parentage: the callout and superblock nest their children.
			const byId = byIdMap(walk);
			const callout = walk.find((b) => b.type === "callout")!;
			expect(walk[2]).toMatchObject({
				type: "p",
				content: "inside callout",
				parentId: callout.id,
				parentType: "callout",
			});
			const superblock = walk.find((b) => b.type === "s")!;
			const tabs = walk.find((b) => b.type === "tabs")!;
			for (const [i, content] of [
				[4, "left of superblock"],
				[5, "right of superblock"],
			] as const) {
				expect(walk[i]).toMatchObject({
					type: "p",
					content,
					parentId: superblock.id,
					parentType: "s",
				});
			}
			// By-id agreement: every walked parent is itself in the walk.
			for (const b of walk) {
				if (b.parentId !== null) {
					expect(byId.has(b.parentId)).toBe(true);
				}
			}
			// The indexed-but-unwalkable hazard: the blocks index must carry no
			// row the walk did not emit (the doc's own `d` row excluded — the
			// walk emits the root's children).
			const indexed = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(kindsDoc)} AND id != ${sqlString(kindsDoc)}`,
			);
			expect(new Set(indexed.map((r) => String(r.id)))).toEqual(
				new Set(walk.map((b) => b.id)),
			);
			// The endpoint answers the same structure the walk recorded: the
			// containers' getChildBlocks is exactly the walk's nested child set,
			// the table (a leaf in the vocabulary) answers nothing — the fact
			// the walk's parentage rows mirror.
			const table = walk.find((b) => b.type === "t")!;
			expect(await client.getChildBlocks(table.id)).toEqual([]);
			for (const container of [callout, superblock, tabs]) {
				const walkedChildren = walk
					.filter((b) => b.parentId === container.id)
					.map((b) => b.id);
				expect(walkedChildren.length).toBeGreaterThan(0);
				expect(
					(await client.getChildBlocks(container.id)).map((b) => String(b.id)),
				).toEqual(walkedChildren);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"walks into a migrated mindmap — mindmap/mindmap_item rows in document order with exact parentage",
		async () => {
			// Mindmap containers are not markdown-mintable: a legacy ```mindmap
			// fence parses as an ordinary code block, and the kernel retypes it
			// (list → mindmap, items → mindmap_item, nested lists recursively)
			// only on the migrate endpoint (kernel/model/list_mindmap_migration.go).
			// The kernel's getChildBlocks recurses into both types
			// (model.Block.IsContainerBlock @ 3.8.8), so the walk must emit their
			// rows — a missing type here voids every absence judgment over
			// mindmap content. The migrate endpoint has no layer-1 method, so
			// this one pin rides the raw call helper; the contract layer
			// requires both id and notebook (kernel/apicontract/list_mindmap.go).
			const mapDoc = await mintDoc(
				client,
				boxId,
				"/walk live mindmap",
				[
					"# Map doc",
					"",
					"```mindmap",
					"- root",
					"  - branch",
					"    leaf body",
					"```",
					"",
					"tail para",
					"",
				].join("\n"),
			);
			const migrated = await rawKernelCall("/api/block/migrateLegacyMindmaps", {
				id: mapDoc,
				notebook: boxId,
			});
			expect(migrated.status).toBe(200);
			expect(migrated.body).toMatchObject({ code: 0 });
			const { blocks: walk, truncated } = await walkBlockTree(client, mapDoc);
			expect(truncated).toBe(false);
			// The migrated fence: mindmap → mindmap_item → [p "root", mindmap →
			// mindmap_item → [p "branch\nleaf body"]] — item text rides a
			// paragraph child (the list shape), the nested list retypes
			// recursively, and the branch item's indented continuation line
			// merges into its paragraph (lute's lazy continuation, verified
			// live) — all in document order, then the doc-level sibling.
			expect(walk.map((b) => b.type)).toEqual([
				"h",
				"mindmap",
				"mindmap_item",
				"p",
				"mindmap",
				"mindmap_item",
				"p",
				"p",
			]);
			// Exact parentage: the outer map hangs off the doc; the root item
			// off the outer map; its text paragraph and the nested map off the
			// root item; the branch item off the nested map; its text (the
			// merged continuation included) off the branch item; the tail
			// paragraph off the doc.
			const byId = new Map(walk.map((b) => [b.id, b]));
			const outerMap = walk[1]!;
			const rootItem = walk[2]!;
			const rootText = walk[3]!;
			const nestedMap = walk[4]!;
			const branchItem = walk[5]!;
			expect(outerMap).toMatchObject({
				type: "mindmap",
				parentId: null,
				parentType: "d",
			});
			expect(rootItem).toMatchObject({
				type: "mindmap_item",
				parentId: outerMap.id,
				parentType: "mindmap",
			});
			expect(rootText).toMatchObject({
				type: "p",
				content: "root",
				parentId: rootItem.id,
				parentType: "mindmap_item",
			});
			expect(nestedMap).toMatchObject({
				type: "mindmap",
				parentId: rootItem.id,
				parentType: "mindmap_item",
			});
			expect(branchItem).toMatchObject({
				type: "mindmap_item",
				parentId: nestedMap.id,
				parentType: "mindmap",
			});
			expect(walk[6]).toMatchObject({
				type: "p",
				content: "branch\nleaf body",
				parentId: branchItem.id,
				parentType: "mindmap_item",
			});
			expect(walk[7]).toMatchObject({
				type: "p",
				content: "tail para",
				parentId: null,
				parentType: "d",
			});
			// By-id agreement: every mapped parent is itself in the walk — the
			// membership fact every section judgment over mindmap content rides.
			for (const b of walk) {
				if (b.parentId !== null) {
					expect(byId.has(b.parentId)).toBe(true);
				}
			}
			// Write-parent acceptance: the kernel's CheckContainerParent accepts
			// a mindmap_item (IsContainerType) — the write-parent half of
			// the vocabulary, beside the walk-side pin above.
			const branchAppend = await rawKernelCall("/api/block/appendBlock", {
				data: "appended inside map",
				dataType: "markdown",
				parentID: branchItem.id,
			});
			expect(branchAppend.status).toBe(200);
			expect(branchAppend.body).toMatchObject({ code: 0 });
			const afterAppend = await client.getChildBlocks(branchItem.id);
			expect(afterAppend.map((b) => b.content)).toContain(
				"appended inside map",
			);
		},
		LIVE_TIMEOUT,
	);
});
