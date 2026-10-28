import { spawnSync } from 'node:child_process'
import { reserveStdoutForData } from '@vostride/agent-qa-core'
import type { LogWarningsFunction } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installEvalWarningLogger } from '../eval-warning-logger.js'

const original = globalThis.AI_SDK_LOG_WARNINGS
afterEach(() => {
  globalThis.AI_SDK_LOG_WARNINGS = original
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('keeps the real installed SDK first warning off stdout and retains returned warnings', () => {
  // A fresh process guarantees the installed SDK's one-time warning state is uninitialized.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { generateText } from 'ai';
    import { installEvalWarningLogger } from ${JSON.stringify(new URL('../eval-warning-logger.ts', import.meta.url).href)};
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    const restore = installEvalWarningLogger();
    const warning = { type: 'unsupported', feature: 'seed' };
    const result = await generateText({ prompt: 'ok', seed: 11, model: {
      specificationVersion: 'v3', provider: 'warning-fixture', modelId: 'warning-fixture', supportedUrls: {},
      doStream() { throw new Error('stream forbidden'); },
      async doGenerate() { return { content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [warning] }; }
    }});
    console.log(JSON.stringify({ text: result.text, warnings: result.warnings }));
    restore();
  `], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({ text: 'ok', warnings: [{ type: 'unsupported', feature: 'seed' }] })
  expect(child.stderr).toContain('AI SDK Warning (warning-fixture / warning-fixture)')
  expect(child.stderr).toContain('"feature":"seed"')
  expect(child.stdout).not.toContain('AI SDK Warning System')
})

it('preserves deliberate logging configuration and restores the default after eval', () => {
  const custom = vi.fn()
  for (const configured of [false, custom] as const) {
    globalThis.AI_SDK_LOG_WARNINGS = configured
    installEvalWarningLogger()()
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(configured)
  }
  globalThis.AI_SDK_LOG_WARNINGS = undefined
  const restore = installEvalWarningLogger()
  expect(globalThis.AI_SDK_LOG_WARNINGS).toBeTypeOf('function')
  restore()
  expect(globalThis.AI_SDK_LOG_WARNINGS).toBeUndefined()
})

describe('an AI SDK warning prints as text under GitHub Actions', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
  const warnings = [{ type: 'other', message: '::add-mask::x' }] as const

  function installedLogger(): LogWarningsFunction {
    const logger = globalThis.AI_SDK_LOG_WARNINGS
    expect(logger).toBeTypeOf('function')
    return logger as LogWarningsFunction
  }

  function logWarning(): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = []
    const stderr: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    globalThis.AI_SDK_LOG_WARNINGS = undefined
    const restore = installEvalWarningLogger()
    const logger = installedLogger()
    try {
      logger({ warnings: [...warnings], provider: 'fixture', model: 'fixture-model' })
    } finally {
      restore()
    }
    return { stdout, stderr }
  }

  it('writes the warning once to stdout inside a pair', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const { stdout, stderr } = logWarning()
    expect(stdout).toHaveLength(1)
    expect(stdout[0]).toMatch(PAIR)
    expect(stdout[0]).toContain('AI SDK Warning (')
    expect(stdout[0]).toContain('::add-mask::x')
    expect(stderr).toEqual([])
  })

  it('keeps the wrapped warning on stderr while stdout is reserved for data', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const release = reserveStdoutForData()
    try {
      const { stdout, stderr } = logWarning()
      expect(stdout).toEqual([])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toMatch(PAIR)
      expect(stderr[0]).toContain('AI SDK Warning (fixture / fixture-model)')
    } finally {
      release()
    }
  })

  it('writes the plain line to stderr off GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const { stdout, stderr } = logWarning()
    expect(stdout).toEqual([])
    expect(stderr).toEqual([
      `AI SDK Warning (fixture / fixture-model): ${JSON.stringify(warnings[0])}\n`,
    ])
  })
})
