import { describe, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type {
  Action as SchemaAction,
  ModelCallRecord,
  ToolExchangeEvidence,
} from '@vostride/agent-qa-schema'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { LoopPorts } from '../ports.js'
import type { Planner, PlanResult } from '../types.js'
import { EvidenceRecorder } from '../evidence.js'
import { executeStep } from '../index.js'
import { maskToolExchanges } from '../mask-exchanges.js'
import { PlanningTurnError } from '../planner.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeAdapter, makeStepContext } from './loop-harness.js'

const RAW_SECRET = 'sk-live-registered-secret'
const MASKED_SECRET = '[secret:ACCOUNT_TOKEN]'
const CLICK_ACTION: SchemaAction = { type: 'click', ref: asRef('e2') }
const CALL_RECORD: ModelCallRecord = {
  resolvedModelId: 'resolved-planner-model',
  effectiveSampling: { temperature: 0 },
}

const secretRedactor = new SecretRedactor(new SecretStore({ ACCOUNT_TOKEN: RAW_SECRET }))
const mask = (text: string) => secretRedactor.redactString(text)

function exchangeWithSecret(): ToolExchangeEvidence {
  return {
    tool: 'lookup_account',
    args: {
      attempts: 2,
      enabled: true,
      nested: [{ authorization: `Bearer ${RAW_SECRET}`, untouched: null }],
    },
    result: `account token=${RAW_SECRET}`,
  }
}

function finalize(recorder: EvidenceRecorder) {
  return recorder.finalize({ pass: true, reasoning: 'goal met' }, 0, 'log in')
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

describe('maskToolExchanges', () => {
  it('masks nested string leaves while preserving structure, scalar values, and tool identifiers', () => {
    const source = [exchangeWithSecret()]

    const masked = maskToolExchanges(source, mask)

    expect(masked).toEqual([
      {
        tool: 'lookup_account',
        args: {
          attempts: 2,
          enabled: true,
          nested: [{ authorization: `Bearer ${MASKED_SECRET}`, untouched: null }],
        },
        result: `account token=${MASKED_SECRET}`,
      },
    ])
    expect(masked[0].tool).toBe(source[0].tool)
    expect(source[0].args).toEqual({
      attempts: 2,
      enabled: true,
      nested: [{ authorization: `Bearer ${RAW_SECRET}`, untouched: null }],
    })
  })
})

describe('EvidenceRecorder exchange fields', () => {
  it('copies present exchanges and call records onto SubActionEvidence', () => {
    const recorder = new EvidenceRecorder()
    const exchanges = maskToolExchanges([exchangeWithSecret()], mask)
    recorder.recordSubAction({
      plan: 'click log in',
      plannedAction: CLICK_ACTION,
      stateBefore: makeScreenState(),
      result: { success: true },
      exchanges,
      callRecord: CALL_RECORD,
    })

    const subAction = finalize(recorder).subActions[0]

    expect(subAction.exchanges).toEqual(exchanges)
    expect(subAction.callRecord).toEqual(CALL_RECORD)
  })

  it('leaves exchanges and callRecord structurally absent when they were not supplied', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'replay cached click',
      plannedAction: CLICK_ACTION,
      stateBefore: makeScreenState(),
      result: { success: true },
    })

    const subAction = finalize(recorder).subActions[0]

    expect('exchanges' in subAction).toBe(false)
    expect('callRecord' in subAction).toBe(false)
  })

  it('records planning failures conditionally on finalized StepEvidence', () => {
    const recorder = new EvidenceRecorder()
    const exchanges = maskToolExchanges([exchangeWithSecret()], mask)
    recorder.recordPlanningFailure({
      reason: 'no_action_tool_called',
      message: 'Planning turn failed after a re-prompt.',
      exchanges,
      callRecord: CALL_RECORD,
    })

    expect(finalize(recorder).planningFailure).toEqual({
      reason: 'no_action_tool_called',
      message: 'Planning turn failed after a re-prompt.',
      exchanges,
      callRecord: CALL_RECORD,
    })
    expect(finalize(new EvidenceRecorder()).planningFailure).toBeUndefined()
  })

  it('never serializes a raw registered secret after mask-before-record', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'look up account',
      plannedAction: CLICK_ACTION,
      stateBefore: makeScreenState(),
      result: { success: true },
      exchanges: maskToolExchanges([exchangeWithSecret()], mask),
    })

    const serialized = JSON.stringify(finalize(recorder))

    expect(serialized).not.toContain(RAW_SECRET)
    expect(serialized).toContain(MASKED_SECRET)
  })
})

describe('executeStep exchange threading', () => {
  it('records masked exchanges and the call record from a live planner result', async () => {
    const planner: Planner = {
      async plan(): Promise<PlanResult> {
        return {
          plan: makeActionPlan(),
          exchanges: [exchangeWithSecret()],
          callRecord: CALL_RECORD,
        }
      },
    }

    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner, secretRedactor }),
      makeStepContext(),
    )

    const subAction = result.evidence?.subActions[0]
    expect(subAction?.exchanges).toEqual(maskToolExchanges([exchangeWithSecret()], mask))
    expect(subAction?.callRecord).toEqual(CALL_RECORD)
    expect(JSON.stringify(result.evidence)).not.toContain(RAW_SECRET)
  })

  it('recovers a typed planner failure into masked planningFailure evidence', async () => {
    const planner: Planner = {
      async plan(): Promise<PlanResult> {
        throw new PlanningTurnError(
          'no_action_tool_called',
          'Model produced no action tool call after a re-prompt.',
          [exchangeWithSecret()],
          CALL_RECORD,
        )
      },
    }

    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner, secretRedactor }),
      makeStepContext(),
    )

    expect(result.status).toBe('failed')
    expect(result.evidence?.planningFailure).toEqual({
      reason: 'no_action_tool_called',
      message:
        'Planning turn failed (no_action_tool_called): Model produced no action tool call after a re-prompt.',
      exchanges: maskToolExchanges([exchangeWithSecret()], mask),
      callRecord: CALL_RECORD,
    })
    expect(JSON.stringify(result.evidence)).not.toContain(RAW_SECRET)
  })

  it('keeps exchange fields absent on a cache-replayed sub-action', async () => {
    const cachedPlan: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const cache: ActionPlanCache = {
      async get() {
        return cachedPlan
      },
      async set() {},
      async invalidate() {},
    }
    const planner: Planner = {
      async plan(): Promise<PlanResult> {
        throw new Error('planner must not run on a cache hit')
      },
    }

    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner, cache, secretRedactor }),
      makeStepContext(),
    )

    const subAction = result.evidence?.subActions[0]
    expect(subAction).toBeDefined()
    expect('exchanges' in (subAction ?? {})).toBe(false)
    expect('callRecord' in (subAction ?? {})).toBe(false)
  })
})
