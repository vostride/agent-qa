// Supplies `testIndex` and `stepIndex`, which the loop never learns; telemetry never throws to it.

import type {
  HookFinishedPayload,
  HookStartedPayload,
  MaskFn,
  StepEvidence,
  SubActionEvidence,
  TestRetryScheduledPayload,
} from '@vostride/agent-qa-schema'
import {
  projectHookFinished,
  projectHookStarted,
  projectStepFinalized,
  projectSubActionRecorded,
  projectTestRetryScheduled,
} from '@vostride/agent-qa-schema'
import type { RunEventBus } from './bus.js'
import type { MemberEventSink } from './ports.js'
import type { LoopEventEmitPort } from '../loop/ports.js'

// Telemetry is fire-and-forget: an error becomes at most one guarded `runWarning` and is swallowed.
function guardEmit(bus: RunEventBus, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    try {
      bus.publish('runWarning', {
        code: 'event-sink-error',
        message: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // The bus itself is unusable (e.g. closed) — drop; telemetry never throws into the loop.
    }
  }
}

// `testIndex` is bound here and `stepIndex` curried by `loopEmitFor`.
export function createMemberEventSink(deps: {
  bus: RunEventBus
  mask: MaskFn
  testIndex: number
}): MemberEventSink {
  const { bus, mask, testIndex } = deps

  return {
    stepStarted(input: { stepIndex: number; stepText: string }): void {
      guardEmit(bus, () => {
        bus.publish('stepStarted', {
          testIndex,
          stepIndex: input.stepIndex,
          stepText: mask(input.stepText),
        })
      })
    },

    loopEmitFor(stepIndex: number): LoopEventEmitPort {
      return {
        stepFinalized(
          evidence: StepEvidence,
          extra?: Parameters<LoopEventEmitPort['stepFinalized']>[1],
        ): void {
          guardEmit(bus, () => {
            // The projection folds in status, durationMs and error, masking `error`.
            bus.publish(
              'stepFinalized',
              projectStepFinalized(evidence, { testIndex, stepIndex }, mask, extra),
            )
          })
        },
        subActionRecorded(
          evidence: SubActionEvidence,
          subActionIndex: number,
          extra?: Parameters<LoopEventEmitPort['subActionRecorded']>[2],
        ): void {
          guardEmit(bus, () => {
            bus.publish(
              'subActionRecorded',
              projectSubActionRecorded(evidence, { testIndex, stepIndex, subActionIndex }, mask, extra),
            )
          })
        },
      }
    },

    // Hook lifecycle and retry legs cross the same projection and mask as every other payload.
    hookStarted(input: HookStartedPayload): void {
      guardEmit(bus, () => {
        bus.publish('hookStarted', projectHookStarted(input, mask))
      })
    },
    hookFinished(input: HookFinishedPayload): void {
      guardEmit(bus, () => {
        // stdout/stderr/error + every `variables` VALUE are masked at projection (keys preserved).
        bus.publish('hookFinished', projectHookFinished(input, mask))
      })
    },
    testRetryScheduled(input: TestRetryScheduledPayload): void {
      guardEmit(bus, () => {
        // Identifiers and scheduling accounting only, with no captured stream, so no MaskFn.
        bus.publish('testRetryScheduled', projectTestRetryScheduled(input))
      })
    },
  }
}
