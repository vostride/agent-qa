// Op-level behaviour for the three expansion capabilities (Phase 384, Plan 03).
//
// Ops are pure functions of (validated input, injected deps). These cases call `invoke`
// directly against fake ports so the projection logic is pinned independently of the gate,
// the registry, and any host access — `invoke-function.test.ts` owns the pipeline itself.

import type {
  CompletedRunHandoff,
  ConfigChange,
  ConfigChangeOutput,
  FunctionCaller,
  KnowledgeBundleSummary,
  KnowledgeGatesListResult,
  MaskedResolvedConfig,
  RunId,
} from '@vostride/agent-qa-schema'
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  stampReceiptDigest,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../functions/invoke.js'
import { authoringDraftEditSpec } from '../functions/ops/authoring-draft-edit.js'
import { authoringDraftWriteSpec } from '../functions/ops/authoring-draft-write.js'
import { authoringFunnelGetSpec } from '../functions/ops/authoring-funnel-get.js'
import { authoringVerifyDraftSpec } from '../functions/ops/authoring-verify-draft.js'
import { configAuthSetSpec } from '../functions/ops/config-auth-set.js'
import { configFieldSetSpec } from '../functions/ops/config-field-set.js'
import { configGetSpec } from '../functions/ops/config-get.js'
import { configHookAddSpec } from '../functions/ops/config-hook-add.js'
import { configProjectScaffoldSpec } from '../functions/ops/config-project-scaffold.js'
import { configTargetEditSpec } from '../functions/ops/config-target-edit.js'
import { editorLiveUrlSpec } from '../functions/ops/editor-live-url.js'
import { entitiesGetSpec } from '../functions/ops/entities-get.js'
import { entitiesResolveSpec } from '../functions/ops/entities-resolve.js'
import { knowledgeBriefWhySpec } from '../functions/ops/knowledge-brief-why.js'
import { knowledgeBundlesListSpec } from '../functions/ops/knowledge-bundles-list.js'
import { knowledgeForgetSpec } from '../functions/ops/knowledge-forget-propose.js'
import { knowledgeGatesListSpec, KnowledgeGatesUnboundError } from '../functions/ops/knowledge-gates-list.js'
import { knowledgeRecordsDiffSpec } from '../functions/ops/knowledge-records-diff.js'
import { quarantineAddSpec } from '../functions/ops/quarantine-add.js'
import { quarantineListSpec } from '../functions/ops/quarantine-list.js'
import { quarantineReleaseSpec } from '../functions/ops/quarantine-release.js'
import { runsArtifactSpec } from '../functions/ops/runs-artifact.js'
import { runsDetailSpec } from '../functions/ops/runs-detail.js'
import { runsDigestSpec } from '../functions/ops/runs-digest.js'
import { runsEvidenceSpec } from '../functions/ops/runs-evidence.js'
import { runsEventsSpec } from '../functions/ops/runs-events.js'
import { RunNotFoundError, runsGetSpec } from '../functions/ops/runs-get.js'
import { runsListSpec } from '../functions/ops/runs-list.js'
import { runsLiveUrlSpec } from '../functions/ops/runs-live-url.js'
import { runsMarkSpec } from '../functions/ops/runs-mark.js'
import { runsMarkPreviewSpec } from '../functions/ops/runs-mark-preview.js'
import { runsMarksHistorySpec } from '../functions/ops/runs-marks-history.js'
import { runsOverviewSpec } from '../functions/ops/runs-overview.js'
import { runsStartSpec } from '../functions/ops/runs-start.js'
import { createFunctionRegistry } from '../functions/registry.js'
import type { FunctionDeps } from '../functions/spec.js'

function bundle(overrides: Partial<KnowledgeBundleSummary> = {}): KnowledgeBundleSummary {
  return {
    bundleId: 'rec-1',
    product: 'shop',
    dir: 'memory/shop/bundles/rec-1',
    kind: 'fact',
    subtype: 'selector',
    scope: { tier: 'product', key: 'checkout' },
    status: 'active',
    trust: 0.75,
    counters: { confirmed: 2, contradicted: 0, helpful: 0, harmful: 0 },
    openedAtOrdinal: 4,
    lastConfirmedOrdinal: 7,
    summary: 'Checkout button on the cart page',
    evidenceIncomplete: false,
    ...overrides,
  }
}

