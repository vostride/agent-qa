// This layer owns ordering, filtering and the cap, and never learns where a run's bytes live.

import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  MaskFn,
  PerTestOutcome,
  RecordedTargets,
  RunStatus,
  RunSummary,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { FunctionInputError, invokeFunction } from '../invoke.js'
import { runsListSpec } from '../ops/runs-list.js'
import { createRegistryFromSpecs } from '../registry.js'
import type { FunctionDeps } from '../spec.js'

const READER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}

function member(testIndex: number, testId: string, testName: string): PerTestOutcome {
  return {
    testId,
    testName,
    filePath: `tests/${testId}.yaml`,
    testIndex,
    outcome: 'passed',
    steps: [],
  }
}

function run(input: {
  runId: string
  endedAt: number
  verdict?: RunStatus
  buildOrdinal?: number
  tests?: PerTestOutcome[]
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: input.buildOrdinal ?? 1,
    executionContext: 'local-headless',
    aggregateVerdict: input.verdict ?? 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: Math.max(0, input.endedAt - 10),
    endedAt: input.endedAt,
    tests: input.tests ?? [member(0, `t-${input.runId}`, `Checkout ${input.runId}`)],
  }
}

interface Harness {
  list(input: unknown): Promise<RunSummary[]>
  listCalls(): number
  targetCalls(): readonly string[]
}

function harness(
  documents: readonly CompletedRunHandoff[],
  targets?: (runId: string) => RecordedTargets,
  secretMask: MaskFn | null = text => text,
): Harness {
  let listCalls = 0
  const targetCalls: string[] = []
  const runs = {
    list: () => {
      listCalls += 1
      return Promise.resolve(documents)
    },
    get: (runId: string) => Promise.resolve(documents.find((document) => document.runId === runId)),
    readEvents: () => Promise.resolve([]),
    readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    ...(targets === undefined
      ? {}
      : {
          getRecordedTargets: (runId: string) => {
            targetCalls.push(runId)
            return Promise.resolve(targets(runId))
          },
        }),
  }
  const registry = createRegistryFromSpecs([runsListSpec], {
    deps: { runs, ...(secretMask === null ? {} : { secretMask }) } as unknown as FunctionDeps,
  })
  return {
    list: async (input) => (await invokeFunction(registry, 'runs.list', input, READER)) as RunSummary[],
    listCalls: () => listCalls,
    targetCalls: () => targetCalls,
  }
}

function numbered(count: number, from = 1): CompletedRunHandoff[] {
  return Array.from({ length: count }, (_, offset) => {
    const ordinal = from + offset
    return run({ runId: `run-${String(ordinal).padStart(3, '0')}`, endedAt: 10_000 + ordinal * 100 })
  })
}

