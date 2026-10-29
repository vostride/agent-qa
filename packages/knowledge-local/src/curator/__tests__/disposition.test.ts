import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  DELTA_ORIGINS,
  asEvidenceToken,
  asRecordId,
  type Anchor,
  type CompareAndSet,
  type Delta,
  type DeltaOrigin,
  type ExecutionContext,
  type MeasurementBaseline,
  type MeasurementObservation,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CITED_ID_INTEGRITY_CONDITIONS,
  appendMeasurementObservation,
  appendOutcomeEvent,
  authoredCheckpointSchema,
  deriveBundleTrust,
  disposeDelta,
  loadBundle,
  parseAuthoredCheckpoint,
  resolveDispositionProfile,
  sliceAuthoredCheckpoint,
  writeMeasurementBaseline,
  type AuthoredDeltaCheckpoint,
  type AuthorOutcome,
  type CitedIdIntegrityCondition,
  type CurationJobView,
  type CuratorAuthor,
  type NeighborRecord,
} from '../../index.js'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'

const scope = { tier: 'product', key: 'storefront' } as const
const citedRecordId = asRecordId('fact-checkout-button')
const precondition = {
  recordId: citedRecordId,
  observedStatus: 'active',
  observedOrdinal: 41,
}

const authoredCheckpoint = {
  schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  deltas: [{
    kind: 'Confirm',
    origin: 'agent',
    scope,
    citedIds: [citedRecordId],
    precondition: [precondition],
    targetId: citedRecordId,
    evidenceToken: asEvidenceToken('evidence-checkout-button'),
  }],
  neighborIds: [citedRecordId],
  preconditions: [precondition],
  authorship: {
    path: 'llm',
    model: { id: 'curator-model', family: 'test-family' },
    executionContext: 'local-interactive',
  },
} as const

let root: string
let knowledgeRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-disposition-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// Uses the structural schema, not the drain's origin admission, as production disposal callers do.
function checkpoint(
  delta: Delta,
  neighborIds: RecordId[],
  preconditions: CompareAndSet[],
): AuthoredDeltaCheckpoint {
  const parsed = authoredCheckpointSchema.parse({
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    deltas: [delta],
    neighborIds,
    preconditions,
    authorship: {
      path: 'llm',
      model: { id: 'curator-model' },
      executionContext: 'local-interactive',
    },
  })
  return sliceAuthoredCheckpoint(parsed)[0]!
}

function publishActive(
  anchors: Anchor[],
  createdAtOrdinal = 40,
  recordScope: ScopeKey = scope,
): { id: RecordId; dir: string } {
  const draft = makeBundleDraftFixture({ anchors, scope: recordScope })
  const published = publishBundle(
    {
      knowledgeRoot,
      productKey: 'storefront',
    },
    {
      draft,
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal,
      screenStates: [],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'promoted',
          evidenceToken: `promoted-${createdAtOrdinal}`,
          curationJobId: `publish-${createdAtOrdinal}`,
          buildOrdinal: createdAtOrdinal,
        }),
      ],
      relations: [],
      provenance: { mode: 'standalone', sourceDescription: 'disposition fixture' },
      artifacts: [],
    },
  )
  if (published.kind !== 'published') throw new Error(`expected publish, got ${published.kind}`)
  return { id: published.id, dir: published.dir }
}

function observed(recordId: RecordId, ordinal = 40, status = 'active'): CompareAndSet {
  return { recordId, observedStatus: status, observedOrdinal: ordinal }
}

function supersedeDelta(
  victimId: RecordId,
  anchors: Anchor[],
  precondition: CompareAndSet,
): Extract<Delta, { kind: 'Supersede' }> {
  return {
    kind: 'Supersede',
    origin: 'agent',
    scope,
    citedIds: [victimId],
    precondition: [precondition],
    victimId,
    newBundle: makeBundleDraftFixture({ anchors, scope }),
    evidenceToken: asEvidenceToken(`supersede-${victimId}`),
  }
}

function candidate(anchors: Anchor[], buildOrdinal = 41, candidateScope: ScopeKey = scope) {
  return {
    anchors,
    buildOrdinal,
    scope: candidateScope,
    curationJobId: 'candidate-job',
  }
}

function drainState(): { supersedesSeenByAnchorKey: Map<string, number> } {
  return { supersedesSeenByAnchorKey: new Map() }
}

const measurementAnchors: Anchor[] = [
  { t: 'flow', name: 'measurement:reported-value' },
  { t: 'platform', platform: 'web' },
]

function measurementObservation(value: number, buildOrdinal: number): MeasurementObservation {
  return {
    value,
    buildOrdinal,
    evidenceToken: `measurement-${buildOrdinal}`,
    curationJobId: `measurement-job-${buildOrdinal}`,
  }
}

