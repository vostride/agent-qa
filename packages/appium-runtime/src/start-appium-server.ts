import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'

import treeKill from 'tree-kill'

import { prepareAppiumHome, removeAppiumHome } from './appium-home'
import { resolveBundledAppium } from './bundled-appium'

const LOOPBACK = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const KEPT_LINES = 10

export interface AppiumServer {
  // http://127.0.0.1 and the port the server listens on
  readonly url: string
  // Settles when the server process has ended, by stop() or on its own. Never rejects.
  readonly exited: Promise<void>
  // Settles once the process tree is killed, the child has closed and the prepared home is
  // removed. Never rejects. Safe to call twice.
  stop(): Promise<void>
}

interface ChildOutput {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
}

export interface AppiumChild {
  readonly pid?: number | undefined
  readonly stdout: ChildOutput | null
  readonly stderr: ChildOutput | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
}

export type AppiumSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => AppiumChild

export interface StartAppiumServerOptions {
  // Every chunk the server prints, for its whole life.
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  // The two seams a test passes fakes through; the defaults are the real spawn and the real probe.
  readonly spawn?: AppiumSpawn
  readonly probe?: (url: string) => Promise<boolean>
}

const spawnNode: AppiumSpawn = (command, args, options) => nodeSpawn(command, [...args], options)

function isAppiumReady(url: string): Promise<boolean> {
  return new Promise<boolean>((settle) => {
    const req = request(`${url}/status`, { method: 'GET', timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          settle(parsed?.value?.ready === true)
        } catch {
          settle(false)
        }
      })
    })
    req.on('error', () => settle(false))
    req.on('timeout', () => {
      req.destroy()
      settle(false)
    })
    req.end()
  })
}

// The port the system hands out on loopback, released at once.
function findFreePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const server = createServer()
    server.unref()
    server.once('error', fail)
    server.listen({ port: 0, host: LOOPBACK }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => settle(port))
    })
  })
}

// tree-kill lists the tree's processes before it signals any of them, so the tree is killed only
// once its callback runs. What the callback reports is not passed on.
function killTree(pid: number): Promise<void> {
  return new Promise((settle) => {
    treeKill(pid, 'SIGKILL', () => settle())
  })
}

export async function startAppiumServer(
  options: StartAppiumServerOptions = {},
): Promise<AppiumServer> {
  const spawn = options.spawn ?? spawnNode
  const probe = options.probe ?? isAppiumReady
  const { serverEntry, driverFolders } = resolveBundledAppium()
  const port = await findFreePort()
  const home = await prepareAppiumHome(driverFolders)
  const child = spawn(
    process.execPath,
    [
      serverEntry,
      '--address',
      LOOPBACK,
      '--port',
      String(port),
      '--relaxed-security',
      '--deny-insecure',
      '*:cors',
      '--log-no-colors',
    ],
    { env: { ...process.env, APPIUM_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const lastLines: string[] = []
  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    options.onOutput?.(text, stream)
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      lastLines.push(line)
      if (lastLines.length > KEPT_LINES) lastLines.shift()
    }
  }
  child.stdout?.on('data', forward('stdout'))
  child.stderr?.on('data', forward('stderr'))

  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
  })
  let closed = false
  const exited = new Promise<void>((settle) => {
    child.once('close', () => {
      closed = true
      settle()
    })
  })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (!closed && child.pid !== undefined) await killTree(child.pid)
      await exited
      await removeAppiumHome(home).catch(() => {})
    })()
    return stopping
  }

  const url = `http://${LOOPBACK}:${port}`
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await removeAppiumHome(home)
      throw spawnError
    }
    if (await probe(url)) return { url, exited, stop }
    await new Promise((settle) => setTimeout(settle, POLL_INTERVAL_MS))
  }

  await stop()
  const message = `Appium server did not become ready within ${STARTUP_TIMEOUT_MS}ms`
  throw new Error(lastLines.length > 0 ? `${message}\n${lastLines.join('\n')}` : message)
}
