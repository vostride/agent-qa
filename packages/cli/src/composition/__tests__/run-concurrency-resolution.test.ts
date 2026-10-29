// THE CONFIG-SIDE HALF OF D-12: a worker count is resolved from CONFIG, at one seam.
//
// The request-side half — that a CALLER cannot name either field — is pinned in the schema
// package's `runs-start-input-posture.test.ts`, and the formula itself in `use-parallel.test.ts`.
// What is left, and what only this package can measure, is the CHAIN: a `use.parallel` /
// `use.workers` a person wrote in `agent-qa.config.yaml` survives the shipped config schema, is
// read by the shipped member producer, and lands on the `RunConfig` the shell reads `workers` off.
//
// EACH LINK IS PINNED SEPARATELY AND DELIBERATELY, rather than through one end-to-end run that
// watches members overlap. Two reasons, both measured rather than assumed: the suite path
// SERIALIZES its members whatever `workers` says (each member drives the one `suiteConfig.adapter`
// its suite set up — 402-02, WINDOWS #232), so a suite-shaped cell would observe nothing; and a
// direct-path cell that inferred the count from wall-clock overlap would be a timing assertion
// wearing a config assertion's clothes. 402-02 already pinned the last link — `config.workers` to
// actual concurrent execution — on injected executors in `run-shell.concurrency.test.ts`.

import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { DEFAULT_PARALLEL_WORKERS, resolveEffectiveWorkers } from '@vostride/agent-qa-schema'

import { CliRunInputError } from '../cli-run-input-error.js'
import { assembleCliRun } from '../run-assembly.js'
import { runInProcessCliRun } from '../in-process-run-execution.js'
import {
  produceMembersFromPatterns,
  resolveRunConcurrencyConfig,
  resolveRunInvocationInputs,
} from '../../commands/run.js'
import type { RunOptions } from '../../commands/run.js'
import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { closeTestRunRecords, testRunRecord } from './in-process-run-fixture.js'
import { removeTempRoots } from '../../__tests__/temp-roots.js'

// every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })
const assemblyRoots: string[] = []
afterAll(() => {
  removeInProcessFixtures()
  removeTempRoots(assemblyRoots.splice(0))
})

/**
 * WHAT THE DRIVE HANDED THE ASSEMBLER, captured at the seam itself.
 *
 * A SPY RATHER THAN A SOURCE GREP, and the difference is not stylistic: a grep for
 * `resolveEffectiveWorkers` in the drive passes on the IMPORT LINE alone, so replacing the drive's
 * whole expression with a literal `workers: 1` survives it. That mutation was run (M7) and it
 * survived exactly that way — this capture is what reds on it, because it reads the number the
 * drive computed for a project whose config asked for two.
 *
 * The real assembler still runs: the wrapper records and delegates, so every other artifact of the
 * run below is the shipped one.
 */
const assemblerSeam = vi.hoisted(() => ({
  calls: [] as { readonly workers: number | undefined; readonly memberCount: number }[],
}))

vi.mock('../run-assembly.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../run-assembly.js')>()
  return {
    ...actual,
    assembleCliRun: async (input: Parameters<typeof actual.assembleCliRun>[0]) => {
      assemblerSeam.calls.push({ workers: input.workers, memberCount: input.members.length })
      return await actual.assembleCliRun(input)
    },
  }
})

const noFlags = {} as RunOptions

