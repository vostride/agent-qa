// Engine test fixtures for the replay engine: leaf / procedure cassette
// builders plus scripted ReplayPlannerFactory fakes and a fixed-increment fake clock.
// Test-only module — exempt from the src module-discipline scan.

import { makeScreenState } from '@vostride/agent-qa-runner'
import type { NonActionToolMap, PlanResult, StepContext } from '@vostride/agent-qa-runner'
import { asRef } from '@vostride/agent-qa-schema'
import type { Action, Platform, ScreenState, ServedBrief } from '@vostride/agent-qa-schema'
import type { CassetteInputLeg } from '../../cassette/input-leg'
import type { CassetteLabelLeg } from '../../cassette/label-leg'
import type { CassetteReceipt } from '../../cassette/receipt-leg'
import type { CassetteSidecarLeg } from '../../cassette/sidecar-leg'
import type {
  LeafCassette,
  ProcedureCassette,
  ProcedureEndState,
  ProcedureStepRecord,
  DecisionRecord,
} from '../../cassette/cassette'
import { CASSETTE_SCHEMA_VERSION } from '../../cassette/cassette'
import type { ReplayClock, ReplayPlannerFactory, ReplayPlannerHandle } from '../ports'

/** A wire-shape action as it rides PlanResult.plan.action. */
export interface WireAction {
  type: string
  [key: string]: unknown
}

export function emptyBrief(): ServedBrief {
  return {
    scope: { tier: 'test', key: 'k' },
    asOfBuild: 1,
    budget: 100,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'digest',
  } as ServedBrief
}

export function makeLeg(overrides: Partial<CassetteInputLeg> = {}): CassetteInputLeg {
  return {
    testId: 'test-login',
    testIndex: 0,
    stepIndex: 0,
    decisionOrdinal: 0,
    stepText: 'Click the login button',
    stateBefore: makeScreenState(),
    servedBrief: emptyBrief(),
    exchanges: [],
    ...overrides,
  }
}

/** A full-capture ScreenState carrying a screenshot ref that resolves no bytes. */
export function fullCaptureScreenState(): ScreenState {
  const base = makeScreenState()
  return {
    ...base,
    metadata: {
      ...base.metadata,
      captureMode: 'full',
      imageWidth: 390,
      imageHeight: 844,
    },
  }
}

export function makeReceipt(overrides: Partial<CassetteReceipt> = {}): CassetteReceipt {
  return {
    promptInputHash: 'hash-recorded',
    model: { declared: { provider: 'openai', modelId: 'gpt-x' } },
    sampling: {},
    screenStateHash: 'screen-state-hash',
    judge: {},
    buildOrdinal: 1,
    ...overrides,
  }
}

/** Real matcher gold with a ref action and stable semantic anchor (Phase 369 F1). */
export function makeSidecar(
  overrides: Partial<CassetteSidecarLeg> = {},
): CassetteSidecarLeg {
  const goldAction: Action = overrides.goldAction ?? { type: 'click', ref: asRef('e1') }
  const defaultGoldAnchor = {
    role: 'button',
    nameNormalized: 'submit',
    ordinal: 0,
  }
  const goldAnchor = overrides.goldAnchor ?? defaultGoldAnchor
  const equivalenceSet = overrides.equivalenceSet ?? [{ ...goldAnchor, ref: 'e1' }]

  return {
    goldAction,
    opClass: overrides.opClass ?? goldAction.type,
    ...(overrides.goldValue === undefined ? {} : { goldValue: overrides.goldValue }),
    goldAnchor,
    equivalenceSet,
    ...(overrides.annotation === undefined ? {} : { annotation: overrides.annotation }),
  }
}

/** Honest label provenance, with pair-aware defaults for synthetic D-15 fixtures. */
export function makeLabel(overrides: Partial<CassetteLabelLeg> = {}): CassetteLabelLeg {
  const hasPairing = overrides.pairing !== undefined
  return {
    sourceChannel:
      overrides.sourceChannel ?? (hasPairing ? 'self-heal-pair' : 'recorded-verdict'),
    tier: overrides.tier ?? (hasPairing ? 'near-gold' : 'silver'),
    ...(overrides.verdict === undefined ? {} : { verdict: overrides.verdict }),
    ...(overrides.recordedFailure === undefined
      ? {}
      : { recordedFailure: overrides.recordedFailure }),
    ...(overrides.rootCause === undefined ? {} : { rootCause: overrides.rootCause }),
    ...(overrides.pairing === undefined ? {} : { pairing: overrides.pairing }),
  }
}

export interface LeafCassetteOverrides {
  leg?: Partial<CassetteInputLeg>
  sidecar?: CassetteSidecarLeg
  label?: CassetteLabelLeg
  receipt?: Partial<CassetteReceipt>
  completeness?: LeafCassette['completeness']
  id?: string
}

