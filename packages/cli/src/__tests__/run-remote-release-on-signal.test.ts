// A spawned `agent-qa run` holds a page on a CDP browser this test owns, parked in its first step.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer, ServerResponse } from 'node:http'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateTestId } from '@vostride/agent-qa-ids'
import { chromium } from 'playwright-core'
import type { Browser, CDPSession } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

// Drives the built `dist/cli.js`, so a stale dist measures the previous build.
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js')

// The CLI's cancel grace: a release that is not done by then is not done before the process ends.
const CANCEL_GRACE_MS = 3_000
const PARKED_BUDGET_MS = 90_000
const POLL_MS = 25
const CELL_BUDGET_MS = 180_000

const WEBSOCKET_UPGRADE = /\r\nupgrade:\s*websocket\s*\r\n/i
const WEBSOCKET_CLOSE_OPCODE = 0x8

interface Closable {
  close(): Promise<void>
}

const openRigs: Closable[] = []
const children: ChildProcess[] = []
const roots: string[] = []
let pinnedTmpdir: PinnedTmpdir | undefined

beforeAll(() => {
  if (process.platform === 'win32') throw new Error('POSIX signals required; never skip')
  if (!existsSync(chromium.executablePath())) {
    throw new Error('Playwright Chromium missing; never skip')
  }
  if (!existsSync(CLI_DIST)) throw new Error(`No built CLI at ${CLI_DIST}; run pnpm build`)
  pinnedTmpdir = pinProcessTmpdir()
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const rig of openRigs.splice(0).reverse()) await rig.close()
  removeTempRoots(roots.splice(0))
})

afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((closed) => server.close(() => closed()))
  return port
}

function closeHttp(server: HttpServer): Promise<void> {
  server.closeAllConnections()
  return new Promise<void>((closed) => server.close(() => closed()))
}

interface CdpOwner {
  readonly endpoint: string
  readonly port: number
  // Pages of the target page server, wherever they were opened from.
  pagesAt(origin: string): Promise<string[]>
  versionStatus(): Promise<number>
}

// Started with Playwright's own launch, whose default switches keep the macOS keychain out of it.
async function startCdpOwner(): Promise<CdpOwner> {
  const port = await freePort()
  let owner: Browser | undefined
  openRigs.push({
    close: async () => {
      await owner?.close()
    },
  })
  owner = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${String(port)}`],
  })
  const session: CDPSession = await owner.newBrowserCDPSession()
  const endpoint = `http://127.0.0.1:${String(port)}`
  return {
    endpoint,
    port,
    pagesAt: async (origin) => {
      const { targetInfos } = await session.send('Target.getTargets')
      return targetInfos
        .filter((target) => target.type === 'page' && target.url.startsWith(origin))
        .map((target) => target.url)
    },
    versionStatus: async () => (await fetch(`${endpoint}/json/version`)).status,
  }
}

interface TargetPages {
  readonly origin: string
}

async function startTargetPages(): Promise<TargetPages> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Held page</title><h1>Held page</h1><button>Go</button>')
  })
  openRigs.push({ close: () => closeHttp(server) })
  const port = await listen(server)
  return { origin: `http://127.0.0.1:${String(port)}` }
}

interface HangingModel {
  readonly baseUrl: string
  requests(): number
}

// Accepts every request and never answers, so each test stays parked in its first step.
async function startHangingModel(): Promise<HangingModel> {
  const held: ServerResponse[] = []
  let requests = 0
  const server = createHttpServer((_request, response) => {
    requests += 1
    held.push(response)
  })
  openRigs.push({
    close: async () => {
      for (const response of held.splice(0)) response.destroy()
      await closeHttp(server)
    },
  })
  const port = await listen(server)
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, requests: () => requests }
}

interface ForwardingProxy {
  readonly endpoint: string
  closeFrames(): number
  // Stops forwarding both ways and keeps every socket open, so the remote goes silent.
  blackhole(): void
}

