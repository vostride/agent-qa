// A Playwright server on loopback behind a proxy that counts one session per WebSocket upgrade.

import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { chromium } from 'playwright-core'
import type { BrowserServer } from 'playwright-core'

export function refuseWithoutChromium(): void {
  if (!existsSync(chromium.executablePath())) throw new Error('Playwright Chromium missing; never skip')
}

export interface RemoteBrowserEndpoint {
  /** The proxy's ws URL, carrying the server's own path. */
  readonly wsEndpoint: string
  /** Connections whose first chunk asked for a WebSocket upgrade. */
  sessions(): number
  close(): Promise<void>
}

const WEBSOCKET_UPGRADE = /\r\nupgrade:\s*websocket\s*\r\n/i

export async function startRemoteBrowserEndpoint(): Promise<RemoteBrowserEndpoint> {
  refuseWithoutChromium()
  let server: BrowserServer | undefined
  let proxy: Server | undefined
  const sockets = new Set<Socket>()
  let sessions = 0

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const open = proxy
    proxy = undefined
    if (open !== undefined) await new Promise<void>((closed) => open.close(() => closed()))
    const running = server
    server = undefined
    await running?.close()
  }

  try {
    server = await chromium.launchServer({ host: '127.0.0.1' })
    const upstream = new URL(server.wsEndpoint())
    const upstreamPort = Number(upstream.port)
    proxy = createServer((client) => {
      const toServer = connect(upstreamPort, '127.0.0.1')
      sockets.add(client)
      sockets.add(toServer)
      const end = (): void => {
        client.destroy()
        toServer.destroy()
        sockets.delete(client)
        sockets.delete(toServer)
      }
      client.on('error', end).on('close', end)
      toServer.on('error', end).on('close', end)
      client.once('data', (chunk: Buffer) => {
        if (WEBSOCKET_UPGRADE.test(chunk.toString('latin1'))) sessions += 1
        toServer.write(chunk)
        client.pipe(toServer)
      })
      toServer.pipe(client)
    })
    const listening = proxy
    await new Promise<void>((ready, failed) => {
      listening.once('error', failed)
      listening.listen(0, '127.0.0.1', () => ready())
    })
    const { port } = listening.address() as AddressInfo
    return {
      wsEndpoint: `ws://127.0.0.1:${String(port)}${upstream.pathname}`,
      sessions: () => sessions,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
