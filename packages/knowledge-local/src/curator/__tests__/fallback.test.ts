import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  deriveEvidenceToken,
  type Anchor,
  type Delta,
  type ExecutionContext,
  type FactSubtype,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import { publishBundle } from '../../bundle-publish.test-helper.js'
import type { PublishBundleInput } from '../../index.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION, parseAuthoredCheckpoint } from '../author-contract.js'
import type { CurationJobView, NeighborRecord } from '../author-contract.js'
import {
  RESTRICTED_FALLBACK_DELTA_KINDS,
  assertRestrictedFallbackDelta,
  constructFallbackDeltas,
} from '../fallback.js'

type FallbackJobFixture = CurationJobView & {
  attributingObservationId: string
  executionContext: ExecutionContext
}

type FallbackNeighborFixture = Extract<NeighborRecord, { kind: 'fact' }>

const primaryAnchor: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const pageAnchor: Anchor = { t: 'page', route: '/checkout' }
const scope = { tier: 'product', key: 'storefront' } as const
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-fallback-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function job(overrides: Partial<FallbackJobFixture> = {}): FallbackJobFixture {
  return {
    candidateId: 'a'.repeat(64),
    kind: 'fact',
    subtype: 'selector',
    anchors: [primaryAnchor, pageAnchor],
    summarySeed: 'Checkout control',
    bodySeed: 'The Checkout button resolves uniquely on the checkout page.',
    distilledObservations: [],
    scope,
    buildOrdinal: 42,
    attributingObservationId: 'run-1:test-0:step-0',
    executionContext: 'local-headless',
    ...overrides,
  }
}

function neighbor(
  overrides: Partial<FallbackNeighborFixture> = {},
): FallbackNeighborFixture {
  return {
    alias: 1,
    recordId: asRecordId('fact-checkout-control'),
    kind: 'fact',
    subtype: 'selector',
    summary: 'Existing checkout control',
    anchors: [primaryAnchor, pageAnchor],
    observedStatus: 'active',
    observedOrdinal: 41,
    ...overrides,
  }
}

function onlyDelta(jobView: FallbackJobFixture, neighbors: FallbackNeighborFixture[] = []): Delta {
  const deltas = constructFallbackDeltas(jobView, neighbors, 'no-model')
  expect(deltas).toHaveLength(1)
  return deltas[0]!
}

