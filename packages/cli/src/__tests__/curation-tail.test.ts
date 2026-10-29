import { emptyCanaryCreditCounters } from '../curation/canary-credit.js'
import { generateRunId } from '@vostride/agent-qa-ids'
import { CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId } from '@vostride/agent-qa-schema'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUN_OUTCOMES_PROJECTION_VERSION,
  type FoldRunOutcomesOptions,
  type FoldRunOutcomesReport,
} from '@vostride/agent-qa-knowledge-local'
import {
  HANDOFF_FILE,
  RUNS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import type {
  DeterministicRootCauseClass,
  KnowledgeHintReader,
} from '@vostride/agent-qa-runner'
import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  guardCompletedRunHandoff,
  type CanaryOutcome,
  type CompletedRunHandoff,
  type QuarantineLedgerEvent,
  type StepEvidence,
} from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'

import {
  CURATION_TAIL_RECEIPT_FILE,
  CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
  curationTailHandoffDigest,
  readCurationTailReceipt,
  runCurationTail,
  runVerdictFirstCurationTail,
  type CurationTailReceipt,
  type RunCurationTailOptions,
} from '../curation/curation-tail.js'

const agentQaRoot = '/workspace/project/.agent-qa'
const configDir = '/workspace/project'
const knowledgeRoot = '/workspace/project/agent-qa-knowledge'
const runId = 'run-curation-tail'
const mask = (text: string) => text
const modelDeps = {} as RunCurationTailOptions['modelDeps']

describe('canary receipt contract', () => {
  it('reads a receipt with the current key set and stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-receipt-reader-'))
    try {
      writeFileSync(join(dir, CURATION_TAIL_RECEIPT_FILE), JSON.stringify({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION, runId, handoffDigest: 'a'.repeat(64),
        projectionVersion: 1, drainKind: 'drained', handoffHolderPid: null, candidateIds: [],
        canary: emptyCanaryCreditCounters() }))
      expect(readCurationTailReceipt(dir)?.schemaVersion).toBe(CURATION_TAIL_RECEIPT_SCHEMA_VERSION)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['stamp-3-without-canary', 'stamp-4-without-canary', 'stamp-4', 'missing', 'extra', 'negative', 'fractional', 'nonSignal-extra', 'nonSignal-missing', 'nonSignal-negative'] as const)(
    'refuses %s counter shape at the reader', mode => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-qa-receipt-reader-'))
      try {
        const receipt: Record<string, unknown> = { schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION, runId, handoffDigest: 'a'.repeat(64),
          projectionVersion: 1, drainKind: 'drained', handoffHolderPid: null, candidateIds: [],
          canary: emptyCanaryCreditCounters() }
        const counters = receipt.canary as Record<string, unknown>
        if (mode === 'stamp-3-without-canary') {
          receipt.schemaVersion = 3
          delete receipt.canary
        }
        if (mode === 'stamp-4-without-canary') {
          receipt.schemaVersion = 4
          delete receipt.canary
        }
        if (mode === 'stamp-4') receipt.schemaVersion = 4
        if (mode === 'missing') delete counters.rideAlongUncredited
        if (mode === 'extra') counters.unknown = 0
        if (mode === 'negative') counters.rideAlongUncredited = -1
        if (mode === 'fractional') counters.rerunExcluded = 0.5
        if (mode === 'nonSignal-extra') counters.nonSignal = { environment: 0, timeout: 0, flake: 0, unknown: 0 }
        if (mode === 'nonSignal-missing') counters.nonSignal = { environment: 0, timeout: 0 }
        if (mode === 'nonSignal-negative') counters.nonSignal = { environment: -1, timeout: 0, flake: 0 }
        writeFileSync(join(dir, CURATION_TAIL_RECEIPT_FILE), JSON.stringify(receipt))
        expect(readCurationTailReceipt(dir)).toBeUndefined()
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  )

  it('a receipt without canary counters refolds once into the current key set; diagnostic errors do not block completion', async () => {
    for (const stamp of [3, 4]) {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-receipt-refold-'))
      const runDir = join(root, RUNS_SUBDIR, slugBranch(runId))
      mkdirSync(runDir, { recursive: true })
      try {
        const completed = handoff()
        writeFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), JSON.stringify({ schemaVersion: stamp,
          runId, handoffDigest: curationTailHandoffDigest(completed), projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
          drainKind: 'drained', handoffHolderPid: null, candidateIds: [] }))
        expect(readCurationTailReceipt(runDir)).toBeUndefined()
        const canary = { ...emptyCanaryCreditCounters(), rideAlongUncredited: 1, rerunExcluded: 1 }
        const emit = vi.fn(async () => ({ emitted: 0, refused: 0, unresolved: 0, canary,
          procedure: { emitted: 0, refused: 0, unresolved: 0 }, details: [] }))
        const operations = successfulOperations({ loadCompletedRunHandoff: () => completed,
          listCompletedRunDirs: () => [runDir], emitCanaryOutcomes: emit })
        delete operations.readCurationTailReceipt
        delete operations.writeCurationTailReceipt
        await runCurationTail(baseOptions(operations, { agentQaRoot: root }))
        const receipt = readCurationTailReceipt(runDir)!
        expect(receipt.schemaVersion).toBe(CURATION_TAIL_RECEIPT_SCHEMA_VERSION)
        expect(receipt.canary).toEqual(canary)
        expect(Object.keys(receipt).sort().join(',')).toBe('canary,candidateIds,drainKind,handoffDigest,handoffHolderPid,projectionVersion,runId,schemaVersion')
        expect(Object.keys(receipt.canary).sort()).toEqual(['nonSignal', 'rerunExcluded', 'rideAlongUncredited'])
        expect(Object.keys(receipt.canary.nonSignal).sort()).toEqual(['environment', 'flake', 'timeout'])
        await runCurationTail(baseOptions(operations, { agentQaRoot: root }))
        expect(emit).toHaveBeenCalledOnce()
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
})

// 2026-10-18 (444-20, D-48): these fixtures' handoffs are `ci` runs, so an incomplete fold states
// curation's resume limit instead of promising the next run.
const CI_CURATION_RESUME = /resumes only if this workspace's \.agent-qa\/ is kept and a later local run picks it up\.$/u

function handoff(executionContext: CompletedRunHandoff['executionContext'] = 'ci') {
  return { executionContext, runId } as CompletedRunHandoff
}

function attributableHandoff(): CompletedRunHandoff {
  return {
    executionContext: 'ci',
    runId: 'run-curation-tail',
    buildOrdinal: 42,
    tests: [{
      steps: [{
        stepIndex: 0,
        servedBrief: {
          briefDigest: 'brief-digest-0',
          channel1: [{ id: 'candidate-checkout', servedAsCanary: true }],
        },
        verifierVerdict: { pass: true },
        subActions: [{
          plannedAction: { type: 'click', ref: 'checkout' },
          stateBefore: {
            elements: [{
              ref: 'checkout',
              role: 'button',
              nameNormalized: 'checkout',
            }],
          },
        }],
      }],
    }],
  } as CompletedRunHandoff
}

function completeHandoffForGuard(
  completedRunId: string = runId,
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: completedRunId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop-web' },
    buildOrdinal: 42,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'suite-digest',
      testConfigDigest: 'test-digest',
    },
    startedAt: 100,
    endedAt: 200,
    tests: [{
      testId: 'checkout-happy-1',
      testName: 'checkout happy path',
      filePath: 'suite/checkout.test.ts',
      testIndex: 0,
      outcome: 'passed',
      steps: [{
        stepIndex: 0,
        stepText: 'Click checkout',
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'shop-web' },
          asOfBuild: 42,
          budget: 128,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
          briefDigest: 'brief-digest',
        },
        subActions: [],
        verifierVerdict: { pass: true, reasoning: 'Observed checkout' },
      }],
    }],
  }
}

const malformedSiblingCases: Array<{
  key: string
  name: string
  mutate: (handoff: CompletedRunHandoff) => void
}> = [
  {
    key: 'root',
    name: 'missing executionContext',
    mutate(handoff) {
      delete (handoff as Partial<CompletedRunHandoff>).executionContext
    },
  },
  {
    key: 'test-identity',
    name: 'member missing filePath',
    mutate(handoff) {
      delete (handoff.tests[0] as Partial<CompletedRunHandoff['tests'][number]>).filePath
    },
  },
  {
    key: 'verdict',
    name: 'step missing verifierVerdict',
    mutate(handoff) {
      delete (handoff.tests[0]!.steps[0] as Partial<StepEvidence>).verifierVerdict
    },
  },
  {
    key: 'brief',
    name: 'step servedBrief missing channel1',
    mutate(handoff) {
      delete (handoff.tests[0]!.steps[0]!.servedBrief as Partial<StepEvidence['servedBrief']>)
        .channel1
    },
  },
  {
    key: 'step',
    name: 'bare nested step object',
    mutate(handoff) {
      handoff.tests[0]!.steps = [{} as StepEvidence]
    },
  },
  {
    key: 'plan-source',
    name: 'step planSource procedure-replay missing its guard',
    mutate(handoff) {
      handoff.tests[0]!.steps[0]!.planSource = {
        kind: 'procedure-replay',
        procedureId: 'proc-checkout',
      } as unknown as StepEvidence['planSource']
    },
  },
  {
    key: 'root-cause',
    name: 'member rootCause environment missing its evidence',
    mutate(handoff) {
      handoff.tests[0]!.rootCause = {
        class: 'environment',
      } as unknown as CompletedRunHandoff['tests'][number]['rootCause']
    },
  },
  {
    key: 'sub-action-element',
    name: 'step with a valid procedure-replay planSource and a bare subActions element',
    mutate(handoff) {
      handoff.tests[0]!.steps[0]!.planSource = {
        kind: 'procedure-replay',
        procedureId: 'proc-checkout',
        guard: { checksPassed: 3, total: 3 },
      } as unknown as StepEvidence['planSource']
      handoff.tests[0]!.steps[0]!.subActions = [
        {},
      ] as unknown as StepEvidence['subActions']
    },
  },
  {
    key: 'brief-line',
    name: 'step servedBrief channel1 carrying a null line',
    mutate(handoff) {
      handoff.tests[0]!.steps[0]!.servedBrief.channel1 = [
        null,
      ] as unknown as StepEvidence['servedBrief']['channel1']
    },
  },
  {
    key: 'grounding-attempt-element',
    name: 'complete subActions element whose grounding attempts carry a null member',
    mutate(handoff) {
      handoff.tests[0]!.steps[0]!.subActions = [{
        plannedAction: { type: 'click', ref: 'checkout' },
        stateBefore: {
          url: 'https://shop.example/checkout',
          platform: 'web',
          elements: [{
            ref: 'checkout',
            role: 'button',
            name: 'Checkout',
            nameNormalized: 'checkout',
            state: { enabled: true, focused: false, visible: true },
            labels: { testId: 'checkout' },
            attributes: { type: 'submit' },
          }],
        },
        grounding: { attempts: [null] },
      }] as unknown as StepEvidence['subActions']
    },
  },
  {
    key: 'stateAfter-url-element',
    name: 'complete subActions element whose stateAfter carries a numeric url beside a differing stateBefore url',
    mutate(handoff) {
      handoff.tests[0]!.steps[0]!.subActions = [{
        plannedAction: { type: 'click', ref: 'checkout' },
        stateBefore: {
          url: 'https://shop.example/checkout',
          platform: 'web',
          elements: [{
            ref: 'checkout',
            role: 'button',
            name: 'Checkout',
            nameNormalized: 'checkout',
            state: { enabled: true, focused: false, visible: true },
            labels: { testId: 'checkout' },
            attributes: { type: 'submit' },
          }],
        },
        stateAfter: { url: 42 },
      }] as unknown as StepEvidence['subActions']
    },
  },
]

