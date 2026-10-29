// THE IN-PROCESS RUN EXECUTION'S OWN CELLS (Phase 401 plan 11).
//
// This file grows across the plan. Task 1 lands the typed-input-error register — the proof that no
// input failure on this path can terminate its host (T-401-31). Task 2 adds the composability cell
// and the ambient-crossing pair.
//
// THE RED BASELINE FOR THE TASK-1 CELLS IS NOT A FAILING ASSERTION, and saying so plainly is more
// honest than manufacturing one. Pre-task there was no `CliRunInputError` to catch: the preflight
// RENDERED and called `process.exit`, so the measurement is what the shipped binary did, taken on
// the pre-extraction dist and pasted into the plan's SUMMARY:
//
//     $ agent-qa run tests/red.yaml          # with no .env
//     Error: Env file not found: <PROJECT>/.env
//     exit=1
//     $ agent-qa run 'tests/nothing-*.yaml'
//     Error: No test files found matching patterns:
//       tests/nothing-*.yaml
//     exit=2
//     $ agent-qa run tests/empty.yaml
//     Error: Resolved test file(s) but found 0 runnable tests.
//       <PROJECT>/tests/empty.yaml
//     Each test file must define at least one test (a top-level `name` + `steps`, or a `tests:` list).
//     exit=2
//
// A process that terminates cannot be asserted about from inside; the cells below assert the same
// lines and the same codes arriving as a VALUE, and — the discriminating half — that the
// host-terminating call was never reached.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  produceMembersFromPatterns,
  refuseZeroRunnableTests,
  requireReporterSelection,
  resolveRunInvocationInputs,
} from '../../commands/run.js'
import type { RunOptions } from '../../commands/run.js'
import { CliRunInputError } from '../in-process-run-execution.js'
import { CountingTarget, createInProcessFixture } from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

/**
 * Drive a producer with the host-terminating call STUBBED TO THROW A MARKER.
 *
 * Without this, "the host is still alive afterwards" is not something a cell can say: under vitest
 * a real `process.exit` would take the worker with it, and a cell that merely observed a throw
 * could not tell a typed refusal from a refusal that ALSO tried to exit on its way out. The marker
 * is the discriminator, and every cell below asserts it never appears.
 */
async function withExitTrap<T>(body: () => Promise<T>): Promise<T> {
  const marker = new Error('THE MODULE TERMINATED ITS HOST')
  const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw marker
  }) as never)
  try {
    return await body()
  } finally {
    spy.mockRestore()
  }
}

async function refusalFrom(body: () => Promise<unknown>): Promise<CliRunInputError> {
  const caught = await withExitTrap(async () => {
    try {
      await body()
      return undefined
    } catch (err) {
      return err
    }
  })
  if (!(caught instanceof CliRunInputError)) {
    throw new Error(
      `expected a CliRunInputError; got ${caught === undefined ? 'no throw at all' : String(caught)}`,
    )
  }
  return caught
}

/** ANSI-strip, so a cell asserts the WORDS while `lines` keeps carrying the rendered bytes. */
function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\[[0-9;]*m/g, ''))
}

