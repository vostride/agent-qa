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
  // Settles once the server process has ended, by stop() or on its own, and the prepared home
  // is removed. Never rejects.
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
  const withLastLines = (message: string): string => [message, ...lastLines].join('\n')

  let removed: Promise<void> | undefined
  const removeHome = (): Promise<void> => (removed ??= removeAppiumHome(home).catch(() => {}))

  let wake = (): void => {}
  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
    wake()
  })
  let closedBy: string | undefined
  const exited = new Promise<void>((settle) => {
    child.once('close', (code, signal) => {
      closedBy = signal === null ? `exit code ${code}` : `signal ${signal}`
      wake()
      settle()
    })
  }).then(removeHome)
  const ended = (): boolean => spawnError !== undefined || closedBy !== undefined
  const pause = (): Promise<void> =>
    new Promise((settle) => {
      if (ended()) return settle()
      const timer = setTimeout(settle, POLL_INTERVAL_MS)
      wake = () => {
        clearTimeout(timer)
        settle()
      }
    })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (closedBy === undefined && child.pid !== undefined) await killTree(child.pid)
      await exited
    })()
    return stopping
  }

  const url = `http://${LOOPBACK}:${port}`
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (!ended() && Date.now() < deadline) {
    // Once the child has ended, whatever answers on its port is another process.
    if ((await probe(url)) && !ended()) return { url, exited, stop }
    await pause()
  }

  if (spawnError !== undefined) {
    await removeHome()
    throw spawnError
  }
  if (closedBy !== undefined) {
    await exited
    throw new Error(withLastLines(`Appium exited before it was ready (${closedBy})`))
  }
  await stop()
  throw new Error(
    withLastLines(`Appium server did not become ready within ${STARTUP_TIMEOUT_MS}ms`),
  )
}
