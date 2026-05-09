import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import {
  VariableStore,
  interpolateVariables,
  findBareVariables,
  findUnresolvedTemplates,
  ExplicitExtractor,
  LLMVariableExtractor,
  createExtractor,
  parseEnvFile,
} from '../variables.js'
import {
  SecretRedactor,
  SecretStore,
  findSecretTemplates,
  interpolateSecretTemplates,
} from '../secrets.js'
import type { ExtractorInput } from '../types.js'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn((config: any) => config),
  },
}))

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'heading "Order #ORD-456 confirmed"\ntext "Your order ID is ORD-456"\nbutton "Continue" [ref=btn-1]',
    elements: [
      { ref: 'h-1', role: 'heading', name: 'Order #ORD-456 confirmed', attributes: {} },
      { ref: 'txt-1', role: 'text', name: 'Your order ID is ORD-456', attributes: {} },
      { ref: 'btn-1', role: 'button', name: 'Continue', attributes: {} },
    ],
    url: 'https://example.com/order/confirmed',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
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

  it('capture overwriting env triggers console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new VariableStore()
    store.set('TOKEN', 'from-env', 'env')
    store.set('TOKEN', 'from-capture')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('capture step overwrites variable "TOKEN"')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('was set by env')
    )
    warnSpy.mockRestore()
  })

  it('test overwriting env does NOT warn (deliberate hierarchy)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new VariableStore()
    store.set('TOKEN', 'from-env', 'env')
    store.set('TOKEN', 'from-test', 'inline')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('capture overwriting cli triggers warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new VariableStore()
    store.set('KEY', 'cli-val', 'cli')
    store.set('KEY', 'captured')
    expect(warnSpy).toHaveBeenCalledTimes(1)
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

  it('does not resolve runtime secret templates', () => {
    const store = new VariableStore()
    store.set('loginPassword', 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7', 'env')

    expect(interpolateVariables('Password {{secret:loginPassword}}', store))
      .toBe('Password {{secret:loginPassword}}')
  })
})

describe('SecretStore', () => {
  const sentinel = 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7'

  it('loads dotenv-style content without exposing a bulk snapshot API', () => {
    const store = SecretStore.fromEnvContent(`loginPassword=${sentinel}\nAPI_TOKEN="token value"\n`)

    expect(store.has('loginPassword')).toBe(true)
    expect(store.get('loginPassword')).toBe(sentinel)
    expect(store.get('API_TOKEN')).toBe('token value')
    expect(store.count()).toBe(2)
    expect('getAll' in store).toBe(false)
    expect('snapshot' in store).toBe(false)
  })

  it('finds secret templates with conservative names', () => {
    expect(findSecretTemplates('Fill {{secret:loginPassword}} and {{secret:API_TOKEN}}')).toEqual([
      { pattern: '{{secret:loginPassword}}', name: 'loginPassword' },
      { pattern: '{{secret:API_TOKEN}}', name: 'API_TOKEN' },
    ])
    expect(findSecretTemplates('Ignore {{secret:bad-name}}')).toEqual([])
  })

  it('interpolates secret templates only through the explicit secret helper', () => {
    const store = SecretStore.fromEnvContent(`loginPassword=${sentinel}\n`)

    expect(interpolateSecretTemplates('Fill {{secret:loginPassword}}', store))
      .toBe(`Fill ${sentinel}`)
    expect(interpolateSecretTemplates('Fill {{secret:missing}}', store))
      .toBe('Fill {{secret:missing}}')
  })
})

describe('SecretRedactor', () => {
  const sentinel = 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7'

  it('redacts known secret placeholders with keyed markers and values with generic markers', () => {
    const store = SecretStore.fromEnvContent(`loginPassword=${sentinel}\n`)
    const redactor = new SecretRedactor(store)

    expect(redactor.redactString(`Use {{secret:loginPassword}} then ${sentinel}`))
      .toBe('Use [secret:loginPassword] then [secret]')
  })

  it('redacts recursive payloads without mutating non-secret values', () => {
    const store = SecretStore.fromEnvContent(`loginPassword=${sentinel}\n`)
    const redactor = new SecretRedactor(store)

    const payload = {
      action: { type: 'fill', value: sentinel },
      messages: [`before ${sentinel}`, '{{secret:loginPassword}}'],
      nested: [{ ok: true, value: 'public' }],
      error: new Error(`failed with ${sentinel}`),
    }

    const redacted = redactor.redactValue(payload) as typeof payload
    expect(JSON.stringify(redacted)).not.toContain(sentinel)
    expect(JSON.stringify(redacted)).toContain('[secret]')
    expect(JSON.stringify(redacted)).toContain('[secret:loginPassword]')
    expect(redacted.nested[0].value).toBe('public')
  })
})

describe('VariableStore single namespace (capture collapsed into env)', () => {
  it('captured variables are accessible via store.get regardless of source', () => {
    const store = new VariableStore()
    store.set('orderId', 'ORD-123', 'capture')
    expect(store.get('orderId')).toBe('ORD-123')
    expect(store.getSource('orderId')).toBe('capture')
  })

  it('all source types accessible via store.get', () => {
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

  it('{{hook:TOKEN}} syntax does NOT resolve (namespace removed per D-07)', () => {
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

  it('extracts value via AI generateText', async () => {
    const { generateText } = await import('ai')
    const mockGenerateText = vi.mocked(generateText)
    mockGenerateText.mockResolvedValueOnce({
      output: {
        value: 'UUID-abc-123',
        reasoning: 'found in heading',
      },
    } as any)

    const extractor = new LLMVariableExtractor({} as any)
    const input: ExtractorInput = {
      method: 'ai',
      variableName: 'uuid',
      description: 'Extract the UUID from the page',
    }

    const result = await extractor.extract(input, makeScreenState())

    expect(result.success).toBe(true)
    expect(result.value).toBe('UUID-abc-123')
    expect(result.reasoning).toBe('found in heading')
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
