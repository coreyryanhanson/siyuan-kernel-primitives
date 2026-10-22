// The shared pre-judgment failure taxonomy — one home for the four arms
// every verified mutation outcome union composes and for the error
// classification that renders them. Leaf module: imports only the layer-1
// error classes and the probe type, so every flow module can depend on it
// without a cycle.
//
// The class list is the contract: SiYuanAuthError and SiYuanRateLimitError
// are siblings of SiYuanApiError, never subclasses — the fact that makes
// the classification's instanceof branch safe. A new layer-1 error
// class lands here once instead of per flow site: it extends `KernelCause`,
// and every exhaustive consumer fails typecheck until it names the new
// arm. Every consumer of the classification routes through `causeOf`.

import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import type { KernelProbeResult } from "./version.js";

/** The four pre-judgment failure arms every verified mutation outcome
 * union carries (insert, edit, block/doc move, block delete,
 * replace-section) — the policy
 * over them lives beside their producers (`refuseDrift`,
 * `mutationFailureOf`, `verificationFailureOf`). Composed by each union so
 * a new arm fails typecheck once — in the consumer's single failure-ladder
 * mapper — instead of per flow. */
export type MutationFailure =
	| { kind: "drift"; observed: string }
	| { kind: "transport-unverified"; detail: string }
	| { kind: "kernel-refused"; message: string }
	| { kind: "verification-failed"; cause: VerificationCause; detail: string };

/** The cause taxonomy over the layer-1 error classes — one arm per class,
 * closed so a new layer-1 error class fails every consumer's exhaustive
 * switch typecheck. Declared here beside `causeOf`. The read barrel
 * carries `KernelCause` + `causeOf` (the layer-1 identity surface's
 * classification half); the write-verdict name is the alias below.
 *
 * `auth` carries the HTTP status and `rate-limit` the kernel's served
 * Retry-After so a consumer feeding its breaker/lock schedule and wording
 * never needs the caught instance — the class list stays here alone. */
export type KernelCause =
	| { kind: "transport" }
	| { kind: "kernel" }
	| { kind: "auth"; status: number }
	| { kind: "rate-limit"; retryAfterSeconds?: number | undefined };

/** The verification-failed arm's recovery evidence — the write-verdict
 * name for `KernelCause`. `auth`/`rate-limit` are the load-bearing legs
 * (the acked-mutation rationale lives on `verificationFailureOf`): the
 * consumer must both feed its breaker/lock schedule AND word "the write
 * may already be applied" — a raw rethrow would erase the second fact.
 * The rate-limit leg carries the kernel's served Retry-After: it is what
 * a 429-cooldown schedule plans around, and the rethrow it replaces
 * preserved it verbatim — the verdict must not downgrade it to prose. */
export type VerificationCause = KernelCause;

/** The drift arm on its own — the shape `refuseDrift` produces, composed
 * by the flows that cannot take the whole ladder. */
export type DriftFailure = Extract<MutationFailure, { kind: "drift" }>;

/** The mutation-phase arms on their own — the shape `catchMutation`
 * produces, composed by the flows that cannot take the whole ladder. */
export type MutationPhaseFailure = Extract<
	MutationFailure,
	{ kind: "transport-unverified" | "kernel-refused" }
>;

/** The kernel-refused arm on its own — composed beside
 * `JudgedTransportFailure` by flows whose transport arm carries its own
 * evidence (delete-section's judged set). On the batched route a refusal
 * over HTTP is NOT proof of non-application — the kernel can fail after
 * the commit — so the consumer verifies from a fresh read before wording
 * this as "nothing landed". */
export type KernelRefusal = Extract<
	MutationFailure,
	{ kind: "kernel-refused" }
>;

/** `transport-unverified` with the caller's judged set attached — the
 * batched-route shape. With no ack the commit-wait guarantee does not
 * apply, so the WHOLE judged set is what may be gone, and the verdict
 * carries it: the consumer never re-derives what a verdict observed.
 * Composed over the shared ladder arm, so a field added there fails
 * typecheck here instead of being silently dropped. */
export type JudgedTransportFailure = Extract<
	MutationFailure,
	{ kind: "transport-unverified" }
> & { judgedBlockIds: string[] };

/** The post-write walk failure with the caller's judged set attached —
 * the batched route's other outcome-unknown shape: the mutation phase is
 * over (for the batched path, the batch HAS committed or rolled back per
 * the commit-wait fact) but a post-write walk threw, so the judgment is
 * missing. The judged set rides the arm — on a committed batch it is
 * wider than the issued ids (a delete takes the closure, a move the
 * run) — so the consumer never re-derives what the transport observed.
 * Composed by the batched sequences' unverified unions (`moveSection.ts`,
 * `sectionDeleteCore.ts`). */
export type JudgedWalkFailure = {
	kind: "walk-failed";
	error: unknown;
	judgedBlockIds: string[];
};