export function leafCassette(overrides: LeafCassetteOverrides = {}): LeafCassette {
  const leg = makeLeg(overrides.leg)
  return {
    schemaVersion: CASSETTE_SCHEMA_VERSION,
    id: overrides.id ?? 'cassette-leaf-1',
    runId: 'run-1',
    testId: leg.testId,
    testIndex: 0,
    blobs: [],
    completeness: overrides.completeness ?? { status: 'complete' },
    granularity: 'leaf',
    stepIndex: 0,
    decisionOrdinal: 0,
    input: leg,
    sidecar: overrides.sidecar ?? makeSidecar(),
    label: overrides.label ?? makeLabel(),
    receipt: makeReceipt(overrides.receipt),
  }
}

export interface ProcedureDecisionOverrides {
  leg?: Partial<CassetteInputLeg>
  sidecar?: CassetteSidecarLeg
  label?: CassetteLabelLeg
  receipt?: Partial<CassetteReceipt>
}

function decisionRecord(
  baseLeg: Partial<CassetteInputLeg>,
  overrides: ProcedureDecisionOverrides = {},
): DecisionRecord {
  return {
    input: makeLeg({ ...baseLeg, ...overrides.leg }),
    sidecar: overrides.sidecar ?? makeSidecar(),
    label: overrides.label ?? makeLabel(),
    receipt: makeReceipt(overrides.receipt),
  }
}

export const PROCEDURE_END_STATE = { outcome: 'passed' } as unknown as ProcedureEndState

export function procedureCassette(
  decisionOverrides: readonly ProcedureDecisionOverrides[] = [],
): ProcedureCassette {
  const steps: ProcedureStepRecord[] = [
    {
      kind: 'decision',
      stepIndex: 0,
      decisionOrdinal: 0,
      record: decisionRecord({ stepIndex: 0 }, decisionOverrides[0]),
    },
    { kind: 'cache-served', stepIndex: 1, decisionOrdinal: 0 },
    { kind: 'synthesized', stepIndex: 2 },
    {
      kind: 'decision',
      stepIndex: 3,
      decisionOrdinal: 0,
      record: decisionRecord({ stepIndex: 3 }, decisionOverrides[1]),
    },
  ]
  return {
    schemaVersion: CASSETTE_SCHEMA_VERSION,
    id: 'cassette-proc-1',
    runId: 'run-1',
    testId: 'test-login',
    testIndex: 0,
    blobs: [],
    completeness: { status: 'complete' },
    granularity: 'procedure',
    steps,
    endState: PROCEDURE_END_STATE,
  }
}

// --- Scripted planner-factory fakes ---------------------------------------

export interface FactoryProbe {
  factory: ReplayPlannerFactory
  createCount(): number
  creates(): { platform: Platform; nonActionTools: NonActionToolMap }[]
}

const DUMMY_MODEL = 'planner-model' as unknown as StepContext['plannerModel']

/**
 * A factory whose per-sample `plan()` delegates to a script keyed by the zero-based create
 * call index. The script returns a PlanResult or throws — the engine classifies the throw.
 * Records every create() input so tests assert per-sample freshness and call counts.
 */
export function makeFactory(
  plan: (callIndex: number) => Promise<PlanResult> | PlanResult,
  replayedModel: { provider: string; modelId: string } = { provider: 'test', modelId: 'model-1' },
): FactoryProbe {
  const creates: { platform: Platform; nonActionTools: NonActionToolMap }[] = []
  const factory: ReplayPlannerFactory = {
    create(input): ReplayPlannerHandle {
      const callIndex = creates.length
      creates.push(input)
      return {
        model: DUMMY_MODEL,
        replayedModel,
        plan: async () => plan(callIndex),
      }
    },
  }
  return {
    factory,
    createCount: () => creates.length,
    creates: () => creates,
  }
}

export function decisionPlan(action: WireAction, tokenUsage?: PlanResult['tokenUsage']): PlanResult {
  return {
    plan: { reasoning: '', action, confidence: 1, stepComplete: true },
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
  }
}

/** A factory that returns pre-programmed grounded actions, one per create() call. */
export function actionsFactory(actions: readonly WireAction[]): FactoryProbe {
  return makeFactory(callIndex => decisionPlan(actions[callIndex] ?? actions[actions.length - 1]))
}

/** A fixed-increment monotonic fake clock (the ONLY time source the engine consumes). */
export function fixedIncrementClock(step = 10, start = 1000): ReplayClock {
  let value = start
  return {
    now(): number {
      const current = value
      value += step
      return current
    },
  }
}
