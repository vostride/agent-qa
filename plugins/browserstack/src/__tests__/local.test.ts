import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginError, type PluginCallContext } from '@vostride/agent-qa-plugin-kit'
import { afterEach, describe, expect, it } from 'vitest'
import { cannotRunReason, type TunnelFactory, type TunnelRequest } from '../local.js'
import { createBrowserStackPlugin } from '../plugin.js'
import { BROWSERSTACK_PLAYWRIGHT_VERSIONS } from '../playwright-versions.js'
import {
  ACCESS_KEY,
  initializePlugin,
  RUN_ID,
  startPluginProcess,
  TEST_NAME,
  USERNAME,
  type PluginProcess,
} from './plugin-process.js'

const LISTED = `${BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]}.0`
const FRESH_IDENTIFIER = /^agent-qa-[0-9a-f]{16}$/

interface FakeFactory extends TunnelFactory {
  starts: TunnelRequest[]
  stops: number
  aborts: number
}

function fakeFactory(input: { fail?: Error; startMs?: number } = {}): FakeFactory {
  const factory: FakeFactory = {
    starts: [],
    stops: 0,
    aborts: 0,
    start(request) {
      factory.starts.push(request)
      const running = (async () => {
        if (input.startMs !== undefined) await new Promise((r) => setTimeout(r, input.startMs))
        if (input.fail !== undefined) throw input.fail
        return {
          async stop() {
            factory.stops += 1
          },
        }
      })()
      return {
        running,
        async abort() {
          factory.aborts += 1
        },
      }
    },
  }
  return factory
}

function context(signal = new AbortController().signal): PluginCallContext & {
  messages: string[]
} {
  const messages: string[] = []
  return {
    signal,
    progress: (update) => messages.push(update.message),
    runFacts: { runId: RUN_ID },
    messages,
  }
}

async function browserStack(factory: TunnelFactory, options: Record<string, unknown> = {}) {
  const plugin = createBrowserStackPlugin({ tunnelFactory: factory })
  const parsed = plugin.options.parse({ username: USERNAME, accessKey: ACCESS_KEY, ...options })
  await plugin.initialize?.(
    {
      options: parsed,
      host: {
        pid: process.pid,
        agentQaVersion: '0.0.0',
        playwrightVersion: LISTED,
        webdriverioVersion: 'unknown',
      },
      entry: 'browserstack',
      runFacts: { runId: RUN_ID },
    },
    context(),
  )
  const settings = plugin.settings.parse({})
  return {
    plugin,
    web: async (ctx = context()) =>
      plugin.acquire(
        {
          remote: 'browserstack',
          settings,
          options: parsed,
          session: { platform: 'web', engine: 'chromium', context: 'new' },
          run: { testName: TEST_NAME },
        },
        ctx,
      ),
    device: async (ctx = context()) =>
      plugin.acquire(
        {
          remote: 'browserstack-devices',
          settings,
          options: parsed,
          session: {
            platform: 'android',
            capabilities: { 'appium:deviceName': 'Google Pixel 9' },
          },
          run: { testName: TEST_NAME },
        },
        ctx,
      ),
    shutdown: async () => plugin.shutdown?.({ options: parsed }, context()),
  }
}

function capsOf(url: string): Record<string, unknown> {
  return JSON.parse(new URL(url).searchParams.get('caps') ?? '{}') as Record<string, unknown>
}

function bstackOptions(answer: { capabilities?: Record<string, unknown> }) {
  return answer.capabilities?.['bstack:options'] as Record<string, unknown>
}

