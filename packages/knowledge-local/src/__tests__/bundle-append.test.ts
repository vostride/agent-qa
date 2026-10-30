import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  committedFileText,
  foldMeasurements,
  guardBundleManifest,
  guardBundleRelations,
} from '@vostride/agent-qa-schema'
import type {
  BundleOutcomeEvent,
  BundleRelation,
  MeasurementBaseline,
  MeasurementObservation,
  RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MEASUREMENTS_REL_PATH,
  appendMeasurementObservation,
  appendOutcomeEvent,
  appendOutcomeEventWithEnrichment,
  appendRelation,
  type AppendOutcome,
  writeMeasurementBaseline,
} from '../bundle-append.js'
import { loadBundle, readMeasurements } from '../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../bundle-publish.test-helper.js'
import {
  commitBundleMutation,
  recoverExpiredBundleMutations,
} from '../journal/bundle-mutation.js'
import {
  listCurationEffectReceipts,
  receiptForEffect,
  writeCurationEffectReceipt,
  type CurationEffect,
  type CurationObservation,
} from '../journal/curation-effect-receipt.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import { purgeRecord } from '../purge.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

const MEASUREMENT_BASELINE: MeasurementBaseline = {
  mu0: 125,
  sigma0: 8,
  n0: 6,
  openedAtOrdinal: 42,
}

function measurementObservation(
  overrides: Partial<MeasurementObservation> = {},
): MeasurementObservation {
  return {
    value: 131,
    buildOrdinal: 43,
    evidenceToken: 'measurement-observation',
    curationJobId: 'measurement-job',
    ...overrides,
  }
}

function event(
  overrides: Partial<Extract<BundleOutcomeEvent, { type: 'confirmed' }>> = {},
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type: 'confirmed',
    evidenceToken: 'append-confirmed',
    curationJobId: 'append-job',
    buildOrdinal: 43,
    origin: 'agent-verified',
    ...overrides,
  })
}

function relation(overrides: Partial<BundleRelation> = {}): BundleRelation {
  return {
    type: 'relates-to',
    targetId: 'fact-target-0123456789abcdef',
    addedAtOrdinal: 43,
    curationJobId: 'append-relation-job',
    ...overrides,
  }
}

