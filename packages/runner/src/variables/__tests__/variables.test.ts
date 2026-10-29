import { describe, it, expect, vi, beforeEach } from 'vitest'
import { asRef, normalizeAccessibleName } from '@vostride/agent-qa-schema'
import type { ScreenState, ElementInfo } from '@vostride/agent-qa-schema'
import { makeScreenState as makeBaseScreenState } from '../../testing/screen-fixtures.js'
import {
  VariableStore,
  interpolateVariables,
  interpolateVariablesWithProvenance,
  findBareVariables,
  findUnresolvedTemplates,
  ExplicitExtractor,
  LLMVariableExtractor,
  createExtractor,
} from '../index.js'
import { parseEnvFile, serializeEnvFile } from '../../hooks/env-file.js'
import type { ExtractorInput } from '../../loop/types.js'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn((config: any) => config),
  },
}))

interface LooseElement {
  ref?: string
  role: string
  name: string
  value?: string
  attributes?: Record<string, string>
}

// Local loose-fixture bridge: build a valid v2 ScreenState from the legacy
// hand-shaped elements these variables tests use, filling the required v2 fields
// via the shared runner factory (mirrors the core/agent screen-fixtures bridge).
function makeScreenState(overrides: { tree?: string; url?: string; elements?: LooseElement[] } = {}): ScreenState {
  const base = makeBaseScreenState()
  const elements: LooseElement[] = overrides.elements ?? [
    { ref: 'h-1', role: 'heading', name: 'Order #ORD-456 confirmed', attributes: {} },
    { ref: 'txt-1', role: 'text', name: 'Your order ID is ORD-456', attributes: {} },
    { ref: 'btn-1', role: 'button', name: 'Continue', attributes: {} },
  ]
  const result: ScreenState = {
    ...base,
    tree: overrides.tree ?? 'heading "Order #ORD-456 confirmed"\ntext "Your order ID is ORD-456"\nbutton "Continue" [ref=btn-1]',
    elements: elements.map((e, i): ElementInfo => {
      const el: ElementInfo = {
        ref: asRef(e.ref ?? `e${i + 1}`),
        role: e.role,
        name: e.name,
        nameNormalized: normalizeAccessibleName(e.name),
        state: { enabled: true, focused: false, visible: true },
        labels: {},
        attributes: e.attributes ?? {},
      }
      if (e.value !== undefined) el.value = e.value
      return el
    }),
  }
  if (overrides.url !== undefined) result.url = overrides.url
  else result.url = 'https://example.com/order/confirmed'
  return result
}

describe('VariableStore', () => {
  it('set/get/has/getAll: stores and retrieves variables', () => {
    const store = new VariableStore()
    store.set('orderNum', 'ORD-123')

    expect(store.get('orderNum')).toBe('ORD-123')
    expect(store.has('orderNum')).toBe(true)

    const all = store.getAll()
    expect(all.get('orderNum')).toBe('ORD-123')
  })

  it('get unknown variable returns undefined', () => {
    const store = new VariableStore()
    expect(store.get('nonexistent')).toBeUndefined()
    expect(store.has('nonexistent')).toBe(false)
  })
})

describe('VariableStore source tracking', () => {
  it('set without source defaults to capture', () => {
    const store = new VariableStore()
    store.set('KEY', 'val')
    expect(store.getSource('KEY')).toBe('capture')
  })

  it('set with explicit source stores source', () => {
    const store = new VariableStore()
    store.set('KEY', 'val', 'env')
    expect(store.getSource('KEY')).toBe('env')
    expect(store.get('KEY')).toBe('val')
  })

  it('getSource returns undefined for missing key', () => {
    const store = new VariableStore()
    expect(store.getSource('MISSING')).toBeUndefined()
  })

  it('getAll returns values only, no source leak', () => {
    const store = new VariableStore()
    store.set('A', '1', 'env')
    store.set('B', '2', 'cli')
    const all = store.getAll()
    expect(all.get('A')).toBe('1')
    expect(all.get('B')).toBe('2')
    expect(typeof all.get('A')).toBe('string')
  })

  it('setAll sets all with given source', () => {
    const store = new VariableStore()
    store.setAll({ X: '10', Y: '20' }, 'env')
    expect(store.getSource('X')).toBe('env')
    expect(store.getSource('Y')).toBe('env')
    expect(store.get('X')).toBe('10')
  })

  it('setAll defaults to capture source', () => {
    const store = new VariableStore()
    store.setAll({ K: 'v' })
    expect(store.getSource('K')).toBe('capture')
  })
})