describe('constructFallbackDeltas restricted BYOM projection', () => {
  it('types the fallback-only job and neighbor facts at the author boundary', () => {
    expectTypeOf<CurationJobView['attributingObservationId']>().toEqualTypeOf<string>()
    expectTypeOf<CurationJobView['executionContext']>().toEqualTypeOf<ExecutionContext>()
    expectTypeOf<
      Extract<NeighborRecord, { kind: 'fact' }>['subtype']
    >().toEqualTypeOf<FactSubtype>()
    expectTypeOf<
      Extract<NeighborRecord, { kind: 'procedure' }>['subtype']
    >().toEqualTypeOf<undefined>()
  })

  it('emits a born-candidate Add with deterministic fallback authorship when no anchor matches', () => {
    const input = job()
    const delta = onlyDelta(input)

    expect(delta).toMatchObject({
      kind: 'Add',
      origin: 'agent',
      scope,
      citedIds: [],
      authorship: {
        path: 'deterministic-fallback',
        executionContext: 'local-headless',
      },
    })
    if (delta.kind !== 'Add') throw new Error('expected Add')
    expect(delta.authorship?.model).toBeUndefined()
    expect(delta.bundle).toMatchObject({
      kind: 'fact',
      subtype: 'selector',
      anchors: [primaryAnchor, pageAnchor],
      scope,
      summary: input.summarySeed,
      body: input.bodySeed,
      originStage: 'run-curation',
    })
  })

  it('confirms an exact normalized primary-anchor neighbor with a fresh code-derived token', () => {
    const input = job({
      anchors: [
        { t: 'el', role: ' button ', name: ' CHECKOUT ' },
        { t: 'page', route: '/checkout/' },
      ],
    })
    const existing = neighbor()
    const delta = onlyDelta(input, [existing])

    expect(delta.kind).toBe('Confirm')
    if (delta.kind !== 'Confirm') throw new Error('expected Confirm')
    expect(delta.targetId).toBe(existing.recordId)
    expect(delta.evidenceToken).toBe(
      deriveEvidenceToken({
        attributingObservationId: input.attributingObservationId,
        anchor: input.anchors[0]!,
        buildOrdinal: input.buildOrdinal,
      }),
    )
    expect(delta.citedIds).toEqual([existing.recordId])
    expect(delta.precondition).toEqual([
      {
        recordId: existing.recordId,
        observedStatus: existing.observedStatus,
        observedOrdinal: existing.observedOrdinal,
      },
    ])
  })

  it('supersedes only an exact-key measurement neighbor and carries the fresh measured draft', () => {
    const input = job({
      subtype: 'measurement',
      summarySeed: 'Checkout latency p95: 840 ms',
      bodySeed: 'The verified checkout latency p95 is 840 ms.',
    })
    const measurementNeighbor = neighbor({ subtype: 'measurement' })
    const delta = onlyDelta(input, [measurementNeighbor])

    expect(delta.kind).toBe('Supersede')
    if (delta.kind !== 'Supersede') throw new Error('expected Supersede')
    expect(delta.victimId).toBe(measurementNeighbor.recordId)
    expect(delta.newBundle).toMatchObject({
      kind: 'fact',
      subtype: 'measurement',
      summary: input.summarySeed,
      body: input.bodySeed,
    })
    expect(delta.evidenceToken).toBe(
      deriveEvidenceToken({
        attributingObservationId: input.attributingObservationId,
        anchor: input.anchors[0]!,
        buildOrdinal: input.buildOrdinal,
      }),
    )
  })

  it('never supersedes a non-measurement neighbor for a measurement candidate', () => {
    const input = job({ subtype: 'measurement' })
    const behavioralNeighbor = neighbor({ subtype: 'behavioral' })

    expect(onlyDelta(input, [behavioralNeighbor]).kind).toBe('Confirm')
  })

  it('uses the complete supersession key before measurement supersession', () => {
    const input = job({ subtype: 'measurement' })
    const differentPage = neighbor({
      subtype: 'measurement',
      anchors: [primaryAnchor, { t: 'page', route: '/different-page' }],
    })

    expect(onlyDelta(input, [differentPage]).kind).toBe('Confirm')
  })

  it('is byte-deterministic and does not mutate the caller-owned inputs', () => {
    const input = job()
    const neighbors = [neighbor({ alias: 2 }), neighbor({ alias: 1 })]
    const inputBefore = structuredClone(input)
    const neighborsBefore = structuredClone(neighbors)

    const first = constructFallbackDeltas(input, neighbors, 'no-model')
    const second = constructFallbackDeltas(input, neighbors, 'no-model')

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(input).toEqual(inputBefore)
    expect(neighbors).toEqual(neighborsBefore)
  })

  it('persists needsEnrichment for a non-derivable kind through the authored checkpoint', () => {
    const input = job({
      subtype: 'behavioral',
      summarySeed: 'Checkout control behavior',
      bodySeed: 'The Checkout button submits the order.',
    })
    const delta = onlyDelta(input)
    expect(delta.kind).toBe('Add')
    if (delta.kind !== 'Add') throw new Error('expected Add')
    expect((delta.bundle as typeof delta.bundle & { needsEnrichment?: true }).needsEnrichment).toBe(
      true,
    )

    const parsed = parseAuthoredCheckpoint({
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      deltas: [delta],
      neighborIds: [],
      preconditions: [],
      authorship: delta.authorship,
    })
    const parsedDelta = parsed.deltas[0]!
    expect(
      (
        parsedDelta.kind === 'Add'
          ? (parsedDelta.bundle as typeof parsedDelta.bundle & { needsEnrichment?: true })
          : {}
      ).needsEnrichment,
    ).toBe(true)
  })

  it('never authors a procedure: an extraction job falls back to a one-element Noop', () => {
    const deltas = constructFallbackDeltas(
      job({
        kind: 'procedure',
        subtype: undefined,
        anchors: [{ t: 'flow', name: 'Checkout flow' }],
        summarySeed: 'Checkout flow',
        bodySeed: 'Complete checkout using the verified step sequence.',
      }),
      [],
      'malformed',
    )

    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.kind).toBe('Noop')
    expect(deltas[0]?.authorship?.path).toBe('deterministic-fallback')
    // The stamp names which fallback, so the drain noop can carry its cause.
    expect(deltas[0]?.authorship?.fallbackReason).toBe('malformed')
  })

  it('produces no delta kind outside the restricted set across a fixture sweep', () => {
    const produced = [
      onlyDelta(job()),
      onlyDelta(job(), [neighbor()]),
      onlyDelta(job({ subtype: 'measurement' }), [neighbor({ subtype: 'measurement' })]),
      onlyDelta(job({ subtype: 'measurement' }), [neighbor({ subtype: 'behavioral' })]),
      onlyDelta(
        job({
          kind: 'procedure',
          subtype: undefined,
          anchors: [{ t: 'flow', name: 'Checkout flow' }],
        }),
      ),
    ]
    type RestrictedKind = (typeof RESTRICTED_FALLBACK_DELTA_KINDS)[number]
    const counts: Record<RestrictedKind, number> = {
      Add: 0,
      Confirm: 0,
      Supersede: 0,
      Noop: 0,
    }

    for (const delta of produced) {
      assertRestrictedFallbackDelta(delta)
      counts[delta.kind as RestrictedKind] += 1
    }

    expect(Object.keys(counts).sort()).toEqual([...RESTRICTED_FALLBACK_DELTA_KINDS].sort())
    expect(counts).toMatchObject({ Add: 1, Confirm: 2, Supersede: 1, Noop: 1 })
    expect(produced.some((delta) => delta.kind === 'Deprecate')).toBe(false)
  })
})

