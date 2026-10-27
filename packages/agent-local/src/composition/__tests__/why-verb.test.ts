// `knowledge.brief.why` answers about THEN (Phase 387 plan 06, KREV-02 / D-14 / D-15).
//
// Nothing is stubbed on the answering path. Bundles are really published to a temp knowledge
// root, the index is really rebuilt, the serving reader really assembles a brief and returns
// the trace it was assembled with, the trace is really written into a handoff document on disk,
// and the verb reads it back through the version guard.
//
// THE VACUITY THIS FILE IS BUILT AGAINST. "The answer is byte-identical after the index
// changed" is trivially true if the index change did not change anything a fresh retrieval
// would return — a test that mutated nothing would pass it. So Test 1 proves POTENCY first: it
// re-serves after the mutation and asserts the fresh brief and trace DID change. Only then is
// the why-verb's unchanged answer evidence of anything.
//
// AND THE SECOND ONE. "The absence path performs zero live-index reads" is vacuous if the path
// never had a handle on an index to begin with. Test 2 reports which of the two it is by
// establishing both halves: a poisoned knowledge port whose every method throws is bound into a
// real registry, the verb answers, and the poison is never touched — and a control invocation
// of a DIFFERENT verb through the same registry proves the poison would have fired if reached.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionRegistry, KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import {
  openKnowledgeReader,
  publishBundleForTest,
  rebuildIndex,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { HANDOFF_FILE, RUNS_SUBDIR } from '@vostride/agent-qa-runner-local'
import {
  BundleOutcomeEventSchema,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  asEvidenceToken,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  BriefBlock,
  BriefWhyResult,
  BundleDiscriminant,
  BundleDraft,
  FunctionCaller,
  MaskedResolvedConfig,
  ScopeKey,
  ServedBrief,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKnowledgeReader, createRunsReader } from '../compose-local-agent.js'

const PRODUCT = 'why-storefront'
const SCOPE: ScopeKey = { tier: 'product', key: PRODUCT }
const RUN_ID = 'run-why-alpha'
const TEST_ID = 't_checkout'

/**
 * Small enough that the seven-record fixture does not fit, so the truncation ledger is
 * non-empty (measured: 6 served, 1 cut).
 *
 * That is not a detail: `truncated` is the ledger that answers "why didn't it mention X"
 * (D-14), and a budget that admitted everything would leave Test 3 asserting over an empty
 * array — which passes for the wrong reason. The cases that depend on a cut candidate assert
 * the ledger is non-empty before using it, so a retune that silently admitted everything
 * fails loudly instead of passing vacuously.
 */
const SERVE_BUDGET = 400

/**
 * Enough records that the budget above demonstrably cuts some of them.
 *
 * Sized from a measurement rather than a guess, and the cases that use it assert the ledger is
 * non-empty before reading it — so if a serving change ever admits all twelve, this fixture
 * fails loudly instead of quietly asserting over an empty array.
 */
const TRUNCATING_FIXTURE = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima',
] as const

// 2026-10-02 (432-38, D-12): no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither (432-20).
const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

