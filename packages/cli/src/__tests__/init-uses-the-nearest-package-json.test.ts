// Where init declares agent-qa: the nearest package.json within the project's range, on real folders.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { defaultProjectIo } from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { fakeRunner } from './project-fixtures.js'

const WEB_GEMINI = ['--platform', 'web', '--llm', 'gemini', '--pm', 'none']
const roots: string[] = []
let errors: MockInstance<typeof process.stderr.write>

function tempFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  roots.push(folder)
  return folder
}

function gitRoot(): string {
  const root = tempFolder('agent-qa-nearest-package-json-')
  mkdirSync(join(root, '.git'))
  return root
}

function folder(...parts: string[]): string {
  const path = join(...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path, text)
  return text
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_nearest-package-json', runtimeContext: 'user' }),
  })

async function init(cwd: string, homedir: string = tempFolder('agent-qa-nearest-home-')) {
  const parent = new Command()
  const command = createInitCommand({
    cwd,
    host: { homedir, run: fakeRunner() },
    isTTY: false,
    composeAnalytics: silentAnalytics,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  await parent.parseAsync(['node', 'test', 'init', ...WEB_GEMINI])
}

// init draws its human output on stderr.
function stderr(): string {
  return stripVTControlCharacters(errors.mock.calls.map((call) => String(call[0])).join(''))
}

describe('init uses the nearest package.json', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('below a plain package.json the entry lands in the package.json above and the folder gets none', async () => {
    const root = gitRoot()
    writeJson(join(root, 'package.json'), { name: 'shop', private: true })
    const start = folder(root, 'tests', 'e2e')

    await init(start)

    expect(readJson(join(root, 'package.json'))).toEqual({
      name: 'shop',
      private: true,
      devDependencies: { 'agent-qa': getAgentQaVersion() },
    })
    expect(existsSync(join(start, 'package.json'))).toBe(false)
    expect(stderr()).toContain('✓ ../../package.json updated\n')
  })

  it("in a workspace member folder with no package.json the entry lands in the workspace root's package.json", async () => {
    const root = gitRoot()
    writeJson(join(root, 'package.json'), {
      name: 'monorepo',
      private: true,
      workspaces: ['packages/*'],
      devDependencies: { typescript: '6.0.0' },
    })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    const member = folder(root, 'packages', 'web')

    await init(member)

    expect(readJson(join(root, 'package.json')).devDependencies).toEqual({
      'agent-qa': getAgentQaVersion(),
      typescript: '6.0.0',
    })
    expect(existsSync(join(member, 'package.json'))).toBe(false)
  })

  it('the walk stops at the git root', async () => {
    const outside = tempFolder('agent-qa-nearest-outside-')
    const above = writeJson(join(outside, 'package.json'), { name: 'outside', private: true })
    const repo = folder(outside, 'repo')
    mkdirSync(join(repo, '.git'))
    const start = folder(repo, 'app')

    await init(start)

    expect(readFileSync(join(outside, 'package.json'), 'utf8')).toBe(above)
    expect(existsSync(join(repo, 'package.json'))).toBe(false)
    expect(readJson(join(start, 'package.json'))).toEqual({
      name: 'app',
      private: true,
      devDependencies: { 'agent-qa': getAgentQaVersion() },
    })
  })

  it('a package.json in the home folder is never used', async () => {
    const home = tempFolder('agent-qa-nearest-home-')
    const homePackageJson = writeJson(join(home, 'package.json'), { name: 'home', private: true })
    const top = folder(home, 'projects')
    const start = folder(top, 'shop')

    const range = await projectRange(start, { homedir: home, io: defaultProjectIo })
    expect(range.folders).toEqual([realpathSync(start), realpathSync(top)])

    await init(start, home)

    expect(readFileSync(join(home, 'package.json'), 'utf8')).toBe(homePackageJson)
    expect(existsSync(join(top, 'package.json'))).toBe(false)
    expect(readJson(join(start, 'package.json')).devDependencies).toEqual({
      'agent-qa': getAgentQaVersion(),
    })
  })

  it('the config and the scaffold stay in the current folder', async () => {
    const root = gitRoot()
    writeJson(join(root, 'package.json'), { name: 'shop', private: true })
    const start = folder(root, 'qa')

    await init(start)

    for (const file of [
      'agent-qa.config.yaml',
      'hooks.yaml',
      '.gitignore',
      join('tests', 'examples', 'komazon-checkout.yaml'),
      join('agent-qa-knowledge', 'AGENTS.md'),
    ]) {
      expect(existsSync(join(start, file)), file).toBe(true)
      expect(existsSync(join(root, file)), file).toBe(false)
    }
  })

  it('a file: entry is left as declared', async () => {
    const root = gitRoot()
    const before = writeJson(join(root, 'package.json'), {
      name: 'demo',
      private: true,
      devDependencies: { 'agent-qa': 'file:../x', zod: '4.0.0' },
    })

    await init(root)

    const after = readFileSync(join(root, 'package.json'), 'utf8')
    expect(after).toContain('    "agent-qa": "file:../x",\n')
    expect(after).toBe(before)
  })
})
