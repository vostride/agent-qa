/**
 * D-16 corpus-seeding planner — the composition root of the pure label
 * factory (LABEL-01..03, ROOT-03).
 *
 * Planner law (D-16): this plan is the ONLY decision-maker. It composes the
 * pair matcher, the silver sampler, and the record/entry projections into
 * one typed SeedingPlan with every case fully materialized (cassette id +
 * label record + corpus entry). eval-local EXECUTES the plan byte-for-byte;
 * no selection or labeling decision is left to the storage side.
 *
 * Membership law (D-13): the plan's cases ARE the commit scope. Exactly the
 * seeded silver selections plus pair members appear — nothing else may land
 * in the committed corpus, by construction. Every non-member is accounted
 * for by a typed pair skip or silver exclusion carried forward verbatim.
 *
 * Partition law (414 D-07): the split is decided BEFORE the entry is
 * projected. `assignSplit` runs inside the admit closure and its result is
 * handed to `projectCorpusEntry` as an INPUT, so no post-hoc relabel path
 * exists anywhere in the seeder — a split can only change by re-deriving the
 * whole entry from a changed manifest, which is a named migration.
 *
 * The partition parameters and the D-04 fields are caller-supplied DATA:
 * eval core imports no runner-local constants, and module discipline bans
 * clock APIs here — the CLI and eval-local resolve the committed manifest,
 * the ISO capture time and the target environment and pass them in.
 */
import { actionDidNotFail, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, MaskFn, PerTestOutcome, Verdict } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import { maskCorpusText } from '../extract/corpus-text-mask'
import { computeCorpusDigest } from '../census/corpus-digest'
import type { CommittedCorpusSnapshot } from '../census/derive-census'
import { collectSoftPopulation, type SoftPopulation } from './soft-population'
import { computeSoftWeight } from './soft-weight'
import type { LeafCassette } from '../cassette/cassette'
import type { ExtractedCassette } from '../extract/extract-run'
import { deriveLeafCassetteId, deriveRunSlug } from '../extract/ids'
import { projectInputLeg } from '../extract/input-leg'
import { assembleReceipt } from '../extract/receipt'
import { projectLabelLeg } from '../extract/label-leg'
import { projectSidecarLeg } from '../extract/sidecar-leg'
import { createLabelRevision } from './effective-labels'
import type { GoldMark } from './golden-plan'
import { EXCLUSION_CLASSES } from './run-exclusion'
import { projectCorpusEntry, resolveProductPartition } from './corpus-entry'
import type { CorpusEntry, TargetEnvironment } from './corpus-entry'
import { projectPairLabelRecords, projectSilverLabelRecord } from './label-record'
import type { StandaloneLabelRecord } from './label-record'
import { collectSelfHealPairs } from './pair-matching'
import type { PairSkip } from './pair-matching'
import { DEFAULT_SILVER_PER_TEST_CAP, isRerunSilverQuarantined, selectSilverCassettes } from './silver-sampling'
import type { SilverExclusion } from './silver-sampling'
import { assignSplit } from './split-assignment'
import type { PartitionParams } from './split-assignment'

/** Caller-suppliable curation policy (D-11) — NOT frozen-config measurement. */
export interface SeedingParams {
  /** Per-test silver cap; defaults to DEFAULT_SILVER_PER_TEST_CAP. */
  silverPerTestCap?: number
}

/** One fully materialized corpus admission — id, record, and entry agree. */
export interface SeedingPlanCase {
  cassetteId: string
  labelRecord: StandaloneLabelRecord
  corpusEntry: CorpusEntry
}

/** The complete deterministic description of what joins the committed corpus. */
export interface SeedingPlan {
  /** Label-only append operations; no cassette or membership rewrite. */
  labelRevisions?: StandaloneLabelRecord[]
  retirementCounts?: { superseded: number; missing: number; conflict: number }
  softEvidence?: Pick<SoftPopulation, 'skips' | 'missingEvidenceCounts'>
  product: string
  runId: string
  runSlug: string
  /** Exactly the pair members + silver selections, cassetteId ascending (D-13). */
  cases: SeedingPlanCase[]
  /** Matcher skips, verbatim — never silent. */
  pairSkips: PairSkip[]
  /** Sampler exclusions, verbatim — never silent. */
  silverExclusions: SilverExclusion[]
  /** Both pair classes counted so a starved channel is visible (D-07). */
  pairCounts: { total: number; sameState: number; differingState: number }
  /** Count of 'procedure-granularity' exclusions among silverExclusions. */
  proceduresExcludedCount: number
}

