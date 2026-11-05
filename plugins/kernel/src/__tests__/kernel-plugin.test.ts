import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createLineDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from '@vostride/agent-qa-plugin-kit/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { kernelFailureKind } from '../kernel-api.js'
import {
  CREATE_ROUTE,
  DELETE_ROUTE,
  startFakeKernelApi,
  type FakeKernelApi,
} from './fake-kernel-api.js'

const ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url))
const API_KEY = 'kernel-test-key'
const WEB_SESSION = { platform: 'web', engine: 'chromium', context: 'new' } as const

interface RpcErrorData {
  kind?: string
  path?: string
  handle?: unknown
}

interface RpcAnswer {
  result?: unknown
  error?: { code: number; message: string; data?: RpcErrorData }
}

interface PluginHost {
  request(method: string, params?: unknown): Promise<RpcAnswer>
  stderr(): string
  close(): Promise<void>
}

const fakes: FakeKernelApi[] = []
const hosts: PluginHost[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

function startPlugin(): PluginHost {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (answer: RpcAnswer) => void>()
  let stderr = ''
  let next = 0
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      const message = JSON.parse(line) as RpcAnswer & { id?: number }
      if (typeof message.id !== 'number') return
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    },
    onOverflow: () => {
      throw new Error('the plugin wrote an oversized line')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const host: PluginHost = {
    request(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcAnswer>((resolve) => waiting.set(id, resolve))
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return answered
    },
    stderr: () => stderr,
    close() {
      child.stdin.end()
      return exited
    },
  }
  hosts.push(host)
  return host
}

async function startApi(input?: Parameters<typeof startFakeKernelApi>[0]) {
  const api = await startFakeKernelApi(input)
  fakes.push(api)
  return api
}

async function initialized(options: Record<string, unknown>) {
  const plugin = startPlugin()
  const answer = await plugin.request('initialize', {
    protocolVersions: [1],
    host: {
      pid: process.pid,
      agentQaVersion: '0.0.0',
      playwrightVersion: 'unknown',
      webdriverioVersion: 'unknown',
    },
    entry: 'kernel',
    options,
  })
  return { plugin, answer }
}

async function kernelPlugin(api: FakeKernelApi) {
  const { plugin, answer } = await initialized({ apiKey: API_KEY, apiUrl: api.url })
  expect(answer.error).toBeUndefined()
  return plugin
}

function acquire(plugin: PluginHost, settings: Record<string, unknown> = {}) {
  return plugin.request('acquire', { remote: 'kernel', settings, session: WEB_SESSION })
}

function createBodies(api: FakeKernelApi) {
  return api.routeCalls(CREATE_ROUTE).map((request) => request.body)
}

describe('creating a Kernel browser', () => {
  it('sends headless true and a 60 second timeout by default, with the key as the Bearer header', async () => {
    const api = await startApi()
    const plugin = await kernelPlugin(api)

    expect((await acquire(plugin)).error).toBeUndefined()

    expect(createBodies(api)).toEqual([{ headless: true, timeout_seconds: 60 }])
    expect(api.routeCalls(CREATE_ROUTE)[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('sends the curated settings it is given', async () => {
    const api = await startApi()
    const plugin = await kernelPlugin(api)

    await acquire(plugin, {
      headless: false,
      timeoutSeconds: 300,
      stealth: true,
      region: 'eu-west',
      proxy: { id: 'proxy-1' },
      viewport: { width: 1280, height: 800, refreshRate: 30 },
    })

    expect(createBodies(api)).toEqual([
      {
        headless: false,
        timeout_seconds: 300,
        stealth: true,
        region: 'eu-west',
        proxy: { id: 'proxy-1' },
        viewport: { width: 1280, height: 800, refresh_rate: 30 },
      },
    ])
  })

  it('lets a pass-through field override a default and a curated setting', async () => {
    const api = await startApi()
    const plugin = await kernelPlugin(api)

    await acquire(plugin, { headless: true, extra: { headless: false, kiosk_mode: true } })

    expect(createBodies(api)).toEqual([{ headless: false, timeout_seconds: 60, kiosk_mode: true }])
  })

  it('answers cdp with the browser url, masks it and the live view url, and returns no link', async () => {
    const api = await startApi()
    const plugin = await kernelPlugin(api)

    const answer = await acquire(plugin, { headless: false })

    expect(answer.result).toEqual({
      handle: { sessionId: 'browser-1' },
      protocol: 'cdp',
      url: 'wss://cdp.example.invalid/browser-1?jwt=browser-1-jwt',
      mask: [
        'wss://cdp.example.invalid/browser-1?jwt=browser-1-jwt',
        'https://live.example.invalid/browser-1?jwt=browser-1-live',
      ],
    })
  })

  it('returns the handle with the failure when the created browser has no cdp url', async () => {
    const api = await startApi({ create: [{ status: 200, json: { session_id: 'half-made' } }] })
    const plugin = await kernelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.data).toMatchObject({
      kind: 'refused',
      handle: { sessionId: 'half-made' },
    })
  })
})

describe('deleting a Kernel browser', () => {
  it('deletes the browser by its session id', async () => {
    const api = await startApi()
    const plugin = await kernelPlugin(api)
    const acquired = await acquire(plugin)

    const released = await plugin.request('release', {
      handle: (acquired.result as { handle: unknown }).handle,
    })

    expect(released).toMatchObject({ result: {} })
    expect(api.deletedIds()).toEqual(['browser-1'])
    expect(api.routeCalls(DELETE_ROUTE)[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('treats a browser Kernel no longer has as released', async () => {
    const api = await startApi({ delete: [{ status: 404, json: { message: 'not found' } }] })
    const plugin = await kernelPlugin(api)

    const released = await plugin.request('release', { handle: { sessionId: 'gone' } })

    expect(released).toMatchObject({ result: {} })
    expect(api.deletedIds()).toEqual(['gone'])
  })
})

describe('Kernel failures', () => {
  it.each([
    [429, 'capacity'],
    [529, 'capacity'],
    [401, 'auth'],
  ])('a %i from Kernel fails the acquire as %s', async (status, kind) => {
    const api = await startApi({ create: [{ status, json: { message: 'no' } }] })
    const plugin = await kernelPlugin(api)

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe(kind)
    expect(answer.error?.message).toContain(String(status))
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(answer.error?.message).not.toContain('\n')
  })

  it('maps statuses and a network error to failure kinds', () => {
    expect([401, 403, 429, 529, 400, 409, 500, undefined].map(kernelFailureKind)).toEqual([
      'auth',
      'auth',
      'capacity',
      'capacity',
      'refused',
      'refused',
      'refused',
      'unreachable',
    ])
  })

  it('fails as unreachable without naming the key when nothing answers', async () => {
    const api = await startApi()
    const url = api.url
    await api.close()
    const { plugin } = await initialized({ apiKey: API_KEY, apiUrl: url })

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('unreachable')
    expect(answer.error?.message).not.toContain(API_KEY)
    expect(plugin.stderr()).not.toContain(API_KEY)
  })
})

describe('the Kernel apiUrl', () => {
  it.each(['http://kernel.example.com', 'https://user:secret@api.onkernel.com'])(
    'refuses %s at initialize, pointing at apiUrl',
    async (apiUrl) => {
      const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

      expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'apiUrl' })
      expect(answer.error?.message).toBe(
        'apiUrl must use https:// unless it points at this machine.',
      )
    },
  )

  it.each(['https://api.onkernel.com', 'http://127.0.0.1:9', 'http://localhost:9'])(
    'accepts %s',
    async (apiUrl) => {
      const { answer } = await initialized({ apiKey: API_KEY, apiUrl })

      expect(answer.error).toBeUndefined()
    },
  )
})
