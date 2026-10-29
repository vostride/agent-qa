import { expectTypeOf } from 'vitest'
import type { ClockPort, KnowledgePort, PersistencePort } from '../ports/index.js'
import type {
  CanaryOutcome,
  Delta,
  GateReceipt,
  GateReceiptRecordOutcome,
  Patch,
  PatchId,
  RecordId,
} from '@vostride/agent-qa-schema'

declare const knowledge: KnowledgePort
declare const persistence: PersistencePort
declare const clock: ClockPort

expectTypeOf(knowledge).toMatchTypeOf<KnowledgePort>()
expectTypeOf(persistence).toMatchTypeOf<PersistencePort>()
expectTypeOf(clock).toMatchTypeOf<ClockPort>()

expectTypeOf<keyof KnowledgePort>().toEqualTypeOf<
  'proposeDeltas' | 'commit' | 'recordCanaryOutcome' | 'promote' | 'recordGateReceipt'
>()

expectTypeOf<Parameters<KnowledgePort['proposeDeltas']>>().toEqualTypeOf<[deltas: Delta[]]>()
expectTypeOf<ReturnType<KnowledgePort['proposeDeltas']>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<Parameters<KnowledgePort['commit']>>().toEqualTypeOf<[deltas: Delta[]]>()
expectTypeOf<ReturnType<KnowledgePort['commit']>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<Parameters<KnowledgePort['recordCanaryOutcome']>>().toEqualTypeOf<
  [outcome: CanaryOutcome]
>()
expectTypeOf<ReturnType<KnowledgePort['recordCanaryOutcome']>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<Parameters<KnowledgePort['promote']>>().toEqualTypeOf<[candidateId: RecordId, receipts?: readonly GateReceipt[]]>()
expectTypeOf<ReturnType<KnowledgePort['promote']>>().toEqualTypeOf<Promise<PromotionOutcome>>()
expectTypeOf<Parameters<KnowledgePort['recordGateReceipt']>>().toEqualTypeOf<[receipt: GateReceipt]>()
expectTypeOf<ReturnType<KnowledgePort['recordGateReceipt']>>().toEqualTypeOf<Promise<GateReceiptRecordOutcome>>()

// Pinned by key-set equality, so an added or a dropped method fails this line.
expectTypeOf<keyof PersistencePort>().toEqualTypeOf<'savePatch' | 'getPatch'>()

expectTypeOf<Parameters<PersistencePort['savePatch']>>().toEqualTypeOf<[patch: Patch]>()
expectTypeOf<ReturnType<PersistencePort['savePatch']>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<Parameters<PersistencePort['getPatch']>>().toEqualTypeOf<[id: PatchId]>()
expectTypeOf<ReturnType<PersistencePort['getPatch']>>().toEqualTypeOf<Promise<Patch | undefined>>()

expectTypeOf<ReturnType<ClockPort['now']>>().toEqualTypeOf<string>()
import type { PromotionOutcome } from '@vostride/agent-qa-schema'
