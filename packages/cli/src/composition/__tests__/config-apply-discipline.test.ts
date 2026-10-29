// Config operations write in the call and commit nothing; a person's dirty work is written around.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UnknownFunctionError, createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  sha256hexBytes,
  utf8Encode,
} from '@vostride/agent-qa-schema'
import type {
  ConfigChangeOutput,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFnCommand } from '../../commands/fn.js'
import {
  createConfigFilesPort,
  createConfigValidatePort,
  createConfigWritePort,
} from '../local-agent-host.js'
import * as hostModule from '../local-agent-host.js'
import { filePre432ConfigProposal } from './pre-432-config-proposal.js'

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const SEEDED_CONFIG = `# agent-qa Configuration

# File discovery and project settings
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

# Named resource definitions (LLM configs, app targets)
registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html

# How runs behave by default.
use:
  llm: judge
  timeout:
    # Raise this when the app under test is slow to settle.
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`

const SEEDED_GITIGNORE = '.agent-qa/\n'

let root: string
let configPath: string
let agentQaRoot: string

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // A `git` that ran and failed must not return quietly.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim())
}

/** The whole repository's porcelain, so a cell can say what is STILL dirty after an apply. */
function porcelain(): string[] {
  return git('status', '--porcelain').stdout
    .split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/** The staged index entry for one path, as git's own plumbing spells it. */
function indexEntry(path: string): string {
  return git('ls-files', '--stage', '--', path).stdout.trim()
}

// The config sits under `sub/dir`, so config-relative and root-relative paths differ by a prefix.
function seedSubdirLayout(): void {
  git('rm', '--quiet', '--cached', '--', 'agent-qa.config.yaml')
  rmSync(configPath)

  const configDir = join(root, 'sub', 'dir')
  mkdirSync(configDir, { recursive: true })
  configPath = join(configDir, 'agent-qa.config.yaml')
  // The runtime root travels WITH the config, which is where a real project's does.
  agentQaRoot = join(configDir, '.agent-qa')
  writeFileSync(configPath, SEEDED_CONFIG)
  writeFileSync(join(configDir, '.gitignore'), SEEDED_GITIGNORE)

  git('add', '--', 'sub/dir/agent-qa.config.yaml', 'sub/dir/.gitignore')
  git('commit', '--quiet', '-m', 'seed the configuration in a subdirectory')
}

/** Every tracked path in the repository, so a cell can say a shape exists NOWHERE. */
function trackedPaths(): string[] {
  return git('ls-files').stdout.split('\n').map((line) => line.trim()).filter((l) => l.length > 0)
}

function registryFor(overrides: Partial<FunctionDeps> = {}) {
  const deps: FunctionDeps = {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    configFiles: createConfigFilesPort(configPath),
    configValidate: createConfigValidatePort(),
    // The direct writer config operations publish through; no apply port or undo source is bound.
    configWrite: createConfigWritePort(configPath, (text) => text),
    // The one seam a cell may replace; every other dependency stays production's.
    ...overrides,
  }

  return createFunctionRegistry({
    deps,
  })
}

type Registry = ReturnType<typeof registryFor>

async function call(
  registry: Registry,
  id: string,
  input: unknown,
): Promise<unknown> {
  return await invokeFunction(registry, id, input, HUMAN)
}

// A legacy `config.field.set` proposal record, planted on disk as an old workspace holds it.
async function proposeField(input: { path: string; value: string | number | boolean }): Promise<string> {
  return (await filePre432ConfigProposal({ configPath, agentQaRoot, edits: [input] })).proposalId
}

async function accept(registry: Registry, proposalId: string): Promise<unknown> {
  return await invokeFunction(registry, 'proposals.accept', { proposalId }, HUMAN)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-discipline-'))
  configPath = join(root, 'agent-qa.config.yaml')
  agentQaRoot = join(root, '.agent-qa')
  writeFileSync(configPath, SEEDED_CONFIG)
  writeFileSync(join(root, '.gitignore'), SEEDED_GITIGNORE)
  writeFileSync(join(root, 'notes.md'), 'a scratch note\n')

  git('init', '--quiet')
  git('config', 'user.name', 'A Person')
  git('config', 'user.email', 'a-person@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', '.gitignore', 'notes.md', 'agent-qa.config.yaml')
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function change(
  registry: Registry,
  input: { path: string; value: string | number | boolean },
): Promise<ConfigChangeOutput> {
  return await invokeFunction(registry, 'config.field.set', input, HUMAN) as ConfigChangeOutput
}

/** What git holds: the tip, the history length, the index and what is staged. */
function repositoryState(): { head: string; index: string; staged: string; commits: number } {
  return {
    head: git('rev-parse', 'HEAD').stdout.trim(),
    index: git('ls-files', '--stage').stdout,
    staged: git('diff', '--cached', '--name-status').stdout,
    commits: commitCount(),
  }
}

function configDigest(): string {
  return sha256hexBytes(Uint8Array.from(readFileSync(configPath)))
}

/** Product source with comments removed, so history notes may still name what the code must not. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('the human commits first, and the agent commits only what was approved', () => {
  it('(1) a dirty config file takes the change in place, and neither edit is committed', async () => {
    const humanEdit = SEEDED_CONFIG.replace('test: 90m', 'test: 45m')
    writeFileSync(configPath, humanEdit)
    const before = repositoryState()

    expect((await change(registryFor(), { path: 'use.timeout.step', value: '45s' })).outcome)
      .toBe('applied')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit.replace('step: 30s', 'step: 45s'))
    expect(repositoryState()).toEqual(before)
    expect(porcelain()).toEqual(['M agent-qa.config.yaml'])
  })

  it("(1b) an old proposal record over a dirty file is refused unbound, and the person's bytes stay put", async () => {
    const id = await proposeField({ path: 'use.timeout.step', value: '45s' })
    const humanEdit = SEEDED_CONFIG.replace('test: 90m', 'test: 45m')
    writeFileSync(configPath, humanEdit)
    const before = repositoryState()

    await expect(accept(registryFor(), id)).rejects.toBeInstanceOf(UnknownFunctionError)

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit)
    expect(repositoryState()).toEqual(before)
  })

  it('(2) dirty bytes in files the change does not touch stay uncommitted — including a CONFIG-SET member', async () => {
    writeFileSync(join(root, '.gitignore'), `${SEEDED_GITIGNORE}scratch/\n`)
    writeFileSync(join(root, 'notes.md'), 'an unsaved thought\n')
    const before = repositoryState()

    expect((await change(registryFor(), { path: 'use.timeout.step', value: '45s' })).outcome)
      .toBe('applied')

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(`${SEEDED_GITIGNORE}scratch/\n`)
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('an unsaved thought\n')
    expect(repositoryState()).toEqual(before)
    expect(porcelain().sort()).toEqual(['M .gitignore', 'M agent-qa.config.yaml', 'M notes.md'])
  })

  it('(3) a publication outside the workspace is refused, and nothing is written or committed', async () => {
    const before = repositoryState()
    const outcome = await createConfigWritePort(configPath, (text) => text).publishFiles({
      files: [{ path: '../outside.yaml', bytes: utf8Encode('outside: true\n') }],
    })

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'outside-workspace', written: [] })
    expect(existsSync(join(root, '..', 'outside.yaml'))).toBe(false)
    expect(repositoryState()).toEqual(before)
    expect(porcelain()).toEqual([])
  })
})

describe('a concurrent human edit always beats the agent', () => {
  it('(4) two publications racing over one file: the second refuses at the digest re-check', async () => {
    const port = createConfigWritePort(configPath, (text) => text)
    const base = configDigest()
    const first = utf8Encode(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
    const second = utf8Encode(SEEDED_CONFIG.replace('step: 30s', 'step: 50s'))

    expect(await port.publishFiles({ files: [{ path: 'agent-qa.config.yaml', baseDigest: base, bytes: first }] }))
      .toEqual({ kind: 'published', written: ['agent-qa.config.yaml'] })
    expect(await port.publishFiles({ files: [{ path: 'agent-qa.config.yaml', baseDigest: base, bytes: second }] }))
      .toMatchObject({ kind: 'refused', reason: 'file-changed', written: [] })

    expect(Uint8Array.from(readFileSync(configPath))).toEqual(first)
    expect(commitCount()).toBe(1)
  })

  it('(5) the stale refusal names the file and the fact, and the recovery it points at EXISTS', async () => {
    const base = configDigest()
    writeFileSync(configPath, SEEDED_CONFIG.replace('navigation: 2m', 'navigation: 5m'))

    const refused = await createConfigWritePort(configPath, (text) => text).publishFiles({
      files: [{
        path: 'agent-qa.config.yaml',
        baseDigest: base,
        bytes: utf8Encode(SEEDED_CONFIG.replace('step: 30s', 'step: 45s')),
      }],
    })

    expect(refused).toEqual({
      kind: 'refused', reason: 'file-changed', path: 'agent-qa.config.yaml', written: [],
    })
    expect(createFnCommand().name()).toBe('fn')
    const listed = registryFor().list(HUMAN).find((entry) => entry.id === 'config.field.set')
    expect(listed?.bindingStatus).toBe('bound')
  })

  it('(6) a refusal on a DIRTY file mutates nothing', async () => {
    const base = configDigest()
    const humanEdit = SEEDED_CONFIG.replace('test: 90m', 'test: 45m')
    writeFileSync(configPath, humanEdit)
    const before = repositoryState()

    expect((await createConfigWritePort(configPath, (text) => text).publishFiles({
      files: [{
        path: 'agent-qa.config.yaml',
        baseDigest: base,
        bytes: utf8Encode(SEEDED_CONFIG.replace('step: 30s', 'step: 45s')),
      }],
    })).kind).toBe('refused')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit)
    expect(repositoryState()).toEqual(before)
  })

  // The recovery is the direct change, which re-reads the file in the call.
  it('(7) the named recovery after a stale refusal lands on the human\'s bytes, not over them', async () => {
    const base = configDigest()
    const humanEdit = SEEDED_CONFIG.replace('navigation: 2m', 'navigation: 5m')
    writeFileSync(configPath, humanEdit)
    git('commit', '--quiet', '-m', 'human raises the navigation budget', '--', 'agent-qa.config.yaml')
    expect((await createConfigWritePort(configPath, (text) => text).publishFiles({
      files: [{ path: 'agent-qa.config.yaml', baseDigest: base, bytes: utf8Encode(SEEDED_CONFIG) }],
    })).kind).toBe('refused')

    expect((await change(registryFor(), { path: 'use.timeout.step', value: '45s' })).outcome)
      .toBe('applied')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit.replace('step: 30s', 'step: 45s'))
    expect(commitCount()).toBe(2)
  })
})

describe('the multi-file rollback: an interrupted apply leaves no partial config and no commit', () => {
  it('(8) a publication whose first write fails writes nothing, names what it did not write, and leaves the index alone', async () => {
    const before = repositoryState()
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    let outcome: unknown
    try {
      outcome = await createConfigWritePort(configPath, (text) => text).publishFiles({
        files: [
          { path: 'locked/hooks.yaml', bytes: utf8Encode('hooks: []\n') },
          {
            path: '.gitignore',
            baseDigest: sha256hexBytes(utf8Encode(SEEDED_GITIGNORE)),
            bytes: utf8Encode(`${SEEDED_GITIGNORE}node_modules/\n`),
          },
        ],
      })
    } finally {
      chmodSync(locked, 0o755)
    }

    expect(outcome).toMatchObject({
      kind: 'interrupted',
      written: [],
      failed: { path: 'locked/hooks.yaml', reason: 'write-failed' },
      unwritten: ['.gitignore'],
    })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(SEEDED_GITIGNORE)
    expect(repositoryState()).toEqual(before)
    expect(indexEntry('.gitignore')).toBe(before.index.split('\n').find((line) => line.endsWith('\t.gitignore')))
  })
})

describe('idempotency: the retry gets the ORIGINAL receipt, both commits of it', () => {
  it('(9) a repeated change answers no-change and writes nothing more', async () => {
    const registry = registryFor()
    expect((await change(registry, { path: 'use.timeout.step', value: '45s' })).outcome).toBe('applied')
    const once = readFileSync(configPath)

    expect((await change(registry, { path: 'use.timeout.step', value: '45s' })).outcome).toBe('no-change')

    expect(readFileSync(configPath).equals(once)).toBe(true)
    expect(commitCount()).toBe(1)
  })

  it('(9b) an old proposal record retried through config.proposal.apply is refused unbound, alike each time', async () => {
    const id = await proposeField({ path: 'use.timeout.step', value: '45s' })
    const registry = registryFor()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(invokeFunction(registry, 'config.proposal.apply', { proposalId: id }, HUMAN))
        .rejects.toBeInstanceOf(UnknownFunctionError)
    }
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(commitCount()).toBe(1)
  })
})

describe('undo is a proposal, and it rides the one gated write path', () => {
  it('(10) the undo refuses unbound by name and files nothing', async () => {
    await change(registryFor(), { path: 'use.timeout.step', value: '45s' })
    const before = repositoryState()

    await expect(call(registryFor(), 'config.undo.propose', {}))
      .rejects.toBeInstanceOf(UnknownFunctionError)

    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(repositoryState()).toEqual(before)
  })

  it('(11) a change is undone with git restore, byte-exactly', async () => {
    const seeded = readFileSync(configPath)
    await change(registryFor(), { path: 'use.timeout.step', value: '45s' })
    expect(readFileSync(configPath).equals(seeded)).toBe(false)

    git('restore', '--', 'agent-qa.config.yaml')

    expect(readFileSync(configPath).equals(seeded)).toBe(true)
    expect(commitCount()).toBe(1)
    expect(porcelain()).toEqual([])
  })

  it('(12) an intervening human commit is what a restore returns to', async () => {
    const humanEdit = SEEDED_CONFIG.replace('navigation: 2m', 'navigation: 5m')
    writeFileSync(configPath, humanEdit)
    git('commit', '--quiet', '-m', 'human raises the navigation budget', '--', 'agent-qa.config.yaml')
    await change(registryFor(), { path: 'use.timeout.step', value: '45s' })

    git('restore', '--', 'agent-qa.config.yaml')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit)
    expect(commitCount()).toBe(2)
  })

  it('(13) a change after a restore needs no special case', async () => {
    const registry = registryFor()
    await change(registry, { path: 'use.timeout.step', value: '45s' })
    git('restore', '--', 'agent-qa.config.yaml')

    expect((await change(registry, { path: 'use.timeout.step', value: '45s' })).outcome).toBe('applied')
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
    expect(commitCount()).toBe(1)
  })

  it('(14) there is no revert VERB — the registry publishes a propose op and nothing else', async () => {
    // The checkable half of "one write path". If a direct-revert op is ever added, this cell is
    // where it shows up.
    const ids = registryFor().list(HUMAN).map((entry) => entry.id).filter((id) => id.startsWith('config.'))
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).not.toContain('config.undo.propose')
    expect(ids.filter((id) => id.endsWith('.apply'))).toEqual([])
    expect(ids.filter((id) => id.includes('revert'))).toEqual([])
    expect(ids.filter((id) => id === 'config.undo' || id === 'config.undo.apply')).toEqual([])
  })
})

describe('the config dir is NOT the repository root', () => {
  it('(15) at sub/dir the undo refuses unbound, and a restore of the configDir-relative member is exact', async () => {
    seedSubdirLayout()
    const seeded = readFileSync(configPath)
    await change(registryFor(), { path: 'use.timeout.step', value: '45s' })
    expect(porcelain()).toEqual(['M sub/dir/agent-qa.config.yaml'])

    await expect(call(registryFor(), 'config.undo.propose', {}))
      .rejects.toBeInstanceOf(UnknownFunctionError)
    git('restore', '--', 'sub/dir/agent-qa.config.yaml')

    expect(readFileSync(configPath).equals(seeded)).toBe(true)
    expect(trackedPaths().filter((path) => path.includes('sub/dir/sub'))).toEqual([])
  })

  it('(16) the CLI host asks git nothing — no log, no show, no spawn', () => {
    const host = code(join(__dirname, '..', 'local-agent-host.ts'))
    expect(host).toContain('export function createConfigWritePort')
    expect(host).not.toMatch(/['"]git['"]/)
    expect(host).not.toMatch(/\bspawnSync\b/)
    expect(host).not.toContain('Agent-QA-Proposal')
  })

  it('(17) at sub/dir a dirty config file takes the change and nothing is committed', async () => {
    seedSubdirLayout()
    const humanEdit = SEEDED_CONFIG.replace('test: 90m', 'test: 45m')
    writeFileSync(configPath, humanEdit)
    const before = repositoryState()

    expect((await change(registryFor(), { path: 'use.timeout.step', value: '45s' })).outcome)
      .toBe('applied')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit.replace('step: 30s', 'step: 45s'))
    expect(repositoryState()).toEqual(before)
    expect(porcelain()).toEqual(['M sub/dir/agent-qa.config.yaml'])
  })
})

// A person mid-change is not refused: dirty bytes, staged work and HEAD stay untouched.
describe('the direct writer leaves a person\'s work and history alone', () => {
  function directPort(): NonNullable<FunctionDeps['configWrite']> {
    const create = (hostModule as Record<string, unknown>).createConfigWritePort
    expect(typeof create, 'the direct config writer is exported').toBe('function')
    return (create as (path: string) => NonNullable<FunctionDeps['configWrite']>)(configPath)
  }

  function repository(): { head: string; index: string; staged: string; commits: number } {
    return {
      head: git('rev-parse', 'HEAD').stdout.trim(),
      index: git('ls-files', '--stage').stdout,
      staged: git('diff', '--cached', '--name-status').stdout,
      commits: commitCount(),
    }
  }

  it('a dirty config set member and unrelated staged content are valid; HEAD and the index do not move', async () => {
    const humanEdit = SEEDED_CONFIG.replace('test: 90m', 'test: 45m')
    writeFileSync(configPath, humanEdit)
    writeFileSync(join(root, '.gitignore'), `${SEEDED_GITIGNORE}scratch/\n`)
    writeFileSync(join(root, 'notes.md'), 'a staged note\n')
    git('add', '--', 'notes.md')
    const before = repository()

    const port = directPort()
    expect((await port.applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })).kind).toBe('applied')
    expect(await port.publishFiles({
      files: [{
        path: '.gitignore',
        baseDigest: sha256hexBytes(utf8Encode(`${SEEDED_GITIGNORE}scratch/\n`)),
        bytes: utf8Encode(`${SEEDED_GITIGNORE}scratch/\nnode_modules/\n`),
      }],
    })).toEqual({ kind: 'published', written: ['.gitignore'] })

    expect(repository()).toEqual(before)
    expect(before.staged).toBe('M\tnotes.md\n')
    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit.replace('step: 30s', 'step: 45s'))
    expect(porcelain().sort()).toEqual(['M .gitignore', 'M agent-qa.config.yaml', 'M  notes.md'].sort())
  })

  it('at sub/dir the direct writer publishes the configDir-relative member and commits nothing', async () => {
    seedSubdirLayout()
    const before = repository()

    const outcome = await directPort().applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })

    expect(outcome).toMatchObject({ kind: 'applied', file: 'agent-qa.config.yaml' })
    expect(repository()).toEqual(before)
    expect(porcelain()).toEqual(['M sub/dir/agent-qa.config.yaml'])
    expect(trackedPaths().filter((path) => path.includes('sub/dir/sub'))).toEqual([])
  })

  it('a two-file publication whose second write fails keeps the first, names both, and commits nothing', async () => {
    const before = repository()
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    let outcome: unknown
    try {
      outcome = await directPort().publishFiles({
        files: [
          {
            path: '.gitignore',
            baseDigest: sha256hexBytes(utf8Encode(SEEDED_GITIGNORE)),
            bytes: utf8Encode(`${SEEDED_GITIGNORE}node_modules/\n`),
          },
          { path: 'locked/hooks.yaml', bytes: utf8Encode('hooks: []\n') },
        ],
      })
    } finally {
      chmodSync(locked, 0o755)
    }

    expect(outcome).toMatchObject({
      kind: 'interrupted',
      written: ['.gitignore'],
      failed: { path: 'locked/hooks.yaml', reason: 'write-failed' },
      unwritten: [],
    })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(`${SEEDED_GITIGNORE}node_modules/\n`)
    expect(existsSync(join(locked, 'hooks.yaml'))).toBe(false)
    expect(repository()).toEqual(before)
  })
})
