/// <reference lib="dom" />
// Shared shipped-binary lifecycle. Only the local model is scripted; recording, persistence,
// projection, HTTP serving and the dashboard bundle are the real production chain.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { generateTestId } from '@vostride/agent-qa-ids'
import { chromium, type Browser, type Page, type Worker } from 'playwright-core'
import {
  POPULATED_RUN_ANCHORED_BUILDS, RUN_BUDGET_MS, drivePopulatedRun,
  populatedRunFixtureProject, populatedRunSpawnEnv, startStubModelServer, startTargetPageServer,
  type PopulatedRunProject, type PopulatedRunDrive,
  POPULATED_SECRET_VALUE,
} from './populated-run-fixture.js'
import { buildFreshness, reserveEphemeralPort, spawnDashboard, type SpawnedDashboard } from './spawned-chat.js'

export interface RecordingFixture {
  browser: Browser
  project: PopulatedRunProject
  dashboard: SpawnedDashboard
  drive: PopulatedRunDrive
  close(): Promise<void>
}

export async function recordingFixture(label: string, recordingOff = false, layout = false, thirdMember = false): Promise<RecordingFixture> {
  if (process.platform === 'win32') throw new Error('POSIX dashboard lifecycle required; never skip')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required')
  const executable = chromium.executablePath()
  if (!existsSync(executable)) throw new Error('Playwright Chromium missing; never skip')
  let cache = dirname(executable)
  while (!readdirSync(cache).some(name => name.startsWith('ffmpeg-'))) {
    const parent = dirname(cache)
    if (parent === cache) throw new Error('Playwright ffmpeg missing; never skip')
    cache = parent
  }
  const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
  if (freshness.missing.length || freshness.stale.length) {
    throw new Error(`Run pnpm build before browser checks: ${JSON.stringify(freshness)}`)
  }
  const cleanup: Array<() => Promise<unknown>> = []
  const close = async () => {
    for (const stop of cleanup.reverse()) await stop().catch(() => undefined)
    cleanup.length = 0
  }
  try {
    const browser = await chromium.launch({ headless: true })
    cleanup.push(() => browser.close())
    const target = await startTargetPageServer()
    cleanup.push(() => target.close())
    let targetUrl = target.url
    if (layout) {
      const server = createServer((_req, res) => {
        if (_req.url === '/broken') { res.writeHead(503); res.end('Synthetic failure'); return }
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html lang="en"><title>Evidence layout probe</title><body>'
          + '<h1>Evidence layout probe</h1><label>Credential<input type="password" role="textbox" aria-label="Credential"></label>'
          + '<button onclick="console.error(\'Synthetic console error\'); fetch(\'/broken\')">Acknowledge</button>'
          + '<p>Local synthetic fixture only</p></body></html>')
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
      })
      cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No target port')
      targetUrl = `http://127.0.0.1:${address.port}`
    }
    const model = await startStubModelServer()
    cleanup.push(() => model.close())
    // The existing model emits one click. Keep its protocol and make every first click
    // non-terminal so the real runner records two decisions under the same parent step.
    let plannerCalls = 0
    const proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const upstream = await fetch(`${model.url}${req.url}`, {
          method: req.method, headers: { 'Content-Type': 'application/json' },
          body: Buffer.concat(chunks),
        })
        const body = await upstream.json() as {
          choices?: Array<{ message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>
        }
        const action = body.choices?.[0]?.message?.tool_calls?.[0]
        if (action) {
          const args = JSON.parse(action.function.arguments) as Record<string, unknown>
          args.stepComplete = ++plannerCalls % 2 === 0
          if (layout && plannerCalls % 2 === 1) {
            action.function.name = 'web_fill'
            delete args.ref
            args.target = { role: 'textbox', name: 'Credential' }
            args.elementDescription = 'Credential'
            args.text = POPULATED_SECRET_VALUE
          }
          action.function.arguments = JSON.stringify(args)
        }
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    cleanup.push(() => new Promise<void>(resolve => {
      proxy.closeAllConnections()
      proxy.close(() => resolve())
    }))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('No model proxy port')
    const project = populatedRunFixtureProject(label, {
      modelBaseUrl: `http://127.0.0.1:${address.port}/v1`, targetUrl,
    }, layout ? { stepText: 'Fill Credential then click Acknowledge', secondStepText: 'Fill Credential then click Acknowledge' } : {})
    if (layout) {
      const path = join(project.root, project.testPath)
      const test = parse(readFileSync(path, 'utf8'))
      test.steps = Array.from({ length: 6 }, (_, index) => `Fill Credential then click Acknowledge for round ${index + 1}`)
      writeFileSync(path, stringify(test))
    }
    if (thirdMember) {
      const test = parse(readFileSync(join(project.root, project.testPath), 'utf8'))
      test['test-id'] = generateTestId()
      test.name = 'The third recording probe'
      test.steps = ['Fill Credential then click Acknowledge']
      const path = 'tests/third-recording.yaml'
      writeFileSync(join(project.root, path), stringify(test))
      const suitePath = join(project.root, project.suitePath)
      const suite = parse(readFileSync(suitePath, 'utf8'))
      suite.tests.push({ test: path, id: test['test-id'] })
      writeFileSync(suitePath, stringify(suite))
    }
    if (recordingOff) {
      const config = JSON.parse(readFileSync(project.configPath, 'utf8'))
      config.services = { recording: { enabled: false } }
      writeFileSync(project.configPath, JSON.stringify(config))
    }
    const dashboard = await spawnDashboard(project.root, project.configPath,
      await reserveEphemeralPort(), 60_000, populatedRunSpawnEnv())
    cleanup.push(() => dashboard.stop())
    if (!dashboard.ready) throw new Error(`Dashboard did not start: ${dashboard.stderr()}`)
    const drive = await drivePopulatedRun(dashboard, project, RUN_BUDGET_MS)
    if (!drive.finished) throw new Error(`Run did not finish: ${drive.lastType}; ${dashboard.stderr()}`)
    return { browser, project, dashboard, drive, close }
  } catch (error) {
    await close()
    throw error
  }
}

export async function capture(page: Page, name: string) {
  const directory = process.env.AGENT_QA_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' })
}

/** How long the isolated zoom extension may take to see the tab the cell just navigated. */
export const FIXTURE_TAB_WAIT_MS = 30_000

// Find the tab by origin and path, because the run page rewrites its query after load.
export async function zoomFixtureTab(worker: Worker, url: string, factor: number): Promise<number> {
  return await worker.evaluate(async ({ url, factor, waitMs }) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: {
      query(query: { url?: string }): Promise<Array<{ id?: number; url?: string }>>
      setZoom(id: number, factor: number): Promise<void>
      getZoom(id: number): Promise<number>
    } } }).chrome.tabs
    const documentOf = (address: string): string => {
      const parsed = new URL(address)
      return `${parsed.origin}${parsed.pathname}`
    }
    const deadline = Date.now() + waitMs
    for (;;) {
      const tab = (await tabs.query({}))
        .find(entry => entry.url !== undefined && entry.url !== '' && documentOf(entry.url) === documentOf(url))
      if (tab?.id !== undefined) {
        await tabs.setZoom(tab.id, factor)
        return await tabs.getZoom(tab.id)
      }
      if (Date.now() >= deadline) {
        const seen = (await tabs.query({})).map(entry => entry.url ?? '<no url>')
        throw new Error(`The isolated extension found no fixture tab for ${url} within ${waitMs} ms; tabs seen: ${JSON.stringify(seen)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }, { url, factor, waitMs: FIXTURE_TAB_WAIT_MS })
}
