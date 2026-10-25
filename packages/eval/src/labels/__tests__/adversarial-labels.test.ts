/**
 * 422-02-T2 — derived labels and generator metadata through the STRICT readers.
 *
 * The derived label is where D-06 either holds or quietly stops holding. Three properties,
 * each of which has a way of failing silently:
 *
 *   1. The clone is the seed's gold. Channel, tier, the executable correction and the run
 *      provenance travel unchanged; only the cassette identity and the receipt digest — the
 *      two facts that describe the DERIVED bytes — are reassigned. A clone that re-derived
 *      the provenance would quietly re-home the label onto the derivation's own run, and
 *      ROOT-03 would stop excluding the run that bred it.
 *   2. Old bytes still read. Every pre-422 record and every pre-422 adversarial entry parses
 *      byte-for-byte as before, because the additive fields are optional at the arm.
 *   3. New bytes read COMPLETELY or not at all. A `derivedFrom` marker is minted by the
 *      engine, never inherited from history, so a partial marker is malformed rather than
 *      "an old record" — and the reader must say so instead of fabricating the absent field.
 */
import { describe, expect, it } from 'vitest'
import { asRef, sha256hex } from '@vostride/agent-qa-schema'
import {
  FIXTURE_REFS,
  makeAdversarialSeedFixture,
} from '../../adversarial/__tests__/fixtures'
import { generateAdversarialVariants } from '../../adversarial/generate'
import type { AdversarialVariant } from '../../adversarial/generate'
import { ADVERSARIAL_TABLE_HASH, ADVERSARIAL_TABLE_VERSION } from '../../adversarial/tables'
import { canonicalJson } from '../../canonical-json'
import { selectGateSet } from '../../gate/gate-set'
import { CORPUS_ENTRY_SCHEMA_VERSION } from '../corpus-entry'
import type { CorpusEntry } from '../corpus-entry'
import { parseCorpusEntry } from '../corpus-entry-guard'
import { effectiveGold } from '../effective-gold'
import type { GoldMark } from '../golden-plan'
import { parseStandaloneLabelRecord } from '../effective-labels'
import {
  LABEL_RECORD_SCHEMA_VERSION,
  deriveAdversarialLabel,
  projectSilverLabelRecord,
  projectUserMarkLabelRecord,
} from '../label-record'
import type { StandaloneLabelRecord } from '../label-record'

const CORRECTED_EXPECTATION = 'The checkout should have stayed blocked'

function seedFixture(runId?: string) {
  return makeAdversarialSeedFixture({
    ...(runId === undefined ? {} : { runId }),
    names: { [FIXTURE_REFS.status]: 'Saved item' },
  })
}

/** A user-gold record carrying an EXECUTABLE correction — the strongest seed gold there is. */
function userGoldSeedLabel(seed: ReturnType<typeof seedFixture>): StandaloneLabelRecord {
  const mark: GoldMark = {
    kind: 'false-pass',
    markId: 'mark_0123456789ab',
    correctedExpectation: CORRECTED_EXPECTATION,
    correctedAction: { type: 'click', ref: asRef(FIXTURE_REFS.siblingButton) },
  } as GoldMark
  return projectUserMarkLabelRecord({
    cassette: seed.cassette,
    runId: seed.runId,
    goldCassetteId: seed.cassette.id,
    mark,
  })
}

/** A recorded-verdict silver record that later acquired a correction. */
function correctedSilverSeedLabel(seed: ReturnType<typeof seedFixture>): StandaloneLabelRecord {
  const silver = projectSilverLabelRecord({ cassette: seed.cassette, runId: seed.runId })
  return {
    ...silver,
    correction: {
      verdict: 'fail',
      overturnedVerdict: { ...seed.cassette.label.verdict! },
      correctedExpectation: CORRECTED_EXPECTATION,
      correctedAction: { type: 'click', ref: asRef(FIXTURE_REFS.siblingButton) },
      markId: 'mark_ba9876543210',
    },
  }
}

function deriveOne(
  seed: ReturnType<typeof seedFixture>,
  label: StandaloneLabelRecord,
): AdversarialVariant {
  const result = generateAdversarialVariants({
    product: 'fixture',
    seeds: [{ cassette: seed.cassette, entry: seed.entry, label }],
    mutators: ['confusable'],
  })
  const variant = result.variants[0]
  if (variant === undefined) throw new Error('fixture seed derived no confusable variant')
  return variant
}

