// `canaryAttributionsFor` — what became of the canary lines a run served.
//
// The join is between two things a run cannot hold at once: the SERVE-time marker, which is a
// fact about the run and lives in its evidence, and the ATTRIBUTED outcome, which is a fact about
// the committed knowledge store and lives in a bundle's outcomes log. The observation id is the
// only thing that spans them, and it is recomputed here from the run's own tuples rather than
// read from anywhere — which is what makes an answer here evidence rather than a claim.
//
// Every cell below reads COMMITTED bytes. Nothing in this file mints, appends or retracts an
// outcome event to make an assertion true: the write path stays behind the writer lease, and a
// read that could write would be the T-407-11 tampering hazard rather than its mitigation.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  asRecordId,
} from '@vostride/agent-qa-schema'
import type { BundleOutcomeEvent, RecordId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle } from '../bundle-publish.test-helper.js'
import type { BundleStoreConfig } from '../bundle-publish.test-helper.js'
import { canaryAttributionsFor } from '../serving/canary-attribution.js'
import { canaryOutcomeObservationId } from '../serving/canary-observation-id.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

const RUN_ID = 'run-A'
const TEST_ID = 'checkout'

function event(
  value: Parameters<typeof BundleOutcomeEventSchema.parse>[0],
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(value)
}

