// Notebook-resolution judgment over the kernel's lsNotebooks listing.
// Pure — no kernel client; the caller already holds the list. The encrypted
// leg branches on a pinned kernel fact: `encrypted` is always present in
// the listing regardless of lock state, so ONE problem kind covers both
// lock states. A kernel that dropped the flag would read an encrypted box
// as plain and slip it into the valid set.

import type { NotebookList } from "siyuan-kernel-api";

/** Why a configured KB did not join the valid set. */
export type NotebookProblem =
	| { kind: "missing"; name: string; notebookId: string }
	| { kind: "encrypted"; name: string; notebookId: string };

export interface ResolvedNotebooks {
	/** Configured KB name → notebook id, for every notebook found on the
	 * kernel and not encrypted. */
	valid: Map<string, string>;
	/** One entry per dropped KB, in the configured order. */
	problems: NotebookProblem[];
}

/** Match the configured KBs against the listing and judge each. Unknown
 * names and encrypted boxes are dropped with a problem; everything else
 * joins the valid set. What a dropped KB means for the session (warn,
 * degrade, refuse) is the consumer's policy, never this file's. */
export function resolveNotebooks(
	configured: readonly { name: string; notebook: string }[],
	list: NotebookList,
): ResolvedNotebooks {
	const byId = new Map(list.notebooks.map((n) => [n.id, n]));
	const valid = new Map<string, string>();
	const problems: NotebookProblem[] = [];
	for (const kb of configured) {
		const notebook = byId.get(kb.notebook);
		if (notebook === undefined) {
			problems.push({
				kind: "missing",
				name: kb.name,
				notebookId: kb.notebook,
			});
		} else if (notebook.encrypted) {
			problems.push({
				kind: "encrypted",
				name: kb.name,
				notebookId: kb.notebook,
			});
		} else {
			valid.set(kb.name, kb.notebook);
		}
	}
	return { valid, problems };
}