describe('bundle append atomic checkpoint units', () => {
  let root: string
  let config: BundleStoreConfig
  let id: RecordId
  let bundleDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-append-'))
    config = {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey: 'Example Store / production',
      writerLeaseId: 'lease-append-fixture',
    }
    const input: PublishBundleInput = {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [
        event({
          evidenceToken: asEvidenceToken('publish-confirmed'),
          curationJobId: 'publish-job',
          buildOrdinal: 42,
        }),
      ],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'append-run',
        testId: 'append-sign-in',
        stepIndex: 0,
        authorship: {
          path: 'deterministic-fallback',
          executionContext: 'local-headless',
        },
        needsEnrichment: true,
      },
      artifacts: [],
    }
    const published = publishBundle(config, input)
    if (published.kind !== 'published') throw new Error('expected fixture bundle publication')
    id = published.id
    bundleDir = published.dir
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function manifest() {
    return guardBundleManifest(
      JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')),
    )
  }

  function mutationDirs(): string[] {
    const stagingRoot = join(bundleDir, '..', '.staging')
    return existsSync(stagingRoot)
      ? readdirSync(stagingRoot).filter((name) => name.includes('-mutation-')).sort()
      : []
  }

  function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  it('stages one complete outcome mutation, applies the manifest last, and removes the journal', () => {
    const replacementOrder: string[] = []
    let durableJournalObserved = false
    config.hooks = {
      afterMutableReplacement(relPath) {
        replacementOrder.push(relPath)
        if (relPath !== 'evidence/outcomes.jsonl') return

        const [transactionName] = mutationDirs()
        expect(transactionName).toMatch(/^lease-append-fixture-mutation-/)
        const transactionDir = join(bundleDir, '..', '.staging', transactionName!)
        const journal = JSON.parse(
          readFileSync(join(transactionDir, 'mutation.json'), 'utf8'),
        ) as {
          leaseId: string
          bundleId: string
          replacements: {
            targetRelPath: string
            recoveryRelPath: string
            sha256: string
            manifest: boolean
          }[]
        }
        expect(journal).toMatchObject({
          leaseId: config.writerLeaseId,
          bundleId: id,
        })
        expect(journal.replacements.map(({ targetRelPath, manifest }) => ({
          targetRelPath,
          manifest,
        }))).toEqual([
          { targetRelPath: 'evidence/outcomes.jsonl', manifest: false },
          { targetRelPath: 'manifest.json', manifest: true },
        ])
        for (const replacement of journal.replacements) {
          expect(
            sha256(readFileSync(join(transactionDir, replacement.recoveryRelPath))),
          ).toBe(replacement.sha256)
        }
        durableJournalObserved = true
      },
    }

    expect(appendOutcomeEvent(config, id, event())).toEqual<AppendOutcome>({
      kind: 'appended',
    })

    expect(durableJournalObserved).toBe(true)
    expect(replacementOrder).toEqual(['evidence/outcomes.jsonl', 'manifest.json'])
    expect(mutationDirs()).toEqual([])
  })

  it('retains every immutable recovery payload when enrichment stops after the first target', () => {
    const before = Object.fromEntries(
      ['record.md', 'provenance.json', 'evidence/outcomes.jsonl', 'manifest.json'].map(
        (relPath) => [relPath, readFileSync(join(bundleDir, relPath))],
      ),
    )
    config.hooks = {
      afterMutableReplacement(relPath) {
        if (relPath === 'record.md') throw new Error('injected mutable stop')
      },
    }

    expect(() =>
      appendOutcomeEventWithEnrichment(config, id, event(), {
        summary: 'Capable-model checkout selector',
        body: 'The checkout selector was re-authored from verified evidence.',
        authorship: {
          path: 'llm',
          model: { id: 'capable-curator' },
          executionContext: 'local-interactive',
        },
      }),
    ).toThrow('injected mutable stop')

    expect(readFileSync(join(bundleDir, 'record.md'))).not.toEqual(before['record.md'])
    expect(readFileSync(join(bundleDir, 'provenance.json'))).toEqual(before['provenance.json'])
    expect(readFileSync(join(bundleDir, 'evidence/outcomes.jsonl'))).toEqual(
      before['evidence/outcomes.jsonl'],
    )
    expect(readFileSync(join(bundleDir, 'manifest.json'))).toEqual(before['manifest.json'])

    const [transactionName] = mutationDirs()
    expect(transactionName).toMatch(/^lease-append-fixture-mutation-/)
    const transactionDir = join(bundleDir, '..', '.staging', transactionName!)
    const journal = JSON.parse(
      readFileSync(join(transactionDir, 'mutation.json'), 'utf8'),
    ) as {
      replacements: {
        targetRelPath: string
        recoveryRelPath: string
        sha256: string
        manifest: boolean
      }[]
    }
    expect(journal.replacements.map(({ targetRelPath }) => targetRelPath)).toEqual([
      'record.md',
      'provenance.json',
      'evidence/outcomes.jsonl',
      'manifest.json',
    ])
    for (const replacement of journal.replacements) {
      const recoveryBytes = readFileSync(join(transactionDir, replacement.recoveryRelPath))
      expect(sha256(recoveryBytes)).toBe(replacement.sha256)
    }
  })

  it('writes the immutable measurement baseline once and refuses any overwrite', () => {
    const measurementsPath = join(bundleDir, MEASUREMENTS_REL_PATH)

    expect(writeMeasurementBaseline(config, id, MEASUREMENT_BASELINE)).toEqual<AppendOutcome>({
      kind: 'appended',
    })
    expect(readFileSync(measurementsPath, 'utf8')).toBe(
      `${canonicalJson(MEASUREMENT_BASELINE)}\n`,
    )
    const measurementsBefore = readFileSync(measurementsPath)
    const manifestBefore = readFileSync(join(bundleDir, 'manifest.json'))

    expect(
      writeMeasurementBaseline(config, id, {
        ...MEASUREMENT_BASELINE,
        mu0: 999,
      }),
    ).toEqual<AppendOutcome>({ kind: 'duplicate' })
    expect(readFileSync(measurementsPath)).toEqual(measurementsBefore)
    expect(readFileSync(join(bundleDir, 'manifest.json'))).toEqual(manifestBefore)
  })

  it('appends strict measurement observations and reads the stream in append order', () => {
    const persistedBaseline: MeasurementBaseline = {
      ...MEASUREMENT_BASELINE,
      mu0: 10,
    }
    const first = measurementObservation({ value: 20 })
    const second = measurementObservation({
      value: 0,
      buildOrdinal: 44,
      evidenceToken: 'measurement-observation-2',
      curationJobId: 'measurement-job-2',
    })
    expect(readMeasurements(bundleDir)).toBeUndefined()
    expect(appendMeasurementObservation(config, id, first)).toEqual<AppendOutcome>({
      kind: 'not-found',
    })
    expect(writeMeasurementBaseline(config, id, persistedBaseline)).toEqual<AppendOutcome>({
      kind: 'appended',
    })

    expect(appendMeasurementObservation(config, id, first)).toEqual<AppendOutcome>({
      kind: 'appended',
    })
    expect(appendMeasurementObservation(config, id, second)).toEqual<AppendOutcome>({
      kind: 'appended',
    })
    const measurements = readMeasurements(bundleDir)
    expect(measurements).toEqual({
      baseline: persistedBaseline,
      observations: [first, second],
    })
    expect(measurements?.observations.map(({ value }) => value)).toEqual([20, 0])
    const folded = foldMeasurements(measurements!.baseline, measurements!.observations)
    expect(folded.ewma).toBeCloseTo(9.6, 12)
    expect(folded.mean).toBe(10)

    writeFileSync(
      join(bundleDir, MEASUREMENTS_REL_PATH),
      `${canonicalJson(persistedBaseline)}\n${canonicalJson(first)}\n{"value":"bad"}\n`,
      'utf8',
    )
    expect(() => readMeasurements(bundleDir)).toThrow()
  })

  it('advances mutable state without changing bundle identity on a measurement append', () => {
    expect(writeMeasurementBaseline(config, id, MEASUREMENT_BASELINE)).toEqual<AppendOutcome>({
      kind: 'appended',
    })
    const before = manifest()

    expect(
      appendMeasurementObservation(config, id, measurementObservation()),
    ).toEqual<AppendOutcome>({ kind: 'appended' })

    const after = manifest()
    expect(after.contentHashes[MEASUREMENTS_REL_PATH]).not.toBe(
      before.contentHashes[MEASUREMENTS_REL_PATH],
    )
    expect(after.mutableStateHash).not.toBe(before.mutableStateHash)
    expect({ id: after.id, identityHash: after.identityHash }).toEqual({
      id: before.id,
      identityHash: before.identityHash,
    })
  })

  it('recovers a crashed measurement append byte-identically and keeps second recovery inert', () => {
    const persistedBaseline: MeasurementBaseline = {
      ...MEASUREMENT_BASELINE,
      mu0: 10,
    }
    const firstObservation = measurementObservation({ value: 20 })
    const secondObservation = measurementObservation({
      value: 0,
      buildOrdinal: 44,
      evidenceToken: 'measurement-observation-2',
      curationJobId: 'measurement-job-2',
    })
    expect(writeMeasurementBaseline(config, id, persistedBaseline)).toEqual<AppendOutcome>({
      kind: 'appended',
    })
    expect(
      appendMeasurementObservation(config, id, firstObservation),
    ).toEqual<AppendOutcome>({ kind: 'appended' })
    config.hooks = {
      afterMutableReplacement(relPath) {
        if (relPath === MEASUREMENTS_REL_PATH) {
          throw new Error('injected measurement append stop')
        }
      },
    }

    expect(() => appendMeasurementObservation(config, id, secondObservation)).toThrow(
      'injected measurement append stop',
    )
    const [transactionName] = mutationDirs()
    const transactionDir = join(bundleDir, '..', '.staging', transactionName!)
    const journal = JSON.parse(
      readFileSync(join(transactionDir, 'mutation.json'), 'utf8'),
    ) as { replacements: { targetRelPath: string }[] }
    expect(journal.replacements.map(({ targetRelPath }) => targetRelPath)).toEqual([
      MEASUREMENTS_REL_PATH,
      'manifest.json',
    ])

    config.hooks = undefined
    expect(
      recoverExpiredBundleMutations(config.knowledgeRoot, [config.writerLeaseId!]),
    ).toEqual({ mutationsRecovered: 1, recoveredBundleIds: [id] })
    const recoveredMeasurements = readMeasurements(bundleDir)
    expect(recoveredMeasurements).toEqual({
      baseline: persistedBaseline,
      observations: [firstObservation, secondObservation],
    })
    const recoveredFold = foldMeasurements(
      recoveredMeasurements!.baseline,
      recoveredMeasurements!.observations,
    )
    expect(recoveredFold.ewma).toBeCloseTo(9.6, 12)
    expect(recoveredFold.mean).toBe(10)
    const firstRecoveryBytes = {
      measurements: readFileSync(join(bundleDir, MEASUREMENTS_REL_PATH)),
      manifest: readFileSync(join(bundleDir, 'manifest.json')),
    }

    expect(
      recoverExpiredBundleMutations(config.knowledgeRoot, [config.writerLeaseId!]),
    ).toEqual({ mutationsRecovered: 0, recoveredBundleIds: [] })
    expect(readFileSync(join(bundleDir, MEASUREMENTS_REL_PATH))).toEqual(
      firstRecoveryBytes.measurements,
    )
    expect(readFileSync(join(bundleDir, 'manifest.json'))).toEqual(
      firstRecoveryBytes.manifest,
    )
    const secondRecoveryMeasurements = readMeasurements(bundleDir)
    expect(foldMeasurements(
      secondRecoveryMeasurements!.baseline,
      secondRecoveryMeasurements!.observations,
    )).toEqual(recoveredFold)
  })

  it('rejects traversal and unexpected mutable targets before changing canonical bytes', () => {
    const recordBefore = readFileSync(join(bundleDir, 'record.md'))
    const manifestBefore = readFileSync(join(bundleDir, 'manifest.json'))
    const baseInput = {
      knowledgeRoot: config.knowledgeRoot,
      bundleDir,
      bundleId: id,
      writerLeaseId: config.writerLeaseId!,
    }

    expect(() =>
      commitBundleMutation({
        ...baseInput,
        replacements: [
          { targetRelPath: '../record.md', text: 'escaped' },
          { targetRelPath: 'manifest.json', text: manifestBefore.toString('utf8') },
        ],
      }),
    ).toThrow()
    expect(() =>
      commitBundleMutation({
        ...baseInput,
        replacements: [
          { targetRelPath: MEASUREMENTS_REL_PATH, text: 'first' },
          { targetRelPath: MEASUREMENTS_REL_PATH, text: 'duplicate' },
          { targetRelPath: 'manifest.json', text: manifestBefore.toString('utf8') },
        ],
      }),
    ).toThrow('duplicate mutable bundle target')
    expect(() =>
      commitBundleMutation({
        ...baseInput,
        replacements: [
          { targetRelPath: 'notes.txt', text: 'unexpected' },
          { targetRelPath: 'manifest.json', text: manifestBefore.toString('utf8') },
        ],
      }),
    ).toThrow()

    expect(readFileSync(join(bundleDir, 'record.md'))).toEqual(recordBefore)
    expect(readFileSync(join(bundleDir, 'manifest.json'))).toEqual(manifestBefore)
    expect(mutationDirs()).toEqual([])
  })

  it('appends exactly one canonical event and advances only mutable identity', () => {
    const appendedEvent = event()
    const outcomesPath = join(bundleDir, 'evidence', 'outcomes.jsonl')
    const outcomesBefore = readFileSync(outcomesPath, 'utf8')
    const manifestBefore = manifest()

    expect(appendOutcomeEvent(config, id, appendedEvent)).toEqual<AppendOutcome>({
      kind: 'appended',
    })

    const outcomesAfter = readFileSync(outcomesPath, 'utf8')
    const manifestAfter = manifest()
    expect(outcomesAfter).toBe(`${outcomesBefore}${canonicalJson(appendedEvent)}\n`)
    expect(manifestAfter.contentHashes['evidence/outcomes.jsonl']).not.toBe(
      manifestBefore.contentHashes['evidence/outcomes.jsonl'],
    )
    expect(manifestAfter.mutableStateHash).not.toBe(manifestBefore.mutableStateHash)
    expect({
      id: manifestAfter.id,
      identityHash: manifestAfter.identityHash,
      complete: manifestAfter.complete,
      evidenceIncomplete: manifestAfter.evidenceIncomplete,
    }).toEqual({
      id: manifestBefore.id,
      identityHash: manifestBefore.identityHash,
      complete: manifestBefore.complete,
      evidenceIncomplete: manifestBefore.evidenceIncomplete,
    })
    expect(readdirSync(join(bundleDir, 'evidence')).some((name) => name.includes('.tmp'))).toBe(
      false,
    )
    expect(readdirSync(bundleDir).some((name) => name.includes('.tmp'))).toBe(false)
  })

  it('returns duplicate without changing event-log or manifest bytes', () => {
    const duplicate = event({
      evidenceToken: asEvidenceToken('publish-confirmed'),
      curationJobId: 'publish-job',
      buildOrdinal: 999,
    })
    const outcomesPath = join(bundleDir, 'evidence', 'outcomes.jsonl')
    const manifestPath = join(bundleDir, 'manifest.json')
    const outcomesBefore = readFileSync(outcomesPath)
    const manifestBefore = readFileSync(manifestPath)

    expect(appendOutcomeEvent(config, id, duplicate)).toEqual<AppendOutcome>({
      kind: 'duplicate',
    })
    expect(readFileSync(outcomesPath)).toEqual(outcomesBefore)
    expect(readFileSync(manifestPath)).toEqual(manifestBefore)
  })

  it('appends and deduplicates relations with the pinned relation key', () => {
    const relationsPath = join(bundleDir, 'relations.json')
    const manifestPath = join(bundleDir, 'manifest.json')
    const first = relation()

    expect(appendRelation(config, id, first)).toEqual<AppendOutcome>({ kind: 'appended' })
    const parsed = guardBundleRelations(JSON.parse(readFileSync(relationsPath, 'utf8')))
    expect(parsed.relations).toEqual([first])
    const relationsAfterAppend = readFileSync(relationsPath)
    const manifestAfterAppend = readFileSync(manifestPath)

    expect(
      appendRelation(
        config,
        id,
        relation({ addedAtOrdinal: 999 }),
      ),
    ).toEqual<AppendOutcome>({ kind: 'duplicate' })
    expect(readFileSync(relationsPath)).toEqual(relationsAfterAppend)
    expect(readFileSync(manifestPath)).toEqual(manifestAfterAppend)
    expect(mutationDirs()).toEqual([])
  })

  it('treats missing and incomplete bundles as not found', () => {
    expect(
      appendOutcomeEvent(config, asRecordId('missing-bundle'), event()),
    ).toEqual<AppendOutcome>({ kind: 'not-found' })

    const manifestPath = join(bundleDir, 'manifest.json')
    writeFileSync(manifestPath, committedFileText({ ...manifest(), complete: false }))
    const manifestBefore = readFileSync(manifestPath)
    const outcomesPath = join(bundleDir, 'evidence', 'outcomes.jsonl')
    const outcomesBefore = readFileSync(outcomesPath)

    expect(appendOutcomeEvent(config, id, event())).toEqual<AppendOutcome>({
      kind: 'not-found',
    })
    expect(readFileSync(manifestPath)).toEqual(manifestBefore)
    expect(readFileSync(outcomesPath)).toEqual(outcomesBefore)
    expect(existsSync(join(bundleDir, 'manifest.json.tmp'))).toBe(false)
  })
})

