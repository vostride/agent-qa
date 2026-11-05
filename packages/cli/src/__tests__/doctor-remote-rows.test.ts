import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Command } from 'commander'
import { chromium } from 'playwright-core'
import { stringify } from 'yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { pinProcessTmpdir, removeTempRoots, type PinnedTmpdir } from './temp-roots.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn(() => Buffer.from('Version 1.64.1')),
  execFileSync: vi.fn(() => Buffer.from('')),
}))

vi.mock('@vostride/agent-qa-runner-local', () => ({
  checkDockerAvailable: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../commands/doctor-knowledge-checks.js', () => ({
  createKnowledgeChecks: () => [],
}))

vi.mock('../provider-plugins.js', () => ({
  loadProviderPluginsForRawConfig: vi.fn(() => Promise.resolve()),
}))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  resolveLLMAuth: vi.fn(() =>
    Promise.resolve({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    }),
  ),
  validateProject: vi.fn(() =>
    Promise.resolve({ errorCount: 0, warningCount: 0, fileCount: 1, results: [] }),
  ),
}))

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn(() => ({})),
}))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

import { createDoctorCommand } from '../commands/doctor.js'
import { createRemoteChecks } from '../commands/doctor-remote-checks.js'

const { startFakeAppiumServer } = (await import(
  new URL('../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: { readonly status?: 'fail' }) => Promise<{
    readonly url: string
    readonly origin: string
    readonly requests: readonly { method: string; path: string; headers: Record<string, string> }[]
    sessionsCreated(): readonly string[]
    close(): Promise<void>
  }>
}

const SECRET_VALUE = 'probe-secret-value-7f3a'

interface RecordedRequest {
  path: string
  search: string
  headers: IncomingMessage['headers']
}

interface ProbeServer {
  origin: string
  port: number
  requests: RecordedRequest[]
  close(): Promise<void>
}

async function startProbeServer(): Promise<ProbeServer> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://probe')
    requests.push({ path: url.pathname, search: url.search, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('Running')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `127.0.0.1:${String(port)}`,
    port,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((closed) => server.close(() => closed()))
    },
  }
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((closed) => server.close(() => closed()))
  return port
}

function refuseWithoutChromium(): void {
  if (!existsSync(chromium.executablePath()))
    throw new Error('Playwright Chromium missing; never skip')
}

interface ProjectFiles {
  config: Record<string, unknown>
  secrets?: string
  tests?: Record<string, Record<string, unknown>>
  suites?: Record<string, Record<string, unknown>>
}

let pinned: PinnedTmpdir
let printed: string[]
let consoleSpies: { mockRestore(): void }[] = []
const servers: ProbeServer[] = []
const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')

function baseConfig(extra: { remotes?: unknown[]; remote?: string; targetUrl?: string } = {}) {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    registry: {
      llms: [
        {
          name: 'default',
          provider: 'openai-compatible',
          model: 'model-name',
          baseURL: 'https://llm.example/api/v1',
        },
      ],
      targets: { web: { platform: 'web', url: extra.targetUrl ?? 'https://app.example' } },
      ...(extra.remotes ? { remotes: extra.remotes } : {}),
    },
    use: {
      llm: 'default',
      ...(extra.remote
        ? { browser: { name: 'chromium', headless: true, remote: extra.remote } }
        : {}),
    },
  }
}

async function writeProject(files: ProjectFiles): Promise<string> {
  const dir = await mkdtemp(join(pinned.root, 'project-'))
  await writeFile(join(dir, 'agent-qa.config.yaml'), stringify(files.config))
  await writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n')
  await writeFile(join(dir, '.env'), '')
  await writeFile(join(dir, '.env.secrets.local'), files.secrets ?? '')
  await mkdir(join(dir, 'tests'), { recursive: true })
  await mkdir(join(dir, 'suites'), { recursive: true })
  const tests = files.tests ?? { 'home.yaml': { name: 'Home', target: 'web', steps: ['Open'] } }
  for (const [file, body] of Object.entries(tests)) {
    await writeFile(join(dir, 'tests', file), stringify(body))
  }
  for (const [file, body] of Object.entries(files.suites ?? {})) {
    await writeFile(join(dir, 'suites', file), stringify(body))
  }
  return join(dir, 'agent-qa.config.yaml')
}

async function runDoctor(configPath: string, ...args: string[]): Promise<string> {
  printed = []
  process.exitCode = 0
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createDoctorCommand())
  await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'doctor', ...args])
  return printed.join('\n')
}