/** The kernel-coupled drift refusal, judged from the required probe —
 * `undefined` when the verdict is not drift. Every verified mutation
 * checks this before any kernel call. */
export function refuseDrift(
	probe: KernelProbeResult,
): DriftFailure | undefined {
	if (probe.verdict !== "drift") return undefined;
	return { kind: "drift", observed: probe.kernelVersion };
}

/** The layer-1 classification, one home: every thrown value maps to the
 * `KernelCause` arm naming its class, or `undefined` when it is not a
 * layer-1 error at all (the caller rethrows unchanged). The specific
 * classes are matched BEFORE the `SiYuanApiError` catch-all so the arms
 * survive even if layer 1 ever nests them under it. Consumers switch
 * exhaustively on `kind` and keep only their policy — the class list is
 * never re-encoded outside this module. */
export function causeOf(err: unknown): KernelCause | undefined {
	if (err instanceof SiYuanNetworkError || err instanceof SiYuanTimeoutError) {
		return { kind: "transport" };
	}
	if (err instanceof SiYuanAuthError) {
		return { kind: "auth", status: err.status };
	}
	if (err instanceof SiYuanRateLimitError) {
		return { kind: "rate-limit", retryAfterSeconds: err.retryAfterSeconds };
	}
	if (err instanceof SiYuanApiError) {
		return { kind: "kernel" };
	}
	return undefined;
}

/** Mutation-phase classification: transport failures are outcome-UNKNOWN
 * (the mutation may already be applied — never "unreachable"-shaped), a
 * synchronous kernel rejection carries the kernel's message verbatim.
 * `undefined` means the error is not a flow-classifiable failure — the
 * caller rethrows it unchanged for the caller's gate (auth and rate-limit
 * ride the breaker and 429-cooldown paths there).
 *
 * The auth/rate-limit rethrow is safe HERE and only here: the kernel
 * checks auth in middleware before any handler runs, so a mutation-phase
 * auth error provably means the mutation never executed — "auth failed"
 * and "nothing applied" are the same statement. Verification-phase auth
 * errors do NOT get this treatment (see `verificationFailureOf`). */
function mutationFailureOf(err: unknown): MutationPhaseFailure | undefined {
	const cause = causeOf(err);
	if (cause === undefined) return undefined;
	const detail = err instanceof Error ? err.message : String(err);
	switch (cause.kind) {
		case "transport":
			return { kind: "transport-unverified", detail };
		case "kernel":
			return { kind: "kernel-refused", message: detail };
		case "auth":
		case "rate-limit":
			return undefined;
	}
	cause satisfies never;
	return undefined;
}

/** Verification-phase classification: every post-mutation read failure is
 * `verification-failed` — the mutation has already acked by the time a
 * verification read runs, so a 401/403 (token or role changed mid-flow)
 * or a 429 (the per-IP lock any client on this IP arms) leaves the write
 * APPLIED-BUT-UNJUDGED; rethrowing would let the consumer read that state
 * as "nothing happened" and blind-retry after the lockout, duplicating
 * the write. `undefined` means rethrow.
 *
 * Every layer-1 error class classifies here, including auth and rate-limit
 * — the deliberate opposite of `mutationFailureOf`. The `cause` leg
 * preserves the class so the consumer still feeds its breaker/lock
 * schedule from the same verdict it renders the never-retry wording from. */
function verificationFailureOf(
	err: unknown,
): Extract<MutationFailure, { kind: "verification-failed" }> | undefined {
	const cause = causeOf(err);
	if (cause === undefined) return undefined;
	return {
		kind: "verification-failed",
		cause,
		detail: err instanceof Error ? err.message : String(err),
	};
}

/** The mutation-phase catch body, one home: classify with
 * `mutationFailureOf`, rethrowing what it declines. Every flow's
 * mutation try/catch is this call. The two-argument form attaches the
 * caller's judged set to the transport arm (delete-section's batched
 * route: the whole judged set is what may be gone). */
export function catchMutation(err: unknown): MutationPhaseFailure;
export function catchMutation(
	err: unknown,
	judgedBlockIds: string[],
): KernelRefusal | JudgedTransportFailure;
export function catchMutation(
	err: unknown,
	judgedBlockIds?: string[],
): MutationPhaseFailure | JudgedTransportFailure {
	const failure = mutationFailureOf(err);
	if (failure === undefined) throw err;
	if (failure.kind === "transport-unverified" && judgedBlockIds !== undefined) {
		return { ...failure, judgedBlockIds };
	}
	return failure;
}

/** The verification-phase catch body, one home: classify with
 * `verificationFailureOf`, rethrow only what is not a layer-1 error at
 * all. Every flow's verification try/catch is this call. */
export function catchVerification(
	err: unknown,
): Extract<MutationFailure, { kind: "verification-failed" }> {
	const failure = verificationFailureOf(err);
	if (failure === undefined) throw err;
	return failure;
}