describe('the in-process run path refuses inputs instead of terminating its host', () => {
  it('a missing env file is a typed refusal carrying the command’s own line and exit code 1', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        omitEnvFile: true,
      })
      const refusal = await refusalFrom(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.testPattern],
        }),
      )
      expect(plain(refusal.lines)).toEqual([
        `Error: Env file not found: ${fixture.project}/.env`,
      ])
      expect(refusal.exitCode).toBe(1)
    } finally {
      await target.close()
    }
  })

  it('a missing hooks file is a typed refusal with exit code 1', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        omitHooksFile: true,
      })
      const refusal = await refusalFrom(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.testPattern],
        }),
      )
      expect(plain(refusal.lines)).toEqual([
        `Error: Hooks file not found: ${fixture.project}/hooks.yaml`,
      ])
      expect(refusal.exitCode).toBe(1)
    } finally {
      await target.close()
    }
  })

  it('a missing secrets file is a typed refusal with exit code 1 and both of its lines', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        omitSecretsFile: true,
      })
      const refusal = await refusalFrom(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.testPattern],
        }),
      )
      expect(plain(refusal.lines)).toEqual([
        `Error: Secrets file not found: ${fixture.project}/.env.secrets.local`,
        'Create the file before running tests. It may be empty, but it must exist.',
      ])
      expect(refusal.exitCode).toBe(1)
    } finally {
      await target.close()
    }
  })

  it('patterns that match nothing are a typed refusal with exit code 2', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const refusal = await refusalFrom(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: ['tests/nothing-*.yaml'],
        }),
      )
      expect(plain(refusal.lines)).toEqual([
        'Error: No test files found matching patterns:',
        '  tests/nothing-*.yaml',
      ])
      expect(refusal.exitCode).toBe(2)
    } finally {
      await target.close()
    }
  })

  it('a test file that parses to zero runnable tests is refused with exit code 2', async () => {
    const files = ['/tmp/whatever/tests/empty.yaml']
    const refusal = await refusalFrom(async () => { refuseZeroRunnableTests(files, []) })
    expect(plain(refusal.lines)).toEqual([
      'Error: Resolved test file(s) but found 0 runnable tests.',
      '  /tmp/whatever/tests/empty.yaml',
      'Each test file must define at least one test (a top-level `name` + `steps`, or a `tests:` list).',
    ])
    expect(refusal.exitCode).toBe(2)
  })

  it('an unsupported reporter is a typed refusal with exit code 2', async () => {
    const refusal = await refusalFrom(async () => {
      requireReporterSelection({ reporter: ['not-a-reporter'] } as unknown as RunOptions)
    })
    expect(plain(refusal.lines)[0]).toContain('Error:')
    expect(refusal.exitCode).toBe(2)
  })

  it('THE ALLOW CONTROL — one field different, and the same producer returns instead of throwing', async () => {
    // Differs from the "patterns that match nothing" cell in exactly one field: the pattern names a
    // file that exists. Without this, every cell above would pass over a producer that threw
    // unconditionally, which is a producer that measures nothing.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.testPattern],
        }),
      )
      // BOTH HALVES OF THE SPLIT COME BACK. A producer that dropped `suites` would make the
      // mode-aware dispatch unbuildable, so the shape is asserted, not just the happy half.
      expect(inputs.discovered.tests).toEqual([`${fixture.project}/tests/direct.yaml`])
      expect(inputs.discovered.suites).toEqual([])
      expect(inputs.configDir).toBe(fixture.project)
      expect(inputs.resolvedEnvFilePath).toBe(`${fixture.project}/.env`)
      expect(inputs.resolvedHooks.size).toBe(0)
      expect(inputs.runtimeSecrets.secretsFileMetadata.status).toBe('loaded')
      expect(inputs.effectiveLogLevel).toBe('warn')
    } finally {
      await target.close()
    }
  })

  it('a suite pattern resolves into the SUITES half, not the tests half', async () => {
    // The other half of the split, without which "returns both halves" is a claim about one of
    // them. Task 2's dispatcher reads exactly this.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.suitePattern],
        }),
      )
      expect(inputs.discovered.suites).toEqual([`${fixture.project}/suites/gate.suite.yaml`])
      expect(inputs.discovered.tests).toEqual([])
    } finally {
      await target.close()
    }
  })

  it('no patterns at all resolves the configured default set (the argument-less edge)', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({ configPath: fixture.configPath }),
      )
      expect([...inputs.discovered.tests].sort()).toEqual([
        `${fixture.project}/tests/direct.yaml`,
        `${fixture.project}/tests/member.yaml`,
      ])
    } finally {
      await target.close()
    }
  })
})