describe('committed records with credential-shaped text', () => {
  const SUMMARY = 'Pay with card 4242 4242 4242 4242 at checkout'
  const BODY = 'Send Bearer abc123def456ghi789 with key AKIAIOSFODNN7EXAMPLE, then mail qa@example.com.'
  let root: string
  let knowledgeRoot: string
  let config: BundleStoreConfig

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-committed-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    config = { knowledgeRoot, productKey: 'Example Store / production' }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publishFixture(text: { summary: string; body: string }, needsEnrichment: boolean) {
    const published = publishBundle(config, {
      draft: makeBundleDraftFixture(text),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: needsEnrichment ? 'Enrich' : 'Pay' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'committed-run',
        testId: 'committed-test',
        stepIndex: 0,
        ...(needsEnrichment
          ? {
              authorship: { path: 'deterministic-fallback', executionContext: 'local-headless' },
              needsEnrichment: true,
            }
          : {}),
      },
      artifacts: [],
    })
    if (published.kind !== 'published') throw new Error(`expected publication, got ${published.kind}`)
    return published
  }

  function loaded(dir: string) {
    const outcome = loadBundle(dir)
    if (outcome.kind !== 'loaded') throw new Error(`expected a loaded bundle, got ${outcome.kind}`)
    return outcome.bundle
  }

  it('a bundle with credential-shaped text is committed as written', () => {
    const published = publishFixture({ summary: SUMMARY, body: BODY }, false)
    expect(loaded(published.dir)).toMatchObject({ summary: SUMMARY, body: BODY })
    expect(readFileSync(join(published.dir, 'record.md'), 'utf8')).toContain(BODY)

    const enrichable = publishFixture(
      { summary: 'Sign in control', body: 'Sign in with the recorded account.' },
      true,
    )
    const enriched = appendOutcomeEventWithEnrichment(config, enrichable.id, event(), {
      summary: SUMMARY,
      body: BODY,
      authorship: { path: 'deterministic-fallback', executionContext: 'local-headless' },
    })
    expect(enriched).toEqual({ kind: 'appended', enriched: true })
    expect(loaded(enrichable.dir)).toMatchObject({ summary: SUMMARY, body: BODY })

    const deprecated = BundleOutcomeEventSchema.parse({
      type: 'deprecated',
      evidenceToken: 'committed-deprecated',
      curationJobId: 'committed-job',
      buildOrdinal: 43,
      reason: BODY,
    })
    expect(appendOutcomeEvent(config, published.id, deprecated)).toEqual({ kind: 'appended' })
    expect(readFileSync(join(published.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(
      `${canonicalJson(deprecated)}\n`,
    )
  })

  it('a purge receipt and a curation effect receipt with the same text are written', () => {
    const published = publishFixture({ summary: SUMMARY, body: BODY }, false)
    const purged = purgeRecord({
      knowledgeRoot,
      recordId: published.id,
      initiator: BODY,
      purgedAtOrdinal: 43,
    })
    if (purged.kind !== 'purged') throw new Error(`expected a purge, got ${purged.kind}`)
    expect(purged.receipt.initiator).toBe(BODY)
    expect(
      readFileSync(join(knowledgeRoot, 'memory', 'receipts', `purge-${published.id}.json`), 'utf8'),
    ).toContain(BODY)

    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error(`expected a writer lease, got ${lease.kind}`)
    const effect: CurationEffect = {
      recordId: published.id,
      product: 'Example Store / production',
      change: 'added',
      atOrdinal: 42,
      evidenceToken: BODY,
    }
    const observation: CurationObservation = {
      schemaVersion: 2,
      sourceRunId: 'committed-run',
      observationId: 'committed-observation',
      originalDeltaKind: 'Supersede',
      appliedDeltaKind: 'Add',
      disposition: 'downgraded',
      downgradeReason: SUMMARY,
      effects: [effect],
    }
    const receipt = receiptForEffect('a'.repeat(64), observation, effect)
    writeCurationEffectReceipt({
      knowledgeRoot,
      authority: { leaseId: lease.leaseId, epoch: lease.epoch },
      receipt,
    })
    expect(listCurationEffectReceipts(knowledgeRoot)).toEqual([receipt])
    expect(receipt).toMatchObject({ evidenceToken: BODY, downgradeReason: SUMMARY })
  })
})
