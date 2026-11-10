import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
import { RunSecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type {
  RemoteLease,
  RemoteLeaseSource,
  RemotePluginBrowserConfig,
} from '@vostride/agent-qa-runner'

const { adapters } = vi.hoisted(() => ({
  adapters: { connectFails: false, connectedUrl: undefined as string | undefined },
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
        adapters.connectedUrl = lease.connection.url
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
      // The page logs the address it was served from, as a page can.
      drainConsoleLogs: vi.fn(() =>
        adapters.connectedUrl === undefined
          ? []
          : [{ level: 'log', text: `served from ${adapters.connectedUrl}`, timestamp: 0 }],
      ),
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

import { LiveSession, resolveLivePlace } from '../live-session.js'
import { SessionManager } from '../session-manager.js'
import type { SessionManagerDeps } from '../session-manager.js'
import type { LiveSessionConfig } from '../types.js'

const ANSWER = { protocol: 'playwright', url: 'ws://127.0.0.1:9/playwright' }
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const EXIT_BUDGET_MS = 20_000

const roots: string[] = []
let managers: SessionManager[] = []

afterEach(async () => {
  adapters.connectFails = false
  adapters.connectedUrl = undefined
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

function pluginProject(
  answer: Record<string, unknown> = ANSWER,
  options: Record<string, unknown> = {},
): PluginProject {
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
          answer,
          ledgerFile,
          recordProcess: true,
          ...options,
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

// The route always hands a session its redactor; null opens one without it.
async function openSession(
  deps: SessionManagerDeps,
  secretRedactor: RunSecretRedactor | null = new RunSecretRedactor(new SecretStore([])),
): Promise<{ manager: SessionManager; sessionId: string }> {
  const manager = new SessionManager(deps)
  managers.push(manager)
  const { sessionId } = await manager.createSession({
    ...(secretRedactor === null ? {} : { secretRedactor }),
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

type SessionMask = (text: string) => string

interface RecordingMaskBinder {
  readonly bindSessionMask: NonNullable<SessionManagerDeps['bindSessionMask']>
  // Each mask handed over, in the order the sessions opened.
  readonly masks: SessionMask[]
  // How often each binding's end was called, at its mask's index.
  readonly ends: number[]
}

function recordingMaskBinder(onEnd: () => void = () => {}): RecordingMaskBinder {
  const masks: SessionMask[] = []
  const ends: number[] = []
  return {
    masks,
    ends,
    bindSessionMask: (mask) => {
      const index = masks.push(mask) - 1
      ends.push(0)
      return () => {
        ends[index] = (ends[index] ?? 0) + 1
        onEnd()
      }
    },
  }
}

interface ThrowingMaskBinder {
  readonly bindSessionMask: NonNullable<SessionManagerDeps['bindSessionMask']>
  readonly calls: { binds: number; ends: number }
}

// A host that cannot take a session's mask, or cannot let it go, by mode.
function throwingMaskBinder(mode: 'bind' | 'end'): ThrowingMaskBinder {
  const calls = { binds: 0, ends: 0 }
  return {
    calls,
    bindSessionMask: () => {
      calls.binds += 1
      if (mode === 'bind') throw new Error('the host could not take the mask')
      return () => {
        calls.ends += 1
        throw new Error('the host could not let the mask go')
      }
    },
  }
}

// Shaped like the answer-mask cell's: the token rides in the connection URL and is listed in mask.
function tokenAnswer(token: string): { protocol: string; url: string; mask: string[] } {
  return {
    protocol: 'playwright',
    url: `ws://127.0.0.1:9/playwright?token=${encodeURIComponent(token)}`,
    mask: [token],
  }
}

function expectAnswerHidden(mask: SessionMask, token: string): void {
  const masked = mask(`the remote at ${tokenAnswer(token).url} stopped answering`)
  expect(masked).toBe(
    'the remote at ws://127.0.0.1:9/playwright?token=[secret:PLUGIN_LAB] stopped answering',
  )
  for (const value of [token, encodeURIComponent(token)]) {
    expect(masked.includes(value), 'the mask let a form of the token through').toBe(false)
  }
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

  it('refuses a session without a redactor before the plugin starts', async () => {
    const project = pluginProject()

    await expect(openSession(project.deps, null)).rejects.toThrow(
      'A plugin remote needs the session redactor, which masks what the plugin answers; this session has none.',
    )

    expect(methodsOf(project)).toEqual([])
  }, 60_000)

  it('shuts the plugin down when the dashboard ends every session', async () => {
    const project = pluginProject()
    const { manager } = await openSession(project.deps)

    await manager.cleanupAll()

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)
})

describe("a live-editor session and its plugin's answer mask", () => {
  it("masks an answer's mask value in the session's output, events and records from acquire on", async () => {
    const token = 'tok/live 9f3a'
    const project = pluginProject({
      protocol: 'playwright',
      url: `ws://127.0.0.1:9/playwright?token=${encodeURIComponent(token)}`,
      mask: [token],
    })
    const { manager, sessionId } = await openSession(
      project.deps,
      new RunSecretRedactor(new SecretStore([])),
    )
    const session = manager.getSession(sessionId)!
    const messages: unknown[] = []
    session.attachMessageSink((message) => messages.push(message))

    const consoleLines = await session.drainDeviceLogs()
    const hookLog = await session.executeHookCommand('teardown', `notify ${token}`)

    expect(consoleLines.map((line) => line.message)).toEqual([
      'served from ws://127.0.0.1:9/playwright?token=[secret:PLUGIN_LAB]',
    ])
    expect(hookLog.hookId).toBe('notify [secret:PLUGIN_LAB]')
    const shown = JSON.stringify([consoleLines, hookLog, messages, session.getState()])
    expect(messages.length).toBeGreaterThan(0)
    for (const value of [token, encodeURIComponent(token)]) {
      expect(shown.includes(value), 'the session showed a mask value').toBe(false)
    }
  }, 60_000)
})

describe("a live-editor session's mask and its host", () => {
  const TOKEN = 'tok/live 9f3a'

  it('hands its host one mask that hides what the plugin answered, once it is open', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const binder = recordingMaskBinder()

    await openSession({ ...project.deps, bindSessionMask: binder.bindSessionMask })

    expect(binder.masks).toHaveLength(1)
    expect(binder.ends).toEqual([0])
    expectAnswerHidden(binder.masks[0]!, TOKEN)
  }, 60_000)

  it('ends that binding once when it ends, and the mask it handed over still hides the answer', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const pluginAtEnd: string[][] = []
    const binder = recordingMaskBinder(() => pluginAtEnd.push(methodsOf(project)))
    const { manager, sessionId } = await openSession({
      ...project.deps,
      bindSessionMask: binder.bindSessionMask,
    })

    expect(await manager.terminateSession(sessionId)).toBe(true)

    expect(binder.ends).toEqual([1])
    // Bound through the whole cleanup: the plugin had released its session and shut down.
    expect(pluginAtEnd).toEqual([['initialize', 'acquire', 'release', 'shutdown']])
    expectAnswerHidden(binder.masks[0]!, TOKEN)
    await expectPluginGone(project)
  }, 60_000)

  it('opens and ends as before when its host takes no mask', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const { manager, sessionId } = await openSession(project.deps)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire'])

    expect(await manager.terminateSession(sessionId)).toBe(true)

    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)

  it('ends its binding once when its inactivity bound passes with no command', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const binder = recordingMaskBinder()
    const { manager, sessionId } = await openSession({
      ...project.deps,
      remoteInactivityMs: 300,
      bindSessionMask: binder.bindSessionMask,
    })
    const session = manager.getSession(sessionId)!

    await vi.waitFor(() => expect(session.status).toBe('terminated'), {
      timeout: EXIT_BUDGET_MS,
      interval: 25,
    })
    await session.cleanup()

    expect(manager.getSession(sessionId)).toBeUndefined()
    expect(binder.ends).toEqual([1])
    await expectPluginGone(project)
  }, 60_000)

  it('ends its binding once when it cannot open on the leased session', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const binder = recordingMaskBinder()
    adapters.connectFails = true

    await expect(
      openSession({ ...project.deps, bindSessionMask: binder.bindSessionMask }),
    ).rejects.toThrow(`Remote ${REMOTE_NAME} did not answer.`)

    expect(binder.masks).toHaveLength(1)
    expect(binder.ends).toEqual([1])
    await expectPluginGone(project)
  }, 60_000)

  it('ends its binding once when the dashboard ends every session', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const binder = recordingMaskBinder()
    const { manager } = await openSession({
      ...project.deps,
      bindSessionMask: binder.bindSessionMask,
    })

    await manager.cleanupAll()

    expect(binder.ends).toEqual([1])
    await expectPluginGone(project)
  }, 60_000)

  it('hands nothing to its host when it is refused for having no redactor', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const binder = recordingMaskBinder()

    await expect(
      openSession({ ...project.deps, bindSessionMask: binder.bindSessionMask }, null),
    ).rejects.toThrow('A plugin remote needs the session redactor')

    expect(binder.masks).toEqual([])
    expect(binder.ends).toEqual([])
    expect(methodsOf(project)).toEqual([])
  }, 60_000)

  // Two projects, so each session's plugin answers a token of its own; the binder is the host's,
  // shared by every session as the dashboard's is.
  it('hands over a mask of its own beside another open session, and ending it ends only its own binding', async () => {
    const [ALPHA, BETA] = ['tok/alpha 1a', 'tok/beta 2b']
    const alpha = pluginProject(tokenAnswer(ALPHA))
    const beta = pluginProject(tokenAnswer(BETA))
    const binder = recordingMaskBinder()
    const first = await openSession({ ...alpha.deps, bindSessionMask: binder.bindSessionMask })
    await openSession({ ...beta.deps, bindSessionMask: binder.bindSessionMask })
    const [alphaMask, betaMask] = binder.masks

    expect(await first.manager.terminateSession(first.sessionId)).toBe(true)

    expect(binder.ends).toEqual([1, 0])
    expectAnswerHidden(alphaMask!, ALPHA)
    expectAnswerHidden(betaMask!, BETA)
    expect(alphaMask!(tokenAnswer(BETA).url), "the other session's answer").toBe(
      tokenAnswer(BETA).url,
    )
    expect(betaMask!(tokenAnswer(ALPHA).url), "the other session's answer").toBe(
      tokenAnswer(ALPHA).url,
    )
    await expectPluginGone(alpha)
    expect(methodsOf(beta)).toEqual(['initialize', 'acquire'])
  }, 60_000)

  it('hands its mask over once however often it is initialized', async () => {
    const binder = recordingMaskBinder()
    const session = new LiveSession('initialized-twice', {
      bindSessionMask: binder.bindSessionMask,
    })
    const config: LiveSessionConfig = {
      secretRedactor: new RunSecretRedactor(new SecretStore([])),
      platform: 'web',
      llmConfig: {
        provider: 'anthropic-compatible',
        model: 'test-model',
        baseURL: 'http://127.0.0.1:1/',
      },
      headless: true,
    }

    await session.initialize(config)
    await session.initialize(config)
    await session.cleanup()

    expect(binder.masks).toHaveLength(1)
    expect(binder.ends).toEqual([1])
  })

  it('opens, ends and shuts its plugin down when its host cannot take the mask', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const host = throwingMaskBinder('bind')
    const { manager, sessionId } = await openSession({
      ...project.deps,
      bindSessionMask: host.bindSessionMask,
    })
    expect(methodsOf(project)).toEqual(['initialize', 'acquire'])

    expect(await manager.terminateSession(sessionId)).toBe(true)

    expect(host.calls).toEqual({ binds: 1, ends: 0 })
    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)

  it('ends, lets its socket go and shuts its plugin down when its host cannot let the mask go', async () => {
    const project = pluginProject(tokenAnswer(TOKEN))
    const host = throwingMaskBinder('end')
    const { manager, sessionId } = await openSession({
      ...project.deps,
      bindSessionMask: host.bindSessionMask,
    })
    const session = manager.getSession(sessionId)!
    const delivered: unknown[] = []
    session.attachMessageSink((message) => delivered.push(message))

    expect(await manager.terminateSession(sessionId)).toBe(true)

    expect(host.calls).toEqual({ binds: 1, ends: 1 })
    expect(manager.getSession(sessionId)).toBeUndefined()
    expect(session.status).toBe('terminated')
    session.deliver({ type: 'step-cancelled' })
    expect(delivered, 'a message reached the socket of an ended session').toEqual([])
    await expectPluginGone(project)
    expect(methodsOf(project)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
  }, 60_000)
})

describe("a live-editor session and its plugin's stderr", () => {
  it("sends its plugin's stderr, masked and under its entry, to the debug log the dashboard gives it", async () => {
    const TOKEN = 'lab-token-7f2c9e'
    const project = pluginProject(ANSWER, { stderr: { acquire: 'signed in with ' + TOKEN } })
    const logged: string[] = []

    await openSession(
      { ...project.deps, pluginDebugLog: (line) => logged.push(line) },
      new RunSecretRedactor(new SecretStore({ LAB_TOKEN: TOKEN })),
    )

    await vi.waitFor(
      () => expect(logged).toContain('plugin lab: signed in with [secret:LAB_TOKEN]'),
      { timeout: EXIT_BUDGET_MS, interval: 25 },
    )
    expect(logged.join('\n')).not.toContain(TOKEN)
  }, 60_000)
})

function configDeps(config: Record<string, unknown>): SessionManagerDeps {
  return {
    configPath: join(tmpdir(), 'agent-qa.config.yaml'),
    configManager: {
      readWithRevision: vi
        .fn()
        .mockResolvedValue({ kind: 'ok', config, raw: '', revision: 'fixture' }),
      mask: (text: string) => text,
    } as never,
  }
}

describe('a project config the CLI refuses for its shape', () => {
  it("refuses a remote with both plugin and url in the CLI's sentence", async () => {
    const deps = configDeps({
      registry: {
        remotes: [{ name: REMOTE_NAME, plugin: ENTRY_NAME, url: 'ws://127.0.0.1:9/playwright' }],
      },
      plugins: [{ name: ENTRY_NAME, path: `./tools/${ENTRY_NAME}` }],
    })

    await expect(resolveLivePlace(deps.configManager, undefined, {})).rejects.toThrow(
      `project config sets registry.remotes[0]: Remote ${REMOTE_NAME} has both plugin and url; a remote has one or the other. The CLI refuses this file too.`,
    )
  })

  it("refuses a plugins entry with both package and path in the CLI's sentence", async () => {
    const deps = configDeps({
      registry: { remotes: [{ name: REMOTE_NAME, plugin: ENTRY_NAME }] },
      plugins: [
        { name: ENTRY_NAME, package: '@acme/agent-qa-plugin-lab', path: `./tools/${ENTRY_NAME}` },
      ],
    })

    await expect(openSession(deps)).rejects.toThrow(
      `project config sets plugins[0]: Plugin entry ${ENTRY_NAME} names both package and path; an entry names one or the other. The CLI refuses this file too.`,
    )
  })
})
