import { describe, it, expect } from 'vitest'
import { SuiteDefinitionSchema } from '../suite-schema.js'

const VALID_SUITE_ID = 's_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const VALID_TEST_ID_TWO = 't_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const LEGACY_SUITE_ID = 's_amber-birch-coral-delta-ember-falcon'
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

function makeSuite(overrides: Record<string, unknown> = {}) {
  return {
    name: 'smoke tests',
    target: 'my-app',
    tests: [
      { test: 'tests/login.yaml', id: VALID_TEST_ID },
      { test: 'tests/dashboard.yaml', id: VALID_TEST_ID_TWO },
    ],
    ...overrides,
  }
}

describe('SuiteDefinitionSchema', () => {
  describe('valid suites', () => {
    it('accepts suite with name, target, and tests array', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite())
      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('smoke tests')
      expect(result.data?.tests).toEqual([
        { test: 'tests/login.yaml', id: VALID_TEST_ID },
        { test: 'tests/dashboard.yaml', id: VALID_TEST_ID_TWO },
      ])
    })

    it('accepts suite with name, target, tests, and use block', () => {
      const result = SuiteDefinitionSchema.safeParse({
        ...makeSuite({
          name: 'mobile suite',
          target: 'com.example.app',
          tests: [{ test: 'tests/app-launch.yaml', id: VALID_TEST_ID }],
        }),
        use: {
          browser: { name: 'chromium' },
        },
      })
      expect(result.success).toBe(true)
      expect(result.data?.target).toBe('com.example.app')
    })

    it('accepts suite with target only (no use block)', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'target-only',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
      }))
      expect(result.success).toBe(true)
      expect(result.data?.target).toBe('my-app')
    })

    it('accepts use with browser as object', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'browser-only',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { browser: { name: 'firefox' } },
      }))
      expect(result.success).toBe(true)
      expect(result.data?.use?.browser?.name).toBe('firefox')
    })

    it('accepts suite with structured timeout in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'timeout suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { timeout: { step: '1m' } },
      }))
      expect(result.success).toBe(true)
      expect(result.data?.use?.timeout?.step).toBe(60000)
    })

    it('accepts suite with llm string reference in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'llm suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { llm: 'claude-main' },
      }))
      expect(result.success).toBe(true)
      expect(result.data?.use?.llm).toBe('claude-main')
    })

    it('accepts suite with healing in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'healing suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: {
          healing: { maxAttempts: 3 },
        },
      }))
      expect(result.success).toBe(true)
    })

    it('accepts suite with explicit mobile device and app-state override', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'mobile suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: {
          device: 'ios-sim',
          mobile: {
            appState: 'reset',
          },
        },
      }))
      expect(result.success).toBe(true)
      expect(result.data?.use?.device).toBe('ios-sim')
      expect(result.data?.use?.mobile?.appState).toBe('reset')
    })

    it('accepts scoped cache disable in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'cache-disabled suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: {
          cache: false,
        },
      }))

      expect(result.success).toBe(true)
      expect(result.data?.use?.cache).toBe(false)
    })

    it('accepts a root auth-state logical name in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'auth-state suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: {
          authState: 'admin',
        },
      }))

      expect(result.success).toBe(true)
      expect(result.data?.use?.authState).toBe('admin')
    })

    it('accepts root auth-state object form in use block', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'auth-state producer suite',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
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

    it('accepts suite with context field', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'x',
        tests: [{ test: 't.yaml', id: VALID_TEST_ID }],
        context: 'Suite info',
      }))
      expect(result.success).toBe(true)
      expect(result.data?.context).toBe('Suite info')
    })

    it('accepts suite without context field', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'x',
        tests: [{ test: 't.yaml', id: VALID_TEST_ID }],
      }))
      expect(result.success).toBe(true)
      expect(result.data?.context).toBeUndefined()
    })

    it('accepts suite with suite-id', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'identified suite',
        'suite-id': VALID_SUITE_ID,
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
      }))
      expect(result.success).toBe(true)
      expect(result.data?.['suite-id']).toBe(VALID_SUITE_ID)
    })

    it('accepts canonical hook ids in setup and teardown', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        setup: [VALID_HOOK_ID],
        teardown: [VALID_HOOK_ID],
      }))
      expect(result.success).toBe(true)
    })
  })

  describe('invalid suites', () => {
    it('rejects suite missing name', () => {
      const result = SuiteDefinitionSchema.safeParse({
        target: 'my-app',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
      })
      expect(result.success).toBe(false)
    })

    it('rejects suite with empty tests array', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'empty',
        target: 'my-app',
        tests: [],
      })
      expect(result.success).toBe(false)
    })

    it('rejects suite missing tests field', () => {
      const result = SuiteDefinitionSchema.safeParse({ name: 'no tests', target: 'my-app' })
      expect(result.success).toBe(false)
    })

    it('rejects use with invalid platform value (strict rejects unknown keys)', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'bad platform',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { platform: 'windows' },
      }))
      expect(result.success).toBe(false)
    })

    it('rejects use.browser as plain string', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'string browser',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { browser: 'firefox' },
      }))
      expect(result.success).toBe(false)
    })

    it('rejects stale use.actionProofs', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'stale action proofs',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        use: { actionProofs: 'strict' },
      }))
      expect(result.success).toBe(false)
    })

    it('rejects unsafe auth-state logical names in root use block', () => {
      for (const authState of INVALID_AUTH_STATE_VALUES) {
        const result = SuiteDefinitionSchema.safeParse(makeSuite({
          name: 'bad auth state',
          tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
          use: {
            authState,
          },
        }))

        expect(result.success, JSON.stringify(authState)).toBe(false)
      }
    })

    it('rejects member-level auth-state use blocks', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        tests: [
          {
            test: 'tests/login.yaml',
            id: VALID_TEST_ID,
            use: { authState: 'admin' },
          },
        ],
      }))

      expect(result.success).toBe(false)
    })

    it('rejects old config: key with z.strict()', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        name: 'old style',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        config: { platform: 'web' },
      }))
      expect(result.success).toBe(false)
    })

    it('rejects unknown extra fields with z.strict()', () => {
      const result = SuiteDefinitionSchema.safeParse({
        ...makeSuite({
          name: 'extended',
          tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
        }),
        description: 'some description',
        custom_field: 42,
      })
      expect(result.success).toBe(false)
    })

    it('rejects bare string in tests array', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'bare strings',
        tests: ['a.yaml'],
      })
      expect(result.success).toBe(false)
    })

    it('rejects test entry missing id', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'no id',
        target: 'my-app',
        tests: [{ test: 'a.yaml' }],
      })
      expect(result.success).toBe(false)
    })

    it('rejects legacy test entry ids', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        tests: [{ test: 'a.yaml', id: LEGACY_TEST_ID }],
      }))
      expect(result.success).toBe(false)
    })

    it('rejects test entry with extra fields', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'extra field',
        target: 'my-app',
        tests: [{ test: 'a.yaml', id: VALID_TEST_ID, extra: 1 }],
      })
      expect(result.success).toBe(false)
    })

    it('rejects suite without target field', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'no target',
        tests: [{ test: 'test.yaml', id: 't_no-target-reject-suite-test' }],
      })
      expect(result.success).toBe(false)
    })

    it('rejects suite with url field (removed)', () => {
      const result = SuiteDefinitionSchema.safeParse({
        name: 'has url',
        target: 'test-target',
        url: 'https://example.com',
        tests: [{ test: 'test.yaml', id: VALID_TEST_ID }],
      })
      expect(result.success).toBe(false)
    })

    it('rejects legacy suite-id values', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        'suite-id': LEGACY_SUITE_ID,
      }))
      expect(result.success).toBe(false)
    })

    it('rejects legacy hook ids in setup and teardown', () => {
      const result = SuiteDefinitionSchema.safeParse(makeSuite({
        setup: [LEGACY_HOOK_ID],
        teardown: [LEGACY_HOOK_ID],
      }))
      expect(result.success).toBe(false)
      expect(result.error?.issues.map((issue) => issue.message)).toContain('Hook ID must be h_ followed by 10 id-agent words')
    })
  })
})
