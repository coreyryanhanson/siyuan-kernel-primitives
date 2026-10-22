// Version-coupled knowledge: the SiYuan version pin and the kernel probe.
// This package is the only layer coupled to a specific SiYuan version. The
// auth-lock schedule
// and the dodge over it live beside the pin in `authLock.ts`. Change the
// pin only via the upgrade checklist: re-run the live integration suite
// against the new kernel before bumping.

import type { NotebookList } from "siyuan-kernel-api";

/** Structural client subset the validation pipeline needs (tests stub it). */
export interface KernelProbeClient {
	/** Kernel origin without trailing slash (for unreachable-kernel messages). */
	readonly baseUrl: string;
	getVersion(): Promise<string>;
	listNotebooks(): Promise<NotebookList>;
}

/** The only kernel version this package's behavior is written against.
 * The tool layer imports this — it never names a version itself. */
export const PINNED_SIYUAN_VERSION = "3.8.8";

/** The narrow probe verdict the write primitives accept: the observed
 * kernel version rides each member, so consumers never re-derive it and it
 * cannot disagree with the verdict. The wider session-lifecycle members
 * (`unreachable` / `never-probed`) are the tool layer's own type — this
 * package never produces them. */
export type KernelProbeResult =
	| { verdict: "ok"; kernelVersion: string }
	| { verdict: "drift"; kernelVersion: string };

/** Kernel probe: unauthenticated connectivity + version. Strict full-version
 * match against this package's own pin (`PINNED_SIYUAN_VERSION`) — the pin
 * is not caller-supplied, so the drift judgment and the pin knowledge share
 * this one owner and no caller can pick a different pin. Drift
 * fails writes closed (the write primitives refuse a drifted verdict) while
 * reads proceed with a warning. RETHROWS on
 * any kernel failure — a probe that swallowed errors would erase each
 * caller's own failure policy (session-start validation wraps it in
 * try/catch → "unreachable"; the write gate classifies the thrown object to
 * arm cooldowns and feed the breaker). The swallow is the caller's choice.
 *
 * The parameter is the probe's true dependency: only the version read. The
 * wider `KernelProbeClient` above satisfies it structurally — it exists for
 * the validation pipeline that shares the probe's client. */
export async function probeKernel(client: {
	getVersion(): Promise<string>;
}): Promise<KernelProbeResult> {
	const kernelVersion = await client.getVersion();
	return kernelVersion === PINNED_SIYUAN_VERSION
		? { verdict: "ok", kernelVersion }
		: { verdict: "drift", kernelVersion };
}