export interface BuildSeedingPlanInput {
  /** Host-loaded committed evidence; derived label weights are never population inputs. */
  populationContext?: {
    snapshot: CommittedCorpusSnapshot
    handoffs: readonly CompletedRunHandoff[]
    marks: readonly GoldMark[]
  }
  handoff: CompletedRunHandoff
  cassettes: readonly ExtractedCassette[]
  /**
   * The product's committed partition parameters (414 D-05/D-07). REQUIRED:
   * no default fraction exists anywhere on the eval side.
   */
  partition: PartitionParams
  /**
   * D-04 ISO wall-clock capture time, resolved by the caller. Omitted when
   * it does not resolve — never fabricated.
   */
  capturedAt?: string
  /** D-04 target environment, resolved by the caller. Omitted when unknown. */
  targetEnvironment?: TargetEnvironment
  params?: SeedingParams
  /**
   * 441 GAP3-D1: the declared mask the caller extracted `cassettes` under. A rerun's original
   * decision is re-projected through it, after its raw digests are checked, so it compares
   * equal to a committed case extracted from a masked run.
   */
  mask?: MaskFn
}

function requireLeaf(
  leavesById: ReadonlyMap<string, LeafCassette>,
  cassetteId: string,
): LeafCassette {
  const cassette = leavesById.get(cassetteId)
  if (cassette === undefined) {
    throw new Error(
      `seeding plan references cassette ${cassetteId} absent from the extracted leaf set`,
    )
  }
  return cassette
}

/** Preserve ordinary exclusion policy; rerun passes and actual recovery evidence reach the factory. */
export function admitSeedMember(
  member: PerTestOutcome,
  verdict?: Pick<Verdict, 'class' | 'producer'>,
): boolean {
  if (member.isRerun === true && (member.outcome === 'passed'
    || member.steps.some(step => step.selfHeal !== undefined && step.verifierVerdict.pass))) return true
  return verdict === undefined || !EXCLUSION_CLASSES.some(value => value === verdict.class)
}

function rerunProvenance(member: PerTestOutcome): StandaloneLabelRecord['provenance']['rerun'] {
  if (!member.isRerun || member.rerunAttempt === undefined) return undefined
  return { attempt: member.rerunAttempt, ...(member.rerunOrigin ? {
    originalAttempt: member.rerunOrigin.attempt, originalEvidenceDigest: member.rerunOrigin.evidenceDigest,
  } : {}) }
}

type OriginalDecision = NonNullable<PerTestOutcome['rerunOrigin']>['decisions'][number]

/** Compare actual recorded legs, not a locator or final-attempt classification alone. */
function matchesOriginal(input: BuildSeedingPlanInput, member: PerTestOutcome, decision: OriginalDecision,
  cassette: LeafCassette, record: StandaloneLabelRecord, entry?: CorpusEntry): boolean {
  const { screenStateHash: stateHash, evidenceDigest, ...facts } = decision
  const subAction = decision.evidence.subActions[decision.decisionOrdinal]
  if (!subAction?.exchanges || sha256hex(canonicalJson(facts)) !== evidenceDigest
    || screenStateHash(subAction.stateBefore) !== stateHash || decision.runId !== input.handoff.runId
    || decision.testId !== member.testId || decision.testIndex !== member.testIndex
    || decision.evidence.stepIndex !== decision.stepIndex) return false
  const address = { testIndex: decision.testIndex, stepIndex: decision.stepIndex, decisionOrdinal: decision.decisionOrdinal }
  const step = input.mask === undefined ? decision.evidence : maskCorpusText(decision.evidence, input.mask)
  const projected = step.subActions[decision.decisionOrdinal]!
  const inputLeg = projectInputLeg({ handoffTest: member, step, subAction: projected, ...address })
  const receipt = assembleReceipt({ inputLeg, step, subAction: projected, handoff: input.handoff })
  const provenance = projectSilverLabelRecord({ cassette, runId: decision.runId }).provenance
  const { rerun: _rerun, ...recordProvenance } = record.provenance
  return cassette.runId === decision.runId && cassette.testId === decision.testId
    && cassette.testIndex === address.testIndex && cassette.stepIndex === address.stepIndex
    && cassette.decisionOrdinal === address.decisionOrdinal
    && canonicalJson(cassette.input) === canonicalJson(inputLeg)
    && canonicalJson(cassette.receipt) === canonicalJson(receipt)
    && canonicalJson(cassette.sidecar) === canonicalJson(projectSidecarLeg({ subAction: projected }).leg)
    && canonicalJson(cassette.label) === canonicalJson(projectLabelLeg({
      // 422-12: the original extraction projected the ORIGINAL attempt's root cause onto the
      // label, and `rerunOrigin.rootCause` is that same recorded verdict. Reconstructing
      // without it would read every post-422 cassette of a member that HAD a root cause as a
      // mismatch, and retire nothing.
      step, subAction: projected, rootCause: member.rerunOrigin?.rootCause,
    }))
    && canonicalJson(record.label) === canonicalJson(cassette.label)
    && canonicalJson(recordProvenance) === canonicalJson(provenance)
    && (entry === undefined ? record.quarantine === 'rerun-overturned'
      && input.populationContext?.snapshot.excludedLabelIds?.has(cassette.id) === true
      : entry.run_links.runId === decision.runId && entry.run_links.runSlug === provenance.runSlug
    && entry.product === resolveProductPartition(input.handoff.scope)
    && entry.receiptDigest === provenance.receiptDigest && entry.captured_at_ordinal === provenance.capturedAtOrdinal)
}

