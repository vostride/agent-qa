// Fixtures, not the real tree: a pin is for the file someone adds later.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { stripCodeComments } from '../evaluate-pin.js'

import {
  findStartRunAcquisitions,
  findStartRunPinOffenders,
  RUNNER_PACKAGE_SPECIFIER,
  RUN_SHELL_MODULE,
  STARTRUN_PIN,
  type StartRunPinSource,
} from '../startrun-pin.js'

const PIN_BARREL = 'packages/runner/src/index.ts'
const PIN_CORE = 'packages/agent-local/src/composition/run-invocation-core.ts'
/** The DEFINITION site. It declares the function and acquires nothing. */
const SHELL = 'packages/runner/src/run/shell.ts'

function pinnedFixtureSources(): StartRunPinSource[] {
  return [
    { file: PIN_BARREL, source: 'export { startRun } from "./run/shell.js"' },
    { file: PIN_CORE, source: 'import { startRun } from "@vostride/agent-qa-runner"' },
  ]
}

function pinScan(...extra: readonly StartRunPinSource[]): string[] {
  return findStartRunPinOffenders([...pinnedFixtureSources(), ...extra])
}

describe('the permitted set', () => {
  it('pins exactly two production files, each with a rationale', () => {
    expect(Object.keys(STARTRUN_PIN).sort()).toEqual([PIN_CORE, PIN_BARREL].sort())
    for (const [file, rationale] of Object.entries(STARTRUN_PIN)) {
      expect(rationale.trim()).not.toEqual('')
      expect(file).toMatch(/^packages\/[a-z-]+\/src\/.+\.ts$/)
    }
  })

  it('the core entry records the MEASURED chain, not the draft-shelf link', () => {
    // A dispatch never reaches `draftShelf.runs.start`, so the rationale must not name that link.
    const rationale = STARTRUN_PIN[PIN_CORE]!
    expect(rationale).toContain('createDraftEvaluation.startGateRun')
    expect(rationale).not.toContain('draftShelf.runs.start')
  })

  it('the shipped fixtures are offender-free in BOTH directions', () => {
    expect(pinScan()).toEqual([])
  })
})

describe('direction 1 — an UN-PINNED acquisition is a build failure', () => {
  it('reports a FOURTH acquiring file, whatever name it binds the symbol to', () => {
    const fourth = 'packages/dashboard-server/src/execution/direct-start.ts'

    expect(
      pinScan({ file: fourth, source: 'import { startRun } from "@vostride/agent-qa-runner"' }),
    ).toEqual([
      `startrun-pin: ${fourth}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])

    expect(
      pinScan({
        file: fourth,
        source: 'import { startRun as beginRun } from "@vostride/agent-qa-runner"',
      }),
    ).toEqual([
      `startrun-pin: ${fourth}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])
  })

  it('reports a relative SHELL-MODULE acquisition from a new runner file', () => {
    const secondShell = 'packages/runner/src/run/second-shell.ts'
    expect(
      pinScan({ file: secondShell, source: 'import { startRun } from "./shell.js"' }),
    ).toEqual([
      `startrun-pin: ${secondShell}:1 ⇏ ./shell.js (un-pinned run-starter acquisition)`,
    ])

    // Any VALUE the shell module publishes is run-start power, so a factory added beside the
    // entry point cannot be used to dodge the pin under a different name.
    const deep = 'packages/runner/src/loop/second-driver.ts'
    expect(
      pinScan({ file: deep, source: 'import { buildRunShell } from "../run/shell.js"' }),
    ).toEqual([
      `startrun-pin: ${deep}:1 ⇏ ../run/shell.js (un-pinned run-starter acquisition)`,
    ])
  })

  it('reports a re-export, which is not an import statement at all', () => {
    const secondBarrel = 'packages/runner-local/src/index.ts'
    expect(
      pinScan({ file: secondBarrel, source: 'export { startRun } from "@vostride/agent-qa-runner"' }),
    ).toEqual([
      `startrun-pin: ${secondBarrel}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])
  })

  it('reports a DYNAMIC whole-module load that reaches for the symbol', () => {
    const dynamic = 'packages/cli/src/commands/sneaky.ts'
    const source = [
      'async function begin(config) {',
      '  const runner = await import("@vostride/agent-qa-runner")',
      '  return runner.startRun(config)',
      '}',
    ].join('\n')

    expect(pinScan({ file: dynamic, source })).toEqual([
      `startrun-pin: ${dynamic}:2 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])

    // The destructured form of the same road.
    const destructured = [
      'const { startRun } = await import("@vostride/agent-qa-runner")',
      'startRun(config)',
    ].join('\n')
    expect(pinScan({ file: dynamic, source: destructured })).toEqual([
      `startrun-pin: ${dynamic}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])

    // …and a static namespace binding that then reaches for it.
    const namespaced = [
      'import * as runner from "@vostride/agent-qa-runner"',
      'export const go = (c) => runner.startRun(c)',
    ].join('\n')
    expect(pinScan({ file: dynamic, source: namespaced })).toEqual([
      `startrun-pin: ${dynamic}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])
  })
})