// Every row fits one line at this width, so a row reads `    <name>  ..  <message>  <STATUS>`.
function row(output: string, name: string): { status: string; message: string } | undefined {
  const line = output.split('\n').find((text) => text.startsWith(`    ${name}  `))
  if (line === undefined) return undefined
  const match = /^ {4}.+? {2}\.+ {2}(.*) {2}(PASS|WARN|FAIL|SKIP)$/.exec(line)
  return match ? { message: match[1] as string, status: match[2] as string } : undefined
}

describe("doctor's remote rows", () => {
  beforeAll(() => {
    pinned = pinProcessTmpdir()
  })

  afterAll(() => {
    pinned.restore()
    removeTempRoots([pinned.root])
  })

  beforeEach(() => {
    printed = []
    vi.mocked(execSync).mockClear()
    Object.defineProperty(process.stdout, 'columns', {
      value: 1000,
      configurable: true,
      writable: true,
    })
    const capture = (...parts: unknown[]) => {
      printed.push(
        parts
          .map(String)
          .join(' ')
          .replace(/\u001b\[[0-9;]*m/g, ''),
      )
    }
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
    ]
  })

  afterEach(async () => {
    for (const spy of consoleSpies) spy.mockRestore()
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns)
    for (const server of servers.splice(0)) await server.close()
    process.exitCode = 0
  })

  it('probes a playwright remote at its path /json and an http cdp remote at /json/version, sending no query, headers or credentials', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          { name: 'team-server', protocol: 'playwright', url: `ws://${probe.origin}/pw/` },
          {
            name: 'devtools',
            protocol: 'cdp',
            url: `http://${probe.origin}/devtools?region=eu`,
            query: { token: '{{secret:PROBE_TOKEN}}', session: 'keep' },
            headers: { 'X-Api-Key': '{{secret:PROBE_TOKEN}}', 'X-Tenant': 'acme' },
            basicAuth: { user: 'qa', password: '{{secret:PROBE_TOKEN}}' },
          },
        ],
      }),
      secrets: `PROBE_TOKEN=${SECRET_VALUE}\n`,
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote team-server')).toEqual({
      status: 'PASS',
      message: `team-server (playwright ws://${probe.origin}) answers; credentials are checked when a test connects.`,
    })
    expect(row(output, 'Remote devtools')).toEqual({
      status: 'PASS',
      message: `devtools (cdp http://${probe.origin}) answers; credentials are checked when a test connects.`,
    })
    expect(probe.requests.map((request) => request.path)).toEqual([
      '/pw/json',
      '/devtools/json/version',
    ])
    for (const request of probe.requests) {
      expect(request.search).toBe('')
      expect(request.headers).not.toHaveProperty('x-api-key')
      expect(request.headers).not.toHaveProperty('x-tenant')
      expect(request.headers).not.toHaveProperty('authorization')
      expect(JSON.stringify(request.headers)).not.toContain(SECRET_VALUE)
    }
    expect(output).not.toContain(SECRET_VALUE)
    expect(process.exitCode).toBe(0)
  })

  it('warns when a wss remote does not answer and leaves the exit code at 0', async () => {
    const port = await closedLoopbackPort()
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          { name: 'cloud', protocol: 'cdp', url: `wss://127.0.0.1:${String(port)}/chromium` },
        ],
      }),
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote cloud')).toEqual({
      status: 'WARN',
      message: `cloud (cdp wss://127.0.0.1:${String(port)}) did not answer within 3s.`,
    })
    expect(output).not.toContain('FAIL')
    expect(process.exitCode).toBe(0)
  })

  it("reads an Appium remote's version from its /status without sending its headers or credentials", async () => {
    const appium = await startFakeAppiumServer()
    servers.push({ origin: appium.origin, port: 0, requests: [], close: () => appium.close() })
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          {
            name: 'farm',
            protocol: 'appium',
            url: appium.url,
            headers: { 'X-Farm-Key': '{{secret:PROBE_TOKEN}}', 'X-Team': 'qa' },
            basicAuth: { user: 'qa', password: '{{secret:PROBE_TOKEN}}' },
          },
        ],
      }),
      secrets: `PROBE_TOKEN=${SECRET_VALUE}\n`,
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote farm')).toEqual({
      status: 'PASS',
      message: `farm (appium ${appium.origin}) answers (Appium 3.4.2); credentials are checked when a test connects.`,
    })
    expect(appium.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /wd/hub/status',
    ])
    const [request] = appium.requests
    expect(request?.headers).not.toHaveProperty('authorization')
    expect(request?.headers).not.toHaveProperty('x-farm-key')
    expect(request?.headers).not.toHaveProperty('x-team')
    expect(JSON.stringify(request?.headers)).not.toContain(SECRET_VALUE)
    expect(appium.sessionsCreated()).toEqual([])
    expect(output).not.toContain(SECRET_VALUE)
    expect(process.exitCode).toBe(0)
  })

  it('says only that an Appium remote answers when its /status reply names no version', async () => {
    const appium = await startFakeAppiumServer({ status: 'fail' })
    servers.push({ origin: appium.origin, port: 0, requests: [], close: () => appium.close() })
    const [check] = createRemoteChecks({
      config: { registry: { remotes: [{ name: 'farm', protocol: 'appium', url: appium.url }] } },
      configPath: join(pinned.root, 'agent-qa.config.yaml'),
    })

    expect(await check?.check()).toEqual({
      status: 'pass',
      message: `farm (appium ${appium.origin}) answers; credentials are checked when a test connects.`,
    })
  })

  it('warns, never fails, when an Appium remote has stopped', async () => {
    const appium = await startFakeAppiumServer()
    await appium.close()
    const configPath = await writeProject({
      config: baseConfig({ remotes: [{ name: 'farm', protocol: 'appium', url: appium.url }] }),
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote farm')).toEqual({
      status: 'WARN',
      message: `farm (appium ${appium.origin}) did not answer within 3s.`,
    })
    expect(output).not.toContain('FAIL')
    expect(process.exitCode).toBe(0)
  })

  it('warns naming an undeclared secret and the configured secrets file, and prints no secret value', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          {
            name: 'grid',
            protocol: 'playwright',
            url: `ws://${probe.origin}/`,
            headers: {
              Authorization: 'Bearer {{secret:MISSING_TOKEN}}',
              'X-Api-Key': '{{secret:PROBE_TOKEN}}',
            },
          },
        ],
      }),
      secrets: `PROBE_TOKEN=${SECRET_VALUE}\n`,
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote grid')).toEqual({
      status: 'WARN',
      message: `grid (playwright ws://${probe.origin}): MISSING_TOKEN not declared in .env.secrets.local.`,
    })
    expect(output).not.toContain(SECRET_VALUE)
    expect(process.exitCode).toBe(0)
  })

  it('reads the secrets file next to the config whatever the working directory', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          {
            name: 'grid',
            protocol: 'playwright',
            url: `ws://${probe.origin}/`,
            headers: { 'X-Api-Key': '{{secret:PROBE_TOKEN}}' },
          },
        ],
      }),
      secrets: `PROBE_TOKEN=${SECRET_VALUE}\n`,
    })
    const elsewhere = await mkdtemp(join(pinned.root, 'elsewhere-'))
    await writeFile(join(elsewhere, '.env.secrets.local'), '')
    const cwd = process.cwd()
    process.chdir(elsewhere)
    let output: string
    try {
      output = await runDoctor(configPath)
    } finally {
      process.chdir(cwd)
    }

    expect(row(output, 'Remote grid')?.status).toBe('PASS')
  })

  it('warns that the secrets cannot be checked when the workspace names no secrets file', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const [check] = createRemoteChecks({
      config: {
        registry: {
          remotes: [
            {
              name: 'grid',
              protocol: 'playwright',
              url: `ws://${probe.origin}/`,
              query: { token: '{{secret:GRID_TOKEN}}' },
            },
          ],
        },
      },
      configPath: join(pinned.root, 'agent-qa.config.yaml'),
    })

    expect(await check?.check()).toEqual({
      status: 'warn',
      message: `grid (playwright ws://${probe.origin}): GRID_TOKEN cannot be checked; workspace.secretsFile is not set.`,
    })
  })

  it("finds a Playwright server's /json answering without opening a session", async () => {
    refuseWithoutChromium()
    const server = await chromium.launchServer({ host: '127.0.0.1' })
    try {
      const [check] = createRemoteChecks({
        config: {
          registry: {
            remotes: [{ name: 'local-server', protocol: 'playwright', url: server.wsEndpoint() }],
          },
        },
        configPath: join(pinned.root, 'agent-qa.config.yaml'),
      })
      const result = await check?.check()

      expect(result?.status).toBe('pass')
      expect(result?.message).toMatch(
        /^local-server \(playwright ws:\/\/127\.0\.0\.1:\d+\) answers; /,
      )
    } finally {
      await server.close()
    }
  })

  it('gives a plugin remote no probe row, because its address is what its plugin answers', () => {
    const checks = createRemoteChecks({
      config: {
        registry: {
          remotes: [
            { name: 'cloud', plugin: 'kernel', settings: { region: 'eu' } },
            { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com/playwright' },
          ],
        },
      },
      configPath: join(pinned.root, 'agent-qa.config.yaml'),
    })

    expect(checks.map((check) => check.name)).toEqual(['Remote grid'])
  })

  it('skips the local browser row when the config default names a remote and no test or suite says local', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [{ name: 'grid', protocol: 'playwright', url: `ws://${probe.origin}/` }],
        remote: 'grid',
      }),
      suites: {
        'smoke.suite.yaml': {
          name: 'Smoke',
          target: 'web',
          tests: ['tests/home.yaml'],
          use: { browser: { remote: 'grid' } },
        },
      },
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Playwright')).toEqual({
      status: 'SKIP',
      message: 'every web test runs on a remote',
    })
    expect(vi.mocked(execSync).mock.calls.map(([command]) => String(command))).not.toContainEqual(
      expect.stringContaining('playwright'),
    )
  })

  it('checks the local browser row when one test says local', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [{ name: 'grid', protocol: 'playwright', url: `ws://${probe.origin}/` }],
        remote: 'grid',
      }),
      tests: {
        'home.yaml': { name: 'Home', target: 'web', steps: ['Open'] },
        'checkout.yaml': {
          name: 'Checkout',
          target: 'web',
          use: { browser: { remote: 'local' } },
          steps: ['Open'],
        },
      },
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Playwright')).toEqual({ status: 'PASS', message: 'installed' })
    expect(vi.mocked(execSync)).toHaveBeenCalledWith('npx playwright --version', { stdio: 'pipe' })
  })

  it("warns on a remote's row when a target on this machine's loopback is placed on it", async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          { name: 'grid', protocol: 'playwright', url: `ws://${probe.origin}/grid` },
          { name: 'spare', protocol: 'playwright', url: `ws://${probe.origin}/spare` },
        ],
        remote: 'grid',
        targetUrl: 'http://127.0.0.1:4173/app',
      }),
    })

    const output = await runDoctor(configPath)

    expect(row(output, 'Remote grid')).toEqual({
      status: 'WARN',
      message:
        `grid (playwright ws://${probe.origin}) answers; target web is on this machine's loopback, ` +
        'which the remote reaches only through a tunnel you run.',
    })
    expect(row(output, 'Remote spare')?.status).toBe('PASS')
    expect(process.exitCode).toBe(0)
  })

  it('shows only the named remote with --remote', async () => {
    const probe = await startProbeServer()
    servers.push(probe)
    const configPath = await writeProject({
      config: baseConfig({
        remotes: [
          { name: 'a', protocol: 'playwright', url: `ws://${probe.origin}/a` },
          { name: 'b', protocol: 'playwright', url: `ws://${probe.origin}/b` },
        ],
      }),
    })

    const output = await runDoctor(configPath, '--remote', 'a')

    expect(row(output, 'Remote a')?.status).toBe('PASS')
    expect(output).not.toContain('Remote b')
    expect(probe.requests.map((request) => request.path)).toEqual(['/a/json'])
  })

  it('refuses an unknown --remote name with the unknown-remote sentence and exit code 2', async () => {
    const listed = await writeProject({
      config: baseConfig({
        remotes: [
          { name: 'a', protocol: 'playwright', url: 'ws://127.0.0.1:9/a' },
          { name: 'b', protocol: 'playwright', url: 'ws://127.0.0.1:9/b' },
        ],
      }),
    })

    const output = await runDoctor(listed, '--remote', 'nope')

    expect(output).toBe('Unknown remote "nope". registry.remotes lists: a, b.')
    expect(process.exitCode).toBe(2)

    const none = await writeProject({ config: baseConfig() })
    expect(await runDoctor(none, '--remote', 'nope')).toBe(
      'Unknown remote "nope". registry.remotes lists no remotes.',
    )
    expect(process.exitCode).toBe(2)
  })
})