// ============================================================================================
// TASK 2 — THE PORT ITSELF
//
// THE RED BASELINE, and it is a measured fact rather than a failing assertion. Pre-task there was
// nothing to red: `assembleCliRun`'s input declares `members` and `executor` as REQUIRED,
// `RunsStartInputSchema` carries neither, and the only chain that turns one into the other lived
// unexported inside `run.ts`'s command body. A cell for the port could not be written against a
// symbol that did not exist — which is the wall 401-06 halted on, stated as a measurement. The real
// bar for these cells is the mutation ledger in task 4.
//
// EVERY RUN BELOW IS A REAL RUN, IN THIS PROCESS. The fixture's model points at an unbindable port
// and `PLAYWRIGHT_BROWSERS_PATH` is an empty directory, so a member fails fast — but it fails
// DOWNSTREAM of `startRun`, which is the whole point: the artifacts a started run leaves are what
// these cells read.
// ============================================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import type { RunSession } from '@vostride/agent-qa-schema'

import { runInProcessCliRun } from '../in-process-run-execution.js'
import type { CliRunOutcome } from '../in-process-run-execution.js'
import { PLANTED_SECRET_NAME, auditRows, buildOrdinalsExist, eventTypes, runDirs } from './in-process-run-fixture.js'
import { parseTestFile } from '@vostride/agent-qa-core'
import { memberStepText } from '@vostride/agent-qa-runner'
import { DatabaseSync } from 'node:sqlite'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { closeTestRunRecords, removeInProcessFixtures, testRunRecord } from './in-process-run-fixture.js'

// 2026-10-17 (443-08, D-22): every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })

/** The process-global resolver is exactly that; a leaked pin poisons every sibling cell. */
const shippedExecutionContextResolver = getActiveExecutionContext
let restoreResolver: (() => void) | undefined

beforeEach(() => {
  restoreResolver = undefined
})
afterEach(() => {
  restoreResolver?.()
  restoreResolver = undefined
})
afterAll(() => { removeInProcessFixtures() })

function pinAmbientExecutionContext(value: 'ci' | 'local-interactive' | 'local-headless'): void {
  setActiveExecutionContextResolver(() => value as never)
  restoreResolver = () => {
    setActiveExecutionContextResolver(() => shippedExecutionContextResolver())
  }
}

function fixtureOptions(fixture: { configPath: string; agentQaRoot: string; project: string }) {
  // An empty browsers root, so the member's failure is a property of the fixture rather than of the
  // machine — the same pin the parity generator uses.
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return { configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot }
}

