import { describe, expect, it } from 'vitest'
import { TestDefinitionSchema } from '../test-schema.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const LEGACY_TEST_ID = 't_amber-birch-coral-delta-ember-falcon'
const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const LEGACY_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon'
const INVALID_AUTH_STATE_VALUES: unknown[] = [
  'Admin',
  'admin/user',
  '../admin',
  '.admin',
  'admin-',
  '',
  ['admin'],
  { name: 'Admin' },
  { name: '../admin' },
  { name: 'admin', mode: 'replace' },
  { name: 'admin', load: 'yes' },
  { load: false, capture: true },
]

function makeTestDefinition(overrides: Record<string, unknown> = {}) {
  return {
    'test-id': VALID_TEST_ID,
    name: 'Login flow',
    target: 'demo-target',
    steps: ['Open the login page'],
    ...overrides,
  }
}

describe('TestDefinitionSchema', () => {
  it('accepts a canonical 10-word test-id', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition())
    expect(result.success).toBe(true)
  })

  it('rejects a legacy 6-word test-id', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({ 'test-id': LEGACY_TEST_ID }))
    expect(result.success).toBe(false)
  })

  it('rejects a test-id with the wrong prefix', () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ 'test-id': 's_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle' }),
    )
    expect(result.success).toBe(false)
  })

  it('accepts canonical hook ids in setup and teardown', () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ setup: [VALID_HOOK_ID], teardown: [VALID_HOOK_ID] }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts explicit mobile device and app-state override', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({
      use: {
        device: 'android-emu',
        mobile: {
          appState: 'reset',
        },
      },
    }))

    expect(result.success).toBe(true)
    expect(result.data?.use?.device).toBe('android-emu')
    expect(result.data?.use?.mobile?.appState).toBe('reset')
  })

  it('accepts scoped cache disable in use block', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({
      use: {
        cache: false,
      },
    }))

    expect(result.success).toBe(true)
    expect(result.data?.use?.cache).toBe(false)
  })

  it('accepts a root auth-state logical name in use block', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({
      use: {
        authState: 'admin',
      },
    }))

    expect(result.success).toBe(true)
    expect(result.data?.use?.authState).toBe('admin')
  })

  it('accepts root auth-state object form in use block', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({
      use: {
        authState: {
          name: 'admin',
          load: false,
          capture: true,
        },
      },
    }))

    expect(result.success).toBe(true)
    expect(result.data?.use?.authState).toEqual({
      name: 'admin',
      load: false,
      capture: true,
    })
  })

  it('rejects unsafe auth-state logical names in root use block', () => {
    for (const authState of INVALID_AUTH_STATE_VALUES) {
      const result = TestDefinitionSchema.safeParse(makeTestDefinition({
        use: {
          authState,
        },
      }))

      expect(result.success, JSON.stringify(authState)).toBe(false)
    }
  })

  it('rejects stale use.actionProofs', () => {
    const result = TestDefinitionSchema.safeParse(makeTestDefinition({
      use: {
        actionProofs: 'strict',
      },
    }))

    expect(result.success).toBe(false)
  })

  it('rejects legacy hook ids in setup and teardown', () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ setup: [LEGACY_HOOK_ID], teardown: [LEGACY_HOOK_ID] }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain('Hook ID must be h_ followed by 10 id-agent words')
  })
})

describe('removed step fields', () => {
  function issueAt(result: ReturnType<typeof TestDefinitionSchema.safeParse>, path: string) {
    return result.error?.issues.find((issue) => issue.path.join('.') === path)
  }

  it("refuses a step's retries with its path and the removal message", () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ steps: ['Open', 'Search', { step: 'Pay', retries: 2 }] }),
    )

    expect(result.success).toBe(false)
    const issue = issueAt(result, 'steps.2.retries')
    expect(issue?.message).toBe(
      'steps[].retries was removed: a test retries as a whole; set meta.retries. Delete this line.',
    )
    expect((issue as { params?: unknown } | undefined)?.params).toEqual({ retired: true })
  })

  it("refuses a step's screenshot with its path and the removal message", () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ steps: ['Open', 'Search', { step: 'Pay', screenshot: true }] }),
    )

    expect(result.success).toBe(false)
    const issue = issueAt(result, 'steps.2.screenshot')
    expect(issue?.message).toBe(
      'steps[].screenshot was removed: screenshots are set per run; pass --screenshot-mode every-step to agent-qa run. Delete this line.',
    )
    expect((issue as { params?: unknown } | undefined)?.params).toEqual({ retired: true })
  })

  it("a step's timeout still parses", () => {
    const result = TestDefinitionSchema.safeParse(
      makeTestDefinition({ steps: [{ step: 'Pay', timeout: '15s' }] }),
    )

    expect(result.success).toBe(true)
    expect(result.data?.steps[0]).toEqual({ step: 'Pay', timeout: 15000 })
  })
})