function planRetirements(input: BuildSeedingPlanInput): Required<Pick<SeedingPlan, 'labelRevisions' | 'retirementCounts'>> {
  const labelRevisions: StandaloneLabelRecord[] = []
  const retirementCounts = { superseded: 0, missing: 0, conflict: 0 }
  const snapshot = input.populationContext?.snapshot
  for (const member of input.handoff.tests.filter(isRerunSilverQuarantined)) {
    const { evidenceDigest, ...origin } = member.rerunOrigin!
    if (sha256hex(canonicalJson(origin)) !== evidenceDigest) { retirementCounts.conflict++; continue }
    if (origin.decisions.length === 0) retirementCounts.missing++
    const seen = new Set<string>()
    for (const decision of origin.decisions) {
      // A passing decision whose action did not fail (a skipped tap included, 437 D-05) is kept.
      if (decision.evidence.verifierVerdict.pass
        && actionDidNotFail(decision.evidence.subActions[decision.decisionOrdinal]?.result)) continue
      const id = deriveLeafCassetteId({ runSlug: deriveRunSlug(decision.runId), ...decision })
      const record = snapshot?.labelsById.get(id), cassette = snapshot?.cassettesById.get(id)
      const entries = snapshot?.entries.filter(entry => entry.cassetteId === id) ?? []
      if (seen.has(id)) { retirementCounts.conflict++; continue }
      seen.add(id)
      if (!record || !cassette || (entries.length === 0 && record.quarantine === undefined)) {
        if (snapshot?.excludedLabelIds?.has(id)) retirementCounts.conflict++
        else retirementCounts.missing++
        continue
      }
      if (entries.length > 1 || record.cassetteId !== id || cassette.id !== id
        || record.label.sourceChannel !== 'recorded-verdict' || record.label.tier !== 'silver'
        || !matchesOriginal(input, member, decision, cassette, record, entries[0]!)) {
        retirementCounts.conflict++; continue
      }
      const revision = createLabelRevision(record, { quarantine: 'rerun-overturned' })
      if (revision !== record) { labelRevisions.push(revision); retirementCounts.superseded++ }
    }
  }
  labelRevisions.sort((a, b) => a.cassetteId < b.cassetteId ? -1 : a.cassetteId > b.cassetteId ? 1 : 0)
  return { labelRevisions, retirementCounts }
}

/**
 * Project handoff evidence + extracted cassettes + seeding params into the
 * one typed seeding plan. Pure and deterministic: same input yields a
 * deep-equal plan; cases are sorted by cassetteId ascending (plain string
 * comparison — total order); the leaf Map is lookup-only. A duplicate case
 * id throws — the pair and silver channels are disjoint by construction
 * (the sampler excludes selfHeal steps), so a duplicate means the
 * channel-purity invariant broke upstream.
 */