function publishMeasurement(
  baseline: MeasurementBaseline,
  observations: readonly MeasurementObservation[],
): { id: RecordId; dir: string } {
  const draft = makeBundleDraftFixture({
    subtype: 'measurement',
    anchors: measurementAnchors,
    scope,
    summary: 'reported-value measured as 100',
    body: 'Verified reported-value value: 100.',
  })
  const published = publishBundle(
    {
      knowledgeRoot,
      productKey: 'storefront',
    },
    {
      draft,
      discriminant: makeDiscriminantFixture('fact', 'measurement'),
      originClass: 'agent-verified',
      createdAtOrdinal: baseline.openedAtOrdinal,
      screenStates: [],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'promoted',
          evidenceToken: `promoted-${baseline.openedAtOrdinal}`,
          curationJobId: `publish-${baseline.openedAtOrdinal}`,
          buildOrdinal: baseline.openedAtOrdinal,
        }),
      ],
      relations: [],
      provenance: { mode: 'standalone', sourceDescription: 'measurement fixture' },
      artifacts: [],
    },
  )
  if (published.kind !== 'published') throw new Error(`expected publish, got ${published.kind}`)

  const config = {
    knowledgeRoot,
    productKey: 'storefront',
  }
  expect(writeMeasurementBaseline(config, published.id, baseline).kind).toBe('appended')
  for (const observation of observations) {
    expect(appendMeasurementObservation(config, published.id, observation).kind).toBe('appended')
  }
  return { id: published.id, dir: published.dir }
}

function measurementSupersede(
  victimId: RecordId,
  value: string,
): Extract<Delta, { kind: 'Supersede' }> {
  return {
    kind: 'Supersede',
    origin: 'agent',
    scope,
    citedIds: [victimId],
    precondition: [observed(victimId)],
    victimId,
    newBundle: makeBundleDraftFixture({
      subtype: 'measurement',
      anchors: measurementAnchors,
      scope,
      summary: `reported-value measured as ${value}`,
      body: `Verified reported-value value: ${value}.`,
    }),
    evidenceToken: asEvidenceToken(`supersede-${victimId}-${value}`),
  }
}

function measurementCandidate(value: string, buildOrdinal: number) {
  return {
    ...candidate(measurementAnchors, buildOrdinal),
    measurementValue: value,
  }
}

describe('Curator author contract', () => {
  it('round-trips a structurally valid authored checkpoint with resolved ids', () => {
    expect(authoredCheckpointSchema.parse(authoredCheckpoint)).toEqual(authoredCheckpoint)
    expect(parseAuthoredCheckpoint(authoredCheckpoint)).toEqual(authoredCheckpoint)
  })

  it('leaves persisted-neighbor membership to disposition check 1', () => {
    const absentFromNeighborSet = {
      ...authoredCheckpoint,
      neighborIds: [asRecordId('different-neighbor')],
    }

    expect(() => authoredCheckpointSchema.parse(absentFromNeighborSet)).not.toThrow()
  })

  it('maps all four execution contexts to their authority mode', () => {
    for (const executionContext of ['local-interactive', 'local-headless'] as const) {
      expect(resolveDispositionProfile(executionContext)).toEqual({ mode: 'drain-to-active' })
    }
    for (const executionContext of ['ci', 'cloud'] as const) {
      expect(resolveDispositionProfile(executionContext)).toEqual({ mode: 'propose-only' })
    }
  })

  it('types the injected author seam and its complete outcome union', () => {
    expectTypeOf<CuratorAuthor>().toEqualTypeOf<
      (job: CurationJobView, neighbors: NeighborRecord[]) => Promise<AuthorOutcome>
    >()

    const parsedCheckpoint = parseAuthoredCheckpoint(authoredCheckpoint)
    const authored: AuthorOutcome = {
      kind: 'authored',
      deltas: parsedCheckpoint.deltas,
      authorship: parsedCheckpoint.authorship,
    }
    const fallbackReasons: Record<
      Extract<AuthorOutcome, { kind: 'fallback-required' }>['reason'],
      true
    > = {
      malformed: true,
      'no-model': true,
      'token-budget': true,
      'model-error': true,
    }

    expect(authored.kind).toBe('authored')
    expect(Object.keys(fallbackReasons).sort()).toEqual([
      'malformed',
      'model-error',
      'no-model',
      'token-budget',
    ])
  })
})

