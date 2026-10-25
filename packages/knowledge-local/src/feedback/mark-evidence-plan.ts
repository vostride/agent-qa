// The read/planning half of mark evidence. No lease, append or markId mint.
import { basename } from 'node:path'
import { asEvidenceToken, asRecordId, deriveEvidenceToken, eventDedupKey, exercisedAnchors,
  type BundleOutcomeEvent, type CompletedRunHandoff, type EvidenceToken, type MarkReceipt } from '@vostride/agent-qa-schema'
import { loadBundle, verifyBundleIntegrity } from '../bundle-read.js'
import { BundleTargetResolutionError, enumerateBundleDirs, resolveProductQualifiedBundleDir } from '../bundle-scan.js'
import { canaryOutcomeObservationId } from '../serving/canary-observation-id.js'

export const MARK_EVIDENCE_TOKEN_PREFIX = 'mark:'

export interface PlanMarkEvidenceInput {
  knowledgeRoot: string
  /** markId is optional: a preview plans ephemeral effects; a resumed writer supplies it to see durable ones. */
  mark: Pick<MarkReceipt, 'runId' | 'kind'> & { markId?: string }
  servedRecordIds: readonly string[]
  /** Historical observation hashes require the original member/step coordinates. */
  handoff?: CompletedRunHandoff
  /** Host-derived chainJobIdsForRun(runId, idSource).curateMemory; never guessed here. */
  curationJobIds?: readonly string[]
}

export type MarkEvidenceEffect =
  | { direction: 'confirm'; alreadyAppended: boolean }
  | { direction: 'overturn'; overturnsEvidenceToken: EvidenceToken; overturnsCurationJobId: string;
    alreadyAppended: boolean }

export type MarkEvidenceTarget =
  | { recordId: string; kind: 'unreadable' }
  | { recordId: string; kind: 'effects'; productKey: string; served: boolean; buildOrdinal: number;
    effects: MarkEvidenceEffect[] }

export interface MarkEvidencePlan {
  targets: MarkEvidenceTarget[]
  /** Without the handoff, opaque historical canary hashes cannot all be correlated. */
  correlationIncomplete?: true
}

export type AppendMarkEvidenceOutcome = {
  confirmed: number
  overturned: number
  skipped: { recordId: string; reason: 'bundle-unreadable' | 'already-appended' }[]
  /** Without the handoff, opaque historical canary hashes cannot all be correlated. */
  correlationIncomplete?: true
}

export function markEvidenceEvent(effect: MarkEvidenceEffect, markId: string, buildOrdinal: number): BundleOutcomeEvent {
  const token = `${MARK_EVIDENCE_TOKEN_PREFIX}${markId}`
  if (effect.direction === 'confirm') {
    return { type: 'confirmed', evidenceToken: asEvidenceToken(token), curationJobId: token, buildOrdinal, origin: 'user' }
  }
  // Include BOTH target identity fields: the same token may name two distinct jobs.
  return { type: 'overturned', markId, evidenceToken: asEvidenceToken(
    `${token}:${effect.overturnsEvidenceToken}:${effect.overturnsCurationJobId}`),
  curationJobId: token, buildOrdinal, overturnsEvidenceToken: effect.overturnsEvidenceToken,
  overturnsCurationJobId: effect.overturnsCurationJobId }
}