describe('BrowserStack Local started by the plugin', () => {
  it('starts one tunnel for the run with a fresh identifier, however many acquires ask', async () => {
    const factory = fakeFactory({ startMs: 20 })
    const { web, device } = await browserStack(factory, { local: true })

    const first = context()
    await Promise.all([web(first), device()])
    await web()

    expect(factory.starts).toHaveLength(1)
    expect(factory.starts[0]?.identifier).toMatch(FRESH_IDENTIFIER)
    expect(factory.starts[0]?.accessKey).toBe(ACCESS_KEY)
    expect(factory.starts[0]?.binary).toBeUndefined()
    expect(first.messages).toEqual(['starting BrowserStack Local'])
  })

  it('gives each plugin process its own identifier', async () => {
    const one = fakeFactory()
    const two = fakeFactory()
    await (await browserStack(one, { local: true })).web()
    await (await browserStack(two, { local: true })).web()

    expect(one.starts[0]?.identifier).not.toBe(two.starts[0]?.identifier)
  })

  it('asks for the tunnel in the web capabilities and the device bstack:options', async () => {
    const factory = fakeFactory()
    const { web, device } = await browserStack(factory, { local: true })

    const webAnswer = await web()
    const deviceAnswer = await device()
    const identifier = factory.starts[0]?.identifier

    expect(capsOf(webAnswer.url)).toMatchObject({
      'browserstack.local': true,
      'browserstack.localIdentifier': identifier,
    })
    expect(bstackOptions(deviceAnswer)).toMatchObject({ local: true, localIdentifier: identifier })
  })

  it('names the tunnel with localIdentifier and runs the localBinary when local is on', async () => {
    const factory = fakeFactory()
    const { web } = await browserStack(factory, {
      local: true,
      localIdentifier: 'team-tunnel',
      localBinary: '/opt/BrowserStackLocal',
    })

    const answer = await web()

    expect(factory.starts).toEqual([
      { accessKey: ACCESS_KEY, identifier: 'team-tunnel', binary: '/opt/BrowserStackLocal' },
    ])
    expect(capsOf(answer.url)['browserstack.localIdentifier']).toBe('team-tunnel')
  })

  it('stops the tunnel once on shutdown, however often shutdown runs', async () => {
    const factory = fakeFactory()
    const { web, shutdown } = await browserStack(factory, { local: true })
    await web()

    await shutdown()
    await shutdown()

    expect(factory.stops).toBe(1)
  })

  it('aborts a tunnel that was still starting when shutdown came, and stops it if it connects', async () => {
    const factory = fakeFactory({ startMs: 50 })
    const { web, shutdown } = await browserStack(factory, { local: true })
    const acquiring = web()

    await shutdown()
    await acquiring

    expect(factory.aborts).toBe(1)
    expect(factory.stops).toBe(1)
  })

  it('stops a connected tunnel without aborting it', async () => {
    const factory = fakeFactory()
    const { web, shutdown } = await browserStack(factory, { local: true })
    await web()

    await shutdown()

    expect(factory.aborts).toBe(0)
    expect(factory.stops).toBe(1)
  })

  it('stops nothing on shutdown when no acquire asked for the tunnel', async () => {
    const factory = fakeFactory()
    const { shutdown } = await browserStack(factory, { local: true })

    await shutdown()

    expect(factory.starts).toEqual([])
    expect(factory.stops).toBe(0)
  })

  it('refuses the acquire with kind unreachable naming the tunnel when the start fails, and tries again on the next', async () => {
    const factory = fakeFactory({ fail: new Error(`binary exited; key ${ACCESS_KEY} refused`) })
    const { web } = await browserStack(factory, { local: true })

    const refusal = await web().catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(PluginError)
    expect(refusal).toMatchObject({ kind: 'unreachable', path: 'options.local' })
    expect((refusal as Error).message).toBe(
      'BrowserStack Local did not start: binary exited; key *** refused',
    )
    await web().catch(() => {})
    expect(factory.starts).toHaveLength(2)
  })

  it('refuses the acquire at the plugin option local once shutdown stopped the tunnel', async () => {
    const factory = fakeFactory()
    const { web, shutdown } = await browserStack(factory, { local: true })
    await shutdown()

    const refusal = await web().catch((error: unknown) => error)

    expect(refusal).toMatchObject({ kind: 'unreachable', path: 'options.local' })
  })

  it('gives up waiting when the acquire is cancelled while the tunnel starts', async () => {
    const factory = fakeFactory({ startMs: 200 })
    const { web } = await browserStack(factory, { local: true })
    const controller = new AbortController()

    const acquiring = web(context(controller.signal))
    controller.abort()

    await expect(acquiring).rejects.toThrow('cancelled while BrowserStack Local was starting')
  })

  it('gives each spawn failure its own fix, and Rosetta only for a Mac binary built for another CPU', () => {
    const binary = '/opt/BrowserStackLocal'
    const failure = (code: string, errno: number) => Object.assign(new Error(code), { code, errno })
    const badCpu = failure('Unknown system error -86', -86)

    expect(cannotRunReason(binary, badCpu, 'darwin')).toBe(
      `this machine cannot run ${binary} (EBADARCH: bad CPU type in executable). Install Rosetta (softwareupdate --install-rosetta --agree-to-license) or set localBinary to a binary built for this Mac`,
    )
    expect(cannotRunReason(binary, badCpu, 'linux')).toBe(
      `this machine cannot run ${binary} (Unknown system error -86). Set localBinary to a binary this machine can run`,
    )
    expect(cannotRunReason(binary, failure('ENOENT', -2), 'darwin')).toBe(
      `${binary} does not exist (ENOENT). Set localBinary to the path of a BrowserStackLocal binary`,
    )
    expect(cannotRunReason(binary, failure('EACCES', -13), 'darwin')).toBe(
      `this machine cannot run ${binary} (EACCES). Check that it is an executable file, or set localBinary to one that is`,
    )
    expect(cannotRunReason(binary, failure('ENOEXEC', -8), 'darwin')).toBe(
      `this machine cannot run ${binary} (ENOEXEC). Set localBinary to a binary this machine can run`,
    )
  })
})

