// A W3C/Appium server on loopback that records every request and answers from a script.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export type NewSessionScript =
  | 'ok'
  | 'hold'
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly text: string }

export interface ExecuteError {
  readonly status: number
  readonly error: string
  readonly message: string
}

export interface FakeAppiumOptions {
  readonly basePath?: string
  // A new session without this header and value answers 401.
  readonly requireHeader?: readonly [string, string]
  // One script per new-session attempt; attempts past the end are 'ok'.
  readonly newSession?: readonly NewSessionScript[]
  readonly sessionCapabilities?: Readonly<Record<string, unknown>>
  readonly sessionIdStyle?: 'uuid' | 'mixed'
  readonly status?: { readonly version?: string } | 'fail' | 'hold'
  // Tested against `<METHOD> <path>`; a matching command request is never answered.
  readonly hold?: RegExp
  // Tested against `<METHOD> <path>`; a matching command request is answered after `ms`.
  readonly slow?: { readonly pattern: RegExp; readonly ms: number }
  // Keyed by the `mobile:` script name posted to execute/sync.
  readonly execute?: Readonly<Record<string, unknown>>
  readonly releaseActions?: 'ok' | 'unknown command'
}

export interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  // The query as sent, with its leading ?, or '' when there is none.
  readonly search: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface FakeAppiumServer {
  // The origin plus the base path, as a remote's url names it.
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

// A 1x1 transparent PNG.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const MINIMAL_SOURCE =
  '<?xml version="1.0" encoding="UTF-8"?><hierarchy index="0" rotation="0" width="1080" height="1920"></hierarchy>'

function isExecuteError(value: unknown): value is ExecuteError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.error === 'string' &&
    typeof candidate.message === 'string'
  )
}

function lowerCasedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendW3cError(response: ServerResponse, status: number, error: string, message: string) {
  sendJson(response, status, { value: { error, message, stacktrace: '' } })
}

function requestedCapabilities(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const capabilities = (body as { capabilities?: { alwaysMatch?: unknown } }).capabilities
  const alwaysMatch = capabilities?.alwaysMatch
  return typeof alwaysMatch === 'object' && alwaysMatch !== null
    ? { ...(alwaysMatch as Record<string, unknown>) }
    : {}
}

export async function startFakeAppiumServer(
  options: FakeAppiumOptions = {},
): Promise<FakeAppiumServer> {
  const basePath = (options.basePath ?? '/wd/hub').replace(/\/+$/, '')
  const requests: FakeAppiumRequest[] = []
  const created: string[] = []
  const deleted: string[] = []
  const sockets = new Set<Socket>()
  let attempts = 0

  const mintSessionId = (): string =>
    options.sessionIdStyle === 'mixed' ? `Abc-XYZ_${String(created.length + 1)}` : randomUUID()

  const newSession = (response: ServerResponse, record: FakeAppiumRequest): void => {
    const script = options.newSession?.[attempts] ?? 'ok'
    attempts += 1
    if (options.requireHeader !== undefined) {
      const [name, value] = options.requireHeader
      if (record.headers[name.toLowerCase()] !== value) {
        sendW3cError(response, 401, 'session not created', 'Missing or wrong credentials')
        return
      }
    }
    if (script === 'hold') return
    if (script !== 'ok') {
      if ('text' in script) {
        response.writeHead(script.status, { 'content-type': 'text/plain' })
        response.end(script.text)
      } else {
        sendJson(response, script.status, script.json)
      }
      return
    }
    const sessionId = mintSessionId()
    created.push(sessionId)
    sendJson(response, 200, {
      value: {
        sessionId,
        capabilities: { ...requestedCapabilities(record.body), ...options.sessionCapabilities },
      },
    })
  }

  const status = (response: ServerResponse): void => {
    if (options.status === 'hold') return
    if (options.status === 'fail') {
      sendW3cError(response, 500, 'unknown error', 'The server is not ready')
      return
    }
    const version = options.status?.version ?? '3.4.2'
    sendJson(response, 200, { value: { ready: true, message: 'ready', build: { version } } })
  }

  const execute = (response: ServerResponse, body: unknown): void => {
    const script = (body as { script?: unknown } | undefined)?.script
    const scripted = typeof script === 'string' ? options.execute?.[script] : undefined
    if (scripted !== undefined) {
      if (isExecuteError(scripted)) {
        sendW3cError(response, scripted.status, scripted.error, scripted.message)
      } else {
        sendJson(response, 200, { value: scripted })
      }
      return
    }
    sendJson(response, 200, { value: script === 'mobile: queryAppState' ? 4 : null })
  }

  const command = (response: ServerResponse, method: string, rest: string, body: unknown) => {
    const found = /^\/session\/([^/]+)(\/.*)?$/.exec(rest)
    const sessionId = found?.[1]
    const route = found?.[2] ?? ''
    if (sessionId !== undefined && route === '' && method === 'DELETE') {
      deleted.push(decodeURIComponent(sessionId))
      sendJson(response, 200, { value: null })
      return
    }
    if (method === 'POST' && route === '/execute/sync') return execute(response, body)
    if (
      route === '/actions' &&
      method === 'DELETE' &&
      options.releaseActions === 'unknown command'
    ) {
      sendW3cError(response, 404, 'unknown command', 'The requested resource could not be found')
      return
    }
    const answers: Record<string, unknown> = {
      'GET /source': MINIMAL_SOURCE,
      'GET /screenshot': PIXEL_PNG,
      'GET /contexts': ['NATIVE_APP'],
      'GET /context': 'NATIVE_APP',
      'GET /timeouts': { implicit: 0, command: 90_000 },
      'GET /window/rect': { x: 0, y: 0, width: 1080, height: 1920 },
      'POST /appium/device/app_state': 4,
    }
    const key = `${method} ${route}`
    sendJson(response, 200, { value: Object.hasOwn(answers, key) ? answers[key] : null })
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const method = request.method ?? 'GET'
      const { pathname: path, search } = new URL(request.url ?? '/', 'http://127.0.0.1')
      const record: FakeAppiumRequest = {
        method,
        path,
        search,
        headers: lowerCasedHeaders(request),
        body: parseBody(Buffer.concat(chunks).toString('utf8')),
      }
      requests.push(record)
      if (basePath !== '' && path !== basePath && !path.startsWith(`${basePath}/`)) {
        sendW3cError(response, 404, 'unknown command', 'The requested resource could not be found')
        return
      }
      const rest = path.slice(basePath.length) || '/'
      if (method === 'POST' && rest === '/session') return newSession(response, record)
      if (method === 'GET' && rest === '/status') return status(response)
      if (options.hold?.test(`${method} ${path}`) === true) return
      const slow = options.slow
      if (slow?.pattern.test(`${method} ${path}`) === true) {
        setTimeout(() => command(response, method, rest, record.body), slow.ms)
        return
      }
      command(response, method, rest, record.body)
    })
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${String(port)}`

  return {
    url: `${origin}${basePath === '' ? '/' : basePath}`,
    origin,
    requests,
    sessionsCreated: () => [...created],
    sessionsDeleted: () => [...deleted],
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((closed) => server.close(() => closed()))
    },
  }
}
