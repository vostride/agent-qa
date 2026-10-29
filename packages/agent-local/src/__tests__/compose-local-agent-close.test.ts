import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  ConfigReaderPort,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  composeLocalAgent,
  LocalAgentClosedError,
} from '../composition/compose-local-agent.js'
import { AGENT_JOB_STORE_DB_FILE } from '../store/sqlite-job-store.js'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:compose-close',
  generate: async () => {
    throw new Error('compose close tests never author')
  },
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/compose-close.config.yaml',
    entries: [],
  }),
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function rejectedWithClosedError(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  )
  expect(outcome.status).toBe('rejected')
  if (outcome.status !== 'rejected') return outcome.value
  expect(outcome.error).toBeInstanceOf(LocalAgentClosedError)
  return outcome.error
}

const temporaryRoots: string[] = []

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-compose-close-${label}-`))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('composeLocalAgent job-store lifecycle', () => {
  it('waits for a superseded open, closes its late store, and never publishes it', async () => {
    const root = makeRoot('race')
    const model = deferred<JobModelCapability>()
    let modelCalls = 0
    const closeStore = vi.spyOn(DatabaseSync.prototype, 'close')
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot: root,
      config: TEST_CONFIG,
      knowledgeRoot: () => join(root, 'knowledge'),
      model: () => {
        modelCalls += 1
        return model.promise
      },
    })

    const opening = host.jobs()
    let closeSettled = false
    const closing = Promise.resolve(host.close()).then(() => {
      closeSettled = true
    })
    await Promise.resolve()
    const settledBeforeModel = closeSettled
    model.resolve(TEST_MODEL)

    const [openOutcome, closeOutcome] = await Promise.allSettled([opening, closing])
    expect(settledBeforeModel).toBe(false)
    expect(closeOutcome.status).toBe('fulfilled')
    expect(openOutcome.status).toBe('rejected')
    if (openOutcome.status === 'rejected') {
      expect(openOutcome.reason).toBeInstanceOf(LocalAgentClosedError)
    }
    expect(existsSync(join(root, AGENT_JOB_STORE_DB_FILE))).toBe(true)
    expect(closeStore).toHaveBeenCalledTimes(1)

    await rejectedWithClosedError(host.jobs())
    expect(modelCalls).toBe(1)
  })

  it('closes a normally opened store once and refuses every later jobs call', async () => {
    const root = makeRoot('opened')
    let modelCalls = 0
    const closeStore = vi.spyOn(DatabaseSync.prototype, 'close')
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot: root,
      config: TEST_CONFIG,
      knowledgeRoot: () => join(root, 'knowledge'),
      model: () => {
        modelCalls += 1
        return TEST_MODEL
      },
    })

    const jobs = await host.jobs()
    await expect(jobs.store.dumpState()).resolves.toMatchObject({ jobs: [] })
    await host.close()

    expect(closeStore).toHaveBeenCalledTimes(1)
    await expect(jobs.store.dumpState()).rejects.toThrow()
    await rejectedWithClosedError(host.jobs())
    await rejectedWithClosedError(host.jobs())
    expect(modelCalls).toBe(1)
    expect(closeStore).toHaveBeenCalledTimes(1)
  })
})