describe('422-02 derived label cloning', () => {
  it('carries a user-gold seed correction, channel, tier and run provenance onto the clone', () => {
    const seed = seedFixture()
    const seedLabel = userGoldSeedLabel(seed)
    const variant = deriveOne(seed, seedLabel)
    const clone = variant.labelRecord

    expect(clone.schemaVersion).toBe(LABEL_RECORD_SCHEMA_VERSION)
    expect(clone.label).toEqual(seedLabel.label)
    expect(clone.label.sourceChannel).toBe('user-mark')
    expect(clone.label.tier).toBe('gold')
    expect(clone.correction).toEqual(seedLabel.correction)

    // Identity and receipt digest are the DERIVED facts; everything else is the seed's.
    expect(clone.cassetteId).toBe(variant.cassette.id)
    expect(clone.provenance.receiptDigest).toBe(sha256hex(canonicalJson(variant.cassette.receipt)))
    expect(clone.provenance.receiptDigest).not.toBe(seedLabel.provenance.receiptDigest)
    expect(clone.provenance.runId).toBe(seedLabel.provenance.runId)
    expect(clone.provenance.runSlug).toBe(seedLabel.provenance.runSlug)
    expect(clone.provenance.capturedAtOrdinal).toBe(seedLabel.provenance.capturedAtOrdinal)
    expect(clone.provenance.sourceCassetteId).toBe(seed.cassette.id)

    // The derived marker is COMPLETE — the engine minted it, so nothing about it is historical.
    expect(clone.derivedFrom).toEqual({
      seedCassetteId: seed.cassette.id,
      generator: {
        kind: 'fuzz-label',
        seedCassetteId: seed.cassette.id,
        generatorVersion: variant.generator.generatorVersion,
        mutator: 'confusable',
        tableVersion: ADVERSARIAL_TABLE_VERSION,
        tableHash: ADVERSARIAL_TABLE_HASH,
      },
    })
  })

  it('carries a corrected silver seed without promoting its channel or tier', () => {
    const seed = seedFixture()
    const seedLabel = correctedSilverSeedLabel(seed)
    const clone = deriveOne(seed, seedLabel).labelRecord

    expect(clone.label.sourceChannel).toBe('recorded-verdict')
    expect(clone.label.tier).toBe('silver')
    expect(clone.correction).toEqual(seedLabel.correction)
    expect(clone.provenance.runId).toBe(seedLabel.provenance.runId)
  })

  it('refuses to clone a label that does not belong to the named seed', () => {
    const seed = seedFixture()
    const other = seedFixture('run / some other checkout 9')
    expect(() =>
      deriveAdversarialLabel({
        cassette: seed.cassette,
        seedLabel: projectSilverLabelRecord({ cassette: other.cassette, runId: other.runId }),
        generator: {
          kind: 'fuzz-label',
          seedCassetteId: seed.cassette.id,
          generatorVersion: 2,
          mutator: 'confusable',
          tableVersion: ADVERSARIAL_TABLE_VERSION,
          tableHash: ADVERSARIAL_TABLE_HASH,
        },
      }),
    ).toThrow(/seed label/i)
  })

  it('refuses to mint a derived marker from incomplete generator metadata', () => {
    const seed = seedFixture()
    expect(() =>
      deriveAdversarialLabel({
        cassette: seed.cassette,
        seedLabel: projectSilverLabelRecord({ cassette: seed.cassette, runId: seed.runId }),
        generator: { kind: 'fuzz-label', seedCassetteId: seed.cassette.id, generatorVersion: 2 },
      }),
    ).toThrow(/generator metadata/i)
  })
})

