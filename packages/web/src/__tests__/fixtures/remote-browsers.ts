// Remote browsers on loopback: a Playwright server, a CDP Chromium and a session-counting proxy.

import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

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
  close(): Promise<void>
}

const WEBSOCKET_UPGRADE = /\r\nupgrade:\s*websocket\s*\r\n/i

export async function startCountingProxy(targetPort: number): Promise<CountingProxy> {
  let proxy: Server | undefined
  const sockets = new Set<Socket>()
  let sessions = 0

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const open = proxy
    proxy = undefined
    if (open !== undefined) await new Promise<void>((closed) => open.close(() => closed()))
  }

  try {
    proxy = createServer((client) => {
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
    return { port, sessions: () => sessions, close }
  } catch (error) {
    await close()
    throw error
  }
}
