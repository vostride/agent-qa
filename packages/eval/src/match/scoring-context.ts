import { sha256hex } from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { canonicalJson } from '../canonical-json'
import type { Cassette } from '../cassette/cassette'
import { JUDGE_CONFIG } from '../judge/config'
import { createPanelIdentity } from '../judge/panel'
import { resolveJudgeFamilies, judgeFamiliesIntersect } from '../judge/family'
import type { ReplayCassetteOutcome } from '../replay/result'
import { MATCHER_CONFIG } from './config'
import { scoreCassetteReplay, type CassetteScore, type DecisionScoreEntry, type JudgeIdentityBlock } from './score'
import { JUDGE_ABSTENTION_CAUSES } from './score'

const count = z.number().int().nonnegative().safe()
const confidence = z.enum(['high', 'medium', 'low'])
const memberIdentity = z.object({ judgeModelId: z.string().min(1), judgeFamily: z.string().min(1) }).strict()
/** Explicit additive identity admission, shared by independent storage boundaries. */
export const judgeIdentitySchema = z.object({
  judgeModelId: z.string(), judgeFamily: z.string(), judgeVersion: count,
  confidenceThreshold: confidence,
  familyOverride: z.literal('same-family-allowed').optional(),
  panelSize: count.optional(), members: z.array(memberIdentity).optional(),
}).strict().refine(judge => {
  if (!judge.judgeModelId.startsWith('panel:')) return judge.panelSize === undefined && judge.members === undefined
  const members = judge.members
  if (members === undefined || members.length < 2 || members.length > JUDGE_CONFIG.maxPanelMembers ||
    judge.panelSize !== members.length || judge.familyOverride !== undefined || judge.judgeVersion < 2) return false
  const ids = members.map(member => member.judgeModelId)
  if (new Set(ids).size !== ids.length) return false
  const families = ids.map(resolveJudgeFamilies)
  if (families.some((family, index) => family.size === 0 ||
    families.slice(0, index).some(previous => judgeFamiliesIntersect(previous, family)))) return false
  const canonical = createPanelIdentity(ids)
  return judge.judgeModelId === canonical.judgeModelId && judge.judgeFamily === canonical.judgeFamily &&
    canonicalJson(members) === canonicalJson(canonical.members)
}, 'panel identity must be canonical, complete and disjoint')

export const judgeUsageSchema = z.object({ calls: count, inputTokens: count.optional(), outputTokens: count.optional() }).strict()
export const judgeMemberOutcomeSchema = z.object({
  ...memberIdentity.shape,
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('settled'), resolution: z.enum(['equivalent', 'different']), confidence }).strict(),
    z.object({ kind: z.literal('abstained'), cause: z.enum(JUDGE_ABSTENTION_CAUSES), confidence: confidence.optional() }).strict(),
    z.object({ kind: z.literal('error'), reason: z.enum(['provider-error', 'unparseable-output']), detail: z.string() }).strict(),
  ]),
  usage: judgeUsageSchema.optional(),
}).strict()

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate additive panel fields without rewriting legacy score documents or their digests. */
export function hasValidScoreJudgeMetadata(record: unknown): boolean {
  if (!object(record)) return false
  const parsedJudge = record.judge === undefined ? undefined : judgeIdentitySchema.safeParse(record.judge)
  if (parsedJudge !== undefined && !parsedJudge.success) return false
  const judge = parsedJudge?.data
  const score = record.score
  if (!object(score)) return false
  const entries = score.kind === 'leaf' ? [score.entry] : score.kind === 'procedure' ? score.entries : []
  if (!Array.isArray(entries)) return false
  for (const entry of entries) {
    if (!object(entry)) return false
    if (entry.kind !== 'decision') continue
    if (!object(entry.score)) return false
    for (const stamp of [entry.score.judgeSettled, entry.score.judgeOutcome]) {
      if (stamp === undefined) continue
      if (!object(stamp)) return false
      if (stamp.usage !== undefined && !judgeUsageSchema.safeParse(stamp.usage).success) return false
      if (judge?.panelSize === undefined) {
        if (stamp.members !== undefined || (typeof stamp.judgeId === 'string' && stamp.judgeId.startsWith('panel:'))) return false
        continue
      }
      if (stamp.kind === 'not-invoked') continue
      if (stamp.judgeId !== judge.judgeModelId || stamp.judgeVersion !== judge.judgeVersion) return false
      if (stamp === entry.score.judgeSettled) {
        if (!z.enum(['element-identity', 'value']).safeParse(stamp.axis).success ||
          !z.enum(['equivalent', 'different']).safeParse(stamp.resolution).success ||
          !confidence.safeParse(stamp.confidence).success ||
          !z.enum(['partial-identity', 'value-mid-band', 'no-consensus']).safeParse(stamp.cause).success) return false
      } else if (stamp.kind !== 'abstained' && stamp.kind !== 'judge-error') return false
      if (stamp.kind === 'abstained' && !z.enum(JUDGE_ABSTENTION_CAUSES).safeParse(stamp.cause).success) return false
      if (stamp.kind === 'judge-error' && (!z.enum(['provider-error', 'unparseable-output']).safeParse(stamp.reason).success ||
        typeof stamp.detail !== 'string')) return false
      if (stamp.confidence !== undefined && !confidence.safeParse(stamp.confidence).success) return false
      if (stamp.members === undefined) {
        // Evidence refusal can precede every call; it has no comparison group.
        if (stamp.kind !== 'abstained' || !['missing-evidence', 'candidate-overflow'].includes(String(stamp.cause)) ||
          (object(stamp.usage) && stamp.usage.calls !== 0)) return false
        continue
      }
      const members = z.array(judgeMemberOutcomeSchema).safeParse(stamp.members)
      if (!members.success) return false
      const limit = (entry.score.kind === 'unresolved-tie' ? entry.score.cause : stamp.cause) === 'no-consensus'
        ? JUDGE_CONFIG.maxDistinctCandidates : 1
      if (members.data.length < judge.panelSize || members.data.length % judge.panelSize !== 0 ||
        members.data.length > judge.panelSize * limit) return false
      if (!members.data.every((member, index) => {
        const expected = judge.members![index % judge.panelSize!]
        return member.judgeModelId === expected.judgeModelId && member.judgeFamily === expected.judgeFamily
      })) return false
    }
  }
  return true
}

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const scoringJudgeRequestSchema = z.object({
  judgeModelId: z.string().min(1), allowSameFamily: z.boolean(),
}).strict().refine(request => !request.judgeModelId.startsWith('panel:') || !request.allowSameFamily,
  'composite judge requests cannot allow same-family judging')