describe('resolveRunConcurrencyConfig — the flags are ORDINARY use-bucket overrides', () => {
  it('reads the config pair when no flag is given', () => {
    expect(resolveRunConcurrencyConfig({ parallel: true, workers: 4 }, noFlags))
      .toEqual({ parallel: true, workers: 4 })
  })

  it('answers an empty pair for a config that says nothing', () => {
    expect(resolveRunConcurrencyConfig({ llm: 'x' }, noFlags)).toEqual({})
    expect(resolveRunConcurrencyConfig(undefined, noFlags)).toEqual({})
  })

  it('lets --parallel turn concurrency ON for a config that never mentioned it', () => {
    expect(resolveRunConcurrencyConfig({}, { parallel: true } as RunOptions))
      .toEqual({ parallel: true })
  })

  it('lets --no-parallel turn OFF a config that asked for concurrency', () => {
    // Commander hands `--no-parallel` through as `parallel: false`, which is what makes this an
    // override rather than a one-way switch: a person who wants a sequential run of a parallel
    // project must be able to say so on the command line.
    expect(resolveRunConcurrencyConfig({ parallel: true, workers: 6 }, { parallel: false } as RunOptions))
      .toEqual({ parallel: false, workers: 6 })
    expect(resolveEffectiveWorkers({
      ...resolveRunConcurrencyConfig({ parallel: true, workers: 6 }, { parallel: false } as RunOptions),
      memberCount: 6,
    })).toBe(1)
  })

  it('lets --workers raise the count over the config, as an argv string', () => {
    expect(resolveRunConcurrencyConfig({ parallel: true, workers: 2 }, { workers: '5' } as RunOptions))
      .toEqual({ parallel: true, workers: 5 })
  })

  it('lets a MEMBER\'s own use.parallel: false make the whole run sequential', () => {
    // Most-restrictive-wins, over the config AND over the flag: a test that says it must not run
    // beside another is making a claim about itself that no project-level setting can answer for.
    expect(resolveRunConcurrencyConfig({ parallel: true, workers: 4 }, noFlags, [
      undefined,
      { parallel: false },
      {},
    ])).toEqual({ parallel: false, workers: 4 })
    expect(resolveRunConcurrencyConfig({}, { parallel: true } as RunOptions, [{ parallel: false }]))
      .toEqual({ parallel: false })
  })

  it('leaves a parallel run alone when no member opted out', () => {
    // The control for the arm above: members that say nothing (and members that say `true`) must
    // not be read as an opt-out, or the whole feature would be off for every ordinary project.
    expect(resolveRunConcurrencyConfig({ parallel: true }, noFlags, [undefined, {}, { parallel: true }]))
      .toEqual({ parallel: true })
  })

  it('refuses a --workers value that is not a positive integer, rather than coercing it', () => {
    for (const value of ['abc', '0', '-3', '2.5', '', ' ']) {
      let refusal: unknown
      try {
        resolveRunConcurrencyConfig({ parallel: true }, { workers: value } as RunOptions)
      } catch (err) {
        refusal = err
      }
      expect(refusal, `--workers ${JSON.stringify(value)}`).toBeInstanceOf(CliRunInputError)
    }
  })
})

describe('the chain: agent-qa.config.yaml → the shipped producer', () => {
  it('carries an authored use.parallel + use.workers onto the produced object', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        parallelRuns: true,
        workerCount: 2,
      })
      const inputs = await resolveRunInvocationInputs({
        configPath: fixture.configPath,
        patterns: [fixture.testPattern],
      })
      // Reaching here at all is half the cell: the config is parsed by the SHIPPED strict schema,
      // so an unrecognised `use.workers` would have been a parse refusal, not a silent drop.
      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_concurrency-chain' })

      expect(produced.concurrency).toEqual({ parallel: true, workers: 2 })
    } finally {
      await target.close()
    }
  }, 120_000)

  it('carries an empty pair for a project that configured nothing — the shipped default', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const inputs = await resolveRunInvocationInputs({
        configPath: fixture.configPath,
        patterns: [fixture.testPattern],
      })
      const produced = await produceMembersFromPatterns({ inputs, runId: 'r_concurrency-default' })

      expect(produced.concurrency).toEqual({})
      expect(resolveEffectiveWorkers({ ...produced.concurrency, memberCount: 4 })).toBe(1)
    } finally {
      await target.close()
    }
  }, 120_000)
})

