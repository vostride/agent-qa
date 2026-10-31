import { expectTypeOf, test } from 'vitest'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type {
  BriefLine,
  CautionLine,
  LosslessServedBriefProofV1,
  ReadTrace,
  ServedAdmissionEvent,
  ServedBrief,
  ServedPromptTurn,
} from '../brief/served-brief'

test('the served brief has a fixed shape and channels', () => {
  expectTypeOf<ServedBrief>().toEqualTypeOf<{
    scope: ScopeKey
    asOfBuild: number
    budget: number
    truncation: string
    channel1: BriefLine[]
    channel2: ReadTrace[]
    channel3: CautionLine[]
    briefDigest: string
    proof?: LosslessServedBriefProofV1
  }>()

  expectTypeOf<keyof ServedBrief>().toEqualTypeOf<
    | 'scope'
    | 'asOfBuild'
    | 'budget'
    | 'truncation'
    | 'channel1'
    | 'channel2'
    | 'channel3'
    | 'briefDigest'
    | 'proof'
  >()

  expectTypeOf<BriefLine>().toMatchTypeOf<{
    trust: number
    status: string
    servedAsCanary: boolean
    tier: string
  }>()

  expectTypeOf<ServedBrief['channel1']>().toEqualTypeOf<BriefLine[]>()
  expectTypeOf<ServedBrief['channel2']>().toEqualTypeOf<ReadTrace[]>()
  expectTypeOf<ServedBrief['channel3']>().toEqualTypeOf<CautionLine[]>()

  expectTypeOf<CautionLine['anchors']>().toEqualTypeOf<Anchor[]>()
})

test('the lossless brief proof records admission events and prompt turns', () => {
  expectTypeOf<ServedAdmissionEvent>().toEqualTypeOf<{
    ordinal: number
    turnOrdinal: number
    surface: 'brief-line' | 'search-result' | 'read-body' | 'caution' | 'procedure-hint'
    id: RecordId
    sourceId: string
    clusterKey: string
    renderedCost: number
    chargeRepeated: boolean
  }>()

  expectTypeOf<ServedPromptTurn>().toEqualTypeOf<{
    ordinal: number
    turnOrdinal: number
    runDate: string
    policyL0: string
    learnedL1: string
    learnedL2: string
    contextTier: string
    volatileTier: string
    policyDigest: string
    contextTierDigest: string
    volatileTierDigest: string
  }>()

  expectTypeOf<LosslessServedBriefProofV1>().toEqualTypeOf<{
    schemaVersion: 2
    completeness: 'lossless'
    recordCap: number
    combinedBudget: number
    admissionEvents: ServedAdmissionEvent[]
    promptTurns: ServedPromptTurn[]
  }>()

  expectTypeOf<ServedAdmissionEvent['surface']>().toEqualTypeOf<
    'brief-line' | 'search-result' | 'read-body' | 'caution' | 'procedure-hint'
  >()
})

test('a brief served before the proof existed still typechecks without one', () => {
  const historicalBriefWithoutProof: ServedBrief = {
    scope: { tier: 'product', key: 'example' },
    asOfBuild: 1,
    budget: 1024,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'legacy-v1-digest',
  }

  expectTypeOf(historicalBriefWithoutProof.proof).toEqualTypeOf<
    LosslessServedBriefProofV1 | undefined
  >()
})