export type ScoringJudgeRequest = z.infer<typeof scoringJudgeRequestSchema> | null
/** Additive score-file context. Absence remains readable for legacy scores. */
export const scoringContextSchema = z.object({
  schemaVersion: z.literal(2), matcherVersion: z.number().int().nonnegative(),
  inputsDigest: digest, replayDigest: digest, finalScoreDigest: digest, judgeIdentityDigest: digest,
  judgeRequest: scoringJudgeRequestSchema.nullable(),
}).strict()
export type ScoringContext = z.infer<typeof scoringContextSchema>
interface ScoringInputs {
  cassette: Cassette
  outcome: ReplayCassetteOutcome
}
interface StoredScore {
  cassetteId: string
  matcherVersion: number
  score: CassetteScore
  judge?: JudgeIdentityBlock
  scoringContext?: ScoringContext
}

const hash = (value: unknown): string => sha256hex(canonicalJson(value))
function inputsDigest(input: ScoringInputs): string {
  const { cassette } = input
  // The label leg feeds the report, not the score.
  const scoringCassette = cassette.granularity === 'leaf'
    ? { ...cassette, label: undefined } : cassette
  return hash({ cassette: scoringCassette })
}
/** Called after the actual matcher/adjudicator completes; never mints a judge verdict. */
export function createScoringContext(input: ScoringInputs & {
  score: CassetteScore; judge?: JudgeIdentityBlock; judgeRequest: ScoringJudgeRequest
}): ScoringContext {
  return { schemaVersion: 2, matcherVersion: MATCHER_CONFIG.matcherVersion,
    inputsDigest: inputsDigest(input),
    // executionSeed is the store's publication envelope; sample seeds/results are bound here.
    replayDigest: hash({ ...input.outcome, executionSeed: undefined }),
    finalScoreDigest: hash(input.score), judgeIdentityDigest: hash(input.judge ?? null),
    judgeRequest: input.judgeRequest }
}

/** Score compatibility is independent of planner input and immutable recorded observations. */
export function resolveScoringContext(input: ScoringInputs & {
  record?: StoredScore
}): { score?: CassetteScore; incurredJudgeScore?: CassetteScore; compatible: boolean } {
  const { cassette, record } = input
  const refuse = (score: CassetteScore) => ({ score, compatible: false,
    ...(record === undefined ? {} : { incurredJudgeScore: record.score }) })
  const currentJudge = record === undefined || (hasValidScoreJudgeMetadata(record) &&
    (record.judge === undefined || (record.judge.judgeVersion === JUDGE_CONFIG.judgeVersion &&
    record.judge.confidenceThreshold === JUDGE_CONFIG.confidenceThreshold)))
  const legacy = record?.scoringContext === undefined
  if (legacy && (record === undefined || (record.cassetteId === cassette.id && record.score.cassetteId === cassette.id &&
    record.matcherVersion === MATCHER_CONFIG.matcherVersion && currentJudge))) {
    return { score: record?.score, compatible: true }
  }
  if (record?.scoringContext !== undefined) {
    const parsed = scoringContextSchema.safeParse(record.scoringContext)
    const context = parsed.success ? parsed.data : undefined
    const current = createScoringContext({ ...input, score: record.score, judge: record.judge,
      judgeRequest: record.scoringContext.judgeRequest })
    if (context !== undefined && record.cassetteId === cassette.id && record.score.cassetteId === cassette.id &&
      record.matcherVersion === MATCHER_CONFIG.matcherVersion && canonicalJson(context) === canonicalJson(current) &&
      currentJudge && (record.judge === undefined || context.judgeRequest?.judgeModelId === record.judge.judgeModelId)) {
      return { score: record.score, compatible: true }
    }
  }
  const deterministic = scoreCassetteReplay(cassette, input.outcome)
  if (deterministic.kind !== 'leaf' && deterministic.kind !== 'procedure') return refuse(deterministic)
  const stale = (entry: DecisionScoreEntry): DecisionScoreEntry =>
    entry.kind === 'skipped' ? entry : { kind: 'never-scored', decisionOrdinal: entry.decisionOrdinal,
      ...(entry.stepIndex === undefined ? {} : { stepIndex: entry.stepIndex }),
      reason: 'stale-scoring-context', matcherVersion: MATCHER_CONFIG.matcherVersion }
  return refuse(deterministic.kind === 'leaf' ? { ...deterministic, entry: stale(deterministic.entry) }
    : { ...deterministic, entries: deterministic.entries.map(stale) })
}