describe('assertRestrictedFallbackDelta commit-side boundary', () => {
  const add = onlyDelta(job())

  it('accepts Add, Confirm, measurement Supersede, and Noop', () => {
    const confirm = onlyDelta(job(), [neighbor()])
    const supersede = onlyDelta(job({ subtype: 'measurement' }), [
      neighbor({ subtype: 'measurement' }),
    ])
    const noop: Delta = {
      kind: 'Noop',
      origin: 'agent',
      scope,
      citedIds: [],
      authorship: {
        path: 'deterministic-fallback',
        executionContext: 'local-headless',
      },
    }

    for (const delta of [add, confirm, supersede, noop]) {
      expect(() => assertRestrictedFallbackDelta(delta)).not.toThrow()
    }
  })

  it('rejects Deprecate, MintUnknown, and non-measurement Supersede', () => {
    const envelope = {
      origin: 'agent' as const,
      scope,
      citedIds: [asRecordId('fact-checkout-control')],
      authorship: {
        path: 'deterministic-fallback' as const,
        executionContext: 'local-headless' as const,
      },
    }
    const forbidden: Delta[] = [
      {
        ...envelope,
        kind: 'Deprecate',
        targetId: envelope.citedIds[0]!,
        reason: 'fallback must not deprecate',
      },
      {
        ...envelope,
        kind: 'MintUnknown',
        conflict: { recordIds: envelope.citedIds, kind: 'contradiction' },
      },
      {
        ...envelope,
        kind: 'Supersede',
        victimId: envelope.citedIds[0]!,
        newBundle:
          add.kind === 'Add'
            ? add.bundle
            : (() => {
                throw new Error('expected Add fixture')
              })(),
        evidenceToken: asEvidenceToken('forbidden-behavioral-supersede'),
      },
    ]

    for (const delta of forbidden) {
      expect(() => assertRestrictedFallbackDelta(delta)).toThrow(TypeError)
    }
  })
})

describe('fallback and capable-author identity convergence', () => {
  function publishInput(draft: Extract<Delta, { kind: 'Add' }>['bundle']): PublishBundleInput {
    const primary = draft.anchors[0]
    if (draft.kind !== 'fact' || draft.subtype !== 'selector' || primary?.t !== 'el') {
      throw new TypeError('identity fixture requires a selector fact with an element anchor')
    }

    return {
      draft,
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: primary.role, name: primary.name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'fallback-run',
        testId: 'fallback-checkout',
        stepIndex: 0,
      },
      artifacts: [],
    }
  }

  function config() {
    return {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey: 'storefront',
    }
  }

  function fallbackAdd(input = job()): Extract<Delta, { kind: 'Add' }> {
    const delta = onlyDelta(input)
    if (delta.kind !== 'Add') throw new Error('expected fallback Add')
    return delta
  }

  it('publishes enriched prose for the same deterministic fields as already-exists', () => {
    const fallback = fallbackAdd()
    const first = publishBundle(config(), publishInput(fallback.bundle))
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected fallback publish')

    const enrichedDraft = {
      ...fallback.bundle,
      summary: 'Checkout call to action for the current storefront',
      body:
        'The uniquely resolved Checkout button submits the cart and navigates to payment.',
    }
    const enriched = publishBundle(config(), publishInput(enrichedDraft))

    expect(enriched).toEqual({ kind: 'already-exists', id: first.id })
  })

  it('mints a different identity when the deterministic primary anchor changes', () => {
    const firstFallback = fallbackAdd()
    const first = publishBundle(config(), publishInput(firstFallback.bundle))
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')

    const differentFallback = fallbackAdd(
      job({
        candidateId: 'b'.repeat(64),
        anchors: [
          { t: 'el', role: 'Button', name: 'Continue to payment' },
          pageAnchor,
        ],
        summarySeed: 'Continue to payment control',
        bodySeed: 'The Continue to payment button resolves uniquely.',
        attributingObservationId: 'run-1:test-0:step-1',
      }),
    )
    const different = publishBundle(config(), publishInput(differentFallback.bundle))

    expect(different.kind).toBe('published')
    if (different.kind !== 'published') throw new Error('expected distinct publish')
    expect(different.id).not.toBe(first.id)
  })
})
