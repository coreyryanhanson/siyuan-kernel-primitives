// Per-box search fan-out over the kernel's full-text search. The kernel
// shares ONE pageSize window across every `paths` entry of a call, so a
// hit-rich notebook can fill the pre-filter window and silently drop the
// other paths' matches — one scoped call per box keeps every window
// dedicated. Report-only: per-box rows plus the window evidence, never a
// refusal.

import type { SearchBlockRow, SearchClient } from "./client.js";

/** One box's search response with its window evidence:
 * - `rows` — the kernel's blocks for this box's window (kernel field
 *   names; the consumer owns any echo renames)
 * - `hidden` — matchedBlockCount beyond the window: matches the agent
 *   was not shown (computed against the raw response, pre-backstop)
 * - `dropped` — response rows whose `box` ≠ the called box: kernel
 *   contamination, reported so a scoped result can never lie silently */
export interface BoxSearchResult {
	boxId: string;
	rows: SearchBlockRow[];
	hidden: number;
	dropped: number;
}

export async function keywordSearchBoxes(
	client: SearchClient,
	input: { query: string; boxIds: string[]; pageSize: number },
): Promise<BoxSearchResult[]> {
	const results: BoxSearchResult[] = [];
	for (const boxId of input.boxIds) {
		const response = await client.fullTextSearch({
			query: input.query,
			paths: [boxId],
			pageSize: input.pageSize,
		});
		let dropped = 0;
		const rows = response.blocks.filter((block) => {
			// Backstop: unreachable against a well-behaved kernel (each call
			// was scoped to one box); the count exists for contamination.
			if (block.box !== boxId) {
				dropped++;
				return false;
			}
			return true;
		});
		results.push({
			boxId,
			rows,
			hidden: Math.max(0, response.matchedBlockCount - response.blocks.length),
			dropped,
		});
	}
	return results;
}