function baseOptions(
  operations: NonNullable<RunCurationTailOptions['operations']>,
  overrides: Partial<RunCurationTailOptions> = {},
): RunCurationTailOptions {
  return {
    runId,
    agentQaRoot,
    knowledgeConfig: { dir: 'agent-qa-knowledge' },
    configDir,
    mask,
    modelDeps,
    log: { warn: vi.fn() },
    operations,
    ...overrides,
  }
}

function successfulOperations(
  overrides: NonNullable<RunCurationTailOptions['operations']> = {},
): NonNullable<RunCurationTailOptions['operations']> {
  return {
    loadCompletedRunHandoff: () => handoff(),
    resolveKnowledgeRoot: () => knowledgeRoot,
    runSafetyScope: (_bundle, fn) => fn(),
    emitCurationCandidates: vi.fn(() => ({
      enqueued: 0,
      coalesced: 0,
      capExceeded: 0,
      refused: 0,
      details: [],
    })),
    openKnowledgeReader: () => ({ emitCanaryOutcome: vi.fn() }) as unknown as KnowledgeHintReader,
    emitCanaryOutcomes: vi.fn(async () => ({
      emitted: 0,
      refused: 0,
      unresolved: 0,
      canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
      procedure: { emitted: 0, refused: 0, unresolved: 0 },
      details: [],
    })),
    buildCuratorAuthor: () => vi.fn(async () => ({
      kind: 'fallback-required' as const,
      reason: 'no-model' as const,
    })),
    drainQueue: vi.fn(async () => ({
      kind: 'drained' as const,
      jobsProcessed: 0,
      committed: 0,
      downgraded: 0,
      withheld: 0,
      quarantined: 0,
      requeued: 0,
      failures: 0,
      failureDetails: [],
      noops: 0,
      noopDetails: [],
      remaining: 0,
      remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
      reconcile: undefined,
      writerPass: { kind: 'not-requested' as const },
      gc: { kind: 'not-run' as const },
    })),
    listCompletedRunDirs: () => [
      join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)),
    ],
    readCurationTailReceipt: () => undefined,
    writeCurationTailReceipt: vi.fn(),
    foldRunOutcomes: vi.fn(() => ({ kind: 'applied' as const, tests: 0, ...NO_DETECTION })),
    reconcileRunOutcomesProjection: vi.fn(() => ({ kind: 'current' as const })),
    acquireWriterLease: vi.fn(() => ({ kind: 'acquired' as const, leaseId: 'sweep-lease', epoch: 7 })),
    releaseLease: vi.fn(() => ({ kind: 'released' as const })),
    // 2026-10-16 (442-10, D-17): each sibling run's fixture context, as its own run-config record would give it.
    resolveRunCurationContext: vi.fn(async () => ({ mask, knowledgeRoot })),
    ...overrides,
  }
}

/**
 * The 390 D-08 detection member every fold report now carries. Declared once so a stub cannot
 * accidentally describe a DIFFERENT detection outcome than the tail is being asked about.
 */
const NO_DETECTION = {
  quarantine: { kind: 'not-evaluated' as const, reason: 'not-requested' as const },
}

function handedOffDrainReport() {
  return {
    kind: 'handed-off' as const,
    holder: {
      leaseId: '00000000-0000-4000-8000-000000000001',
      pid: 4242,
      epoch: 1,
      heartbeatAtMs: 0,
    },
    jobsProcessed: 0,
    committed: 0,
    downgraded: 0,
    withheld: 0,
    quarantined: 0,
    requeued: 0,
    failures: 0,
    failureDetails: [],
    noops: 0,
    noopDetails: [],
    remaining: 0,
    remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
    reconcile: undefined,
    writerPass: { kind: 'skipped' as const, reason: 'lease-held' as const },
    gc: { kind: 'skipped' as const, reason: 'lease-held' as const },
  }
}

