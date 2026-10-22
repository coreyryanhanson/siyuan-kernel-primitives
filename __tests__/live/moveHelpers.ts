// Helpers shared by the move live files — the per-id pins
// (move.live.test.ts) and the batched section move's pins
// (moveSection.live.test.ts) over the same fixture scaffold.
import { expect } from "vitest";
import type { MoveVerifiedOutcome } from "../../move.js";
import type { WalkedBlock, WalkedTree } from "../../walk.js";
import { rawKernelCall } from "./harness.js";

export const heading = (walk: WalkedBlock[], content: string): WalkedBlock =>
	walk.find((b) => b.type === "h" && b.content === content)!;

export async function setFold(blockId: string, fold: boolean): Promise<void> {
	const res = await rawKernelCall("/api/attr/setBlockAttrs", {
		id: blockId,
		attrs: { fold: fold ? "1" : "" },
	});
	expect(res.status).toBe(200);
	// A refused attr write answers 200 + code -1 — silently leaving every
	// fold cell unfolded and the fold matrix passing without exercising
	// anything; the envelope code is the refusal signal.
	expect((res.body as { code: number } | undefined)?.code).toBe(0);
}

/** Small settle after IAL/insert writes — the fold and
 * the concurrent append are read by the kernel's op execution, and the
 * writes are committed before their response, so this is insurance only. */
export const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 300));

export const byContent = (walk: WalkedTree, content: string): WalkedBlock =>
	walk.blocks.find((b) => b.content === content)!;

/** The sibling run of one container in document order, as ids. */
export const idOrder = (walk: WalkedTree, containerId: string | null) =>
	walk.blocks.filter((b) => b.parentId === containerId).map((b) => b.id);

/** The document root's sibling run in document order, as contents. */
export const rootContent = (walk: WalkedTree): string[] =>
	walk.blocks.filter((b) => b.parentId === null).map((b) => b.content);

/** The root-level container row whose subtree holds `content` — container
 * rows mirror their children's concatenated text and list items nest their
 * own paragraphs, so the container is keyed on any descendant row and
 * resolved upward to the root-level row. */
export const containerOf = (walk: WalkedTree, content: string): WalkedBlock => {
	const byId = new Map(walk.blocks.map((b) => [b.id, b]));
	let row = walk.blocks.find((b) => b.content === content)!;
	for (;;) {
		const parent = row.parentId === null ? undefined : byId.get(row.parentId);
		if (parent === undefined) return row;
		row = parent;
	}
};

/** Narrow the two-route entry's wrapper to the section route, then unwrap
 * the sequence's phase wrapper (refused → refusal, unverified → outcome,
 * judged → verdict) — the assertions key on the arm shapes; the phase is
 * structural in the union. The pre-dispatch refusals (drift, foreign)
 * ride the move wrapper's top level — they are not section-route outcomes
 * either. */
export function expectSectionRoute(outcome: MoveVerifiedOutcome) {
	if (outcome.kind !== "section") {
		// The failure arms can carry full post-write walks — keep them out
		// of the message.
		throw new Error(
			`dispatch left the section route: ${JSON.stringify(
				outcome,
				(key, value) => (key.endsWith("Walk") ? undefined : value),
			)}`,
		);
	}
	const phase = outcome.outcome;
	switch (phase.kind) {
		case "refused":
			return phase.refusal;
		case "unverified":
			return phase.outcome;
		case "judged":
			return phase.verdict;
	}
}
