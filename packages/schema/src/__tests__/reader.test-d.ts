import { expectTypeOf, test } from 'vitest'
import type { BriefLine, CautionLine } from '../brief/served-brief'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'
import type { RecordId } from '../ids/record-id'
import type { CuratorTier, ProcedureParamType } from '../knowledge/curator-tier'
import type { Benefit } from '../knowledge/gate-receipt'
import type {
  BriefBlock,
  BuildRange,
  CanaryOutcome,
  CautionBlock,
  IndexEntry,
  ProcedureMatch,
  ReadOptions,
  RecordBody,
  SearchOptions,
  ServingRecordMetadata,
} from '../reader/index'

test('index entries and record bodies have fixed shapes and key sets', () => {
  expectTypeOf<IndexEntry>().toEqualTypeOf<{
    id: RecordId
    kind: string
    subtype?: string
    title: string
    summary: string
    trust: number
    anchors: Anchor[]
    status: string
    servedAsCanary: boolean
    servedAs?: 'current' | 'prior-build-hypothesis'
    unconfirmedSinceOrdinal?: number
    unverified?: boolean
    conflict?: { peerRecordId: RecordId; unknownRecordId: RecordId }
    audit?: { status: string; openedAtOrdinal: number; closedAtOrdinal: number | null }
    scope: ScopeKey
    validity: string
  }>()

  expectTypeOf<keyof IndexEntry>().toEqualTypeOf<
    | 'id'
    | 'kind'
    | 'subtype'
    | 'title'
    | 'summary'
    | 'trust'
    | 'anchors'
    | 'status'
    | 'servedAsCanary'
    | 'servedAs'
    | 'unconfirmedSinceOrdinal'
    | 'unverified'
    | 'conflict'
    | 'audit'
    | 'scope'
    | 'validity'
  >()

  expectTypeOf<RecordBody>().toEqualTypeOf<{
    id: RecordId
    title: string
    body: string
    anchors: Anchor[]
    evidenceDigest: string
    measurement?: string
    relations: { kind: string; targetId: RecordId }[]
  }>()

  expectTypeOf<keyof RecordBody>().toEqualTypeOf<
    'id' | 'title' | 'body' | 'anchors' | 'evidenceDigest' | 'measurement' | 'relations'
  >()
})

test('brief, caution and procedure blocks have fixed shapes', () => {
  expectTypeOf<BriefBlock>().toEqualTypeOf<{
    tiers: { L0: string; L1: string; L2: string }
    lines: BriefLine[]
    truncation: string
    admissions: ServingRecordMetadata[]
  }>()

  expectTypeOf<BriefBlock['lines']>().toEqualTypeOf<BriefLine[]>()

  expectTypeOf<CautionBlock>().toEqualTypeOf<{
    cautions: CautionLine[]
    budgetUsed: number
    admissions: ServingRecordMetadata[]
  }>()

  expectTypeOf<CautionBlock['cautions']>().toEqualTypeOf<CautionLine[]>()

  expectTypeOf<ProcedureMatch>().toEqualTypeOf<{
    id: RecordId
    flowAnchor: Anchor
    confidence: number
    authoringModelTier: CuratorTier
    parameterSchema: { name: string; type: ProcedureParamType; required: boolean }[]
    replayRecommendation: 'replay' | 'hint'
  }>()

  expectTypeOf<ProcedureMatch['replayRecommendation']>().toEqualTypeOf<'replay' | 'hint'>()
  expectTypeOf<ProcedureMatch['authoringModelTier']>().toEqualTypeOf<'full' | 'degraded' | 'floor'>()
  expectTypeOf<IndexEntry['anchors']>().toEqualTypeOf<Anchor[]>()
})

test('search and read options have fixed shapes', () => {
  expectTypeOf<BuildRange>().toEqualTypeOf<{
    from?: number
    to?: number
  }>()

  expectTypeOf<SearchOptions>().toEqualTypeOf<{
    scope: ScopeKey
    kind?: string
    anchors?: Anchor[]
    asOfBuild?: number
    includeSuperseded?: boolean
    asOfRange?: BuildRange
    includeCandidates?: boolean
  }>()

  expectTypeOf<SearchOptions['asOfRange']>().toEqualTypeOf<BuildRange | undefined>()

  expectTypeOf<ReadOptions>().toEqualTypeOf<{
    detailLevel?: string
    budget?: number
    scope?: ScopeKey
    asOfBuild?: number
  }>()
})

test('a canary outcome has a fixed shape and key set', () => {
  expectTypeOf<CanaryOutcome>().toEqualTypeOf<{
    benefit: Benefit
    candidateId: RecordId
    runOutcome: 'positive' | 'negative'
    runId: string
    testId: string
    testIndex: number
    buildOrdinal: number
    stepIndex: number
    briefDigest: string
    attribution: string
    exercisedAnchor: Anchor
  }>()

  expectTypeOf<keyof CanaryOutcome>().toEqualTypeOf<
    | 'benefit'
    | 'candidateId'
    | 'runOutcome'
    | 'runId'
    | 'testId'
    | 'testIndex'
    | 'buildOrdinal'
    | 'stepIndex'
    | 'briefDigest'
    | 'attribution'
    | 'exercisedAnchor'
  >()
})
