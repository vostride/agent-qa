// Runs only with the live-model env set; an ambiguous step must fail without clicking a button.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const LIVE = process.env.AGENT_QA_438_LIVE_MODEL === '1'
const AUTH_PLUGIN = process.env.AGENT_QA_438_LIVE_AUTH_PLUGIN
const LLM = process.env.AGENT_QA_438_LIVE_LLM ?? 'gpt-6.1-sol'
const PROVIDER = 'openai-subscription'

/** packages/cli/src/__tests__ -> packages/cli/dist/cli.js */
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js')

const CELL_TIMEOUT = 15 * 60_000

const TWO_OKAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Confirm</title></head><body>
  <p>Please confirm.</p>
  <div>
    <button type="button" onclick="fetch('/click?n=1', { cache: 'no-store', keepalive: true })">Okay</button>
    <button type="button" onclick="fetch('/click?n=2', { cache: 'no-store', keepalive: true })">Okay</button>
  </div>
</body></html>`

let server: Server
let origin: string
const clicks: string[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/click') {
      clicks.push(url.searchParams.get('n') ?? '?')
      response.writeHead(204).end()
      return
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(TWO_OKAY_PAGE)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()))
})

function configYaml(): string {
  return [
    'workspace:',
    '  testMatch:',
    "    - 'tests/**/*.yaml'",
    '  suiteMatch:',
    "    - 'suites/**/*.suite.yaml'",
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  llms:',
    `    - name: ${JSON.stringify(LLM)}`,
    `      provider: ${PROVIDER}`,
    `      model: ${JSON.stringify(LLM)}`,
    '  targets:',
    '    okay-page:',
    '      platform: web',
    `      url: ${origin}/`,
    '      environment: local',
    'plugins:',
    '  auth:',
    `    - path: ${JSON.stringify(AUTH_PLUGIN ?? '')}`,
    'use:',
    '  browser:',
    '    name: chromium',
    '    headless: true',
    '  mobile:',
    '    appState: preserve',
    '  timeout:',
    '    step: 5m',
    '    test: 10m',
    '    navigation: 2m',
    '  parallel: false',
    `  llm: ${JSON.stringify(LLM)}`,
    '',
  ].join('\n')
}

function coldWorkspace(step: string): string {
  const project = mkdtempSync(join(tmpdir(), 'auto15-live-'))
  mkdirSync(join(project, 'tests'), { recursive: true })
  writeFileSync(join(project, 'agent-qa.config.yaml'), configYaml())
  writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project, '.env'), '')
  writeFileSync(join(project, '.env.secrets.local'), '')
  writeFileSync(
    join(project, 'tests', 'okay.yaml'),
    [
      `test-id: ${generateTestId()}`,
      `name: ${JSON.stringify(step)}`,
      'target: okay-page',
      'steps:',
      `  - ${JSON.stringify(step)}`,
      '',
    ].join('\n'),
  )
  return project
}

// Only what a run needs; nothing from the test process (NODE_ENV, AGENT_QA_*) leaks in.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    AGENT_QA_DEBUG_LLM: '1',
    NO_COLOR: '1',
  }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_DATA_HOME']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

interface LiveRun {
  status: number | null
  stderr: string
  handoff?: {
    tests?: {
      outcome?: string
      steps?: {
        verifierVerdict?: { pass?: boolean; reasoning?: string }
        termination?: { kind?: string; reason?: string }
        subActions?: { result?: { success?: boolean; error?: string } }[]
      }[]
    }[]
  }
  respondingModelIds: string[]
}

async function runLive(step: string): Promise<LiveRun> {
  const project = coldWorkspace(step)
  try {
    const child = spawn(
      process.execPath,
      [CLI_DIST, 'run', 'tests/okay.yaml', '--headless', '--disable-cache', '--detach', '--excluded-from-outcomes'],
      { cwd: project, env: childEnv() },
    )
    let stderr = ''
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const status = await new Promise<number | null>((settle, fail) => {
      child.on('error', fail)
      child.on('close', (code) => settle(code))
    })

    const runsDir = join(project, '.agent-qa', 'runs')
    const runs = existsSync(runsDir) ? readdirSync(runsDir) : []
    const handoffPath = runs.length === 1 ? join(runsDir, runs[0], 'handoff.json') : undefined
    const eventsPath = runs.length === 1 ? join(runsDir, runs[0], 'events.jsonl') : undefined
    const handoff = handoffPath !== undefined && existsSync(handoffPath)
      ? (JSON.parse(readFileSync(handoffPath, 'utf8')) as LiveRun['handoff'])
      : undefined
    const respondingModelIds = new Set<string>()
    if (eventsPath !== undefined && existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const event = JSON.parse(line) as {
          type?: string
          payload?: { modelUsage?: { roles?: Record<string, { respondingModelIds?: string[] }> } }
        }
        if (event.type !== 'stepFinalized') continue
        for (const role of Object.values(event.payload?.modelUsage?.roles ?? {})) {
          for (const id of role.respondingModelIds ?? []) respondingModelIds.add(id)
        }
      }
    }
    return { status, stderr, handoff, respondingModelIds: [...respondingModelIds] }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

function requestedModels(stderr: string): string[] {
  const models = new Set<string>()
  for (const match of stderr.matchAll(/\[agent-qa:llm\] request model=(\S+)/g)) models.add(match[1])
  return [...models]
}

function runReading(run: LiveRun, clicked: readonly string[]): string {
  const test = run.handoff?.tests?.[0]
  const step = test?.steps?.[0]
  const lastError = step?.subActions?.map((sub) => sub.result?.error).filter(Boolean).at(-1)
  const reading =
    `exit=${String(run.status)} configured=${LLM}`
    + ` requested=[${requestedModels(run.stderr).join(',')}]`
    + ` responding=[${run.respondingModelIds.join(',')}]`
    + ` outcome=${String(test?.outcome)} stepPass=${String(step?.verifierVerdict?.pass)}`
    + ` termination=${JSON.stringify(step?.termination ?? null)}`
    + ` lastError=${JSON.stringify(lastError ?? null)}`
    + ` clicks=${JSON.stringify(clicked)}`
  if (run.handoff !== undefined) return reading
  const tail = run.stderr.split('\n').filter((line) => !line.startsWith('[agent-qa:llm]')).slice(-20)
  return `${reading}\nno handoff; stderr tail:\n${tail.join('\n')}`
}

function requireLiveSetup(): void {
  expect(
    AUTH_PLUGIN,
    'AGENT_QA_438_LIVE_AUTH_PLUGIN is unset: name the built agent-qa-subscription-auth dist/index.js',
  ).toBeDefined()
  expect(
    existsSync(AUTH_PLUGIN!),
    `AGENT_QA_438_LIVE_AUTH_PLUGIN names no file: ${String(AUTH_PLUGIN)}`,
  ).toBe(true)
  expect(existsSync(CLI_DIST), 'packages/cli/dist/cli.js is missing: run pnpm build').toBe(true)
}

describe.skipIf(!LIVE)('an ambiguous click target in a live run', () => {
  it('"Click the okay button" ends refused with no click', async () => {
    requireLiveSetup()
    clicks.length = 0
    const run = await runLive('Click the okay button')
    const clicked = [...clicks]
    const reading = runReading(run, clicked)

    expect(run.handoff, `the run left no handoff.json\n${reading}`).toBeDefined()
    const test = run.handoff!.tests?.[0]
    expect(test?.steps?.[0]?.verifierVerdict?.pass, reading).not.toBe(true)
    expect(test?.outcome, reading).not.toBe('passed')
    expect(clicked, reading).toEqual([])
  }, CELL_TIMEOUT)

  it('"Click the second okay button" clicks the second', async () => {
    requireLiveSetup()
    clicks.length = 0
    const run = await runLive('Click the second okay button')
    const clicked = [...clicks]
    const reading = runReading(run, clicked)

    expect(run.handoff, `the run left no handoff.json\n${reading}`).toBeDefined()
    const test = run.handoff!.tests?.[0]
    expect(test?.steps?.[0]?.verifierVerdict?.pass, reading).toBe(true)
    expect(test?.outcome, reading).toBe('passed')
    expect(clicked, reading).toEqual(['2'])
  }, CELL_TIMEOUT)
})
