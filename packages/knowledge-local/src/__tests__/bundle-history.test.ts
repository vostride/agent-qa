// Per origin and evidence case, the bundle read after publish and after each appended history event
// equals fixtures/bundle-history/<case>.json; the package's regen:bundle-history rewrites them.
import { mkdtempSync, rmSync } from 'node:fs'
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
interface HistoryCase {
  name: string
  input: PublishBundleInput
  appended: BundleOutcomeEvent[]
}

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

function inputs(): HistoryCase[] {
  return origins.flatMap(originClass => [false, true].map(incomplete => ({
    name: `${originClass}-${incomplete ? 'incomplete' : 'clean'}`,
    input: {
      draft: makeBundleDraftFixture(), discriminant: makeDiscriminantFixture(),
      originClass, createdAtOrdinal: 10, screenStates: [], initialEvents: [], relations: [],
      provenance: { mode: 'standalone' as const, sourceDescription: 'persisted prior characterization' },
      artifacts: [],
      ...(incomplete ? { preSkippedArtifacts: [{ ref: makeArtifactFixture().ref, stepIndex: 0, reason: 'pruned-source' as const }] } : {}),
    },
    appended: history(),
  })))
}

describe('bundle bytes across publish and every appended history event', () => {
  for (const entry of inputs()) {
    it(`${entry.name} reads back its recorded bytes after publish and after each append`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-bundle-history-'))
      const snapshots: Snapshot[] = []
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
          snapshots.push(snapshot)
        }
        expect(snapshots).toHaveLength(15)
        await expect(`${JSON.stringify(snapshots, null, 2)}\n`).toMatchFileSnapshot(
          `./fixtures/bundle-history/${entry.name}.json`,
        )
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
})
