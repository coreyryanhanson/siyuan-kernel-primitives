// Live probe-verdict pins — the version comparison the split relocated into
// this package, falsified against the real kernel. Opt-in with
// SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { PINNED_SIYUAN_VERSION, probeKernel } from "../../version.js";
import {
	BASE_URL,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	setupFixtures,
	type LiveFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("kernel probe", () => {
	let fixtures: LiveFixtures;
	let client: SiYuanKernelClient;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"probeKernel reports ok with the observed version against the pin",
		async () => {
			const probe = await probeKernel(client);
			expect(probe.verdict).toBe("ok");
			expect(probe.kernelVersion).toBe(PINNED_SIYUAN_VERSION);
		},
		LIVE_TIMEOUT,
	);

	it(
		"the version endpoint is unauthenticated — a bogus token still probes",
		async () => {
			// The consumers' breaker-contact rule counts on this: a probe
			// needs no valid token, so it records no auth failure (and never
			// arms the per-IP lock).
			const bogus = new SiYuanKernelClient(BASE_URL, "bogus-probe-token");
			const probe = await probeKernel(bogus);
			expect(probe.verdict).toBe("ok");
			expect(probe.kernelVersion).toBe(PINNED_SIYUAN_VERSION);
		},
		LIVE_TIMEOUT,
	);
});