describe('LIST-BOUNDARIES: runs.list order, cap and validation', () => {
  it('returns [] for an empty store', async () => {
    expect(await harness([]).list({})).toEqual([])
  })

  it('defaults to the 20 newest completions, endedAt descending', async () => {
    const listed = await harness(numbered(21)).list({})

    expect(listed).toHaveLength(20)
    expect(listed[0]!.runId).toBe('run-021')
    expect(listed.at(-1)!.runId).toBe('run-002')
    expect(listed.map((row) => row.runId)).not.toContain('run-001')
  })

  it('accepts the limit boundaries 1, 20 and 200', async () => {
    const reader = harness(numbered(201))

    expect((await reader.list({ limit: 1 })).map((row) => row.runId)).toEqual(['run-201'])
    expect(await reader.list({ limit: 20 })).toHaveLength(20)
    const widest = await reader.list({ limit: 200 })
    expect(widest).toHaveLength(200)
    expect(widest.at(-1)!.runId).toBe('run-002')
  })

  it.each([
    ['zero', 0],
    ['above the maximum', 201],
    ['fractional', 1.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
    ['negative', -1],
  ])('refuses a %s limit before reading the store', async (_label, limit) => {
    const reader = harness(numbered(3))

    await expect(reader.list({ limit })).rejects.toBeInstanceOf(FunctionInputError)
    expect(reader.listCalls()).toBe(0)
  })

  it.each([
    ['negative', -1],
    ['fractional', 1_000.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses a %s since before reading the store', async (_label, since) => {
    const reader = harness(numbered(3))

    await expect(reader.list({ since })).rejects.toBeInstanceOf(FunctionInputError)
    expect(reader.listCalls()).toBe(0)
  })

  it('treats since as inclusive epoch milliseconds with no rounding', async () => {
    const documents = [
      run({ runId: 'run-before', endedAt: 1_699_999_999_999 }),
      run({ runId: 'run-at', endedAt: 1_700_000_000_000 }),
      run({ runId: 'run-after', endedAt: 1_700_000_000_001 }),
    ]

    const listed = await harness(documents).list({ since: 1_700_000_000_000 })

    expect(listed.map((row) => row.runId)).toEqual(['run-after', 'run-at'])
    expect(await harness(documents).list({ since: 0 })).toHaveLength(3)
  })

  it('breaks an endedAt tie by runId descending, never by list order', async () => {
    const documents = [
      run({ runId: 'run-b', endedAt: 5_000 }),
      run({ runId: 'run-c', endedAt: 5_000 }),
      run({ runId: 'run-a', endedAt: 5_000 }),
      run({ runId: 'run-z', endedAt: 4_999 }),
    ]

    expect((await harness(documents).list({})).map((row) => row.runId))
      .toEqual(['run-c', 'run-b', 'run-a', 'run-z'])
    expect((await harness([...documents].reverse()).list({})).map((row) => row.runId))
      .toEqual(['run-c', 'run-b', 'run-a', 'run-z'])
  })

  it('orders by completion, not by build ordinal', async () => {
    const documents = [
      run({ runId: 'run-late-build', endedAt: 1_000, buildOrdinal: 99 }),
      run({ runId: 'run-early-build', endedAt: 2_000, buildOrdinal: 1 }),
    ]

    expect((await harness(documents).list({})).map((row) => row.runId))
      .toEqual(['run-early-build', 'run-late-build'])
  })

  it('reads one completed snapshot per invocation', async () => {
    const reader = harness(numbered(5))

    await reader.list({ verdict: 'passed', test: 'checkout', limit: 2 })

    expect(reader.listCalls()).toBe(1)
  })
})

describe('LIST-ROWS: every row names all of its tests', () => {
  it('projects every member test id, title and index in recorded order', async () => {
    const documents = [
      run({
        runId: 'run-suite',
        endedAt: 3_000,
        tests: [
          member(0, 't-login', 'Login works'),
          member(1, 't-cart', 'Cart totals'),
          member(2, 't-pay', 'Payment declines'),
        ],
      }),
    ]

    const [row] = await harness(documents).list({ test: 't-cart' })

    expect(row!.tests).toEqual([
      { testIndex: 0, testId: 't-login', testName: 'Login works' },
      { testIndex: 1, testId: 't-cart', testName: 'Cart totals' },
      { testIndex: 2, testId: 't-pay', testName: 'Payment declines' },
    ])
    expect(row!.testCount).toBe(3)
  })

  it('masks a declared secret in a test name and never matches the title filter on it', async () => {
    const secret = 'T431-list-sentinel-not-a-real-credential'
    const documents = [run({ runId: 'run-secret', endedAt: 1,
      tests: [member(0, 't-login', `Login as ${secret}`)] })]
    const reader = harness(documents, undefined, declaredMask({ LIST_KEY: secret }))

    const [row] = await reader.list({})
    expect(row!.tests[0]!.testName).toBe('Login as [secret:LIST_KEY]')
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(await reader.list({ test: secret.slice(0, 12) })).toEqual([])
    expect((await reader.list({ test: 'login as' })).map((listed) => listed.runId)).toEqual(['run-secret'])

    await expect(harness(documents, undefined, null).list({ test: 'login' }))
      .rejects.toThrow(/no declared-secret mask/)
    const unreadable = harness(documents, undefined, () => { throw new Error('synthetic unreadable secrets file') })
    await expect(unreadable.list({ test: 'login' })).rejects.toThrow('synthetic unreadable secrets file')
    await expect(unreadable.list({ test: 't-login' })).rejects.toThrow('synthetic unreadable secrets file')
  })

  it('reports an unknown target set when no recorded target reader is bound', async () => {
    const [row] = await harness([run({ runId: 'run-one', endedAt: 1 })]).list({})

    expect(row!.recordedTargets).toEqual({ status: 'unknown' })
  })
})

describe('LIST-FILTERS: filters select before the cap', () => {
  it('filters by aggregate verdict before capping', async () => {
    const documents = [
      ...Array.from({ length: 21 }, (_, index) =>
        run({ runId: `run-f${String(index).padStart(2, '0')}`, endedAt: 1_000 + index, verdict: 'failed' })),
      ...Array.from({ length: 10 }, (_, index) =>
        run({ runId: `run-p${String(index).padStart(2, '0')}`, endedAt: 5_000 + index, verdict: 'passed' })),
    ]

    const listed = await harness(documents).list({ verdict: 'failed' })

    expect(listed).toHaveLength(20)
    expect(listed.every((row) => row.aggregateVerdict === 'failed')).toBe(true)
    expect(listed[0]!.runId).toBe('run-f20')
  })

  it('matches a test by exact id, never by id case or prefix', async () => {
    const documents = [
      run({ runId: 'run-1', endedAt: 1, tests: [member(0, 't-cart', 'Basket')] }),
      run({ runId: 'run-2', endedAt: 2, tests: [member(0, 't-cart-2', 'Basket two')] }),
    ]
    const reader = harness(documents)

    expect((await reader.list({ test: 't-cart' })).map((row) => row.runId)).toEqual(['run-1'])
    expect(await reader.list({ test: 'T-CART' })).toEqual([])
  })

  it('matches a title substring with Unicode lowercasing and no normalization', async () => {
    const composed = 'Écran de paiement'
    const decomposed = 'Écran de paiement'
    const documents = [
      run({ runId: 'run-composed', endedAt: 1, tests: [member(0, 't-1', composed)] }),
      run({ runId: 'run-decomposed', endedAt: 2, tests: [member(0, 't-2', decomposed)] }),
    ]
    const reader = harness(documents)

    expect((await reader.list({ test: 'ÉCRAN' })).map((row) => row.runId)).toEqual(['run-composed'])
    expect((await reader.list({ test: 'ÉCRAN' })).map((row) => row.runId))
      .toEqual(['run-decomposed'])
    expect((await reader.list({ test: 'de PAIEMENT' })).map((row) => row.runId))
      .toEqual(['run-decomposed', 'run-composed'])
  })

  it.each([
    ['empty test', { test: '' }],
    ['whitespace test', { test: ' \t ' }],
    ['empty target', { target: '' }],
    ['whitespace target', { target: '   ' }],
    ['unknown verdict', { verdict: 'green' }],
    ['unknown key', { order: 'asc' }],
  ])('refuses an invalid %s filter before reading the store', async (_label, input) => {
    const reader = harness(numbered(2))

    await expect(reader.list(input)).rejects.toBeInstanceOf(FunctionInputError)
    expect(reader.listCalls()).toBe(0)
  })

  it('never matches a target against a run whose targets are unknown', async () => {
    const reader = harness([run({ runId: 'run-one', endedAt: 1 })])

    expect(await reader.list({ target: 'shop' })).toEqual([])
  })
})

describe('LIST-TARGETS: recorded targets through the narrow reader port', () => {
  const recorded = (...names: string[]): RecordedTargets => ({ status: 'recorded', names })

  it('filters on an exact recorded target name before capping', async () => {
    const documents = Array.from({ length: 25 }, (_, index) =>
      run({ runId: `run-${String(index).padStart(2, '0')}`, endedAt: 1_000 + index }))
    const reader = harness(documents, (runId) => (
      Number(runId.slice(4)) % 5 === 0 ? recorded('android-qa') : recorded('staging-web', 'android-qa')
    ))

    const listed = await reader.list({ target: 'staging-web' })

    expect(listed).toHaveLength(20)
    expect(listed[0]!.runId).toBe('run-24')
    expect(listed.map((row) => row.runId)).not.toContain('run-20')
    expect(listed.every((row) => row.recordedTargets.status === 'recorded')).toBe(true)
  })

  it('compares target names exactly: no case folding and no substring', async () => {
    const reader = harness([run({ runId: 'run-one', endedAt: 1 })], () => recorded('staging-web'))

    expect(await reader.list({ target: 'Staging-Web' })).toEqual([])
    expect(await reader.list({ target: 'staging' })).toEqual([])
    expect((await reader.list({ target: 'staging-web' })).map((row) => row.runId)).toEqual(['run-one'])
  })

  it('carries each row\'s recorded targets and never matches an unknown one', async () => {
    const documents = [
      run({ runId: 'run-known', endedAt: 2 }),
      run({ runId: 'run-unknown', endedAt: 1 }),
    ]
    const reader = harness(documents, (runId) => (
      runId === 'run-known' ? recorded('staging-web') : { status: 'unknown' }
    ))

    expect((await reader.list({})).map((row) => [row.runId, row.recordedTargets])).toEqual([
      ['run-known', { status: 'recorded', names: ['staging-web'] }],
      ['run-unknown', { status: 'unknown' }],
    ])
    expect((await reader.list({ target: 'staging-web' })).map((row) => row.runId))
      .toEqual(['run-known'])
  })

  it('looks targets up only for the rows it returns when no target filter is set', async () => {
    const reader = harness(numbered(30), () => recorded('staging-web'))

    await reader.list({ limit: 3 })

    expect(reader.targetCalls()).toEqual(['run-030', 'run-029', 'run-028'])
  })
})
