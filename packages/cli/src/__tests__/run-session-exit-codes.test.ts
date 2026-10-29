// Source anchors where execution is impractical, direct verdict-map calls where it is possible.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mapVerdictToExitCode } from '@vostride/agent-qa-runner'

const runSource = readFileSync(fileURLToPath(new URL('../commands/run.ts', import.meta.url)), 'utf8')
const compositionSource = readFileSync(
  fileURLToPath(new URL('../run-session-composition.ts', import.meta.url)),
  'utf8',
)
// The door's one `RunConfig` assembler, which both paths call.
const assemblySource = readFileSync(
  fileURLToPath(new URL('../composition/run-assembly.ts', import.meta.url)),
  'utf8',
)
// The door's one in-process drive: the seams are counted where they live, and `run.ts` holds none.
const driveSource = readFileSync(
  fileURLToPath(new URL('../composition/in-process-run-execution.ts', import.meta.url)),
  'utf8',
)

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// The exit map called directly for every verdict at the CLI import, the CI-gate contract.
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

// Both paths compose the core and exit through the verdict; the census owns the absence.
describe('both CLI run paths exit through the verdict map', () => {
  it('both paths compose the gated core — neither reaches the run shell any other way', () => {
    // `run.ts` composes the core nowhere; the drive composes it once and both door paths reach it.
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

// The run masks with its producer's redactor, and no run masking context is seeded.
describe('the suite path runs inside runSafetyScope and masks with its own redactor', () => {
  it('registers no --trust-session flag and reads no config.safety?.trustMode', () => {
    expect(runSource).not.toMatch(/\.option\(\s*'--trust-session'/)
    expect(runSource).not.toContain('config.safety?.trustMode')
  })

  it('wraps one run body in runSafetyScope, and the run\'s mask is its own redactor', () => {
    // One run body, in the drive, and `run.ts` wraps none of its own.
    expect(count(driveSource, 'runSafetyScope(')).toBe(1)
    expect(count(runSource, 'runSafetyScope(')).toBe(0)
    // The seed helper's primitives are spelled in parts, so this file's own text cannot match them.
    for (const source of [driveSource, runSource]) {
      expect(count(source, ['create', 'MaskingContext('].join(''))).toBe(0)
      expect(count(source, ['seed', 'MaskingContext('].join(''))).toBe(0)
    }
    // The producer's redactor reaches the one assembler, which puts it on `RunConfig`.
    expect(runSource).toContain('secretRedactor')
    expect(count(assemblySource, 'secretRedactor: input.secretRedactor')).toBe(1)
    expect(count(assemblySource, 'masking:')).toBe(0)
  })

  it('closes the run out from a finally, after the producer finalises, exactly once',
    () => {
      // The drive's `finally` runs `closeOutRun`, or a started detached post-run leg's does.
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

// Both shutdown paths arm a bounded exit-130 timer after cancel and clear it once settled.
describe('both handleShutdown paths arm + clear a bounded force-exit backstop', () => {
  // The timer exits through `forceExit`, which closes this process's own still-running row first.
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

// The single-test path uses the same seams and helpers, and no identity mint remains.
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

  it('builds no run MaskingContext and no hook registrar at either site', () => {
    // No site builds a run masking context; the seed helper's primitives stay pinned absent.
    const registrarCall = ['buildRunSafety', 'Hooks('].join('')
    for (const source of [driveSource, runSource]) {
      expect(count(source, ['create', 'MaskingContext('].join(''))).toBe(0)
      expect(count(source, registrarCall)).toBe(0)
    }
  })

  it('routes no trust to a run: no flag, no config read, no env var', () => {
    expect(count(runSource, 'opts.trustSession')).toBe(0)
    expect(driveSource).not.toContain('options.trust')
    expect(driveSource).not.toContain('trustMode')
    // No env var feeds trustMode — guard against a smuggled AGENT_QA_TRUST-style implicit grant.
    expect(runSource).not.toMatch(/trustMode:\s*[^,\n)]*process\.env/)
    expect(runSource).not.toMatch(/process\.env\.[A-Z_]*TRUST/)
  })
})

// Exit 2 stays reserved for config and setup errors; the verdict map never produces it.
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
