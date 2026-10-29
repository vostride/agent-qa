// `runs.detail` — the op's refusal vocabulary and the D-06 token sum (Phase 405 plan 01, D-03).
//
// The end-to-end path this op sits on is measured in `dashboard-server`'s tracer cell, over a real
// database and a real socket. What CANNOT be measured there is what this file measures: the two
// refusals by NAME, and the arithmetic of a sum whose whole contract is what it leaves out.
//
// THE SUM IS TESTED SEPARATELY FROM THE SPEC because it is separately exported, and it is
// separately exported for the reason `projectPostProcessingChips` is: a total mapping with no
// port and nothing to await can have an exhaustive table written over it for the cost of a test
// file rather than a store.

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  EvidenceBlobPresence,
  FunctionCaller,
  RunDetailRows,
  RunDetailStep,
  RunDetailSubAction,
  RunId,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../functions/invoke.js'
import {
  RUNS_DETAIL_FUNCTION_ID,
  projectRunTokenTotals,
  runsDetailSpec,
} from '../functions/ops/runs-detail.js'
import { createFunctionRegistry } from '../functions/registry.js'
import type { FunctionDeps } from '../functions/spec.js'

const RUN_ID = 'run-alpha' as RunId

function step(overrides: Partial<RunDetailStep> = {}): RunDetailStep {
  return {
    testIndex: 0,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    ...overrides,
  }
}

/** The only dep this op reads. Everything else on `FunctionDeps` is unreachable from here. */
function depsWith(read: ((runId: RunId) => Promise<RunDetailRows | undefined>) | undefined): FunctionDeps {
  return (read === undefined ? {} : { runDetail: { read } }) as unknown as FunctionDeps
}

const EMPTY_ROWS: RunDetailRows = { runId: RUN_ID, members: [], steps: [], subActions: [] }

describe('the op refuses BY NAME rather than answering about a projection it cannot see', () => {
  it('throws FunctionNotBoundError when the composition binds no runDetail port', async () => {
    // Read STRUCTURALLY off `name`, exactly as the dashboard route classifies it — this package's
    // consumers may not import the error class, so the name IS the contract.
    await expect(runsDetailSpec.invoke({ runId: RUN_ID }, depsWith(undefined)))
      .rejects.toMatchObject({ name: 'FunctionNotBoundError' })
    // And it names the capability, so an operator learns WHICH op this host does not bind.
    await expect(runsDetailSpec.invoke({ runId: RUN_ID }, depsWith(undefined)))
      .rejects.toThrow(RUNS_DETAIL_FUNCTION_ID)
  })

  it('turns the port\'s undefined into RunNotFoundError — reusing runs.get\'s word, not a second one', async () => {
    await expect(runsDetailSpec.invoke({ runId: RUN_ID }, depsWith(() => Promise.resolve(undefined))))
      .rejects.toMatchObject({ name: 'RunNotFoundError' })
  })

  it('a run that exists and projected nothing is an ANSWER, not a refusal', async () => {
    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, depsWith(() => Promise.resolve(EMPTY_ROWS)))
    expect(result.runId).toBe(RUN_ID)
    expect(result.members).toEqual([])
    expect(result.steps).toEqual([])
    expect(result.subActions).toEqual([])
    expect(result.tokens).toEqual({ measuredSteps: 0, unmeasuredSteps: 0 })
  })

  it('reads the port with the run id it was given and nothing else', async () => {
    const seen: RunId[] = []
    await runsDetailSpec.invoke({ runId: RUN_ID }, depsWith((runId) => {
      seen.push(runId)
      return Promise.resolve(EMPTY_ROWS)
    }))
    expect(seen).toEqual([RUN_ID])
  })
})