// Pitfall 10 (display neutrality): the capture-over-non-capture warning routes through
// the injected onWarn seam — runner-owned code makes zero console calls.
describe('VariableStore onWarn seam', () => {
  it('capture overwriting env fires onWarn with the source in the message', () => {
    const onWarn = vi.fn()
    const store = new VariableStore({ onWarn })
    store.set('TOKEN', 'from-env', 'env')
    store.set('TOKEN', 'from-capture')
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('capture step overwrites variable "TOKEN"'),
    )
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('was set by env'))
  })

  it('capture overwriting cli fires onWarn exactly once', () => {
    const onWarn = vi.fn()
    const store = new VariableStore({ onWarn })
    store.set('KEY', 'cli-val', 'cli')
    store.set('KEY', 'captured')
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('test (inline) overwriting env does NOT warn (deliberate hierarchy)', () => {
    const onWarn = vi.fn()
    const store = new VariableStore({ onWarn })
    store.set('TOKEN', 'from-env', 'env')
    store.set('TOKEN', 'from-test', 'inline')
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('no onWarn provided: capture overwrite is silent (no throw, no console)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new VariableStore()
    store.set('TOKEN', 'from-env', 'env')
    expect(() => store.set('TOKEN', 'from-capture')).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('parseEnvFile', () => {
  it('parses KEY=value lines', () => {
    expect(parseEnvFile('KEY=value\nFOO=bar')).toEqual({ KEY: 'value', FOO: 'bar' })
  })

  it('skips comments and empty lines', () => {
    expect(parseEnvFile('KEY=value\n# comment\n\nFOO=bar')).toEqual({ KEY: 'value', FOO: 'bar' })
  })

  it('strips double quotes from value', () => {
    expect(parseEnvFile('QUOTED="hello world"')).toEqual({ QUOTED: 'hello world' })
  })

  it('strips single quotes from value', () => {
    expect(parseEnvFile("SINGLE='val'")).toEqual({ SINGLE: 'val' })
  })

  it('skips lines without =', () => {
    expect(parseEnvFile('NOEQ')).toEqual({})
  })

  it('trims key and value', () => {
    expect(parseEnvFile('SPACES = spaced ')).toEqual({ SPACES: 'spaced' })
  })

  it('handles value containing =', () => {
    expect(parseEnvFile('DSN=postgres://host:5432/db?opt=1')).toEqual({ DSN: 'postgres://host:5432/db?opt=1' })
  })

  it('returns empty for empty string', () => {
    expect(parseEnvFile('')).toEqual({})
  })

  it('round-trips the closed quoted grammar without changing value bytes', () => {
    const values = {
      DOUBLE_QUOTE: 'before"after',
      APOSTROPHE: "it's preserved",
      BACKSLASH: String.raw`C:\tmp\agent-qa`,
      CARRIAGE_RETURN: 'before\rafter',
      LINE_FEED: 'before\nafter',
      EMPTY: '',
      SPACES: '  padded value  ',
      EQUALS: 'left=middle=right',
      HASH: '#literal-hash',
    }

    expect(parseEnvFile(serializeEnvFile(values))).toEqual(values)
  })

  it.each([
    ['unterminated double quote', 'TOKEN="phase383-sensitive-value'],
    ['unknown quoted escape', String.raw`TOKEN="phase383-sensitive-value\q"`],
    ['trailing bytes after closing quote', 'TOKEN="phase383-sensitive-value"junk'],
  ])('fails closed on %s with a key/location-only diagnostic', (_name, content) => {
    let error: unknown
    try {
      parseEnvFile(content)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('TOKEN')
    expect(message).toContain('line 1')
    expect(message).not.toContain('phase383-sensitive-value')
  })
})

describe('interpolateVariables', () => {
  it('replaces all {{env:varName}} patterns with stored values', () => {
    const store = new VariableStore()
    store.set('name', 'Alice', 'env')
    store.set('orderNum', 'ORD-123', 'env')

    const result = interpolateVariables('Hello {{env:name}}, order {{env:orderNum}}', store)
    expect(result).toBe('Hello Alice, order ORD-123')
  })

  it('leaves unresolved {{env:missing}} templates intact', () => {
    const store = new VariableStore()
    store.set('name', 'Alice', 'env')

    const result = interpolateVariables('ref {{env:missing}} and {{env:name}}', store)
    expect(result).toBe('ref {{env:missing}} and Alice')
  })

  it('no-op for strings without templates', () => {
    const store = new VariableStore()
    const result = interpolateVariables('no templates here', store)
    expect(result).toBe('no templates here')
  })

  it('bare {{name}} is NOT replaced (no longer matches)', () => {
    const store = new VariableStore()
    store.set('name', 'Alice', 'env')

    const result = interpolateVariables('Hello {{name}}', store)
    expect(result).toBe('Hello {{name}}')
  })

  it('does not resolve runtime secret templates (deliberate skip)', () => {
    const store = new VariableStore()
    store.set('loginPassword', 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7', 'env')

    expect(interpolateVariables('Password {{secret:loginPassword}}', store))
      .toBe('Password {{secret:loginPassword}}')
  })
})

// G-381-3 capture half: interpolation must report WHICH binding
// names produced the substituted text without changing the text it produces. The
// delegation-equality table below is the byte-identity pin — expected strings are the
// literal output of interpolateVariables at the time provenance was introduced, so a
// regression in either implementation breaks the row rather than agreeing with itself.
describe('interpolateVariablesWithProvenance', () => {
  function provenanceStore(): VariableStore {
    const store = new VariableStore()
    store.set('PROBE_USER', 'qa.user@example.com', 'env')
    store.set('PROBE_ORDER', 'ORD-123', 'env')
    store.set('loginPassword', 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7', 'env')
    return store
  }

  const delegationTable: Array<[string, string]> = [
    ['no templates here', 'no templates here'],
    ['', ''],
    ['login as {{env:PROBE_USER}}', 'login as qa.user@example.com'],
    [
      'login as {{env:PROBE_USER}} x {{env:PROBE_USER}} and {{env:MISSING}}',
      'login as qa.user@example.com x qa.user@example.com and {{env:MISSING}}',
    ],
    [
      'order {{env:PROBE_ORDER}} for {{env:PROBE_USER}}',
      'order ORD-123 for qa.user@example.com',
    ],
    ['Password {{secret:loginPassword}}', 'Password {{secret:loginPassword}}'],
    ['bare {{PROBE_USER}} stays', 'bare {{PROBE_USER}} stays'],
    ['{{capture:PROBE_ORDER}}', '{{capture:PROBE_ORDER}}'],
    ['{{env:MISSING}} only', '{{env:MISSING}} only'],
  ]

  it.each(delegationTable)(
    'delegation equality — %j interpolates byte-identically through both entry points',
    (template, expected) => {
      const store = provenanceStore()
      expect(interpolateVariables(template, store)).toBe(expected)
      expect(interpolateVariablesWithProvenance(template, store).text).toBe(expected)
    },
  )

  it('records one insertion-ordered pair per DISTINCT resolved name (dedup)', () => {
    const store = provenanceStore()
    const result = interpolateVariablesWithProvenance(
      'login as {{env:PROBE_USER}} x {{env:PROBE_USER}} for order {{env:PROBE_ORDER}}',
      store,
    )
    expect(result.substitutions).toEqual([
      { name: 'PROBE_USER', value: 'qa.user@example.com' },
      { name: 'PROBE_ORDER', value: 'ORD-123' },
    ])
  })

  it('unresolved {{env:MISSING}} contributes no provenance pair', () => {
    const store = provenanceStore()
    const result = interpolateVariablesWithProvenance(
      'ref {{env:MISSING}} and {{env:PROBE_ORDER}}',
      store,
    )
    expect(result.substitutions).toEqual([{ name: 'PROBE_ORDER', value: 'ORD-123' }])
  })

  it('the deliberately skipped {{secret:...}} template contributes no provenance pair', () => {
    const store = provenanceStore()
    const result = interpolateVariablesWithProvenance('Password {{secret:loginPassword}}', store)
    expect(result.substitutions).toEqual([])
  })

  it('a template-free string yields an empty substitution list', () => {
    const result = interpolateVariablesWithProvenance('no templates here', provenanceStore())
    expect(result.substitutions).toEqual([])
  })

  it('records the value VERBATIM — the pair is never masked or redacted', () => {
    const store = new VariableStore()
    store.set('PROBE_USER', 'qa.user@example.com', 'env')
    store.set('PROBE_API_TOKEN', 'tok-live-9f3a2b', 'env')
    const result = interpolateVariablesWithProvenance(
      'login as {{env:PROBE_USER}} with {{env:PROBE_API_TOKEN}}',
      store,
    )
    expect(result.substitutions).toEqual([
      { name: 'PROBE_USER', value: 'qa.user@example.com' },
      { name: 'PROBE_API_TOKEN', value: 'tok-live-9f3a2b' },
    ])
  })
})

describe('VariableStore single namespace (capture collapsed into env)', () => {
  it('captured variables are accessible via store.get regardless of source', () => {
    const store = new VariableStore()
    store.set('orderId', 'ORD-123', 'capture')
    expect(store.get('orderId')).toBe('ORD-123')
    expect(store.getSource('orderId')).toBe('capture')
  })

  it('all source types accessible via store.get (seeding order last-write-wins)', () => {
    const store = new VariableStore()
    store.set('A', '1', 'env')
    store.set('B', '2', 'inline')
    store.set('C', '3', 'suite')
    store.set('D', '4', 'cli')
    store.set('E', '5', 'capture')
    store.set('F', '6', 'hook')
    store.set('G', '7', 'step')
    expect(store.get('A')).toBe('1')
    expect(store.get('B')).toBe('2')
    expect(store.get('C')).toBe('3')
    expect(store.get('D')).toBe('4')
    expect(store.get('E')).toBe('5')
    expect(store.get('F')).toBe('6')
    expect(store.get('G')).toBe('7')
  })

  it('last write wins across sources (seeding order)', () => {
    const store = new VariableStore()
    store.set('TOKEN', 'env-val', 'env')
    store.set('TOKEN', 'cli-val', 'cli')
    expect(store.get('TOKEN')).toBe('cli-val')
    expect(store.getSource('TOKEN')).toBe('cli')
  })
})

describe('findBareVariables', () => {
  it('detects bare {{NAME}} in text', () => {
    expect(findBareVariables('Click {{NAME}} button')).toEqual(['NAME'])
  })

  it('does not flag namespaced {{env:NAME}}', () => {
    expect(findBareVariables('Click {{env:NAME}} button')).toEqual([])
  })

  it('detects multiple bare variables', () => {
    expect(findBareVariables('Use {{A}} and {{B}}')).toEqual(['A', 'B'])
  })

  it('returns empty for no variables', () => {
    expect(findBareVariables('no variables here')).toEqual([])
  })
})

describe('interpolateVariables with namespaces', () => {
  it('resolves {{env:name}} when set with env source', () => {
    const store = new VariableStore()
    store.set('name', 'Alice', 'env')
    expect(interpolateVariables('Hello {{env:name}}', store)).toBe('Hello Alice')
  })

  it('hook-sourced variables resolve via {{env:TOKEN}} (hook namespace eliminated)', () => {
    const store = new VariableStore()
    store.set('TOKEN', 'abc123', 'env')
    expect(interpolateVariables('Val: {{env:TOKEN}}', store)).toBe('Val: abc123')
  })

  it('{{hook:TOKEN}} syntax does NOT resolve (the namespace was removed)', () => {
    const store = new VariableStore()
    store.set('TOKEN', 'abc123', 'env')
    expect(interpolateVariables('Val: {{hook:TOKEN}}', store)).toBe('Val: {{hook:TOKEN}}')
  })

  it('{{capture:orderId}} does NOT resolve (capture syntax removed)', () => {
    const store = new VariableStore()
    store.set('orderId', 'ORD-99', 'capture')
    expect(interpolateVariables('Captured: {{capture:orderId}}', store)).toBe('Captured: {{capture:orderId}}')
  })

  it('captured variables resolve via {{env:orderId}} syntax', () => {
    const store = new VariableStore()
    store.set('orderId', 'ORD-99', 'capture')
    expect(interpolateVariables('Captured: {{env:orderId}}', store)).toBe('Captured: ORD-99')
  })

  it('unresolved {{env:missing}} passes through unchanged', () => {
    const store = new VariableStore()
    expect(interpolateVariables('Unresolved {{env:missing}}', store)).toBe('Unresolved {{env:missing}}')
  })
})

describe('findUnresolvedTemplates', () => {
  it('returns empty array for text without templates', () => {
    expect(findUnresolvedTemplates('no templates here')).toEqual([])
  })

  it('detects unresolved {{env:MISSING}} with helpful message', () => {
    const result = findUnresolvedTemplates('Hello {{env:MISSING}}')
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe('{{env:MISSING}}')
    expect(result[0].message).toContain("variable 'MISSING' not set")
    expect(result[0].message).toContain('.env')
    expect(result[0].message).toContain('--var')
    expect(result[0].message).toContain('setVariable')
  })

  it('detects unsupported {{capture:orderNum}} with replacement suggestion', () => {
    const result = findUnresolvedTemplates('Use {{capture:orderNum}}')
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe('{{capture:orderNum}}')
    expect(result[0].message).toContain("'capture:' syntax is not supported")
    expect(result[0].message).toContain('{{env:orderNum}}')
  })

  it('detects {{hook:setup}} with runHook suggestion', () => {
    const result = findUnresolvedTemplates('Run {{hook:setup}}')
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe('{{hook:setup}}')
    expect(result[0].message).toContain('Did you mean {{runHook:"h_hook-id"}}')
  })

  it('detects unresolved {{runJS:"code"}} with page availability hint', () => {
    const result = findUnresolvedTemplates('Get {{runJS:"code"}}')
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe('{{runJS:"code"}}')
    expect(result[0].message).toContain('runJS failed to resolve')
    expect(result[0].message).toContain('browser page availability')
  })

  it('detects unknown {{weirdstuff}} as unknown template syntax', () => {
    const result = findUnresolvedTemplates('Bad {{weirdstuff}}')
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe('{{weirdstuff}}')
    expect(result[0].message).toContain('unknown template syntax')
  })

  it('skips the secret template (resolved separately, never leaked here)', () => {
    expect(findUnresolvedTemplates('Fill {{secret:loginPassword}}')).toEqual([])
  })

  it('detects multiple unresolved templates', () => {
    const result = findUnresolvedTemplates('Multiple {{env:A}} and {{capture:B}}')
    expect(result).toHaveLength(2)
  })

  it('does not false positive on [runJS error: msg] placeholders', () => {
    expect(findUnresolvedTemplates('Clean text with [runJS error: msg]')).toEqual([])
  })
})

describe('ExplicitExtractor', () => {
  it('regex mode: captures value from screen tree via capture group', async () => {
    const extractor = new ExplicitExtractor()
    const input: ExtractorInput = {
      method: 'regex',
      variableName: 'orderId',
      pattern: 'Order #(\\S+)',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(true)
    expect(result.variableName).toBe('orderId')
    expect(result.value).toBe('ORD-456')
  })

  it('regex mode: no match returns success=false', async () => {
    const extractor = new ExplicitExtractor()
    const input: ExtractorInput = {
      method: 'regex',
      variableName: 'missing',
      pattern: 'Invoice #(\\d+)',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(false)
    expect(result.variableName).toBe('missing')
  })

  it('selector mode: finds element by role and extracts name', async () => {
    const extractor = new ExplicitExtractor()
    const input: ExtractorInput = {
      method: 'selector',
      variableName: 'heading',
      selector: 'heading',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(true)
    expect(result.variableName).toBe('heading')
    expect(result.value).toBe('Order #ORD-456 confirmed')
  })

  it('selector mode: finds element by name match and returns value if present', async () => {
    const extractor = new ExplicitExtractor()
    const screen = makeScreenState({
      elements: [
        { ref: 'inp-1', role: 'textbox', name: 'Email', value: 'alice@test.com', attributes: {} },
      ],
    })
    const input: ExtractorInput = {
      method: 'selector',
      variableName: 'email',
      selector: 'Email',
    }

    const result = await extractor.extract(input, screen)

    expect(result.success).toBe(true)
    expect(result.value).toBe('alice@test.com')
  })

  it('selector mode: no matching element returns success=false', async () => {
    const extractor = new ExplicitExtractor()
    const input: ExtractorInput = {
      method: 'selector',
      variableName: 'missing',
      selector: 'checkbox',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(false)
  })
})

describe('LLMVariableExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts value via injected model generateText (no provider construction)', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        value: 'UUID-abc-123',
        reasoning: 'found in heading',
      },
    } as any)

    // Stub LanguageModel injected directly — the runner never constructs a provider.
    const stubModel = {} as any
    const extractor = new LLMVariableExtractor(stubModel)
    const input: ExtractorInput = {
      method: 'ai',
      variableName: 'uuid',
      description: 'Extract the UUID from the page',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(true)
    expect(result.value).toBe('UUID-abc-123')
    expect(result.reasoning).toBe('found in heading')
    // The injected stub model was passed straight to generateText.
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: stubModel, maxRetries: 0 }),
    )
  })

  it('LLM error → returns success=false with error message', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockRejectedValueOnce(new Error('Overloaded'))

    const extractor = new LLMVariableExtractor({} as any)
    const input: ExtractorInput = {
      method: 'ai',
      variableName: 'val',
      description: 'Extract something',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain('Overloaded')
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })
})

describe('createExtractor', () => {
  it('routes regex to ExplicitExtractor', () => {
    const extractor = createExtractor()
    expect(extractor).toBeInstanceOf(ExplicitExtractor)
  })

  it('routes ai to LLMVariableExtractor', () => {
    const extractor = createExtractor({} as any, 'ai')
    expect(extractor).toBeInstanceOf(LLMVariableExtractor)
  })

  it('throws if ai requested without model', () => {
    expect(() => createExtractor(undefined, 'ai')).toThrow()
  })
})