describe('canaryAttributionsFor joins served canary tuples to committed outcomes', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canary-attribution-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'shop',
    }
  }

  /** The published bundle's id AND its directory — the tamper cell needs the bytes on disk. */
  function publishCandidateEntry(
    name: string,
    initialEvents: readonly BundleOutcomeEvent[],
  ): { id: RecordId; dir: string } {
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        anchors: [{ t: 'el', role: 'Button', name }],
        scope: { tier: 'product', key: name.toLowerCase() },
        summary: `${name} fact`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 3,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [...initialEvents],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: RUN_ID,
        testId: TEST_ID,
        stepIndex: 0,
      },
      artifacts: [],
    })

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
    return { id: outcome.id, dir: outcome.dir }
  }

  function publishCandidate(
    name: string,
    initialEvents: readonly BundleOutcomeEvent[],
  ): RecordId {
    return publishCandidateEntry(name, initialEvents).id
  }

  /** The id the WRITER would have stamped for this served line — recomputed, never read. */
  function observationIdFor(candidateId: RecordId, stepIndex: number): string {
    return canaryOutcomeObservationId({
      candidateId,
      runId: RUN_ID,
      testId: TEST_ID,
      testIndex: 0,
      stepIndex,
    })
  }

  function tupleFor(candidateId: string, stepIndex: number) {
    return { candidateId, testId: TEST_ID, testIndex: 0, stepIndex }
  }

  it('reports the confirming outcome for a line whose observation is committed', () => {
    const candidateId = publishCandidate('Confirmed canary', [])
    const observationId = observationIdFor(candidateId, 2)
    // Republished with the event, so the observation id is known before the bundle is written —
    // exactly the order the writer works in.
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const republished = publishCandidate('Confirmed canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'confirmed-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        origin: 'agent-verified',
      }),
    ])
    expect(republished).toBe(candidateId)

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 2)],
    })).toEqual({
      rows: [
        {
          candidateId,
          testIndex: 0,
          stepIndex: 2,
          observationId,
          outcome: 'confirmed',
        },
      ],
      skippedBundles: 0,
    })
  })

  it('reports a contradicting outcome the same way — the fold reads the event TYPE', () => {
    const probe = publishCandidate('Contradicted canary', [])
    const observationId = observationIdFor(probe, 4)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Contradicted canary', [
      event({
        type: 'contradicted',
        evidenceToken: 'contradicted-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        origin: 'agent-verified',
      }),
    ])

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 4)],
    })).toEqual({
      rows: [
        {
          candidateId,
          testIndex: 0,
          stepIndex: 4,
          observationId,
          outcome: 'contradicted',
        },
      ],
      skippedBundles: 0,
    })
  })

  it('a RETRACTED observation carries no outcome key — the surviving-events fold decides', () => {
    const probe = publishCandidate('Retracted canary', [])
    const observationId = observationIdFor(probe, 1)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Retracted canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'retracted-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        origin: 'agent-verified',
      }),
      event({
        type: 'retracted',
        evidenceToken: 'rollback-at-6',
        curationJobId: 'rollback-job',
        buildOrdinal: 6,
        retractsEvidenceToken: 'retracted-canary',
        retractsCurationJobId: observationId,
        rollbackReceiptId: 'rollback-receipt-1',
      }),
    ])

    const answer = canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 1)],
    })

    expect(answer).toEqual({
      rows: [{ candidateId, testIndex: 0, stepIndex: 1, observationId }],
      skippedBundles: 0,
    })
    expect(Object.hasOwn(answer.rows[0]!, 'outcome')).toBe(false)
  })

  it('a LIFECYCLE event carrying the same id attributes nothing — only the four words do', () => {
    const probe = publishCandidate('Deprecated canary', [])
    const observationId = observationIdFor(probe, 3)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Deprecated canary', [
      event({
        type: 'deprecated',
        evidenceToken: 'deprecated-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        reason: 'retired by a later run',
      }),
    ])

    const answer = canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 3)],
    })

    expect(answer).toEqual({
      rows: [{ candidateId, testIndex: 0, stepIndex: 3, observationId }],
      skippedBundles: 0,
    })
  })

  it("another run's committed observation is not this run's — the id is run-scoped", () => {
    const probe = publishCandidate('Other run canary', [])
    const otherRunObservationId = canaryOutcomeObservationId({
      candidateId: probe,
      runId: 'run-B',
      testId: TEST_ID,
      testIndex: 0,
      stepIndex: 2,
    })
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Other run canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'other-run-canary',
        curationJobId: otherRunObservationId,
        buildOrdinal: 5,
        observationId: otherRunObservationId,
        origin: 'agent-verified',
      }),
    ])

    const { rows, skippedBundles } = canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 2)],
    })

    expect(rows[0]!.observationId).toBe(observationIdFor(candidateId, 2))
    expect(rows[0]!.observationId).not.toBe(otherRunObservationId)
    expect(Object.hasOwn(rows[0]!, 'outcome')).toBe(false)
    expect(skippedBundles).toBe(0)
  })

  it('a candidate with no bundle on disk answers an unattributed row, never a throw', () => {
    publishCandidate('Present canary', [])
    const missing = asRecordId('fact-el-button-never-committed-0000000000000000')

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(missing, 7)],
    })).toEqual({
      rows: [
        {
          candidateId: missing,
          testIndex: 0,
          stepIndex: 7,
          observationId: observationIdFor(missing, 7),
        },
      ],
      skippedBundles: 0,
    })
  })

  it('answers one row per tuple, in the order the caller asked, for the same candidate', () => {
    const probe = publishCandidate('Two step canary', [])
    const first = observationIdFor(probe, 0)
    const second = observationIdFor(probe, 1)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Two step canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'two-step-first',
        curationJobId: first,
        buildOrdinal: 5,
        observationId: first,
        origin: 'agent-verified',
      }),
      event({
        type: 'harmful',
        evidenceToken: 'two-step-second',
        curationJobId: second,
        buildOrdinal: 6,
        observationId: second,
        origin: 'agent-observed',
      }),
    ])

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 1), tupleFor(candidateId, 0)],
    })).toEqual({
      rows: [
        { candidateId, testIndex: 0, stepIndex: 1, observationId: second, outcome: 'harmful' },
        { candidateId, testIndex: 0, stepIndex: 0, observationId: first, outcome: 'confirmed' },
      ],
      skippedBundles: 0,
    })
  })


  it('a malformed bundle beside a healthy one is skipped, and the healthy line is still attributed', () => {
    const probe = publishCandidate('Healthy canary', [])
    const observationId = observationIdFor(probe, 0)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Healthy canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'healthy-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        origin: 'agent-verified',
      }),
    ])
    expect(candidateId).toBe(probe)

    // A bundle directory some other process left half-written — one this run never served, never
    // touched, and has no opinion about. Its name sorts BEFORE the healthy bundle's, so the skip is
    // exercised on the way to the line under test rather than harmlessly after it. Before 407-14
    // this single unparseable file made the WHOLE Knowledge tab read `read_failed`.
    const malformed = join(
      knowledgeRoot,
      'memory',
      'shop',
      'bundles',
      'aaa-malformed-0000000000000000',
    )
    mkdirSync(malformed, { recursive: true })
    writeFileSync(join(malformed, 'manifest.json'), '{ not json', 'utf8')

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 0)],
    })).toEqual({
      rows: [{ candidateId, testIndex: 0, stepIndex: 0, observationId, outcome: 'confirmed' }],
      skippedBundles: 1,
    })
  })

  it('an integrity-tampered sibling is skipped the same way, and counted', () => {
    const probe = publishCandidate('Tamper survivor', [])
    const observationId = observationIdFor(probe, 1)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Tamper survivor', [
      event({
        type: 'helpful',
        evidenceToken: 'tamper-survivor',
        curationJobId: observationId,
        buildOrdinal: 6,
        observationId,
        origin: 'agent-verified',
      }),
    ])
    expect(candidateId).toBe(probe)

    // The second failure mode `loadMaintenanceBundle` raises: bytes that parse but no longer hash
    // to what the manifest committed. Skipping it is not forgiving the tamper — the maintenance
    // scan next door still refuses to answer for this store; it is refusing to let a tampered
    // record decide whether an UNRELATED, still-verifying line gets its outcome.
    //
    // The skip must be exercised BEFORE the line under test, and `enumerateMaintenanceBundleDirs`
    // sorts by DIRECTORY name — which is content-derived, NOT the anchor's display name. So the
    // published directory is renamed under a controlled `aaa-` prefix and this cell ASSERTS it
    // now sorts first, instead of assuming an ordering nothing establishes.
    const sibling = publishCandidateEntry('Tampered sibling', [])
    const bundlesDir = dirname(sibling.dir)
    const tamperedName = `aaa-tampered-${basename(sibling.dir).slice(-16)}`
    renameSync(sibling.dir, join(bundlesDir, tamperedName))
    expect(readdirSync(bundlesDir).sort()[0]).toBe(tamperedName)

    const recordPath = join(bundlesDir, tamperedName, 'record.md')
    writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')}\nunauthorized mutation\n`, 'utf8')

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 1)],
    })).toEqual({
      rows: [{ candidateId, testIndex: 0, stepIndex: 1, observationId, outcome: 'helpful' }],
      skippedBundles: 1,
    })
  })

  it('TWO unloadable siblings are counted TWICE — the skip is a count, not a boolean', () => {
    const probe = publishCandidate('Counted canary', [])
    const observationId = observationIdFor(probe, 2)
    rmSync(knowledgeRoot, { recursive: true, force: true })
    const candidateId = publishCandidate('Counted canary', [
      event({
        type: 'confirmed',
        evidenceToken: 'counted-canary',
        curationJobId: observationId,
        buildOrdinal: 5,
        observationId,
        origin: 'agent-verified',
      }),
    ])
    expect(candidateId).toBe(probe)

    // A caller deciding how loudly to qualify its answer needs to know HOW MUCH of the store went
    // unread, not merely that something did — so the walk reports a count, not a flag.
    for (const name of ['aaa-malformed-0000000000000000', 'aab-malformed-0000000000000001']) {
      const dir = join(knowledgeRoot, 'memory', 'shop', 'bundles', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), '{ not json', 'utf8')
    }

    expect(canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor(candidateId, 2)],
    })).toEqual({
      rows: [{ candidateId, testIndex: 0, stepIndex: 2, observationId, outcome: 'confirmed' }],
      skippedBundles: 2,
    })
  })

  it('an empty tuple list answers no rows and no skips WITHOUT walking the store', () => {
    // A store the walker cannot read: the empty-tuple answer is only honest if it never looked.
    mkdirSync(join(knowledgeRoot, 'memory'), { recursive: true })
    writeFileSync(join(knowledgeRoot, 'memory', 'shop'), 'not a directory', 'utf8')

    expect(canaryAttributionsFor({ knowledgeRoot, runId: RUN_ID, tuples: [] })).toEqual({
      rows: [],
      skippedBundles: 0,
    })
    expect(() => canaryAttributionsFor({
      knowledgeRoot,
      runId: RUN_ID,
      tuples: [tupleFor('fact-anything', 0)],
    })).toThrow(/scan incomplete/i)
  })
})
