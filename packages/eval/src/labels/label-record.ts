/**
 * LABEL-03 standalone label records (D-01/D-06/D-07/D-09/D-12) — the third
 * module of the D-09 pure label factory.
 *
 * Store law (D-01): `labels/` is the authoritative label store — one
 * standalone record per cassette id reflecting the strongest channel. The
 * cassette's embedded label leg stays exactly as extracted (the as-extracted
 * snapshot and documented fallback); consumers read `labels/` first and fall
 * back to the embedded leg. The extractor's projection is never touched.
 *
 * Tier law (D-12): tier = channel trust, never verdict polarity. Self-heal
 * pair members mint 'near-gold' on both sides; recorded verdicts stay
 * 'silver' whether the verdict is pass or fail (recordedFailure context
 * already preserves the failure detail). No v50 channel mints the reserved
 * top tier — it stays for M3's human-anchored channels (user marks,
 * overturned verdicts). The shipped LabelTier/LabelSourceChannel unions are
 * not extended.
 *
 * Evolution law (D-09): M3's channels land as sibling projection functions
 * on this module and SUPERSEDE records — they never mutate an immutable
 * cassette or an existing record.
 */
import { sha256hex } from '@vostride/agent-qa-schema'
import type { Action } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import type { LeafCassette } from '../cassette/cassette'
import type { CassetteLabelLeg, ContrastivePairing } from '../cassette/label-leg'
import { deriveRunSlug } from '../extract/ids'
import type { MintedContrastivePair } from './pair-matching'
import type { CorpusGenerator } from './corpus-entry'
import type { GoldMark } from './golden-plan'
import { generatorProvenance } from './corpus-entry'

/** Single version gate for the standalone label record document (D-01). */
export const LABEL_RECORD_SCHEMA_VERSION = 2

/** Run-anchored provenance stamped on every standalone record (ROOT-03 base). */
export interface LabelProvenance {
  rerun?: { attempt: number; originalAttempt?: number; originalEvidenceDigest?: string }
  sourceCassetteId?: string
  /** Source run identity as a plain wire string. */
  runId: string
  /** Traversal-safe slug derived from the run id. */
  runSlug: string
  /** Monotonic build ordinal copied from the cassette receipt. */
  capturedAtOrdinal: number
  /** Digest of the canonical-serialized cassette receipt. */
  receiptDigest: string
}

/**
 * Same-observed-state stamp for a contrastive pair member (D-07). Lives on
 * the RECORD — the shipped ContrastivePairing DTO is deliberately not
 * widened (D-06). sameState is stamped from receipt hash equality, never
 * gated: differing-state pairs remain honest recovery evidence.
 */
export interface PairStateStamp {
  /** Whether both pair members observed the same screen state. */
  sameState: boolean
  /** The labeled member's own receipt screen-state hash. */
  screenStateHash: string
  /** The partner member's receipt screen-state hash. */
  pairedScreenStateHash: string
}

/**
 * 2026-09-11, 422 D-06: where a derived adversarial record's gold CAME FROM.
 *
 * ADDITIVE-OPTIONAL on the record, so no `LABEL_RECORD_SCHEMA_VERSION` bump is owed — zero
 * pre-422 records carry it. It is deliberately NOT a fifth `LabelSourceChannel`: the channel
 * and tier of a derived record are the SEED's, unchanged (420 D-01 pinned four channels),
 * because the derivation perturbs the surface and not the evidence that produced the label.
 */
export interface LabelDerivation {
  /** The natural cassette whose gold this record clones. */
  seedCassetteId: string
  /** The generator provenance, identical to the corpus entry's (D-05). */
  generator: CorpusGenerator
}

