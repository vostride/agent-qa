import type { CassetteLabelLeg } from '../../../cassette/label-leg'
import type { LabelWeight } from '../../../labels/label-record'
import type { ScoredBatchEntry } from '../../metrics'
import { MATCHER_CONFIG } from '../../config'

export function metricEntry(cassetteId: string, full = true): ScoredBatchEntry {
  return {
    cassetteId,
    outcome: {
      granularity: 'leaf', cassetteId, briefSource: 'empty',
      samples: [{ sampleIndex: 0, durationMs: 10,
        outcome: { kind: 'planner-failure', reason: 'no_action_tool_called', message: 'fixture' },
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }],
      agreement: { k: 1, agreementRate: 1, noConsensus: false, harnessErrorCount: 0 },
      promptDrift: { drift: false, harnessDrift: false, recordedHash: 'same', recomputedHash: 'same' },
      replayedModel: { provider: 'fixture', modelId: 'fixture' },
      unconsumedExchanges: [], totalDurationMs: 10,
    },
    score: { kind: 'leaf', cassetteId, entry: { kind: 'decision', decisionOrdinal: 0, score: {
      kind: 'scored', matcherVersion: MATCHER_CONFIG.matcherVersion,
      axes: {
        elementIdentity: { kind: 'scored', level: full ? 'full' : 'miss', numeric: full ? 1 : 0, tier: 2 },
        opClass: { kind: 'match', opClass: 'activate' }, value: { kind: 'not-applicable' },
      }, loop: { kind: 'none' }, tierReached: 2,
    } } },
  }
}

export function passLabel(sourceChannel: CassetteLabelLeg['sourceChannel'] = 'recorded-verdict'): CassetteLabelLeg {
  return { sourceChannel, tier: sourceChannel === 'recorded-verdict' ? 'silver' : 'gold',
    verdict: { pass: true, reasoning: 'recorded' } }
}

export function weight(value: number): LabelWeight {
  return { value, k: 0, n: 0, verdictSource: 'unverified', verdictFactor: 1,
    capabilityTier: 'full', tierFactor: 1, alpha0: 2, beta0: 1,
    corpusDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64),
    capabilityEvidence: { kind: 'deterministic' } }
}

export function metricPair(id: string, full: boolean, value?: number): ScoredBatchEntry[] {
  const positive = metricEntry(`${id}-positive`, full), negative = metricEntry(`${id}-negative`)
  positive.label = { sourceChannel: 'self-heal-pair', tier: 'near-gold',
    pairing: { relation: 'contrastive-positive', pairedCassetteId: negative.cassetteId } }
  negative.label = { sourceChannel: 'self-heal-pair', tier: 'near-gold',
    pairing: { relation: 'contrastive-negative', pairedCassetteId: positive.cassetteId } }
  if (value !== undefined) Object.assign(positive, { softWeight: weight(value) })
  return [positive, negative]
}
