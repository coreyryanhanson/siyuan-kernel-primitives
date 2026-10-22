// Fresh-content judgment over the pinned read pair: the
// getChildBlocks walk (the judgment surface — the blocks index converges
// behind a real edit, so a SQL re-read alone is blind inside that window)
// and the blocks.content seed read (the SQL-now snapshot for
// `never-served` targets). Two entries, one judgment:
// `checkFreshContent` — self-contained, takes its own vanish-tolerant
// walk — and `judgeFreshOverWalk` — the held-walk judge over a walk the
// caller already holds, the walk-carrying guards' entry. The arm logic
// lives in the held-walk entry and nowhere else. Meaningful only because
// the kernel renders both forms identically (nodeStaticContent), so a
// SQL-seeded hash compares equal against walk content; a kernel that
// ever split the forms fails closed — a diverging seed reads as stale,
// named, never silently matched. Read-only and pre-mutation: no probe,
// no error arm — kernel and transport failures propagate raw for the
// consumer's transport classification; only the kernel's
// vanished-container envelope is judged (`absence-unconfirmed`, via the
// walk's tolerated vanish).

import { createHash } from "node:crypto";
import { blockContents } from "./byId.js";
import type { ChildBlocksClient, SqlClient } from "./client.js";
import { walkBlockTree, type WalkedTree } from "./walk.js";

/** The baseline digest: first 32 hex chars (128 bits) of the SHA-256 of
 * the served content. Wide enough that a collision cannot read a
 * concurrently-edited block as `fresh` — the unsafe direction for a write
 * precondition. Single-sourced here: the tool's stored baseline hashes
 * and this judgment's comparisons must use the same digest. */
export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** Per-target outcome, in input order — every target is judged, never
 * short-circuited mid-list:
 * - `fresh` — walk content hashes to the caller's baseline (unchanged)
 * - `vanished` — absent from a COMPLETE walk (concurrent delete; a
 *   lingering blocks.content row is index lag, not life — the SQL read
 *   plays no part in this arm)
 * - `absence-unconfirmed` — absent from a walk that is incomplete (the depth
 *   bound, or a tolerated vanish): the target may sit past the bound or
 *   behind a swallowed branch, so its death cannot be confirmed (and
 *   its content cannot be hashed) — unconfirmed, never `vanished`
 * - `unseen` — a `never-served` verdict (the session never served the
 *   block): there is no stored value to launder, so adoption is the
 *   consumer's choice; a present seed row that diverges from the walk fails
 *   closed to `stale` instead
 * - `stale` — walk content hashes differently from the supplied baseline
 *   (or, on the seed path, from the SQL-now row) — a concurrent change.
 *   `compared` names the comparison that fired: "baseline" (hash vs the
 *   caller's served baseline) or "seed" (walk-vs-index divergence on a
 *   never-served target) — the consumer's wording keys on it, so the
 *   session sentence and the index-divergence sentence stay truthful
 *   without the consumer re-deriving which path ran */
export type FreshOutcome =
	| { kind: "fresh"; blockId: string; currentContent: string }
	| { kind: "vanished"; blockId: string }
	| { kind: "absence-unconfirmed"; blockId: string }
	| { kind: "unseen"; blockId: string; currentContent: string }
	| {
			kind: "stale";
			blockId: string;
			currentContent: string;
			compared: "baseline" | "seed";
	  };

/** The stale arm, as the judgment renders it — the one unsafe arm the
 * guard refuses on. The consumer's wording keys on `compared`; the
 * refusal's `stale` tuple carries these in judged order. */
export type StaleFreshArm = Extract<FreshOutcome, { kind: "stale" }>;

// The judgment's baseline verdict — "never served" is a legitimate named
// state, never a falsy default a caller can forget into.
export type ServedBaseline =
	| { kind: "served"; hash: string }
	| { kind: "never-served" };

/** The session's served-baseline verdict per block id, as a lookup — the
 * required-input shape the destroy-shaped guards' `baselineFor` inputs
 * share. The judged set derives inside the consuming primitive — its own
 * enumeration or stake derivation — and is consulted through this
 * lookup, so the caller never re-derives the set. */
export type BaselineLookup = (blockId: string) => ServedBaseline;

/** One judged target: the in-doc block id plus the session's served
 * baseline for it. Walk presence is the life/death surface: the doc root
 * is never emitted by the walk, and a walk truncated at the depth bound
 * answers `absence-unconfirmed` (never `vanished`) for targets it could
 * not see — pass block-level ids only. */
export interface FreshTarget {
	blockId: string;
	baseline: ServedBaseline;
}

export interface FreshInput {
	docId: string;
	targets: FreshTarget[];
}

/** The internal fresh-content guard's shared refusal arm — composed into
 * the guard-taking write primitives' outcome unions (declared beside the
 * judgment it projects, re-exported at ./write). The judgment refused
 * the mutation because some judged target's content diverged from the
 * baseline the caller supplied. `arms` is every judged arm in judged
 * order, so the consumer can disposition them without a second read;
 * `stale` is the judged-order stale subset, non-empty by construction.
 * `walk` is the snapshot the judgment judged over — the consumer's
 * refusal outline and its re-baseline both ride it. (`FreshRefusal`
 * carries no completeness arm: the judged set derives inside the
 * consuming primitive, so no caller-supplied keying can under-cover it —
 * a guard that needs a completeness refusal derives it from its
 * `absence-unconfirmed` arms, as the verified edit does.) */
export type FreshRefusal = {
	kind: "fresh-refused";
	arms: FreshOutcome[];
	stale: [StaleFreshArm, ...StaleFreshArm[]];
	walk: WalkedTree;
};

