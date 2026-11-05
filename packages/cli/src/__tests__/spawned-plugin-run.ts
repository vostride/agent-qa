// A spawned `agent-qa run` whose web test sits on a session leased from a scripted path plugin,
// parked in its first step by a model that never answers.

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateTestId } from '@vostride/agent-qa-ids'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
import type { ScriptedPluginInput } from '@vostride/agent-qa-plugin-kit/testing'

import { startRemoteBrowserEndpoint } from '../composition/__tests__/remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from '../composition/__tests__/remote-browser-endpoint.js'
import { removeTempRoots } from './temp-roots.js'

// Drives the built `dist/cli.js`, so a stale dist measures the previous build.
export const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js')

export const PARKED_BUDGET_MS = 90_000
const POLL_MS = 25

export type LedgerLine = Record<string, unknown> & { method: string }

export interface SpawnedRun {
  readonly child: ChildProcess
  output(): string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>
}

export interface PluginRunRig {
  readonly root: string
  readonly configPath: string
  readonly endpoint: RemoteBrowserEndpoint
  modelRequests(): number
  ledger(): LedgerLine[]
  // The plugin's pid, from its initialize line.
  pluginPid(): number | undefined
  // With `detached`, the run leads its own process group, as a terminal's foreground job does.
  spawnRun(options?: { detached?: boolean }): SpawnedRun
  close(): Promise<void>
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  return (server.address() as AddressInfo).port
}

function closeHttp(server: HttpServer): Promise<void> {
  server.closeAllConnections()
  return new Promise<void>((closed) => server.close(() => closed()))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function processGroupOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}

export async function until(
  what: string,
  check: () => boolean,
  budgetMs: number,
  run?: SpawnedRun,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (check()) return
    if (run !== undefined && (run.child.exitCode !== null || run.child.signalCode !== null)) {
      throw new Error(`the run exited before ${what}:\n${run.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}:\n${run?.output() ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

export interface PluginRunRigInput {
  readonly tmpdir: string
  // The scripted plugin's steps by method, such as a slow release.
  readonly script?: Record<string, unknown>
  // What the plugin declares beyond the required methods; nothing when absent.
  readonly methods?: ScriptedPluginInput['methods']
  readonly runFacts?: ScriptedPluginInput['runFacts']
}

export async function startPluginRunRig(input: PluginRunRigInput): Promise<PluginRunRig> {
  const closers: Array<() => Promise<void>> = []
  const children: ChildProcess[] = []
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-run-')))
  let pid: number | undefined

  const close = async (): Promise<void> => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL')
    for (const closer of closers.splice(0).reverse()) await closer()
    removeTempRoots([root])
  }

  try {
    const pages = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Held page</title><h1>Held page</h1><button>Go</button>')
    })
    closers.push(() => closeHttp(pages))
    const origin = `http://127.0.0.1:${String(await listen(pages))}`

    const held: ServerResponse[] = []
    let requests = 0
    const model = createHttpServer((_request, response) => {
      requests += 1
      held.push(response)
    })
    closers.push(async () => {
      for (const response of held.splice(0)) response.destroy()
      await closeHttp(model)
    })
    const modelBaseUrl = `http://127.0.0.1:${String(await listen(model))}/v1`

    const endpoint = await startRemoteBrowserEndpoint()
    closers.push(() => endpoint.close())

    writeScriptedPlugin(join(root, 'tools', 'lab'), {
      methods: input.methods ?? [],
      ...(input.runFacts === undefined ? {} : { runFacts: input.runFacts }),
    })
    const ledgerFile = join(root, 'plugin-ledger.jsonl')
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
        '    held:',
        '      platform: web',
        `      url: ${origin}/held`,
        '      environment: local',
        '      product: held-pages',
        '  llms:',
        '    - name: hanging',
        '      provider: openai-compatible',
        '      model: hanging-model',
        `      baseURL: ${modelBaseUrl}`,
        '  remotes:',
        '    - name: lab-chrome',
        '      plugin: lab',
        'plugins:',
        '  - name: lab',
        '    path: ./tools/lab',
        '    options:',
        `      ledgerFile: ${JSON.stringify(ledgerFile)}`,
        '      recordProcess: true',
        '      recordParams: true',
        ...(input.script === undefined ? [] : [`      script: ${JSON.stringify(input.script)}`]),
        '      answer:',
        '        protocol: playwright',
        `        url: ${JSON.stringify(endpoint.wsEndpoint)}`,
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
    writeFileSync(
      join(root, 'tests', 'held.yaml'),
      [
        `test-id: ${generateTestId()}`,
        'name: the held test',
        'target: held',
        'use:',
        '  browser:',
        '    remote: lab-chrome',
        'steps:',
        '  - Click the Go button',
        '',
      ].join('\n'),
    )

    const ledger = (): LedgerLine[] => {
      if (!existsSync(ledgerFile)) return []
      return readFileSync(ledgerFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LedgerLine)
    }

    return {
      root,
      configPath,
      endpoint,
      modelRequests: () => requests,
      ledger,
      pluginPid: () => {
        const recorded = ledger().find((line) => line.method === 'initialize')?.pid
        if (typeof recorded === 'number') pid = recorded
        return pid
      },
      spawnRun: (options = {}) => {
        const child = spawn(
          process.execPath,
          [CLI_DIST, '--config', configPath, 'run', 'tests/held.yaml'],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: root,
              TMPDIR: input.tmpdir,
              NODE_ENV: 'test',
              CI: 'true',
              NO_COLOR: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(options.detached === true ? { detached: true } : {}),
          },
        )
        children.push(child)
        let output = ''
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
        })
        child.stderr!.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
        })
        const exit = new Promise<{
          code: number | null
          signal: NodeJS.Signals | null
          at: number
        }>((settle, fail) => {
          child.once('error', fail)
          child.once('exit', (code, signal) => settle({ code, signal, at: Date.now() }))
        })
        return { child, output: () => output, exit }
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

// Waits until the run holds its leased page and has made its first model call.
export async function parked(rig: PluginRunRig, run: SpawnedRun): Promise<void> {
  await until(
    'the leased session and the first model call',
    () =>
      rig.ledger().some((line) => line.method === 'acquire') &&
      rig.endpoint.sessions() === 1 &&
      rig.modelRequests() > 0,
    PARKED_BUDGET_MS,
    run,
  )
}
