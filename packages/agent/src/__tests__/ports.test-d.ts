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

// 385 plan 02, narrowed by 391 plan 02. The exact key set, pinned by equality
// rather than by a list of per-method assertions. Per-method assertions can only say what IS
// there, and the claim this carve-up has to support is what is NOT: no conversation surface for
// a later refactor to unify chat into, no generic job CRUD beside the queue's compound verbs,
// and — since 391 derived its write side as an enumerable proposal store plus a folded grant
// ledger rather than as a save/get over an id — no approval-shaped pair either. A method
// resurrected under any of those roles fails this line, and so does one quietly dropped from
// the two that survive: a deletion is not a way to make a pin pass.
expectTypeOf<keyof PersistencePort>().toEqualTypeOf<'savePatch' | 'getPatch'>()

expectTypeOf<Parameters<PersistencePort['savePatch']>>().toEqualTypeOf<[patch: Patch]>()
expectTypeOf<ReturnType<PersistencePort['savePatch']>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<Parameters<PersistencePort['getPatch']>>().toEqualTypeOf<[id: PatchId]>()
expectTypeOf<ReturnType<PersistencePort['getPatch']>>().toEqualTypeOf<Promise<Patch | undefined>>()

expectTypeOf<ReturnType<ClockPort['now']>>().toEqualTypeOf<string>()
import type { PromotionOutcome } from '@vostride/agent-qa-schema'
