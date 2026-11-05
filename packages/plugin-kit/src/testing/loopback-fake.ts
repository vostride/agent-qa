import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export type LoopbackReply =
  | 'hold'
  | {
      status: number
      json?: unknown
      text?: string
      headers?: Record<string, string>
    }

export interface LoopbackRequest {
  method: string
  path: string
  query: Record<string, string>
  params: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export type LoopbackRoute = readonly LoopbackReply[] | ((request: LoopbackRequest) => LoopbackReply)

export interface LoopbackFakeInput {
  // Keyed by 'METHOD /path'; a ':name' segment matches any one segment.
  routes: Record<string, LoopbackRoute>
}

export interface LoopbackFake {
  url: string
  origin: string
  requests: readonly LoopbackRequest[]
  routeCalls(key: string): readonly LoopbackRequest[]
  close(): Promise<void>
}

interface CompiledRoute {
  key: string
  method: string
  segments: string[]
  route: LoopbackRoute
  calls: LoopbackRequest[]
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

function compile(key: string, route: LoopbackRoute): CompiledRoute {
  const match = /^([A-Z]+) (\/\S*)$/.exec(key)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`a loopback route is 'METHOD /path', not '${key}'`)
  }
  if (Array.isArray(route) && route.length === 0) {
    throw new Error(`the loopback route '${key}' has no replies`)
  }
  return { key, method: match[1], segments: splitPath(match[2]), route, calls: [] }
}

function matchParams(route: CompiledRoute, method: string, path: string) {
  if (route.method !== method) return undefined
  const segments = splitPath(path)
  if (segments.length !== route.segments.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, expected] of route.segments.entries()) {
    const actual = segments[index] ?? ''
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
    else if (expected !== actual) return undefined
  }
  return params
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

function send(response: ServerResponse, reply: Exclude<LoopbackReply, 'hold'>): void {
  const [contentType, text] =
    reply.json !== undefined
      ? ['application/json; charset=utf-8', JSON.stringify(reply.json)]
      : ['text/plain; charset=utf-8', reply.text ?? '']
  response.writeHead(reply.status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    ...reply.headers,
  })
  response.end(text)
}

export async function startLoopbackFake(input: LoopbackFakeInput): Promise<LoopbackFake> {
  const routes = Object.entries(input.routes).map(([key, route]) => compile(key, route))
  const requests: LoopbackRequest[] = []
  const sockets = new Set<Socket>()

  const answer = (record: LoopbackRequest, response: ServerResponse) => {
    for (const route of routes) {
      const params = matchParams(route, record.method, record.path)
      if (params === undefined) continue
      const request = { ...record, params }
      requests.push(request)
      route.calls.push(request)
      const reply =
        typeof route.route === 'function'
          ? route.route(request)
          : (route.route[Math.min(route.calls.length, route.route.length) - 1] ?? 'hold')
      if (reply !== 'hold') send(response, reply)
      return
    }
    requests.push(record)
    send(response, { status: 404, json: { message: 'no route' } })
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const record: LoopbackRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        params: {},
        headers: lowerCasedHeaders(request),
        body: parseBody(Buffer.concat(chunks).toString('utf8')),
      }
      answer(record, response)
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
  let closing: Promise<void> | undefined

  return {
    url: origin,
    origin,
    requests,
    routeCalls(key) {
      return [...(routes.find((route) => route.key === key)?.calls ?? [])]
    },
    close() {
      closing ??= new Promise<void>((closed) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => closed())
      })
      return closing
    },
  }
}
