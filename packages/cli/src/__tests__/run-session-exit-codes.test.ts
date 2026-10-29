// Phase 361 Plan 11 (D-09 / D-14 · T-361-08 · T-361-02): the CLI-side regression lock that BOTH run
// invocation shapes (the suite path AND the single-test path) exit through `mapVerdictToExitCode`
// and construct the identity `MaskingContext` UNCONDITIONALLY (decoupled from cache enablement).
//
// Source-anchored where full execution is impractical (the wm-flush delegate-anchor convention:
// readFileSync + pattern assertions over run.ts / run-session-composition.ts), direct-map pins where
// a unit assertion IS possible (the imported D-14 map called for every verdict). Plan 12's phase
// roll-call delegates the D-09/D-14 CLI-boundary proof to this suite — a new run path or a
// cache-conditioned masking regression cannot ship without tripping these anchors.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mapVerdictToExitCode } from '@vostride/agent-qa-runner'

const runSource = readFileSync(fileURLToPath(new URL('../commands/run.ts', import.meta.url)), 'utf8')
const compositionSource = readFileSync(
  fileURLToPath(new URL('../run-session-composition.ts', import.meta.url)),
  'utf8',
)
// 401-04: the door's ONE `RunConfig` assembler, which both paths now hand their run MaskingContext
// to. It is a source anchor's third file for the same reason the second exists — the property being
// pinned did not change, the line it lives on did.
const assemblySource = readFileSync(
  fileURLToPath(new URL('../composition/run-assembly.ts', import.meta.url)),
  'utf8',
)
// 401-11: the door's ONE in-process drive, and a FOURTH anchor file for the same reason the third
// exists. Every seam this suite pins — the core composition, the safety scope, the run masking
// context, the per-run safety-hook runner, the dispose-last ordering — used to be written twice in
// `run.ts`, once per path, and this suite counted the two copies. They are written ONCE now, in the
// module both paths call. The property is unchanged and stronger: "at both sites, with the same
// helpers" was always a proxy for "one seam, shared", and a count of two copies cannot survive the
// copies being merged. So the count moved to where the thing it counts lives, and `run.ts` is
// asserted to hold NONE of them — which a `>= 2` could never have said.
const driveSource = readFileSync(
  fileURLToPath(new URL('../composition/in-process-run-execution.ts', import.meta.url)),
  'utf8',
)

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// (c) The D-14 table re-pinned at the CLI import — called directly for all five verdicts. This is
// the CI-gate contract (T-361-08): the mapping the whole CLI now funnels through.
describe('exit map re-pinned at the CLI boundary', () => {
  it('passed and healed map to 0 (healed is ratified as a pass — the annotation is not the exit code)', () => {
    expect(mapVerdictToExitCode('passed')).toBe(0)
    expect(mapVerdictToExitCode('healed')).toBe(0)
  })

  it('failed and timeout map to 1', () => {
    expect(mapVerdictToExitCode('failed')).toBe(1)
    expect(mapVerdictToExitCode('timeout')).toBe(1)
  })

  it('cancelled maps to 130 (the existing SIGINT convention)', () => {
    expect(mapVerdictToExitCode('cancelled')).toBe(130)
  })
})

// (a) Source anchors: BOTH composition paths reach `startRun` and derive the exit code from the
// verdict — the ad-hoc `hasFailed ? 1 : 0` boolean aggregation is gone from the single-test path.
//
// 401-03 RESTATED THIS ANCHOR RATHER THAN RELAXING IT. Until this phase, "reaches startRun" and
// "contains a `startRun({` literal" were the same sentence, so counting literals in run.ts was a
// faithful pin. The single-test path now composes the ONE policy-gated invocation core (D-02) and
// the core owns the `startRun` call — which is the point: a run may begin in exactly one place, and
// that place is behind a gate. Counting literals here would now demand the very second call-site
// this phase exists to remove. So the anchor says what it always meant, in two clauses:
//
//   * the suite path still composes `startRun` directly (it migrates in 401-04), and
//   * the single-test path reaches it through `createRunInvocationCore`.
//
// 401-04 FINISHED THE SENTENCE. The suite path migrated, so the first clause is now false by
// design: run.ts holds ZERO direct calls and TWO core compositions, which is what "no CLI
// invocation reaches `startRun` except through the one gated core" means when written as code.
// What survives here is only the half this file uniquely owns — that BOTH paths compose the core
// and BOTH derive their exit code from the verdict.
//
// THE ABSENCE ITSELF IS NOT ASSERTED HERE, on purpose (one producer per claim). "No file in this
// package acquires `startRun`" is a complete-set claim over 150-odd files, and a count of literals
// in ONE file cannot make it — it would pass a door that regrew the call next door. It is produced
// by `run-door-invocation-census.test.ts`, whose predicate self-checks against its own acquisition
// forms and whose discovery is pinned to named members before it is allowed to judge anything.
//
// The reachability the old count stood for is measured for real elsewhere, on artifacts rather than
// on source text: `run-gate.e2e.test.ts` and `run-gate-suite.e2e.test.ts` drive the shipped binary
// and assert a `runStarted` event on each path's allow control, and `run-invocation-core.test.ts`
// asserts the core's event log end to end.
describe('both CLI run paths exit through the verdict map', () => {
  it('both paths compose the gated core — neither reaches the run shell any other way', () => {
    // 401-11 RESTATED THIS, and in the direction that makes it stronger. The two core compositions
    // this line counted were two copies of one composition; they are one now, in the drive both
    // paths call. So: `run.ts` composes the core ZERO times (a second composition beside the drive
    // would be exactly the regrowth the old count existed to forbid), the drive composes it ONCE,
    // and BOTH of the door's paths reach the drive.
    expect(count(runSource, 'createRunInvocationCore({')).toBe(0)
    expect(count(driveSource, 'createRunInvocationCore({')).toBe(1)
    expect(count(runSource, 'runInProcessCliRun as typeof RunInProcessCliRun)(')).toBe(2)
  })

  it('maps the verdict to the exit code in both paths — no ad-hoc hasFailed boolean survives', () => {
    // Still two, and still in `run.ts`: each path folds its OWN post-verdict answer (`--all` on one,
    // a pending cancel on both) and the drive maps the run's own verdict once beneath them.
    expect(count(runSource, 'mapVerdictToExitCode(')).toBeGreaterThanOrEqual(2)
    expect(count(driveSource, 'mapVerdictToExitCode(')).toBe(1)
    expect(runSource).not.toContain('hasFailed')
  })
})

