// Remote browsers on loopback: a Playwright server, a CDP Chromium, a session-counting proxy, a
// credential-checking proxy and services that refuse a connect.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer, STATUS_CODES } from 'node:http'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { dirname, join } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser, BrowserServer } from 'playwright-core'

export function refuseWithoutChromium(): void {
  if (!existsSync(chromium.executablePath())) {
    throw new Error('Playwright Chromium missing; never skip')
  }
}

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((closed) => server.close(() => closed()))
  return port
}

export interface PlaywrightServer {
  readonly wsEndpoint: string
  close(): Promise<void>
}

export async function startPlaywrightServer(): Promise<PlaywrightServer> {
  refuseWithoutChromium()
  let server: BrowserServer | undefined
  const close = async (): Promise<void> => {
    const running = server
    server = undefined
    await running?.close()
  }
  try {
    server = await chromium.launchServer({ host: '127.0.0.1' })
    return { wsEndpoint: server.wsEndpoint(), close }
  } catch (error) {
    await close()
    throw error
  }
}

export interface CdpBrowser {
  /** The DevTools HTTP endpoint, `http://127.0.0.1:<port>`. */
  readonly endpoint: string
  readonly port: number
  /** The browser as launched; closing it ends the process and removes its temporary profile. */
  readonly owner: Browser
  close(): Promise<void>
}

// Launched through Playwright, whose default switches keep the macOS keychain out of it.
export async function startCdpBrowser(): Promise<CdpBrowser> {
  refuseWithoutChromium()
  let owner: Browser | undefined
  const close = async (): Promise<void> => {
    const running = owner
    owner = undefined
    await running?.close()
  }
  try {
    const port = await freePort()
    owner = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${String(port)}`],
    })
    return { endpoint: `http://127.0.0.1:${String(port)}`, port, owner, close }
  } catch (error) {
    await close()
    throw error
  }
}

export interface CountingProxy {
  readonly port: number
  /** Connections whose first chunk asked for a WebSocket upgrade. */
  sessions(): number
  /** Every TCP connection the proxy accepted. */
  connections(): number
  close(): Promise<void>
}

const WEBSOCKET_UPGRADE = /\r\nupgrade:\s*websocket\s*\r\n/i

export async function startCountingProxy(targetPort: number): Promise<CountingProxy> {
  let proxy: Server | undefined
  const sockets = new Set<Socket>()
  let sessions = 0
  let connections = 0

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const open = proxy
    proxy = undefined
    if (open !== undefined) await new Promise<void>((closed) => open.close(() => closed()))
  }

  try {
    proxy = createServer((client) => {
      connections += 1
      const upstream = connect(targetPort, '127.0.0.1')
      sockets.add(client)
      sockets.add(upstream)
      const end = (): void => {
        client.destroy()
        upstream.destroy()
        sockets.delete(client)
        sockets.delete(upstream)
      }
      client.on('error', end).on('close', end)
      upstream.on('error', end).on('close', end)
      client.once('data', (chunk: Buffer) => {
        if (WEBSOCKET_UPGRADE.test(chunk.toString('latin1'))) sessions += 1
        upstream.write(chunk)
        client.pipe(upstream)
      })
      upstream.pipe(client)
    })
    const listening = proxy
    await new Promise<void>((ready, failed) => {
      listening.once('error', failed)
      listening.listen(0, '127.0.0.1', () => ready())
    })
    const { port } = listening.address() as AddressInfo
    return { port, sessions: () => sessions, connections: () => connections, close }
  } catch (error) {
    await close()
    throw error
  }
}

export interface LoopbackService {
  readonly port: number
  close(): Promise<void>
}

async function listenOnLoopback(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  return (server.address() as AddressInfo).port
}

// Answers every WebSocket upgrade and every plain request, DevTools discovery included, with one status.
export async function startStatusServer(
  status: number,
  body: string,
): Promise<LoopbackService> {
  const sockets = new Set<Socket>()
  const reason = STATUS_CODES[status] ?? 'Refused'
  const server = createHttpServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' })
    response.end(body)
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (_request, socket: Socket) => {
    const head = [
      `HTTP/1.1 ${String(status)} ${reason}`,
      'Content-Type: text/plain',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      'Connection: close',
    ]
    socket.end(`${head.join('\r\n')}\r\n\r\n${body}`)
  })
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
  try {
    return { port: await listenOnLoopback(server), close }
  } catch (error) {
    await close()
    throw error
  }
}

