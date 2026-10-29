import { describe, expect, it } from 'vitest'
import type { Action, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeActionPlan, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

const PASSWORD = 'hunter2-correct-horse'
const TOKEN = 'tok-9f8e7d6c'

const refusalFor = (name: string) =>
  `This action contains the masked placeholder [secret:${name}]; it would type the placeholder ` +
  `text. Use {{secret:${name}}} to type the secret.`

function recordingAdapter(calls: Action[]): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return makeScreenState()
    },
    async execute(action: Action) {
      calls.push(action)
      return { success: true }
    },
  }
}

async function runOne(action: Record<string, unknown> & { type: string }) {
  const calls: Action[] = []
  const secretStore = new SecretStore({ PASSWORD, TOKEN })
  const ports: LoopPorts = {
    adapter: recordingAdapter(calls),
    planner: makePlanner([makeActionPlan({ action, stepComplete: true })]),
    verifier: makeVerifier(),
    plannerConfig: { maxActions: 2, maxPlanningTurns: 2, previousStepCount: 0 },
    secretStore,
    secretRedactor: new SecretRedactor(secretStore),
  }
  const result = await executeStep('Sign in', ports, makeStepContext())
  return { calls, result, sub: result.evidence?.subActions[0] }
}

describe('a masked secret placeholder is refused before dispatch', () => {
  it('a fill whose value is the masked placeholder never reaches the app', async () => {
    const { calls, sub } = await runOne({
      type: 'fill',
      ref: 'e2',
      text: '[secret:PASSWORD]',
      clearMode: 'replace',
      submit: false,
    })
    expect(calls).toHaveLength(0)
    expect(sub?.result.success).toBe(false)
    expect(sub?.result.error).toBe(refusalFor('PASSWORD'))
  })

  it('a navigation or descriptor holding the placeholder is refused the same way', async () => {
    const navigation = await runOne({
      type: 'navigate',
      to: 'url',
      url: 'https://app.example.test/?token=[secret:TOKEN]',
    })
    expect(navigation.calls).toHaveLength(0)
    expect(navigation.sub?.result.error).toBe(refusalFor('TOKEN'))

    const described = await runOne({
      type: 'waitFor',
      on: 'text',
      text: 'Signed in with [secret:TOKEN]',
      timeoutMs: 1000,
    })
    expect(described.calls).toHaveLength(0)
    expect(described.sub?.result.error).toBe(refusalFor('TOKEN'))
  })

  it('the template form still types the real value', async () => {
    const { calls, sub } = await runOne({
      type: 'fill',
      ref: 'e2',
      text: '{{secret:PASSWORD}}',
      clearMode: 'replace',
      submit: false,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'fill', text: PASSWORD })
    expect(sub?.plannedAction).toMatchObject({ type: 'fill', text: '[secret:PASSWORD]' })
  })

  it('an undeclared template still fails as before', async () => {
    const { calls, sub } = await runOne({
      type: 'fill',
      ref: 'e2',
      text: '{{secret:NEVER}}',
      clearMode: 'replace',
      submit: false,
    })
    expect(calls).toHaveLength(0)
    expect(sub?.result.error).toBe('Secret not found: NEVER')
  })

  it('the refusal names only the marker', async () => {
    const { sub } = await runOne({
      type: 'fill',
      ref: 'e2',
      text: `[secret:PASSWORD] ${PASSWORD}`,
      clearMode: 'replace',
      submit: false,
    })
    expect(sub?.result.error).toBe(refusalFor('PASSWORD'))
    expect(sub?.result.error).not.toContain(PASSWORD)
    expect(sub?.result.error).not.toContain(TOKEN)
  })
})