// Counts the WebSocket close frames a client sends after its upgrade.
function closeFrameReader(onClose: () => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0)
  let upgraded = false
  return (chunk) => {
    pending = Buffer.concat([pending, chunk])
    if (!upgraded) {
      const headersEnd = pending.indexOf('\r\n\r\n')
      if (headersEnd < 0) return
      if (!WEBSOCKET_UPGRADE.test(pending.subarray(0, headersEnd + 4).toString('latin1'))) {
        pending = Buffer.alloc(0)
        return
      }
      upgraded = true
      pending = pending.subarray(headersEnd + 4)
    }
    for (;;) {
      if (pending.length < 2) return
      const opcode = pending[0]! & 0x0f
      let length = pending[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        length = Number(pending.readBigUInt64BE(2))
        offset = 10
      }
      if ((pending[1]! & 0x80) !== 0) offset += 4
      if (pending.length < offset + length) return
      if (opcode === WEBSOCKET_CLOSE_OPCODE) onClose()
      pending = pending.subarray(offset + length)
    }
  }
}

async function startForwardingProxy(targetPort: number): Promise<ForwardingProxy> {
  const sockets = new Set<Socket>()
  let closeFrames = 0
  let silent = false
  const proxy = createServer((client) => {
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
    const readFrames = closeFrameReader(() => {
      closeFrames += 1
    })
    client.on('data', (chunk: Buffer) => {
      readFrames(chunk)
      if (!silent) upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => {
      if (!silent) client.write(chunk)
    })
  })
  openRigs.push({
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((closed) => proxy.close(() => closed()))
    },
  })
  const port = await listen(proxy)
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    closeFrames: () => closeFrames,
    blackhole: () => {
      silent = true
    },
  }
}

interface ProjectTest {
  readonly file: string
  readonly path: string
  readonly remote: string
}

interface Project {
  readonly root: string
  readonly configPath: string
}

function writeProject(input: {
  readonly origin: string
  readonly modelBaseUrl: string
  readonly remotes: Readonly<Record<string, string>>
  readonly tests: readonly ProjectTest[]
}): Project {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remote-release-')))
  roots.push(root)
  mkdirSync(join(root, 'tests'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      ...input.tests.flatMap((test) => [
        `    ${test.file}:`,
        '      platform: web',
        `      url: ${input.origin}${test.path}`,
        '      environment: local',
        '      product: held-pages',
      ]),
      '  llms:',
      '    - name: hanging',
      '      provider: openai-compatible',
      '      model: hanging-model',
      `      baseURL: ${input.modelBaseUrl}`,
      '  remotes:',
      ...Object.entries(input.remotes).flatMap(([name, url]) => [
        `    - name: ${name}`,
        '      protocol: cdp',
        `      url: ${JSON.stringify(url)}`,
      ]),
      'use:',
      '  browser:',
      '    name: chromium',
      '    headless: true',
      '  llm: hanging',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, '.env.secrets.local'), '')
  for (const test of input.tests) {
    writeFileSync(
      join(root, 'tests', `${test.file}.yaml`),
      [
        `test-id: ${generateTestId()}`,
        `name: the ${test.file} test`,
        `target: ${test.file}`,
        'use:',
        '  browser:',
        `    remote: ${test.remote}`,
        'steps:',
        '  - Click the Go button',
        '',
      ].join('\n'),
    )
  }
  return { root, configPath }
}

interface SpawnedRun {
  readonly child: ChildProcess
  output(): string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>
}