/** The pure projection over a judged result that every guard composes
 * (`undefined` means proceed). The family rule it encodes: a
 * destroy-shaped mutation refuses iff a judged arm provably diverged
 * (`stale`); every proceeding arm rides the refusal's `arms` when a
 * sibling refused, and carries no evidence on the ok path (the
 * mutation's own verdict carries the post-write
 * facts). `walk` is the snapshot the arms were judged over — the
 * consumer's outline and re-baseline ride it without a second read. */
export function freshRefusalOf(
	arms: FreshOutcome[],
	walk: WalkedTree,
): FreshRefusal | undefined {
	const [first, ...rest] = arms.filter(
		(arm): arm is StaleFreshArm => arm.kind === "stale",
	);
	return first === undefined
		? undefined
		: { kind: "fresh-refused", arms, stale: [first, ...rest], walk };
}

/** The held-walk judge — the arm logic over a walk the caller already
 * holds, with no walk of its own and no membership precondition: the
 * walk-carrying guards' entry, for the primitives whose judged set
 * derives from a walk in hand (the section flows derive theirs from the
 * caller-held enumeration walk; block delete fetches its stake walk and
 * judges in the same breath — the judged set can include a target the
 * complete walk answers `vanished`, the concurrent-delete fact, a
 * proceeding arm). Walk-is-the-world: the supplied walk is the sole
 * authority for what content the judgment sees. Strict over the supplied
 * walk, no tolerance pin: the callers derive their judged sets from this
 * very walk, so a row present in it is sound evidence; an incomplete
 * walk is deliberately not refused — once membership holds, presence is
 * sound, and a completeness refusal could only turn a sound judgment
 * into a refusal. (The refusal policy lives in `freshRefusalOf`, beside
 * this judgment.) The supplied walk's own tolerance mode is the
 * caller's (enumeration) concern. The seed read (the one kernel read a
 * walk-carrying guard cannot dedupe away) fires once, scoped to the
 * never-served survivors of the walk; the absence arms key on that
 * walk's completeness. The walk is also the currency horizon: a change
 * landing after the snapshot is caught only through the seed read's
 * walk-vs-index divergence (never-served targets); a held baseline does
 * not see post-walk changes here — the next judged write does, against
 * its stored hash. */
export async function judgeFreshOverWalk(
	client: SqlClient,
	targets: FreshTarget[],
	walk: WalkedTree,
): Promise<FreshOutcome[]> {
	const current = new Map(walk.blocks.map((b) => [b.id, b.content]));
	// Seed read only for never-served targets that survived the walk — the
	// vanished and baseline-held arms need no SQL row.
	const seedIds = targets
		.filter(
			(t) =>
				t.baseline.kind === "never-served" &&
				current.get(t.blockId) !== undefined,
		)
		.map((t) => t.blockId);
	const seeds = new Map(
		(await blockContents(client, seedIds)).map((r) => [r.id, r.content]),
	);
	const arms = targets.map((target): FreshOutcome => {
		const nowContent = current.get(target.blockId);
		if (nowContent === undefined) {
			// Absence is a negative fact: only a complete walk renders it as
			// `vanished`; an incomplete walk's unseen tail reads as unconfirmed.
			return walk.incomplete
				? { kind: "absence-unconfirmed", blockId: target.blockId }
				: { kind: "vanished", blockId: target.blockId };
		}
		if (target.baseline.kind === "never-served") {
			const row = seeds.get(target.blockId);
			// Seed-and-check: SQL-now vs walk-now, compared as strings (both are
			// in hand — the digest is only for caller-held baselines). An
			// under-dated row diverges from the walk → stale (fail-closed); an
			// absent row → unseen.
			if (row !== undefined && row !== nowContent) {
				return {
					kind: "stale",
					blockId: target.blockId,
					currentContent: nowContent,
					compared: "seed",
				};
			}
			return {
				kind: "unseen",
				blockId: target.blockId,
				currentContent: nowContent,
			};
		}
		if (contentHash(nowContent) !== target.baseline.hash) {
			return {
				kind: "stale",
				blockId: target.blockId,
				currentContent: nowContent,
				compared: "baseline",
			};
		}
		return {
			kind: "fresh",
			blockId: target.blockId,
			currentContent: nowContent,
		};
	});
	// The arms alone — the walk is the caller's; the self-contained entry
	// below composes the total { walk, arms } result.
	return arms;
}

/** Judge every target's content freshness against the live tree. Both
 * kernel reads happen once regardless of target count; everything after
 * is in-memory hashing. The walk tolerates the kernel's vanished-container
 * envelope (HTTP 200 / code:-1): the branch ends, the walk comes back
 * `incomplete`, and every target absent from it judges
 * `absence-unconfirmed` instead of the judgment throwing a raw
 * SiYuanApiError the consumer would misword as a transport failure —
 * absence is evidence, never silence. A vanished *target* under a
 * complete walk is still the ordinary `vanished` arm.
 * Walk-absence decides `vanished` before the SQL read is consulted, so a
 * caller whose targets all carry baselines issues one kernel read (the
 * walk), never the seed read. The walk is unconditional — even an empty
 * target list takes it, because the snapshot IS the entry's product. */
export async function checkFreshContent(
	client: SqlClient & ChildBlocksClient,
	input: FreshInput,
): Promise<{ walk: WalkedTree; arms: FreshOutcome[] }> {
	const tree = await walkBlockTree(client, input.docId, {
		tolerateVanished: true,
	});
	return {
		walk: tree,
		arms: await judgeFreshOverWalk(client, input.targets, tree),
	};
}
