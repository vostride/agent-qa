import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { heartbeat, deviceAdapters } = vi.hoisted(() => ({
  heartbeat: { beats: 0 },
  deviceAdapters: [] as Array<{ options: Record<string, unknown>; setupConfig?: unknown }>,
}))

// The adapter beats on its own interval while it holds a remote, as the real one does.
vi.mock('@vostride/agent-qa-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-web')>()),
  WebPlatformAdapter: vi.fn().mockImplementation(function () {
    let beat: ReturnType<typeof setInterval> | undefined
    return {
      platform: 'web',
      setup: vi.fn(async (config: { browser?: { remote?: unknown } }) => {
        if (config.browser?.remote === undefined) return
        beat = setInterval(() => {
          heartbeat.beats += 1
        }, 30_000)
      }),
      cleanup: vi.fn(async () => clearInterval(beat)),
      execute: vi.fn().mockResolvedValue({ success: true }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('frame')),
      observe: vi.fn().mockResolvedValue({ tree: 'main', elements: [], timestamp: 0, metadata: {} }),
      drainConsoleLogs: vi.fn(() => []),
      drainNetworkLogs: vi.fn(() => []),
    }
  }),
}))

vi.mock('@vostride/agent-qa-android', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-android')>()),
  AndroidPlatformAdapter: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
    const built: (typeof deviceAdapters)[number] = { options }
    deviceAdapters.push(built)
    return {
      platform: 'android',
      setup: vi.fn(async (config: unknown) => {
        built.setupConfig = config
      }),
      cleanup: vi.fn(async () => undefined),
      execute: vi.fn().mockResolvedValue({ success: true }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('frame')),
      observe: vi.fn().mockResolvedValue({ tree: 'main', elements: [], timestamp: 0, metadata: {} }),
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

import { SecretRedactor, SecretStore, createRemoteSessionRegistry } from '@vostride/agent-qa-runner'
import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'

import { IDLE_TIMEOUT_MS, REMOTE_INACTIVITY_TIMEOUT_MS } from '../live-session.js'
import type { LiveSession } from '../live-session.js'
import { SessionManager } from '../session-manager.js'
import { LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from '../types.js'
import type { LiveSessionConfig } from '../types.js'
import { createSessionHandler } from '../ws-handler.js'

const MINUTE = 60_000

const remote: RemoteBrowserConfig = {
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://grid.example.test/playwright',
  connectTimeoutMs: 30_000,
}

class FakeSocket {
  readyState = 1
  OPEN = 1
  readonly sent: Record<string, unknown>[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
  }

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  message(msg: object): void {
    for (const handler of this.handlers.get('message') ?? []) void handler(Buffer.from(JSON.stringify(msg)))
  }

  drop(): void {
    this.readyState = 3
    for (const handler of this.handlers.get('close') ?? []) handler()
  }
}

interface Opened {
  manager: SessionManager
  sessionId: string
  session: LiveSession
  attach(): FakeSocket
  open(): boolean
}

let managers: SessionManager[] = []

beforeEach(() => {
  heartbeat.beats = 0
  deviceAdapters.length = 0
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(managers.map((manager) => manager.cleanupAll()))
  managers = []
  vi.restoreAllMocks()
})

async function openSession(place?: RemoteBrowserConfig): Promise<Opened> {
  const manager = new SessionManager()
  managers.push(manager)
  const config: LiveSessionConfig = {
    platform: 'web',
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1/',
    },
    headless: true,
    ...(place === undefined ? {} : { remote: place }),
  }
  const { sessionId } = await manager.createSession(config)
  const session = manager.getSession(sessionId)!
  return {
    manager,
    sessionId,
    session,
    // The page's socket, which ends the session through the manager as the server wires it.
    attach() {
      const socket = new FakeSocket()
      createSessionHandler(session, () => {
        void manager.terminateSession(sessionId)
      })(socket as never)
      return socket
    },
    open: () => manager.getSession(sessionId) !== undefined,
  }
}

const deviceConfig = {
  use: { mobile: { appState: 'preserve' } },
  registry: {
    remotes: [{ name: 'farm', protocol: 'appium', url: 'https://farm.example.test/wd/hub' }],
    targets: {
      'shop-android': { platform: 'android', appPackage: 'com.example.shop', device: 'pixel' },
    },
    devices: {
      pixel: { platform: 'android', model: 'Pixel 8' },
      'galaxy-farm': { platform: 'android', model: 'Samsung Galaxy S24', remote: 'farm' },
    },
  },
}

interface OpenedDevice extends Opened {
  acquireLease: ReturnType<typeof vi.fn>
}

// A mobile session built from the project config; the device here is one running phone.
async function openDeviceSession(
  device: 'pixel' | 'galaxy-farm',
  extra: Partial<LiveSessionConfig> = {},
  remoteSessions = createRemoteSessionRegistry(),
): Promise<OpenedDevice> {
  const acquireLease = vi.fn().mockResolvedValue(undefined)
  const manager = new SessionManager({
    appiumManager: {
      acquireLease,
      releaseLease: vi.fn().mockReturnValue(true),
      getUrl: vi.fn(() => 'http://127.0.0.1:4723'),
    } as never,
    configManager: {
      readWithRevision: vi.fn().mockResolvedValue({
        kind: 'ok',
        config: deviceConfig,
        raw: '',
        revision: 'fixture',
      }),
    } as never,
    configPath: '/tmp/agent-qa.config.yaml',
    remoteSessions,
    listDevicesHere: async () => ({
      attached: [{ serial: '37121FDJH000', state: 'device', model: 'Pixel 8' }],
      avds: [],
    }),
    appiumEnvUrl: '',
  })
  managers.push(manager)
  const { sessionId } = await manager.createSession({
    platform: 'android',
    targetName: 'shop-android',
    useDeviceName: device,
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1/',
    },
    ...extra,
  })
  const session = manager.getSession(sessionId)!
  return {
    manager,
    sessionId,
    session,
    acquireLease,
    attach() {
      const socket = new FakeSocket()
      createSessionHandler(session, () => {
        void manager.terminateSession(sessionId)
      })(socket as never)
      return socket
    },
    open: () => manager.getSession(sessionId) !== undefined,
  }
}

describe("a live-editor session on a remote device", () => {
  it('ends an attached session 30 minutes after it opened when no command arrives', async () => {
    const opened = await openDeviceSession('galaxy-farm')
    const socket = opened.attach()
    expect(opened.session.runsOnRemote).toBe(true)

    await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_TIMEOUT_MS - 1)
    expect(opened.open(), 'not one millisecond early').toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
    expect(socket.closes).toEqual([{ code: LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, reason: 'session_ended' }])
    expect(opened.session.status).toBe('terminated')
  })

  it('moves the end to minute 59 when a step runs at minute 29', async () => {
    const opened = await openDeviceSession('galaxy-farm')
    vi.spyOn(opened.session, 'executeStepCommand').mockResolvedValue({
      name: 'open the cart',
      status: 'passed',
      duration: 1,
    } as never)
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(29 * MINUTE)
    socket.message({ type: 'execute-step', stepInstruction: 'open the cart', stepIndex: 0 })

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('builds the device adapter with the connection options a remote browser gets', async () => {
    const remoteSessions = createRemoteSessionRegistry()
    const declared = new SecretStore({ FARM_KEY: 'farm-key-value' })
    const opened = await openDeviceSession(
      'galaxy-farm',
      {
        connectionSecretStore: declared,
        secretsFile: '.env.secrets.local',
        secretRedactor: new SecretRedactor(declared),
      },
      remoteSessions,
    )

    expect(opened.acquireLease).not.toHaveBeenCalled()
    const [built] = deviceAdapters
    expect(built?.options).toMatchObject({
      connectionSecrets: declared,
      secretsFile: '.env.secrets.local',
      sessions: remoteSessions,
      refusalMemory: expect.any(Object),
    })
    const mask = built?.options.mask as (text: string) => string
    expect(mask('the farm said farm-key-value')).not.toContain('farm-key-value')
    expect(built?.setupConfig).toMatchObject({
      device: { name: 'galaxy-farm', remote: { name: 'farm', protocol: 'appium' } },
    })
  })

  it('gives a session on a device here no 30-minute timer', async () => {
    const opened = await openDeviceSession('pixel')
    const socket = opened.attach()
    expect(opened.session.runsOnRemote).toBe(false)
    expect(opened.acquireLease).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4 * 60 * MINUTE)
    expect(opened.open()).toBe(true)
    expect(socket.closes).toEqual([])
  })
})

describe("a remote live-editor session's inactivity", () => {
  it('ends an attached session 30 minutes after it opened when no command arrives', async () => {
    const opened = await openSession(remote)
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_TIMEOUT_MS - 1)
    expect(opened.open(), 'not one millisecond early').toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
    expect(socket.closes).toEqual([{ code: LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, reason: 'session_ended' }])
    expect(opened.session.status).toBe('terminated')
  })

  it('moves the end to minute 59 when a step runs at minute 29', async () => {
    const opened = await openSession(remote)
    vi.spyOn(opened.session, 'executeStepCommand').mockResolvedValue({
      name: 'open the inbox',
      status: 'passed',
      duration: 1,
    } as never)
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(29 * MINUTE)
    socket.message({ type: 'execute-step', stepInstruction: 'open the inbox', stepIndex: 0 })

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('moves the end when the ARIA panel fetches the tree at minute 29', async () => {
    const opened = await openSession(remote)
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(29 * MINUTE)
    socket.message({ type: 'get-aria-tree' })

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1)
    expect(opened.open()).toBe(true)
    expect(socket.sent).toContainEqual({ type: 'aria-tree', tree: 'main' })
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('ends at minute 30 though a client asks for the state every minute', async () => {
    const opened = await openSession(remote)
    const socket = opened.attach()

    for (let minute = 1; minute < 30; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE)
      socket.message({ type: 'get-state' })
    }
    expect(socket.sent.filter((message) => message.type === 'session-state').length).toBeGreaterThan(29)

    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('ends at minute 30 while preview frames, device-log pushes and heartbeats run throughout', async () => {
    const opened = await openSession(remote)
    const frames: unknown[] = []
    opened.session.liveAttachment().subscribeFrames(0, (frame) => frames.push(frame))
    // The device-log push runs for device sessions; it is driven on this one to show it counts for nothing.
    const state = opened.session.getState.bind(opened.session)
    vi.spyOn(opened.session, 'getState').mockImplementation(() => ({ ...state(), platform: 'android' }))
    vi.spyOn(opened.session, 'drainDeviceLogs').mockResolvedValue([
      { level: 'info', message: 'tick', timestamp: 0 },
    ])
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_TIMEOUT_MS - 1)
    expect(opened.open()).toBe(true)
    expect(frames.length).toBeGreaterThan(100)
    expect(socket.sent.filter((message) => message.type === 'device-logs').length).toBeGreaterThan(100)
    expect(heartbeat.beats).toBeGreaterThan(50)

    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('ends at minute 30 when the page drops and reconnects without a command', async () => {
    const opened = await openSession(remote)
    let socket = opened.attach()

    for (let minute = 4; minute < 30; minute += 4) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE)
      socket.drop()
      socket = opened.attach()
    }

    await vi.advanceTimersByTimeAsync(2 * MINUTE - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
    expect(socket.closes).toEqual([{ code: LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, reason: 'session_ended' }])
  })

  it.each([
    ['on a remote', remote],
    ['here', undefined],
  ])('still ends a detached session %s after 5 minutes', async (_where, place) => {
    const opened = await openSession(place)
    const socket = opened.attach()
    await vi.advanceTimersByTimeAsync(MINUTE)
    socket.drop()

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it('gives a session here no 30-minute timer', async () => {
    const opened = await openSession()
    const socket = opened.attach()

    await vi.advanceTimersByTimeAsync(4 * 60 * MINUTE)
    expect(opened.open()).toBe(true)
    expect(socket.closes).toEqual([])
  })

  // The session's own work, standing in for a slow step, test or hook on a remote.
  type SessionWork = 'executeStepInternal' | 'runLifecycleHooksCapturing' | 'runLifecycleHooks'
  function holdWork(session: LiveSession, work: SessionWork, ms: number, result: unknown): void {
    const internals = session as unknown as Record<SessionWork, () => Promise<unknown>>
    vi.spyOn(internals, work).mockImplementation(
      () => new Promise((done) => setTimeout(() => done(result), ms)),
    )
  }

  const LONG_WORK_MS = 45 * MINUTE
  const longWork: Record<string, (session: LiveSession) => Promise<unknown>> = {
    step: (session) => {
      holdWork(session, 'executeStepInternal', LONG_WORK_MS, { status: 'passed' })
      return session.executeStepCommand('open the inbox', 0)
    },
    test: (session) => {
      holdWork(session, 'runLifecycleHooksCapturing', LONG_WORK_MS, { allPassed: false, logs: [] })
      return session.executeTestCommand('exec-1', {
        testIndex: 0,
        testId: '',
        testName: 'inbox',
        steps: ['open the inbox'],
        setup: ['seed'],
        teardown: [],
      })
    },
    hook: (session) => {
      holdWork(session, 'runLifecycleHooks', LONG_WORK_MS, { allPassed: true, logs: [] })
      return session.executeHookCommand('setup', 'seed')
    },
  }

  it.each(['step', 'test', 'hook'])(
    'keeps the session through a %s that runs past 30 minutes and ends it 30 minutes after it finishes',
    async (kind) => {
      const opened = await openSession(remote)
      opened.attach()

      const work = longWork[kind]!(opened.session)
      await vi.advanceTimersByTimeAsync(LONG_WORK_MS)
      await work
      expect(opened.open(), 'open when the work ends').toBe(true)

      await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_TIMEOUT_MS - 1)
      expect(opened.open(), 'the window restarts when the work ends').toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(opened.open()).toBe(false)
    },
  )

  it('gives a person the whole window to read a step that ended at minute 29', async () => {
    const opened = await openSession(remote)
    opened.attach()
    holdWork(opened.session, 'executeStepInternal', 29 * MINUTE, { status: 'passed' })

    const work = opened.session.executeStepCommand('open the inbox', 0)
    await vi.advanceTimersByTimeAsync(29 * MINUTE)
    await work

    await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_TIMEOUT_MS - 1)
    expect(opened.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.open()).toBe(false)
  })

  it.each([
    { type: 'execute-step', stepInstruction: 'open the inbox', stepIndex: 0 },
    { type: 'execute-test', testExecutionId: 'exec-1', testId: 'test', path: 'tests/a.yaml', testIndex: 0 },
    { type: 'execute-hook', phase: 'setup', hookId: 'hook' },
    { type: 'cancel-step' },
    { type: 'terminate-session' },
    { type: 'navigate', url: 'https://example.test/' },
    { type: 'refresh-page' },
    { type: 'go-back' },
    { type: 'go-forward' },
    { type: 'get-aria-tree' },
  ])('counts $type as a person\'s activity', async (command) => {
    const opened = await openSession(remote)
    vi.spyOn(opened.session, 'executeStepCommand').mockResolvedValue({
      name: 'open the inbox',
      status: 'passed',
      duration: 1,
    } as never)
    vi.spyOn(opened.session, 'executeHookCommand').mockResolvedValue({} as never)
    const noted = vi.spyOn(opened.session, 'noteUserActivity')
    const socket = opened.attach()

    socket.message(command)
    expect(noted).toHaveBeenCalledTimes(1)
  })

  it.each([{ type: 'get-state' }, { type: 'no-such-command' }])(
    'does not count $type as activity',
    async (command) => {
      const opened = await openSession(remote)
      const noted = vi.spyOn(opened.session, 'noteUserActivity')
      const socket = opened.attach()

      socket.message(command)
      expect(noted).not.toHaveBeenCalled()
    },
  )
})