describe('disposeDelta deterministic authority', () => {
  const primary: Anchor = { t: 'el', role: 'button', name: 'Sign in' }
  const page: Anchor = { t: 'page', route: '/login' }

  it('runs cited-id integrity against both the persisted neighbor set and bundle tree', () => {
    const victim = publishActive([primary, page])
    const precondition = observed(victim.id)
    const delta: Delta = {
      kind: 'Confirm',
      origin: 'agent',
      scope,
      citedIds: [victim.id],
      precondition: [precondition],
      targetId: victim.id,
      evidenceToken: asEvidenceToken('confirm-victim'),
    }

    const neverRetrieved = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [], [precondition]),
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })
    expect(neverRetrieved).toMatchObject({
      kind: 'downgraded',
      reason: 'cited-id-integrity',
      original: delta,
    })

    rmSync(victim.dir, { recursive: true, force: true })
    const missingFromDisk = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [victim.id], [precondition]),
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })
    expect(missingFromDisk).toMatchObject({
      kind: 'downgraded',
      reason: 'cited-id-integrity',
      original: delta,
    })
  })

  it('checks candidate anchor evidence and permits only the deterministic rename bridge', () => {
    const contradictoryAnchors = [{ t: 'el', role: 'button', name: 'Checkout' }, page] as Anchor[]
    const add: Delta = {
      kind: 'Add',
      origin: 'agent',
      scope,
      citedIds: [],
      bundle: makeBundleDraftFixture({ anchors: contradictoryAnchors, scope }),
    }
    expect(
      disposeDelta({
        delta: add,
        checkpoint: checkpoint(add, [], []),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      }),
    ).toMatchObject({ kind: 'downgraded', reason: 'anchor-consistency', original: add })

    const ordinaryVictim = publishActive([primary, page])
    const ordinaryPrecondition = observed(ordinaryVictim.id)
    const unrelatedAnchors = [{ t: 'el', role: 'link', name: 'Help' }, page] as Anchor[]
    const unrelated = supersedeDelta(
      ordinaryVictim.id,
      unrelatedAnchors,
      ordinaryPrecondition,
    )
    expect(
      disposeDelta({
        delta: unrelated,
        checkpoint: checkpoint(unrelated, [ordinaryVictim.id], [ordinaryPrecondition]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate(unrelatedAnchors),
        drainState: drainState(),
      }),
    ).toMatchObject({
      kind: 'downgraded',
      reason: 'anchor-consistency',
      original: unrelated,
    })

    rmSync(ordinaryVictim.dir, { recursive: true, force: true })
    const selector: Anchor = { t: 'selector', literal: '[data-action="sign-in"]' }
    const renamedVictim = publishActive([primary, page, selector])
    const renamedPrecondition = observed(renamedVictim.id)
    const renamedAnchors = [
      { t: 'el', role: 'button', name: 'Log in' },
      page,
      selector,
    ] as Anchor[]
    const renamed = supersedeDelta(renamedVictim.id, renamedAnchors, renamedPrecondition)
    expect(
      disposeDelta({
        delta: renamed,
        checkpoint: checkpoint(renamed, [renamedVictim.id], [renamedPrecondition]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate(renamedAnchors),
        drainState: drainState(),
      }),
    ).toMatchObject({
      kind: 'apply',
      delta: renamed,
      relationIntents: [{ type: 'renamed-from', targetId: renamedVictim.id }],
    })
  })

  it('preserves rename lineage when propose-only downgrades Supersede to Add', () => {
    const originalAnchors = [
      primary,
      page,
      { t: 'selector', literal: '[data-action="sign-in"]' },
    ] as Anchor[]
    const victim = publishActive(originalAnchors)
    const victimPrecondition = observed(victim.id)
    const renamedAnchors = [
      { t: 'el', role: 'button', name: 'Log in' },
      page,
      originalAnchors[2]!,
    ] as Anchor[]
    const delta = supersedeDelta(victim.id, renamedAnchors, victimPrecondition)

    const proposed = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [victim.id], [victimPrecondition]),
      profile: { mode: 'propose-only' },
      knowledgeRoot,
      candidate: candidate(renamedAnchors),
      drainState: drainState(),
    })

    expect(proposed).toMatchObject({
      kind: 'downgraded',
      reason: 'propose-only',
      original: delta,
      delta: { kind: 'Add', bundle: delta.newBundle },
    })
    expect(proposed).toHaveProperty('relationIntents', [
      { type: 'proposed-supersession-of', targetId: victim.id },
      { type: 'renamed-from', targetId: victim.id },
    ])
  })

  it('requires the shared supersession key and a strictly greater candidate ordinal', () => {
    const victim = publishActive([primary, page])
    const precondition = observed(victim.id)
    const differentSecondary = [primary, { t: 'page', route: '/account' }] as Anchor[]
    const wrongKey = supersedeDelta(victim.id, differentSecondary, precondition)
    expect(
      disposeDelta({
        delta: wrongKey,
        checkpoint: checkpoint(wrongKey, [victim.id], [precondition]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate(differentSecondary),
        drainState: drainState(),
      }),
    ).toMatchObject({ kind: 'downgraded', reason: 'supersession-key' })

    const sameKey = supersedeDelta(victim.id, [primary, page], precondition)
    for (const newOrdinal of [40, 39]) {
      expect(
        disposeDelta({
          delta: sameKey,
          checkpoint: checkpoint(sameKey, [victim.id], [precondition]),
          profile: { mode: 'drain-to-active' },
          knowledgeRoot,
          candidate: candidate([primary, page], newOrdinal),
          drainState: drainState(),
        }),
      ).toMatchObject({ kind: 'downgraded', reason: 'supersession-key' })
    }
  })

  it('rejects an agent-origin Deprecate of active bundle truth', () => {
    const victim = publishActive([primary, page])
    const precondition = observed(victim.id)
    const delta: Delta = {
      kind: 'Deprecate',
      origin: 'agent',
      scope,
      citedIds: [victim.id],
      precondition: [precondition],
      targetId: victim.id,
      reason: 'model nominated removal',
    }

    expect(
      disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victim.id], [precondition]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      }),
    ).toMatchObject({ kind: 'downgraded', reason: 'autonomous-deprecate', original: delta })
  })

  it('requeues CAS movement from bundle truth even when a stale index fixture agrees', () => {
    const victim = publishActive([primary, page])
    const staleObservation = observed(victim.id, 40, 'candidate')
    const delta: Delta = {
      kind: 'Confirm',
      origin: 'agent',
      scope,
      citedIds: [victim.id],
      precondition: [staleObservation],
      targetId: victim.id,
      evidenceToken: asEvidenceToken('stale-index-confirm'),
    }
    const indexFixtureDir = join(knowledgeRoot, 'memory', 'index')
    mkdirSync(indexFixtureDir, { recursive: true })
    writeFileSync(
      join(indexFixtureDir, 'stale-index-truth.json'),
      JSON.stringify({ id: victim.id, status: 'candidate', ordinal: 40 }),
    )

    expect(
      disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victim.id], [staleObservation]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      }),
    ).toEqual({ kind: 'requeue-resynthesis', reason: 'compare-and-set' })
  })

  it('caps one Supersede per anchor per drain and confines candidate scope', () => {
    const victim = publishActive([primary, page])
    const precondition = observed(victim.id)
    const delta = supersedeDelta(victim.id, [primary, page], precondition)
    const sharedDrain = drainState()
    const input = {
      delta,
      checkpoint: checkpoint(delta, [victim.id], [precondition]),
      profile: { mode: 'drain-to-active' } as const,
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: sharedDrain,
    }

    expect(disposeDelta(input)).toMatchObject({ kind: 'apply', delta })
    expect(disposeDelta(input)).toMatchObject({
      kind: 'downgraded',
      reason: 'blast-radius-cap',
      original: delta,
      delta: { kind: 'MintUnknown', conflict: { kind: 'drift' } },
    })

    expect(
      disposeDelta({
        ...input,
        candidate: candidate(
          [primary, page],
          41,
          { tier: 'product', key: 'different-storefront' },
        ),
        drainState: drainState(),
      }),
    ).toMatchObject({ kind: 'downgraded', reason: 'blast-radius-scope' })
  })

  it('turns propose-only Supersede into a candidate plus relation intent', () => {
    const victim = publishActive([primary, page])
    const precondition = observed(victim.id)
    const delta = supersedeDelta(victim.id, [primary, page], precondition)

    const proposed = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [victim.id], [precondition]),
      profile: { mode: 'propose-only' },
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })
    expect(proposed).toMatchObject({
      kind: 'downgraded',
      reason: 'propose-only',
      original: delta,
      delta: { kind: 'Add', bundle: delta.newBundle },
    })
    expect(proposed).toHaveProperty('relationIntents', [
      { type: 'proposed-supersession-of', targetId: victim.id },
    ])

    const loadedVictim = loadBundle(victim.dir)
    expect(loadedVictim.kind).toBe('loaded')
    if (loadedVictim.kind !== 'loaded') throw new Error('expected loaded victim')
    expect(deriveBundleTrust(loadedVictim.bundle).status).toBe('active')

    expect(
      disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victim.id], [precondition]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      }),
    ).toMatchObject({ kind: 'apply', delta })
  })

  it('records every downgrade reason and original delta instead of dropping it', () => {
    const delta: Delta = {
      kind: 'Add',
      origin: 'agent',
      scope,
      citedIds: [],
      bundle: makeBundleDraftFixture({
        anchors: [{ t: 'el', role: 'link', name: 'Unverified' }, page],
        scope,
      }),
    }
    const outcome = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [], []),
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })

    expect(outcome).toMatchObject({
      kind: 'downgraded',
      reason: expect.any(String),
      original: delta,
      delta: expect.objectContaining({ kind: expect.any(String) }),
    })
  })
})