describe('a BrowserStack Local tunnel that is already running', () => {
  it('asks for the tunnel by localIdentifier and starts nothing', async () => {
    const factory = fakeFactory()
    const { web, device, shutdown } = await browserStack(factory, {
      localIdentifier: 'team-tunnel',
    })

    const webAnswer = await web()
    const deviceAnswer = await device()
    await shutdown()

    expect(capsOf(webAnswer.url)).toMatchObject({
      'browserstack.local': true,
      'browserstack.localIdentifier': 'team-tunnel',
    })
    expect(bstackOptions(deviceAnswer)).toMatchObject({
      local: true,
      localIdentifier: 'team-tunnel',
    })
    expect(factory.starts).toEqual([])
    expect(factory.stops).toBe(0)
  })

  it('asks for no tunnel when neither local nor localIdentifier is set', async () => {
    const factory = fakeFactory()
    const { web, device } = await browserStack(factory)

    const caps = capsOf((await web()).url)
    const own = bstackOptions(await device())

    expect(caps).not.toHaveProperty('browserstack.local')
    expect(caps).not.toHaveProperty('browserstack.localIdentifier')
    expect(own).not.toHaveProperty('local')
    expect(own).not.toHaveProperty('localIdentifier')
    expect(factory.starts).toEqual([])
  })

  it('refuses localBinary without local, because only a tunnel the plugin starts runs a binary', async () => {
    const refusal = await browserStack(fakeFactory(), {
      localBinary: '/opt/BrowserStackLocal',
    }).catch((error: unknown) => error)

    expect(refusal).toMatchObject({ kind: 'refused', path: 'localBinary' })
  })
})

const STUB = fileURLToPath(new URL('./fixtures/stub-browserstack-local.mjs', import.meta.url))

interface StubRecord {
  args: string[]
  pid: number
  launcher: number
}

interface StubBinary {
  dir: string
  path: string
  record(): StubRecord
  started(): boolean
  stopArgs(): string[] | undefined
}

const dirs: string[] = []
const sleepers: number[] = []
const processes: PluginProcess[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map((plugin) => plugin.close()))
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-browserstack-local-test-'))
  dirs.push(dir)
  return dir
}