export function buildSeedingPlan(input: BuildSeedingPlanInput): SeedingPlan
  & Required<Pick<SeedingPlan, 'labelRevisions' | 'retirementCounts'>> {
  const { handoff, cassettes, partition, capturedAt, targetEnvironment, params } = input
  const product = resolveProductPartition(handoff.scope)
  const runId = handoff.runId
  const runSlug = deriveRunSlug(runId)

  const { pairs, skips } = collectSelfHealPairs({ handoff, cassettes })
  const { selected, exclusions } = selectSilverCassettes({
    handoff,
    cassettes,
    silverPerTestCap: params?.silverPerTestCap ?? DEFAULT_SILVER_PER_TEST_CAP,
  })

  const leavesById = new Map<string, LeafCassette>()
  for (const entry of cassettes) {
    if (entry.cassette.granularity === 'leaf') {
      leavesById.set(entry.cassette.id, entry.cassette)
    }
  }

  const admittedIds = new Set<string>()
  const cases: SeedingPlanCase[] = []
  const admit = (
    cassette: LeafCassette,
    labelRecord: StandaloneLabelRecord,
    isPairMember: boolean,
  ): void => {
    if (admittedIds.has(cassette.id)) {
      throw new Error(
        `duplicate seeding case for cassette ${cassette.id} — channel purity broke upstream`,
      )
    }
    admittedIds.add(cassette.id)
    const assignment = assignSplit({ ...partition, cassetteId: cassette.id, isPairMember })
    cases.push({
      cassetteId: cassette.id,
      labelRecord,
      corpusEntry: projectCorpusEntry({
        cassette,
        product,
        runId,
        assignment,
        capturedAt,
        targetEnvironment,
      }),
    })
  }

  let sameStateCount = 0
  for (const pair of pairs) {
    if (pair.sameState) sameStateCount += 1
    const failedCassette = requireLeaf(leavesById, pair.failedCassetteId)
    const recoveringCassette = requireLeaf(leavesById, pair.recoveringCassetteId)
    const [failedRecord, recoveringRecord] = projectPairLabelRecords({
      pair,
      failedCassette,
      recoveringCassette,
      runId,
    })
    const member = handoff.tests.find(test => test.testIndex === pair.testIndex)!
    const rerun = rerunProvenance(member)
    if (rerun) {
      failedRecord.provenance.rerun = rerun
      recoveringRecord.provenance.rerun = rerun
    }
    admit(failedCassette, failedRecord, true)
    admit(recoveringCassette, recoveringRecord, true)
  }

  for (const cassetteId of selected) {
    const cassette = requireLeaf(leavesById, cassetteId)
    const record = projectSilverLabelRecord({ cassette, runId })
    const rerun = rerunProvenance(handoff.tests.find(test => test.testIndex === cassette.testIndex)!)
    if (rerun) record.provenance.rerun = rerun
    admit(cassette, record, false)
  }

  cases.sort((a, b) => {
    if (a.cassetteId !== b.cassetteId) return a.cassetteId < b.cassetteId ? -1 : 1
    return 0
  })

  const snapshot = input.populationContext?.snapshot
  const population = collectSoftPopulation({
    handoffs: [...(input.populationContext?.handoffs ?? []), handoff],
    marks: input.populationContext?.marks,
  })
  const membership = new Map((snapshot?.entries ?? []).map(entry => [entry.cassetteId, entry]))
  for (const item of cases) membership.set(item.cassetteId, item.corpusEntry)
  const corpusDigest = computeCorpusDigest([...membership.values()])
  for (const pair of pairs) {
    const attempt = handoff.tests.find(test => test.testIndex === pair.testIndex)?.rerunAttempt ?? 0
    const observation = population.observations.find(row => row.runId === runId && row.product === product
      && row.testIndex === pair.testIndex && row.stepIndex === pair.stepIndex && row.attempt === attempt
      && row.failedScreenStateHash === pair.failedScreenStateHash
      && row.recoveringCassetteId === pair.recoveringCassetteId)
    if (!observation) continue // The population's typed skips disclose incomplete evidence.
    const sameState = population.observations.filter(row => row.product === product
      && row.failedScreenStateHash === pair.failedScreenStateHash)
    const wanted = canonicalJson(observation.recoveringAction)
    const weight = computeSoftWeight({ n: sameState.length,
      k: sameState.filter(row => canonicalJson(row.recoveringAction) === wanted).length,
      corpusDigest, evidenceDigest: population.evidenceDigest, recoveringDecision: observation.recoveringDecision })
    for (const id of [pair.failedCassetteId, pair.recoveringCassetteId]) {
      cases.find(item => item.cassetteId === id)!.labelRecord.weight = weight
    }
  }
  // Seeding preserves historical observations, including operator-refreshed effective weights.
  // Population growth is refreshed only by calibration; changed source still hits write-once.
  for (const item of cases) {
    const prior = snapshot?.labelsById.get(item.cassetteId)
    const priorEntry = snapshot?.entries.find(entry => entry.cassetteId === item.cassetteId)
    const priorCassette = snapshot?.cassettesById.get(item.cassetteId)
    if (prior && priorEntry && priorCassette
      && canonicalJson(priorCassette) === canonicalJson(leavesById.get(item.cassetteId))
      && canonicalJson(priorEntry) === canonicalJson(item.corpusEntry)
      && canonicalJson(prior.provenance.rerun ?? null) === canonicalJson(item.labelRecord.provenance.rerun ?? null)) {
      item.labelRecord = prior
    }
  }

  return {
    ...planRetirements(input),
    product,
    runId,
    runSlug,
    cases,
    softEvidence: { skips: population.skips, missingEvidenceCounts: population.missingEvidenceCounts },
    pairSkips: skips,
    silverExclusions: exclusions,
    pairCounts: {
      total: pairs.length,
      sameState: sameStateCount,
      differingState: pairs.length - sameStateCount,
    },
    proceduresExcludedCount: exclusions.filter(
      (exclusion) => exclusion.reason === 'procedure-granularity',
    ).length,
  }
}