function handoff(overrides: Partial<CompletedRunHandoff> = {}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: 'run-alpha' as RunId,
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 11,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1_000,
    endedAt: 2_000,
    tests: [],
    ...overrides,
  }
}

const maskedConfig: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/workspace/agent-qa.config.yaml',
  entries: [
    { key: 'workspace.testMatch', value: '["tests/**/*.yaml"]', source: 'config-file', masked: false },
    { key: 'registry.providers.acme.apiKey', value: '[secret:PW_441]', source: 'config-file', masked: true },
  ],
}

/**
 * The read-side knowledge stub, in one place so a port widening is one edit rather than one
 * per case. `showRecord` reports the honest absence: nothing in this file commits a record.
 */
function fakeKnowledge(
  overrides: Partial<FunctionDeps['knowledge']> = {},
): FunctionDeps['knowledge'] {
  return {
    listBundles: () => Promise.resolve([]),
    inspectRecords: () => Promise.resolve([]),
    diffSince: () => Promise.resolve([]),
    showRecord: ({ recordId }) => Promise.resolve({
      kind: 'not-found',
      schemaVersion: 2,
      recordId,
    } as const),
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<FunctionDeps> = {}): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      // The stream port is exercised in runs-events.test.ts; here it exists only because
      // FunctionDeps is a required, non-partial record.
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: fakeKnowledge(),
    // 387: `entities` is a REQUIRED read port on FunctionDeps. Stated here so the record
    // typechecks, and stated as an ANSWERING stub rather than a refusing one: these cases
    // exercise other ops, and nothing in this file mints an address, so an honest miss and a
    // reported absence are the truthful answers.
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: { getMasked: () => Promise.resolve(maskedConfig) },
    ...overrides,
  }
}

describe('runs.get', () => {
  it('declares a read-only unary contract bound in this composition', () => {
    expect(runsGetSpec.id).toBe('runs.get')
    // RE-SPELLED 2026-10-01 (432-23, D-12) from `requiredScopes` equal to ['read']: the op
    // declares no scope, because no caller is checked for one.
    expect(runsGetSpec).not.toHaveProperty('requiredScopes')
    expect(runsGetSpec.resultKind).toBe('unary')
    // Bound in EVERY composition: the implementation names no optional dep, so there is
    // nothing a host could withhold that would leave it unbound (D-16).
    expect(runsGetSpec.boundThrough).toBeUndefined()
    expect(runsGetSpec.risk).toEqual({ name: 'fn:runs.get', recognized: true, readOnly: true })
  })

  it('projects a completed handoff into a RunDetail, markers included', async () => {
    const deps = fakeDeps({
      runs: {
        list: () => Promise.resolve([]),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
        get: () => Promise.resolve(handoff({
          gateRun: true,
          tests: [{
            testId: 'test-1',
            testName: 'checks out',
            filePath: 'tests/checkout.yaml',
            testIndex: 0,
            outcome: 'failed',
            steps: [
              { } as never,
              { } as never,
              { } as never,
            ],
            rootCause: {
              class: 'app_bug',
              producer: 'deterministic-classifier',
              confidence: 0.8,
              evidence: {
                citedSteps: [2],
                citedAnchors: [],
                citedArtifacts: [],
                rationale: 'the checkout button never enabled',
              },
              memoryMisdirectionRuledOut: true,
              perTest: 0,
            },
          }],
        })),
      },
    })

    const detail = await runsGetSpec.invoke({ runId: 'run-alpha' as RunId }, deps)

    expect(detail).toMatchObject({
      runId: 'run-alpha',
      buildOrdinal: 11,
      aggregateVerdict: 'failed',
      configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
      gateRun: true,
    })
    expect(detail.excludedFromOutcomes).toBeUndefined()
    expect(detail.tests).toEqual([{
      testId: 'test-1',
      testName: 'checks out',
      filePath: 'tests/checkout.yaml',
      testIndex: 0,
      outcome: 'failed',
      stepCount: 3,
      rootCause: {
        class: 'app_bug',
        producer: 'deterministic-classifier',
        confidence: 0.8,
        rationale: 'the checkout button never enabled',
      },
    }])
  })

  it('omits both durable markers and the rootCause when the handoff omits them', async () => {
    const deps = fakeDeps({
      runs: {
        list: () => Promise.resolve([]),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
        get: () => Promise.resolve(handoff({
          tests: [{
            testId: 'test-1',
            testName: 'passes',
            filePath: 'tests/ok.yaml',
            testIndex: 0,
            outcome: 'passed',
            steps: [],
          }],
        })),
      },
    })

    const detail = await runsGetSpec.invoke({ runId: 'run-alpha' as RunId }, deps)

    expect('gateRun' in detail).toBe(false)
    expect('excludedFromOutcomes' in detail).toBe(false)
    expect('rootCause' in detail.tests[0]!).toBe(false)
    expect(detail.tests[0]!.stepCount).toBe(0)
  })

  it('throws the typed not-found error for a runId the reader cannot resolve', async () => {
    await expect(
      runsGetSpec.invoke({ runId: 'run-missing' as RunId }, fakeDeps()),
    ).rejects.toThrow(RunNotFoundError)

    const error = await runsGetSpec
      .invoke({ runId: 'run-missing' as RunId }, fakeDeps())
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RunNotFoundError)
    expect((error as RunNotFoundError).name).toBe('RunNotFoundError')
    expect((error as RunNotFoundError).runId).toBe('run-missing')
    expect((error as Error).message).toContain('run-missing')
  })
})

