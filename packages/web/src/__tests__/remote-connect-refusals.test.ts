import { chromium } from 'playwright-core'
import {
  createRemoteRefusalMemory,
  RemoteRefusalError,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type {
  RemoteBrowserConfig,
  RemoteFailureKind,
  RemotePluginBrowserConfig,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import type { WebPlatformAdapterOptions } from '../adapter.js'
import { formatConnectTimeout, playwrightMajorMinor } from '../remote-connection.js'
import {
  freePort,
  startCountingProxy,
  startMismatchedRunServer,
  startPlaywrightServer,
  startSilentSocket,
  startStatusServer,
} from './fixtures/remote-browsers.js'

const PASSWORD_MARK = 'pw-userinfo-mark'
const PATH_MARK = 'path-token-mark'
const QUERY_MARK = 'query-secret-mark'
const BODY_MARK = 'response-body-mark'
const TOKEN_MARK = 'declared-token-mark'
const SECRET_PASSWORD_MARK = 'declared-password-mark'
const LEAK_MARKS = [
  PASSWORD_MARK,
  PATH_MARK,
  QUERY_MARK,
  BODY_MARK,
  TOKEN_MARK,
  SECRET_PASSWORD_MARK,
]
const connectionSecrets = new SecretStore({
  GRID_TOKEN: TOKEN_MARK,
  GRID_PASSWORD: SECRET_PASSWORD_MARK,
})
const SECRETS_FILE = '.env.secrets.local'
const CONNECT_TIMEOUT_MS = 30_000

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

function remoteAt(
  protocol: RemoteBrowserConfig['protocol'],
  scheme: string,
  port: number,
  extra: Partial<RemoteBrowserConfig> = {},
): RemoteBrowserConfig {
  return {
    name: 'grid',
    protocol,
    url: `${scheme}://agent:${PASSWORD_MARK}@127.0.0.1:${String(port)}/session/${PATH_MARK}?token=${QUERY_MARK}`,
    headers: { 'x-api-token': '{{secret:GRID_TOKEN}}' },
    basicAuth: { user: 'agent', password: '{{secret:GRID_PASSWORD}}' },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    ...extra,
  }
}

async function refusalOf(
  remote: RemoteBrowserConfig | RemotePluginBrowserConfig,
  options: WebPlatformAdapterOptions = { connectionSecrets, secretsFile: SECRETS_FILE },
): Promise<RemoteRefusalError> {
  const adapter = new WebPlatformAdapter(options)
  try {
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
  } catch (error) {
    return error as RemoteRefusalError
  } finally {
    await adapter.cleanup()
  }
  throw new Error('setup connected to a remote that should refuse')
}

function expectRefusal(error: RemoteRefusalError, kind: RemoteFailureKind, sentence: string): void {
  expect(error).toBeInstanceOf(RemoteRefusalError)
  expect(error.name).toBe('RemoteRefusalError')
  expect(error.kind).toBe(kind)
  expect(error.message).toBe(sentence)
  expect('cause' in error).toBe(false)
  expect('log' in error).toBe(false)
  const carried = [
    error.message,
    error.stack ?? '',
    String(error),
    ...Object.getOwnPropertyNames(error).map((key) =>
      String((error as unknown as Record<string, unknown>)[key]),
    ),
  ].join('\n')
  for (const mark of LEAK_MARKS) expect(carried).not.toContain(mark)
}

async function statusService(status: number): Promise<number> {
  const server = await startStatusServer(status, `refused by the service ${BODY_MARK}`)
  teardowns.push(() => server.close())
  return server.port
}

describe('a remote that cannot connect', () => {
  it.each([401, 403])('names the secrets to check when the service answers %i', async (status) => {
    const port = await statusService(status)
    const error = await refusalOf(remoteAt('playwright', 'ws', port))
    expectRefusal(
      error,
      'auth',
      `Remote grid (playwright ws://127.0.0.1:${String(port)}) refused the credentials. Check GRID_PASSWORD and GRID_TOKEN in ${SECRETS_FILE}.`,
    )
  })

  it('points at the remote entry when a refused remote references no secrets', async () => {
    const port = await statusService(401)
    const remote = remoteAt('cdp', 'ws', port)
    delete remote.headers
    delete remote.basicAuth
    const error = await refusalOf(remote)
    expectRefusal(
      error,
      'auth',
      `Remote grid (cdp ws://127.0.0.1:${String(port)}) refused the credentials. Check its headers, query and basicAuth in registry.remotes.`,
    )
  })

  it('names the configured secrets file setting when the run names no file', async () => {
    const port = await statusService(403)
    const error = await refusalOf(remoteAt('playwright', 'ws', port), { connectionSecrets })
    expect(error.message).toBe(
      `Remote grid (playwright ws://127.0.0.1:${String(port)}) refused the credentials. Check GRID_PASSWORD and GRID_TOKEN in workspace.secretsFile.`,
    )
  })

  it('refuses the credentials found during DevTools discovery over http', async () => {
    const port = await statusService(401)
    const error = await refusalOf(remoteAt('cdp', 'http', port))
    expectRefusal(
      error,
      'auth',
      `Remote grid (cdp http://127.0.0.1:${String(port)}) refused the credentials. Check GRID_PASSWORD and GRID_TOKEN in ${SECRETS_FILE}.`,
    )
  })

  it.each([429, 503])('asks for fewer workers when the service answers %i', async (status) => {
    const port = await statusService(status)
    const error = await refusalOf(remoteAt('playwright', 'ws', port))
    expectRefusal(
      error,
      'capacity',
      `Remote grid (playwright ws://127.0.0.1:${String(port)}) has no free session. Lower use.workers or raise the service's limit.`,
    )
  })

  it('names the Playwright version agent-qa uses when a run-server runs another', async () => {
    const server = await startMismatchedRunServer()
    teardowns.push(() => server.close())
    const { port } = new URL(server.wsEndpoint)
    // A run-server serves its root path only; any other path answers 400.
    const remote = remoteAt('playwright', 'ws', Number(port), {
      url: `ws://agent:${PASSWORD_MARK}@127.0.0.1:${port}/?token=${QUERY_MARK}`,
    })
    const error = await refusalOf(remote)
    expectRefusal(
      error,
      'version',
      `Remote grid (playwright ws://127.0.0.1:${port}) runs another Playwright version; agent-qa uses ${playwrightMajorMinor()}.`,
    )
    expect(playwrightMajorMinor()).toMatch(/^\d+\.\d+$/)
  })

  it('says the remote did not answer when nothing listens on its port', async () => {
    const port = await freePort()
    const error = await refusalOf(remoteAt('playwright', 'ws', port))
    expectRefusal(
      error,
      'unreachable',
      `Remote grid (playwright ws://127.0.0.1:${String(port)}) did not answer. Check its url and that the service is running.`,
    )
  })

  it('says the remote did not answer when its host does not resolve', async () => {
    const remote = remoteAt('cdp', 'wss', 443, {
      url: `wss://agent:${PASSWORD_MARK}@no-such-host.invalid/session/${PATH_MARK}?token=${QUERY_MARK}`,
    })
    const error = await refusalOf(remote)
    expectRefusal(
      error,
      'unreachable',
      'Remote grid (cdp wss://no-such-host.invalid:443) did not answer. Check its url and that the service is running.',
    )
  })

  it('names the connect timeout when the remote never answers', async () => {
    const silent = await startSilentSocket()
    teardowns.push(() => silent.close())
    const error = await refusalOf(
      remoteAt('playwright', 'ws', silent.port, { connectTimeoutMs: 1500 }),
    )
    expectRefusal(
      error,
      'timeout',
      `Remote grid (playwright ws://127.0.0.1:${String(silent.port)}) did not connect within 1500ms. Raise its connectTimeout or check the service.`,
    )
  })

  it('names the connect timeout when the remote goes silent right after its handshake', async () => {
    const server = await startPlaywrightServer()
    teardowns.push(() => server.close())
    const upstream = new URL(server.wsEndpoint)
    const proxy = await startCountingProxy(Number(upstream.port))
    teardowns.push(() => proxy.close())
    const connect = chromium.connect.bind(chromium)
    vi.spyOn(chromium, 'connect').mockImplementation(async (...args) => {
      const browser = await connect(...args)
      proxy.blackhole()
      return browser
    })
    const remote: RemoteBrowserConfig = {
      name: 'grid',
      protocol: 'playwright',
      url: `ws://127.0.0.1:${String(proxy.port)}${upstream.pathname}`,
      connectTimeoutMs: 1500,
    }

    const error = await refusalOf(remote, {})

    expectRefusal(
      error,
      'timeout',
      `Remote grid (playwright ws://127.0.0.1:${String(proxy.port)}) connected but did not open a page within 1500ms. Raise its connectTimeout or check the service.`,
    )
  }, 60_000)

  it('writes a connect timeout in whole minutes, whole seconds or milliseconds', () => {
    expect(formatConnectTimeout(300_000)).toBe('5m')
    expect(formatConnectTimeout(90_000)).toBe('90s')
    expect(formatConnectTimeout(1_500)).toBe('1500ms')
  })

  it('is not asked again in the run once it refused', async () => {
    const port = await statusService(401)
    const proxy = await startCountingProxy(port)
    teardowns.push(() => proxy.close())
    const refusalMemory = createRemoteRefusalMemory()
    const remote = remoteAt('playwright', 'ws', proxy.port)
    const options = { refusalMemory, connectionSecrets, secretsFile: SECRETS_FILE }

    const first = await refusalOf(remote, options)
    const second = await refusalOf(remote, options)

    const sentence = `Remote grid (playwright ws://127.0.0.1:${String(proxy.port)}) refused the credentials. Check GRID_PASSWORD and GRID_TOKEN in ${SECRETS_FILE}.`
    expectRefusal(first, 'auth', sentence)
    expectRefusal(second, 'auth', sentence)
    expect(proxy.connections()).toBe(1)
  })

  it('refuses a plugin remote in one line when its host started no plugin host', async () => {
    const connect = vi.spyOn(chromium, 'connect')
    const connectOverCDP = vi.spyOn(chromium, 'connectOverCDP')
    const remote: RemotePluginBrowserConfig = {
      name: 'cloud',
      plugin: { entry: 'kernel', settings: { region: 'eu' } },
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    }
    const error = await refusalOf(remote)
    expectRefusal(
      error,
      'refused',
      'Remote cloud names plugin entry kernel, and this host started no plugin host for it.',
    )
    expect(error.remote).toBe('cloud')
    expect(connect).not.toHaveBeenCalled()
    expect(connectOverCDP).not.toHaveBeenCalled()
  })

  it('does not remember a session that ended or was lost', () => {
    const memory = createRemoteRefusalMemory()
    for (const kind of ['ended', 'lost'] as const) {
      memory.remember('grid', new RemoteRefusalError('The session ended.', { remote: 'grid', kind }))
    }
    expect(memory.refusalFor('grid')).toBeUndefined()
  })
})
