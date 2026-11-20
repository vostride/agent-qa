import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DAEMON_LOGGER, type DaemonHostLogger } from '../host.js'

function tagged(tag: string, message: string): RegExp {
  const escaped = message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^\\d\\d:\\d\\d:\\d\\d  ${tag.padEnd(9)}  ${escaped}$`, 'u')
}

function consoleSpies() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the default daemon logger', () => {
  it('prints an info line on stdout as the time, the daemon tag and the message', () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const spies = consoleSpies()

    DEFAULT_DAEMON_LOGGER.info('agent-qa daemon started (pid 1, epoch 2)')

    expect(spies.log.mock.calls).toEqual([
      [expect.stringMatching(tagged('daemon', 'agent-qa daemon started (pid 1, epoch 2)'))],
    ])
    expect(spies.error).not.toHaveBeenCalled()
    expect(spies.warn).not.toHaveBeenCalled()
  })

  it('prints the tag it is given in place of daemon', () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const spies = consoleSpies()

    DEFAULT_DAEMON_LOGGER.info('Embedder worker ready', 'embedder')

    expect(spies.log.mock.calls).toEqual([
      [expect.stringMatching(tagged('embedder', 'Embedder worker ready'))],
    ])
  })

  it('prints an error line on stderr with its tag and the message', () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const spies = consoleSpies()

    DEFAULT_DAEMON_LOGGER.error('Daemon curation drain failed: boom', 'knowledge')

    expect(spies.error.mock.calls).toEqual([
      [expect.stringMatching(tagged('knowledge', 'Daemon curation drain failed: boom'))],
    ])
    expect(spies.log).not.toHaveBeenCalled()
  })

  it('colours an error line red when colour is on', () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    vi.stubEnv('NO_COLOR', '')
    vi.stubEnv('FORCE_COLOR', '1')
    const spies = consoleSpies()

    DEFAULT_DAEMON_LOGGER.error('Daemon agent-job dispatch failed: boom', 'jobs')

    expect(String(spies.error.mock.calls[0]?.[0])).toContain(
      '\u001b[31mDaemon agent-job dispatch failed: boom\u001b[39m',
    )
  })

  it('under GitHub Actions writes one stop-commands pair and calls no console method', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const spies = consoleSpies()
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })

    DEFAULT_DAEMON_LOGGER.error('Daemon curation drain failed: boom', 'knowledge')

    expect(written).toHaveLength(1)
    const block = written[0] ?? ''
    const token = /^::stop-commands::([0-9a-f]+)\n/u.exec(block)?.[1]
    expect(token, block).toBeDefined()
    expect(block.split('\n')[1]).toMatch(tagged('knowledge', 'Daemon curation drain failed: boom'))
    expect(block.endsWith(`::${token ?? ''}::\n`)).toBe(true)
    expect(block.match(/::stop-commands::/gu)).toHaveLength(1)
    expect(spies.log).not.toHaveBeenCalled()
    expect(spies.warn).not.toHaveBeenCalled()
    expect(spies.error).not.toHaveBeenCalled()
  })
})

describe('a logger a caller hands the daemon', () => {
  it('fits with methods that take one argument and receives each message unchanged first', () => {
    const infos: string[] = []
    const errors: string[] = []
    const logger: DaemonHostLogger = {
      info: (message: string) => infos.push(message),
      error: (message: string) => errors.push(message),
    }

    logger.info('Embedder worker ready', 'embedder')
    logger.error('Dispatched run r_1 failed: boom', 'run')

    expect(infos).toEqual(['Embedder worker ready'])
    expect(errors).toEqual(['Dispatched run r_1 failed: boom'])
  })
})