describe('knowledge.bundles.list', () => {
  it('declares a read-only unary contract bound in this composition', () => {
    expect(knowledgeBundlesListSpec.id).toBe('knowledge.bundles.list')
    // RE-SPELLED 2026-10-01 (432-25, D-12) from `requiredScopes` equal to ['read']: the op
    // declares no scope; read-only stays on its risk descriptor below.
    expect(knowledgeBundlesListSpec).not.toHaveProperty('requiredScopes')
    expect(knowledgeBundlesListSpec.resultKind).toBe('unary')
    expect(knowledgeBundlesListSpec.boundThrough).toBeUndefined()
    expect(knowledgeBundlesListSpec.risk).toEqual({
      name: 'fn:knowledge.bundles.list',
      recognized: true,
      readOnly: true,
    })
  })

  it('returns the reader rows in a total product-then-id order', async () => {
    const deps = fakeDeps({
      knowledge: fakeKnowledge({
        listBundles: () => Promise.resolve([
          bundle({ bundleId: 'rec-9', product: 'shop' }),
          bundle({ bundleId: 'rec-2', product: 'atlas' }),
          bundle({ bundleId: 'rec-1', product: 'shop' }),
        ]),
      }),
    })

    const rows = await knowledgeBundlesListSpec.invoke({}, deps)

    expect(rows.map((row) => `${row.product}/${row.bundleId}`)).toEqual([
      'atlas/rec-2',
      'shop/rec-1',
      'shop/rec-9',
    ])
  })

  it('returns an empty list when the knowledge root holds no bundles', async () => {
    expect(await knowledgeBundlesListSpec.invoke({}, fakeDeps())).toEqual([])
  })
})

describe('config.get', () => {
  it('declares a read-only unary contract bound in this composition', () => {
    expect(configGetSpec.id).toBe('config.get')
    // RE-SPELLED 2026-10-01 (432-24, D-12) from `requiredScopes` equal to ['read']: the op
    // declares no scope, because no caller is checked for one.
    expect(configGetSpec).not.toHaveProperty('requiredScopes')
    expect(configGetSpec.resultKind).toBe('unary')
    expect(configGetSpec.boundThrough).toBeUndefined()
    expect(configGetSpec.risk).toEqual({
      name: 'fn:config.get',
      recognized: true,
      readOnly: true,
    })
  })

  it('returns the injected masked config unchanged — masking is upstream of the op', async () => {
    expect(await configGetSpec.invoke({}, fakeDeps())).toEqual(maskedConfig)
  })
})

