// The kernel's container vocabulary — the wire `type` values whose blocks
// are containers, declared once and derived from everywhere (the walk's
// recursion gate, the write-parent targetability check, the outline's
// `(not targetable)` mark). Leaf module: no imports.

/** The container kinds a section-targeted write may anchor in — the
 * kernel's `IsContainerType` set (kernel/treenode/blocktree.go @ 3.8.8:
 * "d","b","l","i","s","callout","tab","mindmap","mindmap_item"; mindmaps
 * reach real trees as retyped legacy ```mindmap fences,
 * kernel/model/list_mindmap_migration.go) MINUS `tabs` — a deliberate
 * local restriction, not a kernel refusal: `CheckContainerParent` rides
 * `IsContainerType` and accepts `tabs`, but a `NodeTabs` wrapper can only
 * hold tab items (`CanContainBlock(NodeTabs, NodeParagraph)` is false,
 * pinned by kernel treenode/tabs_test.go @ 3.8.8), so a heading can never
 * parent there. The unnamed container (the empty type, e.g. a footnote
 * definition) is the other refusal. Both render `(not targetable)` in the
 * outline. Targetability is a property of the immediate parent only,
 * matching the kernel check it derives from. THE one declaration of the
 * kernel's container
 * vocabulary: the walk's recursion gate derives from this array, so a
 * vocabulary edit lands here and nowhere else. Exported as a frozen array
 * so consumers can enumerate it without being able to rewrite it — a Set
 * survives `Object.freeze` with its slot mutable, so the membership Set
 * stays module-private below. */
export const TARGETABLE_CONTAINER_TYPES: readonly string[] = Object.freeze([
	"d",
	"b",
	"callout",
	"i",
	"l",
	"s",
	"tab",
	"mindmap",
	"mindmap_item",
]);

const TARGETABLE_SET = new Set(TARGETABLE_CONTAINER_TYPES);

/** The kernel's full container vocabulary — the targetable set plus
 * lute's `tabs` wrapper, i.e. both kernel-side container predicates we
 * can read (`treenode.IsContainerType`, `model.Block.IsContainerBlock`):
 * a tabs container is recursed for reading (it can only hold tab items)
 * but never targeted. The read-side recursion gate derives from this
 * array; the empty type nests too, judged by the walk's own gate beside
 * its recursion. Frozen array, not a Set — a Set survives `Object.freeze`
 * with its slot mutable. */
export const KERNEL_CONTAINER_TYPES: readonly string[] = Object.freeze([
	...TARGETABLE_CONTAINER_TYPES,
	"tabs",
]);

/** The targetability predicate over the kernel's container vocabulary —
 * one test for every consumer (the heading-target judgment, the outline's
 * `(not targetable)` mark), so a vocabulary edit can never desync the
 * refusal from the rendered mark. */
export function isTargetableContainer(type: string): boolean {
	return TARGETABLE_SET.has(type);
}
