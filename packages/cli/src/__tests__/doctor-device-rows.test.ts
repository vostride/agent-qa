import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { stringify } from 'yaml'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AndroidHere, IOSHere } from '@vostride/agent-qa-core'

import { removeTempRoots } from './temp-roots.js'
import { assertNoGuardedCalls, takeGuardedCalls } from './test-side-effect-guard.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn(() => Buffer.from('ok')),
  execFileSync: vi.fn(() => Buffer.from('')),
}))

vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()),
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

import { createDoctorCommand, type DoctorCommandHooks } from '../commands/doctor.js'

interface Row {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  message: string
  fix?: string
}

const FARM = { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }
const PIXEL_HERE: AndroidHere = {
  attached: [{ serial: 'R58M41ABCDE', state: 'device', model: 'Pixel 8', os: '15' }],
  avds: [],
}
const NO_SIMULATORS: IOSHere = { simulators: [] }

const roots: string[] = []
let printed: string[] = []

function lister(android: AndroidHere = PIXEL_HERE, ios: IOSHere = NO_SIMULATORS) {
  const calls: string[] = []
  const list: NonNullable<DoctorCommandHooks['listDevicesHere']> = async (platform) => {
    calls.push(platform)
    return platform === 'android' ? android : ios
  }
  return { list, calls }
}

function projectConfig(devices: Record<string, unknown>, targets: string[] = ['android']) {
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
      remotes: [FARM],
      targets: Object.fromEntries(
        targets.map((platform) => [
          `${platform}-app`,
          platform === 'android'
            ? { platform, appPackage: 'com.example', appActivity: '.Main' }
            : { platform, bundleId: 'com.example' },
        ]),
      ),
      devices,
    },
    use: { llm: 'default' },
  }
}

async function writeProject(config: Record<string, unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-doctor-devices-'))
  roots.push(dir)
  await writeFile(join(dir, 'agent-qa.config.yaml'), stringify(config))
  await writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n')
  await writeFile(join(dir, '.env'), '')
  await writeFile(join(dir, '.env.secrets.local'), '')
  await mkdir(join(dir, 'tests'), { recursive: true })
  await mkdir(join(dir, 'suites'), { recursive: true })
  return join(dir, 'agent-qa.config.yaml')
}

async function doctorRows(
  config: Record<string, unknown>,
  hooks: DoctorCommandHooks = {},
): Promise<Row[]> {
  const configPath = await writeProject(config)
  printed = []
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(
    createDoctorCommand({
      chromium: () => ({ found: true, path: '/browsers/chromium-1/chrome' }),
      ...hooks,
    }),
  )
  await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'doctor', '--json'])
  return (JSON.parse(printed.join('\n')) as { rows: Row[] }).rows
}

function row(rows: readonly Row[], name: string): Row | undefined {
  return rows.find((entry) => entry.name === name)
}

describe("doctor's device rows", () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '))
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(''))
    process.exitCode = 0
  })

  afterAll(() => {
    removeTempRoots(roots)
  })

  it('passes a profile found on this machine with what it found', async () => {
    const { list } = lister()
    const rows = await doctorRows(
      projectConfig({ pixel: { platform: 'android', model: 'Pixel 8' } }),
      { listDevicesHere: list },
    )

    expect(row(rows, 'Device pixel')).toEqual({
      name: 'Device pixel',
      status: 'pass',
      message: 'here: Pixel 8 phone R58M41ABCDE',
    })
  })

  it('warns on a local profile that matches nothing here, with what it wants and the devices fix', async () => {
    const { list } = lister()
    const rows = await doctorRows(
      projectConfig({ galaxy: { platform: 'android', model: 'Galaxy S24' } }),
      { listDevicesHere: list },
    )

    expect(row(rows, 'Device galaxy')).toEqual({
      name: 'Device galaxy',
      status: 'warn',
      message: 'not here: wants a Galaxy S24',
      fix: '`npx agent-qa devices` lists what this machine has; connect a phone, start an emulator or boot a simulator that matches.',
    })
  })

  it('passes a profile on a remote with its remote, never warning or failing', async () => {
    const { list } = lister({ attached: [], avds: [] })
    const rows = await doctorRows(
      projectConfig({ 'galaxy-farm': { platform: 'android', model: 'Galaxy S24', remote: 'farm' } }),
      { listDevicesHere: list },
    )

    expect(row(rows, 'Device galaxy-farm')).toEqual({
      name: 'Device galaxy-farm',
      status: 'pass',
      message: 'remote farm (appium https://farm.example.com:443)',
    })
  })

  it('lists one row per device profile right after the Xcode row', async () => {
    const { list } = lister()
    const rows = await doctorRows(
      projectConfig({
        pixel: { platform: 'android', model: 'Pixel 8' },
        galaxy: { platform: 'android', model: 'Galaxy S24' },
        'galaxy-farm': { platform: 'android', model: 'Galaxy S24', remote: 'farm' },
      }),
      { listDevicesHere: list },
    )

    const names = rows.map((entry) => entry.name)
    const xcode = names.indexOf('Xcode')
    expect(xcode).toBeGreaterThan(-1)
    expect(names.slice(xcode + 1, xcode + 4)).toEqual([
      'Device pixel',
      'Device galaxy',
      'Device galaxy-farm',
    ])
    expect(names.filter((name) => name.startsWith('Device '))).toHaveLength(3)
  })

  it('keeps the tool rows failing for a local profile on a machine without the tools', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('appium not found')
    })
    const { list } = lister()
    const rows = await doctorRows(
      projectConfig({ pixel: { platform: 'android', model: 'Pixel 8' } }),
      { listDevicesHere: list },
    )

    expect(row(rows, 'Appium')).toMatchObject({ status: 'fail', message: 'not installed' })
    expect(row(rows, 'Device pixel')).toMatchObject({ status: 'pass' })
  })
})

describe("doctor's device rows in a test without listDevicesHere", () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '))
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.exitCode = 0
  })

  it("are refused by the guard before they list this machine's devices", async () => {
    await doctorRows(projectConfig({ pixel: { platform: 'android', model: 'Pixel 8' } }))

    expect(takeGuardedCalls()).toContain('list devices')
  })

  it('fail the check after the test, naming listDevicesHere', async () => {
    await doctorRows(projectConfig({ pixel: { platform: 'android', model: 'Pixel 8' } }))

    expect(() => assertNoGuardedCalls()).toThrow(/ Inject listDevicesHere\.$/u)
  })
})
