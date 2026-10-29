import { expect, test } from 'vitest'
import * as api from '../index'

test('lists the six config write ops', () => {
  expect(api.CONFIG_WRITE_OPS).toEqual(['set', 'unset', 'append', 'set-if-absent', 'move', 'expect'])
})

test('lists the config write refusals in order', () => {
  expect(api.CONFIG_WRITE_REFUSALS).toEqual([
    'invalid_write_input',
    'file_invalid',
    'path_not_found',
    'validation_failed',
    'write_failed',
    'field_changed',
    'path_not_writable',
    'marker_written_back',
  ])
})

// the two token lists left with their keys; the model list remains.
test('lists registry.llms as the only named array', () => {
  expect(api.CONFIG_NAMED_ARRAYS).toEqual(['registry.llms'])
})

test('the config write request accepts well-formed changes and refuses malformed ones', () => {
  const schema = api.ConfigWriteRequestSchema
  const accepted = [
    { changes: [{ op: 'set', path: ['registry', 'llms', { name: 'gpt-5.6' }, 'model'], value: 'x' }] },
    { changes: [{ op: 'unset', path: ['use', 'cache'] }] },
    { changes: [{ op: 'append', path: ['registry', 'llms'], value: { name: 'local', provider: 'gemini' } }] },
    { changes: [{ op: 'set', path: ['registry', 'llms', 0, 'model'], value: 'y' }], undoable: true },
    { changes: [{ op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m' }] },
    {
      changes: [
        {
          op: 'move',
          from: ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Org'],
          path: ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Team'],
        },
      ],
    },
    { changes: [{ op: 'expect', path: ['workspace', 'testMatch'], value: ['a', 'b'] }] },
    { changes: [{ op: 'expect', path: ['use', 'llm'], value: null }] },
  ]
  for (const body of accepted) {
    expect(schema.parse(body)).toEqual(body)
  }

  const refused = [
    { changes: [{ op: 'set', path: 'use.timeout.step', value: '45s' }] },
    { changes: [{ op: 'merge', path: ['use'], value: {} }] },
    { changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s', extra: true }] },
    { changes: [{ op: 'unset', path: ['use', 'cache'], value: 1 }] },
    { changes: [] },
    { changes: [{ op: 'set', path: ['registry', 'llms', { name: '' }, 'model'], value: 'x' }] },
    { changes: [{ op: 'set', path: [], value: 'x' }] },
    { changes: [{ op: 'set', path: ['use', -1], value: 'x' }] },
    { changes: [{ op: 'set', path: ['registry', 'llms', { name: 'a', index: 0 }], value: 'x' }] },
    { changes: [{ op: 'set', path: ['use'], value: 1 }], extra: true },
    { changes: [{ op: 'move', path: ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Team'] }] },
    {
      changes: [
        {
          op: 'move',
          from: ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Org'],
          path: ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Team'],
          value: 'x',
        },
      ],
    },
    { changes: [{ op: 'expect', path: ['workspace', 'testMatch'], value: ['a'], extra: true }] },
    { changes: [{ op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m', extra: true }] },
    { changes: [{ op: 'move', from: ['a'], path: ['b'], extra: true }] },
  ]
  for (const body of refused) {
    expect(schema.safeParse(body).success).toBe(false)
  }
})

// `safety` left the schema, so it left the denied roots too.
test('lists plugins as the only denied write root', () => {
  expect(api.CONFIG_WRITE_DENIED_ROOTS).toEqual(['plugins'])
})

// The page write door admits exactly the page-owned leaves and refuses every retired key's path as
// an unknown path.
test('the write policy admits the page-owned leaves and refuses the retired paths', () => {
  const writable = api.CONFIG_SCHEMA_LEAVES.filter(pattern => api.isPageWritableConfigPath(concreteLeafPath(pattern, true)))
  expect(writable).toEqual(expect.arrayContaining(['use.planner.maxActions', 'use.planner.maxPlanningTurns']))
  expect(api.CONFIG_SCHEMA_LEAVES.filter(pattern => !writable.includes(pattern))).toEqual([
    'plugins.auth[].package',
    'plugins.auth[].path',
    'plugins.providers[].package',
    'plugins.providers[].path',
  ])
  const retired: api.ConfigPathSegment[][] = [
    ['safety'],
    ['safety', 'trustMode'],
    ['services', 'mcp', 'tokens'],
    ['services', 'mcp', 'tokens', { name: 'ci' }],
    ['services', 'mcp', 'tokens', 0, 'tokenEnvVar'],
    ['services', 'mcp', 'stdio'],
    ['services', 'mcp', 'stdio', 'grantConfigWrite'],
    ['services', 'dashboard', 'runServiceTokens'],
    ['services', 'dashboard', 'runServiceTokens', { name: 'ci' }, 'trustScope', 'project'],
  ]
  for (const path of retired) {
    expect({ path, writable: api.isPageWritableConfigPath(path) }).toEqual({ path, writable: false })
    expect(api.isConfigSchemaPath(path.map(s => (typeof s === 'object' ? 0 : s)))).toBe(false)
  }
  // The retained neighbours of each retired key are still writable.
  for (const path of [['services', 'mcp', 'port'], ['services', 'dashboard', 'host'], ['registry', 'llms', { name: 'k' }, 'model']]) {
    expect({ path, writable: api.isPageWritableConfigPath(path) }).toEqual({ path, writable: true })
  }
})

function concreteLeafPath(pattern: string, named: boolean): api.ConfigPathSegment[] {
  const path: api.ConfigPathSegment[] = []
  const keys: string[] = []
  for (const token of pattern.split('.')) {
    let key = token
    let items = 0
    while (key.endsWith('[]')) {
      key = key.slice(0, -2)
      items++
    }
    keys.push(key)
    path.push(key === '*' ? 'k' : key)
    const owner = keys.join('.')
    for (let item = 0; item < items; item++) {
      const selectsByName =
        named && item === 0 && (api.CONFIG_NAMED_ARRAYS as readonly string[]).includes(owner)
      path.push(selectsByName ? { name: 'k' } : 0)
    }
  }
  return path
}

test('PAGE-WRITABLE-EVERY-RENDERED-LEAF', () => {
  const denied = api.CONFIG_WRITE_DENIED_ROOTS as readonly string[]
  for (const pattern of api.CONFIG_SCHEMA_LEAVES) {
    const expected = !denied.includes(pattern.split('.')[0]!)
    for (const named of [false, true]) {
      const path = concreteLeafPath(pattern, named)
      expect({ pattern, path, writable: api.isPageWritableConfigPath(path) }).toEqual({
        pattern,
        path,
        writable: expected,
      })
    }
  }

  const writable: api.ConfigPathSegment[][] = [
    ['registry', 'llms'],
    ['registry', 'llms', { name: 'k' }],
    ['registry', 'targets', 'k'],
    ['workspace', 'testMatch'],
    ['use', 'timeout'],
  ]
  const refused: api.ConfigPathSegment[][] = [
    [],
    ['use', 'bogus'],
    ['plugins'],
    ['plugins', 'auth', 0, 'path'],
    // a retired root is refused as an unknown path, not as a denied root.
    ['safety', 'trustMode'],
    ['registry', 'llms', { name: 'k' }, 'nope'],
    ['registry', 'llms', '[]', 'model'],
    [0, 'use'],
  ]
  for (const path of writable) {
    expect({ path, writable: api.isPageWritableConfigPath(path) }).toEqual({ path, writable: true })
    expect(api.isConfigSchemaPath(path.map(s => (typeof s === 'object' ? 0 : s)))).toBe(true)
  }
  for (const path of refused) {
    expect({ path, writable: api.isPageWritableConfigPath(path) }).toEqual({ path, writable: false })
  }
  expect(api.isConfigSchemaPath(['plugins', 'auth', 0, 'path'])).toBe(true)
  expect(api.isConfigSchemaPath(['use', 'bogus'])).toBe(false)
})

// the masking classes, the classifier and their cells are deleted with the map;
// the leaf list, its schema-path test and its owner rule remain.
test('LEAF-OWNER', () => {
  expect(api.configLeafOwner('registry.targets.*.url')).toBe('registry.targets')
  expect(api.configLeafOwner('workspace.testMatch[]')).toBe('workspace.testMatch')
  expect(api.configLeafOwner('use.timeout.step')).toBe('use.timeout.step')
})

test('lists the provider error classes in order', () => {
  expect(api.PROVIDER_ERROR_CLASSES).toEqual([
    'auth_error',
    'model_not_found',
    'rate_limit',
    'network_error',
    'invalid_request',
    'provider_error',
  ])
})

test('CLASSIFIER-ORDER-PINNED', () => {
  const cases: readonly [string, number | undefined, api.ProviderErrorClass][] = [
    ['401 unauthorized', undefined, 'auth_error'],
    ['Invalid API key', undefined, 'auth_error'],
    ['model gpt-x does not exist', undefined, 'model_not_found'],
    ['x', 404, 'model_not_found'],
    ['quota exceeded', undefined, 'rate_limit'],
    ['request timeout: rate limit', undefined, 'rate_limit'],
    ['fetch failed', undefined, 'network_error'],
    ['ECONNREFUSED 127.0.0.1', undefined, 'network_error'],
    ['invalid_request: bad field', undefined, 'invalid_request'],
    ['teapot', undefined, 'provider_error'],
  ]
  for (const [message, statusCode, expected] of cases) {
    expect({ message, statusCode, class: api.classifyProviderError(message, statusCode) }).toEqual({
      message,
      statusCode,
      class: expected,
    })
  }
  expect([...new Set(cases.map(([, , expected]) => expected))]).toEqual([
    ...api.PROVIDER_ERROR_CLASSES,
  ])
})

test('CLASSIFIER-EMPTY-MESSAGE', () => {
  expect(api.classifyProviderError('')).toBe('provider_error')
  expect(api.providerErrorSentence('provider_error', '')).toBe('Connection failed. ')
  for (const thrown of [null, undefined, 42, {}]) {
    const { message } = api.extractProviderError(thrown)
    expect(api.classifyProviderError(message)).toBe('provider_error')
  }
})

test('SENTENCES-BYTE-IDENTICAL', () => {
  const sentences = Object.fromEntries(
    api.PROVIDER_ERROR_CLASSES.map(errorClass => [
      errorClass,
      api.providerErrorSentence(errorClass, 'upstream said no'),
    ]),
  )
  expect(sentences).toEqual({
    auth_error: 'Authentication failed. Check the saved credential for this config.',
    model_not_found: 'Model not found. Check the model name.',
    rate_limit: 'Rate limited. Try again later.',
    network_error: 'Network error. Check the exact base URL and try again.',
    invalid_request: 'Invalid request. Check model and provider settings.',
    provider_error: 'Connection failed. upstream said no',
  })
})

test('EXTRACT-PROVIDER-ERROR', () => {
  const withProps = (props: Record<string, unknown>) =>
    Object.assign(new Error('original message'), props)

  expect(api.extractProviderError(withProps({ data: { error: { message: 'bad key' } } }))).toEqual({
    message: 'bad key',
  })
  expect(api.extractProviderError(withProps({ data: { detail: 'nope' } }))).toEqual({
    message: 'nope',
  })
  expect(api.extractProviderError(withProps({ responseBody: '{"detail":"d"}' }))).toEqual({
    message: 'd',
  })
  expect(api.extractProviderError(withProps({ responseBody: 'not json' }))).toEqual({
    message: 'original message',
  })
  expect(api.extractProviderError(withProps({ statusCode: 429 }))).toEqual({
    message: 'original message',
    statusCode: 429,
  })
  expect(api.extractProviderError('x')).toEqual({ message: 'x' })
})

test('lists the LLM setup refusals in order', () => {
  expect(api.LLM_SETUP_REFUSALS).toEqual([
    'invalid_setup_input',
    'name_invalid',
    'name_taken',
    'credential_provider_conflict',
    'credential_not_accepted',
    'credential_missing',
    'credential_exists',
    'validation_failed',
  ])
})

test('lists the config action refusals', () => {
  expect(api.CONFIG_ACTION_REFUSALS).toEqual([
    'undo_expired',
    'undo_conflict',
  ])
})

test('CONNECT-REQUEST-STRICT', () => {
  const schema = api.LlmConnectRequestSchema
  const withKey = {
    name: 'gpt-5.6',
    provider: 'openai-compatible',
    model: 'gpt-5.6',
    baseURL: 'https://api.example.test/v1',
    providerHeaders: { 'x-trace': 'on' },
    credential: { type: 'api-key', secret: 'sk-test' },
    skipTest: false,
  }
  const withoutCredential = { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.6' }
  expect(schema.parse(withKey)).toEqual(withKey)
  expect(schema.parse(withoutCredential)).toEqual(withoutCredential)

  const refused = [
    { ...withoutCredential, extra: true },
    { ...withoutCredential, credential: { type: 'oauth', secret: 'sk-test' } },
    { ...withoutCredential, credential: { type: 'api-key', secret: '' } },
    { ...withoutCredential, credential: { type: 'api-key', secret: 'sk-test', extra: true } },
    { ...withoutCredential, name: '' },
  ]
  for (const body of refused) {
    expect(schema.safeParse(body).success).toBe(false)
  }
})

// the reveal request schema and its cases are deleted; Undo and Move remain.
test('UNDO-MOVE-STRICT', () => {
  const cases = [
    {
      schema: api.ConfigUndoRequestSchema,
      valid: { token: 'undo-1' },
      emptyRequired: { token: '' },
    },
    {
      schema: api.LlmCredentialMoveRequestSchema,
      valid: { from: 'old', to: 'new', provider: 'anthropic-compatible' },
      emptyRequired: { from: 'old', to: '', provider: 'anthropic-compatible' },
    },
  ] as const
  for (const { schema, valid, emptyRequired } of cases) {
    expect(schema.parse(valid)).toEqual(valid)
    expect(schema.safeParse({ ...valid, extra: true }).success).toBe(false)
    expect(schema.safeParse(emptyRequired).success).toBe(false)
  }
})