describe('direction 2 — a STALE pin entry is a build failure', () => {
  it('reports an entry that no longer acquires the run starter (self-shrinking)', () => {
    expect(
      findStartRunPinOffenders(
        pinnedFixtureSources().filter((entry) => entry.file !== PIN_CORE),
      ),
    ).toEqual([
      `startrun-pin: ${PIN_CORE} ⇏ pin entry no longer acquires the run starter (stale)`,
    ])
  })

  it('reports the BARREL entry as stale if the re-export moves', () => {
    expect(
      findStartRunPinOffenders([
        { file: PIN_BARREL, source: 'export { runMemberTest } from "./run/member.js"' },
        ...pinnedFixtureSources().filter((entry) => entry.file !== PIN_BARREL),
      ]),
    ).toEqual([
      `startrun-pin: ${PIN_BARREL} ⇏ pin entry no longer acquires the run starter (stale)`,
    ])
  })
})

describe('what is deliberately NOT an acquisition', () => {
  it('the DEFINITION site, which declares the function and imports nothing', () => {
    const source = [
      'import type { RunConfig } from "./ports.js"',
      'export function startRun(config: RunConfig): RunSession {',
      '  return drive(config)',
      '}',
    ].join('\n')

    expect(findStartRunAcquisitions(source, SHELL)).toEqual([])
    expect(pinScan({ file: SHELL, source })).toEqual([])
  })

  it('a TYPE-ONLY acquisition, from either the barrel or the shell module', () => {
    expect(
      pinScan({
        file: 'packages/cli/src/commands/baseline-probe.ts',
        source: 'import type { BaselineProbeResult } from "@vostride/agent-qa-runner"',
      }),
    ).toEqual([])
    expect(
      pinScan({
        file: 'packages/cli/src/composition/run-assembly.ts',
        source: 'export type { RunConfig, RunSession } from "../run/shell.js"',
      }),
    ).toEqual([])
    // …but an inline VALUE beside a type still fires.
    const mixed = 'packages/cli/src/composition/mixed.ts'
    expect(
      pinScan({
        file: mixed,
        source: 'import { type RunConfig, startRun } from "@vostride/agent-qa-runner"',
      }),
    ).toEqual([
      `startrun-pin: ${mixed}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])
  })

  it('a COMMENTED-OUT acquisition, and a mention in prose', () => {
    const commented = 'packages/cli/src/run-session-composition.ts'
    expect(
      pinScan({
        file: commented,
        source: '// import { startRun } from "@vostride/agent-qa-runner"',
      }),
    ).toEqual([])
    expect(
      pinScan({
        file: commented,
        source: [
          '/* both startRun sites call this helper (Pitfall 8) */',
          'import { assertNever } from "@vostride/agent-qa-runner"',
          'export const attach = () => assertNever',
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('a BARREL import of unrelated values, which is most of this workspace', () => {
    // THE CELL THAT KEEPS THE PIN USABLE. `@vostride/agent-qa-runner` publishes the platform,
    // action, hook and event vocabulary a dozen packages legitimately name. A pin that fired on
    // any of them would be silenced within a week.
    for (const source of [
      'import { WorkingMemoryStore, runMemberTest } from "@vostride/agent-qa-runner"',
      'import { DockerHookExecutor } from "@vostride/agent-qa-runner-local"',
      'import { assertNever, buildScreenState } from "@vostride/agent-qa-runner"',
      'const { LogManager } = await import("@vostride/agent-qa-core")',
    ]) {
      expect(pinScan({ file: 'packages/web/src/adapter.ts', source }), source).toEqual([])
    }
  })

  it('a DYNAMIC barrel load that never reaches for the symbol — the ~15-file case', () => {
    // Measured: `cli/src/commands/run.ts` alone holds a dozen `await import(
    // "@vostride/agent-qa-runner")` calls for the action cache, the storage-state port and the
    // platform adapters, plus type-position `import(...)` annotations. Treating a whole-module
    // load as run-start power on its own — the gate pin's rule, correct for a small gate package —
    // would make offenders of every one of them.
    const source = [
      'const cache = (await import("@vostride/agent-qa-runner")).createActionPlanCache()',
      'let adapter: import("@vostride/agent-qa-runner").PlatformAdapter | null = null',
      'const { mapVerdictToExitCode } = await import("@vostride/agent-qa-runner")',
    ].join('\n')
    expect(pinScan({ file: 'packages/cli/src/commands/run.ts', source })).toEqual([])
  })

  it('keys on STATEMENTS, never on call tokens', () => {
    const noisy = [
      'import { chromium } from "playwright"',
      '// the run is started by the invocation core, never here',
      'const label = "startRun"',
      'export function describeStartRun() { return "startRun" }',
    ].join('\n')
    expect(findStartRunAcquisitions(noisy, 'packages/web/src/probe.ts')).toEqual([])
    expect(pinScan({ file: 'packages/web/src/probe.ts', source: noisy })).toEqual([])
  })

  it('reads a MULTI-LINE clause correctly', () => {
    const continuation = 'packages/eval-local/src/replay-composition.ts'
    const source = [
      'import {',
      '  LLMPlanner,',
      '  startRun,',
      '} from "@vostride/agent-qa-runner"',
    ].join('\n')
    expect(pinScan({ file: continuation, source })).toEqual([
      `startrun-pin: ${continuation}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
    ])
  })
})

describe('the constants say what they mean', () => {
  it('names the barrel and the shell module the real files use', () => {
    expect(RUNNER_PACKAGE_SPECIFIER).toBe('@vostride/agent-qa-runner')
    expect(RUN_SHELL_MODULE).toBe('packages/runner/src/run/shell')
  })
})

// ---------------------------------------------------------------------------------------------
// THE ACQUISITION CENSUS, over the REAL tree and with a predicate the pin does not share.
//
// The fixtures above measure what the pin DOES. This measures whether its permitted set is the
// right one — and it has to ask with a different instrument, because a permitted set derived from
// the pin's own scan would be a guard certifying itself. So: a SYMBOL-shaped scan (does this file
// name `startRun` in a code position at all?) compared against the WRITTEN map plus the definition
// site named here. If the pin's detector ever narrowed, this cell would still see the file.
describe('the acquisition census — an independently-shaped predicate over the workspace', () => {
  const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

  /** The definition site, named rather than discovered: it declares the symbol, acquiring nothing. */
  const DEFINITION_SITE = 'runner/src/run/shell.ts'

  function shippedSourceFiles(): string[] {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules'
            || entry.name === 'dist' || entry.name === 'coverage') continue
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
        found.push(path)
      }
    }
    for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(PACKAGES_ROOT, pkg.name, 'src')
      if (existsSync(src)) walk(src)
    }
    return found
  }

  /** Files the census must range, named rather than read off the scan. */
  const REQUIRED_MEMBERS = [
    join('runner', 'src', 'run', 'shell.ts'),
    join('runner', 'src', 'index.ts'),
    join('agent-local', 'src', 'composition', 'run-invocation-core.ts'),
    join('agent-local', 'src', 'composition', 'compose-local-agent.ts'),
    join('cli', 'src', 'commands', 'run.ts'),
  ] as const

  it('ranges the files the claim is about, including the two the chain document names', () => {
    const scanned = shippedSourceFiles().map((path) => relative(PACKAGES_ROOT, path))
    expect(scanned.length).toBeGreaterThan(500)
    for (const member of REQUIRED_MEMBERS) {
      expect(scanned, `the census is not ranging ${member}`).toContain(member)
    }
  })

  /**
   * The pin's own module. It NAMES the symbol because policing it requires spelling it — exactly as
   * `evaluate-pin.ts` names `evaluate` — and it acquires nothing, which the detector agrees with
   * below. Named here rather than filtered out by a path rule, because a filter over `arch/` would
   * be a hole a later file could be moved into.
   */
  const THE_PIN_ITSELF = 'arch/src/lint/startrun-pin.ts'

  it('exactly four production files name the run starter, and each one is accounted for', () => {
    const naming = shippedSourceFiles()
      .filter((path) => /\bstartRun\b/.test(stripCodeComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(PACKAGES_ROOT, path).replaceAll(sep, '/'))

    expect(naming.sort()).toEqual(
      [
        DEFINITION_SITE,
        THE_PIN_ITSELF,
        ...Object.keys(STARTRUN_PIN).map((file) => file.replace(/^packages\//, '')),
      ].sort(),
    )

    // …and the two that are NOT pinned are not acquisitions, which is what makes the count above a
    // census of the symbol rather than a second spelling of the permitted set.
    for (const file of [DEFINITION_SITE, THE_PIN_ITSELF]) {
      const path = join(PACKAGES_ROOT, ...file.split('/'))
      expect(
        findStartRunAcquisitions(readFileSync(path, 'utf8'), `packages/${file}`),
        `${file} is not supposed to acquire the run starter`,
      ).toEqual([])
    }
  })

  it('the gate-run road named by the measured chain acquires NOTHING, cross-checked', () => {
    // Both chains reach a run through `invokeFunction('runs.start')`, never the run starter itself.
    const composeRoot = join(PACKAGES_ROOT, 'agent-local', 'src', 'composition', 'compose-local-agent.ts')
    const source = readFileSync(composeRoot, 'utf8')
    expect(findStartRunAcquisitions(source, 'packages/agent-local/src/composition/compose-local-agent.ts')).toEqual([])
    // Non-vacuity: the two seams really are in this file, so "no acquisition" is a statement about
    // them rather than about a file that turned out not to mention them.
    expect(source).toContain('startGateRun')
    expect(source).toContain('draftShelf')
  })
})
