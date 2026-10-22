// Live body-read pins — the walk-field rendering posture and the one-call
// stitch (docBody/readDoc) over the real kernel's getChildBlocks: refs and
// embeds verbatim (both arms of the refs-index split), block IAL suppressed
// while span IAL round-trips, frontmatter-derived attrs absent, the
// omitted-empty arm, order survival under mutation, and the structural
// round-trip (write → body read → write-back → re-read). Opt-in with
// SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { sqlString } from "../../sql.js";
import { docBody, readDoc } from "../../body.js";
import { walkBlockTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	pollUntil,
	rawKernelCall,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

/** DOM-author a block after `previousID` — the UI proxy route
 * (`dataType: "dom"`, no markdown parse), the only way to author the
 * empty-paragraph class markdown import cannot produce. Returns the new
 * block's id. */
async function insertDom(data: string, previousID?: string): Promise<string> {
	const res = await rawKernelCall("/api/block/insertBlock", {
		dataType: "dom",
		data,
		...(previousID ? { previousID } : {}),
	});
	expect(res.status).toBe(200);
	expect(res.body).toMatchObject({ code: 0 });
	const ops = (res.body as { data?: { doOperations?: { id?: string }[] }[] })
		.data;
	const id = ops?.[0]?.doOperations?.[0]?.id;
	if (!id) throw new Error(`DOM insert returned no block id: ${data}`);
	return id;
}

/** Set doc-root IAL attrs — the state the UI's YAML frontmatter editing
 * lands at (doc-level tags/custom-* ride IAL into the index). The raw
 * route: layer 1 carries no attr endpoint. */
async function setDocAttrs(
	id: string,
	attrs: Record<string, string>,
): Promise<void> {
	const res = await rawKernelCall("/api/attr/setBlockAttrs", { id, attrs });
	expect(res.status).toBe(200);
	expect(res.body).toMatchObject({ code: 0 });
}

describe.skipIf(!INTEGRATION || TOKEN === "")("body read", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let boxId: string;
	/** The main fixture's doc and its ref/embed target ids — minted once,
	 * read-only across the cases (all mutations ride separate docs). */
	let mainDocId: string;
	let targetA: string;
	let targetB: string;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		boxId = fixtures.notebookIds.fixtureA;

		// The ref/embed targets must exist before the fixture mints — the
		// ref syntax and the id-embed both name real block ids.
		const targetId = await mintDoc(
			client,
			boxId,
			"/body live target",
			"# body live target\n\ntarget body one\n\ntarget body two\n",
		);
		const targets = await client.query(
			`SELECT id FROM blocks WHERE root_id = ${sqlString(targetId)} AND type = 'p' LIMIT 2`,
		);
		targetA = String(targets[0]!.id);
		targetB = String(targets[1]!.id);
		mainDocId = await mintDoc(
			client,
			boxId,
			"/body live",
			[
				"# body live",
				"",
				"para one",
				"",
				"## Section head",
				"",
				"para under section",
				"",
				"- item one",
				"  - nested child under one",
				"- item two",
				"",
				"> quote line one",
				"> quote line two",
				"",
				"```ts",
				"const body = 1;",
				"```",
				"",
				"|a|b|",
				"| --- | --- |",
				"|1|2|",
				"",
				"---",
				"",
				'span *styled*{: style="color: var(--b3-font-color8);"} tail',
				"",
				'span *customed*{: custom-bodylive="1"} tail',
				"",
				'span *named*{: name="dropped"} tail',
				"",
				"block ial para",
				'{: custom-blocklive="1"}',
				"",
				`ref to ((${targetA} "anchor text"))`,
				"",
				"{{SELECT * FROM blocks WHERE type = 'p' LIMIT 3}}",
				"",
				`{{SELECT * FROM blocks WHERE id = '${targetB}'}}`,
				"",
				"{{{row",
				"",
				"super left body",
				"",
				"}}}",
				"",
				'<div data-type="NodeHTMLBlock">raw html line</div>',
			].join("\n"),
		);
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"the stitch serves the full subtree per top-level child, in document order",
		async () => {
			const { body, children } = await docBody(client, mainDocId);

			// Document order as authored: the authored H1 is a real child
			// heading (the doc title rides the mint path, not the H1), then the
			// paragraph, its section heading + para, list, quote, code, table,
			// thematic break, the IAL/ref paragraphs, both embeds, superblock,
			// html block.
			expect(children.map((c) => c.type)).toEqual([
				"h",
				"p",
				"h",
				"p",
				"l",
				"b",
				"c",
				"t",
				"tb",
				"p",
				"p",
				"p",
				"p",
				"p",
				"query_embed",
				"query_embed",
				"s",
				"html",
			]);

			// The one-call stitch: each top-level child's markdown carries its
			// whole subtree (the nested list item rides the list's markdown;
			// quote, fence, table, superblock are whole).
			const h1 = children[0]!;
			const paraOne = children[1]!;
			const heading = children[2]!;
			const sectionPara = children[3]!;
			const list = children[4]!;
			const quote = children[5]!;
			const code = children[6]!;
			const table = children[7]!;
			const hr = children[8]!;
			expect(h1.markdown).toBe("# body live");
			expect(paraOne.markdown).toBe("para one");
			expect(heading.markdown).toBe("## Section head");
			expect(sectionPara.markdown).toBe("para under section");
			expect(list.markdown).toBe(
				"- item one\n\n  - nested child under one\n- item two",
			);
			expect(quote.markdown).toBe("> quote line one\n> quote line two");
			expect(code.markdown).toBe("```ts\nconst body = 1;\n```");
			expect(table.markdown).toContain("|1|2|");
			expect(hr.markdown).toBe("---");

			// The joiner byte rule: blank line between blocks, none trailing —
			// one fixed rule, pinned by literals below and in body.test.ts.
			expect(body).not.toMatch(/\n$/);
			expect(body).toContain("para one\n\n## Section head");

			// The non-doc-id arms, pinned: a valid leaf id answers an empty
			// body with no children (the kernel's !IsContainerBlock arm), a
			// container id yields its children — the same join over a narrower
			// id — and a heading id yields its section's rows (the kernel maps
			// a heading to HeadingChildren), the same wire rows a doc root
			// would yield.
			const leaf = await docBody(client, paraOne.id);
			expect(leaf.body).toBe("");
			expect(leaf.children).toEqual([]);
			const listBody = await docBody(client, list.id);
			expect(listBody.children.length).toBeGreaterThan(0);
			expect(listBody.body).toContain("item one");
			const section = await docBody(client, heading.id);
			expect(section.children[0]).toEqual(children[3]);

			// The strong-form omitted-empty premise: non-empty content ⇒ the
			// markdown field is present (the renderer fatal-exits rather than
			// rendering partially, so absent can only mean empty).
			const walked = await walkBlockTree(client, mainDocId);
			for (const row of children) {
				const block = walked.blocks.find((b) => b.id === row.id);
				expect(block, row.id).toBeDefined();
				if (block!.content !== "") expect(row.markdown).toBeDefined();
			}

			// Block IAL is suppressed from the served body; span IAL is
			// carried — the two-sided assert needs both an authored block
			// custom-* IAL and an authored span style IAL in the fixture. The
			// negative side covers the whole block-level vocabulary.
			expect(body).not.toContain('custom-blocklive="1"');
			expect(body).not.toMatch(/\{: (id|name|alias|memo)=/);
			expect(body).toContain('span *styled*{: style="color:');

			// Refs and embeds render verbatim — the stored pointer forms.
			expect(children[13]?.markdown).toBe(
				`ref to ((${targetA} "anchor text"))`,
			);
			expect(children[14]?.markdown).toBe(
				"{{SELECT * FROM blocks WHERE type = 'p' LIMIT 3}}",
			);
			expect(children[15]?.markdown).toBe(
				`{{SELECT * FROM blocks WHERE id = '${targetB}'}}`,
			);

			// ids appear only inside pointer syntax — strip the ref and embed
			// spans and no walk id survives in the body.
			const stripped = body
				.replace(/\{\{[\s\S]*?\}\}/g, "")
				.replace(/\(\([\s\S]*?\)\)/g, "");
			for (const block of walked.blocks) {
				expect(stripped).not.toContain(block.id);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"frontmatter-derived attrs never enter the served body — the export endpoint synthesizes doc-level frontmatter from root IAL; the walk field does not",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/body live fm",
				"# body live fm\n\nfrontmatter body para\n",
			);
			// The UI's frontmatter editing lands as doc-root IAL (tags and
			// custom-* ride IAL into the index) — seed that state directly.
			await setDocAttrs(docId, {
				tags: "fmtag1,fmtag2",
				"custom-fmkey": "fmvalue",
			});
			// Non-vacuous: the export endpoint synthesizes frontmatter bytes
			// from the root IAL; the walk-field body carries none.
			const exported = await client.exportMarkdown(docId);
			expect(exported.content).toMatch(/^---\n/);
			expect(exported.content).toContain("fmtag1");
			// The served body carries none of it.
			const { body } = await docBody(client, docId);
			expect(body).not.toContain("---");
			expect(body).not.toContain("fmtag");
			expect(body).not.toContain("fmvalue");
		},
		LIVE_TIMEOUT,
	);

	it(
		"the structural round-trip: body read → write-back → re-read is stable, refs and embeds re-import",
		async () => {
			const { body, children } = await docBody(client, mainDocId);

			const pastedId = await mintDoc(client, boxId, "/body live pasted", body);
			const pasted = await docBody(client, pastedId);

			// The re-imported tree's top-level shape equals the source's —
			// stable round-trip, not byte-exact backup (the kernel's canonical
			// re-render normalizes cosmetics like table padding).
			expect(pasted.children.map((c) => c.type)).toEqual(
				children.map((c) => c.type),
			);

			// No frontmatter bytes — frontmatter can only sit at the start;
			// the `---` thematic break inside the body is authored content.
			expect(pasted.body.startsWith("---")).toBe(false);

			// Span IAL round-trips; the name-class span dropped at the parse
			// on both sides; block IAL stays absent.
			const styled = pasted.children.find((c) =>
				(c.markdown ?? "").includes("*styled*"),
			);
			expect(styled?.markdown).toContain('span *styled*{: style="color:');
			const customed = pasted.children.find((c) =>
				(c.markdown ?? "").includes("*customed*"),
			);
			expect(customed?.markdown).toContain(
				'span *customed*{: custom-bodylive="1"}',
			);
			const named = pasted.children.find((c) =>
				(c.markdown ?? "").includes("*named*"),
			);
			expect(named?.markdown).not.toMatch(/\{: /);
			expect(pasted.body).not.toContain('custom-blocklive="1"');

			// The refs index gains a genuine edge for the block ref…
			const refRows: Record<string, unknown>[] = [];
			await pollUntil(
				"the pasted ref reaching the refs index",
				async () => {
					refRows.length = 0;
					refRows.push(
						...(await client.query(
							`SELECT def_block_id FROM refs WHERE root_id = ${sqlString(pastedId)}`,
						)),
					);
					return refRows.length >= 2;
				},
				15_000,
			);
			// …and exactly one more for the id-based embed — the two arms of
			// the refs-index split: the general embed (no WHERE id =) lands as
			// a live query_embed block with no refs edge.
			const defs = refRows.map((r) => String(r.def_block_id));
			expect([...defs].sort()).toEqual([targetA, targetB].sort());
			const general = pasted.children.find((c) =>
				(c.markdown ?? "").includes("LIMIT 3"),
			);
			expect(general?.type).toBe("query_embed");
			expect(general?.markdown).toBe(
				"{{SELECT * FROM blocks WHERE type = 'p' LIMIT 3}}",
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"omitted-empty: empty leaf paragraphs keep their rows and leave the body; empty containers render their marker; a nested empty leaf drops at the import parse, then stabilizes",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/body live omitempty",
				["# body live omitempty", "", "base omitempty para", "", ">"].join(
					"\n",
				),
			);
			const walked = await walkBlockTree(client, docId);
			const base = walked.blocks.find(
				(b) => b.content === "base omitempty para",
			)!;
			// The empty blockquote is markdown-authorable (">") — the kernel
			// imports it as a container whose only child is an empty paragraph.
			// The empty paragraphs need DOM authoring (no markdown parse can
			// produce one), chained after a normal block — the kernel rejects
			// container inserts anchored on an empty paragraph.
			const empty1 = await insertDom(
				'<p data-type="NodeParagraph"></p>',
				base.id,
			);
			await insertDom(
				'<p data-type="NodeParagraph"><span data-type="text"></span></p>',
				empty1,
			);
			await insertDom(
				'<div data-type="NodeBlockquote"><p data-type="NodeParagraph">inside quote</p><p data-type="NodeParagraph"></p></div>',
				base.id,
			);

			const { body, children } = await docBody(client, docId);
			// The empty paragraphs omit: rows of exactly { id, type }, and the
			// body omits the blocks (the walk renders empty leaf blocks as
			// empty — no placeholder bytes to re-import).
			const empties = children.filter((c) => c.markdown === undefined);
			expect(empties.map((c) => c.type)).toEqual(["p", "p"]);
			for (const empty of empties) {
				expect(Object.keys(empty).sort()).toEqual(["id", "type"]);
			}
			// The body: base para, the nested quote, the empty blockquote's
			// marker line — the empty leaves contribute nothing.
			expect(body).toContain("base omitempty para");
			expect(body).toContain("inside quote");
			// The nested quote carries its empty leaf's marker line (the
			// container arm does not omit) — but the IMPORT parse cannot
			// re-create an empty paragraph, so the leaf drops on write-back
			// (the same import-leg class as the span-IAL name drop):
			// re-import renders the quote without the trailing marker line,
			// and the body changes once, then stabilizes at that fixed point.
			const nested = children.find((c) =>
				(c.markdown ?? "").includes("inside quote"),
			);
			expect(nested?.markdown).toBe("> inside quote\n>");
			const pastedId = await mintDoc(
				client,
				boxId,
				"/body live omitempty pasted",
				body,
			);
			const pasted = await docBody(client, pastedId);
			expect(pasted.body).toBe(
				body.replace("> inside quote\n>", "> inside quote"),
			);
			const repastedId = await mintDoc(
				client,
				boxId,
				"/body live omitempty repasted",
				pasted.body,
			);
			expect((await docBody(client, repastedId)).body).toBe(pasted.body);
		},
		LIVE_TIMEOUT,
	);

	it(
		"an empty doc serves an empty body; an id with no block tree refuses with the kernel's code -1 envelope",
		async () => {
			const emptyId = await mintDoc(client, boxId, "/body live empty", "");
			const empty = await docBody(client, emptyId);
			// The observable contract: empty body. The kernel-minted empty doc
			// carries one empty-paragraph child (the omitting arm — markdown
			// absent, nothing to lose); a childless block and an
			// in-store-unloadable tree serve the same empty shape
			// (indistinguishable on the read path — the wording contract's
			// empty-body sentence is the consumer's visibility).
			expect(empty.body).toBe("");
			expect(empty.children).toHaveLength(1);
			expect(Object.keys(empty.children[0]!).sort()).toEqual(["id", "type"]);

			const gone = "20990101000000-gone0001";
			// readDoc's strict root propagates the kernel's code:-1 refusal —
			// no empty body served through the unified read.
			await expect(readDoc(client, gone)).rejects.toMatchObject({
				status: 200,
				code: -1,
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"top-level order survives prepend, mid-insert, and move",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/body live order",
				"para A\n\npara C\n",
			);
			const contents = () =>
				docBody(client, docId).then((r) => r.children.map((c) => c.markdown));
			expect(await contents()).toEqual(["para A", "para C"]);

			// Mid-insert: B lands between A and C.
			const walkedA = await walkBlockTree(client, docId);
			const a = walkedA.blocks.find((b) => b.content === "para A")!;
			const bTx = await client.insertBlock({
				data: "para B",
				previousID: a.id,
			});
			const bId = bTx[0]?.doOperations[0]?.id;
			if (!bId) throw new Error("mid-insert returned no block id");
			expect(await contents()).toEqual(["para A", "para B", "para C"]);

			// Prepend: zero lands before A.
			await client.insertBlock({
				data: "para zero",
				nextID: a.id,
			});
			expect(await contents()).toEqual([
				"para zero",
				"para A",
				"para B",
				"para C",
			]);

			// Move: A lands after C (the endpoint's previousID is the block to
			// follow — there is no nextID on moveBlock).
			const walkedC = await walkBlockTree(client, docId);
			const c = walkedC.blocks.find((b) => b.content === "para C")!;
			const a2 = walkedC.blocks.find((b) => b.content === "para A")!;
			await client.moveBlock({ id: a2.id, previousID: c.id });
			expect(await contents()).toEqual([
				"para zero",
				"para B",
				"para C",
				"para A",
			]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"inline-syntax rendering tracks the live editor markdown config — each construct parses iff its flag is on",
		async () => {
			// Conf.Editor.Markdown is operator state; this assert is
			// config-aware, not a defaults pin: the live flags are read via
			// POST /api/system/getConf (`data.conf.editor.markdown`, fed into
			// the lute renderer at `util/lute.go`) and checked for
			// CONSISTENCY with the walk field's rendering — each construct
			// parses as markup iff its flag is on. The `#tag#` construct is
			// excluded: parsed and literal render identical bytes through the
			// walk field (a tag span's text keeps its hashes), so it has no
			// discriminative power here. Each construct rides its own
			// paragraph — single newlines merge into one paragraph (lazy
			// continuation) and the merged context suppresses some parses.
			const confRes = await rawKernelCall("/api/system/getConf", {});
			const mdConf = (
				confRes.body as {
					data?: {
						conf?: { editor?: { markdown?: Record<string, unknown> } };
					};
				}
			).data?.conf?.editor?.markdown;
			const flagOf = (flag: string): boolean => {
				const v = mdConf?.[flag];
				if (typeof v !== "boolean") {
					throw new Error(
						`inline-syntax posture: Conf.Editor.Markdown.${flag} missing or non-boolean in the POST /api/system/getConf response (status ${confRes.status}) — cannot judge rendering consistency`,
					);
				}
				return v;
			};
			const constructs = [
				["*emx*", "emx", "inlineAsterisk"],
				["_emu_", "emu", "inlineUnderscore"],
				["^supx^", "supx", "inlineSup"],
				["~subx~", "subx", "inlineSub"],
				["$mathx$", "mathx", "inlineMath"],
				["~~delx~~", "delx", "inlineStrikethrough"],
				["==markx==", "markx", "inlineMark"],
				["～～delfw～～", "delfw", "inlineFullWidthStrikethrough"],
			] as const;
			const docId = await mintDoc(
				client,
				boxId,
				"/body live posture",
				[
					"# body live posture",
					"",
					constructs.map(([md]) => md).join("\n\n"),
				].join("\n"),
			);
			const walked = await walkBlockTree(client, docId);
			const contents = new Set(walked.blocks.map((b) => b.content));
			for (const [md, word, flag] of constructs) {
				const flagOn = flagOf(flag);
				const parsed = contents.has(word);
				if (parsed !== flagOn) {
					throw new Error(
						`inline-syntax posture drifted: '${md}' rendered ${parsed ? "as markup" : "as literal text"} while Conf.Editor.Markdown.${flag} is ${flagOn}. Two causes name this failure — the kernel's editor markdown defaults changed on upgrade, or an operator toggled the setting between the conf read and the walk. Check POST /api/system/getConf (Conf.Editor.Markdown) before re-pinning; this is not a kernel regression on its own.`,
					);
				}
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"readDoc's body and rows match docBody, and its walk half matches walkBlockTree",
		async () => {
			const unified = await readDoc(client, mainDocId);
			const standalone = await docBody(client, mainDocId);
			expect(unified.body).toBe(standalone.body);
			expect(unified.children).toEqual(standalone.children);
			// The walk half keeps walkBlockTree's contract exactly.
			const walked = await walkBlockTree(client, mainDocId);
			expect(unified.truncated).toBe(walked.truncated);
			expect(unified.incomplete).toBe(walked.incomplete);
			expect(unified.blocks).toEqual(walked.blocks);
		},
		LIVE_TIMEOUT,
	);
});
