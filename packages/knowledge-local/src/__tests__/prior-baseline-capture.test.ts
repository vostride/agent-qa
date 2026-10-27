import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BundleOutcomeEventSchema, canonicalJson, guardBundleManifest, guardBundleProvenance,
  type BundleOutcomeEvent, type BundleManifest, type BundleProvenance, type OriginClass,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { appendOutcomeEvent } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from '../bundle-read.js'
import { publishBundle, type PublishBundleInput } from '../bundle-publish.test-helper.js'
import { makeArtifactFixture, makeBundleDraftFixture, makeDiscriminantFixture } from './fixtures/bundle-fixture.js'

interface Snapshot {
  stage: string
  events: BundleOutcomeEvent[]
  manifest: BundleManifest
  provenance: BundleProvenance
  expectedBytes: string
}
interface BaselineCase {
  name: string
  input: PublishBundleInput
  appended: BundleOutcomeEvent[]
  snapshots: Snapshot[]
}
interface Baseline {
  sourceRevision: string
  captureCommand: string
  cases: BaselineCase[]
}

const fixturePath = new URL('./fixtures/420-prior-baseline.json', import.meta.url)
const capturePath = process.env.AGENT_QA_CAPTURE_PRIOR_BASELINE
const origins: OriginClass[] = ['user', 'agent-verified', 'agent-observed', 'import']

function history(): BundleOutcomeEvent[] {
  const rows = [
    { type: 'confirmed' }, { type: 'contradicted' }, { type: 'helpful' }, { type: 'harmful' },
    { type: 'promoted' },
    { type: 'window-close', closedAtOrdinal: 16 },
    { type: 'deprecated', reason: 'baseline history' },
    { type: 'superseded', byRecordId: 'baseline-successor' },
    { type: 'retracted', retractsEvidenceToken: 'baseline-7', retractsCurationJobId: 'baseline-job', rollbackReceiptId: 'baseline-rollback' },
    { type: 'retracted', retractsEvidenceToken: 'baseline-6', retractsCurationJobId: 'baseline-job', rollbackReceiptId: 'baseline-rollback' },
    { type: 'retracted', retractsEvidenceToken: 'baseline-5', retractsCurationJobId: 'baseline-job', rollbackReceiptId: 'baseline-rollback' },
    { type: 'retracted', retractsEvidenceToken: 'baseline-0', retractsCurationJobId: 'baseline-job', rollbackReceiptId: 'baseline-rollback' },
    { type: 'overturned', overturnsEvidenceToken: 'baseline-1', overturnsCurationJobId: 'baseline-job', markId: 'mark_0123456789ab' },
    { type: 'confirmed', origin: 'user' },
  ]
  return rows.map((row, index) => BundleOutcomeEventSchema.parse({
    ...row, evidenceToken: `baseline-${index}`, curationJobId: 'baseline-job', buildOrdinal: 11 + index,
  }))
}

function inputs(): BaselineCase[] {
  return origins.flatMap(originClass => [false, true].map(incomplete => ({
    name: `${originClass}-${incomplete ? 'incomplete' : 'clean'}`,
    input: {
      draft: makeBundleDraftFixture(), discriminant: makeDiscriminantFixture(),
      originClass, createdAtOrdinal: 10, screenStates: [], initialEvents: [], relations: [],
      provenance: { mode: 'standalone' as const, sourceDescription: 'persisted prior characterization' },
      artifacts: [],
      ...(incomplete ? { preSkippedArtifacts: [{ ref: makeArtifactFixture().ref, stepIndex: 0, reason: 'pruned-source' as const }] } : {}),
    },
    appended: history(), snapshots: [],
  })))
}

// Explicit capture is a one-time characterization of the old revision. Ordinary assertions
// only read the committed oracle; they never regenerate expectations from the current fold.
const baseline: Baseline = capturePath === undefined
  ? JSON.parse(readFileSync(fixturePath, 'utf8')) as Baseline
  : {
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      captureCommand: 'AGENT_QA_CAPTURE_PRIOR_BASELINE=/private/tmp/420-prior-baseline.json node ../../node_modules/vitest/vitest.mjs run src/__tests__/prior-baseline-capture.test.ts --reporter=verbose',
      cases: inputs(),
    }

describe('420 independently captured persisted prior baseline', () => {
  for (const entry of baseline.cases) {
    it(`preserves old bytes for ${entry.name} across every persisted history prefix`, () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-prior-baseline-'))
      try {
        const config = { knowledgeRoot: join(root, 'knowledge'), productKey: 'baseline' }
        const published = publishBundle(config, entry.input)
        expect(published.kind).toBe('published')
        if (published.kind !== 'published') throw new Error('baseline publication refused')
        for (let index = 0; index <= entry.appended.length; index++) {
          if (index > 0) {
            const event = BundleOutcomeEventSchema.parse(entry.appended[index - 1])
            expect(appendOutcomeEvent(config, published.id, event).kind).toBe('appended')
            expect(appendOutcomeEvent(config, published.id, event).kind).toBe('duplicate')
          }
          expect(verifyBundleIntegrity(published.dir)).toEqual({ ok: true, violations: [] })
          const loaded = loadBundle(published.dir)
          if (loaded.kind !== 'loaded') throw new Error('baseline read refused')
          const snapshot: Snapshot = {
            stage: index === 0 ? 'zero-events' : `${index}-${entry.appended[index - 1]!.type}`,
            events: loaded.bundle.events.map(event => BundleOutcomeEventSchema.parse(event)),
            manifest: guardBundleManifest(loaded.bundle.manifest),
            provenance: guardBundleProvenance(loaded.bundle.provenance),
            expectedBytes: canonicalJson(deriveBundleTrust(loaded.bundle)),
          }
          if (capturePath !== undefined) entry.snapshots.push(snapshot)
          else expect(snapshot).toEqual(entry.snapshots[index])
        }
        expect(entry.snapshots).toHaveLength(15)
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
  it('pins all origin and evidence combinations with an independent source revision', () => {
    expect(baseline.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.cases.map(entry => entry.name)).toEqual([
      'user-clean', 'user-incomplete', 'agent-verified-clean', 'agent-verified-incomplete',
      'agent-observed-clean', 'agent-observed-incomplete', 'import-clean', 'import-incomplete',
    ])
    if (capturePath !== undefined) writeFileSync(capturePath, JSON.stringify(baseline, null, 2) + '\n')
  })
})
