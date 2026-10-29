// Every URL init writes names only the playground host, except agent-qa's own recipe page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../commands/init-filesystem.js', async () => {
  const fs = await import('node:fs')
  const writePlan = (plan: { path: string; content: string | Uint8Array }) => {
    fs.writeFileSync(plan.path, plan.content)
    return { path: plan.path, outcome: 'created' as const }
  }

  return {
    KNOWLEDGE_GITIGNORE_PROBES: [],
    TARGET_GITIGNORE_PROBES: [],
    classifyInitPath: vi.fn(() => 'missing'),
    preflightInitPlan: vi.fn((plans: Array<{ path: string }>) => plans.map(plan => ({
      path: plan.path,
      classification: 'missing',
    }))),
    writeScaffoldFileAtomic: vi.fn(writePlan),
    writeConfigMarkerLast: vi.fn(writePlan),
    upsertManagedGitignoreBlock: vi.fn((path: string) => {
      fs.writeFileSync(path, '# agent-qa init:start\n# agent-qa init:end\n')
      return { path, outcome: 'created' as const }
    }),
    verifyEffectiveGitignore: vi.fn(() => ({ checked: true })),
  }
})

vi.mock('../commands/install-browsers.js', () => ({
  formatInstallBrowsersRetryCommand: vi.fn(() => 'agent-qa install-browsers --chromium'),
  runBrowserInstall: vi.fn(() => ({ ok: true, status: 0, stage: 'installer' })),
}))

vi.mock('@inquirer/select', () => ({ default: vi.fn() }))
vi.mock('@inquirer/input', () => ({ default: vi.fn() }))
vi.mock('@inquirer/checkbox', () => ({ default: vi.fn() }))
vi.mock('@inquirer/confirm', () => ({ default: vi.fn() }))
vi.mock('@inquirer/password', () => ({ default: vi.fn() }))

vi.mock('@vostride/agent-qa-core', () => ({
  writeAuth: vi.fn(() => Promise.resolve()),
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally.'),
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
  getAgentQaVersion: vi.fn(() => '0.1.1'),
}))

import { createInitCommand } from '../commands/init.js'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { clearProviderRegistry } from '@vostride/agent-qa-model'

const mockWriteFileSync = vi.mocked(writeFileSync)

const PLATFORMS = ['web', 'android', 'ios', 'web+android', 'web+ios'] as const
const WEB_PLATFORMS = new Set(['web', 'web+android', 'web+ios'])
const PLAYGROUND_HOST = 'playground.vostride.dev'
const AGENT_QA_RECIPE_URL = 'https://vostride.com/docs/agent-qa/coding-agents'
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g

async function runInit(args: string[]): Promise<void> {
  const parent = new Command()
  const init = createInitCommand({})
  parent.exitOverride()
  init.exitOverride()
  parent.addCommand(init)
  await parent.parseAsync(['node', 'test', 'init', ...args])
}

async function writesFor(platform: string): Promise<Array<{ path: string; content: string }>> {
  mockWriteFileSync.mockClear()
  await runInit(['--dir', '/tmp/c445-hosts', '--platform', platform])
  return mockWriteFileSync.mock.calls.map(call => ({
    path: String(call[0]),
    content: String(call[1]),
  }))
}

describe('the URLs init writes', () => {
  beforeEach(() => {
    clearProviderRegistry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockImplementation(path =>
      String(path).endsWith('package.json') ? '{"version":"0.1.1"}' : '',
    )
  })

  afterEach(() => {
    clearProviderRegistry()
    vi.restoreAllMocks()
  })

  it('every URL init writes for every platform names only playground.vostride.dev', async () => {
    for (const platform of PLATFORMS) {
      const writes = await writesFor(platform)
      expect(writes.length, `${platform}: init wrote no file`).toBeGreaterThan(0)
      const urls = writes.flatMap(write =>
        (write.content.match(URL_PATTERN) ?? [])
          .filter(url => url !== AGENT_QA_RECIPE_URL)
          .map(url => ({ file: write.path, url })),
      )
      if (WEB_PLATFORMS.has(platform)) {
        expect(urls.length, `${platform}: init wrote no URL at all`).toBeGreaterThan(0)
      }
      for (const { file, url } of urls) {
        expect(new URL(url).hostname, `${platform}: ${file} names ${url}`).toBe(PLAYGROUND_HOST)
      }
    }
  })
})
