import { describe, expect, it } from "vitest";
import { KERNEL_CONTAINER_TYPES } from "../containers.js";

// The kernel's own container vocabulary — IsContainerType's abbr switch
// (kernel/treenode/blocktree.go @ 3.8.8; the same set as
// Block.IsContainerBlock, kernel/model/block.go). The walk's recursion
// gate derives from KERNEL_CONTAINER_TYPES, so a kernel that grows a
// container kind without this list being re-derived turns walk absences
// into confident false negatives (and edits into false `absent-target`
// refusals). Frozen literal, not a re-export: an upstream change edits
// here deliberately.
const KERNEL_IS_CONTAINER_TYPES = Object.freeze([
	"d",
	"b",
	"l",
	"i",
	"s",
	"callout",
	"tabs",
	"tab",
	"mindmap",
	"mindmap_item",
]);

describe("KERNEL_CONTAINER_TYPES", () => {
	it("the container vocabularies are exported frozen — data, not a mutable handle", () => {
		expect(Object.isFrozen(KERNEL_CONTAINER_TYPES)).toBe(true);
	});

	it("the vocabulary equals the kernel's IsContainerType set @ 3.8.8", () => {
		expect([...KERNEL_CONTAINER_TYPES].sort()).toEqual(
			[...KERNEL_IS_CONTAINER_TYPES].sort(),
		);
	});
});
