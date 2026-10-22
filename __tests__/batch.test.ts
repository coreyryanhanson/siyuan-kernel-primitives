// Unit cases for the batched-route foundation (`batch.ts`) — the
// judgment-free pair, one transaction over a pre-derived op array then the
// fresh post-write walks. The helper owns the transport-phase fact as the
// outcome's two failure arms: a `transact` throw is `transact-failed`
// (no ack — the raw error rides the arm for the caller's gate to
// classify), a walk failure after the ack is `walk-failed`, and walks
// pass through untouched (completeness facts are the mode's judgment
// inputs, never judged here).

import { describe, expect, it } from "vitest";
import { transactThenWalk, type TransactKernelClient } from "../batch.js";
import { queryClient, deepChain, type QueryClientRoutes } from "./readStub.js";
import { row } from "./sectionStub.js";

function stub(
	children: Record<string, Record<string, unknown>[]>,
	transactImpl: () => Promise<void> = async () => {},
	getChildBlocks?: QueryClientRoutes["getChildBlocks"],
): {
	client: TransactKernelClient;
	transactions: unknown[];
	walked: string[];
} {
	const transactions: unknown[] = [];
	const walked: string[] = [];
	return {
		transactions,
		walked,
		client: {
			...queryClient({
				getChildBlocks:
					getChildBlocks ??
					((id) => {
						walked.push(id);
						return children[id] ?? [];
					}),
			}),
			async transact(tx) {
				transactions.push(tx);
				await transactImpl();
				// The echo is a hint, never evidence — the stub serves an empty
				// one (nothing consumes it).
				return [];
			},
		},
	};
}

const OPS = [
	{ action: "delete", id: "m-1", parentID: "d-root" },
	{ action: "delete", id: "h-1", parentID: "d-root" },
];

describe("transactThenWalk", () => {
	it("issues one transaction carrying the ops verbatim, then walks each touched doc in order", async () => {
		const { client, transactions, walked } = stub({
			"d-root": [row("kept")],
			"d-other": [],
		});
		const outcome = await transactThenWalk(client, {
			operations: OPS,
			rootIds: ["d-root", "d-other"],
		});
		expect(transactions).toEqual([[{ doOperations: OPS }]]);
		expect(walked).toEqual(["d-root", "d-other"]);
		expect(outcome).toEqual({
			kind: "walked",
			walks: [
				{
					blocks: [{ ...row("kept"), parentId: null, parentType: "d" }],
					rootId: "d-root",
					truncated: false,
					incomplete: false,
				},
				{ blocks: [], rootId: "d-other", truncated: false, incomplete: false },
			],
		});
	});

	it("a transact throw is the transact-failed arm and no walk is attempted", async () => {
		const err = new Error("connection reset");
		const { client, walked } = stub({}, async () => {
			throw err;
		});
		const outcome = await transactThenWalk(client, {
			operations: OPS,
			rootIds: ["d-root"],
		});
		expect(outcome).toEqual({ kind: "transact-failed", error: err });
		expect(walked).toEqual([]);
	});

	it("a walk failure after the ack is the walk-failed arm, not a throw", async () => {
		const err = new Error("walk down");
		const { client, transactions } = stub({}, undefined, () => {
			throw err;
		});
		const outcome = await transactThenWalk(client, {
			operations: OPS,
			rootIds: ["d-root"],
		});
		expect(transactions).toEqual([[{ doOperations: OPS }]]);
		expect(outcome).toEqual({ kind: "walk-failed", error: err });
	});

	it("an incomplete walk passes through untouched — the judgment is the mode's", async () => {
		// A container chain deep enough to trip the walk's depth bound: the
		// helper must neither refuse nor judge — the mode reads `incomplete`.
		const children: Record<string, Record<string, unknown>[]> = {};
		deepChain(children, "d-root");
		const { client } = stub(children);
		const outcome = await transactThenWalk(client, {
			operations: OPS,
			rootIds: ["d-root"],
		});
		expect(outcome.kind).toBe("walked");
		if (outcome.kind !== "walked") return;
		expect(outcome.walks[0].truncated).toBe(true);
		expect(outcome.walks[0].incomplete).toBe(true);
	});
});