/** Every handoff the invocation persisted — the durable record a started run always leaves. */
function handoffs(fixture: { project: string; suitePattern: string }): unknown[] {
  return runDirs(fixture as never)
    .map((dir) => join(dir, 'handoff.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

describe('a door holding only a RunsStartInput gets a policy-gated run, in process', () => {
  it('THE COMPOSABILITY CELL — { patterns } and a posture, and a real run happens', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      let session: RunSession | undefined

      // The member fails downstream of `startRun` (no browser binaries), and the drive re-surfaces
      // that framework error exactly as the shipped door does. The run still HAPPENED, which is
      // what every assertion below reads. Caught rather than asserted-against so this cell is about
      // the seam and not about the fixture's failure mode.
      try {
        await runInProcessCliRun(
          {
            runRecord: testRunRecord(),
            ...fixtureOptions(fixture),
            // THE POSTURE TRAVELS EXPLICITLY (D-07). No CLI option is named anywhere in this call.
            executionContext: 'local-headless',
            onSession: (started) => { session = started },
          },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error; the run still happened */ }

      // THE IN-PROCESS WITNESS. No child process can hand back a live object, so a cell that
      // asserts this cannot pass over a spawn.
      expect(session).toBeDefined()
      expect(typeof session!.cancel).toBe('function')
      expect(typeof session!.subscribe).toBe('function')
      expect(typeof session!.id).toBe('string')

      // The durable half: a run that began, under the composition's OWN `<configDir>/.agent-qa`.
      expect(eventTypes(fixture as never)).toContain('runStarted')
      expect(handoffs(fixture)).toHaveLength(1)
      expect(runDirs(fixture as never).map((dir) => dir.split('/').pop())).toContain(
        session!.id as unknown as string,
      )
      // The run started, so the baseline probe knocked.
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(buildOrdinalsExist(fixture as never)).toBe(true)
      // 432-13: the start is not asked about, so it leaves no approval row.
      expect(auditRows(fixture as never)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE SUITE ARM — the same bare request with a suite pattern runs the SUITE', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const outcome: CliRunOutcome = await runInProcessCliRun(
        { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
        // Still a bare `RunsStartInput`. Still no mode flag — which is exactly what
        // `createCliRunExecution` forwards today, so a producer that could not do this would be a
        // scope reduction of the shipped contract at the two doors this seam exists to unblock.
        { patterns: [fixture.suitePattern] },
      )

      const events = eventTypes(fixture as never)
      expect(events).toContain('runStarted')
      // THE MEMBER RAN. Without this, a producer that dispatched to the test path and assembled
      // zero members would pass on `runStarted` alone.
      expect(events).toContain('testStarted')
      expect(handoffs(fixture)).toHaveLength(1)
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(runDirs(fixture as never).map((dir) => dir.split('/').pop())).toContain(outcome.runId)
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE REQUEST NAMES THE CONFIG — `request.configPath` decides what is resolved', async () => {
    // CARRIED FORWARD BY 401-10 from `fn-runs-start.test.ts`, which died with the child it drove.
    // The old cell read the `--config` operand the port put in front of the child. The contract
    // survived the retirement (`runInProcessCliRun`: `request.configPath ?? options.configPath`)
    // and had no other cell, so it is re-asserted here at the EFFECT — the stronger reading, since
    // a port that accepted the field and dropped it produces no argv to be wrong about.
    const target = new CountingTarget()
    await target.listen()
    try {
      const composed = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const named = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        targetPath: '/named-thing',
      })
      expect(named.configPath).not.toBe(composed.configPath)

      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(composed), executionContext: 'local-headless' },
          { configPath: named.configPath, patterns: [named.testPattern] },
        )
      } catch { /* the member's framework error; where the run LANDED is what this cell reads */ }

      // THE TARGET CAME FROM THE CONFIG THE REQUEST NAMED. Both configs declare the same target
      // name, and only the named one points it at `/named-thing`, so a port that dropped
      // `configPath` would have probed the composed project's `/in-process-thing` instead.
      expect(target.hits).toEqual(['/named-thing'])

      // AND THE RUN'S DURABLE EVIDENCE FOLLOWS `agentQaRoot`, WHICH THE REQUEST CANNOT NAME. This
      // is asserted rather than smoothed over: the two halves of one run land in two projects when
      // a door's config and its request's config differ. It is not the retired wire's behaviour —
      // the child resolved BOTH from `--config`, which put the evidence somewhere the composition's
      // own evidence check could not read, and the ack failed. Recorded in the phase's
      // deferred-items as a contract question with an owner, not decided here.
      expect(eventTypes(composed as never)).toContain('runStarted')
      expect(eventTypes(named as never)).toEqual([])
      expect(buildOrdinalsExist(composed as never)).toBe(true)
      expect(buildOrdinalsExist(named as never)).toBe(false)
      // One run, one id — not two runs. RE-SPELLED 2026-09-30 (432-13): the named project's half
      // was the gate's audit row, written under ITS run dir; no row is written now, so the named
      // project holds no run dir at all and the whole run is the composed project's.
      expect(runDirs(named as never)).toEqual([])
      expect(runDirs(composed as never)).toHaveLength(1)
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE DISPATCH BOUNDARY — when both kinds resolve, the TEST path wins', async () => {
    // The direction that is easy to get backwards. `run.ts`'s shipped guard early-returns to the
    // suite path ONLY when `discoveredTestFiles.length === 0`, so a dispatcher that preferred
    // suites whenever any suite resolved would stop running an `--all`-shaped invocation's tests.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({ configPath: fixture.configPath, mode: 'all' }),
      )
      expect(inputs.discovered.tests.length).toBe(2)
      expect(inputs.discovered.suites.length).toBe(1)

      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_dispatch-boundary' })
      // The resolved member set is the TEST files', not the suite's single member.
      expect(produced.members).toHaveLength(2)
      expect(produced.members.map((member) => member.name).sort()).toEqual([
        'the standalone test',
        'the suite member',
      ])
    } finally {
      await target.close()
    }
  }, 120_000)

  // Owner decision 2026-09-26 (2), G-428-2: both producers put the texts member-runner announces on
  // every descriptor. The expected texts come from the fixture's own YAML through the core parser,
  // located by each descriptor's own identity path and test id.
  it('STEP-TEXTS-ON-BOTH-MEMBER-BUILDERS', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        secondSuiteMember: true,
      })
      const parsedStepTexts = (member: { filePath: string; testId: string }): string[] => {
        const absolute = join(fixture.project, member.filePath)
        const parsed = parseTestFile(readFileSync(absolute, 'utf8'), absolute)
        expect(parsed.errors).toEqual([])
        const test = parsed.tests.find((candidate) => candidate['test-id'] === member.testId)
        expect(test).toBeDefined()
        return test!.steps.map((step) => memberStepText(step))
      }

      const testInputs = await withExitTrap(() =>
        resolveRunInvocationInputs({ configPath: fixture.configPath, patterns: [fixture.testPattern] }),
      )
      const direct = await produceMembersFromPatterns({ inputs: testInputs, runId: 'r_step-texts-test' })
      expect(direct.members.map((member) => member.testId)).toEqual([fixture.directTestId])

      const suiteInputs = await withExitTrap(() =>
        resolveRunInvocationInputs({ configPath: fixture.configPath, patterns: [fixture.suitePattern] }),
      )
      const suite = await produceMembersFromPatterns({ inputs: suiteInputs, runId: 'r_step-texts-suite' })
      expect(suite.members.map((member) => member.testId)).toEqual([
        fixture.memberTestId,
        fixture.secondMemberTestId,
      ])

      for (const member of [...direct.members, ...suite.members]) {
        const expected = parsedStepTexts(member)
        expect(expected.length).toBeGreaterThan(0)
        expect(member.stepTexts).toEqual(expected)
        expect(member.totalSteps).toBe(expected.length)
      }
    } finally {
      await target.close()
    }
  }, 120_000)
})