describe('automatic curation disposition by execution context', () => {
  const primary: Anchor = { t: 'el', role: 'button', name: 'Place order' }
  const page: Anchor = { t: 'page', route: '/checkout' }
  const LOCAL_CONTEXTS = ['local-interactive', 'local-headless'] as const
  const REMOTE_CONTEXTS = ['ci', 'cloud'] as const
  const ALL_CONTEXTS = [...LOCAL_CONTEXTS, ...REMOTE_CONTEXTS] as const

  function publishCandidate(anchors: Anchor[], createdAtOrdinal = 40): { id: RecordId } {
    const published = publishBundle(
      {
        knowledgeRoot,
        productKey: 'storefront',
      },
      {
        draft: makeBundleDraftFixture({ anchors, scope }),
        discriminant: makeDiscriminantFixture(),
        originClass: 'agent-verified',
        createdAtOrdinal,
        screenStates: [],
        initialEvents: [],
        relations: [],
        provenance: { mode: 'standalone', sourceDescription: 'context matrix candidate' },
        artifacts: [],
      },
    )
    if (published.kind !== 'published') throw new Error(`expected publish, got ${published.kind}`)
    return { id: published.id }
  }

  function disposeIn(
    executionContext: ExecutionContext,
    delta: Delta,
    neighborIds: RecordId[],
    preconditions: CompareAndSet[],
  ) {
    const parsed = authoredCheckpointSchema.parse({
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      deltas: [delta],
      neighborIds,
      preconditions,
      authorship: { path: 'llm', model: { id: 'curator-model' }, executionContext },
    })
    const sliced = sliceAuthoredCheckpoint(parsed)[0]!
    const outcome = disposeDelta({
      delta,
      checkpoint: sliced,
      profile: resolveDispositionProfile(executionContext),
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })
    expect(sliced.authorship.executionContext, 'disposition never rewrites the run context')
      .toBe(executionContext)
    return outcome
  }

  function agentDeprecate(targetId: RecordId, status: string): Extract<Delta, { kind: 'Deprecate' }> {
    return {
      kind: 'Deprecate',
      origin: 'agent',
      scope,
      citedIds: [targetId],
      precondition: [observed(targetId, 40, status)],
      targetId,
      reason: 'newer evidence contradicts this record',
    }
  }

  function statusOf(dir: string): string {
    const loaded = loadBundle(dir)
    if (loaded.kind !== 'loaded') throw new Error('expected loaded record')
    return deriveBundleTrust(loaded.bundle).status
  }

  it.each(LOCAL_CONTEXTS)('%s automatic curation applies Supersede and Deprecate directly', (context) => {
    // Both local contexts are the same arm; local-headless is the background worker.
    const { id: victimId } = publishActive([primary, page])
    const supersede = supersedeDelta(victimId, [primary, page], observed(victimId))
    expect(disposeIn(context, supersede, [victimId], [observed(victimId)]))
      .toMatchObject({ kind: 'apply', delta: supersede })

    const target = publishCandidate([{ t: 'el', role: 'link', name: 'Stale help' }, page])
    const deprecate = agentDeprecate(target.id, 'candidate')
    expect(disposeIn(context, deprecate, [target.id], deprecate.precondition!))
      .toMatchObject({ kind: 'apply', delta: deprecate })
  })

  it('automatic ci and cloud curation keeps Supersede and Deprecate proposed', () => {
    for (const context of REMOTE_CONTEXTS) {
      knowledgeRoot = join(root, `agent-qa-knowledge-${context}`)
      const { id: victimId, dir: victimDir } = publishActive([primary, page])
      const supersede = supersedeDelta(victimId, [primary, page], observed(victimId))
      const proposed = disposeIn(context, supersede, [victimId], [observed(victimId)])
      expect(proposed, `${context} Supersede must stay a proposed candidate`).toMatchObject({
        kind: 'downgraded',
        reason: 'propose-only',
        original: supersede,
        delta: { kind: 'Add', bundle: supersede.newBundle },
      })
      expect(proposed).toHaveProperty('relationIntents', [
        { type: 'proposed-supersession-of', targetId: victimId },
      ])
      expect(statusOf(victimDir)).toBe('active')

      const target = publishCandidate([{ t: 'el', role: 'link', name: `Stale ${context}` }, page])
      const deprecate = agentDeprecate(target.id, 'candidate')
      expect(
        disposeIn(context, deprecate, [target.id], deprecate.precondition!),
        `${context} Deprecate must stay a clarification unknown`,
      ).toMatchObject({
        kind: 'downgraded',
        reason: 'propose-only',
        original: deprecate,
        delta: { kind: 'MintUnknown', conflict: { kind: 'clarification' } },
      })
    }
  })

  it.each(ALL_CONTEXTS)('%s keeps existing validation for invalid automatic deltas', (context) => {
    const { id: victimId, dir: victimDir } = publishActive([primary, page])
    const activeDeprecate = agentDeprecate(victimId, 'active')
    expect(disposeIn(context, activeDeprecate, [victimId], activeDeprecate.precondition!))
      .toMatchObject({ kind: 'downgraded', reason: 'autonomous-deprecate', original: activeDeprecate })

    const stale = observed(victimId, 39)
    const staleSupersede = supersedeDelta(victimId, [primary, page], stale)
    expect(disposeIn(context, staleSupersede, [victimId], [stale]))
      .toEqual({ kind: 'requeue-resynthesis', reason: 'compare-and-set' })

    const uncited = supersedeDelta(victimId, [primary, page], observed(victimId))
    expect(disposeIn(context, uncited, [], [observed(victimId)]))
      .toMatchObject({ kind: 'downgraded', reason: 'cited-id-integrity', original: uncited })
    expect(statusOf(victimDir)).toBe('active')
  })
})

