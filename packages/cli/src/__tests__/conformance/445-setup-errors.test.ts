// C445-SETUP-ERRORS (445-08, D-15, D-12; 445-16, D-41): each missing setup prerequisite names its fix

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as core from '@vostride/agent-qa-core'
import { generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INIT_BASE_URL_DEFAULTS } from '../../commands/init.js'
import { refuseWithoutRecordingTools } from './433-door-fixture.js'
import {
  POPULATED_RUN_ANCHORED_BUILDS,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type StubModelServer,
} from './populated-run-fixture.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const FILE_BUDGET_MS = 300_000
const LEG_BUDGET_MS = 180_000
const GEMINI_CONFIG = 'gemini-key'
const UNKNOWN_KEY = 'planer'
const INVALID_CONFIG_FIX = 'Fix or remove the key named above'
const PLANTED_KEY = 'sk-test-not-a-key'

interface Leg {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
}

interface Scene {
  browser?: Leg
  model?: Leg
  anthropicNoKey?: Leg
  validate?: Leg
  run?: Leg
  auth?: Record<string, Leg>
  authStoreWritten?: boolean
  modelRequests?: number
  error?: string
}

const scene: Scene = {}
let model: StubModelServer | undefined
let target: FixtureServer | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

function expectFresh(): void {
  const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
}

