import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  canonicalJson,
  guardInspectRecordView,
  normalizeAnchor,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleDiscriminant,
  BundleDraft,
  BundleOutcomeEvent,
  InspectFilter,
  InspectRecordView,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle } from '../bundle-publish.test-helper.js'
import type { BundleStoreConfig } from '../bundle-publish.test-helper.js'
import * as knowledgeLocal from '../index.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

type InspectApi = {
  inspectRecords?: (options: {
    knowledgeRoot: string
    filter: InspectFilter
  }) => InspectRecordView[]
}

function inspectRecords(
  knowledgeRoot: string,
  filter: InspectFilter = {},
): InspectRecordView[] {
  const inspect = (knowledgeLocal as InspectApi).inspectRecords
  expect(inspect, 'inspectRecords export').toBeDefined()
  return inspect!({ knowledgeRoot, filter })
}

function event(
  value: Parameters<typeof BundleOutcomeEventSchema.parse>[0],
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(value)
}

describe('inspectRecords canonical maintenance view', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-inspect-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function publish(input: {
    product: string
    kind: BundleDraft['kind']
    scope: string
    anchor: Anchor
    discriminant: BundleDiscriminant
    createdAtOrdinal: number
    initialEvents?: readonly BundleOutcomeEvent[]
    evidenceMarkdown?: string
  }): string {
    const outcome = publishBundle(config(input.product), {
      draft: makeBundleDraftFixture({
        kind: input.kind,
        anchors: [input.anchor],
        scope: { tier: 'product', key: input.scope },
        summary: `${input.kind} record for ${input.scope}`,
      }),
      discriminant: input.discriminant,
      originClass: 'agent-verified',
      createdAtOrdinal: input.createdAtOrdinal,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [...(input.initialEvents ?? [])],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `inspect-${input.scope}`,
        testId: 'inspect-records',
        stepIndex: 0,
      },
      artifacts: [],
      ...(input.evidenceMarkdown === undefined
        ? {}
        : { evidenceMarkdown: input.evidenceMarkdown }),
    })

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
    return outcome.id
  }

  function seedStore(): {
    activeId: string
    retiredId: string
    unresolvedId: string
    unresolvedAnchor: Anchor
  } {
    const activeId = publish({
      product: 'shop',
      kind: 'fact',
      scope: 'checkout',
      anchor: { t: 'el', role: 'Button', name: 'Checkout Now' },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Checkout Now' },
      },
      createdAtOrdinal: 5,
      initialEvents: [
        event({
          type: 'promoted',
          evidenceToken: 'active-promoted',
          curationJobId: 'active-promotion-job',
          buildOrdinal: 6,
        }),
        event({
          type: 'confirmed',
          evidenceToken: 'active-confirmed',
          curationJobId: 'active-confirmation-job',
          buildOrdinal: 7,
          origin: 'agent-verified',
        }),
      ],
      evidenceMarkdown: 'Evidence for the active checkout record.\n',
    })

    const retiredId = publish({
      product: 'shop',
      kind: 'fact',
      scope: 'legacy-checkout',
      anchor: { t: 'el', role: 'Button', name: 'Legacy Checkout' },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Legacy Checkout' },
      },
      createdAtOrdinal: 5,
      initialEvents: [
        event({
          type: 'superseded',
          evidenceToken: 'legacy-superseded',
          curationJobId: 'legacy-supersession-job',
          buildOrdinal: 20,
          byRecordId: activeId,
        }),
        event({
          type: 'window-close',
          evidenceToken: 'legacy-window-close',
          curationJobId: 'legacy-window-close-job',
          buildOrdinal: 20,
          closedAtOrdinal: 20,
        }),
      ],
    })

    const unresolvedAnchor: Anchor = {
      t: 'error',
      message: '  Payment FAILED for order 42  ',
    }
    const unresolvedId = publish({
      product: 'support',
      kind: 'unknown',
      scope: 'payment-triage',
      anchor: unresolvedAnchor,
      discriminant: {
        kind: 'unknown',
        conflictRecordIds: ['payment-record-b', 'payment-record-a'],
      },
      createdAtOrdinal: 9,
    })

    return { activeId, retiredId, unresolvedId, unresolvedAnchor }
  }

  it('returns only current live records by default in stable record-id order', () => {
    const { activeId, unresolvedId } = seedStore()

    const records = inspectRecords(knowledgeRoot)

    expect(records.map((record) => record.recordId)).toEqual(
      [activeId, unresolvedId].sort(),
    )
    expect(records.map(guardInspectRecordView)).toEqual(records)
    expect(records.find((record) => record.recordId === activeId)).toMatchObject({
      product: 'shop',
      scope: 'checkout',
      kind: 'fact',
      status: 'active',
      confirmations: 1,
      contradictions: 0,
      evidenceTokens: ['active-confirmed', 'active-promoted'],
      lastEventOrdinal: 7,
      openedAtOrdinal: 5,
      trustNarrative: 'Evidence for the active checkout record.\n',
    })
  })

  it('applies every filter against normalized canonical record state', () => {
    const { retiredId, unresolvedId, unresolvedAnchor } = seedStore()
    const normalizedAnchor = canonicalJson(normalizeAnchor(unresolvedAnchor))

    expect(inspectRecords(knowledgeRoot, { product: 'support' }).map((r) => r.recordId))
      .toEqual([unresolvedId])
    expect(inspectRecords(knowledgeRoot, { scope: 'payment-triage' }).map((r) => r.recordId))
      .toEqual([unresolvedId])
    expect(inspectRecords(knowledgeRoot, { kind: 'unknown' }).map((r) => r.recordId))
      .toEqual([unresolvedId])
    expect(inspectRecords(knowledgeRoot, { unresolvedOnly: true }).map((r) => r.recordId))
      .toEqual([unresolvedId])
    expect(inspectRecords(knowledgeRoot, { anchor: normalizedAnchor }).map((r) => r.recordId))
      .toEqual([unresolvedId])
    expect(inspectRecords(knowledgeRoot, { recordId: retiredId, status: 'superseded' }))
      .toHaveLength(1)
    expect(inspectRecords(knowledgeRoot, { recordId: retiredId, asOfBuild: 15 }))
      .toHaveLength(1)
    expect(inspectRecords(knowledgeRoot, { recordId: retiredId, asOfBuild: 20 }))
      .toMatchObject([
        {
          recordId: retiredId,
          status: 'superseded',
          lastEventOrdinal: 20,
          closedAtOrdinal: 20,
        },
      ])
  })

  it('folds fields and selectors from only events visible at the requested horizon', () => {
    const historicalAnchor: Anchor = {
      t: 'error',
      message: 'Historical payment conflict',
    }
    const confirmedAt12 = event({
      type: 'confirmed',
      evidenceToken: 'historical-confirmed',
      curationJobId: 'historical-confirmation-job',
      buildOrdinal: 12,
      origin: 'agent-verified',
    })
    const historicalId = publish({
      product: 'support',
      kind: 'unknown',
      scope: 'historical-payment-triage',
      anchor: historicalAnchor,
      discriminant: {
        kind: 'unknown',
        conflictRecordIds: ['historical-payment-b', 'historical-payment-a'],
      },
      createdAtOrdinal: 5,
      initialEvents: [
        event({
          type: 'promoted',
          evidenceToken: 'historical-promoted',
          curationJobId: 'historical-promotion-job',
          buildOrdinal: 10,
        }),
        confirmedAt12,
        event({
          type: 'confirmed',
          evidenceToken: 'historical-confirmed-late',
          curationJobId: 'historical-confirmation-late-job',
          buildOrdinal: 18,
          origin: 'agent-verified',
        }),
        event({
          type: 'contradicted',
          evidenceToken: 'historical-contradicted-late',
          curationJobId: 'historical-contradiction-late-job',
          buildOrdinal: 18,
          origin: 'agent-verified',
        }),
        event({
          type: 'retracted',
          evidenceToken: 'historical-retraction',
          curationJobId: 'historical-retraction-job',
          buildOrdinal: 20,
          retractsEvidenceToken: confirmedAt12.evidenceToken,
          retractsCurationJobId: confirmedAt12.curationJobId,
          rollbackReceiptId: 'historical-rollback-receipt',
        }),
        event({
          type: 'deprecated',
          evidenceToken: 'historical-deprecated',
          curationJobId: 'historical-deprecation-job',
          buildOrdinal: 20,
          reason: 'Historical conflict resolved',
        }),
        event({
          type: 'window-close',
          evidenceToken: 'historical-window-close',
          curationJobId: 'historical-window-close-job',
          buildOrdinal: 20,
          closedAtOrdinal: 20,
        }),
      ],
    })
    const afterHorizonId = publish({
      product: 'support',
      kind: 'unknown',
      scope: 'future-payment-triage',
      anchor: { t: 'flow', name: 'Future payment triage' },
      discriminant: {
        kind: 'unknown',
        conflictRecordIds: ['future-payment-b', 'future-payment-a'],
      },
      createdAtOrdinal: 16,
    })

    const at15 = inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 15,
    })
    expect(at15).toHaveLength(1)
    expect(at15[0]).toMatchObject({
      recordId: historicalId,
      status: 'active',
      confirmations: 1,
      contradictions: 0,
      evidenceTokens: ['historical-confirmed', 'historical-promoted'],
      lastEventOrdinal: 12,
      openedAtOrdinal: 5,
      anchors: [canonicalJson(normalizeAnchor(historicalAnchor))],
    })
    expect(at15[0]).not.toHaveProperty('closedAtOrdinal')
    expect(inspectRecords(knowledgeRoot, {
      recordId: afterHorizonId,
      asOfBuild: 15,
    })).toEqual([])

    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 15,
      status: 'active',
    })).toHaveLength(1)
    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 15,
      status: 'deprecated',
    })).toEqual([])
    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 15,
      unresolvedOnly: true,
    })).toHaveLength(1)

    const at20 = inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 20,
    })
    expect(at20).toHaveLength(1)
    expect(at20[0]).toMatchObject({
      recordId: historicalId,
      status: 'deprecated',
      confirmations: 1,
      contradictions: 1,
      evidenceTokens: [
        'historical-confirmed-late',
        'historical-contradicted-late',
        'historical-deprecated',
        'historical-promoted',
        'historical-window-close',
      ],
      lastEventOrdinal: 20,
      openedAtOrdinal: 5,
      closedAtOrdinal: 20,
    })
    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 20,
      unresolvedOnly: true,
    })).toEqual([])
    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      asOfBuild: 20,
      status: 'deprecated',
    })).toEqual(at20)

    expect(inspectRecords(knowledgeRoot, { recordId: historicalId })).toEqual([])
    expect(inspectRecords(knowledgeRoot, {
      recordId: historicalId,
      status: 'deprecated',
    })).toEqual(at20)
  })

  it('is byte-identical across repeated reads without wall-clock dependence', () => {
    seedStore()

    const first = JSON.stringify(inspectRecords(knowledgeRoot, { status: 'active' }))
    const second = JSON.stringify(inspectRecords(knowledgeRoot, { status: 'active' }))

    expect(second).toBe(first)
  })

  it('fails closed when a canonical bundle cannot be loaded or verified', () => {
    const recordId = publish({
      product: 'shop',
      kind: 'fact',
      scope: 'damaged-inspect',
      anchor: { t: 'el', role: 'button', name: 'Damaged inspect' },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: 'Damaged inspect' },
      },
      createdAtOrdinal: 4,
    })
    writeFileSync(
      join(knowledgeRoot, 'memory', 'shop', 'bundles', recordId, 'manifest.json'),
      'not-json\n',
      'utf8',
    )

    expect(() => inspectRecords(knowledgeRoot)).toThrowError(
      knowledgeLocal.KnowledgeMaintenanceScanError,
    )
    expect(() => inspectRecords(knowledgeRoot)).toThrow(/scan incomplete.*bundle/i)
  })
})