// Git file modes do not survive every checkout, so the executable is written here.
function stubBinary(mode: 'connect' | 'fail' | 'slow'): StubBinary {
  const dir = freshDir()
  const path = join(dir, 'BrowserStackLocal')
  const recordPath = join(dir, 'record.json')
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "${recordPath}" "${mode}" "$@"\n`,
    { mode: 0o755 },
  )
  return {
    dir,
    path,
    record() {
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as StubRecord
      sleepers.push(record.pid)
      const logFile = record.args[record.args.indexOf('--log-file') + 1]
      if (logFile !== undefined) dirs.push(logFile)
      return record
    },
    started() {
      return existsSync(recordPath)
    },
    stopArgs() {
      const stopPath = `${recordPath}.stop`
      if (!existsSync(stopPath)) return undefined
      return (JSON.parse(readFileSync(stopPath, 'utf8')) as { args: string[] }).args
    },
  }
}

// A directory passes the wrapper's executable check, so it is found without a download, and
// spawning it fails with EACCES on every POSIX system.
function unrunnableBinary(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 5_000; waited += 50) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function argument(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

const webAcquire = {
  remote: 'browserstack',
  settings: {},
  session: { platform: 'web', engine: 'chromium', context: 'new' },
  run: { testName: TEST_NAME },
}

const NOT_EXECUTABLE = 'Check that it is an executable file, or set localBinary to one that is'

async function tunnelled(stub: StubBinary) {
  const cwd = freshDir()
  const plugin = startPluginProcess({ cwd })
  processes.push(plugin)
  const init = await initializePlugin(plugin, { local: true, localBinary: stub.path }, LISTED)
  expect(init.error).toBeUndefined()
  const answer = await plugin.call('acquire', webAcquire)
  if (answer.error === undefined) stub.record()
  return { cwd, plugin, answer }
}

function protocolOnly(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) {
    expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0')
  }
}

// The stand-in binary is a shell script and its sleeper is found by pid; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')('BrowserStack Local run through its wrapper', () => {
  it('connects the tunnel the localBinary runs and asks for it in the web capabilities', async () => {
    const stub = stubBinary('connect')

    const { answer } = await tunnelled(stub)

    expect(answer.error).toBeUndefined()
    const { args, pid } = stub.record()
    expect(args.slice(0, 2)).toEqual(['--daemon', 'start'])
    const identifier = argument(args, '--local-identifier')
    expect(identifier).toMatch(FRESH_IDENTIFIER)
    expect(capsOf((answer.result as { url: string }).url)).toMatchObject({
      'browserstack.local': true,
      'browserstack.localIdentifier': identifier,
    })
    expect(alive(pid)).toBe(true)
  })

  it('stops the tunnel on shutdown', async () => {
    const stub = stubBinary('connect')
    const { plugin } = await tunnelled(stub)
    const { pid } = stub.record()

    expect((await plugin.call('shutdown')).error).toBeUndefined()

    expect(await gone(pid)).toBe(true)
  })

  it('stops the tunnel when the host closes stdin', async () => {
    const stub = stubBinary('connect')
    const { plugin } = await tunnelled(stub)
    const { pid } = stub.record()

    await plugin.close()

    expect(await gone(pid)).toBe(true)
  })

  it('stops the tunnel on SIGTERM', async () => {
    const stub = stubBinary('connect')
    const { plugin } = await tunnelled(stub)
    const { pid } = stub.record()

    await plugin.terminate()

    expect(await gone(pid)).toBe(true)
  })

  it('stops a tunnel still starting when stdin closes, so it never outlives the plugin', async () => {
    const stub = stubBinary('slow')
    const plugin = startPluginProcess({ cwd: freshDir() })
    processes.push(plugin)
    const init = await initializePlugin(plugin, { local: true, localBinary: stub.path }, LISTED)
    expect(init.error).toBeUndefined()
    void plugin.request('acquire', {
      remote: 'browserstack',
      settings: {},
      session: { platform: 'web', engine: 'chromium', context: 'new' },
    })
    for (let waited = 0; !stub.started() && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const { args, pid, launcher } = stub.record()
    sleepers.push(launcher)

    await plugin.close()

    expect(await gone(pid)).toBe(true)
    expect(await gone(launcher)).toBe(true)
    const stopArgs = stub.stopArgs()
    expect(stopArgs?.slice(0, 2)).toEqual(['--daemon', 'stop'])
    expect(argument(stopArgs ?? [], '--local-identifier')).toBe(
      argument(args, '--local-identifier'),
    )
  })

  it('keeps stdout protocol-only although the wrapper logs with console.log', async () => {
    const stub = stubBinary('connect')
    const { plugin } = await tunnelled(stub)
    await plugin.close()

    protocolOnly(plugin.stdoutLines())
    expect(plugin.stderr()).toContain('BINARY PATH IS DEFINED')
  })

  it("logs to a fresh file under the temp directory and never to local.log in the plugin's working directory", async () => {
    const stub = stubBinary('connect')
    const { cwd, plugin } = await tunnelled(stub)
    await plugin.close()

    const logFile = argument(stub.record().args, '--log-file') ?? ''
    expect(logFile.startsWith(join(tmpdir(), 'agent-qa-browserstack-local-'))).toBe(true)
    expect(logFile.endsWith('.log')).toBe(true)
    expect(existsSync(join(cwd, 'local.log'))).toBe(false)
  })

  it('refuses the acquire with kind unreachable when the binary fails, without the key, and leaves the binary in place', async () => {
    const stub = stubBinary('fail')

    const { answer, plugin } = await tunnelled(stub)

    expect(answer.error?.code).toBe(-32000)
    expect(answer.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.localBinary' })
    expect(answer.error?.message).toMatch(/^BrowserStack Local did not start: /)
    expect(answer.error?.message).not.toContain(ACCESS_KEY)
    expect(plugin.stderr()).toContain('Error while trying to execute binary')
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
    const logFile = /\(its log is (.+)\)$/.exec(answer.error?.message ?? '')?.[1]
    expect(logFile?.startsWith(join(tmpdir(), 'agent-qa-browserstack-local-'))).toBe(true)
    if (logFile !== undefined) dirs.push(logFile)
    expect(existsSync(stub.path)).toBe(true)
  })

  it('refuses the acquire at the plugin option localBinary with the fix when this machine cannot run it, leaves no log, and keeps serving', async () => {
    const binary = unrunnableBinary(join(freshDir(), 'BrowserStackLocal'))
    const temp = freshDir()
    const plugin = startPluginProcess({ cwd: freshDir(), env: { ...process.env, TMPDIR: temp } })
    processes.push(plugin)
    const init = await initializePlugin(plugin, { local: true, localBinary: binary }, LISTED)
    expect(init.error).toBeUndefined()

    const first = await plugin.call('acquire', webAcquire)

    expect(first.error?.code).toBe(-32000)
    expect(first.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.localBinary' })
    expect(first.error?.message).toBe(
      `BrowserStack Local did not start: this machine cannot run ${binary} (EACCES). ${NOT_EXECUTABLE}`,
    )
    const second = await plugin.call('acquire', webAcquire)
    expect(second.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.localBinary' })
    expect((await plugin.call('shutdown')).error).toBeUndefined()
    expect(readdirSync(temp)).toEqual([])
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('refuses a localBinary that does not exist at the plugin option localBinary, saying so', async () => {
    const binary = join(freshDir(), 'BrowserStackLocl')
    const temp = freshDir()
    const plugin = startPluginProcess({ cwd: freshDir(), env: { ...process.env, TMPDIR: temp } })
    processes.push(plugin)
    const init = await initializePlugin(plugin, { local: true, localBinary: binary }, LISTED)
    expect(init.error).toBeUndefined()

    const answer = await plugin.call('acquire', webAcquire)

    expect(answer.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.localBinary' })
    expect(answer.error?.message).toBe(
      `BrowserStack Local did not start: ${binary} does not exist (ENOENT). Set localBinary to the path of a BrowserStackLocal binary`,
    )
    expect(readdirSync(temp)).toEqual([])
  })

  it('refuses the acquire at the plugin option local with the fix when this machine cannot run the binary the wrapper finds, leaves no log, and keeps serving', async () => {
    const home = freshDir()
    const found = unrunnableBinary(join(home, '.browserstack', 'BrowserStackLocal'))
    const temp = freshDir()
    const plugin = startPluginProcess({
      cwd: freshDir(),
      env: { ...process.env, HOME: home, TMPDIR: temp },
    })
    processes.push(plugin)
    const init = await initializePlugin(plugin, { local: true }, LISTED)
    expect(init.error).toBeUndefined()

    const first = await plugin.call('acquire', webAcquire)

    expect(first.error?.code).toBe(-32000)
    expect(first.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.local' })
    expect(first.error?.message).toBe(
      `BrowserStack Local did not start: this machine cannot run ${found} (EACCES). ${NOT_EXECUTABLE}`,
    )
    const second = await plugin.call('acquire', webAcquire)
    expect(second.error?.data).toMatchObject({ kind: 'unreachable', path: 'options.local' })
    expect(readdirSync(temp)).toEqual([])
    expect((await plugin.call('shutdown')).error).toBeUndefined()
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })
})
