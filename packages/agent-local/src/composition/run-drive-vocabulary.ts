// The two symbols a CLI in-process run DRIVE needs and had no legal route to.
//
// WHAT THEY ARE. `runSafetyScope` is `@vostride/agent-qa-safety-local`'s AsyncLocalStorage scope —
// the run's masking context, audit sink and execution context installed for the duration of the
// run, so every model egress masks and every tool call is gated and audited. `mapVerdictToExitCode`
// is the runner's own verdict→code table. A drive that RUNS the run has to do both.
//
// WHY THEY NEEDED A ROUTE AT ALL. FUNC-02's surface firewall admits only `@vostride/agent-qa-agent`,
// `-agent-local`, `-analytics` and `-schema` to a file under `packages/cli` without an exact
// `(file, specifier)` ledger entry; that ledger only ever SHRINKS and a file written after
// 2026-07-28 can never join it. `commands/run.ts` is the one cli file already ledgered for
// `safety-local` and `runner`. So the composition module that becomes the ONE in-process drive
// could not name either package, and re-exporting them from the composition root is the sanctioned
// hop — the same one 401-03 used for the assembler port's runner types.
//
// WHY NOT FROM `run-invocation-core.ts`, WHICH THE PLAN'S ROUTE TABLE NAMED. Measured: the core's
// own D-07 hygiene census (`run-invocation-core.test.ts`) asserts that no member of the ambient
// context family — `runSafetyScope` among them — appears in the core's COMMENT-STRIPPED source. A
// re-export is not a call, but the census cannot tell one from the other, and restating it to make
// an exception for re-export lines would weaken a live anchor to accommodate a convenience. The
// anchor is right and the placement was wrong: the core answers "may this run happen and in what
// order", and the drive's scope-and-exit-code vocabulary is not part of that answer. A sibling
// module keeps the census byte-exact.
//
// NEITHER IS A NEW POWER. Both already reach the CLI door today — `run.ts` imports `runSafetyScope`
// statically and pulls `mapVerdictToExitCode` out of a dynamic runner import on both of its paths.
// What changes is that the one drive both paths become callers of can name them too.
//
// PUBLISHED ON THE BARREL, NOT REACHABLE PAST IT. Re-exporting these two from `src/index.ts`
// directly would name the two packages from OUTSIDE `packages/agent-local/src/composition/`, which
// the composition carve-out refuses (401-03 measured that refusal on the runner types). The port
// and its vocabulary travel together.

export { runSafetyScope } from '@vostride/agent-qa-safety-local'
export type { SafetyScopeBundle } from '@vostride/agent-qa-safety-local'
export { mapVerdictToExitCode } from '@vostride/agent-qa-runner'

// the masking digest sidecar this hop also carried is deleted. It existed
// only so a restarted dashboard could restore placeholders, and nothing restores any more.
