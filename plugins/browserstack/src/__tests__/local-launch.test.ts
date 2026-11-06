import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserStackLocalFactory } from '../local.js'

const wrapper = vi.hoisted(() => ({
  found: undefined as string | undefined,
  launches: [] as { binary: string | undefined; retriesLeft: number }[],
}))

// Stands in for browserstack-local's Local: it finds wrapper.found and fails every launch, as a
// binary that runs but cannot connect does.
vi.mock('browserstack-local', () => ({
  Local: class {
    retriesLeft = 9
    binaryPath: string | undefined

    getBinaryPath(callback: (path: string | undefined) => void) {
      callback(wrapper.found)
    }

    start(options: { binarypath?: string }, callback: (error?: Error) => void) {
      if (options.binarypath !== undefined) this.binaryPath = options.binarypath
      wrapper.launches.push({ binary: this.binaryPath, retriesLeft: this.retriesLeft })
      callback(new Error('Command failed: BrowserStackLocal --daemon start'))
    }

    stop(callback: () => void) {
      callback()
    }
  },
}))

let logDir: string

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'agent-qa-browserstack-launch-test-'))
  vi.stubEnv('TMPDIR', logDir)
  wrapper.found = undefined
  wrapper.launches = []
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(logDir, { recursive: true, force: true })
})

describe('the BrowserStack Local launch', () => {
  it('turns the wrapper retry off for the binary it finds, so a failed launch never runs a download the plugin has not checked', async () => {
    wrapper.found = process.execPath

    const starting = browserStackLocalFactory.start({
      accessKey: 'bs-test-access-key',
      identifier: 'agent-qa-launch',
      binary: undefined,
    })

    await expect(starting.running).rejects.toThrow('Command failed')
    expect(wrapper.launches).toEqual([{ binary: process.execPath, retriesLeft: 0 }])
  })
})
