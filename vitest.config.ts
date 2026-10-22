// The live suite shares one kernel and is strictly ordered (the throttle pin
// last: its arming sequence ends in a 480s per-IP lock that every later
// authed call would ride). Its files must never run in parallel with each
// other, and their order must not depend on vitest's cache-driven default
// sort. Unit tests don't touch the kernel, so they keep default parallelism
// via a separate project.
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// Execution order for the live integration suite (endsWith match on the
// file name). The throttle file must stay last: its throttle case arms the
// kernel's per-IP lock and waits it out. Exported for the unit guard
// (__tests__/liveOrder.test.ts) that fails when a live file is missing
// from this list — an unlisted file would otherwise sort after the
// throttle file and ride the armed per-IP lock.
export const INTEGRATION_ORDER = [
	"version.live.test.ts", // probe verdict first (cheapest falsifier)
	"walk.live.test.ts",
	"byId.live.test.ts",
	"body.live.test.ts", // walk-field rendering posture + the stitch round-trip
	"search.live.test.ts", // shared-window premise + fan-out strategy
	"writePins.live.test.ts",
	"fresh.live.test.ts",
	"move.live.test.ts",
	"moveSection.live.test.ts",
	"replace.live.test.ts",
	"delete.live.test.ts",
	"notebooks.live.test.ts", // encrypted-notebook (no lock arming)
	"throttle.live.test.ts", // arms the lock — always last
];

class OrderedSequencer extends BaseSequencer {
	async sort(specs: TestSpecification[]): Promise<TestSpecification[]> {
		const sorted = await super.sort(specs);
		return [...sorted].sort((a, b) => {
			const ra = INTEGRATION_ORDER.findIndex((n) => a.moduleId.endsWith(n));
			const rb = INTEGRATION_ORDER.findIndex((n) => b.moduleId.endsWith(n));
			if (ra === rb) return 0; // includes both unlisted → keep default order
			if (ra === -1) return 1;
			if (rb === -1) return -1;
			return ra - rb;
		});
	}
}

export default defineConfig({
	test: {
		// Verbose by default: runs tee to logs per policy, so per-case lines
		// make failures greppable without a re-run. CLI flags still win.
		reporters: ["verbose"],
		sequence: {
			sequencer: OrderedSequencer,
		},
		projects: [
			{
				test: {
					name: "unit",
					include: ["**/*.test.ts"],
					exclude: ["__tests__/live/**", "**/node_modules/**"],
				},
			},
			{
				test: {
					name: "integration",
					include: ["__tests__/live/**/*.test.ts"],
					fileParallelism: false,
				},
			},
		],
	},
});
