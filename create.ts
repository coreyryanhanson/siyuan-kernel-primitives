// The guarded-create core — the title is judged mintable before any
// kernel call (`mintTitleProblem`), the mint is verified by by-ID asserts
// over the kernel-returned id (`createDocVerified`).

import { SiYuanApiError } from "siyuan-kernel-api";
import type { HPathClient, SqlClient } from "./client.js";
import { hPathByID } from "./byId.js";
import type { KernelProbeResult } from "./version.js";
import { sqlString } from "./sql.js";
import { STMT_HEADS } from "./stmtKind.js";
import { verifyWithinWindow } from "./convergence.js";
import {
	catchMutation,
	catchVerification,
	refuseDrift,
	type DriftFailure,
	type MutationFailure,
	type MutationPhaseFailure,
} from "./failure.js";

/** Structural client subset the guarded create needs (tests stub it). The
 * write entry's WriteKernelClient extends this, so the createDocWithMarkdown
 * contract is declared exactly once. The live-tree hpath read serves the
 * post-mint asserts — index reads cannot see a concurrent rename. */
export interface CreateKernelClient extends SqlClient, HPathClient {
	createDocWithMarkdown(params: {
		notebook: string;
		path: string;
		markdown: string;
		parentID?: string;
	}): Promise<string>;
}

function parentLookupStmt(boxId: string, parentId: string): string {
	return (
		`${STMT_HEADS["parent-lookup"]} ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(parentId)} AND type = 'd'`
	);
}

function verifiedRootStmt(boxId: string, returnedId: string): string {
	return (
		`${STMT_HEADS["verified-root"]} ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(returnedId)} AND type = 'd'`
	);
}

/** Verified-create re-reads: the kernel indexes a fresh doc asynchronously —
 * createDocWithMd resolves when the doc is in the tree, while its blocks
 * row lands via the async index queue (observed live even on an empty DB).
 * The re-reads poll the shared convergence window (convergence.ts). */

async function verifiedRoot(
	kernel: CreateKernelClient,
	boxId: string,
	returnedId: string,
): Promise<{ id: string; root_id: string; content: string } | undefined> {
	// One `undefined` — row not landed yet (poll again) or window
	// exhausted — and for the create read they collapse safely:
	// exhaustion is exactly the flow's `unconfirmable` arm.
	return verifyWithinWindow(async () => {
		const rows = (await kernel.query(verifiedRootStmt(boxId, returnedId))).map(
			(r) => ({
				id: String(r.id),
				root_id: String(r.root_id),
				content: String(r.content),
			}),
		);
		return rows[0];
	});
}

/** Outcome of the guarded create, as a closed union. Success carries the
 * evidence the create echo words itself from (docId, stored title, real
 * hpath) — a docId-only return would force a second read the poll loop
 * already performed:
 * - `created` — the mint landed and every by-ID assert passed
 * - `drift` — the required probe says the kernel is drifted (checked
 *   before any kernel call)
 * - `mint-title` — the title cannot mint verbatim; the flow runs the
 *   mint-title judgment itself, before any kernel call, and the problem
 *   rides as evidence (the kernel facts live on `MintTitleProblem`)
 * - `parent-missing` — parentId does not resolve to a doc row within the
 *   convergence window (a parent minted moments ago is polled, not refused)
 * - `ghost-intermediate` — the parent was deleted or renamed between the
 *   hpath read-back and the mint (the kernel minted a ghost intermediate;
 *   the assert rides the live tree, so a rename is seen immediately)
 * - `hpath-mismatch` — the live-tree hpath diverges from the mint address
 *   over the STORED title (parent hpath + "/" + title nested, "/" +
 *   title at root — unexpected kernel title normalization)
 * - `transport-unverified` — the mint's transport failed after the request
 *   may have been delivered
 * - `kernel-refused` — a synchronous kernel rejection (kernel-verbatim)
 * - `unconfirmable` — the by-ID row never converged inside the
 *   verification window; the mint may already exist
 * - `verification-failed` — a verification read itself failed; the mint
 *   may already exist; the cause leg carries the recovery evidence */
