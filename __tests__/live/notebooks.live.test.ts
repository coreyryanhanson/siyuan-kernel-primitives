// Live encrypted-notebook pin — the kernel fact the notebook-resolution
// judgment branches on: `encrypted` is present and accurate in lsNotebooks
// output in BOTH lock states (locked and unlocked), so one rejection covers
// both. Falsified beside the branch that depends on it (resolveNotebooks in
// notebooks.ts). Needs SIYUAN_ENCRYPTED_PASSWORD and an encryption-enabled
// workspace (the one-time enable is a user action in SiYuan's own UI — this
// package never manages the key domain). Opt-in with SIYUAN_INTEGRATION=1.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { resolveNotebooks } from "../../notebooks.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

const ENCRYPTED_PASSWORD = process.env.SIYUAN_ENCRYPTED_PASSWORD ?? "";

describe.skipIf(!INTEGRATION || TOKEN === "")("notebook resolution", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;
	let baselineCount: number;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
		baselineCount = (await client.listNotebooks()).notebooks.length;
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"encrypted:true in both lock states — resolveNotebooks drops the box either way, plain coexists",
		{ timeout: 180_000 },
		async (ctx) => {
			const status = await client.getEncryptedNotebookStatus();
			if (!status.enabled || ENCRYPTED_PASSWORD === "") {
				ctx.skip();
				return;
			}

			const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
			// Typed createEncryptedNotebook: the box comes back mounted/unlocked.
			const enc = await client.createEncryptedNotebook(
				`primitives-it-enc-${stamp}`,
				ENCRYPTED_PASSWORD,
			);
			const plain = await client.createNotebook(`primitives-it-plain-${stamp}`);
			await client.openNotebook(plain.id);

			// Best-effort removals on any failure path — removeNotebook works
			// on encrypted boxes in either lock state, so teardown cannot
			// strand a fixture.
			const cleanup = async () => {
				await client.removeNotebook(enc.id);
				await client.removeNotebook(plain.id);
			};
			try {
				const configured = [
					{ name: "enc-kb", notebook: enc.id },
					{ name: "plain-kb", notebook: plain.id },
					{ name: "gone-kb", notebook: "nb-never-existed" },
				];

				// Lock state A — unlocked, as created.
				const unlockedRow = (await client.listNotebooks()).notebooks.find(
					(n) => n.id === enc.id,
				);
				expect(unlockedRow?.encrypted).toBe(true);
				expect(unlockedRow?.unlocked).toBe(true);
				const unlocked = resolveNotebooks(
					configured,
					await client.listNotebooks(),
				);
				expect([...unlocked.valid]).toEqual([["plain-kb", plain.id]]);
				expect(unlocked.problems).toEqual([
					{ kind: "encrypted", name: "enc-kb", notebookId: enc.id },
					{ kind: "missing", name: "gone-kb", notebookId: "nb-never-existed" },
				]);

				// Lock it (typed closeNotebook — the kernel's locked state: cached
				// key cleared, per-box db closed): still encrypted, now locked —
				// the always-present-flag pin, the drift direction the branch
				// fails loud on.
				await client.closeNotebook(enc.id);
				const lockedRow = (await client.listNotebooks()).notebooks.find(
					(n) => n.id === enc.id,
				);
				expect(lockedRow?.encrypted).toBe(true);
				expect(lockedRow?.unlocked).toBe(false);
				const locked = resolveNotebooks(
					configured,
					await client.listNotebooks(),
				);
				expect([...locked.valid]).toEqual([["plain-kb", plain.id]]);
				expect(locked.problems[0]).toEqual({
					kind: "encrypted",
					name: "enc-kb",
					notebookId: enc.id,
				});

				// Recovery: typed unlockAndOpenNotebook + password re-mounts the
				// box; the row reports it unlocked again (still encrypted — the
				// flag never hides).
				await client.unlockAndOpenNotebook(enc.id, ENCRYPTED_PASSWORD);
				const reopened = (await client.listNotebooks()).notebooks.find(
					(n) => n.id === enc.id,
				);
				expect(reopened?.encrypted).toBe(true);
				expect(reopened?.unlocked).toBe(true);
			} finally {
				await cleanup();
			}
			const remaining = (await client.listNotebooks()).notebooks.length;
			expect(remaining).toBe(baselineCount);
		},
	);
});
