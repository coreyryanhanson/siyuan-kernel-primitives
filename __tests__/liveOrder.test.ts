// Guard for the live suite's fixed order (vitest.config.ts): every live
// file must end with an entry in INTEGRATION_ORDER, and the throttle file
// must stay last — an unlisted live file sorts after every listed one,
// which would run it after the throttle case armed the per-IP lock.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATION_ORDER } from "../vitest.config.js";

const liveFiles = readdirSync(new URL("../__tests__/live/", import.meta.url))
	.filter((f) => f.endsWith(".test.ts"))
	.sort();

describe("live suite ordering", () => {
	it("every live test file appears in INTEGRATION_ORDER", () => {
		const missing = liveFiles.filter(
			(f) => !INTEGRATION_ORDER.some((n) => f.endsWith(n)),
		);
		expect(missing, `add to INTEGRATION_ORDER: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	it("every INTEGRATION_ORDER entry names an existing live file", () => {
		const stale = INTEGRATION_ORDER.filter(
			(n) => !liveFiles.some((f) => f.endsWith(n)),
		);
		expect(stale, `stale entries: ${stale.join(", ")}`).toEqual([]);
	});

	it("the throttle file is last — it arms the per-IP lock", () => {
		expect(INTEGRATION_ORDER.at(-1)).toBe("throttle.live.test.ts");
	});
});