// (b) 362-06 SEAM-01/03 — the suite (multi-member) path runs inside `runSafetyScope`. 441-58 (D-06):
// the run masks with its producer's redactor, and no run masking context is seeded.
describe('the suite path runs inside runSafetyScope and masks with its own redactor', () => {
  // RE-SPELLED 2026-09-30 (432-13, D-14/D-15): was 'registers the --trust-session flag and reads
  // config.safety?.trustMode'. Nothing asks, so there is nothing for trust to satisfy.
  it('registers no --trust-session flag and reads no config.safety?.trustMode', () => {
    expect(runSource).not.toMatch(/\.option\(\s*'--trust-session'/)
    expect(runSource).not.toContain('config.safety?.trustMode')
  })

  it('wraps one run body in runSafetyScope, and the run\'s mask is its own redactor', () => {
    // 401-11: ONE run body, in the drive, and `run.ts` wraps none of its own.
    expect(count(driveSource, 'runSafetyScope(')).toBe(1)
    expect(count(runSource, 'runSafetyScope(')).toBe(0)
    // 441-19 (D-12): the run seed helper is deleted; neither site reaches its primitives either.
    // 441-33 (D-12): the primitives are deleted too, so their names are spelled in parts.
    for (const source of [driveSource, runSource]) {
      expect(count(source, ['create', 'MaskingContext('].join(''))).toBe(0)
      expect(count(source, ['seed', 'MaskingContext('].join(''))).toBe(0)
    }
    // 441-58 (D-06): the producer's redactor reaches the ONE assembler, which puts it on RunConfig;
    // no masking context is handed over or set.
    expect(runSource).toContain('secretRedactor')
    expect(count(assemblySource, 'secretRedactor: input.secretRedactor')).toBe(1)
    expect(count(assemblySource, 'masking:')).toBe(0)
  })

  // 2026-10-15 (441-30, D-12/D-15): the cell that pinned the hook runner reaching the suite member
  // executor is deleted with the producers' late-bound slot.

  it('closes the run out from a finally, after the producer finalises, exactly once',
    () => {
      // 401-11 / 404 D-06: the close-out is `closeOutRun`, which the drive's `finally` runs when no
      // detached post-run leg was started and the leg's own `finally` runs when one was. 441-58
      // (D-12): there is no masking context to dispose; the close-out shape is what stays pinned.
      const closeOutIdx = driveSource.indexOf('const closeOutRun = (): void => {')
      expect(closeOutIdx).toBeGreaterThan(0)
      expect(
        driveSource.slice(closeOutIdx, closeOutIdx + 400),
        'the untaken lease is released inside the close-out',
      ).toContain('releaseUntakenPostVerdictLease({')

      const finalizeIdx = driveSource.indexOf('await produced.finalize?.()')
      expect(finalizeIdx).toBeGreaterThan(0)
      const driveFinally = driveSource.indexOf('if (detachedTail === undefined) closeOutRun()')
      expect(driveFinally, 'the drive still owns the close-out when nobody took it').toBeGreaterThan(finalizeIdx)
      expect(driveSource.slice(finalizeIdx, driveFinally)).toContain('finally {')
      expect(
        count(driveSource, '.finally(closeOutRun)'),
        'and the detached leg owns it when one was started — exactly one other call site',
      ).toBe(1)
    })
})

// (e) SESSION-04 force-exit backstop (Plan 361-13 Task 3): BOTH handleShutdown paths arm a bounded
// `process.exit(130)` grace timer after cancel, and BOTH clear it after `await session.done`, so a
// genuinely un-settleable run still exits 130 (live Ctrl+C can never hang) and a clean completion
// never leaks the timer. Source-anchored per this file's convention.
describe('both handleShutdown paths arm + clear a bounded force-exit backstop', () => {
  // 2026-10-17 (444-08, D-30): the timer exits through forceExit, which closes this process's own
  // still-running row first.
  it('arms a bounded process.exit(130) grace timer in both handleShutdown sites', () => {
    expect(count(runSource, 'setTimeout(() => forceExit(130), cancelGraceMs())')).toBe(2)
  })

  it('unrefs the grace timer in both sites so it never keeps the loop alive on its own', () => {
    expect(count(runSource, 'grace.unref?.()')).toBe(2)
  })

  it('clears the grace timer after session.done in both paths so a clean completion never leaks it', () => {
    expect(count(runSource, 'clearTimeout(graceTimer)')).toBe(2)
  })

  it('reads the grace window from an env-overridable constant, defaulting to 3000ms', () => {
    expect(runSource).toContain("Number(process.env.AGENT_QA_CANCEL_GRACE_MS ?? 3000)")
  })
})

// (f) 362-06 SEAM-01/03 — the single-test path (the 363 demo path) activates the SAME seams with the
// SAME helpers (Pitfall 7): BOTH startRun sites are wrapped in runSafetyScope, no identity mint
// remains anywhere in production composition, and no trust reaches a run (D-15).
describe('the single-test path activates the seams with no identity mint remaining', () => {
  it('wraps BOTH run bodies in runSafetyScope', () => {
    // There is ONE run body now and both paths enter it, which is what "both are wrapped" meant.
    // Pinned as: one scope in the drive, none in the door, and two calls into the drive from it.
    expect(count(driveSource, 'runSafetyScope(')).toBe(1)
    expect(count(runSource, 'runInProcessCliRun as typeof RunInProcessCliRun)(')).toBe(2)
  })

  it('constructs no identity MaskingContext anywhere in production composition', () => {
    expect(count(runSource, 'buildIdentityMasking')).toBe(0)
    expect(count(compositionSource, 'buildIdentityMasking')).toBe(0)
  })

  // RE-TITLED 2026-10-15 (441-30, D-12/D-15): the old title said the hook runner was built once in
  // the drive. The drive builds no hook registrar either.
  it('builds no run MaskingContext and no hook registrar at either site', () => {
    // 441-58 (D-06): no site builds a run masking context.
    // 441-19 (D-12): the seed helper is deleted, so its primitives are what stays pinned absent.
    const registrarCall = ['buildRunSafety', 'Hooks('].join('')
    for (const source of [driveSource, runSource]) {
      expect(count(source, ['create', 'MaskingContext('].join(''))).toBe(0)
      expect(count(source, registrarCall)).toBe(0)
    }
  })

  // 2026-10-15 (441-30, D-12/D-15): the cell 'threads the run context + hooks into the single-test
  // runTest config' is deleted with the single-test producer's late-bound slot.

  // RE-SPELLED 2026-09-30 (432-13): was 'routes trust to the gate only via --trust-session /
  // config.safety.trustMode'. No trust reaches a run at all now; the env-var guards stay.
  // 2026-10-01 (432-14, D-03): the hooks input no longer declares trust, so the drive passes none —
  // not even the constant `false` it handed the unread field.
  it('routes no trust to a run: no flag, no config read, no env var', () => {
    expect(count(runSource, 'opts.trustSession')).toBe(0)
    expect(driveSource).not.toContain('options.trust')
    expect(driveSource).not.toContain('trustMode')
    // No env var feeds trustMode — guard against a smuggled AGENT_QA_TRUST-style implicit grant.
    expect(runSource).not.toMatch(/trustMode:\s*[^,\n)]*process\.env/)
    expect(runSource).not.toMatch(/process\.env\.[A-Z_]*TRUST/)
  })
})

// (d) The config/setup exit-2 convention is untouched (D-14): exit 2 stays reserved for
// config/setup errors and is NOT produced by the verdict map.
describe('the config/setup exit-2 convention survives the cutover', () => {
  it('retains process.exit(2) config-error sites in run.ts', () => {
    expect(count(runSource, 'process.exit(2)')).toBeGreaterThanOrEqual(1)
  })

  it('mapVerdictToExitCode never yields 2 for any verdict', () => {
    for (const verdict of ['passed', 'healed', 'failed', 'timeout', 'cancelled'] as const) {
      expect(mapVerdictToExitCode(verdict)).not.toBe(2)
    }
  })
})