export function planMarkEvidence(input: PlanMarkEvidenceInput): MarkEvidencePlan {
  if (input.handoff !== undefined && input.handoff.runId !== input.mark.runId) {
    throw new TypeError('mark evidence handoff belongs to another run')
  }
  const plan: MarkEvidencePlan = { targets: [],
    ...(input.mark.kind === 'false-pass' && input.handoff === undefined ? { correlationIncomplete: true as const } : {}) }
  const served = new Set(input.servedRecordIds)
  const targets = new Set([...served, ...(input.mark.kind === 'false-pass'
    ? enumerateBundleDirs(input.knowledgeRoot).map(entry => basename(entry.dir)) : [])])
  for (const recordId of targets) {
    let entry
    try {
      entry = resolveProductQualifiedBundleDir({ knowledgeRoot: input.knowledgeRoot, recordId })
    } catch (error) {
      if (!(error instanceof BundleTargetResolutionError)) throw error
      plan.targets.push({ recordId, kind: 'unreadable' })
      continue
    }
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded' || !verifyBundleIntegrity(entry.dir).ok) {
      plan.targets.push({ recordId, kind: 'unreadable' })
      continue
    }
    const bundle = loaded.bundle
    const observations = new Set<string>()
    const evidenceTokens = new Set<string>()
    const bundleAnchors = bundle.frontmatter.anchors.map(({ raw }) => raw)
    for (const member of input.handoff?.tests ?? []) {
      for (const step of member.steps) {
        const canaryId = canaryOutcomeObservationId({ candidateId: asRecordId(recordId),
          runId: input.mark.runId, testId: member.testId, testIndex: member.testIndex,
          stepIndex: step.stepIndex })
        observations.add(canaryId)
        // The deterministic emitter's persisted observation address (emit-candidates.ts).
        observations.add(`${input.mark.runId}:test-${member.testIndex}:step-${step.stepIndex}`)
        // Positive canary Confirm goes through the knowledge-port bridge, which changes
        // observationId but preserves this canonical run/anchor/build evidence token.
        for (const anchor of [...bundleAnchors, ...exercisedAnchors(step)]) {
          evidenceTokens.add(deriveEvidenceToken({ attributingObservationId: canaryId,
            anchor, buildOrdinal: input.handoff!.buildOrdinal }))
        }
      }
    }
    const jobs = new Set(input.curationJobIds ?? [])
    const provenance = bundle.provenance
    if (provenance.mode === 'run-linked' && provenance.runId === input.mark.runId
      && provenance.curationJobId !== undefined) jobs.add(provenance.curationJobId)
    const hits = bundle.events.filter((event) => (event.type === 'helpful' || event.type === 'confirmed')
      && ((event.observationId !== undefined && observations.has(event.observationId))
        || evidenceTokens.has(event.evidenceToken) || jobs.has(event.curationJobId)))
    if (!served.has(recordId) && hits.length === 0) continue
    const buildOrdinal = Math.max(bundle.manifest.createdAtOrdinal,
      ...bundle.events.map((event) => event.buildOrdinal)) + 1
    // Mirror the append-time dedup key sequence. Durable log keys only matter for a known markId;
    // collisions inside one plan do not depend on the id, so a preview uses an empty stand-in.
    const seen = new Set(input.mark.markId === undefined ? [] : bundle.events.map(eventDedupKey))
    const effects: MarkEvidenceEffect[] = []
    const add = (effect: MarkEvidenceEffect) => {
      const key = eventDedupKey(markEvidenceEvent(effect, input.mark.markId ?? '', buildOrdinal))
      effects.push({ ...effect, alreadyAppended: seen.has(key) })
      seen.add(key)
    }
    if (served.has(recordId)) add({ direction: 'confirm', alreadyAppended: false })
    if (input.mark.kind === 'false-pass') {
      for (const hit of hits) {
        add({ direction: 'overturn', overturnsEvidenceToken: hit.evidenceToken,
          overturnsCurationJobId: hit.curationJobId, alreadyAppended: false })
      }
    }
    plan.targets.push({ recordId, kind: 'effects', productKey: entry.product, served: served.has(recordId),
      buildOrdinal, effects })
  }
  return plan
}

/** The outcome an append executing this plan reports, with duplicates counted only on resume. */
export function projectMarkEvidenceOutcome(plan: MarkEvidencePlan,
  options: { includeAlreadyAppended: boolean }): AppendMarkEvidenceOutcome {
  const result: AppendMarkEvidenceOutcome = { confirmed: 0, overturned: 0, skipped: [],
    ...(plan.correlationIncomplete === true ? { correlationIncomplete: true as const } : {}) }
  for (const target of plan.targets) {
    if (target.kind === 'unreadable') {
      result.skipped.push({ recordId: target.recordId, reason: 'bundle-unreadable' })
      continue
    }
    let changed = false
    for (const effect of target.effects) {
      if (effect.alreadyAppended && !options.includeAlreadyAppended) continue
      if (effect.direction === 'confirm') result.confirmed += 1
      else result.overturned += 1
      changed = true
    }
    if (!changed) result.skipped.push({ recordId: target.recordId, reason: 'already-appended' })
  }
  return result
}