describe('runCurationTail post-verdict fold', () => {
  it('prints every promotion in report order', async () => {
    const info = vi.fn()
    const drainQueue = vi.fn(async (_options: object) => ({
      ...handedOffDrainReport(),
      promotions: [
        { candidateId: 'c1', promotionPath: 'deterministic-verdict-floor' as const },
        { candidateId: 'c2', promotionHoldReason: 'no-confirmed-evidence' as const },
      ],
    }))
    await runCurationTail(baseOptions(successfulOperations({ drainQueue }), {
      log: { warn: vi.fn(), info },
    }))
    // The drain is handed no proposals root.
    expect(drainQueue.mock.calls[0]![0]).not.toHaveProperty('agentQaRoot')
    expect(info.mock.calls.map(([message]) => message).filter(message => message.startsWith('curation: '))).toEqual([
      'curation: handed to daemon (pid 4242)',
      'curation: c1 promoted via deterministic-verdict-floor',
      'curation: c2 held: no-confirmed-evidence',
    ])
  })
  it('loads the handoff, emits candidates and canary outcomes in one scope, then drains', async () => {
    const order: string[] = []
    const controller = new AbortController()
    const ambientExecutionContext = 'local-interactive'
    const completed = attributableHandoff()
    const canaryOutcome: CanaryOutcome = {
      candidateId: 'candidate-checkout' as CanaryOutcome['candidateId'],
      runOutcome: 'positive',
      benefit: 'rode-along',
      runId,
      testId: 'checkout::happy-path',
      testIndex: 0,
      buildOrdinal: 42,
      stepIndex: 0,
      briefDigest: 'brief-digest-0',
      attribution: 'candidate-checkout matched checkout on passing step 0',
      exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
    }
    const author = vi.fn(async () => ({
      kind: 'fallback-required' as const,
      reason: 'no-model' as const,
    }))
    const writeCurationTailReceipt = vi.fn()

    const operations = successfulOperations({
      loadCompletedRunHandoff(file) {
        order.push('handoff')
        expect(file).toBe(
          join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId), HANDOFF_FILE),
        )
        return completed
      },
      resolveKnowledgeRoot(knowledge, seenConfigDir) {
        order.push('knowledge-root')
        expect(knowledge).toEqual({ dir: 'agent-qa-knowledge' })
        expect(seenConfigDir).toBe(configDir)
        return knowledgeRoot
      },
      runSafetyScope(bundle, fn) {
        order.push('scope')
        expect(ambientExecutionContext).not.toBe(completed.executionContext)
        expect(bundle).toEqual({
          executionContext: completed.executionContext,
        })
        return fn()
      },
      emitCurationCandidates(options) {
        order.push('emit')
        expect(options).toMatchObject({
          handoff: completed,
          runDir: join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)),
          knowledgeRoot,
        })
        expect(options).not.toHaveProperty('policy')
        return {
          enqueued: 0,
          coalesced: 0,
          capExceeded: 0,
          refused: 0,
          details: [],
        }
      },
      openKnowledgeReader(config) {
        order.push('reader')
        expect(config).toEqual({ knowledgeRoot })
        return {
          emitCanaryOutcome(outcome: CanaryOutcome) {
            order.push('queue')
            expect(outcome).toEqual(canaryOutcome)
          },
        } as unknown as KnowledgeHintReader
      },
      async emitCanaryOutcomes(options) {
        order.push('canary-emit')
        expect(options).toMatchObject({
          handoff: completed,
          runDir: join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)),
          knowledgeRoot,
        })
        options.emit(canaryOutcome)
        return {
          emitted: 1,
          refused: 0,
          unresolved: 0,
          canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
          procedure: { emitted: 0, refused: 0, unresolved: 0 },
          details: [{
            benefit: canaryOutcome.benefit,
            candidateId: canaryOutcome.candidateId,
            testId: canaryOutcome.testId,
            testIndex: canaryOutcome.testIndex,
            stepIndex: 0,
            outcome: { kind: 'emitted' },
          }],
        }
      },
      foldRunOutcomes(options) {
        order.push('projection')
        expect(options).toMatchObject({
          knowledgeRoot,
          handoff: completed,
        })
        expect(options).not.toHaveProperty('excluded')
        expect(options.extractAnchors).toBeTypeOf('function')
        // 390 D-08: the tail reads the drain's wall clock ONCE and hands it down as data — the
        // fold and the ladder read no clock of their own.
        expect(options.quarantine?.now).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
        return { kind: 'applied', tests: 1, ...NO_DETECTION }
      },
      buildCuratorAuthor(deps) {
        order.push('author')
        expect(deps).toEqual({ ...modelDeps, mask: expect.any(Function), signal: controller.signal })
        return author
      },
      async drainQueue(options) {
        order.push('drain')
        expect(options).toMatchObject({
          knowledgeRoot,
          author,
          executionContext: completed.executionContext,
          signal: controller.signal,
        })
        expect(options).not.toHaveProperty('policy')
        return {
          kind: 'drained',
          jobsProcessed: 0,
          committed: 0,
          downgraded: 0,
          withheld: 0,
          quarantined: 0,
          requeued: 0,
          failures: 0,
          failureDetails: [],
          noops: 0,
          noopDetails: [],
          remaining: 0,
          remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
          reconcile: undefined,
          writerPass: { kind: 'not-requested' },
          gc: { kind: 'not-run' },
        }
      },
      listCompletedRunDirs(root) {
        order.push('list-runs')
        expect(root).toBe(agentQaRoot)
        return [join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))]
      },
      readCurationTailReceipt(seenRunDir) {
        order.push('read-receipt')
        expect(seenRunDir).toBe(join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)))
        return undefined
      },
      writeCurationTailReceipt(seenRunDir, receipt) {
        order.push('write-receipt')
        writeCurationTailReceipt(seenRunDir, receipt)
      },
    })

    await expect(
      runCurationTail(baseOptions(operations, { signal: controller.signal })),
    ).resolves.toBeUndefined()

    expect(order).toEqual([
      'handoff',
      'knowledge-root',
      'list-runs',
      'read-receipt',
      'scope',
      'emit',
      'reader',
      'canary-emit',
      'queue',
      'projection',
      'author',
      'drain',
      'write-receipt',
    ])
    expect(writeCurationTailReceipt).toHaveBeenCalledWith(
      join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)),
      expect.objectContaining({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
      canary: emptyCanaryCreditCounters(),
        runId,
        handoffDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
        drainKind: 'drained',
        handoffHolderPid: null,
        candidateIds: [],
      }),
    )
  })

  it('finalizes a handed-off run once with sorted provenance and never re-sweeps it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'curation-tail-handed-off-'))
    try {
      const realAgentQaRoot = join(root, '.agent-qa')
      const runDir = join(realAgentQaRoot, RUNS_SUBDIR, slugBranch(runId))
      mkdirSync(runDir, { recursive: true })
      const completed = handoff()
      const candidateA = 'candidate-a'
      const candidateZ = 'candidate-z'
      const info = vi.fn()
      const emitCurationCandidates = vi.fn(() => ({
        enqueued: 2,
        coalesced: 0,
        capExceeded: 0,
        refused: 0,
        details: [
          {
            candidateId: candidateZ,
            kind: 'fact' as const,
            outcome: { kind: 'enqueued' as const, candidateId: candidateZ },
          },
          {
            candidateId: candidateA,
            kind: 'caution' as const,
            outcome: { kind: 'enqueued' as const, candidateId: candidateA },
          },
        ],
      }))
      const drainQueue = vi.fn(async () => ({
        kind: 'handed-off' as const,
        holder: {
          leaseId: '00000000-0000-4000-8000-000000000001',
          pid: 4242,
          epoch: 1,
          heartbeatAtMs: 0,
        },
        jobsProcessed: 0,
        committed: 0,
        downgraded: 0,
        withheld: 0,
        quarantined: 0,
        requeued: 0,
        failures: 0,
        failureDetails: [],
        noops: 0,
        noopDetails: [],
        remaining: 2,
        remainingWork: { queued: 2, claimedNonterminal: 0, quarantined: 0 },
        reconcile: undefined,
        writerPass: { kind: 'skipped' as const, reason: 'lease-held' as const },
        gc: { kind: 'skipped' as const, reason: 'lease-held' as const },
      }))
      const operations = successfulOperations({
        loadCompletedRunHandoff: () => completed,
        listCompletedRunDirs: () => [runDir],
        emitCurationCandidates,
        drainQueue,
      })
      // Exercise the production validator and durable temp-rename writer.
      delete operations.readCurationTailReceipt
      delete operations.writeCurationTailReceipt

      await runCurationTail(baseOptions(operations, {
        agentQaRoot: realAgentQaRoot,
        log: { warn: vi.fn(), info },
      }))

      expect(JSON.parse(
        readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8'),
      )).toEqual({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
      canary: emptyCanaryCreditCounters(),
        runId,
        handoffDigest: curationTailHandoffDigest(completed),
        projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
        drainKind: 'handed-off',
        handoffHolderPid: 4242,
        candidateIds: [candidateA, candidateZ],
      })
      expect(info).toHaveBeenCalledWith('curation: handed to daemon (pid 4242)')

      await runCurationTail(baseOptions(operations, {
        agentQaRoot: realAgentQaRoot,
        log: { warn: vi.fn(), info },
      }))

      expect(emitCurationCandidates).toHaveBeenCalledOnce()
      expect(drainQueue).toHaveBeenCalledOnce()
      expect(info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith('curation: ')))
        .toEqual(['curation: handed to daemon (pid 4242)'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'candidate-refused',
    'candidate-cap-exceeded',
    'canary-refused',
    'canary-unresolved',
    'projection-failed',
  ] as const)('keeps %s as a receipt blocker when the drain hands off', async (condition) => {
    const warn = vi.fn()
    const info = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({
      writeCurationTailReceipt,
      emitCurationCandidates: vi.fn(() => ({
        enqueued: 0,
        coalesced: 0,
        capExceeded: condition === 'candidate-cap-exceeded' ? 1 : 0,
        refused: condition === 'candidate-refused' ? 1 : 0,
        details: [],
      })),
      emitCanaryOutcomes: vi.fn(async () => ({
        emitted: 0,
        refused: condition === 'canary-refused' ? 1 : 0,
        unresolved: condition === 'canary-unresolved' ? 1 : 0,
        canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
        procedure: { emitted: 0, refused: 0, unresolved: 0 },
        details: [],
      })),
      foldRunOutcomes: condition === 'projection-failed'
        ? vi.fn(() => { throw new Error('projection failed') })
        : vi.fn(() => ({ kind: 'applied' as const, tests: 0, ...NO_DETECTION })),
      drainQueue: vi.fn(async () => handedOffDrainReport()),
    })

    await runCurationTail(baseOptions(operations, { log: { warn, info } }))

    expect(writeCurationTailReceipt).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/curation incomplete/i))
    expect(info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('curation: ')))
      .toEqual(['curation: handed to daemon (pid 4242)'])
  })

  it('writes inline drain provenance and one whole-second disposition hint', async () => {
    const info = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({ writeCurationTailReceipt })

    await runCurationTail(baseOptions(operations, {
      log: { warn: vi.fn(), info },
    }))

    expect(writeCurationTailReceipt).toHaveBeenCalledWith(
      join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)),
      expect.objectContaining({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
        drainKind: 'drained',
        handoffHolderPid: null,
        candidateIds: [],
      }),
    )
    const dispositionLines = info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('curation: '))
    expect(dispositionLines).toHaveLength(1)
    expect(dispositionLines[0]).toMatch(/^curation: drained inline \(\d+s\)$/u)
  })

  it('receipts a zero-candidate handoff and skips it on the next sweep', async () => {
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    const receipts = new Map<string, CurationTailReceipt>()
    const emitCurationCandidates = vi.fn(successfulOperations().emitCurationCandidates)
    const drainQueue = vi.fn(async () => handedOffDrainReport())
    const operations = successfulOperations({
      emitCurationCandidates,
      drainQueue,
      readCurationTailReceipt: (seenRunDir) => receipts.get(seenRunDir),
      writeCurationTailReceipt(seenRunDir, receipt) {
        receipts.set(seenRunDir, receipt)
      },
    })

    await runCurationTail(baseOptions(operations))
    await runCurationTail(baseOptions(operations))

    expect(receipts.get(runDir)).toMatchObject({
      drainKind: 'handed-off',
      handoffHolderPid: 4242,
      candidateIds: [],
    })
    expect(emitCurationCandidates).toHaveBeenCalledOnce()
    expect(drainQueue).toHaveBeenCalledOnce()
  })

  it('refolds a four-key receipt stamped 2 exactly once and leaves the current bytes unchanged thereafter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'curation-tail-four-key-refold-'))
    try {
      const realAgentQaRoot = join(root, '.agent-qa')
      const runDir = join(realAgentQaRoot, RUNS_SUBDIR, slugBranch(runId))
      mkdirSync(runDir, { recursive: true })
      const completed = handoff()
      writeFileSync(
        join(runDir, CURATION_TAIL_RECEIPT_FILE),
        `${JSON.stringify({
          schemaVersion: 2,
          runId,
          handoffDigest: curationTailHandoffDigest(completed),
          projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
        })}\n`,
        'utf8',
      )
      const emitCurationCandidates = vi.fn(successfulOperations().emitCurationCandidates)
      const operations = successfulOperations({
        loadCompletedRunHandoff: () => completed,
        listCompletedRunDirs: () => [runDir],
        emitCurationCandidates,
      })
      delete operations.readCurationTailReceipt
      delete operations.writeCurationTailReceipt

      await runCurationTail(baseOptions(operations, { agentQaRoot: realAgentQaRoot }))
      const firstBytes = readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8')
      expect(JSON.parse(firstBytes)).toMatchObject({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
        drainKind: 'drained',
        handoffHolderPid: null,
        candidateIds: [],
      })

      await runCurationTail(baseOptions(operations, { agentQaRoot: realAgentQaRoot }))
      const secondPassBytes = readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8')
      await runCurationTail(baseOptions(operations, { agentQaRoot: realAgentQaRoot }))

      expect(readdirSync(runDir)).toEqual([CURATION_TAIL_RECEIPT_FILE])
      expect(secondPassBytes).toBe(firstBytes)
      expect(readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8')).toBe(firstBytes)
      expect(emitCurationCandidates).toHaveBeenCalledOnce()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes a marker-set sibling handoff unchanged without a caller exclusion flag', async () => {
    const siblingRunId = 'run-gate-replay' as CompletedRunHandoff['runId']
    const currentRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    const siblingRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(siblingRunId))
    const currentHandoff = handoff()
    const excludedSibling = {
      ...handoff(),
      runId: siblingRunId,
      excludedFromOutcomes: true,
    } satisfies CompletedRunHandoff
    const handoffs = new Map([
      [join(currentRunDir, HANDOFF_FILE), currentHandoff],
      [join(siblingRunDir, HANDOFF_FILE), excludedSibling],
    ])
    const foldRunOutcomes = vi.fn((_options: FoldRunOutcomesOptions) => ({
      kind: 'applied' as const,
      tests: 0 as const,
      ...NO_DETECTION,
    }))
    const operations = successfulOperations({
      loadCompletedRunHandoff(file) {
        const loaded = handoffs.get(file)
        if (loaded === undefined) throw new Error(`missing handoff ${file}`)
        return loaded
      },
      listCompletedRunDirs: () => [siblingRunDir, currentRunDir],
      foldRunOutcomes,
    })

    await runCurationTail(baseOptions(operations))

    const siblingCall = foldRunOutcomes.mock.calls
      .map(([options]) => options)
      .find(({ handoff: completed }) => completed.runId === siblingRunId)
    expect(siblingCall?.handoff).toBe(excludedSibling)
    expect(siblingCall).not.toHaveProperty('excluded')
  })

  it.each(['emit', 'canary-emit', 'drain'] as const)(
    'swallows a %s failure and warns that incomplete curation resumes on the next run',
    async (failureStage) => {
      const warn = vi.fn()
      const operations = successfulOperations({
        emitCurationCandidates() {
          if (failureStage === 'emit') throw new Error('emit failed')
          return {
            enqueued: 0,
            coalesced: 0,
            capExceeded: 0,
            refused: 0,
            details: [],
          }
        },
        async emitCanaryOutcomes() {
          if (failureStage === 'canary-emit') throw new Error('canary emit failed')
          return {
            emitted: 0,
            refused: 0,
            unresolved: 0,
            canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
            procedure: { emitted: 0, refused: 0, unresolved: 0 },
            details: [],
          }
        },
        async drainQueue() {
          if (failureStage === 'drain') throw new Error('drain failed')
          return {
            kind: 'drained',
            jobsProcessed: 0,
            committed: 0,
            downgraded: 0,
            withheld: 0,
            quarantined: 0,
            requeued: 0,
            failures: 0,
            failureDetails: [],
            noops: 0,
            noopDetails: [],
            remaining: 0,
            remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
            reconcile: undefined,
            writerPass: { kind: 'not-requested' },
            gc: { kind: 'not-run' },
          }
        },
      })

      await expect(
        runCurationTail(baseOptions(operations, { log: { warn } })),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toMatch(/curation incomplete/i)
      expect(warn.mock.calls[0]?.[0]).toMatch(CI_CURATION_RESUME)
    },
  )

  it.each([
    'candidate-refused',
    'candidate-cap-exceeded',
    'canary-refused',
    'canary-unresolved',
    'drain-failure',
    'drain-requeued',
    'drain-aborted',
  ] as const)('withholds the durable receipt for a structured %s result', async (condition) => {
    const warn = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({
      writeCurationTailReceipt,
      emitCurationCandidates() {
        return {
          enqueued: 0,
          coalesced: 0,
          capExceeded: condition === 'candidate-cap-exceeded' ? 1 : 0,
          refused: condition === 'candidate-refused' ? 1 : 0,
          details: [],
        }
      },
      async emitCanaryOutcomes() {
        return {
          emitted: 0,
          refused: condition === 'canary-refused' ? 1 : 0,
          unresolved: condition === 'canary-unresolved' ? 1 : 0,
          canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
          procedure: { emitted: 0, refused: 0, unresolved: 0 },
          details: [],
        }
      },
      async drainQueue() {
        const aborted = condition === 'drain-aborted'
        return {
          kind: aborted ? 'aborted' as const : 'drained' as const,
          jobsProcessed: 0,
          committed: 0,
          downgraded: 0,
          withheld: 0,
          quarantined: 0,
          requeued: condition === 'drain-requeued' ? 1 : 0,
          failures: condition === 'drain-failure' ? 1 : 0,
          failureDetails: [],
          noops: 0,
          noopDetails: [],
          remaining: condition === 'drain-requeued' ? 1 : 0,
          remainingWork: {
            queued: condition === 'drain-requeued' ? 1 : 0,
            claimedNonterminal: 0,
            quarantined: 0,
          },
          reconcile: undefined,
          writerPass: aborted
            ? { kind: 'skipped' as const, reason: 'aborted' as const }
            : { kind: 'not-requested' as const },
          gc: aborted
            ? { kind: 'skipped' as const, reason: 'aborted' as const }
            : { kind: 'not-run' as const },
        }
      },
    })

    await expect(
      runCurationTail(baseOptions(operations, { log: { warn } })),
    ).resolves.toBeUndefined()

    expect(writeCurationTailReceipt).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(CI_CURATION_RESUME))
    const diagnostic = {
      'candidate-refused': 'candidate-refused=1',
      'candidate-cap-exceeded': 'candidate-cap-exceeded=1',
      'canary-refused': 'canary-refused=1',
      'canary-unresolved': 'canary-unresolved=1',
      'drain-failure': 'drain-failures=1',
      'drain-requeued': 'drain-requeued=1',
      'drain-aborted': 'drain-kind=aborted',
    }[condition]
    expect(warn.mock.calls[0]?.[0]).toContain(diagnostic)
  })

  it('replays a prior failed canary drop once and receipts successful siblings idempotently', async () => {
    const oldRunId = '001-old-run'
    const newRunId = '002-new-run'
    const oldDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(oldRunId))
    const newDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(newRunId))
    const oldHandoff = { executionContext: 'ci', runId: oldRunId } as CompletedRunHandoff
    const newHandoff = { executionContext: 'ci', runId: newRunId } as CompletedRunHandoff
    const handoffs = new Map([
      [join(oldDir, HANDOFF_FILE), oldHandoff],
      [join(newDir, HANDOFF_FILE), newHandoff],
    ])
    const receipts = new Map<string, CurationTailReceipt>()
    const durableOutcomes = new Set<string>()
    const canaryRuns: string[] = []
    let successfulSiblingAttempts = 0
    let completedRunDirs = [oldDir]
    let oldAttempts = 0
    const warn = vi.fn()
    const drainQueue = vi.fn(successfulOperations().drainQueue)
    const operations = successfulOperations({
      loadCompletedRunHandoff(file) {
        const loaded = handoffs.get(file)
        if (loaded === undefined) throw new Error(`missing handoff ${file}`)
        return loaded
      },
      listCompletedRunDirs: () => completedRunDirs,
      readCurationTailReceipt: (seenRunDir) => receipts.get(seenRunDir),
      writeCurationTailReceipt(seenRunDir, receipt) {
        receipts.set(seenRunDir, receipt)
      },
      async emitCanaryOutcomes({ handoff: completed }) {
        const completedRunId = String(completed.runId)
        canaryRuns.push(completedRunId)
        if (completedRunId === oldRunId) {
          oldAttempts += 1
          successfulSiblingAttempts += 1
          durableOutcomes.add('old-successful-sibling')
          if (oldAttempts === 1) {
            return {
              emitted: 1,
              refused: 1,
              unresolved: 0,
              canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
              procedure: { emitted: 0, refused: 0, unresolved: 0 },
              details: [],
            }
          }
          durableOutcomes.add('old-retried-outcome')
          return {
            emitted: 2,
            refused: 0,
            unresolved: 0,
            canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
            procedure: { emitted: 0, refused: 0, unresolved: 0 },
            details: [],
          }
        }
        durableOutcomes.add('new-outcome')
        return {
          emitted: 1,
          refused: 0,
          unresolved: 0,
          canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
          procedure: { emitted: 0, refused: 0, unresolved: 0 },
          details: [],
        }
      },
      drainQueue,
    })

    await runCurationTail(baseOptions(operations, {
      runId: oldRunId,
      log: { warn },
    }))
    expect(receipts.has(oldDir)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(CI_CURATION_RESUME))

    completedRunDirs = [oldDir, newDir]
    await runCurationTail(baseOptions(operations, {
      runId: newRunId,
      log: { warn },
    }))

    expect(receipts.has(oldDir)).toBe(true)
    expect(receipts.has(newDir)).toBe(true)
    expect(canaryRuns).toEqual([oldRunId, oldRunId, newRunId])
    expect(successfulSiblingAttempts).toBe(2)
    expect([...durableOutcomes].sort()).toEqual([
      'new-outcome',
      'old-retried-outcome',
      'old-successful-sibling',
    ])
    expect(drainQueue).toHaveBeenCalledTimes(3)

    await runCurationTail(baseOptions(operations, {
      runId: newRunId,
      log: { warn },
    }))
    expect(canaryRuns).toEqual([oldRunId, oldRunId, newRunId])
    expect(drainQueue).toHaveBeenCalledTimes(3)
  })

  it('rejects a structurally invalid sibling handoff once at load and never reaches the emitters', async () => {
    const malformedRunId = '000-malformed-sibling'
    const malformedRunDir = join(
      agentQaRoot,
      RUNS_SUBDIR,
      slugBranch(malformedRunId),
    )
    const validRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    const validSibling = completeHandoffForGuard()
    const malformedDocument = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: malformedRunId,
      executionContext: 'ci',
      tests: [{}],
    }
    const warn = vi.fn()
    const emitCurationCandidates = vi.fn(
      successfulOperations().emitCurationCandidates,
    )
    const emitCanaryOutcomes = vi.fn(successfulOperations().emitCanaryOutcomes)
    const foldRunOutcomes = vi.fn(successfulOperations().foldRunOutcomes)
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({
      loadCompletedRunHandoff(file) {
        if (file === join(validRunDir, HANDOFF_FILE)) return validSibling
        if (file === join(malformedRunDir, HANDOFF_FILE)) {
          return guardCompletedRunHandoff(malformedDocument)
        }
        throw new Error(`missing handoff ${file}`)
      },
      listCompletedRunDirs: () => [malformedRunDir, validRunDir],
      emitCurationCandidates,
      emitCanaryOutcomes,
      foldRunOutcomes,
      writeCurationTailReceipt,
    })

    await runCurationTail(baseOptions(operations, { log: { warn } }))

    expect(
      emitCurationCandidates.mock.calls.filter(
        ([options]) => options.runDir === malformedRunDir,
      ),
    ).toHaveLength(0)
    expect(
      emitCanaryOutcomes.mock.calls.filter(
        ([options]) => options.runDir === malformedRunDir,
      ),
    ).toHaveLength(0)
    expect(
      foldRunOutcomes.mock.calls.filter(
        ([options]) => String(options.handoff.runId) === malformedRunId,
      ),
    ).toHaveLength(0)
    expect(writeCurationTailReceipt).toHaveBeenCalledOnce()
    expect(writeCurationTailReceipt).toHaveBeenCalledWith(
      validRunDir,
      expect.objectContaining({ runId }),
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      `Skipping post-verdict knowledge curation for ${malformedRunDir}: handoff is malformed.`,
    )
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/curation incomplete/i))
  })

  it.each(malformedSiblingCases)(
    'skips a malformed sibling once before emitters: $name',
    async ({ key, mutate }) => {
      const malformedRunId = `000-malformed-${key}`
      const malformedRunDir = join(
        agentQaRoot,
        RUNS_SUBDIR,
        slugBranch(malformedRunId),
      )
      const validRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
      const validSibling = completeHandoffForGuard()
      const malformedDocument = completeHandoffForGuard(malformedRunId)
      mutate(malformedDocument)
      const warn = vi.fn()
      const emitCurationCandidates = vi.fn(
        successfulOperations().emitCurationCandidates,
      )
      const emitCanaryOutcomes = vi.fn(successfulOperations().emitCanaryOutcomes)
      const foldRunOutcomes = vi.fn(successfulOperations().foldRunOutcomes)
      const writeCurationTailReceipt = vi.fn()
      const operations = successfulOperations({
        loadCompletedRunHandoff(file) {
          if (file === join(validRunDir, HANDOFF_FILE)) return validSibling
          if (file === join(malformedRunDir, HANDOFF_FILE)) {
            return guardCompletedRunHandoff(malformedDocument)
          }
          throw new Error(`missing handoff ${file}`)
        },
        listCompletedRunDirs: () => [malformedRunDir, validRunDir],
        emitCurationCandidates,
        emitCanaryOutcomes,
        foldRunOutcomes,
        writeCurationTailReceipt,
      })

      await runCurationTail(baseOptions(operations, { log: { warn } }))

      expect(
        emitCurationCandidates.mock.calls.filter(
          ([options]) => options.runDir === malformedRunDir,
        ),
      ).toHaveLength(0)
      expect(
        emitCanaryOutcomes.mock.calls.filter(
          ([options]) => options.runDir === malformedRunDir,
        ),
      ).toHaveLength(0)
      expect(
        foldRunOutcomes.mock.calls.filter(
          ([options]) => String(options.handoff.runId) === malformedRunId,
        ),
      ).toHaveLength(0)
      expect(writeCurationTailReceipt).toHaveBeenCalledOnce()
      expect(writeCurationTailReceipt).toHaveBeenCalledWith(
        validRunDir,
        expect.objectContaining({ runId }),
      )
      expect(warn).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(
        `Skipping post-verdict knowledge curation for ${malformedRunDir}: handoff is malformed.`,
      )
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining(`curation incomplete for ${malformedRunId}`),
      )
    },
  )

  it.each(['missing', 'malformed'] as const)(
    'treats a %s handoff as a logged skip without emitting or draining',
    async (condition) => {
      const warn = vi.fn()
      const emitCurationCandidates = vi.fn()
      const openKnowledgeReader = vi.fn()
      const emitCanaryOutcomes = vi.fn()
      const drainQueue = vi.fn()
      const operations = successfulOperations({
        loadCompletedRunHandoff() {
          throw new Error(`${condition} handoff`)
        },
        emitCurationCandidates,
        openKnowledgeReader,
        emitCanaryOutcomes,
        drainQueue,
      })

      await expect(
        runCurationTail(baseOptions(operations, { log: { warn } })),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toMatch(/skip/i)
      expect(warn.mock.calls[0]?.[0]).toMatch(/handoff/i)
      expect(emitCurationCandidates).not.toHaveBeenCalled()
      expect(openKnowledgeReader).not.toHaveBeenCalled()
      expect(emitCanaryOutcomes).not.toHaveBeenCalled()
      expect(drainQueue).not.toHaveBeenCalled()
    },
  )
})

