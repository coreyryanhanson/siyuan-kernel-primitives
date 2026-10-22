// Live write-primitive pins — the guarded-create core, the verdict
// classifications, and the landed judgments, each falsified directly against
// the real pinned kernel, not only transitively through a consumer's tool
// tests. Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import {
	blockInDoc,
	findTitleMatches,
	probeKernel,
	rootEcho,
	type KernelProbeResult,
} from "siyuan-kernel-primitives";
import {
	createDocVerified,
	editVerified,
} from "siyuan-kernel-primitives/write";
import { insertLanded, newBlockIdFrom } from "../../insert.js";
import { judgeEditLanded } from "../../edit.js";
import { sectionOf } from "../../placement.js";
import { sqlString } from "../../sql.js";
import { TARGETABLE_CONTAINER_TYPES } from "../../containers.js";
import { idSet, walkBlockTree } from "../../walk.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	awaitIndexed,
	mintDoc,
	pollUntil,
	rawKernelCall,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("write primitives", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let probe: KernelProbeResult;
	let boxId: string;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		// The session-start probe, produced by the real probeKernel.
		probe = await probeKernel(client);
		expect(probe.verdict).toBe("ok");
		boxId = fixtures.notebookIds.fixtureA;
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	// -------------------------------------------------------------------
	// Guarded-create core
	// -------------------------------------------------------------------

	it(
		"createDocVerified mints and its poll loop certifies the landed doc",
		async () => {
			const result = await createDocVerified(client, probe, {
				boxId,
				title: "verified create live",
				body: "verified body",
			});
			expect(result.kind).toBe("created");
			if (result.kind !== "created") return;
			// The success evidence is what the create echo words itself from.
			expect(result.content).toBe("verified create live");
			expect(result.hpath).toBe("/verified create live");
			// The certifying read rides the same pinned doc-row shape the poll
			// loop asserted: rootEcho must carry the minted docId.
			const echo = await rootEcho(client, boxId, result.docId);
			expect(echo).toEqual({
				docId: result.docId,
				title: result.content,
				hpath: result.hpath,
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"nested create rides the live parent read-back and the hpath ground-truth assert",
		async () => {
			const parent = await mintDoc(
				client,
				boxId,
				"/nested parent live",
				"# nested parent live\n\nparent body\n",
			);
			const parentEcho = await client.query(
				`SELECT hpath FROM blocks WHERE id = ${sqlString(parent)}`,
			);
			const parentHpath = String(parentEcho[0]!.hpath);
			const result = await createDocVerified(client, probe, {
				boxId,
				title: "nested child live",
				body: "child body",
				parentId: parent,
			});
			expect(result.kind).toBe("created");
			if (result.kind !== "created") return;
			// The composed path was the parent's REAL hpath (read back from the
			// kernel, never predicted), and the stored hpath matches it.
			expect(parentHpath).toBe("/nested parent live");
			expect(result.hpath).toBe(`${parentHpath}/nested child live`);
			expect(result.hpath).toBe("/nested parent live/nested child live");
			expect(result.content).toBe("nested child live");
		},
		LIVE_TIMEOUT,
	);

	it(
		"a drifted probe refuses before any kernel call — the drift refusal lives beside the pin",
		async () => {
			const drifted: KernelProbeResult = {
				verdict: "drift",
				kernelVersion: "9.9.9-drifted",
			};
			const result = await createDocVerified(client, drifted, {
				boxId,
				title: "never minted",
				body: "never minted",
			});
			expect(result).toEqual({ kind: "drift", observed: "9.9.9-drifted" });
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Title-guard round-trip
	// -------------------------------------------------------------------

	it(
		"adversarial titles mint, store verbatim, and re-find through the guard legs (blocks.content stores them unescaped)",
		async () => {
			for (const title of ["A & B", 'say "hi"', "it's fine"]) {
				const result = await createDocVerified(client, probe, {
					boxId,
					title,
					body: `body of ${title}`,
				});
				expect(result.kind).toBe("created");
				if (result.kind !== "created") return;
				expect(result.content).toBe(title);
				// The exact guard leg re-finds the minted doc with the stored
				// form verbatim — `"` and `&` unescaped, `'` never a numeric
				// entity.
				const matches = await findTitleMatches(client, boxId, title);
				expect(matches.kind).toBe("duplicate");
				expect(matches.rows[0]!.root_id).toBe(result.docId);
				expect(matches.rows[0]!.content).toBe(title);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"the exactly-512-rune boundary mints verbatim — the create endpoint stores and addresses it unchanged",
		async () => {
			// The live pin for the superset claim: a title AT the bound mints
			// and stores verbatim, and the guard re-finds it by the stored form.
			const boundary = "x".repeat(512);
			const result = await createDocVerified(client, probe, {
				boxId,
				title: boundary,
				body: "boundary body",
			});
			expect(result.kind).toBe("created");
			if (result.kind !== "created") return;
			expect(result.content).toBe(boundary);
			expect(result.hpath).toBe(`/${boundary}`);
			const matches = await findTitleMatches(client, boxId, boundary);
			expect(matches.kind).toBe("duplicate");
			expect(matches.rows[0]!.root_id).toBe(result.docId);
		},
		LIVE_TIMEOUT,
	);

	it(
		"the create endpoint silently shortens an over-long title — stored content and hpath both truncate to the 512-rune prefix",
		async () => {
			// The create endpoint truncates the base name to 512 runes before
			// composing the hpath, so the guarded create's hpath assert cannot
			// catch an over-long title — the kernel fact the `too-long` mint
			// refusal models. The flow refuses pre-mint, so this pin reaches
			// the endpoint directly.
			const docId = await client.createDocWithMarkdown({
				notebook: boxId,
				path: `/${"y".repeat(513)}`,
				markdown: "overlong body",
			});
			await awaitIndexed(client, boxId, docId);
			expect(await rootEcho(client, boxId, docId)).toEqual({
				docId,
				title: "y".repeat(512),
				hpath: `/${"y".repeat(512)}`,
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"the create endpoint silently strips control characters from the base name — the stored title is the stripped form",
		async () => {
			// The kernel strips tabs, newlines and the Unicode line/paragraph
			// separators out of the base name before minting — the kernel fact
			// the `control-chars` mint refusal models (one mint pins the tab
			// and the line separator together).
			const docId = await client.createDocWithMarkdown({
				notebook: boxId,
				path: "/tab\tsep\u2028para",
				markdown: "stripped body",
			});
			await awaitIndexed(client, boxId, docId);
			expect(await rootEcho(client, boxId, docId)).toEqual({
				docId,
				title: "tabseppara",
				hpath: "/tabseppara",
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"the create endpoint cleans a bare dot segment out of the mint address — the stored title is substituted, never the requested form",
		async () => {
			// path.Join(dir, "..") cleans the component out of the mint
			// address, the base name goes empty, and the kernel substitutes its
			// empty-title fallback (Conf.Language(16), locale-dependent —
			// asserted as a substitution fact, not a string). The stored title
			// and hpath stay mutually consistent, so the guarded create's
			// title-normalization assert cannot see it — the kernel fact the
			// `dot-segment` mint refusal models. The flow refuses pre-mint, so
			// this pin reaches the endpoint directly.
			const docId = await client.createDocWithMarkdown({
				notebook: boxId,
				path: "/..",
				markdown: "dot-segment body",
			});
			await awaitIndexed(client, boxId, docId);
			const echoed = await rootEcho(client, boxId, docId);
			expect(echoed).toBeDefined();
			expect(echoed!.title).not.toBe("..");
			expect(echoed!.hpath).toBe(`/${echoed!.title}`);
		},
		LIVE_TIMEOUT,
	);

	it(
		"findTitleMatches classifies near for a separator variant and clear for a foreign box",
		async () => {
			// Near: the stored "guard separator live" matches the separator
			// variants of the hyphenated query.
			await createDocVerified(client, probe, {
				boxId,
				title: "guard separator live",
				body: "x",
			});
			const near = await findTitleMatches(
				client,
				boxId,
				"guard-separator-live",
			);
			expect(near.kind).toBe("near");

			// Foreign box: the same title minted in fixtureB never surfaces in
			// fixtureA's guard read — the `WHERE box = …` scoping is the
			// signature's required input.
			const other = await createDocVerified(client, probe, {
				boxId: fixtures.notebookIds.fixtureB,
				title: "guard separator live",
				body: "x",
			});
			expect(other.kind).toBe("created");
			if (other.kind !== "created") return;
			const foreign = await findTitleMatches(
				client,
				boxId,
				"guard separator live",
			);
			expect(foreign.kind).toBe("duplicate");
			expect(foreign.rows).toHaveLength(1);
			expect(foreign.rows[0]!.root_id).not.toBe(other.docId);

			const clear = await findTitleMatches(
				client,
				boxId,
				"no such title anywhere in this box",
			);
			expect(clear).toEqual({ kind: "clear", rows: [], truncated: false });
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Edit landing judgment
	// -------------------------------------------------------------------

	it(
		"judgeEditLanded certifies a live update off the post-write tree walk — immediate, no flush wait",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/edit verify live",
				"# edit verify live\n\noriginal body\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(String(docId))} AND type = 'p' LIMIT 1`,
			);
			const blockId = String(rows[0]!.id);
			// The pre-write row rides the walk (the fresh guard's evidence
			// shape) — the judgment is walk-vs-walk, never index-vs-walk.
			const preWalk = await walkBlockTree(client, docId);
			const preWrite = preWalk.blocks.find((b) => b.id === blockId);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;

			await client.updateBlock({
				id: blockId,
				data: "edited body",
			});
			// No sleep, no index poll: the tree is the authority the moment
			// the ack lands — the post-write walk reads the moved fields
			// immediately.
			const postWalk = await walkBlockTree(client, docId);
			const outcome = judgeEditLanded({
				preWrite,
				body: "edited body",
				postWalk,
			});
			expect(outcome.kind).toBe("landed");
			if (outcome.kind !== "landed") return;
			// The arm carries the post-write row's watched fields — the
			// consumer's baseline seeding needs no re-read.
			expect(outcome.stored).toEqual({
				content: "edited body",
				type: preWrite.type,
				subType: preWrite.subType,
				markdown: "edited body",
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"updateBlock preserves block IDs — a ref into the edited block still resolves",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/edit preserve live",
				"# edit preserve live\n\nbefore body\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(String(docId))} AND type = 'p' LIMIT 1`,
			);
			const blockId = String(rows[0]!.id);
			// The pre-write row rides the walk (the fresh guard's evidence
			// shape) — the judgment is walk-vs-walk, never index-vs-walk.
			const preWrite = (await walkBlockTree(client, docId)).blocks.find(
				(b) => b.id === blockId,
			);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;

			// A ref into the block about to be edited: ID preservation means it
			// still resolves after the edit — the edit below must not orphan it.
			await mintDoc(
				client,
				boxId,
				"/edit preserve referrer live",
				`# edit preserve referrer live\n\ncite: ((${blockId} "cite"))\n`,
			);

			await client.updateBlock({
				id: blockId,
				data: "after body",
			});
			const outcome = judgeEditLanded({
				preWrite,
				body: "after body",
				postWalk: await walkBlockTree(client, docId),
			});
			expect(outcome.kind).toBe("landed");
			if (outcome.kind !== "landed") return;
			// The arm carries the post-write row's watched fields (IDs
			// preserved; the tree serves the new form synchronously).
			expect(outcome.stored).toEqual({
				content: "after body",
				type: preWrite.type,
				subType: "",
				markdown: "after body",
			});

			// The same block id now carries the new content (IDs preserved); the
			// content column converges asynchronously after the edit.
			await pollUntil("edited content reaching the blocks index", async () => {
				const row = await blockInDoc(client, docId, blockId);
				return row.kind === "in-doc" && row.content === "after body";
			});
			// The ref into the edited block still resolves — it is not among
			// the workspace's invalid refs.
			const invalid = await client.listInvalidBlockRefs();
			expect(JSON.stringify(invalid)).not.toContain(blockId);
		},
		LIVE_TIMEOUT,
	);

	it(
		"a block moved to another doc between the fresh walk and the verify is absent from the complete post-write walk — concurrent-gone",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/concurrent move live",
				"# concurrent move live\n\nbody to move\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(String(docId))} AND type = 'p' LIMIT 1`,
			);
			const blockId = String(rows[0]!.id);
			// The pre-write row is the fresh walk's (the source doc still held
			// the block pre-move) — the same evidence shape editVerified's
			// guard holds.
			const preWrite = (await walkBlockTree(client, docId)).blocks.find(
				(b) => b.id === blockId,
			);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;

			await client.updateBlock({
				id: blockId,
				data: "moved and edited body",
			});

			// Kill the content race before the move: wait for the index to
			// carry the edited content, then the only thing that can change
			// under the judgment is the moved root.
			await pollUntil("edited content reaching the blocks index", async () => {
				const row = await blockInDoc(client, docId, blockId);
				return row.kind === "in-doc" && row.content === "moved and edited body";
			});

			// The concurrent move: the block relocates to a second doc after
			// the update transaction is acked. The tree endpoint is
			// synchronous, so wait for the move itself, then judge off the
			// source doc's post-write walk — the tree certifies the absence
			// immediately, no index convergence needed.
			const doc2 = await mintDoc(
				client,
				boxId,
				"/concurrent move destination",
				"# concurrent move destination\n\ndestination body\n",
			);
			await client.moveBlock({ id: blockId, parentID: doc2 });
			const tree = await client.getChildBlocks(doc2);
			expect(tree.some((b) => b.id === blockId)).toBe(true);

			// The pre-write row is the fresh walk's (the source doc still
			// held the block pre-move), and body differs from it, so the
			// judgment can never report landed — the only observable outcome
			// is the absence off the complete source-doc walk.
			const outcome = judgeEditLanded({
				preWrite,
				body: "body that was never applied",
				postWalk: await walkBlockTree(client, docId),
			});
			expect(outcome.kind).toBe("concurrent-gone");
		},
		LIVE_TIMEOUT,
	);

	it(
		"a level-only heading edit judges landed — blocks.subtype tracks heading level through updateBlock",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/edit level live",
				"# edit level live\n\n## demote target\n\nbody\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'h' AND subtype = 'h2'`,
			);
			const headingId = String(rows[0]!.id);
			const preWrite = (await walkBlockTree(client, docId)).blocks.find(
				(b) => b.id === headingId,
			);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;

			await client.updateBlock({ id: headingId, data: "### demote target" });
			const outcome = judgeEditLanded({
				preWrite,
				body: "### demote target",
				postWalk: await walkBlockTree(client, docId),
			});
			// The level lives only in subType: content carries no level marks
			// and type stays 'h' across the edit.
			expect(outcome.kind).toBe("landed");
			if (outcome.kind !== "landed") return;
			expect(outcome.stored).toEqual({
				content: "demote target",
				type: "h",
				subType: "h3",
				markdown: "### demote target",
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"a checkbox-only edit judges landed — blocks.markdown tracks checkbox state, stored - [X] uppercase",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/edit checkbox live",
				"# edit checkbox live\n\n- [ ] spike task\n- plain sibling\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'i' AND subtype = 't'`,
			);
			const itemId = String(rows[0]!.id);
			const preWrite = (await walkBlockTree(client, docId)).blocks.find(
				(b) => b.id === itemId,
			);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;
			// The pre-write markdown holds the unchecked marker; content is
			// checkbox-stripped — only markdown moves through the toggle.
			expect(preWrite.markdown).toBe("- [ ] spike task");
			expect(preWrite.content).toBe(" spike task");

			await client.updateBlock({ id: itemId, data: "- [x] spike task" });
			const outcome = judgeEditLanded({
				preWrite,
				body: "- [x] spike task",
				postWalk: await walkBlockTree(client, docId),
			});
			expect(outcome.kind).toBe("landed");
			if (outcome.kind !== "landed") return;
			// Normalization pin: the stored marker is UPPERCASE — no future
			// comparison may byte-match a submitted body against the stored form.
			expect(outcome.stored).toEqual({
				content: " spike task",
				type: "i",
				subType: "t",
				markdown: "- [X] spike task",
			});
		},
		LIVE_TIMEOUT,
	);

	it(
		"a submitted {: …} IAL suffix stores as literal block text — the attrs layer never gains the key",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/edit ial live",
				"# edit ial live\n\nplain body\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'p'`,
			);
			const paraId = String(rows[0]!.id);
			const preWrite = (await walkBlockTree(client, docId)).blocks.find(
				(b) => b.id === paraId,
			);
			expect(preWrite).toBeDefined();
			if (preWrite === undefined) return;

			await client.updateBlock({
				id: paraId,
				data: 'plain body {: custom-ial-pin="v1"}',
			});
			const postWalk = await walkBlockTree(client, docId);
			const row = postWalk.blocks.find((b) => b.id === paraId);
			expect(row).toBeDefined();
			// The suffix moves BOTH watched fields verbatim — the whitelist's
			// route-scoped coverage: there is no attribute state updateBlock can
			// move that the watched fields miss.
			expect(row?.content).toBe('plain body {: custom-ial-pin="v1"}');
			expect(row?.markdown).toBe('plain body {: custom-ial-pin="v1"}');
			expect(
				judgeEditLanded({
					preWrite,
					body: 'plain body {: custom-ial-pin="v1"}',
					postWalk,
				}).kind,
			).toBe("landed");

			// The gate for the limit side: the attrs layer and the blocks.ial
			// column never gain the key — setBlockAttrs state is invisible to
			// the comparison and unreachable from the edit flow's route.
			const attrs = await rawKernelCall("/api/attr/getBlockAttrs", {
				id: paraId,
			});
			const attrData = attrs.body as { data: Record<string, string> };
			expect(Object.keys(attrData.data).sort()).toEqual(["id", "updated"]);
			const ial = await client.query(
				`SELECT ial FROM blocks WHERE id = ${sqlString(paraId)}`,
			);
			expect(String(ial[0]!.ial)).not.toContain("custom-ial-pin");
		},
		LIVE_TIMEOUT,
	);

	it(
		"editVerified refuses absent-target on a kernel-deleted block and mutates nothing — the guard end-to-end",
		async () => {
			// The endpoint pin for the refusal the d-row wipe case premises:
			// a block the index still names (or not yet — either membership
			// falls through the same way) but the completed walk cannot emit
			// refuses BEFORE the mutation — the destructive wipe `updateBlock`
			// would ack stays unreachable through the flow, not merely loud
			// after it. (The doc's own id refuses earlier still, as `doc-id`
			// at the scoping read — the indexed d-row case.)
			const docId = await mintDoc(
				client,
				boxId,
				"/edit absent-target live",
				"# edit absent-target live\n\ndoomed para\n\nbody that must survive\n",
			);
			// The blocks index converges asynchronously behind the mint —
			// wait for it to carry the doomed para before deleting it.
			let doomedId = "";
			await pollUntil("index carrying the doomed para", async () => {
				const rows = await client.query(
					`SELECT id, content FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'p'`,
				);
				const row = rows.find((r) => String(r.content) === "doomed para");
				if (row === undefined) return false;
				doomedId = String(row.id);
				return true;
			});
			await client.deleteBlock(doomedId);
			const outcome = await editVerified(client, probe, {
				rootId: docId,
				blockId: doomedId,
				body: "wiping body",
				baseline: { kind: "never-served" },
			});
			expect(outcome.kind).toBe("absent-target");
			if (outcome.kind !== "absent-target") return;
			// The refusal carries the completed guard walk as evidence, and
			// the doc's body is intact — no `updateBlock` rode the refusal.
			expect(outcome.walk.incomplete).toBe(false);
			const after = await walkBlockTree(client, docId);
			expect(
				after.blocks.filter((b) => b.type === "p").map((b) => b.content),
			).toEqual(["body that must survive"]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"updateBlock on the walk-invisible d row ACKS a body wipe while deleteBlock refuses synchronously — the absent-target hazard class",
		async () => {
			// The wipe arm: the doc root is the one blocks row the walk never
			// emits, and updateBlock on it does NOT fail — it acks code 0 and
			// replaces the document's entire body with the submitted markdown.
			// This is the live falsifier for the absent-target refusal's premise.
			const docId = await mintDoc(
				client,
				boxId,
				"/d-row wipe live",
				"# d-row wipe live\n\npara one\n\npara two\n",
			);
			const preWalk = await walkBlockTree(client, docId);
			// The class premise: a complete walk emits nothing for the doc root.
			expect(idSet(preWalk.blocks).has(docId)).toBe(false);

			await client.updateBlock({ id: docId, data: "replacement body" });
			const wiped = await walkBlockTree(client, docId);
			const wipedParas = wiped.blocks.filter((b) => b.type === "p");
			expect(wipedParas).toHaveLength(1);
			expect(wipedParas[0]!.content).toBe("replacement body");

			// The negative arm: deleteBlock on the same class of row refuses
			// synchronously through the tree — index state irrelevant (a fresh,
			// possibly pre-flush doc id refuses identically), so the delete
			// flow carries no walk-presence guard of its own.
			const freshDocId = await client.createDocWithMarkdown({
				notebook: boxId,
				path: "/d-row delete live",
				markdown: "# d-row delete live\n\npara one\n",
			});
			await expect(client.deleteBlock(freshDocId)).rejects.toThrow(
				/document cannot be deleted as a block/,
			);
			// The refusal is pre-mutation: the fresh doc is untouched.
			const intact = await walkBlockTree(client, freshDocId);
			expect(intact.blocks.some((b) => b.type === "p")).toBe(true);
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Insert-landed judgment + the silent-DML no-op
	// -------------------------------------------------------------------

	it(
		"insertLanded certifies a live append's transaction id against the walked tree",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/insert landed live",
				"# insert landed live\n\nanchor paragraph\n",
			);
			const preWalk = await walkBlockTree(client, docId);
			const tx = await client.appendBlock({
				data: "appended by insertLanded live",
				parentID: docId,
			});
			const mintedId = newBlockIdFrom(tx);
			expect(mintedId).toBeDefined();
			expect(String(mintedId)).toMatch(/^\d{14}-[0-9a-z]+$/);
			// The tree endpoint is synchronous — no convergence wait needed.
			const postWalk = await walkBlockTree(client, docId);
			const outcome = insertLanded({ tx, preWalk, postWalk });
			expect(outcome).toEqual({ kind: "landed", blockId: mintedId });
			// The pinned response shape: the minted id serializes as the first
			// insert operation's id, and the tree carries the block under it.
			const landed = postWalk.blocks.find((b) => b.id === mintedId);
			expect(landed?.content).toBe("appended by insertLanded live");
			// The freshly minted id reaches the SQL index too (the blocks index
			// converges asynchronously after the append).
			await pollUntil(
				"appended block reaching the blocks index",
				async () =>
					String(
						(
							await client.query(
								"SELECT content FROM blocks WHERE id = " +
									sqlString(String(mintedId)),
							)
						)[0]?.content ?? "",
					) === "appended by insertLanded live",
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"a multi-paragraph markdown insert lands as exactly one doOperations entry with the whole body in its data (the insert-shape pin)",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/insert shape live",
				"# insert shape live\n\nanchor paragraph\n",
			);
			const body = "shape para one\n\n- shape item\n\nshape para three";
			const preWalk = await walkBlockTree(client, docId);
			const tx = await client.appendBlock({ data: body, parentID: docId });
			// One transaction entry, one insert operation carrying the whole
			// payload (the kernel DOM-serializes the markdown inside the op's
			// data) — so doOperations[0].id covers the whole body.
			expect(tx).toHaveLength(1);
			expect(tx[0]!.doOperations).toHaveLength(1);
			const opData = String(tx[0]!.doOperations[0]!.data);
			for (const piece of [
				"shape para one",
				"shape item",
				"shape para three",
			]) {
				expect(opData).toContain(piece);
			}
			const mintedId = newBlockIdFrom(tx);
			expect(String(mintedId)).toMatch(/^\d{14}-[0-9a-z]+$/);
			// The kernel expands the single op into one block per markdown
			// block, and the landed judgment certifies the first of them.
			const preIds = idSet(preWalk.blocks);
			const postWalk = await walkBlockTree(client, docId);
			const fresh = postWalk.blocks.filter((b) => !preIds.has(b.id));
			expect(fresh.length).toBeGreaterThanOrEqual(2);
			expect(fresh.map((b) => b.id)).toContain(mintedId);
			const outcome = insertLanded({ tx, preWalk, postWalk });
			expect(outcome).toEqual({ kind: "landed", blockId: mintedId });
		},
		LIVE_TIMEOUT,
	);

	it(
		"appendBlock accepts every markdown-mintable container kind as a write-parent (the TARGETABLE_CONTAINER_TYPES vocabulary)",
		async () => {
			// The set's members are the kernel's write-parent vocabulary
			// (IsContainerType @ 3.8.8). The table drives only the
			// markdown-mintable members — "d" is the doc root, "l"/"tab"
			// carry no heading-mintable fixture, and "mindmap"/"mindmap_item"
			// exist only after the legacy-fence migration (pinned by the walk
			// suite's migrated-mindmap case). Pinning the exact contents here
			// means a set edit fails here until its members are
			// re-checked against the kernel.
			expect([...TARGETABLE_CONTAINER_TYPES].sort()).toEqual([
				"b",
				"callout",
				"d",
				"i",
				"l",
				"mindmap",
				"mindmap_item",
				"s",
				"tab",
			]);
			const docId = await mintDoc(
				client,
				boxId,
				"/container write-parents live",
				[
					"# Doc",
					"",
					"> # In quote",
					"> quote body",
					"",
					"- item",
					"",
					"  ## In item",
					"",
					"  item body",
					"",
					"> [!NOTE] C",
					"> ## In callout",
					"> callout body",
					"",
					"{{{row",
					"# In superblock",
					"superblock body",
					"}}}",
					"",
				].join("\n"),
			);
			const pinsTree = await walkBlockTree(client, docId);
			const walk = pinsTree.blocks;
			for (const content of [
				"In quote",
				"In item",
				"In callout",
				"In superblock",
			]) {
				const target = walk.find(
					(b) => b.type === "h" && b.content === content,
				)!;
				const pinSection = sectionOf(pinsTree, target.id);
				if (pinSection.kind !== "section") continue;
				const containerId = pinSection.section.containerId;
				expect(containerId).not.toBeNull();
				const tx = await client.appendBlock({
					data: `appended to ${content}`,
					parentID: containerId!,
				});
				const mintedId = newBlockIdFrom(tx);
				expect(mintedId).toBeDefined();
				// The kernel accepted the container as a write-parent and the
				// block is its last child (the tree endpoint is synchronous).
				const { blocks: after } = await walkBlockTree(client, docId);
				const landedBlock = after.find((b) => b.id === mintedId);
				expect(landedBlock).toBeDefined();
				expect(landedBlock!.parentId).toBe(containerId);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		'silent-DML no-op pin: query/sql UPDATE/DELETE answer success and change nothing (single and mode:"multiple")',
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/dml noop live",
				"# dml noop live\n\nuntouchable paragraph\n",
			);
			const rows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(String(docId))} AND type = 'p' LIMIT 1`,
			);
			const blockId = String(rows[0]!.id);
			const res = await rawKernelCall("/api/query/sql", {
				stmt: `UPDATE blocks SET content = 'hijacked' WHERE id = '${blockId}'`,
			});
			expect(res.status).toBe(200);
			const body = res.body as { code?: number };
			expect(body.code).toBe(0);
			const still = await client.query(
				`SELECT content FROM blocks WHERE id = ${sqlString(String(blockId))}`,
			);
			expect(String(still[0]!.content)).toBe("untouchable paragraph");

			// DELETE is equally inert — raw, and again under mode:"multiple"
			// (multi-statement input): the index row survives, the tree still
			// serves the content. The endpoint is no longer a mutation vector.
			const del = await rawKernelCall("/api/query/sql", {
				stmt: `DELETE FROM blocks WHERE id = '${blockId}'`,
			});
			expect(del.status).toBe(200);
			expect((del.body as { code?: number }).code).toBe(0);
			const multi = await rawKernelCall("/api/query/sql", {
				stmt: `SELECT 1; DELETE FROM blocks WHERE id = '${blockId}'`,
				mode: "multiple",
			});
			expect(multi.status).toBe(200);
			// pi-lens-ignore: sql-injection
			const surviving = await client.query(
				`SELECT COUNT(*) AS n FROM blocks WHERE id = ${sqlString(String(blockId))}`,
			);
			expect(Number(surviving[0]!.n)).toBe(1);
		},
		LIVE_TIMEOUT,
	);
});
