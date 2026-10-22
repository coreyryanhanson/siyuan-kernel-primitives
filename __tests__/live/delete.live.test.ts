// Live pins: the verified deletes (deleteBlockVerified / deleteDocVerified).
// Sole falsification of the delete-generation fact — an absent block target
// is answered synchronously by the pinned kernel with a "tree not found"
// rejection (3.8.3 no-oped; pinned here through the
// primitive's kernel-refused arm, reached via the designed absent
// fall-through) — of the block delete's pre-mutation scoping refusal (a
// foreign id refuses before the kernel sees it; the raw-id mutation would
// otherwise destroy another doc's block behind a target-gone verdict),
// of the heading-delete scope fact the section-delete sequence rests on
// (the delete path is fold-blind: a heading delete removes ONLY the
// heading; the members survive and their ownership moves to the preceding
// heading — the fact deleteSectionVerified's delete set is built on), of
// the section-delete sequence itself (the judged arm over a live section
// with a nested subsection and a container member, and the pre-mutation
// walk-rootId provenance refusal — a caller resolving the target from
// another doc's walk refuses with zero kernel calls, no index wait), and
// of the doc-delete evidence pins: the deleted root's walk throws the
// ambiguous "block not found" class (same message an encrypted-locked
// notebook produces, and distinct from the invalid-id rejection a
// never-existed id gets), which is why the doc delete carries evidence,
// never a landing judgment. The judged arm's still-present verdict (a
// no-op generation) is unreachable live on the pinned kernel — its
// falsification stays in the stubbed unit suite. Ordered before the
// throttle file; teardown asserts zero strays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { deleteBlockVerified, deleteDocVerified } from "../../delete.js";
import { contentHash, type ServedBaseline } from "../../fresh.js";
import { deleteSectionVerified } from "../../deleteSection.js";
import { walkBlockTree, type WalkedTree } from "../../walk.js";
import { sectionOf } from "../../placement.js";
import { PINNED_SIYUAN_VERSION } from "../../version.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	mintDoc,
	pollUntil,
	setupFixtures,
	TOKEN,
} from "./harness.js";
import { sqlString } from "../../sql.js";

let fx: Awaited<ReturnType<typeof setupFixtures>>;
let client: SiYuanKernelClient;
let box: string;

/** An up-to-date probe verdict for the primitives' required probe arg —
 * the suite's setup already pinned the kernel to the exact version. */
const probe = { verdict: "ok" as const, kernelVersion: PINNED_SIYUAN_VERSION };

/** The block delete's membership read routes on the blocks index, which
 * lags a minted doc's child rows past mintDoc's doc-row wait — poll the
 * row before the primitive's pre-mutation read, or the absent
 * fall-through would route the delete through the kernel (flaking the
 * content pin, or destroying a foreign target for real). */
async function awaitBlockIndexed(
	client: SiYuanKernelClient,
	id: string,
): Promise<void> {
	await pollUntil(
		`block ${id} reaching the blocks index`,
		async () =>
			(await client.query(`SELECT id FROM blocks WHERE id = ${sqlString(id)}`))
				.length > 0,
	);
}

/** The guard's baseline verdict, minted from a live walk: the target's
 * served hash off the walk row it was resolved from, `never-served` when
 * the walk does not hold it. */