/** The authoritative `labels/` unit: one standalone record per cassette id (D-01). */
export interface StandaloneLabelRecord {
  revision?: { id: string; predecessorId: string; generationId?: string }
  /** 422 D-06: present only on a derived adversarial record. */
  derivedFrom?: LabelDerivation
  quarantine?: 'rerun-overturned'
  weight?: LabelWeight
  correction?: LabelCorrection
  supersedes?: string
  /** Version gate (D-01). */
  schemaVersion: typeof LABEL_RECORD_SCHEMA_VERSION
  /** Deterministic cassette identity this record labels (D-01). */
  cassetteId: string
  /**
   * A full CassetteLabelLeg (with pairing populated for pair members) so
   * ScoredBatchEntry.label consumers read it unchanged (D-01).
   */
  label: CassetteLabelLeg
  /** D-07 same-state stamp; present only on contrastive pair members. */
  pairState?: PairStateStamp
  /** Run-anchored provenance (ROOT-03 base). */
  provenance: LabelProvenance
}

/** Persisted evidence for the SOFT estimate; consumers never recalculate it. */
export interface LabelWeight {
  value: number
  k: number
  n: number
  verdictSource: 'user-gold' | 'stable-pass-silver' | 'unverified'
  verdictFactor: number
  capabilityTier: 'full' | 'degraded' | 'floor'
  tierFactor: number
  alpha0: number
  beta0: number
  corpusDigest: string
  evidenceDigest: string
  capabilityEvidence: {
    kind: 'model-identity' | 'deterministic' | 'missing'
    modelIdentity?: { provider: string; modelId: string }
  }
}

/** 2026-09-08, 419 D-06: the correction is separate from the observed action and verdict. */
export interface LabelCorrection {
  verdict: 'pass' | 'fail'
  overturnedVerdict: { pass: boolean; reasoning: string }
  correctedExpectation?: string
  correctedAction?: Action
  markId: string
}

export interface ProjectUserMarkLabelRecordInput {
  cassette: LeafCassette
  runId: string
  goldCassetteId: string
  mark: GoldMark
  supersedes?: string
}

export interface ProjectOverturnedVerdictLabelRecordInput extends ProjectUserMarkLabelRecordInput {
  correctedExpectation?: string
}

function recordedVerdict(cassette: LeafCassette): NonNullable<CassetteLabelLeg['verdict']> {
  if (cassette.label.verdict === undefined) {
    throw new Error('gold correction requires a recorded verifier verdict')
  }
  return { ...cassette.label.verdict }
}

export function projectUserMarkLabelRecord({
  cassette, runId, goldCassetteId, mark, supersedes,
}: ProjectUserMarkLabelRecordInput): StandaloneLabelRecord {
  return {
    schemaVersion: LABEL_RECORD_SCHEMA_VERSION,
    cassetteId: goldCassetteId,
    // All three kinds retain the recorded VerifierVerdict. false-fail corrects it
    // to pass separately; confirmed-bug confirms FAIL; false-pass has a sibling correction.
    label: { ...cassette.label, sourceChannel: 'user-mark', tier: 'gold' },
    ...(mark.kind !== 'confirmed-bug' || mark.correctedAction !== undefined || mark.correctedExpectation !== undefined ? {
      correction: { verdict: mark.kind === 'false-fail' ? 'pass' as const : 'fail' as const,
        overturnedVerdict: recordedVerdict(cassette), markId: mark.markId,
        ...(mark.correctedExpectation === undefined ? {} : { correctedExpectation: mark.correctedExpectation }),
        ...(mark.correctedAction === undefined ? {} : { correctedAction: mark.correctedAction }) },
    } : {}),
    ...(supersedes === undefined ? {} : { supersedes }),
    provenance: { ...projectProvenance(cassette, runId), sourceCassetteId: cassette.id },
  }
}

