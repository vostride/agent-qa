import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { adapterOptions, adapterSetups, setupFailure } = vi.hoisted(() => ({
  adapterOptions: [] as unknown[],
  adapterSetups: [] as unknown[],
  setupFailure: { error: undefined as Error | undefined },
}))

vi.mock('@vostride/agent-qa-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-web')>()),
  WebPlatformAdapter: vi.fn().mockImplementation(function (options: unknown) {
    adapterOptions.push(options)
    return {
      platform: 'web',
      setup: vi.fn(async (config: unknown) => {
        adapterSetups.push(config)
        if (setupFailure.error !== undefined) throw setupFailure.error
      }),
      cleanup: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({ success: true }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
      observe: vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} }),
      drainConsoleLogs: vi.fn(() => []),
      drainNetworkLogs: vi.fn(() => []),
    }
  }),
}))

vi.mock('@vostride/agent-qa-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner')>()),
  LLMPlanner: vi.fn().mockImplementation(function () {
    return { plan: vi.fn() }
  }),
  LLMVerifier: vi.fn().mockImplementation(function () {
    return { verify: vi.fn() }
  }),
}))

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn().mockReturnValue({ modelId: 'test-model' }),
}))

import { RemoteEntrySchema, resolveWorkspacePaths, toRemoteBrowserConfig } from '@vostride/agent-qa-core'
import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { SecretStore } from '@vostride/agent-qa-runner'

import { ConfigManager } from '../../config/index.js'
import { createRouter } from '../../server/routes.js'
import { SuiteFileManager } from '../../tests/suite-file-manager.js'
import { TestFileManager } from '../../tests/test-file-manager.js'
import { SessionManager } from '../session-manager.js'

const GRID = {
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://grid.example.test/playwright',
  headers: { Authorization: 'Bearer {{secret:GRID_TOKEN}}' },
}
const OTHER = { name: 'other', protocol: 'playwright', url: 'wss://other.example.test/' }

const gridRemote = toRemoteBrowserConfig({
  ...RemoteEntrySchema.parse(GRID),
  protocol: 'playwright',
})
const otherRemote = toRemoteBrowserConfig({
  ...RemoteEntrySchema.parse(OTHER),
  protocol: 'playwright',
})

interface TestFile {
  file: string
  pick?: string
}

interface Workspace {
  configPick?: string
  // A device on an appium remote whose capabilities reference FARM_KEY, and an android target
  // whose app.ref references SHOP_APK_SIGNATURE.
  devices?: boolean
  tests: TestFile[]
  suite?: { name: string; pick?: string; members: string[] }
}

interface Opened {
  invoke(body: Record<string, unknown>): Promise<{ status: number; body: string }>
  testIds: Map<string, string>
  suiteId: string
  sessionManager: SessionManager
}

let tempDirs: string[] = []
let managers: SessionManager[] = []

beforeEach(() => {
  adapterOptions.length = 0
  adapterSetups.length = 0
  setupFailure.error = undefined
})

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.cleanupAll()))
  managers = []
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function useBrowserRemote(pick: string | undefined, indent = ''): string[] {
  return pick === undefined ? [] : [`${indent}use:`, `${indent}  browser:`, `${indent}    remote: ${pick}`]
}

