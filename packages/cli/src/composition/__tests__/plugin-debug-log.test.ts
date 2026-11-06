import { afterEach, describe, expect, it, vi } from 'vitest'

import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'

import { doorLogLevel, pluginDebugLog } from '../plugin-host.js'

const LINE = 'plugin lab: ready with [secret:LAB_KEY]'

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function captureStreams(): { stderr: string[]; stdout: string[] } {
  const stderr: string[] = []
  const stdout: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(plain(String(chunk)))
    return true
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(plain(String(chunk)))
    return true
  })
  return { stderr, stdout }
}

function expectGuarded(written: string): void {
  const token = /^::stop-commands::([0-9a-f]+)\n/.exec(written)?.[1]
  expect(token, written).toBeDefined()
  expect(written).toContain(`DEBUG [adapter] ${LINE}\n::${token}::\n`)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the plugin debug log', () => {
  it('is not given below debug level', () => {
    for (const level of ['error', 'warn', 'info', 'silent']) {
      expect(pluginDebugLog(level), level).toBeUndefined()
    }
  })

  it("prints each line on stderr as a DEBUG adapter line in the run logger's form, and nothing on stdout", () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const debugLog = pluginDebugLog('debug')
    expect(debugLog).toBeTypeOf('function')
    const streams = captureStreams()

    debugLog?.(LINE)

    expect(streams.stderr).toHaveLength(1)
    expect(streams.stderr[0]).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} DEBUG \[adapter\] plugin lab: ready with \[secret:LAB_KEY\]\n$/,
    )
    expect(streams.stdout).toEqual([])
  })

  it("under GitHub Actions, prints the guarded line on stdout, the stream the run's own blocks use", () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const debugLog = pluginDebugLog('debug')
    const streams = captureStreams()

    debugLog?.(LINE)

    expectGuarded(streams.stdout.join(''))
    expect(streams.stderr).toEqual([])
  })

  it('under GitHub Actions, prints the guarded line on stderr while a --json action holds stdout', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const debugLog = pluginDebugLog('debug')
    const streams = captureStreams()
    const release = reserveStdoutForData()

    try {
      debugLog?.(LINE)
    } finally {
      release()
    }

    expectGuarded(streams.stderr.join(''))
    expect(streams.stdout).toEqual([])
  })

  it("folds the door's log level as run does: --log-level, then --verbose or --quiet, then the config, then warn", () => {
    const debugConfig = { services: { logging: { level: 'debug' } } }
    expect(doorLogLevel({ logLevel: 'debug' }, null)).toBe('debug')
    expect(doorLogLevel({ verbose: true }, null)).toBe('debug')
    expect(doorLogLevel({ logLevel: 'warn', verbose: true }, null)).toBe('warn')
    expect(doorLogLevel({ quiet: true }, null)).toBe('silent')
    expect(doorLogLevel({}, debugConfig)).toBe('debug')
    expect(doorLogLevel({ quiet: true }, debugConfig)).toBe('silent')
    expect(doorLogLevel({}, null)).toBe('warn')
    expect(doorLogLevel({}, { services: { logging: { level: 3 } } })).toBe('warn')
  })
})