export function projectOverturnedVerdictLabelRecord({
  cassette, runId, goldCassetteId, mark, supersedes,
  correctedExpectation = mark.correctedExpectation,
}: ProjectOverturnedVerdictLabelRecordInput): StandaloneLabelRecord {
  if (mark.kind !== 'false-pass') throw new Error('overturned verdict requires a false-pass mark')
  return {
    schemaVersion: LABEL_RECORD_SCHEMA_VERSION,
    cassetteId: goldCassetteId,
    label: { ...cassette.label, sourceChannel: 'overturned-verdict', tier: 'gold' },
    correction: {
      verdict: 'fail',
      overturnedVerdict: recordedVerdict(cassette),
      ...(correctedExpectation === undefined ? {} : { correctedExpectation }),
      ...(mark.correctedAction === undefined ? {} : { correctedAction: mark.correctedAction }),
      markId: mark.markId,
    },
    ...(supersedes === undefined ? {} : { supersedes }),
    provenance: { ...projectProvenance(cassette, runId), sourceCassetteId: cassette.id },
  }
}

export interface ProjectPairLabelRecordsInput {
  pair: MintedContrastivePair
  failedCassette: LeafCassette
  recoveringCassette: LeafCassette
  runId: string
}

export interface ProjectSilverLabelRecordInput {
  cassette: LeafCassette
  runId: string
}

function projectProvenance(cassette: LeafCassette, runId: string): LabelProvenance {
  return {
    runId,
    runSlug: deriveRunSlug(runId),
    capturedAtOrdinal: cassette.receipt.buildOrdinal,
    receiptDigest: sha256hex(canonicalJson(cassette.receipt)),
  }
}

interface PairMemberInput {
  cassette: LeafCassette
  partnerId: string
  relation: ContrastivePairing['relation']
  ownHash: string
  partnerHash: string
  sameState: boolean
  runId: string
}

function projectPairMember({
  cassette,
  partnerId,
  relation,
  ownHash,
  partnerHash,
  sameState,
  runId,
}: PairMemberInput): StandaloneLabelRecord {
  return {
    schemaVersion: LABEL_RECORD_SCHEMA_VERSION,
    cassetteId: cassette.id,
    label: {
      ...cassette.label,
      sourceChannel: 'self-heal-pair',
      tier: 'near-gold',
      pairing: { pairedCassetteId: partnerId, relation },
    },
    pairState: {
      sameState,
      screenStateHash: ownHash,
      pairedScreenStateHash: partnerHash,
    },
    provenance: projectProvenance(cassette, runId),
  }
}

/**
 * Project a minted contrastive pair into its two near-gold records — failed
 * member first, recovering second. Each record spreads the member's embedded
 * leg (preserving verdict/recordedFailure context, D-12) then stamps the
 * self-heal-pair channel, the near-gold tier, the shipped pairing vocabulary
 * (failed => 'contrastive-negative', recovering => 'contrastive-positive' —
 * the relation describes the LABELED cassette, D-06), and the D-07 pairState.
 */
export function projectPairLabelRecords({
  pair,
  failedCassette,
  recoveringCassette,
  runId,
}: ProjectPairLabelRecordsInput): [StandaloneLabelRecord, StandaloneLabelRecord] {
  return [
    projectPairMember({
      cassette: failedCassette,
      partnerId: recoveringCassette.id,
      relation: 'contrastive-negative',
      ownHash: pair.failedScreenStateHash,
      partnerHash: pair.recoveringScreenStateHash,
      sameState: pair.sameState,
      runId,
    }),
    projectPairMember({
      cassette: recoveringCassette,
      partnerId: failedCassette.id,
      relation: 'contrastive-positive',
      ownHash: pair.recoveringScreenStateHash,
      partnerHash: pair.failedScreenStateHash,
      sameState: pair.sameState,
      runId,
    }),
  ]
}

export interface DeriveAdversarialLabelInput {
  /** The DERIVED cassette this record labels. */
  cassette: LeafCassette
  /** The seed's effective standalone record — its strongest gold. */
  seedLabel: StandaloneLabelRecord
  /** Generator provenance, minted by the pure derivation engine. */
  generator: CorpusGenerator
}

