import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { asEvidenceToken, canonicalJson, sha256hex } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { appendGateReceipt, appendOutcomeEvent } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle, readGateReceipts, verifyBundleIntegrity } from '../bundle-read.js'
import { markReceipt, createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'
import { canaryAttributionsFor } from '../serving/canary-attribution.js'
import { canaryOutcomeObservationId } from '../serving/canary-observation-id.js'

describe('persisted gates part byte identity', () => {
  it('preserves trust and attributed canary rows with exactly the optional manifest difference', () => {
    const root = mkdtempSync(join(tmpdir(), 'gates-byte-identity-'))
    try {
      const knowledgeRoot = join(root, 'source')
      const fixture = createPromotionFloorFixture({ knowledgeRoot })
      const { published } = fixture.publishHeldCandidate('canary-byte-identity')
      const runId = 'run-canary-byte-identity'
      const tuple = { candidateId: published.id, testId: 'checkout', testIndex: 0, stepIndex: 2 }
      const observationId = canaryOutcomeObservationId({ ...tuple, runId })
      expect(appendOutcomeEvent(fixture.outcomeAppendConfig(), published.id, {
        type: 'confirmed', evidenceToken: asEvidenceToken(observationId), curationJobId: observationId,
        buildOrdinal: 43, observationId, origin: 'agent-verified',
      })).toEqual({ kind: 'appended' })

      const withoutRoot = join(root, 'without')
      const withRoot = join(root, 'with')
      cpSync(knowledgeRoot, withoutRoot, { recursive: true })
      const receipt = markReceipt(published.id)
      expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, receipt))
        .toEqual({ kind: 'appended' })
      cpSync(knowledgeRoot, withRoot, { recursive: true })
      const bundlePath = relative(knowledgeRoot, published.dir)
      const withoutDir = join(withoutRoot, bundlePath)
      const withDir = join(withRoot, bundlePath)
      const without = loadBundle(withoutDir)
      const withPart = loadBundle(withDir)
      expect(without.kind).toBe('loaded')
      expect(withPart.kind).toBe('loaded')
      if (without.kind !== 'loaded' || withPart.kind !== 'loaded') throw new Error('pair did not load')

      expect(verifyBundleIntegrity(withoutDir)).toEqual({ ok: true, violations: [] })
      expect(verifyBundleIntegrity(withDir)).toEqual({ ok: true, violations: [] })
      expect(canonicalJson(deriveBundleTrust(withPart.bundle)))
        .toBe(canonicalJson(deriveBundleTrust(without.bundle)))
      expect(deriveBundleTrust(without.bundle).counters.confirmed).toBe(1)
      expect(readFileSync(join(withDir, 'evidence/outcomes.jsonl'), 'utf8'))
        .toBe(readFileSync(join(withoutDir, 'evidence/outcomes.jsonl'), 'utf8'))

      const withoutAttributions = canaryAttributionsFor({ knowledgeRoot: withoutRoot, runId, tuples: [tuple] })
      const withAttributions = canaryAttributionsFor({ knowledgeRoot: withRoot, runId, tuples: [tuple] })
      expect(withoutAttributions).toEqual({
        rows: [{ candidateId: published.id, testIndex: 0, stepIndex: 2, observationId, outcome: 'confirmed' }],
        skippedBundles: 0,
      })
      expect(withAttributions).toEqual(withoutAttributions)
      expect(canonicalJson(withAttributions)).toBe(canonicalJson(withoutAttributions))
      expect(readGateReceipts(withoutDir, published.id)).toBeUndefined()
      expect(readGateReceipts(withDir, published.id)).toEqual([receipt])

      const before = without.bundle.manifest
      const after = withPart.bundle.manifest
      expect(before.contentHashes).not.toHaveProperty('evidence/gates.jsonl')
      expect(after.contentHashes['evidence/gates.jsonl'])
        .toBe(sha256hex(readFileSync(join(withDir, 'evidence/gates.jsonl'), 'utf8')))
      expect(after.mutableStateHash).not.toBe(before.mutableStateHash)
      const { mutableStateHash: beforeHash, ...beforeOther } = before
      const { mutableStateHash: afterHash, contentHashes, ...afterOther } = after
      const { ['evidence/gates.jsonl']: gateHash, ...otherContentHashes } = contentHashes
      expect({ ...afterOther, contentHashes: otherContentHashes }).toEqual(beforeOther)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