describe('the chain: the resolved count → the RunConfig the shell reads', () => {
  function assemblyInput(workers: number | undefined): Parameters<typeof assembleCliRun>[0] {
    const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'run-assembly-workers-')))
    assemblyRoots.push(configDir)
    return {
      runId: 'r_assembly-workers',
      executionContext: 'local-headless' as never,
      configDir,
      knowledgeRoot: join(configDir, 'knowledge'),
      ports: {} as never,
      secretRedactor: new SecretRedactor(new SecretStore()),
      members: [],
      executor: (() => { throw new Error('unreachable in this cell') }) as never,
      configDigests: { config: 'c', source: 's' } as never,
      product: 'workers-product',
      warn: () => { /* no fold in this cell */ },
      ...(workers === undefined ? {} : { workers }),
    }
  }

  it('stamps a resolved count above 1 onto the RunConfig', async () => {
    const assembly = await assembleCliRun(assemblyInput(4))

    expect(assembly.config.workers).toBe(4)
  })

  it('leaves the field ABSENT for a sequential run, so its RunConfig has no workers member', async () => {
    for (const workers of [undefined, 1]) {
      const assembly = await assembleCliRun(assemblyInput(workers))

      expect('workers' in assembly.config, `workers: ${String(workers)}`).toBe(false)
    }
  })

  it('is the same count the one formula answers for the authored config', () => {
    // The seam expression, spelled here on the SAME inputs the drive uses: the producer's pair and
    // the produced member count. A drive that folded its own default would disagree with this.
    expect(resolveEffectiveWorkers({ parallel: true, memberCount: 9 })).toBe(DEFAULT_PARALLEL_WORKERS)
  })
})

describe('the drive: the ONE seam that applies the formula, for every door', () => {
  /**
   * Drive a REAL two-member run of a project configured exactly as the arm says, and answer with
   * what the drive handed the assembler.
   *
   * TWO MEMBERS ON PURPOSE, AND THREE ARMS ON PURPOSE. `min(memberCount, workers)` over ONE member
   * is 1, which is also what a drive that resolved nothing would hand over — so a one-member cell
   * passes for the wrong reason. Two members separate 2 from 1; and the third arm below
   * (`workers: 1` with `parallel: true`) is what separates the formula from `parallel ? memberCount
   * : 1`, a mutation that survives both of the other two arms (M9).
   */
  async function workersHandedToAssembler(
    fixtureInput: { parallelRuns?: boolean; workerCount?: number },
  ): Promise<{ workers: number | undefined; memberCount: number }> {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        secondTarget: true,
        ...fixtureInput,
      })
      assemblerSeam.calls.length = 0
      try {
        await runInProcessCliRun(
          {
            runRecord: testRunRecord(),
            configPath: fixture.configPath,
            agentQaRoot: fixture.agentQaRoot,
            executionContext: 'local-headless',
          },
          { patterns: [fixture.testPattern, fixture.secondTestPattern!] },
        )
      } catch {
        // The members fail downstream of `startRun` (no browser binaries on this machine) and the
        // drive re-surfaces the first framework error. The run still reached assembly, which is
        // the only thing these cells read.
      }
      expect(assemblerSeam.calls, 'assembly never happened — nothing below measures a count')
        .toHaveLength(1)
      return assemblerSeam.calls[0]!
    } finally {
      await target.close()
    }
  }

  it('hands over the count the CONFIG asked for', async () => {
    expect(await workersHandedToAssembler({ parallelRuns: true, workerCount: 2 }))
      .toEqual({ workers: 2, memberCount: 2 })
  }, 180_000)

  it('hands over 1 for the same project with no concurrency configured', async () => {
    // The control, two config lines different: the SAME two members, and the drive's answer is the
    // shipped sequential count.
    expect(await workersHandedToAssembler({})).toEqual({ workers: 1, memberCount: 2 })
  }, 180_000)

  it('honours a configured ceiling BELOW the member count', async () => {
    // `parallel: true, workers: 1` — a config owner who wants the pool's shape without its
    // concurrency. A drive that took the member count whenever `parallel` was set would answer 2.
    expect(await workersHandedToAssembler({ parallelRuns: true, workerCount: 1 }))
      .toEqual({ workers: 1, memberCount: 2 })
  }, 180_000)
})

describe('the source pin: the drive is the formula\'s CALLER, not a second speller', () => {
  it('imports the formula and spells none of its literals', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'in-process-run-execution.ts'), 'utf8')

    expect(source).toContain('resolveEffectiveWorkers')
    // A second `?? 3` or a second `Math.min` in this file would be a second default living beside
    // the imported one — precisely the drift this cell exists to refuse. (The single declaration
    // of the formula itself is pinned in the package that owns it, `use-parallel.test.ts`.)
    expect(source).not.toMatch(/\?\?\s*3\b/)
    expect(source.match(/Math\.min\(/g)).toBeNull()
  })
})
