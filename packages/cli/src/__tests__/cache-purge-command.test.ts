// Purges at once with no prompt and no `--force`; fixtures use throwaway temp directories.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { sha256hex16 } from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ readlineCalls: [] as string[] }))

// A prompt that is still wired answers "no", so a surviving confirmation fails on the removal
// assertions below rather than hanging the worker.
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>()
  return {
    ...actual,
    createInterface: vi.fn(() => ({
      close: vi.fn(),
      question: (question: string, answer: (value: string) => void) => {
        harness.readlineCalls.push(question)
        answer('n')
      },
    })),
  }
})

import { createCacheCommand, purgeAll } from '../commands/cache.js'

interface Workspace {
  root: string
  configPath: string
  cacheDir: string
}

interface Invocation {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
  commanderError?: CommanderError
  stdinTouches: string[]
}

const STDIN_METHODS = [
  'read', 'on', 'once', 'addListener', 'prependListener', 'resume', 'pipe', 'setRawMode',
] as const

function workspaceFixture(roots: string[]): Workspace {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-cache-${randomUUID()}-`))
  roots.push(root)
  const cacheDir = join(root, '.agent-qa', 'cache')
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, `${JSON.stringify({
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    services: { cache: { dir: cacheDir } },
    use: { mobile: { appState: 'preserve' } },
  }, null, 2)}\n`, 'utf8')
  return { root, configPath, cacheDir }
}

function seedEntry(cacheDir: string, branch: string, key: string): string {
  mkdirSync(join(cacheDir, branch), { recursive: true })
  const path = join(cacheDir, branch, `${key}.json`)
  writeFileSync(path, '{"schemaVersion":10,"value":{}}')
  return path
}

function tree(root: string): string[] {
  if (!existsSync(root)) return []
  const paths: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      paths.push(relative(root, path))
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return paths.sort()
}

function setTerminal(tty: boolean): void {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: tty })
  }
}

async function invoke(workspace: Workspace, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdinTouches: string[] = []
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    }),
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      stdout.push(`${values.map(String).join(' ')}\n`)
    }),
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      stderr.push(`${values.map(String).join(' ')}\n`)
    }),
  ]
  const stdin = process.stdin as unknown as Record<string, unknown>
  const originals = new Map<string, { own: boolean; value: unknown }>()
  for (const method of STDIN_METHODS) {
    originals.set(method, { own: Object.hasOwn(stdin, method), value: stdin[method] })
    stdin[method] = () => {
      stdinTouches.push(method)
      throw new Error(`stdin.${method} is forbidden in a cache purge`)
    }
  }
  process.exitCode = undefined
  let commanderError: CommanderError | undefined
  try {
    const cache = createCacheCommand()
    const program = new Command().option('--config <path>', 'config file path').addCommand(cache)
    for (const command of [program, cache, ...cache.commands]) command.exitOverride()
    try {
      await program.parseAsync(['node', 'agent-qa', '--config', workspace.configPath, 'cache', ...args])
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error
      commanderError = error
    }
  } finally {
    for (const [method, original] of originals) {
      if (original.own) stdin[method] = original.value
      else delete stdin[method]
    }
    for (const spy of spies) spy.mockRestore()
  }
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: process.exitCode,
    ...(commanderError === undefined ? {} : { commanderError }),
    stdinTouches,
  }
}

describe('cache purge executes declared intent', () => {
  const roots: string[] = []
  let exitCode: typeof process.exitCode
  const ttys = new Map<NodeJS.ReadStream | NodeJS.WriteStream, boolean | undefined>()

  beforeEach(() => {
    exitCode = process.exitCode
    for (const stream of [process.stdin, process.stdout, process.stderr]) ttys.set(stream, stream.isTTY)
    setTerminal(false)
    harness.readlineCalls.splice(0)
  })

  afterEach(() => {
    process.exitCode = exitCode
    for (const [stream, value] of ttys) {
      Object.defineProperty(stream, 'isTTY', { configurable: true, value })
    }
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  describe('cache purge asks no question', () => {
    it('purge --all removes exactly the selected cache from a non-TTY with stdin forbidden', async () => {
      const workspace = workspaceFixture(roots)
      for (let i = 0; i < 3; i++) seedEntry(workspace.cacheDir, 'main', sha256hex16(`main-${i}`))
      for (let i = 0; i < 2; i++) seedEntry(workspace.cacheDir, 'feature-z', sha256hex16(`feature-${i}`))
      const sibling = join(workspace.root, '.agent-qa', 'runs', 'keep.json')
      mkdirSync(join(workspace.root, '.agent-qa', 'runs'), { recursive: true })
      writeFileSync(sibling, '{"kept":true}\n')
      const outsideBefore = tree(workspace.root).filter((path) => !path.startsWith('.agent-qa/cache'))

      const result = await invoke(workspace, ['purge', '--all'])

      expect(result.commanderError).toBeUndefined()
      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('Purged 5 cached plans (all)')
      expect(existsSync(workspace.cacheDir)).toBe(true)
      expect(readdirSync(workspace.cacheDir)).toEqual([])
      expect(tree(workspace.root).filter((path) => !path.startsWith('.agent-qa/cache'))).toEqual(
        outsideBefore,
      )
      expect(readFileSync(sibling, 'utf8')).toBe('{"kept":true}\n')
      expect(harness.readlineCalls).toEqual([])
      expect(result.stdinTouches).toEqual([])
    })

    it('an interactive terminal is not asked either', async () => {
      setTerminal(true)
      const workspace = workspaceFixture(roots)
      seedEntry(workspace.cacheDir, 'main', 'abcabcabcabcabca')
      seedEntry(workspace.cacheDir, 'main', 'defdefdefdefdefd')

      const result = await invoke(workspace, ['purge', '--all'])

      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('Purged 2 cached plans (all)')
      expect(result.stdout).not.toContain('Aborted')
      expect(readdirSync(workspace.cacheDir)).toEqual([])
      expect(harness.readlineCalls).toEqual([])
      expect(result.stdinTouches).toEqual([])
    })

    it('the removed --test option is unknown before any deletion', async () => {
      const workspace = workspaceFixture(roots)
      const entry = seedEntry(workspace.cacheDir, 'main', 'abcabcabcabcabca')
      const testPath = join(workspace.root, 'tests', 'login.yaml')
      mkdirSync(join(workspace.root, 'tests'), { recursive: true })
      writeFileSync(testPath, 'url: https://example.com\nsteps:\n  - Click login\n')
      const before = tree(workspace.root)

      const result = await invoke(workspace, ['purge', '--test', testPath])

      expect(result.commanderError?.code).toBe('commander.unknownOption')
      expect(result.stderr).toContain("unknown option '--test'")
      expect(result.stdout).toBe('')
      expect(existsSync(entry)).toBe(true)
      expect(tree(workspace.root)).toEqual(before)
      expect(harness.readlineCalls).toEqual([])
    })
  })

  it('reports an empty or absent cache as success without asking', async () => {
    const empty = workspaceFixture(roots)
    mkdirSync(empty.cacheDir, { recursive: true })
    const emptyResult = await invoke(empty, ['purge', '--all'])
    expect(emptyResult.exitCode).toBeUndefined()
    expect(emptyResult.stdout).toContain('No cached plans found')

    const absent = workspaceFixture(roots)
    const absentResult = await invoke(absent, ['purge', '--all'])
    expect(absentResult.exitCode).toBeUndefined()
    expect(absentResult.stdout).toContain('No cached plans found')
    expect(existsSync(absent.cacheDir)).toBe(false)
    expect(harness.readlineCalls).toEqual([])
  })

  it('still requires an explicit selection and deletes nothing without one', async () => {
    const workspace = workspaceFixture(roots)
    const entry = seedEntry(workspace.cacheDir, 'main', 'abcabcabcabcabca')

    const result = await invoke(workspace, ['purge'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Specify --all')
    expect(existsSync(entry)).toBe(true)
    expect(harness.readlineCalls).toEqual([])
  })

  it('reports a cache root that is not a directory as an error and leaves it in place', async () => {
    const workspace = workspaceFixture(roots)
    mkdirSync(join(workspace.root, '.agent-qa'), { recursive: true })
    writeFileSync(workspace.cacheDir, 'not a cache directory\n')

    await expect(purgeAll(workspace.cacheDir)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(invoke(workspace, ['purge', '--all'])).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(readFileSync(workspace.cacheDir, 'utf8')).toBe('not a cache directory\n')
    expect(harness.readlineCalls).toEqual([])
  })
})
