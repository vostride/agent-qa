import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
import type {
  RemoteLease,
  RemoteLeaseSource,
  RemotePluginBrowserConfig,
} from '@vostride/agent-qa-runner'

const { adapters } = vi.hoisted(() => ({
  adapters: { connectFails: false },
}))

// Leases as the real adapter does: acquire at setup, release at cleanup or on a failed connect.
vi.mock('@vostride/agent-qa-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-web')>()),
  WebPlatformAdapter: vi.fn().mockImplementation(function (options: {
    pluginSessions?: RemoteLeaseSource
  }) {
    let lease: RemoteLease | undefined
    return {
      platform: 'web',
      setup: vi.fn(async (config: { browser?: { remote?: RemotePluginBrowserConfig } }) => {
        const remote = config.browser?.remote
        if (remote === undefined) return
        if (options.pluginSessions === undefined) {
          throw new Error(`Remote ${remote.name}: this host started no plugin host for it.`)
        }
        lease = await options.pluginSessions.acquire({
          remote: remote.name,
          plugin: remote.plugin,
          deadlineMs: remote.connectTimeoutMs,
          session: { platform: 'web', engine: 'chromium', context: 'new' },
        })
        if (adapters.connectFails) {
          await lease.release()
          lease = undefined
          throw new Error(`Remote ${remote.name} did not answer.`)
        }
      }),
      cleanup: vi.fn(async () => {
        await lease?.release()
        lease = undefined
      }),
      execute: vi.fn().mockResolvedValue({ success: true }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('frame')),
      observe: vi
        .fn()
        .mockResolvedValue({ tree: 'main', elements: [], timestamp: 0, metadata: {} }),
      drainConsoleLogs: vi.fn(() => []),
      drainNetworkLogs: vi.fn(() => []),
    }
  }),
}))

vi.mock('@vostride/agent-qa-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner')>()),
  LLMPlanner: vi.fn().mockImplementation(function () {
    return { plan: vi.fn() }
  }),
  LLMVerifier: vi.fn().mockImplementation(function () {
    return { verify: vi.fn() }
  }),
}))

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn().mockReturnValue({ modelId: 'test-model' }),
}))

import { SessionManager } from '../session-manager.js'
import type { SessionManagerDeps } from '../session-manager.js'

const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const EXIT_BUDGET_MS = 20_000

const roots: string[] = []
let managers: SessionManager[] = []

afterEach(async () => {
  adapters.connectFails = false
  await Promise.all(managers.map((manager) => manager.cleanupAll()))
  managers = []
})

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface LedgerLine {
  readonly method: string
  readonly pid?: number
}

interface PluginProject {
  readonly configPath: string
  readonly ledgerFile: string
  readonly deps: SessionManagerDeps
}

function pluginProject(): PluginProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'live-plugin-')))
  roots.push(root)
  writeScriptedPlugin(join(root, 'tools', ENTRY_NAME))
  const configPath = join(root, 'agent-qa.config.yaml')
  const ledgerFile = join(root, 'plugin-ledger.jsonl')
  const config = {
    registry: { remotes: [{ name: REMOTE_NAME, plugin: ENTRY_NAME }] },
    plugins: [
      {
        name: ENTRY_NAME,
        path: `./tools/${ENTRY_NAME}`,
        options: {
          answer: { protocol: 'playwright', url: 'ws://127.0.0.1:9/playwright' },
          ledgerFile,
          recordProcess: true,
        },
      },
    ],
  }
  return {
    configPath,
    ledgerFile,
    deps: {
      configPath,
      configManager: {
        readWithRevision: vi
          .fn()
          .mockResolvedValue({ kind: 'ok', config, raw: '', revision: 'fixture' }),
        mask: (text: string) => text,
      } as never,
    },
  }
}

const place: RemotePluginBrowserConfig = {
  name: REMOTE_NAME,
  plugin: { entry: ENTRY_NAME },
  connectTimeoutMs: 30_000,
}

async function openSession(
  deps: SessionManagerDeps,
): Promise<{ manager: SessionManager; sessionId: string }> {
  const manager = new SessionManager(deps)
  managers.push(manager)
  const { sessionId } = await manager.createSession({
    platform: 'web',
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1/',
    },
    headless: true,
    remote: place,
  })
  return { manager, sessionId }
}

function ledgerOf(project: PluginProject): LedgerLine[] {
  if (!existsSync(project.ledgerFile)) return []
  return readFileSync(project.ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerLine)
}

function methodsOf(project: PluginProject): string[] {
  return ledgerOf(project).map((line) => line.method)
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function expectPluginGone(project: PluginProject): Promise<void> {
  await vi.waitFor(
    () => expect(methodsOf(project).at(-1)).toBe('shutdown'),
    { timeout: EXIT_BUDGET_MS, interval: 25 },
  )
  const pid = ledgerOf(project).find((line) => line.method === 'initialize')?.pid
  expect(typeof pid).toBe('number')
  await vi.waitFor(() => expect(running(pid!)).toBe(false), {
    timeout: EXIT_BUDGET_MS,
    interval: 25,
  })
}

describe('a live-editor session on a plugin remote', () => {
  it('leases once, and its end releases the lease and shuts the plugin down', async () => {
    const project = pluginProject()
    const { manager, sessionId } = await openSession(project.deps)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire'])

    expect(await manager.terminateSession(sessionId)).toBe(true)

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)

  it('ends after its inactivity bound with no command and shuts the plugin down', async () => {
    const project = pluginProject()
    const { manager, sessionId } = await openSession({
      ...project.deps,
      remoteInactivityMs: 300,
    })
    expect(manager.getSession(sessionId)?.runsOnRemote).toBe(true)

    await vi.waitFor(() => expect(manager.getSession(sessionId)).toBeUndefined(), {
      timeout: EXIT_BUDGET_MS,
      interval: 25,
    })

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)

  it('shuts the plugin down when the session cannot open on the leased session', async () => {
    const project = pluginProject()
    adapters.connectFails = true

    await expect(openSession(project.deps)).rejects.toThrow(`Remote ${REMOTE_NAME} did not answer.`)

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)

  it('shuts the plugin down when the dashboard ends every session', async () => {
    const project = pluginProject()
    const { manager } = await openSession(project.deps)

    await manager.cleanupAll()

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)
})