describe('run-outcome projection under the extended tail receipt', () => {
  it('isolates a run-outcome fold failure: counted, logged, and never blocking the drain', async () => {
    const warn = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const drainQueue = vi.fn(successfulOperations().drainQueue)
    const operations = successfulOperations({
      foldRunOutcomes() {
        throw new Error('projection fold failed')
      },
      drainQueue,
      writeCurationTailReceipt,
    })

    await expect(
      runCurationTail(baseOptions(operations, { log: { warn } })),
    ).resolves.toBeUndefined()

    expect(drainQueue).toHaveBeenCalledOnce()
    expect(writeCurationTailReceipt).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('projection-failed=1'))
  })

  it('skips the projection fold too for an already-receipted handoffDigest — the one extended receipt', async () => {
    const completed = handoff()
    const receipt: CurationTailReceipt = {
      schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
      canary: emptyCanaryCreditCounters(),
      runId,
      handoffDigest: curationTailHandoffDigest(completed),
      projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
      drainKind: 'drained',
      handoffHolderPid: null,
      candidateIds: [],
    }
    const foldRunOutcomes = vi.fn()
    const emitCurationCandidates = vi.fn()
    const drainQueue = vi.fn()
    const operations = successfulOperations({
      loadCompletedRunHandoff: () => completed,
      readCurationTailReceipt: () => receipt,
      foldRunOutcomes,
      emitCurationCandidates,
      drainQueue,
    })

    await runCurationTail(baseOptions(operations))

    expect(foldRunOutcomes).not.toHaveBeenCalled()
    expect(emitCurationCandidates).not.toHaveBeenCalled()
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('refolds a run whose stored receipt predates the projection component', async () => {
    const completed = handoff()
    const staleReceipt = {
      schemaVersion: 1,
      runId,
      handoffDigest: curationTailHandoffDigest(completed),
    } as unknown as CurationTailReceipt
    const foldRunOutcomes = vi.fn(() => ({ kind: 'applied' as const, tests: 0, ...NO_DETECTION }))
    const operations = successfulOperations({
      loadCompletedRunHandoff: () => completed,
      readCurationTailReceipt: () => staleReceipt,
      foldRunOutcomes,
    })

    await runCurationTail(baseOptions(operations))

    expect(foldRunOutcomes).toHaveBeenCalledOnce()
  })

  it('reruns all three folds after a simulated mid-tail failure — safe because the fold is idempotent per runId', async () => {
    let crashDrain = true
    const receipts = new Map<string, CurationTailReceipt>()
    const foldRunOutcomes = vi.fn(() => ({ kind: 'applied' as const, tests: 1, ...NO_DETECTION }))
    const emitCurationCandidates = vi.fn(successfulOperations().emitCurationCandidates)
    const emitCanaryOutcomes = vi.fn(successfulOperations().emitCanaryOutcomes)
    const workingDrain = successfulOperations().drainQueue!
    const operations = successfulOperations({
      foldRunOutcomes,
      emitCurationCandidates,
      emitCanaryOutcomes,
      readCurationTailReceipt: (seenRunDir) => receipts.get(seenRunDir),
      writeCurationTailReceipt(seenRunDir, receipt) {
        receipts.set(seenRunDir, receipt)
      },
      async drainQueue(options) {
        if (crashDrain) throw new Error('simulated mid-tail crash')
        return workingDrain(options)
      },
    })

    await runCurationTail(baseOptions(operations, { log: { warn: vi.fn() } }))
    expect(receipts.size).toBe(0)

    crashDrain = false
    await runCurationTail(baseOptions(operations, { log: { warn: vi.fn() } }))

    expect(emitCurationCandidates).toHaveBeenCalledTimes(2)
    expect(emitCanaryOutcomes).toHaveBeenCalledTimes(2)
    expect(foldRunOutcomes).toHaveBeenCalledTimes(2)
    expect(receipts.size).toBe(1)
  })

  it('leaves exactly one tail receipt file in the run dir — never a second projection marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'curation-tail-receipt-'))
    try {
      const realAgentQaRoot = join(root, '.agent-qa')
      const runDir = join(realAgentQaRoot, RUNS_SUBDIR, slugBranch(runId))
      mkdirSync(runDir, { recursive: true })
      const operations = successfulOperations({
        listCompletedRunDirs: () => [runDir],
      })
      // Use the real durable receipt read/write legs against the temp run dir.
      delete operations.readCurationTailReceipt
      delete operations.writeCurationTailReceipt

      await runCurationTail(baseOptions(operations, { agentQaRoot: realAgentQaRoot }))

      expect(readdirSync(runDir)).toEqual([CURATION_TAIL_RECEIPT_FILE])
      const receipt = JSON.parse(
        readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8'),
      ) as Record<string, unknown>
      expect(receipt).toMatchObject({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
        runId,
        projectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
        drainKind: 'drained',
        handoffHolderPid: null,
        candidateIds: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 393 CR-02. The reconcile is the half of the version bump that re-derives rows; the receipt
  // above is the half that re-runs them. Both pins here are about POSITION and BLAST RADIUS,
  // because those are the two ways this wiring could be present and still wrong: a reconcile
  // inside the loop would clear rows the loop just folded, and a reconcile that can abort the
  // sweep would let a stale projection stop curation outright.
  it('reconciles the projection version exactly once, before any per-run fold', async () => {
    const order: string[] = []
    const secondRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch('run-sibling'))
    const currentRunDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    const reconcileRunOutcomesProjection = vi.fn(() => {
      order.push('reconcile')
      return {
        kind: 'rebuilt' as const,
        report: { folded: 2, skippedHandoffs: 1, skippedArtifacts: 0 },
      }
    })
    const foldRunOutcomes = vi.fn(() => {
      order.push('fold')
      return { kind: 'applied' as const, tests: 0, ...NO_DETECTION }
    })
    const info = vi.fn()
    const operations = successfulOperations({
      loadCompletedRunHandoff: () => handoff(),
      listCompletedRunDirs: () => [secondRunDir, currentRunDir],
      reconcileRunOutcomesProjection,
      foldRunOutcomes,
    })

    const authority = { leaseId: 'held-post-run-lease', epoch: 12 }
    await runCurationTail(baseOptions(operations, { authority, log: { warn: vi.fn(), info } }))
    expect(operations.acquireWriterLease).not.toHaveBeenCalled()
    expect(operations.releaseLease).not.toHaveBeenCalled()

    expect(reconcileRunOutcomesProjection).toHaveBeenCalledOnce()
    expect(reconcileRunOutcomesProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeRoot,
        runsRoot: join(agentQaRoot, RUNS_SUBDIR),
        authority,
      }),
    )
    expect(foldRunOutcomes).toHaveBeenCalledTimes(2)
    expect(order[0]).toBe('reconcile')
    expect(order.indexOf('reconcile')).toBeLessThan(order.indexOf('fold'))
    expect(order.lastIndexOf('reconcile')).toBe(0)
    // A rebuild of the derived index is never silent.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('folded 2, skipped 1 handoff, 0 artifact'),
    )
  })

  it('acquires and releases direct-sweep authority around reconciliation', async () => {
    const operations = successfulOperations()
    await runCurationTail(baseOptions(operations))
    expect(operations.acquireWriterLease).toHaveBeenCalledExactlyOnceWith(knowledgeRoot)
    expect(operations.reconcileRunOutcomesProjection).toHaveBeenCalledWith(expect.objectContaining({
      authority: { leaseId: 'sweep-lease', epoch: 7 },
    }))
    expect(operations.releaseLease).toHaveBeenCalledExactlyOnceWith({ knowledgeRoot, leaseId: 'sweep-lease' })
  })

  it('warns on the no-authority skip and continues without releasing another holder', async () => {
    const warn = vi.fn()
    const operations = successfulOperations({
      acquireWriterLease: vi.fn(() => ({ kind: 'held' as const, holder: handedOffDrainReport().holder })),
      reconcileRunOutcomesProjection: vi.fn(() => ({ kind: 'skipped' as const, reason: 'no-writer-authority' as const })),
    })
    await runCurationTail(baseOptions(operations, { log: { warn } }))
    expect(operations.reconcileRunOutcomesProjection).toHaveBeenCalledWith(expect.not.objectContaining({
      authority: expect.anything(),
    }))
    expect(warn).toHaveBeenCalledWith('curation: run-outcome projection not reconciled (no writer authority)')
    expect(operations.releaseLease).not.toHaveBeenCalled()
    expect(operations.foldRunOutcomes).toHaveBeenCalledOnce()
  })

  it('isolates a throwing reconcile: warned, and every per-run fold still happens', async () => {
    const warn = vi.fn()
    const foldRunOutcomes = vi.fn(successfulOperations().foldRunOutcomes)
    const drainQueue = vi.fn(successfulOperations().drainQueue)
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({
      reconcileRunOutcomesProjection() {
        throw new Error('reconcile failed')
      },
      foldRunOutcomes,
      drainQueue,
      writeCurationTailReceipt,
    })

    await expect(
      runCurationTail(baseOptions(operations, { log: { warn } })),
    ).resolves.toBeUndefined()

    expect(operations.releaseLease).toHaveBeenCalledExactlyOnceWith({ knowledgeRoot, leaseId: 'sweep-lease' })

    // The warn has to be true about what the throw LEFT, not just that it happened — and true of
    // EVERY throw that can reach this catch (393 round 7, WARN-TEXT-CLASS). Two classes arrive
    // here: one raised before any DELETE (`openIndexWriter`, `ensureRunOutcomeTables`,
    // `readStoredProjectionVersion`), which leaves the family INTACT under its previous stamp and
    // may not rebuild next sweep at all; and one raised after the DELETEs — including the
    // projection/write throws that now propagate — which leaves it unstamped and possibly partial.
    // An unconditional "failed partway / will rebuild again" was simply false of the first class,
    // so the text states both outcomes hinged on whether the rebuild had begun.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the run-outcome projection reconcile did not complete'),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'If the rebuild write phase had already begun, the projection family is left unstamped and possibly'
        + ' partial, and the next reconcile rebuilds it',
      ),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'if it stopped before that, the family and its previous stamp are untouched',
      ),
    )
    // The CLI arm no longer DISCARDS the cause the daemon arm has always printed. The injected
    // message is deliberately absent from the static text above, so this cannot pass vacuously.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconcile failed'))
    expect(foldRunOutcomes).toHaveBeenCalledOnce()
    expect(drainQueue).toHaveBeenCalledOnce()
    expect(writeCurationTailReceipt).toHaveBeenCalledOnce()
  })
})