describe('disposeDelta measurement mechanism', () => {
  const baseline: MeasurementBaseline = {
    mu0: 100,
    sigma0: 1,
    n0: 5,
    openedAtOrdinal: 40,
  }

  function disposeMeasurementSupersede(
    victimId: RecordId,
    value: string,
    buildOrdinal: number,
    mode: 'drain-to-active' | 'propose-only' = 'drain-to-active',
  ) {
    const delta = measurementSupersede(victimId, value)
    const precondition = observed(victimId)
    return {
      delta,
      outcome: disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victimId], [precondition]),
        profile: { mode },
        knowledgeRoot,
        candidate: measurementCandidate(value, buildOrdinal),
        drainState: drainState(),
      }),
    }
  }

  it('widens a below-minimum measurement Supersede into Confirm plus append intent', () => {
    const victim = publishMeasurement(baseline, [
      measurementObservation(101, 41),
      measurementObservation(99, 42),
    ])
    const { delta, outcome } = disposeMeasurementSupersede(victim.id, '100', 43)

    expect(outcome).toMatchObject({
      kind: 'apply',
      delta: {
        kind: 'Confirm',
        targetId: victim.id,
        evidenceToken: delta.evidenceToken,
      },
      measurementAppend: {
        victimId: victim.id,
        observation: {
          value: 100,
          buildOrdinal: 43,
          evidenceToken: delta.evidenceToken,
          curationJobId: 'candidate-job',
        },
      },
    })
    expect(outcome).not.toHaveProperty('bornActive')
  })

  it('arms bornActive for confirmed drift only in drain-to-active', () => {
    const victim = publishMeasurement(baseline, [
      measurementObservation(200, 41),
      measurementObservation(201, 42),
      measurementObservation(202, 43),
      measurementObservation(203, 44),
    ])
    const { delta, outcome } = disposeMeasurementSupersede(victim.id, '204', 45)

    expect(outcome).toMatchObject({ kind: 'apply', delta, bornActive: true })
    expect(outcome).not.toHaveProperty('measurementAppend')
  })

  it('keeps the same confirmed drift candidate-only under propose-only', () => {
    const victim = publishMeasurement(baseline, [
      measurementObservation(200, 41),
      measurementObservation(201, 42),
      measurementObservation(202, 43),
      measurementObservation(203, 44),
    ])
    const { delta, outcome } = disposeMeasurementSupersede(
      victim.id,
      '204',
      45,
      'propose-only',
    )

    expect(outcome).toMatchObject({
      kind: 'downgraded',
      reason: 'propose-only',
      original: delta,
      delta: { kind: 'Add', bundle: delta.newBundle },
      relationIntents: [
        { type: 'proposed-supersession-of', targetId: victim.id },
      ],
    })
    expect(outcome).not.toHaveProperty('bornActive')
  })

  it('widens an oscillating two-band measurement instead of superseding it', () => {
    const bimodalBaseline: MeasurementBaseline = {
      mu0: 10,
      sigma0: 1,
      n0: 5,
      openedAtOrdinal: 40,
    }
    const victim = publishMeasurement(bimodalBaseline, [
      measurementObservation(10, 41),
      measurementObservation(100, 42),
      measurementObservation(11, 43),
      measurementObservation(101, 44),
      measurementObservation(12, 45),
    ])
    const { outcome } = disposeMeasurementSupersede(victim.id, '102', 46)

    expect(outcome).toMatchObject({
      kind: 'apply',
      delta: { kind: 'Confirm', targetId: victim.id },
      measurementAppend: {
        victimId: victim.id,
        observation: { value: 102, buildOrdinal: 46 },
      },
    })
    expect(outcome).not.toHaveProperty('bornActive')
  })

  it('bypasses numeric drift for non-numeric measurement values', () => {
    const victim = publishMeasurement(baseline, [
      measurementObservation(200, 41),
      measurementObservation(201, 42),
      measurementObservation(202, 43),
      measurementObservation(203, 44),
    ])
    const { delta, outcome } = disposeMeasurementSupersede(victim.id, 'not-a-number', 45)

    expect(outcome).toMatchObject({ kind: 'apply', delta })
    expect(outcome).not.toHaveProperty('measurementAppend')
    expect(outcome).not.toHaveProperty('bornActive')
  })

  it('routes a measurement Confirm through the same append discipline', () => {
    const victim = publishMeasurement(baseline, [
      measurementObservation(101, 41),
      measurementObservation(99, 42),
    ])
    const precondition = observed(victim.id)
    const delta: Delta = {
      kind: 'Confirm',
      origin: 'agent',
      scope,
      citedIds: [victim.id],
      precondition: [precondition],
      targetId: victim.id,
      evidenceToken: asEvidenceToken('confirm-measurement-100'),
    }

    const outcome = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [victim.id], [precondition]),
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: measurementCandidate('100', 43),
      drainState: drainState(),
    })

    expect(outcome).toMatchObject({
      kind: 'apply',
      delta,
      measurementAppend: {
        victimId: victim.id,
        observation: {
          value: 100,
          buildOrdinal: 43,
          evidenceToken: delta.evidenceToken,
          curationJobId: 'candidate-job',
        },
      },
    })
  })
})

