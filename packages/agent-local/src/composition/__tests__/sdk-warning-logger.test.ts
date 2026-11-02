import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { installSdkWarningLogger, isSdkWarningLogger } from '../sdk-warning-logger.js'

function installed() {
  const logger = globalThis.AI_SDK_LOG_WARNINGS
  if (typeof logger !== 'function') throw new Error('expected an AI SDK warning logger')
  return logger
}

let emitted: unknown[][] = []

beforeEach(() => {
  emitted = []
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', undefined)
  vi.stubEnv('AGENT_QA_DEBUG_LLM', '')
  vi.spyOn(process, 'emitWarning').mockImplementation((...args: unknown[]) => {
    emitted.push(args)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('prints any other AI SDK warning as a process warning, and a deprecation once', () => {
  installSdkWarningLogger()
  const deprecated = { type: 'deprecated', setting: 'streamObject', message: 'Use it.' } as const

  installed()({
    warnings: [{ type: 'unsupported', feature: 'seed' }],
    provider: 'anthropic.messages',
    model: 'claude-sonnet-4-6',
  })
  installed()({ warnings: [deprecated] })
  installed()({ warnings: [deprecated] })

  expect(emitted).toEqual([
    [
      'AI SDK Warning (anthropic.messages / claude-sonnet-4-6): '
        + '{"type":"unsupported","feature":"seed"}',
      { type: 'Warning' },
    ],
    [`AI SDK Warning: ${JSON.stringify(deprecated)}`, { type: 'DeprecationWarning' }],
  ])
})

it('keeps a provider adaptation off the terminal', () => {
  installSdkWarningLogger()

  installed()({
    warnings: [{ type: 'unsupported', feature: 'toolChoice' }],
    provider: 'anthropic.messages',
    model: 'claude-sonnet-5-5',
  })

  expect(emitted).toEqual([])
})

it('knows the logger it installed', () => {
  installSdkWarningLogger()

  expect(isSdkWarningLogger(globalThis.AI_SDK_LOG_WARNINGS)).toBe(true)
})

it.each([
  ['logging turned off', false],
  ['a logger of its own', () => {}],
] as const)('keeps an AI_SDK_LOG_WARNINGS setting that is %s', (_label, setting) => {
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', setting)

  installSdkWarningLogger()

  expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(setting)
  expect(isSdkWarningLogger(setting)).toBe(false)
})
