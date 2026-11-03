import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn().mockReturnValue({ modelId: 'test-model' }),
}))

import { REMOTE_RELEASE_BOUND_MS, createRemoteSessionRegistry } from '@vostride/agent-qa-runner'
import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { SessionManager } from '../session-manager.js'
import type { LiveSessionConfig } from '../types.js'

interface PlaywrightServerLauncher {
  chromium: {
    executablePath(): string
    launchServer(options: {
      host: string
    }): Promise<{ wsEndpoint(): string; close(): Promise<void> }>
  }
}

// Playwright comes from the web adapter's own install, the same build the session drives.
const playwright = createRequire(createRequire(import.meta.url).resolve('@vostride/agent-qa-web'))(
  'playwright-core',
) as PlaywrightServerLauncher

interface CountedEndpoint {
  readonly wsEndpoint: string
  open(): number
  close(): Promise<void>
}

// A Playwright server on loopback behind a proxy that counts the client connections still open.
async function startCountedEndpoint(): Promise<CountedEndpoint> {
  if (!existsSync(playwright.chromium.executablePath())) {
    throw new Error('Playwright Chromium missing; never skip')
  }
  const server = await playwright.chromium.launchServer({ host: '127.0.0.1' })
  const upstream = new URL(server.wsEndpoint())
  const sockets = new Set<Socket>()
  let open = 0
  const proxy: Server = createServer((client) => {
    open += 1
    const toServer = connect(Number(upstream.port), '127.0.0.1')
    sockets.add(client).add(toServer)
    let ended = false
    const end = (): void => {
      if (!ended) {
        ended = true
        open -= 1
      }
      client.destroy()
      toServer.destroy()
    }
    client.on('error', end).on('close', end)
    toServer.on('error', end).on('close', end)
    client.pipe(toServer)
    toServer.pipe(client)
  })
  await new Promise<void>((ready) => proxy.listen(0, '127.0.0.1', () => ready()))
  const { port } = proxy.address() as AddressInfo
  return {
    wsEndpoint: `ws://127.0.0.1:${String(port)}${upstream.pathname}`,
    open: () => open,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((closed) => proxy.close(() => closed()))
      await server.close()
    },
  }
}

function sessionConfig(remote: RemoteBrowserConfig): LiveSessionConfig {
  return {
    platform: 'web',
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1/',
    },
    headless: true,
    remote,
  }
}

describe("a live-editor session's remote when the dashboard shuts down", () => {
  let endpoint: CountedEndpoint | undefined
  let manager: SessionManager | undefined

  afterEach(async () => {
    await manager?.cleanupAll()
    manager = undefined
    await endpoint?.close()
    endpoint = undefined
  })

  it("is released by the host's registry while the session is still open", async () => {
    endpoint = await startCountedEndpoint()
    const remoteSessions = createRemoteSessionRegistry()
    manager = new SessionManager({ remoteSessions })
    await manager.createSession(
      sessionConfig({
        name: 'grid',
        protocol: 'playwright',
        url: endpoint.wsEndpoint,
        connectTimeoutMs: 30_000,
      }),
    )
    expect(endpoint.open()).toBe(1)

    const started = Date.now()
    await remoteSessions.releaseAll(REMOTE_RELEASE_BOUND_MS)
    await vi.waitFor(() => {
      expect(endpoint?.open()).toBe(0)
    })
    expect(Date.now() - started).toBeLessThan(REMOTE_RELEASE_BOUND_MS)
    expect(manager.size).toBe(1)

    await manager.cleanupAll()
    expect(manager.size).toBe(0)
  }, 60_000)
})