// A person's delta with a broken citation is refused, never minted into new content as theirs.
describe('cited-id integrity: the fallback is total over DeltaOrigin', () => {
  const primary: Anchor = { t: 'el', role: 'button', name: 'Sign in' }
  const page: Anchor = { t: 'page', route: '/login' }

  type CitedIdIntegrityOutcome = 'refuses' | 'downgrades-to-mint-unknown'

  const EXPECTED_OUTCOME_BY_ORIGIN = {
    agent: 'downgrades-to-mint-unknown',
    user: 'refuses',
    import: 'downgrades-to-mint-unknown',
    system: 'downgrades-to-mint-unknown',
  } satisfies Record<DeltaOrigin, CitedIdIntegrityOutcome>

  /**
   * The ways `checkCitedIdIntegrity` can fail — COUNTED BY THE REGISTRY, not by this comment.
   *
   * The previous version of this block said "the THREE ways", and it was wrong when it was
   * written: the check's second return is a three-way disjunction (`truth === undefined ||
   * status === 'deprecated' || !sameScope(…)`), so there were always four. Round 2's verifier
   * proved the omission by mutation — carving `scope-mismatch` out of the refusal for EVERY
   * origin left 3 files / 70 tests green, because no row in this corpus ever reached it.
   *
   * So the walk is driven by a registry rather than by a list somebody keeps in step. A fifth
   * condition added to the union reds this walk by EXISTING: the fixture table below is
   * `satisfies Record<CitedIdIntegrityCondition, …>`, so a member with no fixture is a compile
   * error, and a fixture naming no member is the same.
   *
   * Scoping the refusal to `status === 'deprecated'` alone would be the same one-axis-out error
   * this phase keeps paying for: the check's failure domain is "this delta cites something this
   * store cannot stand behind", and a vanished record, an unpersisted neighbour or a record
   * addressed at a scope it does not carry is that fact just as much as a tombstoned one.
   */
  const FAILURE_CONDITIONS = CITED_ID_INTEGRITY_CONDITIONS

  function confirmCiting(origin: DeltaOrigin, targetId: RecordId): Delta {
    return {
      kind: 'Confirm',
      origin,
      scope,
      citedIds: [targetId],
      precondition: [observed(targetId)],
      targetId,
      evidenceToken: asEvidenceToken(`confirm-${origin}-${targetId}`),
    }
  }

  function deprecate(recordId: RecordId): void {
    const appended = appendOutcomeEvent(
      {
        knowledgeRoot,
        productKey: 'storefront',
      },
      recordId,
      BundleOutcomeEventSchema.parse({
        type: 'deprecated',
        evidenceToken: `disposition-deprecated-${recordId}`,
        curationJobId: `disposition-deprecated-job-${recordId}`,
        buildOrdinal: 42,
        reason: 'the reviewer removed it',
      }),
    )
    if (appended.kind !== 'appended') throw new Error(`fixture deprecate failed: ${appended.kind}`)
  }

  /** A scope key no fixture bundle is published under, so `sameScope` cannot accidentally hold. */
  const OTHER_SCOPE: ScopeKey = { tier: 'product', key: 'checkout-lane' }

  // `scope-mismatch` fails on a readable record; the other three break availability.
  const CONDITION_FIXTURES = {
    'not-a-persisted-neighbor': () => {
      const victim = publishActive([primary, page])
      return { victim, delta: confirmCiting('agent', victim.id), neighborIds: [] as RecordId[] }
    },
    'missing-from-disk': () => {
      const victim = publishActive([primary, page])
      rmSync(victim.dir, { recursive: true, force: true })
      return { victim, delta: confirmCiting('agent', victim.id), neighborIds: [victim.id] }
    },
    deprecated: () => {
      const victim = publishActive([primary, page])
      deprecate(victim.id)
      return { victim, delta: confirmCiting('agent', victim.id), neighborIds: [victim.id] }
    },
    'scope-mismatch': () => {
      const victim = publishActive([primary, page], 40, OTHER_SCOPE)
      return { victim, delta: confirmCiting('agent', victim.id), neighborIds: [victim.id] }
    },
  } satisfies Record<CitedIdIntegrityCondition, () => {
    victim: { id: RecordId; dir: string }
    delta: Delta
    neighborIds: RecordId[]
  }>

  for (const origin of DELTA_ORIGINS) {
    const expected = EXPECTED_OUTCOME_BY_ORIGIN[origin]
    for (const condition of FAILURE_CONDITIONS) {
      it(`${origin}-origin Confirm whose cited id is ${condition} → ${expected}`, () => {
        const { victim, neighborIds } = CONDITION_FIXTURES[condition]()
        const delta = confirmCiting(origin, victim.id)

        const dispose = () => disposeDelta({
          delta,
          checkpoint: checkpoint(delta, neighborIds, [observed(victim.id)]),
          profile: { mode: 'drain-to-active' },
          knowledgeRoot,
          candidate: candidate([primary, page]),
          drainState: drainState(),
        })

        if (expected === 'refuses') {
          let thrown: unknown
          expect(
            () => { try { dispose() } catch (error) { thrown = error; throw error } },
            'a user delta must be REFUSED rather than converted into minted content: minting '
              + 'from a human instruction about existing records fabricates authorship',
          ).toThrow()
          expect((thrown as Error).name).toBe('UserDeltaCitationIntegrityError')
          expect((thrown as { recordId?: RecordId }).recordId).toBe(victim.id)
          expect((thrown as { deltaKind?: string }).deltaKind).toBe('Confirm')
          // WHICH condition fired, per row. Asserting merely that the field EXISTS would pass
          // against an error that carried the same token for all four, which is the difference
          // between naming the failure and appearing to.
          expect(
            (thrown as { condition?: string }).condition,
            'the refusal must name the condition it actually failed on',
          ).toBe(condition)
        } else {
          // PRESERVED, and this half is drawn from OUTSIDE the refusal's own assumption: the
          // pipeline's clarification-candidate behaviour is untouched. A mapping that
          // over-broadened into the drain path would red here, not in the user rows.
          const outcome = dispose()
          expect(outcome).toMatchObject({
            kind: 'downgraded',
            reason: 'cited-id-integrity',
            original: delta,
          })
          expect(
            outcome.kind === 'downgraded' ? outcome.delta.kind : undefined,
            'the pipeline fallback is still a MintUnknown clarification candidate',
          ).toBe('MintUnknown')
        }
      })
    }
  }

  // The message names the condition: a scope-mismatched record is readable, not tombstoned.
  it('the refusal message names the record, the delta kind and the failing condition', () => {
    const { victim } = CONDITION_FIXTURES['scope-mismatch']()
    const delta = confirmCiting('user', victim.id)

    let thrown: unknown
    try {
      disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victim.id], [observed(victim.id)]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      })
    } catch (error) { thrown = error }

    const message = (thrown as Error | undefined)?.message ?? ''
    expect(message).toContain(victim.id)
    expect(message).toContain('Confirm')
    expect(message, 'the condition token is what makes the message actionable').toContain(
      'scope-mismatch',
    )
    expect(
      message,
      'the old phrasing claimed a tombstone that a scope-mismatched record does not have',
    ).not.toContain('tombstoned')
  })
})

