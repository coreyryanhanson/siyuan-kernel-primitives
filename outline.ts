// The canonical extended outline notation over a block-tree walk:
// SiYuan's heading tree plus what the kernel's own outline does not carry —
// container glyphs, write-targetability marks, and the `→ <id>` block
// anchors the write flows echo back. Pure projection: no kernel calls, no
// session state, deterministic. Consumers may render their own projection
// from the same WalkedBlock data; this is the default notation, not the
// only one. Serving policy (baseline seeding, the inline cap, spilling)
// stays with the consumer.

import { headingLevel, headingRows } from "./heading.js";
import { isTargetableContainer } from "./containers.js";
import { byIdMap, type WalkedBlock, type WalkedTree } from "./walk.js";

/** Container glyph table, glued to the level marks: markdown-native
 * symbols where the container exists in markdown (`>` quote, `-` list/
 * item), the wire type's letter where SiYuan-specific (`c` callout, `s`
 * superblock, `t` tab), and a bracketed token for a container with no
 * defined glyph (`[tabs]`, a refused kind). No token contains `#`, so
 * the trailing run of `#` before the first space is always the level.
 *
 * Internal data (only `renderExtendedOutlineLines` is public), frozen so
 * no in-repo code can rewrite the notation in-process. The coupling it
 * holds with the write-side container pin: every type the primitives
 * accept as a write parent must have a defined glyph here. */
export const CONTAINER_GLYPHS: { readonly [type: string]: string } =
	Object.freeze({
		b: ">",
		callout: "c",
		l: "-",
		i: "-",
		s: "s",
		tab: "t",
		tabs: "[tabs]",
		// The map `m`; its branched item `+` — the branching counterpart of the
		// list item's `-`, for a radial topology. Single distinct characters
		// keep the unseparated concatenation unambiguous.
		mindmap: "m",
		mindmap_item: "+",
		d: "",
	});

/** Glyph for one enclosing block: the table hit, or — for a targetable
 * type the table has not learned yet — the wire type itself, never
 * `[unnamed]`, which would misrepresent a writable container. */
function containerPrefix(c: WalkedBlock): string {
	const glyph = CONTAINER_GLYPHS[c.type];
	if (glyph !== undefined) return glyph;
	return isTargetableContainer(c.type) ? `[${c.type}]` : "[unnamed]";
}

/** Extended outline lines from a walk already in hand — pure:
 * level marks + the container prefix outermost-first + the `→ <id>`
 * payload + `(not targetable)` on refused kinds. No sessionId, no
 * baselines, no spill. This is the rendering that must never diverge from
 * the section rule (`headingLevel` is shared with it; the placement corpus
 * pins the rule). Takes the whole WalkedTree, never a bare block list:
 * the incompleteness fact rides the render call, so a consumer's echo
 * cannot drop it and serve a partial doc's prefix as the whole outline.
 * The returned `incomplete` is the walk's fact verbatim. */
export function renderExtendedOutlineLines(tree: WalkedTree): {
	lines: string[];
	incomplete: boolean;
} {
	const walk = tree.blocks;
	const headings = headingRows(walk);
	const byId = byIdMap(walk);
	const lines = headings.map((h) => {
		const level = headingLevel(h);
		// The enclosing container chain, innermost first, from exact parentage
		// (headings are never recursed into, so every ancestor is a container).
		const chain: WalkedBlock[] = [];
		for (
			let c = h.parentId ? byId.get(h.parentId) : undefined;
			c;
			c = c.parentId ? byId.get(c.parentId) : undefined
		) {
			chain.push(c);
		}
		// Rendered outermost-first; a list directly wrapping the item renders
		// through the item's bullet, not a second one. Targetability reads the
		// immediate parent only — the same block CheckContainerParent validates.
		const prefixes: string[] = [];
		for (let i = chain.length - 1; i >= 0; i--) {
			const c = chain[i];
			if (!c) continue;
			// chain is innermost-first: the item inside this list sits at i-1.
			if (c.type === "l" && chain[i - 1]?.type === "i") continue;
			prefixes.push(containerPrefix(c));
		}
		const targetable = isTargetableContainer(h.parentType ?? "");
		return `${prefixes.join("")}${"#".repeat(level)} ${h.content} → ${h.id}${targetable ? "" : " (not targetable)"}`;
	});
	return { lines, incomplete: tree.incomplete };
}
