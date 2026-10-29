// 2026-09-30, 432-09 (D-04/D-11/D-25): run detail says what a mark changed, never what awaits review.
//
// The history line is projected from the applied receipt (the record content it changed, or the test
// file it wrote); the preview speaks of what will change; a historical drafted receipt whose change
// was never recorded reads as unavailable rather than as an invented change.
import { describe, expect, it } from 'vitest'
import * as feedbackView from '@/lib/feedback-view'

const fv = feedbackView as Record<string, unknown>
const call = <T>(name: string, ...args: unknown[]): T => {
  const fn = fv[name]
  expect(typeof fn, `${name} is exported`).toBe('function')
  return (fn as (...values: unknown[]) => T)(...args)
}

const KNOWLEDGE = {
  kind: 'applied', fix: 'caution',
  change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_1', 'mem_2'] },
} as const
const TEST_FILE = {
  kind: 'applied', fix: 'test-edit',
  change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'sha256:abc' },
} as const
const CONTENT = {
  content: 'Coupon codes are refused after checkout starts.',
  summary: 'coupon refused', kind: 'caution',
  applicability: { product: 'shop', scope: 'shop', anchors: [], openedAtOrdinal: 1 },
  currentStatus: 'active',
  currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 1 },
}

describe('the applied change, as the history and preview show it', () => {
  it('knowledge and test-file outcomes read as applied; no-fix, bug and historical drafts read as themselves', () => {
    expect(call<string>('dispositionText', KNOWLEDGE)).toBe('Recorded — a caution was added')
    expect(call<string>('dispositionText', TEST_FILE)).toBe('Recorded — the test file was edited')
    expect(call<string>('dispositionText', { kind: 'confirmed-bug', confirmedRecords: 2 }))
      .toBe('Recorded — kept as a real product bug; nothing changed')

    const knowledge = call<unknown>('appliedChangeView', {
      disposition: KNOWLEDGE,
      changedRecords: [{ recordId: 'mem_1', recordContent: CONTENT }, { recordId: 'mem_2', contentAbsence: { reason: 'not-found' } }],
    })
    expect(knowledge).toEqual({ kind: 'knowledge', records: [
      { recordId: 'mem_1', content: CONTENT.content },
      { recordId: 'mem_2' },
    ] })
    expect(call<string>('appliedChangeText', knowledge))
      .toBe('Changed knowledge: “Coupon codes are refused after checkout starts.”; mem_2 (content unavailable)')

    const file = call<unknown>('appliedChangeView', { disposition: TEST_FILE })
    expect(file).toEqual({ kind: 'test-file', filePath: 'tests/checkout.yaml' })
    expect(call<string>('appliedChangeText', file)).toBe('Edited the test file tests/checkout.yaml')

    const historical = call<unknown>('appliedChangeView', {
      disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' },
    })
    expect(historical, 'an unrecorded change is unavailable, never fabricated').toEqual({ kind: 'unavailable' })
    expect(call<string>('appliedChangeText', historical)).toBe('What this mark changed was not recorded.')

    for (const disposition of [
      { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
      { kind: 'confirmed-bug', confirmedRecords: 0 },
      { kind: 'quarantined', class: 'flake' },
    ]) expect(call<unknown>('appliedChangeView', { disposition }), disposition.kind).toBeUndefined()

    // The preview names what will change, and a replaced mark keeps its fix.
    expect(call<string>('previewFixText', { kind: 'knowledge', fix: 'fact', target: { grain: 'bundle', id: 'mem_1' } }))
      .toBe('A knowledge fact will be added')
    expect(call<string>('previewFixText', { kind: 'test-edit', testRef: 'tests/checkout.yaml::checkout' }))
      .toBe('The test file will be edited')
    expect(call<string>('replacesLine', 2, '14:05')).toBe('Replaces your earlier mark (#2, 14:05); what it changed stays')
  })
})
