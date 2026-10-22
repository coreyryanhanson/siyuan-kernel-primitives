import { describe, expect, it } from "vitest";
import { SiYuanAuthError } from "siyuan-kernel-api";
import {
	PINNED_SIYUAN_VERSION,
	probeKernel,
	type KernelProbeClient,
} from "../index.js";

function probeClient(version: string, fail?: Error): KernelProbeClient {
	return {
		baseUrl: "http://kernel.test",
		getVersion: () => (fail ? Promise.reject(fail) : Promise.resolve(version)),
		listNotebooks: () => Promise.reject(new Error("not used")),
	};
}

describe("probeKernel", () => {
	it("returns ok with the observed version on an exact pin match", async () => {
		const probe = await probeKernel(probeClient(PINNED_SIYUAN_VERSION));
		expect(probe).toEqual({
			verdict: "ok",
			kernelVersion: PINNED_SIYUAN_VERSION,
		});
	});

	it("returns drift with the observed version on any mismatch", async () => {
		const probe = await probeKernel(probeClient("3.9.0"));
		expect(probe).toEqual({ verdict: "drift", kernelVersion: "3.9.0" });
	});

	it("rethrows kernel failures verbatim — the swallow is the caller's", async () => {
		const auth = new SiYuanAuthError(401);
		await expect(probeKernel(probeClient("unused", auth))).rejects.toBe(auth);
	});
});