export type CreateDocOutcome =
	| { kind: "created"; docId: string; content: string; hpath: string }
	| DriftFailure
	| MutationPhaseFailure
	| { kind: "mint-title"; problem: MintTitleProblem }
	| { kind: "parent-missing"; parentId: string }
	| { kind: "ghost-intermediate"; parentId: string }
	| { kind: "hpath-mismatch"; stored: string; expected: string }
	| { kind: "unconfirmable"; returnedId: string }
	| (Extract<MutationFailure, { kind: "verification-failed" }> & {
			returnedId: string;
	  });

/** The pinned kernel facts of a mint title, judged before any kernel call:
 * the `/` path separator (the create endpoint mints a doc per path segment,
 * so a `/` in the title would mint a ghost intermediate doc) and the
 * truncation bound (longer titles are silently shortened — stored content
 * and hpath truncate consistently, so the guarded create's hpath assert
 * cannot catch it).
 * `control-chars` covers the characters the create endpoint silently
 * strips from the base name (`\t\n\r`, the Unicode line/paragraph
 * separators) plus the wider `\x00-\x1f\x7f` range as a storage-safety
 * superset. `dot-segment` covers the bare `.`/`..` forms the create
 * endpoint's `path.Join` cleans out of the mint address — at root level
 * the address collapses to `/`, the base name goes empty, and the kernel
 * substitutes its localized "Untitled" for it, a substitution the
 * title-normalization assert cannot see because both sides derive from
 * the stored title. Zero kernel calls. */
export type MintTitleProblem =
	| { kind: "empty" }
	| { kind: "slash"; title: string }
	| { kind: "dot-segment"; title: string }
	| { kind: "too-long"; title: string; runes: number }
	| { kind: "control-chars"; title: string };

/** The create endpoint's title truncation bound, single-sourced for
 * consumers' wording. `normalizeDocTitle` enforces no length; 512 runes
 * is the create endpoint's own cut over the control-char-stripped base
 * name (rename and doc-validation reject longer titles instead — the
 * bound is a caller check, not a normalize rule). The bound and the cut
 * are pinned live; the superset claim (surviving titles store
 * verbatim) rides the title round-trip. */
export const MINT_TITLE_MAX_RUNES = 512;

/** Judge a mint title against the kernel facts above. `undefined` means
 * the title survives verbatim (the superset claim) — the trimmed form is
 * what the caller should mint. */
export function mintTitleProblem(raw: string): MintTitleProblem | undefined {
	const title = raw.trim();
	if (title === "") return { kind: "empty" };
	if (title.includes("/")) return { kind: "slash", title };
	// Only the bare forms — `path.Join` cleans exactly these out of a path
	// component position; `a..b` and `...` survive verbatim.
	if (title === "." || title === "..") return { kind: "dot-segment", title };
	const runes = [...title].length;
	if (runes > MINT_TITLE_MAX_RUNES) return { kind: "too-long", title, runes };
	// the control-char class is deliberate (storage-safety superset over
	// the stripped set)
	// oxlint-disable-next-line no-control-regex
	if (/[\t\n\r\x00-\x1f\x7f\u2028\u2029]/.test(title))
		return { kind: "control-chars", title };
	return undefined;
}

/** The guarded-create core, whole: the mint-title judgment → parent
 * read-back → hpath composition → mint → by-ID asserts (the doc-row poll
 * loop, then the ghost and title-normalization asserts over live-tree
 * hpath ground truth — index reads cannot see a concurrent rename). One
 * temporal judgment about pinned kernel behavior — hpath as
 * the create endpoint's mint address, the parent baseline the ghost assert
 * is measured against, the transaction response shape — so none of it
 * stays tool-side. Classification rides the shared fork in failure.ts. */