describe('the seed capability set', () => {
  it('registers exactly the four D-06 read ids', () => {
    expect([
      runsListSpec.id,
      runsGetSpec.id,
      knowledgeBundlesListSpec.id,
      configGetSpec.id,
    ].sort()).toEqual(['config.get', 'knowledge.bundles.list', 'runs.get', 'runs.list'])
  })
})
describe('knowledge.gates.list', () => {
  it('declares a read-only unary contract through the required knowledge port', () => {
    expect(knowledgeGatesListSpec.id).toBe('knowledge.gates.list')
    // RE-SPELLED 2026-10-01 (432-27, D-12) from `requiredScopes` equal to ['read']: the op
    // declares no scope; read-only stays on its risk descriptor below.
    expect(knowledgeGatesListSpec).not.toHaveProperty('requiredScopes')
    expect(knowledgeGatesListSpec.resultKind).toBe('unary')
    expect(knowledgeGatesListSpec.boundThrough).toBeUndefined()
    expect(knowledgeGatesListSpec.risk).toEqual({
      name: 'fn:knowledge.gates.list', recognized: true, readOnly: true,
    })
  })
  it('forwards the found DTO unchanged and classifies its live verdict', async () => {
    const result: KnowledgeGatesListResult = {
      kind: 'found', recordId: 'rec-1', product: 'shop', recordKind: 'fact', status: 'candidate',
      strongestPromotionPath: 'deterministic-verdict-floor',
      lines: [stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion',
        candidateId: 'rec-1', promotionPath: 'deterministic-verdict-floor',
        citedReceiptDigests: [], producedAtOrdinal: 43, producedBy: { opId: 'promote' } })],
      standing: [], live: { verdict: 'promote', promotionPath: 'deterministic-verdict-floor',
        citedReceiptDigests: [] },
    }
    const deps = fakeDeps({ knowledge: fakeKnowledge({
      gateReceipts: ({ candidateId }) => {
        expect(candidateId).toBe('rec-1')
        return Promise.resolve(result)
      },
    }) })
    expect(await knowledgeGatesListSpec.invoke({ recordId: 'rec-1' }, deps)).toBe(result)
    expect(knowledgeGatesListSpec.classify!(result)).toEqual({
      status: 'executed', outcome: '1 gate line(s); promote via deterministic-verdict-floor',
    })
    expect(knowledgeGatesListSpec.classify!({ kind: 'not-found', recordId: 'missing' })).toEqual({
      status: 'executed', outcome: 'record not found',
    })
    expect(knowledgeGatesListSpec.classify!({
      ...result, live: { verdict: 'hold', reason: 'not-candidate' },
    })).toEqual({ status: 'executed', outcome: '1 gate line(s); held: not-candidate' })
  })
  it('refuses an unbound gateReceipts capability by name', async () => {
    await expect(knowledgeGatesListSpec.invoke({ recordId: 'rec-1' }, fakeDeps()))
      .rejects.toBeInstanceOf(KnowledgeGatesUnboundError)
  })
})