function spawnRun(project: Project, args: readonly string[]): SpawnedRun {
  const argv = [CLI_DIST, '--config', project.configPath, 'run', ...args]
  const child = spawn(process.execPath, argv, {
    cwd: project.root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: project.root,
      TMPDIR: pinnedTmpdir!.root,
      NODE_ENV: 'test',
      CI: 'true',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
    (settle, fail) => {
      child.once('error', fail)
      child.once('exit', (code, signal) => settle({ code, signal, at: Date.now() }))
    },
  )
  return { child, output: () => output, exit }
}

async function until(
  what: string,
  check: () => Promise<boolean>,
  budgetMs: number,
  run: SpawnedRun,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await check()) return
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`the run exited before ${what}:\n${run.output()}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${run.output()}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

// The first moment at or after now that `check` holds, or undefined once the budget is spent.
async function firstTime(
  check: () => Promise<boolean>,
  budgetMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await check()) return Date.now()
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

describe('agent-qa run releases remote sessions on a signal', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`on ${signal}, the run's remote page is gone within the grace and the CDP service still answers`, async () => {
      const owner = await startCdpOwner()
      const pages = await startTargetPages()
      const model = await startHangingModel()
      const project = writeProject({
        origin: pages.origin,
        modelBaseUrl: model.baseUrl,
        remotes: { owner: owner.endpoint },
        tests: [{ file: 'held', path: '/held', remote: 'owner' }],
      })

      const run = spawnRun(project, ['tests/held.yaml'])
      const heldPage = `${pages.origin}/held`
      await until(
        'its page on the remote and its first model call',
        async () => (await owner.pagesAt(heldPage)).length === 1 && model.requests() > 0,
        PARKED_BUDGET_MS,
        run,
      )

      const signalledAt = Date.now()
      run.child.kill(signal)
      const goneAt = await firstTime(
        async () => (await owner.pagesAt(heldPage)).length === 0,
        CANCEL_GRACE_MS,
      )
      const exited = await run.exit

      expect(goneAt, run.output()).toBeDefined()
      expect(goneAt! - signalledAt, run.output()).toBeLessThan(CANCEL_GRACE_MS)
      expect(exited.at - signalledAt, run.output()).toBeLessThan(CANCEL_GRACE_MS)
      expect({ code: exited.code, signal: exited.signal }, run.output()).toEqual({
        code: 130,
        signal: null,
      })
      expect(await owner.versionStatus()).toBe(200)
    }, CELL_BUDGET_MS)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`on ${signal}, a silent remote and a healthy one are both released at once, and the run exits within the grace`, async () => {
      const owner = await startCdpOwner()
      const pages = await startTargetPages()
      const model = await startHangingModel()
      const healthy = await startForwardingProxy(owner.port)
      const silent = await startForwardingProxy(owner.port)
      const project = writeProject({
        origin: pages.origin,
        modelBaseUrl: model.baseUrl,
        remotes: { healthy: healthy.endpoint, silent: silent.endpoint },
        tests: [
          { file: 'healthy', path: '/healthy', remote: 'healthy' },
          { file: 'silent', path: '/silent', remote: 'silent' },
        ],
      })

      const run = spawnRun(project, [
        '--parallel',
        '--workers',
        '2',
        'tests/healthy.yaml',
        'tests/silent.yaml',
      ])
      const healthyPage = `${pages.origin}/healthy`
      const silentPage = `${pages.origin}/silent`
      await until(
        'both pages on their remotes and both first model calls',
        async () =>
          (await owner.pagesAt(healthyPage)).length === 1 &&
          (await owner.pagesAt(silentPage)).length === 1 &&
          model.requests() > 1,
        PARKED_BUDGET_MS,
        run,
      )

      silent.blackhole()
      const signalledAt = Date.now()
      run.child.kill(signal)
      const goneAt = await firstTime(
        async () => (await owner.pagesAt(healthyPage)).length === 0,
        CANCEL_GRACE_MS,
      )
      const exited = await run.exit

      expect(goneAt, run.output()).toBeDefined()
      expect(goneAt! - signalledAt, run.output()).toBeLessThan(CANCEL_GRACE_MS)
      expect(healthy.closeFrames(), run.output()).toBe(1)
      expect(silent.closeFrames(), run.output()).toBe(1)
      expect(exited.at - signalledAt, run.output()).toBeLessThan(CANCEL_GRACE_MS)
      expect({ code: exited.code, signal: exited.signal }, run.output()).toEqual({
        code: 130,
        signal: null,
      })
      expect(await owner.versionStatus()).toBe(200)
    }, CELL_BUDGET_MS)
  }
})