describe('verdict-first CLI tail wiring', () => {
  it('returns the fixed verdict exit code even when the defensive tail boundary catches a throw', async () => {
    const unexpected = new Error('tail contract was violated')
    const onUnexpectedError = vi.fn()

    await expect(
      runVerdictFirstCurationTail({
        exitCode: 1,
        detach: false,
        runTail: vi.fn(async () => {
          throw unexpected
        }),
        onUnexpectedError,
      }),
    ).resolves.toBe(1)
    expect(onUnexpectedError).toHaveBeenCalledWith(unexpected)
  })

  it('skips the complete tail under --detach and preserves the verdict code', async () => {
    const runTail = vi.fn()

    await expect(
      runVerdictFirstCurationTail({
        exitCode: 130,
        detach: true,
        runTail,
      }),
    ).resolves.toBe(130)
    expect(runTail).not.toHaveBeenCalled()
  })

  it('keeps the reported verdict when the process signal aborts the drain at its boundary', async () => {
    const controller = new AbortController()
    const drainQueue = vi.fn(async (options) => {
      controller.abort()
      expect(options.signal).toBe(controller.signal)
      expect(options.signal?.aborted).toBe(true)
      return {
        kind: 'aborted' as const,
        jobsProcessed: 0,
        committed: 0,
        downgraded: 0,
        withheld: 0,
        quarantined: 0,
        requeued: 0,
        failures: 0,
        failureDetails: [],
        noops: 0,
        noopDetails: [],
        remaining: 0,
        remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
        reconcile: undefined,
        writerPass: { kind: 'skipped' as const, reason: 'aborted' as const },
        gc: { kind: 'skipped' as const, reason: 'aborted' as const },
      }
    })
    const operations = successfulOperations({ drainQueue })

    await expect(
      runVerdictFirstCurationTail({
        exitCode: 0,
        detach: false,
        runTail: () =>
          runCurationTail(
            baseOptions(operations, { signal: controller.signal }),
          ),
      }),
    ).resolves.toBe(0)
    expect(drainQueue).toHaveBeenCalledOnce()
  })

  it('warns naming every drain noop while still completing the tail', async () => {
    const warn = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const base = successfulOperations()
    const operations = successfulOperations({
      writeCurationTailReceipt,
      async drainQueue(options) {
        const report = await base.drainQueue!(options)
        return {
          ...report,
          noops: 2,
          noopDetails: [
            { candidateId: 'cand-a', reason: 'procedure-body-unparseable' },
            { candidateId: 'cand-b', reason: 'evidence-token-consumed' },
          ],
        }
      },
    })

    await runCurationTail(baseOptions(operations, { log: { warn } }))

    const noopWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => /noop/i.test(message))
    expect(noopWarning).toBeDefined()
    expect(noopWarning).toContain('cand-a')
    expect(noopWarning).toContain('procedure-body-unparseable')
    expect(noopWarning).toContain('cand-b')
    expect(noopWarning).toContain('evidence-token-consumed')
    // The complete predicate does NOT gate on noops: legitimate reasons (dedup) must never
    // wedge a healthy tail into the incomplete retry loop.
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/curation incomplete/i))
    expect(writeCurationTailReceipt).toHaveBeenCalledOnce()
  })

  it('renders the empty-delta cause inside the noop parenthetical', async () => {
    const warn = vi.fn()
    const base = successfulOperations()
    const operations = successfulOperations({
      async drainQueue(options) {
        const report = await base.drainQueue!(options)
        return {
          ...report,
          noops: 2,
          noopDetails: [
            {
              candidateId: 'cand-a',
              reason: 'delta-noop',
              emptyDeltaCause: 'fallback-malformed' as const,
            },
            { candidateId: 'cand-b', reason: 'evidence-token-consumed' },
          ],
        }
      },
    })

    await runCurationTail(baseOptions(operations, { log: { warn } }))

    const noopWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => /noop/i.test(message))
    expect(noopWarning).toBeDefined()
    // The cause renders inside the existing trailing parenthetical.
    expect(noopWarning).toContain('cand-a (delta-noop: fallback-malformed)')
    // A causeless noop renders exactly the 381-40 form.
    expect(noopWarning).toContain('cand-b (evidence-token-consumed)')
  })

  it('keeps the count-anchored warn prefix the ladder extractor parses', async () => {
    const warn = vi.fn()
    const base = successfulOperations()
    const operations = successfulOperations({
      async drainQueue(options) {
        const report = await base.drainQueue!(options)
        return {
          ...report,
          noops: 1,
          noopDetails: [
            {
              candidateId: 'cand-a',
              reason: 'delta-noop',
              emptyDeltaCause: 'fallback-malformed' as const,
            },
          ],
        }
      },
    })

    await runCurationTail(baseOptions(operations, { log: { warn } }))

    const noopWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => /noop/i.test(message))
    expect(noopWarning).toBeDefined()
    // The same count-anchored pattern demo/init/scripts/ladder-evidence.mjs embeds in its
    // --self-check rows; the harness ships unmodified for the 381-48 ladder re-run.
    const matches = [...String(noopWarning).matchAll(/drain produced (\d+) commit noop\(s\)[^\n]*/g)]
    expect(matches).toHaveLength(1)
    expect(Number(matches[0]![1])).toBe(1)
  })

  it('adds a drain-noops entry to incompleteDetails when the tail is already incomplete', async () => {
    const warn = vi.fn()
    const base = successfulOperations()
    const operations = successfulOperations({
      async drainQueue(options) {
        const report = await base.drainQueue!(options)
        return {
          ...report,
          failures: 1,
          failureDetails: [{ stage: 'commit' as const, message: 'boom' }],
          noops: 1,
          noopDetails: [
            { candidateId: 'cand-a', reason: 'procedure-body-unparseable' },
          ],
        }
      },
    })

    await runCurationTail(baseOptions(operations, { log: { warn } }))

    const incomplete = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => /curation incomplete/i.test(message))
    expect(incomplete).toBeDefined()
    expect(incomplete).toContain('drain-noops=1')
  })

  it('registers --detach and invokes the shared tail at both run verdict sites', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../commands/run.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain(
      ".option('--detach', 'skip the post-verdict knowledge curation tail')",
    )
    // 388-02: the shared tail the two sites invoke is now `runPostRunTail` — the v51 curation
    // fold is reached THROUGH it (as `curate-memory`'s body and as the prior-run sweep), so
    // `run.ts` names it no more. The claim this case makes is unchanged: BOTH verdict sites go
    // through the one helper, and a site that grew its own tail again fails right here.
    //
    // 404 D-06: the helper is `composeCliPostRunTail`, and `run.ts` no longer spells the tail's
    // option literal at all. The composition moved because the `runs.start` door needs the SAME
    // one — three spellings of "how this project's tail is composed" is how a field added to the
    // tail reaches two of them.
    expect(source.match(/composeCliPostRunTail\(/g)).toHaveLength(2)
    expect(source.match(/runPostRunTail\(/g)).toBeNull()
    expect(source.match(/runCurationTail\(/g)).toBeNull()
    expect(source.match(/runVerdictFirstCurationTail\(/g)).toHaveLength(2)
  })
})

describe('per-run candidate summary line', () => {
  const factIdA = '1a'.repeat(32)
  const factIdB = '2b'.repeat(32)
  const procedureId = '3c'.repeat(32)

  function summaryLineFrom(log: ReturnType<typeof vi.fn>): string | undefined {
    return log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('Knowledge curation candidates for '))
  }

  it('renders one line per swept run naming per-kind projected counts and the outcome split', async () => {
    const warn = vi.fn()
    const info = vi.fn()
    const operations = successfulOperations({
      emitCurationCandidates: vi.fn(() => ({
        enqueued: 2,
        coalesced: 1,
        capExceeded: 0,
        refused: 0,
        details: [
          {
            candidateId: factIdA,
            kind: 'fact' as const,
            outcome: { kind: 'enqueued' as const, candidateId: factIdA },
          },
          {
            candidateId: factIdB,
            kind: 'fact' as const,
            outcome: { kind: 'enqueued' as const, candidateId: factIdB },
          },
          {
            candidateId: procedureId,
            kind: 'procedure' as const,
            outcome: { kind: 'coalesced' as const, candidateId: procedureId },
          },
        ],
      })),
    })

    await runCurationTail(baseOptions(operations, { log: { warn, info } }))

    const line = summaryLineFrom(info)
    expect(line).toBe(
      `Knowledge curation candidates for ${runId}: `
      + `fact 2 projected (2 enqueued); `
      + `procedure 1 projected (1 coalesced: ${procedureId}).`,
    )
    expect(info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Knowledge curation candidates for ')))
      .toHaveLength(1)
    // Additive beside the ladder extractor: the line matches NEITHER harness regex.
    expect([...String(line).matchAll(/drain produced (\d+) commit noop\(s\)/g)]).toHaveLength(0)
    expect([...String(line).matchAll(/drain-noops=(\d+)/g)]).toHaveLength(0)
  })

  it('always names the procedure kind, even at zero projected', async () => {
    const warn = vi.fn()
    const info = vi.fn()

    await runCurationTail(baseOptions(successfulOperations(), { log: { warn, info } }))

    expect(summaryLineFrom(info)).toBe(
      `Knowledge curation candidates for ${runId}: procedure 0 projected.`,
    )
  })

  it('renders the coalesced enqueue outcome visibly and never gates on it', async () => {
    // 381-49 adjudication: the round-11 candidate died queue-silently — 'coalesced'
    // is the one enqueue outcome no surface rendered. It must be named on the line
    // while the complete predicate stays byte-unchanged (receipt written, no warning).
    const warn = vi.fn()
    const info = vi.fn()
    const writeCurationTailReceipt = vi.fn()
    const operations = successfulOperations({
      writeCurationTailReceipt,
      emitCurationCandidates: vi.fn(() => ({
        enqueued: 0,
        coalesced: 1,
        capExceeded: 0,
        refused: 0,
        details: [
          {
            candidateId: procedureId,
            kind: 'procedure' as const,
            outcome: { kind: 'coalesced' as const, candidateId: procedureId },
          },
        ],
      })),
    })

    await runCurationTail(baseOptions(operations, { log: { warn, info } }))

    const line = summaryLineFrom(info)
    expect(line).toContain(`procedure 1 projected (1 coalesced: ${procedureId})`)
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/curation incomplete/i))
    expect(writeCurationTailReceipt).toHaveBeenCalledOnce()
  })

  it('keeps the line value-free: kinds, counts, and candidate ids only', async () => {
    const summarySeedSentinel = 'XSENTINEL-SUMMARY-SEEDX'
    const bodySeedSentinel = 'XSENTINEL-BODY-SEEDX'
    const warn = vi.fn()
    const info = vi.fn()
    const operations = successfulOperations({
      loadCompletedRunHandoff: () => ({
        executionContext: 'ci',
        runId,
        tests: [{
          steps: [{
            stepText: summarySeedSentinel,
            subActions: [{ plan: bodySeedSentinel }],
          }],
        }],
      } as unknown as CompletedRunHandoff),
      emitCurationCandidates: vi.fn(() => ({
        enqueued: 1,
        coalesced: 0,
        capExceeded: 0,
        refused: 1,
        details: [
          {
            candidateId: factIdA,
            kind: 'fact' as const,
            outcome: { kind: 'enqueued' as const, candidateId: factIdA },
          },
          {
            kind: 'procedure' as const,
            outcome: { kind: 'refused' as const, reason: 'artifact-io-error' as const },
          },
        ],
      })),
    })

    await runCurationTail(baseOptions(operations, { log: { warn, info } }))

    const line = summaryLineFrom(info)
    expect(line).toBeDefined()
    for (const rendered of [...info.mock.calls, ...warn.mock.calls].map(([m]) => String(m))) {
      expect(rendered).not.toContain(summarySeedSentinel)
      expect(rendered).not.toContain(bodySeedSentinel)
    }
    // Kinds, counts, content-address ids, and fixed punctuation only.
    expect(line).toMatch(
      /^Knowledge curation candidates for [\w-]+: (?:[a-z-]+ \d+ projected(?: \([^()]*\))?(?:; )?)+\.$/,
    )
  })

  it('pins the complete predicate expression byte-identical (visibility never gates)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../curation/curation-tail.ts', import.meta.url)),
      'utf8',
    )

    // 388-02: the expression is pinned byte-identically at its new home. Extracting the
    // per-run fold out of the sweep loop moved it two nesting levels out, so the CONTINUATION
    // indentation is the only thing that changed — the operand list and its order are the
    // thing this test exists to hold, and both are untouched.
    expect(source).toContain(
      `complete = candidates.refused === 0
        && candidates.capExceeded === 0
        && canaries.refused === 0
        && canaries.unresolved === 0
        && !projectionFailed
        && (drain.kind === 'drained' || drain.kind === 'handed-off')
        && drain.failures === 0
        && drain.requeued === 0`,
    )
  })

  it('wires an info channel on the production tail logger (run.ts)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../commands/run.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('info(message: string): void')
  })
})

