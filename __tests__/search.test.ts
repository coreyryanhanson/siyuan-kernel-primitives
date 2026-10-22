// Per-box search fan-out unit cases — the shared-window premise the module
// exists for (one scoped call per box, never a shared paths list), the
// contamination backstop (a response row whose box ≠ the called box is
// filtered from rows and counted in dropped), and the hidden clamp (a
// matchedBlockCount below the returned rows is never a negative surplus).

import { describe, expect, it } from "vitest";
import type { SearchBlockRow } from "../client.js";
import { keywordSearchBoxes } from "../search.js";
import { queryClient } from "./readStub.js";

const row = (id: string, box: string): SearchBlockRow => ({
	id,
	rootID: "d-root",
	box,
	hPath: "/doc",
	updated: "20260101120000",
});

describe("keywordSearchBoxes", () => {
	it("issues one scoped call per box, each window dedicated", async () => {
		const searches: { query: string; paths: string[]; pageSize: number }[] = [];
		const client = queryClient({
			fullTextSearch: async (params) => {
				searches.push(params);
				return {
					blocks: [row("b1", params.paths[0]!)],
					matchedBlockCount: 1,
				};
			},
		});
		const results = await keywordSearchBoxes(client, {
			query: "docker",
			boxIds: ["nb-a", "nb-b"],
			pageSize: 32,
		});
		expect(searches).toEqual([
			{ query: "docker", paths: ["nb-a"], pageSize: 32 },
			{ query: "docker", paths: ["nb-b"], pageSize: 32 },
		]);
		expect(results.map((r) => r.boxId)).toEqual(["nb-a", "nb-b"]);
		expect(results.map((r) => r.rows.map((b) => b.id))).toEqual([
			["b1"],
			["b1"],
		]);
		expect(results.map((r) => r.hidden)).toEqual([0, 0]);
		expect(results.map((r) => r.dropped)).toEqual([0, 0]);
	});

	it("a response row from another box is contamination: filtered, counted, never silent", async () => {
		const client = queryClient({
			fullTextSearch: async () => ({
				blocks: [row("b-ours", "nb-a"), row("b-foreign", "nb-other")],
				matchedBlockCount: 2,
			}),
		});
		const [result] = await keywordSearchBoxes(client, {
			query: "docker",
			boxIds: ["nb-a"],
			pageSize: 32,
		});
		expect(result!.rows.map((b) => b.id)).toEqual(["b-ours"]);
		expect(result!.dropped).toBe(1);
		expect(result!.hidden).toBe(0);
	});

	it("matchedBlockCount beyond the window reads as hidden, never below zero", async () => {
		const surplus = queryClient({
			fullTextSearch: async () => ({
				blocks: [row("b1", "nb-a")],
				matchedBlockCount: 4,
			}),
		});
		const [a] = await keywordSearchBoxes(surplus, {
			query: "docker",
			boxIds: ["nb-a"],
			pageSize: 1,
		});
		expect(a!.hidden).toBe(3);

		const contaminated = queryClient({
			fullTextSearch: async () => ({
				blocks: [row("b1", "nb-a"), row("b-foreign", "nb-other")],
				matchedBlockCount: 1,
			}),
		});
		const [b] = await keywordSearchBoxes(contaminated, {
			query: "docker",
			boxIds: ["nb-a"],
			pageSize: 32,
		});
		// The clamp is computed against the raw response, pre-backstop.
		expect(b!.hidden).toBe(0);
	});
});