// RE-SPELLED 2026-09-30 (432-13). The D-07 pair used the run gate as its discriminator: an ambient
// read would have prompted where the injected context failed closed, and the reverse. The run gate is
// gone, so a non-production start no longer varies with the context at all — which is the claim the
// pair now pins, both ways round. The injected context is still what the run carries
// (`resolveExecutionContext: () => input.executionContext` in run-composition); its only reader until
// 432-19 is the in-run gate hook, which no action of this fixture reaches.
describe('a shared target starts whatever the injected or ambient context', () => {
  it.each([
    { ambient: 'local-interactive', injected: 'ci' },
    { ambient: 'ci', injected: 'local-interactive' },
  ] as const)('ambient $ambient, injected $injected: the run starts and knocks once', async ({ ambient, injected }) => {
    const target = new CountingTarget()
    await target.listen()
    try {
      pinAmbientExecutionContext(ambient)
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: injected },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error; the run still happened */ }

      expect(eventTypes(fixture as never)).toContain('runStarted')
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(auditRows(fixture as never)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)
})

// RE-SPELLED 2026-09-30 (432-13). This cell read the disclosure the confirm port was handed, and the
// port was its only consumer; no door asks about a run any more. What stays true on the door's own
// road is the reach half: a two-target invocation drives BOTH declared targets. The disclosure text
// itself keeps its unit cells beside `buildRunDisclosure` until 432-18/19 retire it.
describe('the CLI door drives every target a two-target invocation names', () => {
  it('a TWO-TARGET shared invocation starts and probes both declared targets', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'shared',
        secondTarget: true,
      })
      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-interactive' },
          { patterns: [fixture.testPattern, fixture.secondTestPattern!] },
        )
      } catch { /* the member's framework error; the run still happened */ }

      expect(eventTypes(fixture as never)).toContain('runStarted')
      expect([...target.hits].sort()).toEqual(['/in-process-thing', '/the-second-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)
})

