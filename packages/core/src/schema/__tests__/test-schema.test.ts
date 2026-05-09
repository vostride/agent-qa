import { describe, expect, it } from 'vitest'
import { TestDefinitionSchema } from '../test-schema.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const LEGACY_TEST_ID = 't_amber-birch-coral-delta-ember-falcon'
const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const LEGACY_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon'

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