// Declared apart from `AUTONOMOUS_DEPRECATE_BY_ORIGIN`, so flipping a value reds a row.
describe('the autonomy floor is total over DeltaOrigin', () => {
  const primary: Anchor = { t: 'el', role: 'button', name: 'Sign in' }
  const page: Anchor = { t: 'page', route: '/login' }

  type AutonomyFloorOutcome = 'downgraded' | 'passes-floor'

  // Answers who may tombstone standing knowledge, not who may arrive as drain-authored output.
  const EXPECTED_FLOOR_BY_ORIGIN = {
    agent: 'downgraded',
    import: 'downgraded',
    system: 'passes-floor',
    user: 'passes-floor',
  } satisfies Record<DeltaOrigin, AutonomyFloorOutcome>

  function deprecateOf(origin: DeltaOrigin, targetId: RecordId): Delta {
    return {
      kind: 'Deprecate',
      origin,
      scope,
      citedIds: [targetId],
      precondition: [observed(targetId)],
      targetId,
      reason: `floor-walk-${origin}`,
    }
  }

  for (const origin of DELTA_ORIGINS) {
    const expected = EXPECTED_FLOOR_BY_ORIGIN[origin]
    it(`${origin}-origin Deprecate of an ACTIVE record → ${expected}`, () => {
      const victim = publishActive([primary, page])
      const delta = deprecateOf(origin, victim.id)

      const outcome = disposeDelta({
        delta,
        checkpoint: checkpoint(delta, [victim.id], [observed(victim.id)]),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot,
        candidate: candidate([primary, page]),
        drainState: drainState(),
      })

      if (expected === 'downgraded') {
        expect(
          outcome,
          'a machine-authored Deprecate may not remove standing knowledge on its own authority',
        ).toMatchObject({
          kind: 'downgraded',
          reason: 'autonomous-deprecate',
          original: delta,
        })
      } else {
        // A POSITIVE assertion, not merely "not downgraded by the floor": the review verbs need
        // this delta to reach `apply`, and asserting the whole outcome is what makes an
        // over-broadened table red here instead of quietly changing which arm they land on.
        expect(
          outcome,
          'reject/forget and rollback maintenance depend on this Deprecate passing disposition',
        ).toMatchObject({ kind: 'apply', delta })
      }
    })
  }

  /**
   * The floor's PRECONDITION, drawn from outside the floor's own domain: an already-deprecated
   * target never reaches the origin question at all, because `lookup(targetId)?.status` is not
   * 'active'. The row is `agent` — the origin the floor downgrades hardest — so if the table
   * consult ever lost the active-target gate this case would report it.
   *
   * The outcome is a cited-id-integrity downgrade rather than an apply: `deltaTargetIds` folds a
   * Deprecate's `targetId` into the cited set, and a deprecated cited record is one of
   * `CITED_ID_INTEGRITY_CONDITIONS`. Asserting the exact reason is the point — asserting only
   * `reason !== 'autonomous-deprecate'` would pass against any other downgrade the floor
   * accidentally introduced.
   */
  it('a Deprecate of an ALREADY-DEPRECATED target never reaches the floor (agent origin)', () => {
    const victim = publishActive([primary, page])
    const appended = appendOutcomeEvent(
      {
        knowledgeRoot,
        productKey: 'storefront',
      },
      victim.id,
      BundleOutcomeEventSchema.parse({
        type: 'deprecated',
        evidenceToken: `floor-precondition-${victim.id}`,
        curationJobId: `floor-precondition-job-${victim.id}`,
        buildOrdinal: 42,
        reason: 'the reviewer removed it',
      }),
    )
    if (appended.kind !== 'appended') throw new Error(`fixture deprecate failed: ${appended.kind}`)

    const delta = deprecateOf('agent', victim.id)
    const outcome = disposeDelta({
      delta,
      checkpoint: checkpoint(delta, [victim.id], [observed(victim.id)]),
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: candidate([primary, page]),
      drainState: drainState(),
    })

    expect(
      outcome,
      'the idempotency path is not the autonomy floor\'s business',
    ).toMatchObject({ kind: 'downgraded', reason: 'cited-id-integrity' })
  })
})
