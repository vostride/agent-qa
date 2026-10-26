import { committedFileText, sha256hex } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, ScopeKey } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
} from '../../__tests__/fixtures/handoff-fixtures'
import { canonicalJson } from '../../canonical-json'
import type { LeafCassette } from '../../cassette/cassette'
import { extractRunCassettes } from '../../extract/extract-run'
import type { ArtifactSource } from '../../ports'
import {
  CORPUS_ENTRY_SCHEMA_VERSION,
  projectCorpusEntry,
  resolveProductPartition,
} from '../corpus-entry'

const RUN_ID = 'run / checkout suite 42'
const RUN_SLUG = 'run---checkout-suite-42'
const LEAF_ID = `${RUN_SLUG}/test-00-step-00-d00-leaf`

function fullArtifacts(): ArtifactSource {
  const entries = new Map<string, Uint8Array>([
    [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
    [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
  ])
  return { getBlob: (sha) => entries.get(sha) }
}

function fixtureLeaf(): LeafCassette {
  const handoff: CompletedRunHandoff = makeArtifactRefV2Handoff()
  const found = extractRunCassettes({ handoff, artifacts: fullArtifacts() })
    .cassettes.map((entry) => entry.cassette)
    .find(
      (cassette): cassette is LeafCassette =>
        cassette.granularity === 'leaf' && cassette.id === LEAF_ID,
    )
  if (found === undefined) throw new Error(`missing leaf cassette ${LEAF_ID}`)
  return found
}

describe('projectCorpusEntry (D-02/ROOT-03, 414 D-03/D-04/D-13)', () => {
  it('adds feedback provenance only when present without changing ordinary entry keys', () => {
    const input = { cassette: fixtureLeaf(), product: 'demo-app', runId: RUN_ID, assignment: { split: 'natural' as const } }
    const ordinary = projectCorpusEntry(input)
    const feedback = { attributedObservationId: 'observation-fixture', benefit: 'rode-along' as const }
    expect(projectCorpusEntry({ ...input, feedback })).toEqual({ ...ordinary, source: 'canary-feedback', ...feedback })
    expect(Object.keys(ordinary).sort()).toEqual(['schemaVersion', 'cassetteId', 'product', 'split', 'captured_at_ordinal', 'run_links', 'receiptDigest'].sort())
  })
  it('projects the full v2 membership shape with requirement-verbatim provenance keys', () => {
    const cassette = fixtureLeaf()

    const entry = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'natural' },
    })

    expect(entry).toEqual({
      schemaVersion: CORPUS_ENTRY_SCHEMA_VERSION,
      cassetteId: LEAF_ID,
      product: 'demo-app',
      split: 'natural',
      captured_at_ordinal: cassette.receipt.buildOrdinal,
      run_links: { runId: RUN_ID, runSlug: RUN_SLUG },
      receiptDigest: sha256hex(canonicalJson(cassette.receipt)),
    })
    expect(entry.captured_at_ordinal).toBe(37)
    expect(Object.keys(entry.run_links)).toEqual(['runId', 'runSlug'])

    const serialized = committedFileText(entry)
    expect(serialized).toContain('"captured_at_ordinal"')
    expect(serialized).toContain('"run_links"')
  })

  it('carries the assignment arm through, and only that arm', () => {
    const cassette = fixtureLeaf()

    const heldOut = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'held-out', heldOutVisibility: 'private' },
    })
    expect(heldOut.split).toBe('held-out')
    expect(heldOut).toMatchObject({ split: 'held-out', heldOutVisibility: 'private' })

    const natural = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'natural' },
    })
    expect(Object.keys(natural)).not.toContain('heldOutVisibility')
    expect(Object.keys(natural)).not.toContain('generator')
  })

  it('stamps the D-04 fields iff they were supplied, never as undefined keys', () => {
    const cassette = fixtureLeaf()

    const stamped = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'natural' },
      capturedAt: '2026-09-04T16:25:54.000Z',
      targetEnvironment: 'local',
    })
    expect(stamped.captured_at).toBe('2026-09-04T16:25:54.000Z')
    expect(stamped.targetEnvironment).toBe('local')

    const bare = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'natural' },
    })
    expect(Object.keys(bare)).not.toContain('captured_at')
    expect(Object.keys(bare)).not.toContain('targetEnvironment')
  })

  it('recomputes to the same receiptDigest independently', () => {
    const cassette = fixtureLeaf()

    const entry = projectCorpusEntry({
      cassette,
      product: 'demo-app',
      runId: RUN_ID,
      assignment: { split: 'natural' },
    })

    const independent = sha256hex(JSON.stringify(sortKeysDeep(cassette.receipt)))
    expect(entry.receiptDigest).toBe(independent)
  })
})

describe('resolveProductPartition (D-03/A1)', () => {
  it('passes a real product name through', () => {
    const scope: ScopeKey = { tier: 'product', key: 'demo-app' }
    expect(resolveProductPartition(scope)).toBe('demo-app')
  })

  it("maps the 'unknown' fallback and an empty name to the typed default partition", () => {
    expect(resolveProductPartition({ tier: 'product', key: 'unknown' })).toBe('default')
    expect(resolveProductPartition({ tier: 'product', key: '' })).toBe('default')
  })

  it('maps non-product tiers to the typed default partition', () => {
    expect(resolveProductPartition({ tier: 'global', key: 'demo-app' })).toBe('default')
    expect(resolveProductPartition({ tier: 'suite', key: 'checkout' })).toBe('default')
    expect(resolveProductPartition({ tier: 'test', key: 'checkout::happy-path' })).toBe(
      'default',
    )
  })
})

/** Key-order-independent recursive sort mirroring canonical serialization. */
function sortKeysDeep(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortKeysDeep)
  if (input === null || typeof input !== 'object') return input
  const source = input as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeysDeep(source[key])
  }
  return sorted
}
