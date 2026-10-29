// Exact key equality, so collapsing the two N terms into one is a compile error.

import { expectTypeOf } from 'vitest'

import { FAN_OUT_RUN_PURPOSES } from '../fan-out'
import type {
  ConsumedRun,
  FanOutBound,
  FanOutBoundInput,
  FanOutReport,
  FanOutRunPurpose,
} from '../fan-out'

// ---- 1. Three terms and a total, and exactly those four ---------------------------------------
expectTypeOf<keyof FanOutBound>().toEqualTypeOf<'initialN' | 'probeK' | 'finalN' | 'total'>()

// The INPUT carries the three terms and no total: a caller that could hand in its own total would
// be a second arithmetic reaching the one function that exists to be the only one.
expectTypeOf<keyof FanOutBoundInput>().toEqualTypeOf<'initialN' | 'probeK' | 'finalN'>()

// ---- 2. The report pairs the preview with what was actually consumed ---------------------------
expectTypeOf<keyof FanOutReport>().toEqualTypeOf<
  'previewed' | 'consumed' | 'consumedTotal' | 'exceedsPreview'
>()
expectTypeOf<FanOutReport['previewed']>().toEqualTypeOf<FanOutBound>()

// ---- 3. A consumed run is a ref plus a role, never a run document ------------------------------
//
// The report is a DISCLOSURE, not a second copy of the run store: carrying the documents would put
// per-step evidence on the proposal arm a person reads to decide about a draft.
expectTypeOf<keyof ConsumedRun>().toEqualTypeOf<'runId' | 'purpose' | 'completedAt'>()
expectTypeOf<FanOutRunPurpose>().toEqualTypeOf<'gate' | 'probe'>()
expectTypeOf<typeof FAN_OUT_RUN_PURPOSES>().toEqualTypeOf<readonly ['gate', 'probe']>()