function bundleInput(name: string, createdAtOrdinal: number): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    // ONE shared anchor across every fixture record, so every one of them is an eligible
    // candidate for the product-scope brief and the budget is what decides which are served.
    anchors: [{ t: 'page', route: '/checkout' }],
    scope: SCOPE,
    summary: `${name}: the checkout page reports a stale cart badge after the last item is removed`,
    body: `${name} body — observed on the checkout page during a purchase flow. `.repeat(8),
    distilledEvidenceRef: { id: `${name}-evidence`, sha: 'a'.repeat(64) },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name },
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal,
    screenStates: [],
    // PROMOTED at publication, because a bare candidate is not servable and a fixture whose
    // records never reach the brief would leave every assertion below measuring an empty
    // serve — which is exactly how a why-verb test passes without ever exercising a why.
    initialEvents: [BundleOutcomeEventSchema.parse({
      type: 'promoted',
      evidenceToken: asEvidenceToken(`promoted-${name}`),
      curationJobId: `why-job-${name}`,
      buildOrdinal: 10,
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `why-${name}`,
      testId: 'why-fixture',
      stepIndex: 0,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
  }
}

/**
 * A `ServedBrief` built from the block the reader actually assembled.
 *
 * Channels 2 and 3 are empty because this fixture serves only Channel 1; the handoff load
 * boundary checks `channel1` at object depth and the why-verb's offering check wants the three
 * §A11 channels plus a digest, and both are satisfied by the real block's own lines.
 */
function servedBriefFrom(block: BriefBlock): ServedBrief {
  return {
    scope: SCOPE,
    asOfBuild: 0,
    budget: SERVE_BUDGET,
    truncation: block.truncation,
    channel1: block.lines,
    channel2: [],
    channel3: [],
    briefDigest: `digest-${String(block.lines.length)}`,
  }
}

interface StepSpec {
  stepIndex: number
  brief: BriefBlock
  trace?: ServedRetrievalTraceV1
}

interface TestSpec {
  testId: string
  steps: readonly StepSpec[]
}

describe('knowledge.brief.why answers from the persisted trace (387-06)', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string

  function seedBundle(name: string, createdAtOrdinal: number): string {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
    }
    const outcome = publishBundleForTest(config, bundleInput(name, createdAtOrdinal))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('why fixture bundle did not publish')
    return outcome.id
  }

  /** Serve Channel 1 through the REAL reader and hand back both halves of the composite. */
  function serve(): { brief: BriefBlock; trace: ServedRetrievalTraceV1 } {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
    return reader.getRunBrief(SCOPE, SERVE_BUDGET)
  }

  /** Write a real handoff document under the runs directory the runs reader enumerates. */
  function writeHandoff(runId: string, tests: readonly TestSpec[]): void {
    const runDir = join(agentQaRoot, RUNS_SUBDIR, runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), JSON.stringify({
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId,
      scope: SCOPE,
      buildOrdinal: 12,
      executionContext: 'local-headless',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
      startedAt: 1,
      endedAt: 2,
      tests: tests.map((test, testIndex) => ({
        testId: test.testId,
        testName: `member ${test.testId}`,
        filePath: `tests/${test.testId}.yaml`,
        testIndex,
        outcome: 'passed',
        steps: test.steps.map((step) => ({
          stepIndex: step.stepIndex,
          stepText: `step ${String(step.stepIndex)} of ${test.testId}`,
          cacheStatus: 'miss',
          servedBrief: servedBriefFrom(step.brief),
          ...(step.trace === undefined ? {} : { retrievalTrace: step.trace }),
          subActions: [],
          verifierVerdict: { pass: true, reasoning: 'fixture' },
        })),
      })),
    }, null, 2), 'utf8')
  }

  /**
   * A registry over the REAL runs reader and a caller-supplied knowledge port.
   *
   * Built here rather than through `composeLocalAgent` for one reason: the poisoned-reader test
   * needs to substitute the knowledge port, and a composition root that builds its own deps
   * offers nowhere to do that. Everything else — the gate, the registry, the runs reader — is
   * the production article.
   */
  function registryWith(knowledge: KnowledgeReaderPort): FunctionRegistry {
    return createFunctionRegistry({
      deps: {
        runs: createRunsReader(agentQaRoot),
        knowledge,
        config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
        entities: {
          resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
          get: () => Promise.resolve(undefined),
        },
      },
      // 2026-10-02 (432-38, D-12): no `resolveExecutionContext` registry option; the registry reads
      // no context (432-20).
    })
  }

  function realRegistry(): FunctionRegistry {
    return registryWith(createKnowledgeReader(() => knowledgeRoot))
  }

  async function why(
    registry: FunctionRegistry,
    input: Record<string, unknown>,
  ): Promise<BriefWhyResult> {
    return await invokeFunction(
      registry,
      'knowledge.brief.why',
      input,
      CALLER,
    ) as BriefWhyResult
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-why-verb-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(agentQaRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // ---- Test 1: then, not now -------------------------------------------------------------

  it('answers identically after the index changes — and the change is proven POTENT',
    async () => {
      for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
        seedBundle(name, 10)
      }
      await rebuildIndex({ knowledgeRoot })

      const servedThen = serve()
      expect(servedThen.trace.servedLines.length).toBeGreaterThan(0)
      writeHandoff(RUN_ID, [
        { testId: TEST_ID, steps: [{ stepIndex: 0, brief: servedThen.brief, trace: servedThen.trace }] },
      ])

      const first = await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })
      expect(first.kind).toBe('answered')

      // ---- the mutation ----
      for (const name of ['Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo']) {
        seedBundle(name, 10)
      }
      await rebuildIndex({ knowledgeRoot })

      // ---- POTENCY, asserted before the claim that depends on it ----
      const servedNow = serve()
      const changed = JSON.stringify(servedNow.trace) !== JSON.stringify(servedThen.trace)
        || JSON.stringify(servedNow.brief.lines) !== JSON.stringify(servedThen.brief.lines)
      expect(
        changed,
        'the index mutation must change what a FRESH serve returns, or the byte-identity '
        + 'assertion below is measuring nothing',
      ).toBe(true)

      // ---- the claim ----
      const second = await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })

  it('answers identically after a served record is REMOVED from the index', async () => {
    // The additive mutation above cannot distinguish "answers from the artifact" from "answers
    // from an index that still contains everything it did". Removing a record the brief was
    // built from is the case where a re-querying implementation could not possibly reproduce
    // the original attribution.
    const doomed = seedBundle('Alpha', 10)
    for (const name of ['Bravo', 'Charlie', 'Delta']) seedBundle(name, 10)
    await rebuildIndex({ knowledgeRoot })

    const servedThen = serve()
    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: servedThen.brief, trace: servedThen.trace }] },
    ])
    const first = await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })
    expect(first.kind).toBe('answered')
    if (first.kind !== 'answered') throw new Error('unreachable')

    const attributedIds = [
      ...first.trace.servedLines.map((line) => line.recordId),
      ...first.trace.truncated.map((line) => line.recordId),
    ]
    expect(attributedIds).toContain(doomed)

    rmSync(join(knowledgeRoot, 'memory', PRODUCT, 'bundles', doomed), {
      recursive: true,
      force: true,
    })
    await rebuildIndex({ knowledgeRoot })

    const servedNow = serve()
    const stillAttributed = [
      ...servedNow.trace.servedLines.map((line) => line.recordId),
      ...servedNow.trace.truncated.map((line) => line.recordId),
    ]
    expect(stillAttributed, 'the removal must be potent').not.toContain(doomed)

    const second = await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    if (second.kind !== 'answered') throw new Error('unreachable')
    // Named explicitly: the answer still attributes a record the store no longer holds, which
    // is the whole of what "about then" means.
    expect([
      ...second.trace.servedLines.map((line) => line.recordId),
      ...second.trace.truncated.map((line) => line.recordId),
    ]).toContain(doomed)
  })

  // ---- Test 2: the absence path, and a poisoned reader -------------------------------------

  it('returns no-trace(pre-trace-run) offering the brief, and never touches the index',
    async () => {
      seedBundle('Alpha', 10)
      await rebuildIndex({ knowledgeRoot })
      const served = serve()
      // A step with NO retrievalTrace: exactly a pre-387 run.
      writeHandoff(RUN_ID, [
        { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief }] },
      ])

      const touched: string[] = []
      const poisoned: KnowledgeReaderPort = {
        listBundles: () => { touched.push('listBundles'); throw new Error('poisoned reader') },
        inspectRecords: () => {
          touched.push('inspectRecords')
          throw new Error('poisoned reader')
        },
        diffSince: () => { touched.push('diffSince'); throw new Error('poisoned reader') },
        showRecord: () => { touched.push('showRecord'); throw new Error('poisoned reader') },
      }
      const registry = registryWith(poisoned)

      const result = await why(registry, { runId: RUN_ID, stepIndex: 0 })

      expect(result.kind).toBe('no-trace')
      if (result.kind !== 'no-trace') throw new Error('unreachable')
      expect(result.reason).toBe('pre-trace-run')
      // The brief survived even though its trace did not, so it is OFFERED.
      expect(result.servedBrief?.channel1).toEqual(served.brief.lines)
      expect(touched).toEqual([])

      // THE CONTROL that makes the empty list mean something: the same poisoned port, reached
      // through a verb that does consult it, DOES fire. Without this, `touched` being empty is
      // consistent with a registry that was never handed the poison at all.
      await expect(invokeFunction(registry, 'knowledge.bundles.list', {}, CALLER))
        .rejects.toThrow('poisoned reader')
      expect(touched).toEqual(['listBundles'])
    })

  it('never touches the index on the ANSWERED path either', async () => {
    seedBundle('Alpha', 10)
    seedBundle('Bravo', 10)
    await rebuildIndex({ knowledgeRoot })
    const served = serve()
    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
    ])

    const touched: string[] = []
    const poisoned: KnowledgeReaderPort = {
      listBundles: () => { touched.push('listBundles'); throw new Error('poisoned reader') },
      inspectRecords: () => { touched.push('inspectRecords'); throw new Error('poisoned reader') },
      diffSince: () => { touched.push('diffSince'); throw new Error('poisoned reader') },
      showRecord: () => { touched.push('showRecord'); throw new Error('poisoned reader') },
    }

    const result = await why(registryWith(poisoned), { runId: RUN_ID, stepIndex: 0 })

    expect(result.kind).toBe('answered')
    expect(touched).toEqual([])
  })

  // ---- Test 3: the truncation ledger reaches the answer ------------------------------------

  it('surfaces the cut candidates with their rank and score (D-14)', async () => {
    for (const name of TRUNCATING_FIXTURE) seedBundle(name, 10)
    await rebuildIndex({ knowledgeRoot })
    const served = serve()

    // The fixture is only a fixture if the budget really cut something.
    expect(
      served.trace.truncated.length,
      'the serve budget must actually truncate, or this case asserts over an empty ledger',
    ).toBeGreaterThan(0)

    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
    ])

    const result = await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })

    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') throw new Error('unreachable')
    expect(result.trace.truncated).toEqual(served.trace.truncated)
    for (const line of result.trace.truncated) {
      expect(line.rank).toBeGreaterThan(0)
      expect(Number.isFinite(line.score)).toBe(true)
    }
    // A cut candidate is NOT in the served ledger — the two answer different questions.
    const servedIds = new Set(result.trace.servedLines.map((line) => line.recordId))
    for (const line of result.trace.truncated) expect(servedIds.has(line.recordId)).toBe(false)
  })

  // ---- Test 4: addressing ------------------------------------------------------------------

  it('narrows to one record when recordId is given, keeping BOTH ledgers', async () => {
    for (const name of TRUNCATING_FIXTURE) seedBundle(name, 10)
    await rebuildIndex({ knowledgeRoot })
    const served = serve()
    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
    ])
    const registry = realRegistry()

    const cut = served.trace.truncated[0]
    expect(cut, 'the fixture needs a cut candidate to narrow to').toBeDefined()
    if (cut === undefined) throw new Error('unreachable')

    const narrowed = await why(registry, {
      runId: RUN_ID,
      stepIndex: 0,
      recordId: cut.recordId,
    })

    expect(narrowed.kind).toBe('answered')
    if (narrowed.kind !== 'answered') throw new Error('unreachable')
    // The whole point of narrowing to a CUT record: "why didn't it mention X" is answered by
    // X's rank and score among the candidates that did not fit. A filter that kept only served
    // lines would answer that question with an empty result.
    expect(narrowed.trace.truncated).toEqual([cut])
    expect(narrowed.trace.servedLines).toEqual([])

    const servedLine = served.trace.servedLines[0]
    if (servedLine === undefined) throw new Error('the fixture needs a served line')
    const narrowedToServed = await why(registry, {
      runId: RUN_ID,
      stepIndex: 0,
      recordId: servedLine.recordId,
    })
    if (narrowedToServed.kind !== 'answered') throw new Error('unreachable')
    expect(narrowedToServed.trace.servedLines).toEqual([servedLine])

    // A record that took no part is an ANSWERED result with two empty ledgers, not an absence:
    // the trace exists and says that record contributed nothing.
    const stranger = await why(registry, {
      runId: RUN_ID,
      stepIndex: 0,
      recordId: 'rec-that-was-never-a-candidate',
    })
    expect(stranger).toEqual({
      kind: 'answered',
      trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [] },
    })
  })

  it('reports a missing artifact and an out-of-range step as different absences', async () => {
    seedBundle('Alpha', 10)
    await rebuildIndex({ knowledgeRoot })
    const served = serve()
    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
    ])
    const registry = realRegistry()

    // No such run: the handoff is gone or was never written. `go looking`.
    expect(await why(registry, { runId: 'run-nobody-recorded', stepIndex: 0 }))
      .toEqual({ kind: 'no-trace', reason: 'artifact-missing' })

    // The run and its trace exist; the step being asked about does not. `the address is wrong`.
    expect(await why(registry, { runId: RUN_ID, stepIndex: 41 }))
      .toEqual({ kind: 'no-trace', reason: 'step-not-found' })

    // A testId that names no member is the same class of wrong address.
    expect(await why(registry, { runId: RUN_ID, stepIndex: 0, testId: 't_not_a_member' }))
      .toEqual({ kind: 'no-trace', reason: 'step-not-found' })
  })

  it('REFUSES an ambiguous address on a multi-test run rather than picking a test',
    async () => {
      // `stepIndex` is numbered per member test, so this run has two step 0s. 387-02 left this
      // as an explicit obligation: refuse, never pick the first.
      seedBundle('Alpha', 10)
      seedBundle('Bravo', 10)
      await rebuildIndex({ knowledgeRoot })
      const served = serve()
      writeHandoff(RUN_ID, [
        { testId: 't_checkout', steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
        { testId: 't_refund', steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
      ])
      const registry = realRegistry()

      const error = await why(registry, { runId: RUN_ID, stepIndex: 0 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      expect(error).toBeInstanceOf(Error)
      // It names the candidates, because "be more specific" without saying what to choose
      // between leaves the reader to go and find them by hand.
      expect((error as Error).message).toContain('t_checkout')
      expect((error as Error).message).toContain('t_refund')

      // Naming the test resolves it, so the refusal is about the ADDRESS and not about the run.
      const answered = await why(registry, {
        runId: RUN_ID,
        stepIndex: 0,
        testId: 't_refund',
      })
      expect(answered.kind).toBe('answered')
    })

  it('does not refuse a single-test run that omits the testId', async () => {
    // The counterfactual for the refusal above: ambiguity is a property of the run, not a
    // standing demand for a testId. A verb that always required one would pass the refusal
    // test and be wrong for every ordinary run.
    seedBundle('Alpha', 10)
    await rebuildIndex({ knowledgeRoot })
    const served = serve()
    writeHandoff(RUN_ID, [
      { testId: TEST_ID, steps: [{ stepIndex: 0, brief: served.brief, trace: served.trace }] },
    ])

    expect((await why(realRegistry(), { runId: RUN_ID, stepIndex: 0 })).kind).toBe('answered')
  })
})