describe('the run-start baseline is taken PER MEMBER and deduped by URL', () => {
  it('two members naming two different web targets: each target is probed, once', async () => {
    // The direct producer's road. Both targets declare `local`, so the run is allowed with no
    // confirm and the only axis left is which URLs assembly reaches for.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        secondTarget: true,
      })

      // REACH, BEFORE ANY CLAIM ABOUT PROBES. Two members, and the URLs they carry are the two
      // targets' own — read off the producer rather than off the run, so a run that died before
      // assembly cannot be mistaken for a run that chose not to probe.
      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.testPattern, fixture.secondTestPattern!],
        }),
      )
      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_per-member-probe' })
      expect(produced.members).toHaveLength(2)
      expect(produced.memberProbeUrls).toEqual([
        `${target.origin}/in-process-thing`,
        `${target.origin}/the-second-thing`,
      ])

      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns: [fixture.testPattern, fixture.secondTestPattern!] },
        )
      } catch { /* the members' framework errors; who was knocked on is what this cell reads */ }

      expect(auditRows(fixture as never)).toEqual([])
      expect([...target.hits].sort()).toEqual(['/in-process-thing', '/the-second-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('two members naming the SAME web target cost ONE probe, not one each', async () => {
    // The dedupe half, and the direction a naive per-member fix breaks: WR-04's complaint was an
    // unexpected outbound request, so turning one GET into N would be a regression dressed as a fix.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const patterns = [fixture.testPattern, 'tests/member.yaml']

      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({ configPath: fixture.configPath, patterns }),
      )
      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_dedupe-probe' })
      expect(produced.members).toHaveLength(2)
      expect(produced.memberProbeUrls).toEqual([
        `${target.origin}/in-process-thing`,
        `${target.origin}/in-process-thing`,
      ])

      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns },
        )
      } catch { /* as above */ }

      expect(auditRows(fixture as never)).toEqual([])
      expect(target.hits).toEqual(['/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE SUITE PRODUCER, the sibling half: two suite members, one target, one probe', async () => {
    // The same claim on the other producer. A fix applied to the direct loop and not to this one is
    // this repo's most-repeated defect, so the suite path gets its own cell rather than a reader's
    // assumption that the two loops agree.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        secondSuiteMember: true,
      })

      const inputs = await withExitTrap(() =>
        resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [fixture.suitePattern],
        }),
      )
      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_suite-probe' })
      expect(produced.members).toHaveLength(2)
      expect(produced.memberProbeUrls).toEqual([
        `${target.origin}/in-process-thing`,
        `${target.origin}/in-process-thing`,
      ])

      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns: [fixture.suitePattern] },
        )
      } catch { /* as above */ }

      expect(auditRows(fixture as never)).toEqual([])
      expect(target.hits).toEqual(['/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 441-58 (D-14): the drive writes no masking-digests sidecar beside events.jsonl
// ---------------------------------------------------------------------------

describe('a dashboard-launched run leaves no masking-digests sidecar', () => {
  it('a run directory holds events.jsonl and no masking-digests.json', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const plantedSecret = 'zq7-planted-masking-secret-405-02'
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        plantedSecret,
      })

      // The member dies on the pinned empty browsers root — a framework error the drive re-surfaces.
      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error */ }

      expect(eventTypes(fixture as never)).toContain('runStarted')
      const dirs = runDirs(fixture as never)
      expect(dirs).toHaveLength(1)
      const eventsPath = join(dirs[0]!, 'events.jsonl')
      expect(existsSync(eventsPath)).toBe(true)
      expect(existsSync(join(dirs[0]!, 'masking-digests.json'))).toBe(false)
      expect(readFileSync(eventsPath).includes(plantedSecret)).toBe(false)
    } finally {
      await target.close()
    }
  }, 120_000)

  // 441-48 (D-14): with the sidecar module deleted, the host root gains no masking key either.
  it('a finished run leaves no masking digest or host key', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        plantedSecret: 'zq7-planted-masking-secret-441-48',
      })

      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error */ }

      expect(eventTypes(fixture as never)).toContain('runFinished')
      const dirs = runDirs(fixture as never)
      expect(dirs).toHaveLength(1)
      expect(existsSync(join(dirs[0]!, 'masking-digests.json'))).toBe(false)
      expect(existsSync(join(fixture.agentQaRoot, 'masking-key'))).toBe(false)
    } finally {
      await target.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 441-12 (D-06, D-11): a run's records are masked by the redactor its producer read, and only by it
// ---------------------------------------------------------------------------

/** Every line of the one run's `events.jsonl`, as written. */
function eventLines(fixture: { project: string; suitePattern: string }): string[] {
  const dirs = runDirs(fixture as never)
  expect(dirs).toHaveLength(1)
  return readFileSync(join(dirs[0]!, 'events.jsonl'), 'utf8').split('\n').filter((line) => line !== '')
}

/** The one step text the run's one `testStarted` recorded. */
function onlyStepText(lines: readonly string[]): string {
  const stepTexts = lines
    .map((line) => JSON.parse(line) as { type: string; payload: { stepTexts?: string[] } })
    .filter((event) => event.type === 'testStarted')
    .flatMap((event) => event.payload.stepTexts ?? [])
  expect(stepTexts).toHaveLength(1)
  return stepTexts[0]!
}

describe('declared secrets in in-process run records', () => {
  it("an in-process run's events.jsonl holds the declared marker and the email as written", async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const plantedSecret = 'zq7-planted-run-records-441'
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        plantedSecret,
        stepText: `Sign in as qa@example.com with ${plantedSecret}`,
      })
      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error on the pinned empty browsers root */ }

      const lines = eventLines(fixture)
      expect(onlyStepText(lines)).toBe(`Sign in as qa@example.com with [secret:${PLANTED_SECRET_NAME}]`)
      expect(lines.filter((line) => line.includes(plantedSecret))).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  // The secrets file is rewritten once the run has started; the run keeps the redactor it read.
  it('a run masks with the secrets read at its own start', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        stepText: 'Sign in with Hunter-42-zz, then with Later-99-qq',
      })
      const secretsPath = join(fixture.project, '.env.secrets.local')
      writeFileSync(secretsPath, 'PW_441=Hunter-42-zz\n')
      let rewritten = false
      try {
        await runInProcessCliRun(
          {
            runRecord: testRunRecord(),
            ...fixtureOptions(fixture),
            executionContext: 'local-headless',
            onSession: (session) => {
              session.subscribe(1, () => {
                if (rewritten) return
                rewritten = true
                writeFileSync(secretsPath, 'PW_441=Later-99-qq\n')
              })
            },
          },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* the member's framework error on the pinned empty browsers root */ }

      expect(rewritten).toBe(true)
      const lines = eventLines(fixture)
      expect(onlyStepText(lines)).toBe('Sign in with [secret:PW_441], then with Later-99-qq')
      expect(lines.filter((line) => line.includes('Hunter-42-zz'))).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('two runs from different secrets files each mask with their own', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const stepText = 'Use alpha-441-x and bravo-441-y'
      const alpha = createInProcessFixture({ origin: target.origin, environment: 'local', stepText })
      const bravo = createInProcessFixture({ origin: target.origin, environment: 'local', stepText })
      writeFileSync(join(alpha.project, '.env.secrets.local'), 'A_441=alpha-441-x\n')
      writeFileSync(join(bravo.project, '.env.secrets.local'), 'B_441=bravo-441-y\n')
      const run = async (fixture: typeof alpha): Promise<void> => {
        try {
          await runInProcessCliRun(
            { runRecord: testRunRecord(), ...fixtureOptions(fixture), executionContext: 'local-headless' },
            { patterns: [fixture.testPattern] },
          )
        } catch { /* the member's framework error on the pinned empty browsers root */ }
      }
      await Promise.all([run(alpha), run(bravo)])

      const alphaLines = eventLines(alpha)
      const bravoLines = eventLines(bravo)
      expect(onlyStepText(alphaLines)).toBe('Use [secret:A_441] and bravo-441-y')
      expect(onlyStepText(bravoLines)).toBe('Use alpha-441-x and [secret:B_441]')
      expect(alphaLines.filter((line) => line.includes('alpha-441-x'))).toEqual([])
      expect(bravoLines.filter((line) => line.includes('bravo-441-y'))).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)
})