/**
 * 422 D-06: clone a seed's gold onto its derived adversarial cassette.
 *
 * The expectation under a perturbed surface IS the seed's expectation — a planner that
 * changes its decision because a glyph changed, or because an instruction was injected into
 * an accessible name, has regressed. So the label leg, the tier, the source channel and any
 * executable `correction` travel unchanged, and the provenance keeps the SEED's run identity
 * and build ordinal so ROOT-03's "no run that bred a candidate may gate it" exclusion still
 * excludes the breeding run.
 *
 * What does NOT travel: `revision` / `supersedes` (the derived record is a fresh root, not a
 * successor in the seed's history), `quarantine` and `weight` (both are facts measured about
 * the SEED's own evidence), and `pairState` / `label.pairing` (they name a partner cassette
 * that has no derived counterpart — carrying them would point at a sibling that was never
 * derived). `receiptDigest` is recomputed because it describes the derived receipt.
 *
 * The factory is PURE and lives here beside the other projections (v50 D-09): the generator
 * never mints a label, and no channel widening happens anywhere.
 */
export function deriveAdversarialLabel({
  cassette,
  seedLabel,
  generator,
}: DeriveAdversarialLabelInput): StandaloneLabelRecord {
  // 2026-09-11, 422-02: two caller-bug guards, matching what the strict reader admits.
  //
  // The first is the one that would corrupt gold silently. Cloning a record that labels a
  // DIFFERENT cassette would stamp the derived variant with another decision's expectation
  // and another run's provenance — a wrong gold and a broken ROOT-03 exclusion at once, and
  // nothing downstream could tell, because the clone is well-formed in every other respect.
  //
  // The second keeps the factory and `parseStandaloneLabelRecord` telling one story: a
  // `derivedFrom` marker has no legacy form, so minting a partial one here would write bytes
  // this package's own reader refuses.
  if (seedLabel.cassetteId !== generator.seedCassetteId) {
    throw new TypeError(
      'adversarial derivation requires the seed label of the cassette the generator names',
    )
  }
  //
  // 2026-09-11, 422-04: the completeness question is asked of `generatorProvenance` rather than
  // re-spelled here. Two derivation paths now reach this factory and they stamp different
  // provenance — a table-drawn variant names the mutation family and its generation, an
  // LLM-authored probe names its author and the frozen prompt version. The rule stayed one
  // function so widening it for probes could not accidentally relax it for tables: a stamp that
  // is complete for the WRONG path is `malformed` and refused here exactly as a partial one is.
  if (generatorProvenance(generator) !== 'table' && generatorProvenance(generator) !== 'probe') {
    throw new TypeError(
      'adversarial derivation requires complete generator metadata for its kind ' +
        '(mutator, tableVersion and tableHash for a table family; ' +
        'authoringModel and promptVersion for a probe)',
    )
  }
  const {
    revision: _revision,
    supersedes: _supersedes,
    quarantine: _quarantine,
    weight: _weight,
    pairState: _pairState,
    ...carried
  } = seedLabel
  const { pairing: _pairing, ...label } = seedLabel.label
  return {
    ...carried,
    cassetteId: cassette.id,
    label,
    derivedFrom: { seedCassetteId: generator.seedCassetteId, generator },
    provenance: {
      ...seedLabel.provenance,
      sourceCassetteId: generator.seedCassetteId,
      receiptDigest: sha256hex(canonicalJson(cassette.receipt)),
    },
  }
}

/**
 * Project a selected silver cassette into its standalone record. The label
 * is the embedded leg verbatim — extraction already stamped
 * 'recorded-verdict'/'silver' (D-12) — with no pairing and no pairState.
 */
export function projectSilverLabelRecord({
  cassette,
  runId,
}: ProjectSilverLabelRecordInput): StandaloneLabelRecord {
  return {
    schemaVersion: LABEL_RECORD_SCHEMA_VERSION,
    cassetteId: cassette.id,
    label: { ...cassette.label },
    provenance: projectProvenance(cassette, runId),
  }
}