describe('422-02 strict reader round trips', () => {
  it('round-trips a derived record through the committed reader unchanged', () => {
    const seed = seedFixture()
    const clone = deriveOne(seed, userGoldSeedLabel(seed)).labelRecord
    const parsed = parseStandaloneLabelRecord(JSON.parse(JSON.stringify(clone)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.issues)
    expect(canonicalJson(parsed.record)).toBe(canonicalJson(clone))
    expect(parsed.record.derivedFrom).toEqual(clone.derivedFrom)
  })

  it('reads a pre-422 record with no additions byte-for-byte', () => {
    const seed = seedFixture()
    const legacy = projectSilverLabelRecord({ cassette: seed.cassette, runId: seed.runId })
    expect(Object.hasOwn(legacy, 'derivedFrom')).toBe(false)
    const parsed = parseStandaloneLabelRecord(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.issues)
    expect(canonicalJson(parsed.record)).toBe(canonicalJson(legacy))
    expect(Object.hasOwn(parsed.record, 'derivedFrom')).toBe(false)
  })

  it('refuses every malformed derived marker instead of fabricating the absent value', () => {
    const seed = seedFixture()
    const clone = deriveOne(seed, userGoldSeedLabel(seed)).labelRecord
    const derivedFrom = clone.derivedFrom!
    const broken: readonly Record<string, unknown>[] = [
      // An unknown family.
      { ...derivedFrom, generator: { ...derivedFrom.generator, mutator: 'not-a-family' } },
      // A table hash that is not a digest.
      { ...derivedFrom, generator: { ...derivedFrom.generator, tableHash: 'nope' } },
      // Partial metadata: the engine always mints all three together.
      { ...derivedFrom, generator: { ...omit(derivedFrom.generator, 'tableVersion') } },
      { ...derivedFrom, generator: { ...omit(derivedFrom.generator, 'mutator') } },
      { ...derivedFrom, generator: { ...omit(derivedFrom.generator, 'tableHash') } },
      // A marker whose two seed identities disagree — provenance that cannot both be true.
      { ...derivedFrom, seedCassetteId: 'some-other-seed' },
      // An unknown key.
      { ...derivedFrom, note: 'smuggled' },
    ]
    for (const candidate of broken) {
      const parsed = parseStandaloneLabelRecord({ ...clone, derivedFrom: candidate })
      expect(parsed.ok).toBe(false)
    }
  })
})

describe('422-02 corpus generator metadata admission', () => {
  const seed = seedFixture()
  const derived = deriveOne(seed, userGoldSeedLabel(seed))

  it('admits complete generator metadata and keeps the corpus schema at 2', () => {
    const parsed = parseCorpusEntry(JSON.parse(JSON.stringify(derived.corpusEntry)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.issues)
    expect(parsed.schemaVersion).toBe(CORPUS_ENTRY_SCHEMA_VERSION)
    expect(canonicalJson(parsed.entry)).toBe(canonicalJson(derived.corpusEntry))
  })

  it('admits a pre-422 adversarial entry that names none of the additive fields', () => {
    const legacy = {
      ...derived.corpusEntry,
      generator: {
        kind: derived.corpusEntry.generator.kind,
        seedCassetteId: derived.corpusEntry.generator.seedCassetteId,
        generatorVersion: derived.corpusEntry.generator.generatorVersion,
      },
    }
    const parsed = parseCorpusEntry(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.issues)
    expect(canonicalJson(parsed.entry)).toBe(canonicalJson(legacy))
  })

  it('refuses partial generator metadata with an issue naming the generator', () => {
    for (const dropped of ['mutator', 'tableVersion', 'tableHash'] as const) {
      const partial = {
        ...derived.corpusEntry,
        generator: omit(derived.corpusEntry.generator, dropped),
      }
      const parsed = parseCorpusEntry(JSON.parse(JSON.stringify(partial)))
      expect(parsed.ok).toBe(false)
      if (parsed.ok) throw new Error('partial generator metadata was admitted')
      expect(parsed.issues).toContain('generator')
    }
  })
})

describe('422-02 the derived label is scoring-only and still excluded from its own gate', () => {
  it('keeps the corrected gold out of the planner input while effectiveGold still serves it', () => {
    const seed = seedFixture()
    const seedLabel = userGoldSeedLabel(seed)
    const variant = deriveOne(seed, seedLabel)

    // The planner's diet is the CAPTURED decision: no corrected expectation anywhere in it.
    expect(canonicalJson(variant.cassette.input)).not.toContain(CORRECTED_EXPECTATION)
    expect(canonicalJson(variant.cassette.sidecar)).not.toContain(CORRECTED_EXPECTATION)
    expect(variant.cassette.sidecar.goldAction).toEqual(seed.cassette.sidecar.goldAction)

    // Scoring reads the correction through the one seam that is allowed to.
    const resolved = effectiveGold(variant.cassette, variant.labelRecord)
    expect(resolved.kind).toBe('eligible')
    if (resolved.kind !== 'eligible') throw new Error('derived effective gold refused')
    expect(resolved.cassette.sidecar.goldAction).toEqual(seedLabel.correction!.correctedAction)
    expect(resolved.cassette.label).toEqual(variant.labelRecord.label)
  })

  it('still excludes the breeding run from gating the candidate it bred', () => {
    const seed = seedFixture()
    const variant = deriveOne(seed, userGoldSeedLabel(seed))
    const foreign = seedFixture('run / unrelated gate member 4')
    const entries: readonly CorpusEntry[] = [seed.entry, variant.corpusEntry, foreign.entry]

    const verdict = selectGateSet({
      entries,
      product: 'fixture',
      candidate: {
        runIds: [seed.runId],
        receiptDigests: [],
        capturedAtOrdinals: [],
      },
      minimumGateSet: 1,
    })
    expect(verdict.verdict).toBe('ok')
    if (verdict.verdict !== 'ok') throw new Error('gate set refused')
    expect(verdict.excluded).toContainEqual({
      cassetteId: variant.corpusEntry.cassetteId,
      reason: 'run-contributed',
    })
    expect(verdict.gateEntries.map(entry => entry.cassetteId)).toEqual([
      foreign.entry.cassetteId,
    ])
    expect(verdict.counts.after.adversarial).toBe(0)
  })
})

function omit(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[key]
  return copy
}