describe('projectRunTokenTotals — absent is not zero', () => {
  it('answers two counts and NO sums when nothing was measured', () => {
    const totals = projectRunTokenTotals([])
    expect(totals).toEqual({ measuredSteps: 0, unmeasuredSteps: 0 })
    // The key ABSENCE is the claim, not the value: a `totalTokens: 0` would be a measurement
    // nobody took, and a page cannot tell that apart from a run that really spent nothing.
    expect(Object.keys(totals).sort()).toEqual(['measuredSteps', 'unmeasuredSteps'])
    expect('totalTokens' in totals).toBe(false)
  })

  it('offers no sums for a run whose every step is unmeasured', () => {
    const totals = projectRunTokenTotals([step(), step({ stepIndex: 1 }), step({ stepIndex: 2 })])
    expect(totals).toEqual({ measuredSteps: 0, unmeasuredSteps: 3 })
    expect('totalTokens' in totals).toBe(false)
  })

  it('sums the measured steps and counts the rest', () => {
    const totals = projectRunTokenTotals([
      step({ stepIndex: 0, tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
      step({ stepIndex: 1, tokenUsage: { promptTokens: 300, completionTokens: 45, totalTokens: 345 } }),
      step({ stepIndex: 2 }),
    ])
    expect(totals).toEqual({
      measuredSteps: 2,
      unmeasuredSteps: 1,
      promptTokens: 400,
      completionTokens: 65,
      totalTokens: 465,
    })
  })

  it('sums a mixed run step-by-step — the parts are summed independently, never re-derived', () => {
    // Small asymmetric counts on purpose: a transposed prompt/completion accumulator would still
    // produce the right `totalTokens` with the symmetric fixtures above, and would be invisible.
    const totals = projectRunTokenTotals([
      step({ stepIndex: 0, tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
      step({ stepIndex: 1, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
      step({ stepIndex: 2 }),
    ])
    expect(totals).toEqual({
      measuredSteps: 2,
      unmeasuredSteps: 1,
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 17,
    })
  })

  it('two unmeasured steps answer two counts and no sum keys at all', () => {
    const totals = projectRunTokenTotals([step({ stepIndex: 0 }), step({ stepIndex: 1 })])
    expect(totals).toEqual({ measuredSteps: 0, unmeasuredSteps: 2 })
    expect(Object.keys(totals).sort()).toEqual(['measuredSteps', 'unmeasuredSteps'])
  })

  it('a measured step that genuinely spent zero is still MEASURED', () => {
    // The distinction the whole shape exists for, from the other side: a provider that reported
    // a zero-token call is a measurement, and it must not be counted as an absent one.
    const totals = projectRunTokenTotals([
      step({ tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    ])
    expect(totals).toEqual({
      measuredSteps: 1,
      unmeasuredSteps: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })
  })

  it('is the sum the op returns — one producer, not two', async () => {
    const rows: RunDetailRows = {
      ...EMPTY_ROWS,
      steps: [
        step({ tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        step({ stepIndex: 1 }),
      ],
    }
    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, depsWith(() => Promise.resolve(rows)))
    expect(result.tokens).toEqual(projectRunTokenTotals(rows.steps))
  })
})

describe('the declaration', () => {
  it('carries a dotted lowercase op id', () => {
    expect(RUNS_DETAIL_FUNCTION_ID).toMatch(/^[a-z]+(?:\.[a-z]+)+$/)
    expect(runsDetailSpec.id).toBe(RUNS_DETAIL_FUNCTION_ID)
  })

  it('is a read-tier, read-only unary op bound through the optional runDetail dep', () => {
    // RE-SPELLED 2026-10-01 (432-27, D-12) from `requiredScopes` equal to ['read']: the op
    // declares no scope; the read-only risk below is what still states the tier.
    expect(runsDetailSpec).not.toHaveProperty('requiredScopes')
    expect(runsDetailSpec.resultKind).toBe('unary')
    expect(runsDetailSpec.boundThrough).toBe('runDetail')
    expect(runsDetailSpec.risk).toEqual({ name: 'fn:runs.detail', recognized: true, readOnly: true })
  })

  it('folds the three counts and interpolates NOTHING from inside the payload', () => {
    const verdict = runsDetailSpec.classify({
      runId: RUN_ID,
      members: [{ testIndex: 0, attempts: 1 }],
      steps: [step()],
      subActions: [],
      tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
    })
    expect(verdict.status).toBe('executed')
    expect(verdict.outcome).toBe('1 member(s), 1 step(s), 0 sub-action(s)')
  })
})

// Read-time presence on every projected artifact ref (406-03, D-17, DETL-05).
//
// The projection records which blobs a sub-action produced; it cannot record whether they are
// still on disk, because a producer writes once and a page reads later. So the op asks — once per
// distinct sha, through the optional port — and a host that cannot answer leaves the key absent
// rather than reporting refs it never looked at as missing.

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function subAction(artifactRefs?: RunDetailSubAction['artifactRefs']): RunDetailSubAction {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex: 0,
    plan: 'click submit',
    plannedAction: {} as RunDetailSubAction['plannedAction'],
    result: {} as RunDetailSubAction['result'],
    screenStateHash: 'hash',
    ...(artifactRefs === undefined ? {} : { artifactRefs }),
  }
}

function depsWithBlobs(
  rows: RunDetailRows,
  has: ((runId: RunId, sha: string) => Promise<EvidenceBlobPresence>) | undefined,
): FunctionDeps {
  return {
    runDetail: { read: () => Promise.resolve(rows) },
    evidenceBlobs: {
      read: () => Promise.resolve({ status: 'unknown_run' as const }),
      ...(has === undefined ? {} : { has }),
    },
  } as unknown as FunctionDeps
}

describe('runs.detail — presence per artifact ref', () => {
  const ROWS: RunDetailRows = {
    ...EMPTY_ROWS,
    steps: [step()],
    subActions: [subAction([{ id: `decision-screenshot:${SHA_A}`, sha: SHA_A }])],
  }

  it('annotates present: true for found and false for BOTH absences', async () => {
    for (const [word, present] of [['found', true], ['blob_absent', false], ['unknown_run', false]] as const) {
      const result = await runsDetailSpec.invoke(
        { runId: RUN_ID },
        depsWithBlobs(ROWS, () => Promise.resolve(word)),
      )
      expect(result.subActions[0]!.artifactRefs)
        .toEqual([{ id: `decision-screenshot:${SHA_A}`, sha: SHA_A, present }])
    }
  })

  it('OMITS present when the bound port cannot stat, and leaves the rest of the row untouched', async () => {
    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, depsWithBlobs(ROWS, undefined))
    const ref = result.subActions[0]!.artifactRefs![0]!

    expect('present' in ref).toBe(false)
    expect(ref).toEqual({ id: `decision-screenshot:${SHA_A}`, sha: SHA_A })
    // Everything the projection already served is byte-identical — presence is additive.
    expect(result.subActions[0]!.plan).toBe('click submit')
    expect(result.steps.map(({ evidence }) => evidence)).toEqual([{
      console: { kind: 'console', state: 'absent', reason: 'unavailable' },
      network: { kind: 'network', state: 'absent', reason: 'unavailable' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unavailable' },
      variables: { kind: 'variables', state: 'absent', reason: 'unavailable' },
    }])
    expect(result.steps.map(({ evidence: _evidence, ...prior }) => prior)).toEqual(ROWS.steps)
    expect(result.tokens).toEqual({ measuredSteps: 0, unmeasuredSteps: 1 })
  })

  it('a REJECTED stat does not fail the read, and leaves the key ABSENT rather than false', async () => {
    // Presence is opportunistic on this op by its own note — "this is not a binding condition".
    // A rejected stat that rejected the read would map to `read_failed` at the route and take the
    // whole run-detail page down over an annotation that is allowed to be missing.
    const result = await runsDetailSpec.invoke(
      { runId: RUN_ID },
      depsWithBlobs(ROWS, () => Promise.reject(new Error('stat failed: connection reset'))),
    )
    const ref = result.subActions[0]!.artifactRefs![0]!

    // ABSENT, not `present: false`. A failed stat is presence UNKNOWN; reporting it as an absence
    // would render intact evidence as incomplete on the strength of a lookup that never happened.
    expect('present' in ref).toBe(false)
    expect(ref).toEqual({ id: `decision-screenshot:${SHA_A}`, sha: SHA_A })
    // The rest of the projection is untouched — the annotation failing costs the annotation only.
    expect(result.subActions[0]!.plan).toBe('click submit')
    expect(result.steps.map(({ evidence }) => evidence)).toEqual([{
      console: { kind: 'console', state: 'absent', reason: 'unavailable' },
      network: { kind: 'network', state: 'absent', reason: 'unavailable' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unavailable' },
      variables: { kind: 'variables', state: 'absent', reason: 'unavailable' },
    }])
    expect(result.steps.map(({ evidence: _evidence, ...prior }) => prior)).toEqual(ROWS.steps)
  })

  it('one rejected sha does not erase the presence of the shas that DID answer', async () => {
    const rows: RunDetailRows = {
      ...EMPTY_ROWS,
      subActions: [subAction([
        { id: `decision-screenshot:${SHA_A}`, sha: SHA_A },
        { id: `decision-screenshot:${SHA_B}`, sha: SHA_B },
      ])],
    }
    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, depsWithBlobs(rows, (_runId, sha) =>
      sha === SHA_A
        ? Promise.reject(new Error('stat failed: connection reset'))
        : Promise.resolve('found' as const)))
    const refs = result.subActions[0]!.artifactRefs!

    expect('present' in refs[0]!).toBe(false)
    expect(refs[1]).toEqual({ id: `decision-screenshot:${SHA_B}`, sha: SHA_B, present: true })
  })

  it('leaves a sub-action with NO artifactRefs without the key, and stats each sha once', async () => {
    const seen: string[] = []
    const rows: RunDetailRows = {
      ...EMPTY_ROWS,
      subActions: [
        subAction(),
        subAction([
          { id: `decision-screenshot:${SHA_A}`, sha: SHA_A },
          { id: `decision-screenshot:${SHA_A}#again`, sha: SHA_A },
          { id: `decision-screenshot:${SHA_B}`, sha: SHA_B, evidenceIncomplete: true },
        ]),
      ],
    }

    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, depsWithBlobs(rows, (_runId, sha) => {
      seen.push(sha)
      return Promise.resolve('blob_absent')
    }))

    expect('artifactRefs' in result.subActions[0]!).toBe(false)
    expect(result.subActions[1]!.artifactRefs).toEqual([
      { id: `decision-screenshot:${SHA_A}`, sha: SHA_A, present: false },
      { id: `decision-screenshot:${SHA_A}#again`, sha: SHA_A, present: false },
      { id: `decision-screenshot:${SHA_B}`, sha: SHA_B, evidenceIncomplete: true, present: false },
    ])
    expect(seen.sort()).toEqual([SHA_A, SHA_B])
  })
})

// ---- C432-ALL-OPS-AVAILABLE (432-27, D-12) ------------------------------------------------------
//
// `runs.detail` and `runs.overview` once required `read`. Through a real registry and
// `invokeFunction`, retried from three callers that differ in surface and origin and carry no
// scope, each is served every time: every attempt reads the same ports the same number of times,
// every caller gets the same projection, and no audit row is written.
describe('the run detail and overview reads serve every caller', () => {
  it('a retried runs.detail and runs.overview are served alike to every caller', async () => {
    const document: CompletedRunHandoff = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: RUN_ID,
      scope: { tier: 'product', key: 'shop' },
      buildOrdinal: 5,
      executionContext: 'local-headless',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_000,
      endedAt: 9_000,
      tests: [{
        testId: 'test-checkout', testName: 'Checkout smoke', filePath: 'tests/checkout.yaml',
        testIndex: 0, outcome: 'passed',
        steps: [{
          stepIndex: 0, stepText: 'Open the home page', cacheStatus: 'miss',
          servedBrief: {
            scope: { tier: 'product', key: 'shop' }, asOfBuild: 5, budget: 400, truncation: '',
            channel1: [], channel2: [], channel3: [], briefDigest: 'brief-0',
          },
          subActions: [],
          verifierVerdict: { pass: true, reasoning: 'ok' },
        }],
      }],
    }
    const rows: RunDetailRows = {
      runId: RUN_ID,
      members: [{ testIndex: 0, testId: 'test-checkout', name: 'Checkout smoke', attempts: 1,
        outcome: 'passed' }],
      steps: [step({ stepText: 'Open the home page', status: 'passed',
        tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })],
      subActions: [],
    }
    const reads = { detail: 0, handoff: 0 }
    const deps: FunctionDeps = {
      secretMask: (text: string) => text,
      runs: {
        list: () => Promise.resolve([document]),
        get: (runId) => {
          reads.handoff += 1
          return Promise.resolve(runId === RUN_ID ? document : undefined)
        },
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
      knowledge: {
        listBundles: () => Promise.resolve([]),
        inspectRecords: () => Promise.resolve([]),
        diffSince: () => Promise.resolve([]),
        showRecord: ({ recordId }) =>
          Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId }),
      },
      entities: {
        resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
        get: () => Promise.resolve(undefined),
      },
      config: {
        getMasked: () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
      },
      runDetail: {
        read: (runId) => {
          reads.detail += 1
          return Promise.resolve(runId === RUN_ID ? rows : undefined)
        },
      },
    }
    const registry = createFunctionRegistry({ deps })
    const callers: readonly FunctionCaller[] = [
      { surface: 'test', origin: 'agent' },
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]

    const answers: unknown[] = []
    const perAttempt: { detail: number; handoff: number }[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = { ...reads }
        answers.push(await invokeFunction(registry, 'runs.detail', { runId: RUN_ID }, caller))
        answers.push(await invokeFunction(registry, 'runs.overview', { runId: RUN_ID }, caller))
        perAttempt.push({
          detail: reads.detail - before.detail,
          handoff: reads.handoff - before.handoff,
        })
      }
    }

    expect(perAttempt[0]!.detail).toBe(2)
    expect(perAttempt[0]!.handoff).toBeGreaterThan(0)
    expect(perAttempt).toEqual(Array.from({ length: 6 }, () => perAttempt[0]))
    expect(answers).toEqual(Array.from({ length: 6 }, () => answers.slice(0, 2)).flat())
    expect(answers[0]).toMatchObject({
      runId: RUN_ID,
      members: [{ testIndex: 0, testId: 'test-checkout' }],
      tokens: { measuredSteps: 1, unmeasuredSteps: 0, totalTokens: 12 },
    })
    expect(answers[1]).toMatchObject({
      runId: RUN_ID,
      aggregateVerdict: 'passed',
      tests: [{ testIndex: 0, testId: 'test-checkout', name: { text: 'Checkout smoke' },
        steps: [{ stepIndex: 0, label: { text: 'Open the home page' }, status: 'passed' }] }],
    })
  })
})