// Accepts connections and never answers, so a connect waits out its timeout.
export async function startSilentSocket(): Promise<LoopbackService> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
  })
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
  try {
    return { port: await listenOnLoopback(server), close }
  } catch (error) {
    await close()
    throw error
  }
}

export interface MismatchedRunServer {
  readonly wsEndpoint: string
  close(): Promise<void>
}

const RUN_SERVER_LISTENING = /Listening on (ws:\/\/\S+)/

// Playwright's own run-server, told it is another release, refuses this client's version.
export async function startMismatchedRunServer(): Promise<MismatchedRunServer> {
  const require = createRequire(import.meta.url)
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js')
  let child: ChildProcess | undefined
  const close = async (): Promise<void> => {
    const running = child
    child = undefined
    if (running === undefined || running.exitCode !== null || running.signalCode !== null) return
    await new Promise<void>((exited) => {
      running.once('exit', () => exited())
      running.kill('SIGKILL')
    })
  }
  try {
    const started = spawn(
      process.execPath,
      [cli, 'run-server', '--host', '127.0.0.1', '--port', '0'],
      { env: { ...process.env, PW_VERSION_OVERRIDE: '1.63.0' }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child = started
    const wsEndpoint = await new Promise<string>((listening, failed) => {
      let output = ''
      const timer = setTimeout(() => failed(new Error('run-server did not start')), 30_000)
      started.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const found = RUN_SERVER_LISTENING.exec(output)
        if (found?.[1] !== undefined) {
          clearTimeout(timer)
          listening(found[1])
        }
      })
      started.stderr?.resume()
      started.once('error', (error) => {
        clearTimeout(timer)
        failed(error)
      })
      started.once('exit', (code) => {
        clearTimeout(timer)
        failed(new Error(`run-server exited with ${String(code)}`))
      })
    })
    return { wsEndpoint, close }
  } catch (error) {
    await close()
    throw error
  }
}

export interface CredentialExpectation {
  /** Header values by lower-case name. */
  readonly headers?: Readonly<Record<string, string>>
  /** Decoded query values by name. */
  readonly query?: Readonly<Record<string, string>>
}

export interface RecordedUpgrade {
  /** The request line as sent, query included. */
  readonly requestLine: string
  /** The path and query as sent. */
  readonly url: string
  /** Header values by lower-case name. */
  readonly headers: Readonly<Record<string, string>>
}

export interface CredentialCheckingProxy {
  readonly port: number
  /** Every upgrade request the proxy received, accepted or not. */
  requests(): readonly RecordedUpgrade[]
  close(): Promise<void>
}

function meetsExpectation(request: RecordedUpgrade, expected: CredentialExpectation): boolean {
  const query = new URL(request.url, 'http://127.0.0.1').searchParams
  const headers = Object.entries(expected.headers ?? {})
  const values = Object.entries(expected.query ?? {})
  return (
    headers.every(([name, value]) => request.headers[name] === value) &&
    values.every(([name, value]) => query.get(name) === value)
  )
}

function upgradeHead(request: IncomingMessage): string {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`]
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index] ?? ''}: ${request.rawHeaders[index + 1] ?? ''}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

// Lets a WebSocket upgrade through to the target only when its headers and query match.
export async function startCredentialCheckingProxy(options: {
  target: number
  expect: CredentialExpectation
}): Promise<CredentialCheckingProxy> {
  const sockets = new Set<Socket>()
  const recorded: RecordedUpgrade[] = []
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
  }
  const server = createHttpServer((_request, response) => {
    response.writeHead(404, { connection: 'close' })
    response.end()
  })
  server.on('connection', track)
  server.on('upgrade', (request: IncomingMessage, client: Socket, head: Buffer) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const url = request.url ?? '/'
    const upgrade = {
      requestLine: `${request.method ?? 'GET'} ${url} HTTP/${request.httpVersion}`,
      url,
      headers,
    }
    recorded.push(upgrade)
    if (!meetsExpectation(upgrade, options.expect)) {
      client.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = connect(options.target, '127.0.0.1')
    track(upstream)
    const end = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('close', end)
    upstream.on('close', end)
    upstream.write(upgradeHead(request))
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
  try {
    return { port: await listenOnLoopback(server), requests: () => [...recorded], close }
  } catch (error) {
    await close()
    throw error
  }
}
