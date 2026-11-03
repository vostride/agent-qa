// A Playwright server on loopback behind a proxy that counts one session per WebSocket upgrade.
// With `requireHeader`, an upgrade without that header is answered 401 and never forwarded.

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
  /** Upgrades forwarded to the server. */
  sessions(): number
  /** Upgrades answered 401 for lacking the required header. */
  refusals(): number
  close(): Promise<void>
}

export interface RemoteBrowserEndpointOptions {
  readonly requireHeader?: readonly [name: string, value: string]
}

const WEBSOCKET_UPGRADE = /\r\nupgrade:\s*websocket\s*\r\n/i
const HEAD_END = '\r\n\r\n'

function carriesHeader(head: string, [name, value]: readonly [string, string]): boolean {
  return head
    .split('\r\n')
    .slice(1)
    .some((line) => {
      const colon = line.indexOf(':')
      return (
        colon > 0 &&
        line.slice(0, colon).trim().toLowerCase() === name.toLowerCase() &&
        line.slice(colon + 1).trim() === value
      )
    })
}

export async function startRemoteBrowserEndpoint(
  options: RemoteBrowserEndpointOptions = {},
): Promise<RemoteBrowserEndpoint> {
  refuseWithoutChromium()
  let server: BrowserServer | undefined
  let proxy: Server | undefined
  const sockets = new Set<Socket>()
  let sessions = 0
  let refusals = 0

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
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk])
        const text = head.toString('latin1')
        if (!text.includes(HEAD_END)) return
        client.off('data', onData)
        const upgrade = WEBSOCKET_UPGRADE.test(text)
        const required = options.requireHeader
        if (upgrade && required !== undefined && !carriesHeader(text, required)) {
          refusals += 1
          // The client closes once the 401 is out; closing the server leg must not cut it short.
          toServer.off('close', end).destroy()
          client.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        if (upgrade) sessions += 1
        toServer.write(head)
        client.pipe(toServer)
      }
      client.on('data', onData)
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
      refusals: () => refusals,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