async function openWorkspace(workspace: Workspace): Promise<Opened> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-live-remote-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'services: {}',
      'registry:',
      '  remotes:',
      `    - name: ${GRID.name}`,
      `      protocol: ${GRID.protocol}`,
      `      url: ${GRID.url}`,
      '      headers:',
      `        Authorization: '${GRID.headers.Authorization}'`,
      `    - name: ${OTHER.name}`,
      `      protocol: ${OTHER.protocol}`,
      `      url: ${OTHER.url}`,
      ...(workspace.devices === true
        ? [
            '    - name: farm',
            '      protocol: appium',
            '      url: https://farm.example.com/wd/hub',
            '  devices:',
            '    galaxy-farm:',
            '      platform: android',
            '      model: Samsung Galaxy S24',
            '      remote: farm',
            '      capabilities:',
            '        farm:options:',
            '          accessKey: "{{secret:FARM_KEY}}"',
            '  targets:',
            '    shop-android:',
            '      platform: android',
            '      appPackage: com.example.shop',
            '      app:',
            '        ref: "https://files.example.com/shop.apk?sig={{secret:SHOP_APK_SIGNATURE}}"',
          ]
        : []),
      ...useBrowserRemote(workspace.configPick),
      '',
    ].join('\n'),
    'utf-8',
  )
  await Promise.all([
    writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n', 'utf-8'),
    writeFile(join(dir, '.env'), '', 'utf-8'),
    writeFile(
      join(dir, '.env.secrets.local'),
      workspace.devices === true
        ? 'GRID_TOKEN=grid-token-41c7\nFARM_KEY=farm-key-0b52\nSHOP_APK_SIGNATURE=apk-sig-9e14\n'
        : 'GRID_TOKEN=grid-token-41c7\n',
      'utf-8',
    ),
    mkdir(join(dir, 'tests'), { recursive: true }),
    mkdir(join(dir, 'suites'), { recursive: true }),
  ])
  const testIds = new Map<string, string>()
  for (const test of workspace.tests) {
    const testId = generateTestId()
    testIds.set(test.file, testId)
    await writeFile(
      join(dir, test.file),
      [
        `test-id: ${testId}`,
        `name: ${test.file}`,
        'target: web',
        ...useBrowserRemote(test.pick),
        'steps:',
        '  - open the inbox',
        '',
      ].join('\n'),
      'utf-8',
    )
  }
  const suiteId = generateSuiteId()
  if (workspace.suite !== undefined) {
    await writeFile(
      join(dir, 'suites', 'checkout.suite.yaml'),
      [
        `suite-id: ${suiteId}`,
        `name: ${workspace.suite.name}`,
        'target: web',
        ...useBrowserRemote(workspace.suite.pick),
        'tests:',
        ...workspace.suite.members.map((member) => `  - test: ${member}`),
        '',
      ].join('\n'),
      'utf-8',
    )
  }
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath,
  })
  const configManager = new ConfigManager(configPath, (text) => text)
  const sessionManager = new SessionManager({ configManager, configPath })
  managers.push(sessionManager)
  const testFileManager = new TestFileManager(workspacePaths)
  const router = createRouter({
    db: { getRuns: () => [], close() {} } as any,
    configManager,
    configPath,
    workspacePaths,
    testFileManager,
    suiteFileManager: new SuiteFileManager(workspacePaths, testFileManager),
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-20250514',
      baseURL: 'https://anthropic-proxy.example/messages',
    } as any,
    sessionManager,
  })
  return {
    invoke: (body) => invoke(router, body),
    testIds,
    suiteId,
    sessionManager,
  }
}

function createRequest(headers: IncomingHttpHeaders, body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = '/api/live-editor/sessions'
  req.headers = { host: '127.0.0.1:3470', ...headers }
  process.nextTick(() => {
    req.push(Buffer.from(body))
    req.push(null)
  })
  return req
}

function invoke(
  router: ReturnType<typeof createRouter>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let status = 200
    let text = ''
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      setHeader() {},
      getHeader() {
        return undefined
      },
      write(chunk: string | Buffer) {
        text += chunk.toString()
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) text += chunk.toString()
        resolve({ status, body: text })
      },
    } as unknown as ServerResponse
    router(createRequest({ 'content-type': 'application/json' }, JSON.stringify(body)), res)
  })
}

function setupBrowser(): Record<string, unknown> {
  expect(adapterSetups).toHaveLength(1)
  return (adapterSetups[0] as { browser: Record<string, unknown> }).browser
}

function secretNames(store: unknown): string[] {
  const names: string[] = []
  ;(store as SecretStore).forEachSecret((name) => names.push(name))
  return names.sort()
}

