import { describe, expect, it } from "vitest";
import type { NotebookList } from "siyuan-kernel-api";
import { resolveNotebooks } from "../notebooks.js";

function row(
	overrides: Partial<NotebookList["notebooks"][number]> = {},
): NotebookList["notebooks"][number] {
	return {
		id: "nb-x",
		name: "n",
		encrypted: false,
		unlocked: true,
		closed: false,
		...overrides,
	} as NotebookList["notebooks"][number];
}

function list(rows: NotebookList["notebooks"][number][]): NotebookList {
	return { notebooks: rows } as NotebookList;
}

const configured = [
	{ name: "plain-kb", notebook: "nb-plain" },
	{ name: "gone-kb", notebook: "nb-gone" },
	{ name: "enc-kb", notebook: "nb-enc" },
];

describe("resolveNotebooks", () => {
	it("splits configured KBs into the valid set and ordered problems", () => {
		const { valid, problems } = resolveNotebooks(
			configured,
			list([row({ id: "nb-plain" }), row({ id: "nb-enc", encrypted: true })]),
		);
		expect([...valid]).toEqual([["plain-kb", "nb-plain"]]);
		expect(problems).toEqual([
			{ kind: "missing", name: "gone-kb", notebookId: "nb-gone" },
			{ kind: "encrypted", name: "enc-kb", notebookId: "nb-enc" },
		]);
	});

	it("the encrypted problem kind covers both lock states — the flag never hides", () => {
		// One rejection for locked and unlocked: `encrypted` is present and
		// true regardless of the `unlocked` value (pinned live).
		for (const unlocked of [true, false]) {
			const { valid, problems } = resolveNotebooks(
				[{ name: "enc-kb", notebook: "nb-enc" }],
				list([row({ id: "nb-enc", encrypted: true, unlocked })]),
			);
			expect(valid.size).toBe(0);
			expect(problems).toEqual([
				{ kind: "encrypted", name: "enc-kb", notebookId: "nb-enc" },
			]);
		}
	});

	it("an empty listing drops everything as missing; empty config yields empty everything", () => {
		const dropped = resolveNotebooks(configured, list([]));
		expect(dropped.valid.size).toBe(0);
		expect(dropped.problems).toHaveLength(3);
		expect(resolveNotebooks([], list([row()])).valid.size).toBe(0);
	});
});