// 2026-10-17 (443-08, D-05): a runs.start that names a suite opens its record before the suite is
// prepared, so an unopenable runs.db refuses it before any plugin loads.
describe('a suite run opens its record before preparing the suite', () => {
  it('a runs.start whose pattern is a suite opens the record before preparing the suite', async () => {
    const target = new CountingTarget()
    await target.listen()
    const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
    const composed = composeCliLocalAgent({ agentQaRoot: fixture.agentQaRoot, configPath: fixture.configPath })
    try {
      fixtureOptions(fixture)
      const marker = join(fixture.project, 'plugin-loaded.marker')
      writeFileSync(join(fixture.project, 'marker-auth-plugin.mjs'), [
        "import { writeFileSync } from 'node:fs'",
        "writeFileSync(new URL('./plugin-loaded.marker', import.meta.url), String(process.pid))",
        'export const providers = []',
        '',
      ].join('\n'))
      writeFileSync(
        fixture.configPath,
        `${readFileSync(fixture.configPath, 'utf8')}plugins:\n  auth:\n    - path: ./marker-auth-plugin.mjs\n`,
      )
      const dbPath = join(fixture.agentQaRoot, 'runs.db')
      mkdirSync(fixture.agentQaRoot, { recursive: true })
      const old = new DatabaseSync(dbPath)
      old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 4')
      old.close()

      let refusal: unknown
      try {
        await invokeFunction(composed.registry, 'runs.start', { patterns: [fixture.suitePattern] }, CLI_FUNCTION_CALLER)
      } catch (error) {
        refusal = error
      }

      const message = refusal instanceof Error ? refusal.message : String(refusal)
      expect(message.includes(dbPath) && message.includes('The run was not started.'), `the refusal: ${message}`).toBe(true)
      expect(runDirs(fixture as never).length, 'run directories').toBe(0)
      expect(existsSync(marker), 'the auth plugin loaded').toBe(false)
    } finally {
      await composed.close()
      await target.close()
    }
  }, 120_000)
})

describe('a run that re-raises a framework error hands over its post-run work', () => {
  it('the drive hands its detached post-run work to onPostRun before it throws', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const handedOver: Array<Promise<void>> = []
      // An aborted signal stops the drive waiting on the analysis enqueue, so the enqueue is still
      // the run's detached work when the member's framework error is re-raised.
      const postVerdictSignal = AbortSignal.abort()
      let thrown: unknown
      try {
        await runInProcessCliRun(
          {
            runRecord: testRunRecord(),
            ...fixtureOptions(fixture),
            executionContext: 'local-headless',
            postVerdictSignal,
            onPostRun: (settled) => { handedOver.push(settled) },
          },
          { patterns: [fixture.testPattern] },
        )
      } catch (error) {
        thrown = error
      }

      expect(thrown, 'the member raised no framework error').toBeInstanceOf(Error)
      expect(handedOver, 'the detached post-run work was not handed over').toHaveLength(1)
      await expect(handedOver[0]).resolves.toBeUndefined()
    } finally {
      await target.close()
    }
  }, 120_000)
})