export async function createDocVerified(
	client: CreateKernelClient,
	probe: KernelProbeResult,
	input: {
		boxId: string;
		title: string;
		body: string;
		parentId?: string | undefined;
	},
): Promise<CreateDocOutcome> {
	const drift = refuseDrift(probe);
	if (drift !== undefined) return drift;
	// The mint-title judgment re-runs here so an unguarded caller cannot
	// mint a hazardous title; zero kernel calls, and the judged form is
	// the exact string minted below.
	const title = input.title.trim();
	const problem = mintTitleProblem(title);
	if (problem !== undefined) return { kind: "mint-title", problem };
	// Submission path from ground truth, never predicted.
	let path: string;
	let parentID: string | undefined;
	let storedParentHpath: string | undefined;
	if (input.parentId !== undefined) {
		const parentId = input.parentId;
		// parentID resolves synchronously from the live tree (path.go), but
		// the parent's index row lands via the async queue — the same lag
		// verifiedRoot absorbs post-mint. A parent minted moments ago must
		// be polled, not refused.
		const parent = await verifyWithinWindow(
			async () =>
				(await client.query(parentLookupStmt(input.boxId, parentId)))[0],
		);
		if (parent === undefined) {
			return { kind: "parent-missing", parentId };
		}
		// Kernel invariant (3.8.8): a stored doc row's hpath is never empty
		// (createDocsByHPath0 composes it from a leading "/" plus trimmed
		// segments; the hidden box doc gets "/" + title).
		storedParentHpath = String(parent.hpath ?? "");
		path = `${storedParentHpath}/${title}`;
		parentID = parentId;
	} else {
		path = `/${title}`;
	}
	// The mint may or may not land when the transport fails — the
	// kernel-returned id is lost with the response.
	let returnedId: string;
	try {
		returnedId = await client.createDocWithMarkdown({
			notebook: input.boxId,
			path,
			markdown: input.body,
			...(parentID !== undefined ? { parentID } : {}),
		});
	} catch (err) {
		return catchMutation(err);
	}
	// Post-mint verification: by-ID asserts on the kernel-returned root
	// ID — fail-loud on shape, never a by-title re-lookup; the bounded
	// re-read absorbs the kernel's async index lag.
	try {
		const root = await verifiedRoot(client, input.boxId, returnedId);
		if (root === undefined) {
			return { kind: "unconfirmable", returnedId };
		}
		if (parentID !== undefined) {
			// The ghost assert rides the live tree (hPathByID — synchronous
			// ground truth): a rename between the read-back and the mint is
			// immediately visible, where an index re-read can serve the stale
			// hpath and pass. A vanished parent rejects with the kernel's
			// tree-not-found error, which maps to the same arm.
			let parentHpath: string;
			try {
				parentHpath = await hPathByID(client, parentID);
			} catch (err) {
				if (err instanceof SiYuanApiError && err.msg === "tree not found") {
					return { kind: "ghost-intermediate", parentId: parentID };
				}
				throw err;
			}
			if (parentHpath !== storedParentHpath) {
				return { kind: "ghost-intermediate", parentId: parentID };
			}
		}
		// The live-tree hpath must equal the mint address over the STORED
		// title — fail-loud on any kernel normalization the mint-title
		// judgment does not model.
		const expectedHpath =
			parentID !== undefined
				? `${storedParentHpath}/${root.content}`
				: `/${root.content}`;
		const liveHpath = await hPathByID(client, returnedId);
		if (liveHpath !== expectedHpath) {
			return {
				kind: "hpath-mismatch",
				stored: liveHpath,
				expected: expectedHpath,
			};
		}
		return {
			kind: "created",
			docId: root.root_id,
			content: root.content,
			hpath: liveHpath,
		};
	} catch (err) {
		return { ...catchVerification(err), returnedId };
	}
}
