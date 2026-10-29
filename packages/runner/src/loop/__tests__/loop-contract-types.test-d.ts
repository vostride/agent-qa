// Compile-checked exact key sets for the loop's TypeScript-only contracts. PlannerConfig governs
// what every door passes the loop; StepEvidence and SubActionEvidence carry the limit and operation
// members new runs persist, and keep stagnation, cycle and localEffect as reader-only members.
import { describe, expectTypeOf, it } from 'vitest'
import type {
  CycleEvidence,
  LimitStopEvidence,
  LocalEffectEvidence,
  OperationCaptureAvailability,
  OperationEvidence,
  StagnationEvidence,
  StepEvidence,
  StepLimitUsage,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'

import type { PlannerConfig } from '../types.js'

describe('C436-KEY-SETS narrowed types', () => {
  it('PlannerConfig has exactly the limit pair and previousStepCount', () => {
    expectTypeOf<keyof PlannerConfig>().toEqualTypeOf<'maxActions' | 'maxPlanningTurns' | 'previousStepCount'>()
    expectTypeOf<PlannerConfig>().toEqualTypeOf<{ maxActions: number; maxPlanningTurns: number; previousStepCount: number }>()
  })

  it('StepEvidence has the limit and capture members and keeps stagnation and cycle reader-only', () => {
    expectTypeOf<Pick<StepEvidence, 'limitStop' | 'limitUsage' | 'operationCapture'>>().toEqualTypeOf<{
      limitStop?: LimitStopEvidence
      limitUsage?: StepLimitUsage
      operationCapture?: OperationCaptureAvailability
    }>()
    expectTypeOf<Pick<StepEvidence, 'stagnation' | 'cycle'>>().toEqualTypeOf<{
      stagnation?: StagnationEvidence
      cycle?: CycleEvidence
    }>()
  })

  it('SubActionEvidence has operationEvidence and keeps localEffect reader-only', () => {
    expectTypeOf<Pick<SubActionEvidence, 'operationEvidence' | 'localEffect'>>().toEqualTypeOf<{
      operationEvidence?: OperationEvidence
      localEffect?: LocalEffectEvidence
    }>()
    // 2026-10-08 (437-02): input evidence joins downloads and clipboard (D-05).
    expectTypeOf<keyof OperationEvidence>().toEqualTypeOf<'downloads' | 'clipboard' | 'input'>()
  })
})