describe('the live editor on a remote', () => {
  it("connects a test to the config's default remote with the run's adapter options", async () => {
    const opened = await openWorkspace({ configPick: 'grid', tests: [{ file: 'tests/a.yaml' }] })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
    })

    expect(res.status).toBe(201)
    expect(setupBrowser()).toEqual({ name: 'chromium', headless: false, remote: gridRemote })
    expect(adapterOptions).toHaveLength(1)
    const options = adapterOptions[0] as {
      connectionSecrets?: SecretStore
      secretsFile?: string
      refusalMemory?: unknown
    }
    expect(secretNames(options.connectionSecrets)).toEqual(['GRID_TOKEN'])
    expect(options.secretsFile).toBe('.env.secrets.local')
    expect(options.refusalMemory).toBeDefined()
  })

  it("keeps a device's capability and app.ref secrets for the connection, out of every step", async () => {
    const opened = await openWorkspace({
      configPick: 'grid',
      devices: true,
      tests: [{ file: 'tests/a.yaml' }],
    })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
    })

    expect(res.status).toBe(201)
    const options = adapterOptions[0] as { connectionSecrets?: SecretStore }
    expect(secretNames(options.connectionSecrets)).toEqual([
      'FARM_KEY',
      'GRID_TOKEN',
      'SHOP_APK_SIGNATURE',
    ])
    const session = opened.sessionManager.getSession(
      (JSON.parse(res.body) as { sessionId: string }).sessionId,
    )
    for (const name of ['FARM_KEY', 'SHOP_APK_SIGNATURE']) {
      const result = await session!.executeStepCommand(
        `Type {{secret:${name}}} into the field`,
        0,
        undefined,
        { testName: 'checkout' },
      )
      expect(result.status).toBe('failed')
      expect(result.error).toBe(
        `${name} is a remote's or device's credential and only connects to it; the draft "checkout" uses it in a step. Use another secret there.`,
      )
    }
  })

  it('launches here for a test that picks local over the config default', async () => {
    const opened = await openWorkspace({
      configPick: 'grid',
      tests: [{ file: 'tests/a.yaml', pick: 'local' }],
    })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
    })

    expect(res.status).toBe(201)
    expect(setupBrowser()).toEqual({ name: 'chromium', headless: false })
  })

  it("applies the remote a suite names to the suite's session", async () => {
    const opened = await openWorkspace({
      configPick: 'grid',
      tests: [{ file: 'tests/a.yaml' }, { file: 'tests/b.yaml', pick: 'local' }],
      suite: { name: 'Checkout', pick: 'other', members: ['tests/a.yaml', './tests/b.yaml'] },
    })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'suite', id: opened.suiteId },
    })

    expect(res.status).toBe(201)
    expect(setupBrowser()).toEqual({ name: 'chromium', headless: false, remote: otherRemote })
  })

  it('refuses a suite whose members disagree with the sentence and opens no session', async () => {
    const opened = await openWorkspace({
      tests: [{ file: 'tests/a.yaml', pick: 'grid' }, { file: 'tests/b.yaml', pick: 'local' }],
      suite: { name: 'Checkout', members: ['tests/a.yaml', './tests/b.yaml'] },
    })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'suite', id: opened.suiteId },
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Suite Checkout runs its tests in one place, but tests/a.yaml picks grid and tests/b.yaml picks local. ' +
        'Set use.browser.remote in the suite or make the tests agree.',
    })
    expect(adapterOptions).toHaveLength(0)
    expect(opened.sessionManager.size).toBe(0)
  })

  it('refuses a test that picks an unknown remote, naming its file', async () => {
    const opened = await openWorkspace({ tests: [{ file: 'tests/a.yaml', pick: 'nowhere' }] })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unknown remote "nowhere" in tests/a.yaml. registry.remotes lists: grid, other.',
    })
    expect(opened.sessionManager.size).toBe(0)
  })

  it('takes the place from the files when the request body names another remote', async () => {
    const opened = await openWorkspace({ configPick: 'grid', tests: [{ file: 'tests/a.yaml' }] })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
      remote: 'other',
      browser: { remote: 'other' },
      use: { browser: { remote: 'other' } },
    })

    expect(res.status).toBe(201)
    expect(setupBrowser()).toEqual({ name: 'chromium', headless: false, remote: gridRemote })
  })

  it("uses the config's default when the session edits no saved file", async () => {
    const opened = await openWorkspace({ configPick: 'other', tests: [] })
    const res = await opened.invoke({ platform: 'web' })

    expect(res.status).toBe(201)
    expect(setupBrowser()).toEqual({ name: 'chromium', headless: false, remote: otherRemote })
  })

  it("answers a refused connect with the remote's sentence alone and keeps no session", async () => {
    const sentence = 'Remote grid refused the connection: the token was not accepted.'
    setupFailure.error = new RemoteRefusalError(sentence)
    const opened = await openWorkspace({ configPick: 'grid', tests: [{ file: 'tests/a.yaml' }] })
    const res = await opened.invoke({
      platform: 'web',
      entity: { type: 'test', id: opened.testIds.get('tests/a.yaml') },
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: sentence })
    expect(opened.sessionManager.size).toBe(0)
  })
})