const servedOf = (blocks: WalkedTree["blocks"], id: string): ServedBaseline => {
	const row = blocks.find((b) => b.id === id);
	return row === undefined
		? { kind: "never-served" }
		: { kind: "served", hash: contentHash(row.content) };
};

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"delete primitives (live)",
	() => {
		beforeAll(async () => {
			fx = await setupFixtures();
			client = fx.client;
			box = fx.notebookIds.fixtureA;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fx === undefined) return;
			await fx.teardown();
		}, LIVE_TIMEOUT);

		it(
			"deleteBlockVerified judges the target gone from the post-delete walk, and the walk rides the judged arm as evidence",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete judged",
					"# Judged\n\nvictim paragraph\n\nkeeper paragraph\n",
				);
				const { blocks: preWalk } = await walkBlockTree(client, docId);
				const victim = preWalk.find((b) => b.content === "victim paragraph")!;
				await awaitBlockIndexed(client, victim.id);

				const outcome = await deleteBlockVerified(client, probe, {
					blockId: victim.id,
					rootId: docId,
					baselineFor: (id) => servedOf(preWalk, id),
				});
				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				expect(outcome.verdict).toEqual({ kind: "gone" });
				// The deleted block's stored content rides the verdict off
				// the pre-mutation membership read — the receipt's payload.
				expect(outcome.content).toBe("victim paragraph");
				// Evidence: the judged snapshot is the real post-delete tree —
				// the victim is absent, the rest of the doc survives.
				const postIds = new Set(outcome.postWalk.blocks.map((b) => b.id));
				expect(postIds.has(victim.id)).toBe(false);
				expect(
					outcome.postWalk.blocks.find((b) => b.content === "keeper paragraph"),
				).toBeDefined();
				// The evidence walk matches a fresh read of the same tree.
				const { blocks: fresh } = await walkBlockTree(client, docId);
				expect(new Set(fresh.map((b) => b.id))).toEqual(postIds);
			},
			LIVE_TIMEOUT,
		);

		it(
			"an absent block target rejects synchronously with the kernel-verbatim 'tree not found' — the generation pin, via the kernel-refused arm",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete generation",
					"# Generation\n\nvictim paragraph\n",
				);
				const { blocks: preWalk } = await walkBlockTree(client, docId);
				const victim = preWalk.find((b) => b.content === "victim paragraph")!;
				// The target exists, then is kernel-deleted out from under the
				// flow — exactly the stale-target race the primitive must report.
				await client.deleteBlock(victim.id);

				const outcome = await deleteBlockVerified(client, probe, {
					blockId: victim.id,
					rootId: docId,
					// The stake walk answers the vanished target (the
					// concurrent-delete fact, a proceeding arm) — the verdict
					// minted from the pre-delete walk is inert here.
					baselineFor: (id) => servedOf(preWalk, id),
				});
				// 3.8.3 answered this a silent success no-op (the walk-set
				// evidence would then report a still-present target); the pinned
				// kernel rejects synchronously and the message surfaces verbatim.
				// The membership read reports the stale target `absent` or
				// `in-doc` depending on index convergence — either way the
				// call proceeds to the kernel, never a pre-mutation refusal:
				// this pin proves the fall-through keeps the verbatim route.
				expect(outcome.kind).toBe("kernel-refused");
				if (outcome.kind !== "kernel-refused") return;
				expect(outcome.message).toContain("tree not found");
			},
			LIVE_TIMEOUT,
		);

		it(
			"a foreign block target refuses pre-mutation — the raw-id delete must not destroy another doc's block",
			async () => {
				const docA = await mintDoc(
					client,
					box,
					"/delete scoping A",
					"# Scoping A\n\ndoc A paragraph\n",
				);
				const docB = await mintDoc(
					client,
					box,
					"/delete scoping B",
					"# Scoping B\n\ndoc B paragraph\n",
				);
				const { blocks: walkB } = await walkBlockTree(client, docB);
				const victim = walkB.find((b) => b.content === "doc B paragraph")!;
				await awaitBlockIndexed(client, victim.id);

				const outcome = await deleteBlockVerified(client, probe, {
					blockId: victim.id,
					rootId: docA, // the claim: the block lives in doc A
					// Inert: the scoping refusal precedes the judgment entirely.
					baselineFor: (id) => servedOf(walkB, id),
				});
				// The kernel mutates by raw id with no doc scoping of its own;
				// the membership read is what refuses before the destruction.
				expect(outcome).toEqual({
					kind: "foreign",
					blockId: victim.id,
					rootId: docB,
				});
				// Unharmed: the block still lives in its own doc.
				const { blocks: stillThere } = await walkBlockTree(client, docB);
				expect(stillThere.some((b) => b.id === victim.id)).toBe(true);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a doc id in the blockId slot refuses pre-mutation — the block endpoint must not destroy a document",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete doc-id slot",
					"# Doc-id slot\n\nsurvivor paragraph\n",
				);
				const outcome = await deleteBlockVerified(client, probe, {
					blockId: docId,
					rootId: docId,
					// Inert: the scoping refusal precedes the judgment entirely.
					baselineFor: () => ({ kind: "never-served" }),
				});
				expect(outcome).toEqual({ kind: "doc-id", blockId: docId });
				// Unharmed: the doc and its blocks survive the refused call.
				const { blocks: after } = await walkBlockTree(client, docId);
				expect(after.some((b) => b.content === "survivor paragraph")).toBe(
					true,
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"a heading delete removes only the heading — the section members survive and their ownership moves to the preceding heading",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete heading scope",
					"# First\n\nfirst body\n\n# Second\n\nsecond body\n",
				);
				const pre = await walkBlockTree(client, docId);
				const first = pre.blocks.find(
					(b) => b.type === "h" && b.content === "First",
				)!;
				const second = pre.blocks.find(
					(b) => b.type === "h" && b.content === "Second",
				)!;
				// Pre-state: Second's section holds exactly its body paragraph.
				const section = sectionOf(pre, second.id);
				expect(section.kind).toBe("section");
				if (section.kind !== "section") return;
				expect(section.section.members.map((b) => b.content)).toEqual([
					"second body",
				]);

				await client.deleteBlock(second.id);
				const post = await walkBlockTree(client, docId);
				expect(post.incomplete).toBe(false);
				// Fold-blind: the heading is gone, its member survived it.
				expect(post.blocks.some((b) => b.id === second.id)).toBe(false);
				const orphan = post.blocks.find((b) => b.content === "second body")!;
				// The tree parent is unchanged — the re-parenting is outline/
				// section ownership, not a tree-parent change (no arm may be
				// designed around one).
				expect(orphan.parentId).toBeNull();
				expect(orphan.parentType).toBe("d");
				// Ownership moved: the orphan is now the preceding heading's member.
				const moved = sectionOf(post, first.id);
				expect(moved.kind).toBe("section");
				if (moved.kind !== "section") return;
				expect(moved.section.members.map((b) => b.id)).toContain(orphan.id);
			},
			LIVE_TIMEOUT,
		);

		it(
			"deleteSectionVerified removes the whole section — members first (nested subsection and container included), heading last — and the judged walk certifies the absence of the issued set and its cascaded descendants",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete section judged",
					[
						"# Target",
						"",
						"body one",
						"",
						"- item with children",
						"    - child A",
						"    - child B",
						"",
						"## Nested",
						"",
						"nested body",
						"",
						"# Next",
						"",
						"next body",
						"",
					].join("\n"),
				);
				const pre = await walkBlockTree(client, docId);
				const target = pre.blocks.find(
					(b) => b.type === "h" && b.content === "Target",
				)!;
				await awaitBlockIndexed(client, target.id);
				const section = sectionOf(pre, target.id);
				expect(section.kind).toBe("section");
				if (section.kind !== "section") return;
				// The section's members in document order: body one, the list
				// container (child A/B are its descendants — cascade-covered,
				// never issued), the nested subsection heading, its body.
				const members = section.section.members;
				expect(members).toHaveLength(4);
				expect(members[0]!.content).toBe("body one");
				expect(members[3]!.content).toBe("nested body");
				const childA = pre.blocks.find((b) => b.content === "child A")!.id;
				const childB = pre.blocks.find((b) => b.content === "child B")!.id;

				// The guard's judged stake: the heading first, then the closure
				// in document order — every judged id mints `served` from the
				// walk's own content, so the judgment rides hash comparison and
				// the seed read never fires.
				const outcome = await deleteSectionVerified(client, probe, {
					rootId: docId,
					walk: pre,
					headingId: target.id,
					baselineFor: (id) => servedOf(pre.blocks, id),
				});
				expect(outcome.kind).toBe("judged");
				if (outcome.kind !== "judged") return;
				const verdict = outcome.verdict;
				if (verdict.kind !== "judged") return;
				expect(verdict.postWalk.incomplete).toBe(false);
				const postIds = new Set(verdict.postWalk.blocks.map((b) => b.id));
				// Every issued id is gone — the members and the heading.
				for (const id of [target.id, ...members.map((m) => m.id)]) {
					expect(postIds.has(id)).toBe(false);
				}
				// The cascade-covered descendants that were never issued are
				// gone too.
				expect(postIds.has(childA)).toBe(false);
				expect(postIds.has(childB)).toBe(false);
				// The section after the target is untouched.
				const next = verdict.postWalk.blocks.find(
					(b) => b.type === "h" && b.content === "Next",
				)!;
				expect(next).toBeDefined();
				// The judged snapshot matches a fresh read of the same tree.
				const { blocks: fresh } = await walkBlockTree(client, docId);
				expect(new Set(fresh.map((b) => b.id))).toEqual(postIds);
				// The deleted members did not fold into the following section:
				// "Next" holds exactly its own body.
				const nextSection = sectionOf(verdict.postWalk, next.id);
				expect(nextSection.kind).toBe("section");
				if (nextSection.kind !== "section") return;
				expect(nextSection.section.members.map((b) => b.content)).toEqual([
					"next body",
				]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"deleteSectionVerified refuses a cross-doc heading pre-mutation — the walk-rootId provenance check, zero kernel calls",
			async () => {
				const docA = await mintDoc(
					client,
					box,
					"/delete section scoping A",
					"# Scoping A\n\nanchor paragraph\n",
				);
				const docB = await mintDoc(
					client,
					box,
					"/delete section scoping B",
					"# Scoping B\n\n## Foreign target\n\nforeign body\n",
				);
				const pre = await walkBlockTree(client, docB);
				const foreignHeading = pre.blocks.find(
					(b) => b.type === "h" && b.content === "Foreign target",
				)!;

				const outcome = await deleteSectionVerified(client, probe, {
					rootId: docA, // the claim: the heading lives in doc A
					walk: pre, // doc B's walk — the mismatch the walk's own root catches
					headingId: foreignHeading.id,
					// The provenance check precedes the guard — the lookup is
					// never consulted; minted from the walk to satisfy the input.
					baselineFor: (id) => servedOf(pre.blocks, id),
				});
				// The kernel mutates by raw id with no doc scoping of its own;
				// the mismatch is judged from the walk itself — no index read,
				// no convergence wait, nothing applied.
				expect(outcome).toEqual({
					kind: "refused",
					refusal: {
						kind: "foreign",
						blockId: foreignHeading.id,
						rootId: docB,
					},
				});
				// Unharmed: the whole foreign section survives the refused call.
				const { blocks: after } = await walkBlockTree(client, docB);
				expect(after.some((b) => b.id === foreignHeading.id)).toBe(true);
				expect(after.some((b) => b.content === "foreign body")).toBe(true);
			},
			LIVE_TIMEOUT,
		);

		it(
			"deleteDocVerified returns the pre-delete walk as evidence with no landing judgment — the deleted root's walk throws the ambiguous 'block not found' error, distinct from a never-existed id's",
			async () => {
				const docId = await mintDoc(
					client,
					box,
					"/delete doc",
					"# Doc target\n\ndoc body paragraph\n",
				);

				const outcome = await deleteDocVerified(client, probe, {
					docId,
				});
				expect(outcome.kind).toBe("mutated");
				if (outcome.kind !== "mutated") return;
				// Evidence: the pre-delete walk captured the doc's child block
				// set — heading and body — before any of it vanished. (The walk
				// starts at getChildBlocks, so the root block itself is never in
				// its own walk — the same pinned fact the doc-move judgment
				// rides; the root's deletion is the mutation this call made.)
				expect(
					outcome.preWalk.blocks.find(
						(b) => b.content === "doc body paragraph",
					),
				).toBeDefined();
				expect(
					outcome.preWalk.blocks.find(
						(b) => b.type === "h" && b.content === "Doc target",
					),
				).toBeDefined();

				// Why no landing judgment: the only structural read of the
				// deleted root throws a kernel error whose message is shared
				// with the locked-encrypted-notebook class — not decidable as
				// "deleted" without risking false positives.
				await expect(walkBlockTree(client, docId)).rejects.toThrow(
					/block not found/,
				);
				// A never-existed id gets a different rejection ("invalid ID
				// argument"), so the deleted-doc error is a real pinned shape,
				// just not a usable verdict signal.
				const bogus = "20260101120000-bogus0000000000000000000000000000000";
				await expect(walkBlockTree(client, bogus)).rejects.toThrow(
					/invalid ID argument/,
				);
				// exportMarkdown is no signal either: it answers an empty
				// success for the deleted doc, indistinguishable from a doc
				// with no content by shape alone.
				const md = await client.exportMarkdown(docId);
				expect(md.content).toBe("");
				expect(md.hPath).toBe("");
			},
			LIVE_TIMEOUT,
		);
	},
);
