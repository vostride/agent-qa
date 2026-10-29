// Every element tool takes the ref plus the stated target — role, name and row words — and an
// ordinal is a hard schema error, from the tool call through the provider JSON schema into the plan
// the check reads. Each grounding error hint names its remedy.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { LLMPlanner } from '../../loop/planner.js'
import type { PlanResult } from '../../loop/types.js'
import { makeFakeTokenAccounting, makeStepContext } from '../../loop/__tests__/loop-harness.js'
import { targetSchema } from '../actions/index.js'
import { describeBoundSurface, toolCallToActionPlan } from '../builder.js'
import { groundActionPlan } from '../../grounding/gate.js'
import { GroundingError, groundingError } from '../errors.js'
import { defaultRegistry } from '../index.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const PLAN_FIELDS = {
  reasoning: 'Click Log in',
  confidence: 0.9,
  stepComplete: true,
  doesActionAdvanceUsTowardsGoal: true,
}

function codeOf(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof GroundingError ? error.code : String(error)
  }
}

describe('C438-TARGET-SCHEMA', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('targetSchema takes role, name and row words', () => {
    expect(
      targetSchema.safeParse({ role: 'button', name: 'Edit label', row: '7 Elm Street' }).success,
    ).toBe(true)
    expect(targetSchema.safeParse({ role: 'button', name: 'Edit label' }).success).toBe(true)
  })

  it('targetSchema rejects an ordinal', () => {
    expect(targetSchema.safeParse({ role: 'button', name: 'Save', ordinal: 0 }).success).toBe(false)
  })

  it('targetSchema requires the role', () => {
    expect(targetSchema.safeParse({ name: 'Save' }).success).toBe(false)
  })

  it('targetSchema rejects near and selector-like keys', () => {
    expect(
      targetSchema.safeParse({ role: 'button', name: 'Save', near: { nameNormalized: 'email' } })
        .success,
    ).toBe(false)
    expect(targetSchema.safeParse({ role: 'button', name: 'Save', selector: '#save' }).success).toBe(
      false,
    )
  })

  it("web_click's provider JSON schema closes target to role, name and row", () => {
    const entry = describeBoundSurface(defaultRegistry, { platform: 'web' }).find(
      (tool) => tool.name === 'web_click',
    )
    const parameters = entry?.parameters as {
      properties: Record<string, { additionalProperties?: unknown; required?: string[]; properties?: object }>
    }
    const target = parameters.properties['target']

    expect(target?.additionalProperties).toBe(false)
    expect([...(target?.required ?? [])].sort().join(', ')).toBe('name, role')
    expect(Object.keys(target?.properties ?? {}).sort().join(', ')).toBe('name, role, row')
  })

  it('a tool call carries the ref and the stated target into the plan', () => {
    let plan: ReturnType<typeof toolCallToActionPlan> | undefined
    const code = codeOf(() => {
      plan = toolCallToActionPlan(
        'web_click',
        { ref: 'e2', target: { role: 'button', name: 'Log in', row: 'Account' }, ...PLAN_FIELDS },
        defaultRegistry,
      )
    })

    expect(code).toBeUndefined()
    expect(plan?.action).toMatchObject({
      type: 'click',
      ref: 'e2',
      target: { role: 'button', name: 'Log in', row: 'Account' },
    })
  })

  it('a tool call whose target carries an ordinal throws schema_invalid', () => {
    const code = codeOf(() => {
      toolCallToActionPlan(
        'web_click',
        { ref: 'e2', target: { role: 'button', name: 'Log in', ordinal: 0 }, ...PLAN_FIELDS },
        defaultRegistry,
      )
    })

    expect(code).toBe('schema_invalid')
  })

  it("a planning turn's stated row reaches the plan", async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{
        toolName: 'web_click',
        input: { ref: 'e2', target: { role: 'button', name: 'Log in', row: 'Account' }, ...PLAN_FIELDS },
      }],
      usage: { inputTokens: 10, outputTokens: 2 },
    } as never)
    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())

    const result = await planner
      .plan('Click Log in', makeScreenState(), makeStepContext())
      .catch((error: GroundingError) => ({ code: error.code }))

    expect(result).not.toHaveProperty('code')
    const { plan } = result as PlanResult

    expect(plan.statedTargets?.ref).toEqual({ role: 'button', name: 'Log in', row: 'Account' })
    expect(plan.action).not.toHaveProperty('target')
  })
})

describe('C438-HINTS', () => {
  it('an unresolved target names role, name and row words as the restatement', () => {
    const { hint } = groundingError.descriptorUnresolved('web_click', 'button "Save"')

    expect(hint).toMatch(/\brole\b/)
    expect(hint).toMatch(/\bname\b/)
    expect(hint).toMatch(/row words/)
  })

  it('an ambiguous target keeps the count and points at the ref the step means, never a pick', () => {
    const { message, hint } = groundingError.descriptorAmbiguous('web_click', 'button "Okay"', 3)

    expect(message).toContain('3 elements match button "Okay"')
    expect(hint).toMatch(/ref of the element the step means/)
    expect(hint).toMatch(/latest observation/)
    expect(hint).toMatch(/does not say which/)
    expect(hint).toMatch(/report the candidates and do not choose/)
  })

  it('no-handle says an element action needs a ref with its target, or a target alone', () => {
    const { message, hint } = groundingError.descriptorInvalid('web_click', 'no-handle')

    expect(message).toContain('needs a ref (with its stated target) or, with no confident ref, a target')
    expect(hint).toMatch(/\bref\b/)
    expect(hint).toMatch(/no confident ref, send the target alone/)
  })

  it('near-unsupported points at name and role', () => {
    const { message, hint } = groundingError.descriptorInvalid('web_click', 'near-unsupported')

    expect(message).toMatch(/use name and role/)
    expect(hint).toMatch(/role and name/)
  })

  it('a descriptor renders as its role and quoted name only', () => {
    const result = groundActionPlan({
      toolName: 'click',
      action: { type: 'click', target: { role: 'button', name: 'Okay', ordinal: 7 } },
      screenState: makeScreenState(),
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('button "Okay" for tool')
  })
})