describe('the quarantine disposition line', () => {
  const sighting = {
    product: 'shop-web',
    filePath: 'suite/checkout.test.ts',
    testName: 'checkout completes',
    fingerprint: 'fp::app_bug',
    verdictClass: 'app_bug' as const,
    producer: 'analyze-run' as const,
    occurrenceOrdinals: 4,
    windowOrdinals: 5,
  }

  function enteredFixture(): QuarantineLedgerEvent {
    return {
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: '2026-08-05T12:00:00.000Z',
      product: sighting.product,
      filePath: sighting.filePath,
      testName: sighting.testName,
      fingerprint: 'fp::flake',
      verdictClass: 'flake',
      owner: 'unassigned',
      expiresAt: '2026-09-04T12:00:00.000Z',
    }
  }

  function releasedAutoFixture(): QuarantineLedgerEvent {
    return {
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'released-auto',
      at: '2026-08-05T12:00:00.000Z',
      product: sighting.product,
      filePath: sighting.filePath,
      testName: 'some other test',
    }
  }

  function withQuarantine(quarantine: FoldRunOutcomesReport['quarantine']) {
    return successfulOperations({
      foldRunOutcomes: vi.fn(() => ({ kind: 'applied' as const, tests: 1, quarantine })),
    })
  }

  it('stays silent when detection ran and found nothing worth saying', async () => {
    const info = vi.fn()
    const warn = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({
        kind: 'evaluated',
        append: { kind: 'appended', lines: 0 },
        events: [],
        // A flag alone is NOT news here: it fires every second failure and its home is the
        // recurrence sentence. Pinning the silence is what keeps the drain log readable.
        flagged: [{ ...sighting, verdictClass: 'flake', occurrenceOrdinals: 2 }],
        escalatedNotQuarantined: [],
        refusedLines: [],
      }),
      { log: { warn, info } },
    ))

    expect(info.mock.calls.map(([message]) => String(message))
      .filter((message) => message.startsWith('quarantine: '))).toEqual([])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Quarantine'))
  })

  it('renders one disposition line when lifecycle events landed', async () => {
    const info = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({
        kind: 'evaluated',
        append: { kind: 'appended', lines: 2 },
        events: [enteredFixture(), releasedAutoFixture()],
        flagged: [{ ...sighting, verdictClass: 'flake', occurrenceOrdinals: 2 }],
        escalatedNotQuarantined: [],
        refusedLines: [],
      }),
      { log: { warn: vi.fn(), info } },
    ))

    expect(info).toHaveBeenCalledWith(
      'quarantine: 1 entered, 1 released-auto, 0 escalated-not-quarantined (1 flagged)',
    )
  })

  it('is LOUD about an escalation the class gate withheld — it appends nothing', async () => {
    const info = vi.fn()
    const warn = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({
        kind: 'evaluated',
        append: { kind: 'appended', lines: 0 },
        events: [],
        flagged: [],
        escalatedNotQuarantined: [sighting],
        refusedLines: [],
      }),
      { log: { warn, info } },
    ))

    expect(info).toHaveBeenCalledWith(
      'quarantine: 0 entered, 0 released-auto, 1 escalated-not-quarantined (0 flagged)',
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Quarantine withheld for'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('app_bug'))

    // THE PRODUCER REACHES THE LINE (390-22 / WR-03). The field was carried onto the sighting so
    // an operator could tell an unauthorable class from an unauthored one, and it was never
    // printed — the claim was true of the SHAPE and false of the OPERATOR. Asserted on the emitted
    // text, not on the line's prefix: a rendering fix whose test matches only the prefix is the
    // same defect again.
    const withheld = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Quarantine withheld for'))
    expect(withheld).toHaveLength(1)
    expect(withheld[0]).toContain('analyze-run')
    // And the ACTIONABLE half: this producer means a verdict was already authored, so the operator
    // learns that re-running analysis will not change the answer.
    expect(withheld[0]).toMatch(/will not change the answer/)
    // THE DIFFERENTIAL (390-23 / CR-01): each arm's sentence is its own, two-sided. The
    // next-applied-run remedy belongs to the UNAUTHORED arm alone — an authored verdict's class
    // refusal is settled, and a later fold re-reads the same authored answer.
    expect(withheld[0]).not.toMatch(/next applied run/)
  })

  // THE UNAUTHORED CORPUS IS BUILT FROM PRODUCIBLE SHAPES ONLY (390-30, produced-not-literal law).
  // The leg this replaces spread `verdictClass: 'app_bug'` over `producer: 'deterministic-classifier'`
  // — a pair NO deterministic producer can mint (`classifyRootCause` returns exactly
  // `timeout | environment | flake | unknown`) and, worse, the class for which the sentence it pinned
  // is FALSE. A corpus written as a literal of the type under test cannot fail; the compile-guard
  // below is what keeps it that way. `cls` is typed `DeterministicRootCauseClass`, imported from the
  // runner that declares it, so an `app_bug` fixture here stops COMPILING rather than passing
  // vacuously. No `as` cast may bypass it — a cast reinstates exactly the defect.
  //
  // `flake` is producible by the type but unreachable on a FAILING member (a passing member carries
  // no `failure` row, so no crossing can carry class `flake` AND the deterministic producer —
  // detection.ts's own eligibility docstring), so the three legs below are the reachable arms.
  function unauthoredSighting(cls: DeterministicRootCauseClass) {
    return {
      ...sighting,
      fingerprint: `fp::${cls}`,
      verdictClass: cls,
      producer: 'deterministic-classifier' as const,
    }
  }

  async function withheldLineFor(cls: DeterministicRootCauseClass): Promise<string> {
    const warn = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({
        kind: 'evaluated',
        append: { kind: 'appended', lines: 0 },
        events: [],
        flagged: [],
        escalatedNotQuarantined: [unauthoredSighting(cls)],
        refusedLines: [],
      }),
      { log: { warn, info: vi.fn() } },
    ))

    const withheld = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Quarantine withheld for'))
    expect(withheld).toHaveLength(1)
    expect(withheld[0]).toContain('deterministic-classifier')
    return withheld[0] as string
  }

  it('tells a FLOOR-ELIGIBLE unauthored class that the next applied run may admit it', async () => {
    // `timeout` is floor-eligible (QUARANTINE_FLOOR_ELIGIBILITY) and auto-quarantinable
    // (QUARANTINE_CLASS_DISPOSITIONS), so it was withheld only for want of the per-test same-build
    // signature or because the per-run floor cap was spent — BOTH of which a later run can supply.
    // For this class alone the next-applied-run remedy is TRUE, and it is true by execution:
    // a capped identity IS admitted on a later evaluation, measured 2/2/2 across three consecutive
    // folds (round-4 verification).
    //
    // THE REMEDY, PINNED BY POSITIVE CONTENT (390-23 / CR-01). This arm used to name
    // an `analyze-run` invocation under the binary's name: a job kind enqueued programmatically at
    // post-run-tail.ts:425, absent from the top-level `program.addCommand` registry in cli.ts under
    // any subcommand — so the string it printed was not typeable by anyone. The
    // advice was unreachable even had the verb existed — this line is emitted inside the fold that
    // runs AFTER analysis had its turn, and `applyRunOutcomes` answers
    // `{ kind: 'not-evaluated', reason: 'already-applied' }` (run-outcomes.ts:424, :792), so
    // nothing re-decides THIS crossing. Pinned as POSITIVE CONTENT rather than as a blanket ban on
    // command-shaped strings: a correct future fix naming a REAL verb must not red this leg, and
    // replacing the remedy sentence with any other string must.
    const line = await withheldLineFor('timeout')
    expect(line).toMatch(/next applied run/)
    // Cross-arm negative twins: the other two arms' sentences belong to their own classes.
    expect(line).not.toMatch(/never auto-quarantined/)
    expect(line).not.toMatch(/requires an authored verdict/)
    expect(line).not.toMatch(/will not change the answer/)
  })

  it('tells an AUTHORED-REQUIRED unauthored class that no later run substitutes for a verdict', async () => {
    // `environment` IS auto-quarantinable but is `authored-required` — its evidence is a run-scoped
    // health probe, so a same-build signature does not make it per-test and the floor arm refuses it
    // FOREVER. Telling this operator "the next applied run may admit it then" promises relief no
    // fold grants: the crossing needs an ANALYST, not another run.
    const line = await withheldLineFor('environment')
    expect(line).toMatch(/requires an authored verdict/)
    expect(line).not.toMatch(/next applied run/)
    expect(line).not.toMatch(/never auto-quarantined/)
    expect(line).not.toMatch(/will not change the answer/)
  })

  it('tells an ESCALATE-ONLY unauthored class that no run admits it, ever', async () => {
    // `unknown` is `classifyRootCause`'s TERMINAL arm — the dominant real-world shape on a project
    // with no analysis budget — and its disposition is `escalate-only`: it is refused at the FIRST
    // conjunct of `autoQuarantines`, before eligibility is even consulted. The class itself is the
    // refusal.
    const line = await withheldLineFor('unknown')
    expect(line).toMatch(/never auto-quarantined/)
    expect(line).not.toMatch(/next applied run/)
    expect(line).not.toMatch(/requires an authored verdict/)
    expect(line).not.toMatch(/will not change the answer/)
  })

  it('names RECLASSIFICATION as the one thing that admits an escalate-only crossing', async () => {
    const line = await withheldLineFor('unknown')
    expect(line).toMatch(/only a verdict reclassifying it can/)
    expect(line).not.toMatch(/no authored verdict admits/)
  })

  it('warns when the committed ledger could not be read at all', async () => {
    const warn = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({ kind: 'ledger-unreadable', reason: 'schemaVersion 99 is newer' }),
      { log: { warn, info: vi.fn() } },
    ))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Quarantine detection skipped'),
    )
  })

  it('says nothing at all when detection never ran', async () => {
    const info = vi.fn()
    const warn = vi.fn()

    await runCurationTail(baseOptions(
      withQuarantine({ kind: 'not-evaluated', reason: 'already-applied' }),
      { log: { warn, info } },
    ))

    expect([...info.mock.calls, ...warn.mock.calls]
      .map(([message]) => String(message))
      .filter((message) => message.toLowerCase().includes('quarantine'))).toEqual([])
  })
})