function workspace(label: string, llm: string, llms: string, targetUrl: string): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-445-08-${label}-`)))
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  mkdirSync(join(root, 'agent-qa-knowledge'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    [
      'workspace:',
      "  testMatch: ['tests/**/*.test.yaml']",
      '  testPathIgnore: []',
      "  suiteMatch: ['suites/**/*.suite.yaml']",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'knowledge:',
      '  dir: agent-qa-knowledge',
      'use:',
      '  mobile:',
      '    appState: preserve',
      `  llm: ${llm}`,
      'registry:',
      '  targets:',
      '    shop:',
      '      platform: web',
      `      url: ${targetUrl}`,
      '      environment: local',
      '  llms:',
      llms,
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  writeFileSync(
    join(root, 'tests', 'setup.test.yaml'),
    `name: Setup error probe\ntest-id: ${generateTestId()}\ntarget: shop\nsteps:\n  - Open the page\n`,
    'utf8',
  )
  return root
}

async function spawnCli(
  root: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Leg> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', join(root, 'agent-qa.config.yaml'), ...args],
    {
      cwd: root,
      env: { ...hermeticEnv(root), CI: 'true', NO_COLOR: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, LEG_BUDGET_MS)
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (settle, fail) => {
        child.once('error', fail)
        child.once('close', (code, signal) => { settle({ code, signal }) })
      },
    )
    return { ...exit, output }
  } finally {
    clearTimeout(budget)
  }
}

async function driveBrowser(): Promise<void> {
  if (model === undefined || target === undefined) throw new Error('servers not started')
  const project = populatedRunFixtureProject('445-08-browser', {
    modelBaseUrl: model.baseUrl,
    targetUrl: target.url,
  })
  const noBrowsers = join(project.root, 'no-browsers')
  mkdirSync(noBrowsers, { recursive: true })
  scene.browser = await spawnCli(project.root, ['run', project.testPath], {
    ...populatedRunSpawnEnv(),
    PLAYWRIGHT_BROWSERS_PATH: noBrowsers,
  })
}

async function driveModel(): Promise<void> {
  if (target === undefined) throw new Error('target not started')
  const root = workspace(
    'model',
    GEMINI_CONFIG,
    [
      `    - name: ${GEMINI_CONFIG}`,
      '      provider: gemini',
      '      model: gemini-3-flash-preview',
    ].join('\n'),
    target.url,
  )
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  scene.model = await spawnCli(
    root,
    ['run', 'tests/setup.test.yaml'],
    browsers === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: browsers },
  )
}

async function driveAnthropicNoKey(): Promise<void> {
  if (target === undefined) throw new Error('target not started')
  const root = workspace(
    'anthropic-no-key',
    'default',
    [
      '    - name: default',
      '      provider: anthropic-compatible',
      '      model: claude-sonnet-4-6',
      '      baseURL: https://api.anthropic.com/v1',
    ].join('\n'),
    target.url,
  )
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  scene.anthropicNoKey = await spawnCli(
    root,
    ['run', 'tests/setup.test.yaml'],
    browsers === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: browsers },
  )
}

async function driveConfig(): Promise<void> {
  if (model === undefined || target === undefined) throw new Error('servers not started')
  const root = workspace(
    'config',
    'stub',
    [
      '    - name: stub',
      '      provider: openai-compatible',
      '      model: stub-vision',
      `      baseURL: ${model.baseUrl}`,
      `${UNKNOWN_KEY}:`,
      '  model: stub-vision',
    ].join('\n'),
    target.url,
  )
  scene.validate = await spawnCli(root, ['validate'])
  scene.run = await spawnCli(root, ['run', 'tests/setup.test.yaml'])
}

async function driveAuth(): Promise<void> {
  if (model === undefined || target === undefined) throw new Error('servers not started')
  const root = workspace(
    'auth',
    'default',
    [
      '    - name: codex',
      '      provider: openai-subscription',
      '      model: gpt-6.1-sol',
      '    - name: default',
      '      provider: openai-compatible',
      '      model: stub-vision',
      `      baseURL: ${model.baseUrl}`,
    ].join('\n'),
    target.url,
  )
  const legs: Record<string, readonly string[]> = {
    unknownConfig: ['auth', 'login', '--config', 'nosuch'],
    loginApiConfig: ['auth', 'login', '--config', 'default'],
    setOnSubscription: ['auth', 'set', '--config', 'codex', '--type', 'api-key', PLANTED_KEY],
    invalidType: ['auth', 'set', '--config', 'default', '--type', 'nosuch', PLANTED_KEY],
    bearerOnOpenAI: ['auth', 'set', '--config', 'default', '--type', 'bearer-token', PLANTED_KEY],
    emptySecret: ['auth', 'set', '--config', 'default', '--type', 'api-key', ''],
  }
  scene.auth = {}
  for (const [name, args] of Object.entries(legs)) scene.auth[name] = await spawnCli(root, args)
  scene.authStoreWritten = existsSync(join(root, '.agent-qa', 'auth.json'))
}

describe('C445-SETUP-ERRORS', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    refuseWithoutRecordingTools()
    try {
      target = await startTargetPageServer()
      model = await startStubModelServer()
      await driveBrowser()
      await driveModel()
      await driveConfig()
      await driveAuth()
      await driveAnthropicNoKey()
      scene.modelRequests = model.requests.length
    } catch (error) {
      scene.error = message(error)
    }
    console.info(`C445-SETUP-ERRORS scene: ${JSON.stringify(scene)}`)
  }, FILE_BUDGET_MS)

  afterAll(async () => {
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 60_000)

  it('a missing browser names agent-qa install-browsers --chromium and exits 2', () => {
    expectFresh()
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.browser?.code, seen()).toBe(2)
    expect(scene.browser?.output, seen()).toMatch(/^\s*agent-qa install-browsers --chromium$/mu)
  })

  it('a missing model key names agent-qa auth set with the config and exits 2', () => {
    expectFresh()
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.model?.code, seen()).toBe(2)
    expect(scene.model?.output, seen()).toContain(
      `agent-qa auth set --config ${GEMINI_CONFIG} --type api-key`,
    )
  })

  it('a missing key for anthropic-compatible on the public Anthropic API names agent-qa auth set and exits 2', () => {
    expectFresh()
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.anthropicNoKey?.signal, seen()).toBeNull()
    expect(scene.anthropicNoKey?.code, seen()).toBe(2)
    expect(scene.anthropicNoKey?.output, seen()).toContain(
      'agent-qa auth set --config default --type api-key',
    )
  })

  it('the public provider API hosts are the hosts of the init base URL defaults', () => {
    expectFresh()
    const exported: Record<string, unknown> = core
    const hosts = exported.PUBLIC_PROVIDER_API_HOSTS as readonly string[] | undefined
    const initHosts = Object.values(INIT_BASE_URL_DEFAULTS).map(url => new URL(url).hostname)
    expect(hosts).toBeDefined()
    expect([...(hosts ?? [])].sort()).toEqual([...new Set(initHosts)].sort())
    expect(hosts?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('an invalid config names the key and the fix', () => {
    expectFresh()
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.validate?.code, seen()).toBe(1)
    expect(scene.run?.code, seen()).toBe(2)
    for (const leg of [scene.validate, scene.run]) {
      expect(leg?.output, seen()).toContain(`"${UNKNOWN_KEY}"`)
      expect(leg?.output, seen()).toContain(INVALID_CONFIG_FIX)
    }
  })

  it('auth refusals exit non-zero and name the command to use', () => {
    expectFresh()
    expect(scene.error, seen()).toBeUndefined()
    const auth = scene.auth ?? {}
    expect(Object.keys(auth).length, seen()).toBe(6)
    for (const [name, leg] of Object.entries(auth)) {
      expect({ name, code: leg.code }, seen()).toEqual({ name, code: 1 })
      expect(leg.output, seen()).not.toContain(PLANTED_KEY)
    }
    expect(auth.unknownConfig?.output, seen()).toContain('nosuch')
    expect(auth.unknownConfig?.output, seen()).toContain('codex, default')
    expect(auth.loginApiConfig?.output, seen()).toContain('agent-qa auth set --config')
    expect(auth.setOnSubscription?.output, seen()).toContain('agent-qa auth login --config codex')
    expect(scene.authStoreWritten, seen()).toBe(false)
  })
})
