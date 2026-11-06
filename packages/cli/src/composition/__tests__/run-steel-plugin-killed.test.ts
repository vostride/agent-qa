// A built agent-qa run holds a Steel session from the built Steel plugin, parked in its first
// step by a model that never answers, and is killed with SIGKILL. The plugin sees agent-qa go and
// sends POST /v1/sessions/{id}/release to the fake Steel API on its own.

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { CLI_DIST, until } from '../../__tests__/spawned-plugin-run.js'
import type { SpawnedRun } from '../../__tests__/spawned-plugin-run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { startTargetPageServer } from '../../__tests__/conformance/populated-run-fixture.js'
import { linkBuiltPlugin, pluginTestModule } from './first-party-plugin-project.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { refuseWithoutChromium } from './remote-browser-endpoint.js'

interface FakeSteelApi {
  readonly url: string
  routeCalls(key: string): ReadonlyArray<{ readonly params: Record<string, string> }>
  createdIds(): string[]
  close(): Promise<void>
}

interface CdpBrowser {
  readonly endpoint: string
  close(): Promise<void>
}

const { startFakeSteelApi } = (await import(pluginTestModule('steel', 'fake-steel-api.js'))) as {
  startFakeSteelApi: (input: { cdpUrl: string }) => Promise<FakeSteelApi>
}

const { startCdpBrowser } = (await import(
  new URL('../../../../web/src/__tests__/fixtures/remote-browsers.js', import.meta.url).href
)) as { startCdpBrowser: () => Promise<CdpBrowser> }

const PARKED_BUDGET_MS = 90_000
const RELEASE_BUDGET_MS = 10_000
const CELL_BUDGET_MS = 180_000
const REMOTE_NAME = 'steel-chrome'
const ENTRY_NAME = 'steel'
const KEY_NAME = 'STEEL_API_KEY'
const RELEASE_ROUTE = 'POST /v1/sessions/:id/release'

const opened: Array<() => Promise<void> | void> = []

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  refuseWithoutChromium()
  if (!existsSync(CLI_DIST)) throw new Error(`No built CLI at ${CLI_DIST}; run pnpm build`)
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close()
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

interface HangingModel {
  readonly baseUrl: string
  requests(): number
}

async function startHangingModel(): Promise<HangingModel> {
  const held: ServerResponse[] = []
  let requests = 0
  const server: Server = createServer((_request, response) => {
    requests += 1
    held.push(response)
  })
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  opened.push(async () => {
    for (const response of held.splice(0)) response.destroy()
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  })
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, requests: () => requests }
}

// Every process whose arguments name this project's linked plugin entry.
function pluginPids(entryFile: string): number[] {
  return execFileSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(entryFile))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
}

function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

// SIGKILL and a process's pid going away are POSIX; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')('agent-qa run killed with SIGKILL mid-test', () => {
  it('still has the built Steel plugin release its session at the vendor, and leaves no plugin process', async () => {
    const page = await startTargetPageServer()
    opened.push(() => page.close())
    const cdp = await startCdpBrowser()
    opened.push(() => cdp.close())
    const api = await startFakeSteelApi({ cdpUrl: cdp.endpoint })
    opened.push(() => api.close())
    const model = await startHangingModel()
    const released = (): string[] =>
      api.routeCalls(RELEASE_ROUTE).map(({ params }) => params.id ?? '')

    const project = createInProcessFixture({
      origin: page.url,
      environment: 'local',
      stepText: 'Click the Acknowledge button',
      model: { baseUrl: model.baseUrl, id: 'hanging-model' },
      remote: { name: REMOTE_NAME, protocol: 'cdp', url: cdp.endpoint },
      extraSecrets: { [KEY_NAME]: 'ste_killed_7a2d94e1c6' },
    })
    const { packageName, entryFile } = linkBuiltPlugin(project.project, 'steel')
    const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
      registry: { remotes?: unknown }
      plugins?: unknown
    }
    config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
    config.plugins = [
      {
        name: ENTRY_NAME,
        package: packageName,
        options: { apiKey: `{{secret:${KEY_NAME}}}`, apiUrl: api.url },
      },
    ]
    writeFileSync(project.configPath, stringifyYaml(config))
    opened.push(() => killAll(pluginPids(entryFile)))

    const child: ChildProcess = spawn(
      process.execPath,
      [CLI_DIST, '--config', project.configPath, 'run', project.testPattern],
      {
        cwd: project.project,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: freshUpdateCheckHome(),
          TMPDIR: pinnedTmpdir!.root,
          NODE_ENV: 'test',
          CI: 'true',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    opened.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const exited = new Promise<NodeJS.Signals | null>((settle, fail) => {
      child.once('error', fail)
      child.once('exit', (_code, signal) => settle(signal))
    })
    const run: SpawnedRun = {
      child,
      output: () => output,
      exit: exited.then((signal) => ({ code: child.exitCode, signal, at: Date.now() })),
    }

    await until(
      'the Steel session and the first model call',
      () => api.createdIds().length === 1 && model.requests() > 0,
      PARKED_BUDGET_MS,
      run,
    )
    const [created] = api.createdIds()
    expect(released(), output).toEqual([])
    expect(pluginPids(entryFile), output).toHaveLength(1)

    const killedAt = Date.now()
    child.kill('SIGKILL')
    expect(await exited).toBe('SIGKILL')

    await until(
      'the plugin to release the Steel session and exit',
      () => released().length > 0 && pluginPids(entryFile).length === 0,
      RELEASE_BUDGET_MS,
    )
    expect(Date.now() - killedAt, output).toBeLessThan(RELEASE_BUDGET_MS)
    expect(released(), output).toEqual([created])
  }, CELL_BUDGET_MS)
})
