import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendGateReceipt } from '../bundle-append.js'
import { standingReceiptDigestsFor } from '../gates/canary-posture-facts.js'
import { completeGate1Receipt, createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'

describe('standing gate receipt digests', () => {
  let root: string
  let knowledgeRoot: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'standing-receipt-digests-'))
    knowledgeRoot = join(root, 'knowledge')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  function seed(name = 'quiet') {
    const { published } = fixture.publishHeldCandidate(name)
    const pass = completeGate1Receipt(published.id, { producedAtOrdinal: 10 })
    expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, pass)).toEqual({ kind: 'appended' })
    return { ...published, pass }
  }
  it('reads the standing pass and its corpus digest', () => {
    const planted = seed()
    expect(standingReceiptDigestsFor({ knowledgeRoot })).toEqual([{ candidateId: planted.id,
      gate: 1, verdict: 'pass', corpusDigest: 'c'.repeat(64), producedAtOrdinal: 10 }])
  })
  it('never revives a superseded pass', () => {
    const planted = seed()
    appendGateReceipt(fixture.outcomeAppendConfig(), planted.id,
      completeGate1Receipt(planted.id, { producedAtOrdinal: 14, verdict: 'fail' }))
    expect(standingReceiptDigestsFor({ knowledgeRoot }).find(row => row.gate === 1)?.verdict).toBe('fail')
  })
  it('refuses corrupt evidence instead of skipping the bundle', () => {
    const planted = seed()
    writeFileSync(join(planted.dir, 'evidence/outcomes.jsonl'), '{bad}\n')
    expect(() => standingReceiptDigestsFor({ knowledgeRoot })).toThrow()
  })
})
