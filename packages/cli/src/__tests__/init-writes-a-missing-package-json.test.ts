// The package.json init writes when the project has none.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { sanitizedPackageName } from '../commands/package-json-plan.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { fakeInitUi } from './fake-init-ui.js'
import { fakeRunner } from './project-fixtures.js'

const WEB_GEMINI = ['--platform', 'web', '--llm', 'gemini', '--pm', 'none']
const roots: string[] = []

function tempFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  roots.push(folder)
  return folder
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_missing-package-json', runtimeContext: 'user' }),
  })

describe('the package name comes from the folder name', () => {
  it.each([
    ['My App', 'my-app'],
    ['.hidden', 'hidden'],
    ['_tools', 'tools'],
    ['qa@2026!', 'qa-2026-'],
    ['___', 'agent-qa-project'],
    ['.', 'agent-qa-project'],
  ])('%s becomes %s', (folderName, name) => {
    expect(sanitizedPackageName(folderName)).toBe(name)
  })
})

describe('init writes a missing package.json', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('a folder named My App gets a two-space package.json named my-app with a final newline', async () => {
    const cwd = join(tempFolder('agent-qa-missing-package-json-'), 'My App')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const ui = fakeInitUi()
    const parent = new Command()
    const command = createInitCommand({
      cwd,
      host: { homedir: tempFolder('agent-qa-missing-package-json-home-'), run: fakeRunner() },
      isTTY: false,
      composeAnalytics: silentAnalytics,
      ui,
    })
    parent.exitOverride()
    command.exitOverride()
    parent.addCommand(command)

    await parent.parseAsync(['node', 'test', 'init', ...WEB_GEMINI])

    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(
      `${JSON.stringify(
        { name: 'my-app', private: true, devDependencies: { 'agent-qa': getAgentQaVersion() } },
        null,
        2,
      )}\n`,
    )
    expect(ui.entries).toContainEqual({ kind: 'done', text: 'package.json created (my-app)' })
  })
})
