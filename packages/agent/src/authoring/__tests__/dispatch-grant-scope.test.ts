// Dispatch ordering: every model call before the first run, and a host's scope is never entered.

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { runAuthoringLoop } from '../loop.js'
import type { AuthoringLoopDeps, AuthoringLoopInput } from '../loop.js'
import type { DraftStageOutcome, ParsedDraftLike } from '../ports.js'

const DRAFT_PATH = 'tests/.agent-qa-drafts/dispatch-scope-fixture.yaml'
const DRAFT_NAME = 'Submit the local account form'
const MODEL_DOCUMENT = 'name: Submit the local account form\nsteps:\n  - a\n'

const DRAFT: ParsedDraftLike = {
  testId: DRAFT_NAME,
  filePath: DRAFT_PATH,
  testName: DRAFT_NAME,
  target: 'local-form',
  steps: ['Open the local account form', 'Click the Submit button'],
  contentDigest: 'digest-0',
}

/** A keep-eligible receipt, so the loop takes the shortest path that still spends a run. */
function keepEligibleReceipt(runIds: readonly string[]): DraftReceipt {
  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: DRAFT_PATH,
      testId: DRAFT_NAME,
      testName: DRAFT_NAME,
      contentDigest: 'digest-0',
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: [...runIds], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: true,
        runRefs: [...runIds],
        distinctOutcomes: ['passed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: runIds.map((runId) => ({
      runId,
      memberOutcome: 'passed',
      definitive: true,
      healed: false,
    })),
    addsValueFinding: { novelElements: ['el:button "submit"'], comparedTests: [] },
    stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
    stabilityRunsCompleted: runIds.length,
    disposition: 'keep-eligible',
    evaluatedAt: 1,
  })
}

type TraceEntry = 'enter' | 'exit' | 'model' | `start:${string}`

interface Bench {
  readonly deps: AuthoringLoopDeps
  readonly trace: TraceEntry[]
}

/**
 * The loop's host, with the two things this file measures wired to one trace.
 *
 * `verifyDraft` STARTS ITS OWN GATE RUNS, which is what the real stage 4 does — `authoring.draft.
 * verify` dispatches `runStabilityGates`, and those runs go through `shelf.runs.start`. A bench
 * whose `verifyDraft` started nothing would put the scope's whole reason for existing outside the
 * fixture and every ordering cell would pass vacuously.
 */
function bench(input: {
  readonly gateRuns: number
  /** A stale host handing the deleted scope anyway. The loop must not enter it. */
  readonly bindStaleScope?: boolean
  readonly failVerify?: boolean
  readonly duplicateIntent?: boolean
}): Bench {
  const trace: TraceEntry[] = []
  const runIds: string[] = []

  const shelf = {
    runs: {
      start(request: { patterns?: readonly string[] }) {
        const runId = `r_gate-${runIds.length}`
        runIds.push(runId)
        trace.push(`start:${runId}` as TraceEntry)
        return Promise.resolve({
          runId,
          patterns: request.patterns,
          gateRun: true,
          excludedFromOutcomes: true,
        } as never)
      },
      get: () => Promise.resolve(undefined),
    },
    ...(input.bindStaleScope === true
      ? {
          dispatchGrants: {
            // THE BENCH RUNS THE CONTINUATION, so if the loop still entered a bound scope the trace
            // would show `enter`/`exit` around the runs and the result would be unchanged — the
            // absence cell below can only pass because the loop no longer reads this member.
            async within<T>(fn: () => Promise<T>): Promise<T> {
              trace.push('enter')
              try {
                return await fn()
              } finally {
                trace.push('exit')
              }
            },
          },
        }
      : {}),
    model: () => Promise.resolve({
      modelId: 'fixture:dispatch-scope',
      generate() {
        trace.push('model')
        return Promise.resolve({ text: MODEL_DOCUMENT })
      },
    }),
    write: () => Promise.resolve({ kind: 'staged', draft: DRAFT } as DraftStageOutcome),
    applyPatches: (candidate: ParsedDraftLike) =>
      Promise.resolve({ kind: 'staged', draft: candidate } as DraftStageOutcome),
    async verifyDraft(): Promise<DraftReceipt> {
      // The gate runs stage 4 takes, INSIDE the scope if the scope is where it should be.
      for (let taken = 0; taken < input.gateRuns; taken += 1) {
        await shelf.runs.start({ patterns: [DRAFT_PATH] })
      }
      if (input.failVerify === true) throw new Error('the evaluator could not judge this draft')
      return keepEligibleReceipt(runIds)
    },
    // The final write starts no run, so it sits outside what this file measures.
    publish: (request: { readonly targetPath: string }) => Promise.resolve({
      kind: 'written' as const,
      filePath: request.targetPath,
      contentDigest: DRAFT.contentDigest,
    }),
  }

  return {
    trace,
    deps: {
      read: {
        configuredTargetNames: () => Promise.resolve(['local-form']),
        getAuthoringBrief: () => Promise.resolve({
          scope: { tier: 'product', key: 'local-form' },
          facts: [],
          cautions: [],
          procedures: [],
          exemplars: [],
        } as never),
        suiteTextCorpus: () => Promise.resolve(
          input.duplicateIntent === true
            ? [{
                filePath: 'suites/existing.yaml',
                testName: LOOP_INPUT.intent,
                stepsText: [LOOP_INPUT.intent],
              }]
            : [],
        ),
      },
      shelf: shelf as never,
    },
  }
}