// ---- C432-DECLARATION-KEYS (432-23, D-10/D-12) --------------------------------------------------
//
// The ten op specs 432-23 migrated, pinned at the SPEC, which is the layer the registry's own
// key-set census cannot see: a declaration omits the retired keys whatever the spec spells, so only
// a raw-spec cell proves the op-spec owner actually removed them. The second half pins what must NOT
// move with them — id, result kind, binding need, risk descriptor and the classify fold — so a
// metadata removal that also dropped a binding or changed a tier reds here by name.
describe('C432-DECLARATION-KEYS: the 432-23 op specs carry no permission metadata', () => {
  const migrated = [
    { spec: authoringFunnelGetSpec, resultKind: 'unary', boundThrough: 'authoringFunnel',
      risk: { name: 'fn:authoring.funnel.get', recognized: true, readOnly: true } },
    { spec: knowledgeRecordsDiffSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.records.diff', recognized: true, readOnly: true } },
    { spec: entitiesResolveSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:entities.resolve', recognized: true, readOnly: true } },
    { spec: authoringVerifyDraftSpec, resultKind: 'unary', boundThrough: 'draftEvaluation',
      risk: { name: 'fn:authoring.draft.verify', recognized: true, declaredTier: 'mutating-local' } },
    { spec: runsEventsSpec, resultKind: 'stream', boundThrough: undefined,
      risk: { name: 'fn:runs.events', recognized: true, readOnly: true } },
    { spec: authoringDraftWriteSpec, resultKind: 'unary', boundThrough: 'draftShelf',
      risk: { name: 'fn:authoring.draft.write', recognized: true, declaredTier: 'mutating-shared' } },
    { spec: runsGetSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:runs.get', recognized: true, readOnly: true } },
    { spec: knowledgeForgetSpec, resultKind: 'unary', boundThrough: 'knowledgeReview',
      risk: { name: 'fn:knowledge.forget', recognized: true, readOnly: false } },
    { spec: runsStartSpec, resultKind: 'unary', boundThrough: 'runInvocation',
      risk: { name: 'fn:runs.start', recognized: true, declaredTier: 'mutating-local' } },
    { spec: configTargetEditSpec, resultKind: 'unary', boundThrough: 'configWrite',
      risk: { name: 'fn:config.target.edit', recognized: true, readOnly: false } },
  ] as const

  it('spells neither retired permission key on any of the ten specs', () => {
    expect(migrated.map(({ spec }) => spec.id)).toEqual([
      'authoring.funnel.get',
      'knowledge.records.diff',
      'entities.resolve',
      'authoring.draft.verify',
      'runs.events',
      'authoring.draft.write',
      'runs.get',
      'knowledge.forget',
      'runs.start',
      'config.target.edit',
    ])
    for (const { spec } of migrated) {
      expect(Object.keys(spec), spec.id).not.toContain('requiredScopes')
      expect(Object.keys(spec), spec.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('keeps each spec\'s result kind, binding need, risk descriptor and classify fold', () => {
    for (const { spec, resultKind, boundThrough, risk } of migrated) {
      expect(spec.resultKind, spec.id).toBe(resultKind)
      expect(spec.boundThrough, spec.id).toBe(boundThrough)
      expect(spec.risk, spec.id).toEqual(risk)
      expect(typeof spec.classify, spec.id).toBe('function')
      expect(typeof spec.invoke, spec.id).toBe('function')
    }
    // The one disclosure among the ten was untouched by the metadata removal. RE-SPELLED 2026-10-02
    // (432-42, D-14): the per-op disclosure is deleted, so none of the ten carries one now.
    expect(migrated.filter(({ spec }) => 'disclose' in spec).map(({ spec }) => spec.id))
      .toEqual([])
  })
})

// ---- C432-DECLARATION-KEYS (432-24, D-10/D-12) --------------------------------------------------
//
// The second group of ten, pinned the same way as 432-23's above: absence at the SPEC, and an exact
// pin beside it of what must not move with the metadata. Kept as its own block so each op-spec owner
// extends a list it owns rather than one shared expectation.
describe('C432-DECLARATION-KEYS: the 432-24 op specs carry no permission metadata', () => {
  const migrated = [
    { spec: runsArtifactSpec, resultKind: 'unary', boundThrough: 'evidenceBlobs',
      risk: { name: 'fn:runs.artifact', recognized: true, readOnly: true } },
    { spec: runsListSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:runs.list', recognized: true, readOnly: true } },
    { spec: configGetSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:config.get', recognized: true, readOnly: true } },
    { spec: runsDigestSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:runs.digest', recognized: true, readOnly: true } },
    { spec: configFieldSetSpec, resultKind: 'unary', boundThrough: 'configWrite',
      risk: { name: 'fn:config.field.set', recognized: true, readOnly: false } },
    { spec: authoringDraftEditSpec, resultKind: 'unary', boundThrough: 'draftShelf',
      risk: { name: 'fn:authoring.draft.edit', recognized: true, declaredTier: 'mutating-local' } },
    { spec: knowledgeBriefWhySpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.brief.why', recognized: true, readOnly: true } },
    { spec: runsLiveUrlSpec, resultKind: 'unary', boundThrough: 'liveView',
      risk: { name: 'fn:runs.liveurl', recognized: true, readOnly: true } },
    { spec: runsMarkPreviewSpec, resultKind: 'unary', boundThrough: 'feedbackReads',
      risk: { name: 'fn:runs.mark.preview', recognized: true, readOnly: true } },
    { spec: runsMarkSpec, resultKind: 'unary', boundThrough: 'feedback',
      risk: { name: 'fn:runs.mark', recognized: true, readOnly: false, declaredTier: 'mutating-shared' } },
  ] as const

  it('spells neither retired permission key on any of the ten specs', () => {
    expect(migrated.map(({ spec }) => spec.id)).toEqual([
      'runs.artifact',
      'runs.list',
      'config.get',
      'runs.digest',
      'config.field.set',
      'authoring.draft.edit',
      'knowledge.brief.why',
      'runs.liveurl',
      'runs.mark.preview',
      'runs.mark',
    ])
    for (const { spec } of migrated) {
      expect(Object.keys(spec), spec.id).not.toContain('requiredScopes')
      expect(Object.keys(spec), spec.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('keeps each spec\'s result kind, binding need, risk descriptor and classify fold', () => {
    for (const { spec, resultKind, boundThrough, risk } of migrated) {
      expect(spec.resultKind, spec.id).toBe(resultKind)
      expect(spec.boundThrough, spec.id).toBe(boundThrough)
      expect(spec.risk, spec.id).toEqual(risk)
      expect(typeof spec.classify, spec.id).toBe('function')
      expect(typeof spec.invoke, spec.id).toBe('function')
    }
    // None of the ten discloses; the metadata removal added no disclosure either.
    expect(migrated.filter(({ spec }) => 'disclose' in spec).map(({ spec }) => spec.id)).toEqual([])
  })
})

// ---- C432-DECLARATION-KEYS (432-25, D-10/D-12) --------------------------------------------------
//
// The third group of ten, pinned as 432-23's and 432-24's are. Four of them are writers (the two
// config writers and the two quarantine writes), so the risk descriptor beside the absence is what
// still states that they write; runs.evidence also keeps its declared output representation.
describe('C432-DECLARATION-KEYS: the 432-25 op specs carry no permission metadata', () => {
  const migrated = [
    { spec: configHookAddSpec, resultKind: 'unary', boundThrough: 'configWrite',
      risk: { name: 'fn:config.hook.add', recognized: true, readOnly: false } },
    { spec: knowledgeBundlesListSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.bundles.list', recognized: true, readOnly: true } },
    { spec: configProjectScaffoldSpec, resultKind: 'unary', boundThrough: 'scaffoldContent',
      risk: { name: 'fn:config.project.scaffold', recognized: true, readOnly: false } },
    { spec: editorLiveUrlSpec, resultKind: 'unary', boundThrough: 'liveView',
      risk: { name: 'fn:editor.liveurl', recognized: true, readOnly: true } },
    { spec: runsEvidenceSpec, resultKind: 'unary', boundThrough: 'runDetail',
      risk: { name: 'fn:runs.evidence', recognized: true, readOnly: true } },
    { spec: entitiesGetSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:entities.get', recognized: true, readOnly: true } },
    { spec: runsMarksHistorySpec, resultKind: 'unary', boundThrough: 'feedbackReads',
      risk: { name: 'fn:runs.marks.history', recognized: true, readOnly: true } },
    { spec: quarantineAddSpec, resultKind: 'unary', boundThrough: 'quarantine',
      risk: { name: 'fn:quarantine.add', recognized: true, readOnly: false } },
    { spec: quarantineListSpec, resultKind: 'unary', boundThrough: 'quarantine',
      risk: { name: 'fn:quarantine.list', recognized: true, readOnly: true } },
    { spec: quarantineReleaseSpec, resultKind: 'unary', boundThrough: 'quarantine',
      risk: { name: 'fn:quarantine.release', recognized: true, readOnly: false } },
  ] as const

  it('spells neither retired permission key on any of the ten specs', () => {
    expect(migrated.map(({ spec }) => spec.id)).toEqual([
      'config.hook.add',
      'knowledge.bundles.list',
      'config.project.scaffold',
      'editor.liveurl',
      'runs.evidence',
      'entities.get',
      'runs.marks.history',
      'quarantine.add',
      'quarantine.list',
      'quarantine.release',
    ])
    for (const { spec } of migrated) {
      expect(Object.keys(spec), spec.id).not.toContain('requiredScopes')
      expect(Object.keys(spec), spec.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('keeps each spec\'s result kind, binding need, risk descriptor and classify fold', () => {
    for (const { spec, resultKind, boundThrough, risk } of migrated) {
      expect(spec.resultKind, spec.id).toBe(resultKind)
      expect(spec.boundThrough, spec.id).toBe(boundThrough)
      expect(spec.risk, spec.id).toEqual(risk)
      expect(typeof spec.classify, spec.id).toBe('function')
      expect(typeof spec.invoke, spec.id).toBe('function')
    }
    // None of the ten discloses, and only runs.evidence declares an output representation.
    expect(migrated.filter(({ spec }) => 'disclose' in spec).map(({ spec }) => spec.id)).toEqual([])
    expect(migrated.filter(({ spec }) => 'outputRepresentation' in spec).map(({ spec }) => spec.id))
      .toEqual(['runs.evidence'])
  })
})

// ---- C432-DECLARATION-KEYS (432-27, D-10/D-12) --------------------------------------------------
//
// The last four op specs that still spelled `requiredScopes`, pinned as the earlier groups are.
// config.auth.set is the writer among them: its risk descriptor and its `configWrite` binding are
// what still say it writes. runs.detail and runs.overview keep their `runDetail` binding, which is
// what lists them `unbound` on a host with no projection database.
describe('C432-DECLARATION-KEYS: the 432-27 op specs carry no permission metadata', () => {
  const migrated = [
    { spec: configAuthSetSpec, resultKind: 'unary', boundThrough: 'configWrite',
      risk: { name: 'fn:config.auth.set', recognized: true, readOnly: false } },
    { spec: knowledgeGatesListSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.gates.list', recognized: true, readOnly: true } },
    { spec: runsDetailSpec, resultKind: 'unary', boundThrough: 'runDetail',
      risk: { name: 'fn:runs.detail', recognized: true, readOnly: true } },
    { spec: runsOverviewSpec, resultKind: 'unary', boundThrough: 'runDetail',
      risk: { name: 'fn:runs.overview', recognized: true, readOnly: true } },
  ] as const

  it('spells neither retired permission key on any of the four specs', () => {
    expect(migrated.map(({ spec }) => spec.id)).toEqual([
      'config.auth.set',
      'knowledge.gates.list',
      'runs.detail',
      'runs.overview',
    ])
    for (const { spec } of migrated) {
      expect(Object.keys(spec), spec.id).not.toContain('requiredScopes')
      expect(Object.keys(spec), spec.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('keeps each spec\'s result kind, binding need, risk descriptor and classify fold', () => {
    for (const { spec, resultKind, boundThrough, risk } of migrated) {
      expect(spec.resultKind, spec.id).toBe(resultKind)
      expect(spec.boundThrough, spec.id).toBe(boundThrough)
      expect(spec.risk, spec.id).toEqual(risk)
      expect(typeof spec.classify, spec.id).toBe('function')
      expect(typeof spec.invoke, spec.id).toBe('function')
    }
    // None of the four discloses or declares an output representation.
    expect(migrated.filter(({ spec }) => 'disclose' in spec).map(({ spec }) => spec.id)).toEqual([])
    expect(migrated.filter(({ spec }) => 'outputRepresentation' in spec).map(({ spec }) => spec.id))
      .toEqual([])
  })
})

// ---- C432-ALL-OPS-AVAILABLE (432-27, D-12) ------------------------------------------------------
//
// Unlike the cells above, these go through a real registry and `invokeFunction`, because the claim
// is about who may call. `knowledge.gates.list` once required `read` and `config.auth.set`
// `config-write`. Retried from three callers that differ in surface and origin and carry no scope,
// both are served every time: each port is reached once per attempt with what the caller sent,
// every caller gets the same answer, and no audit row is written. config.auth.set's reference law
// still refuses a value that is not a name, for every caller alike, before the writer is reached.
describe('C432-ALL-OPS-AVAILABLE: the 432-27 gate read and auth writer serve every caller', () => {
  it('C432-ALL-OPS-AVAILABLE: a retried knowledge.gates.list and config.auth.set are served alike to every caller', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const configFile = 'agent-qa.config.yaml'
    const committed = 'registry:\n  targets:\n    shop:\n      platform: web\n'
    const found: KnowledgeGatesListResult = {
      kind: 'found', recordId: 'rec-1', product: 'shop', recordKind: 'fact', status: 'candidate',
      strongestPromotionPath: 'deterministic-verdict-floor',
      lines: [stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion',
        candidateId: 'rec-1', promotionPath: 'deterministic-verdict-floor',
        citedReceiptDigests: [], producedAtOrdinal: 43, producedBy: { opId: 'promote' } })],
      standing: [], live: { verdict: 'promote', promotionPath: 'deterministic-verdict-floor',
        citedReceiptDigests: [] },
    }
    const candidates: string[] = []
    const fieldsSet: { path: string; value: unknown }[] = []
    const written: (readonly ConfigChange[])[] = []
    let validations = 0
    const configPorts = {
      configFiles: {
        read: () => Promise.resolve({
          configFile, hooksFile: 'agent-qa.hooks.yaml',
          files: [{ path: configFile, bytes: encoder.encode(committed) }],
        }),
        inspect: ({ paths }: { paths: readonly string[] }) => Promise.resolve(paths.map((path) =>
          path.startsWith('registry.targets')
            ? { path, present: true, kind: 'map', keys: ['shop'] }
            : { path, present: false })),
        setField: (
          { bytes, path, value }: { bytes?: Uint8Array; path: string; value: unknown },
        ) => {
          fieldsSet.push({ path, value })
          const before = bytes === undefined ? '' : decoder.decode(bytes)
          const after = `${before}plugins:\n  auth: ${JSON.stringify(value)}\n`
          return Promise.resolve({ bytes: encoder.encode(after) })
        },
        mintHookId: () => 'h_unused',
      },
      configValidate: {
        validate: () => {
          validations += 1
          return Promise.resolve({ ok: true as const })
        },
      },
      configWrite: {
        applyFields: ({ changes }: { changes: readonly ConfigChange[] }) => {
          written.push(changes)
          return Promise.resolve({ kind: 'applied' as const, file: configFile,
            revision: 'revision-after', baseRevision: 'revision-before' })
        },
        publishFiles: () =>
          Promise.reject(new Error('config.auth.set publishes field changes only')),
      },
    } as unknown as Partial<FunctionDeps>
    const registry = createFunctionRegistry({
      deps: fakeDeps({
        knowledge: fakeKnowledge({
          gateReceipts: ({ candidateId }) => {
            candidates.push(candidateId)
            return Promise.resolve(candidateId === 'rec-1'
              ? found
              : { kind: 'not-found', recordId: candidateId })
          },
        }),
        ...configPorts,
      }),
    })
    const callers: readonly FunctionCaller[] = [
      { surface: 'test', origin: 'agent' },
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]

    const answers: unknown[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        answers.push(await invokeFunction(registry, 'knowledge.gates.list',
          { recordId: 'rec-1' }, caller))
        answers.push(await invokeFunction(registry, 'knowledge.gates.list',
          { recordId: 'rec-9' }, caller))
        // 2026-10-02 (quick 261002-ctr): the reference is a plugin package (`authStateName` is gone).
        answers.push(await invokeFunction(registry, 'config.auth.set',
          { target: 'shop', pluginPackage: '@acme/auth' }, caller))
        answers.push(await invokeFunction(registry, 'config.auth.set',
          { target: 'shop', pluginPackage: 'not a name; rm -rf' }, caller))
      }
    }

    expect(candidates).toEqual(Array.from({ length: 6 }, () => ['rec-1', 'rec-9']).flat())
    expect(answers).toEqual(Array.from({ length: 6 }, () => answers.slice(0, 4)).flat())
    expect(answers[0]).toEqual(found)
    expect(answers[1]).toEqual({ kind: 'not-found', recordId: 'rec-9' })
    const applied = answers[2] as ConfigChangeOutput
    expect(applied).toMatchObject({
      outcome: 'applied', files: [configFile], fields: ['plugins.auth.0.package'],
    })
    expect(answers[3]).toMatchObject({ outcome: 'refused', reason: 'refs-only' })
    // Only the named reference reaches construction, validation and the writer, once per attempt.
    expect(fieldsSet).toEqual(Array.from({ length: 6 }, () =>
      ({ path: 'plugins.auth', value: [{ package: '@acme/auth' }] })))
    expect(validations).toBe(6)
    expect(written).toEqual(Array.from({ length: 6 }, () =>
      [{ op: 'append', path: ['plugins', 'auth'], value: { package: '@acme/auth' } }]))
  })
})