const LOOP_INPUT: AuthoringLoopInput = {
  intent: 'Check that submitting the local account form shows the confirmation banner',
  scope: { tier: 'product', key: 'local-form' },
}

describe('the authoring dispatch runs directly, with no scope', () => {
  it('EVERY MODEL CALL PRECEDES THE FIRST RUN, AND THE RUNS ARE THE DISPATCH — the whole sequence', async () => {
    const harness = bench({ gateRuns: 3 })
    await runAuthoringLoop(LOOP_INPUT, harness.deps)

    // Sequence equality, because a per-entry check is satisfied by every wrong order.
    expect(harness.trace).toEqual([
      'model',
      'model',
      'start:r_gate-0',
      'start:r_gate-1',
      'start:r_gate-2',
    ])
  })

  it('a host that still binds the deleted scope does not have it entered', async () => {
    // The deletion's own claim. A stale composition handing `dispatchGrants` is ignored: no `enter`,
    // no `exit`, the same runs in the same order and the same result as with nothing bound.
    const stale = bench({ gateRuns: 3, bindStaleScope: true })
    const plain = bench({ gateRuns: 3 })
    const staleResult = await runAuthoringLoop(LOOP_INPUT, stale.deps)
    const plainResult = await runAuthoringLoop(LOOP_INPUT, plain.deps)

    expect(stale.trace).toEqual(plain.trace)
    expect(stale.trace).not.toContain('enter')
    expect(stale.trace).not.toContain('exit')
    expect(staleResult.stages).toEqual(plainResult.stages)
    expect(staleResult.outcome).toEqual(plainResult.outcome)
    expect(staleResult.fanOut).toEqual(plainResult.fanOut)
  })

  it('A THROWN DISPATCH PROPAGATES — the loop adds no wrapper that could swallow it', async () => {
    const harness = bench({ gateRuns: 2, failVerify: true })
    await expect(runAuthoringLoop(LOOP_INPUT, harness.deps)).rejects.toThrow(
      'the evaluator could not judge this draft',
    )
    expect(harness.trace).toEqual([
      'model',
      'model',
      'start:r_gate-0',
      'start:r_gate-1',
    ])
  })

  it('A DEDUP REFUSAL STARTS NOTHING — an invocation that spends no run reaches no model and no run', async () => {
    const harness = bench({ gateRuns: 3, duplicateIntent: true })
    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    expect(result.outcome.kind).toBe('refused')
    expect(harness.trace).toEqual([])
  })
})
