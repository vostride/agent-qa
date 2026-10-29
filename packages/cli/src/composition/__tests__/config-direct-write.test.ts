// 432-07 D-05/D-07: generated config changes publish directly, through the dashboard's config
// transaction, with no proposal and no git process. Every fixture lives in its own temp directory.
//
// C432-CONFIG-OUTSIDE-EDIT  a queued field change merges onto the bytes on disk at its turn.
// C432-CONFIG-PATH-QUEUE    the direct writer and the dashboard's manager take turns on one path.
// C432-NO-GIT-COMMIT        dirty trees, staged content and no-git directories publish; HEAD and
//                           the index do not move.
// C432-CONFIG-DIRECT        whole-file publications check path and digest first, write atomically
//                           and report exactly what they wrote.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FunctionDeps } from '@vostride/agent-qa-agent'
import * as dashboard from '@vostride/agent-qa-dashboard'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as host from '../local-agent-host.js'

type ConfigWritePort = NonNullable<FunctionDeps['configWrite']>

const CONFIG_FILE = 'agent-qa.config.yaml'

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

const HOOKS_FILE = `hooks: []
`

let root: string
let configPath: string

function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function utf8(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, 'utf8'))
}

function writePort(path = configPath): ConfigWritePort {
  const create = (host as Record<string, unknown>).createConfigWritePort
  expect(typeof create, 'the direct config writer is exported beside the old apply port').toBe('function')
  return (create as (configPath: string, mask: (text: string) => string) => ConfigWritePort)(path, (text) => text)
}

function serializeConfigWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
  const serialize = (dashboard as Record<string, unknown>).serializeConfigWrite
  expect(typeof serialize, 'the per-path config queue is exported').toBe('function')
  return (serialize as typeof serializeConfigWrite)(path, work)
}

// Resolves once the test holds the path's write turn; nothing queued behind it runs until release.
async function holdQueue(path: string): Promise<{ held: Promise<void>; release: () => void }> {
  let release!: () => void
  let entered!: () => void
  const holding = new Promise<void>((resolve) => { entered = resolve })
  const held = serializeConfigWrite(path, () => new Promise<void>((resolve) => {
    release = resolve
    entered()
  }))
  await holding
  return { held, release: () => release() }
}

function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function targetChange(index: number) {
  return {
    op: 'set' as const,
    path: ['registry', 'targets', `t${index}`],
    value: { platform: 'web', url: `http://127.0.0.1:${4200 + index}/` },
  }
}

function targetNames(): string[] {
  const text = readFileSync(configPath, 'utf8')
  return [...text.matchAll(/^ {4}(t\d+):$/gm)].map((match) => match[1]!).sort()
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

function repositorySnapshot(): { head: string; index: string; staged: string; commits: string } {
  return {
    head: git('rev-parse', 'HEAD').trim(),
    index: git('ls-files', '--stage'),
    staged: git('diff', '--cached', '--name-status'),
    commits: git('rev-list', '--count', 'HEAD').trim(),
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'direct-config-'))
  configPath = join(root, CONFIG_FILE)
  writeFileSync(configPath, SEEDED_CONFIG)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('C432-CONFIG-OUTSIDE-EDIT: a generated change merges onto the file as it is at its turn', () => {
  it('a field change queued behind another writer keeps the outside edit made while it waited', async () => {
    const port = writePort()
    const { held, release } = await holdQueue(configPath)
    const pending = port.applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })
    // The change is now waiting in the queue; the owner edits the file before its turn comes.
    await settle()
    const outside = SEEDED_CONFIG.replace(
      '  parallel: false',
      '  # Added by the owner while the change waited.\n  parallel: true',
    )
    writeFileSync(configPath, outside)
    release()
    await held

    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'applied',
      file: CONFIG_FILE,
      baseRevision: sha(outside),
      revision: sha(outside.replace('step: 30s', 'step: 45s')),
    })
    expect(readFileSync(configPath, 'utf8')).toBe(outside.replace('step: 30s', 'step: 45s'))
  })

  it('an outside edit between two direct changes is kept by the second, comments and all', async () => {
    const port = writePort()
    expect((await port.applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })).kind).toBe('applied')
    const outside = readFileSync(configPath, 'utf8').replace('appState: reset', 'appState: preserve')
    writeFileSync(configPath, outside)
    expect((await port.applyFields({ changes: [targetChange(1)] })).kind).toBe('applied')

    const saved = readFileSync(configPath, 'utf8')
    expect(saved).toContain('appState: preserve')
    expect(saved).toContain('step: 45s')
    expect(saved).toContain('# Raise this when the app under test is slow to settle.')
    expect(targetNames()).toEqual(['t1'])
  })
})

describe('C432-CONFIG-PATH-QUEUE: the direct writer and the dashboard manager share one queue per path', () => {
  it('overlapping disjoint writes from both writers all land', async () => {
    const port = writePort()
    const manager = new dashboard.ConfigManager(configPath, (text) => text)
    const outcomes = await Promise.all(Array.from({ length: 20 }, async (_, index) =>
      index % 2 === 0
        ? (await port.applyFields({ changes: [targetChange(index)] })).kind
        : (await manager.applyChanges([targetChange(index)])).kind === 'ok' ? 'applied' : 'refused'))
    expect(outcomes).toEqual(Array.from({ length: 20 }, () => 'applied'))
    expect(targetNames()).toEqual(Array.from({ length: 20 }, (_, index) => `t${index}`).sort())
  })

  it('a stale same-field expectation refuses once the co-hosted writer changed that field', async () => {
    const port = writePort()
    const manager = new dashboard.ConfigManager(configPath, (text) => text)
    const [landed, stale] = await Promise.all([
      manager.applyChanges([
        { op: 'expect', path: ['use', 'timeout', 'step'], value: '30s' },
        { op: 'set', path: ['use', 'timeout', 'step'], value: '40s' },
      ]),
      port.applyFields({
        changes: [
          { op: 'expect', path: ['use', 'timeout', 'step'], value: '30s' },
          { op: 'set', path: ['use', 'timeout', 'step'], value: '50s' },
        ],
      }),
    ])
    expect(landed.kind).toBe('ok')
    expect(stale).toEqual({
      kind: 'refused',
      file: CONFIG_FILE,
      error: 'field_changed',
      path: ['use', 'timeout', 'step'],
    })
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 40s'))
  })

  it('a refused stale expectation succeeds on retry once it names the value the file now holds', async () => {
    const port = writePort()
    expect((await new dashboard.ConfigManager(configPath, (text) => text).applyChanges([
      { op: 'set', path: ['use', 'timeout', 'step'], value: '40s' },
    ])).kind).toBe('ok')
    const stale = await port.applyFields({
      changes: [
        { op: 'expect', path: ['use', 'timeout', 'step'], value: '30s' },
        { op: 'set', path: ['use', 'timeout', 'step'], value: '50s' },
      ],
    })
    expect(stale).toMatchObject({ kind: 'refused', error: 'field_changed' })
    const retried = await port.applyFields({
      changes: [
        { op: 'expect', path: ['use', 'timeout', 'step'], value: '40s' },
        { op: 'set', path: ['use', 'timeout', 'step'], value: '50s' },
      ],
    })
    expect(retried.kind).toBe('applied')
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 50s'))
  })

  it('a whole-file publication of the config built before a co-hosted change refuses and keeps that change', async () => {
    const generated = SEEDED_CONFIG.replace('appState: reset', 'appState: preserve')
    expect((await new dashboard.ConfigManager(configPath, (text) => text).applyChanges([
      { op: 'set', path: ['use', 'timeout', 'step'], value: '40s' },
    ])).kind).toBe('ok')
    expect(await writePort().publishFiles({
      files: [{ path: CONFIG_FILE, baseDigest: sha(SEEDED_CONFIG), bytes: utf8(generated) }],
    })).toEqual({ kind: 'refused', reason: 'file-changed', path: CONFIG_FILE, written: [] })
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 40s'))
  })

  it('a queued transaction that fails releases the direct writer behind it', async () => {
    const port = writePort()
    const failed = serializeConfigWrite(configPath, async () => {
      throw new Error('queued failure')
    })
    const successor = port.applyFields({ changes: [targetChange(7)] })
    await expect(failed).rejects.toThrow('queued failure')
    expect((await successor).kind).toBe('applied')
    expect(targetNames()).toEqual(['t7'])
  })
})

describe('C432-NO-GIT-COMMIT: direct config writes need no repository and leave git alone', () => {
  it('a dirty config and unrelated staged content publish without moving HEAD or the index', async () => {
    git('init', '--quiet')
    git('config', 'user.name', 'agent-qa direct config test')
    git('config', 'user.email', 'direct-config-test@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('add', '--', CONFIG_FILE)
    git('commit', '--quiet', '-m', 'seed')
    const human = SEEDED_CONFIG.replace('parallel: false', 'parallel: true')
    writeFileSync(configPath, human)
    writeFileSync(join(root, 'notes.md'), 'staged by the owner\n')
    git('add', '--', 'notes.md')
    const before = repositorySnapshot()

    const port = writePort()
    expect(await port.applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })).toMatchObject({ kind: 'applied', baseRevision: sha(human) })
    expect(await port.publishFiles({
      files: [{ path: 'hooks.yaml', bytes: utf8(HOOKS_FILE) }],
    })).toEqual({ kind: 'published', written: ['hooks.yaml'] })

    expect(repositorySnapshot()).toEqual(before)
    expect(before.staged).toBe('A\tnotes.md\n')
    expect(readFileSync(configPath, 'utf8')).toBe(human.replace('step: 30s', 'step: 45s'))
    expect(readFileSync(join(root, 'hooks.yaml'), 'utf8')).toBe(HOOKS_FILE)
    expect(git('status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M agent-qa.config.yaml',
      '?? hooks.yaml',
      'A  notes.md',
    ])
  })

  it('a directory with no repository publishes with no git on PATH', async () => {
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      const port = writePort()
      expect((await port.applyFields({
        changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
      })).kind).toBe('applied')
      expect(await port.publishFiles({
        files: [{ path: 'hooks.yaml', bytes: utf8(HOOKS_FILE) }],
      })).toEqual({ kind: 'published', written: ['hooks.yaml'] })
    } finally {
      process.env.PATH = path
    }
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
    expect(readFileSync(join(root, 'hooks.yaml'), 'utf8')).toBe(HOOKS_FILE)
  })
})

describe('C432-CONFIG-DIRECT: whole-file publications are checked, atomic and truthful', () => {
  it('publishes a new file and a changed file in the order given, leaving no temp files', async () => {
    const gitignore = '.agent-qa/\n'
    writeFileSync(join(root, '.gitignore'), gitignore)
    const outcome = await writePort().publishFiles({
      files: [
        { path: 'hooks.yaml', bytes: utf8(HOOKS_FILE) },
        { path: '.gitignore', baseDigest: sha(gitignore), bytes: utf8(`${gitignore}agent-qa-knowledge/\n`) },
      ],
    })
    expect(outcome).toEqual({ kind: 'published', written: ['hooks.yaml', '.gitignore'] })
    expect(readFileSync(join(root, 'hooks.yaml'), 'utf8')).toBe(HOOKS_FILE)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(`${gitignore}agent-qa-knowledge/\n`)
    expect(tempFiles(root)).toEqual([])
  })

  it('a stale digest, a file that appeared, an escaping path and a repeated path refuse before any write', async () => {
    const port = writePort()
    writeFileSync(join(root, '.gitignore'), 'owner bytes\n')

    expect(await port.publishFiles({
      files: [
        { path: 'hooks.yaml', bytes: utf8(HOOKS_FILE) },
        { path: '.gitignore', baseDigest: sha('what the change read\n'), bytes: utf8('x\n') },
      ],
    })).toEqual({ kind: 'refused', reason: 'file-changed', path: '.gitignore', written: [] })
    expect(await port.publishFiles({
      files: [{ path: '.gitignore', bytes: utf8('x\n') }],
    })).toEqual({ kind: 'refused', reason: 'file-changed', path: '.gitignore', written: [] })
    expect(await port.publishFiles({
      files: [{ path: '../escape.yaml', bytes: utf8('x\n') }],
    })).toEqual({ kind: 'refused', reason: 'outside-workspace', path: '../escape.yaml', written: [] })
    expect(await port.publishFiles({
      files: [
        { path: 'hooks.yaml', bytes: utf8(HOOKS_FILE) },
        { path: './hooks.yaml', bytes: utf8(HOOKS_FILE) },
      ],
    })).toEqual({ kind: 'refused', reason: 'duplicate-path', path: './hooks.yaml', written: [] })
    expect(await port.publishFiles({ files: [] })).toEqual({ kind: 'refused', reason: 'no-files', written: [] })

    const outsideDir = mkdtempSync(join(tmpdir(), 'direct-config-outside-'))
    try {
      writeFileSync(join(outsideDir, 'target.yaml'), 'outside\n')
      symlinkSync(join(outsideDir, 'target.yaml'), join(root, 'linked.yaml'))
      expect(await port.publishFiles({
        files: [{ path: 'linked.yaml', baseDigest: sha('outside\n'), bytes: utf8('x\n') }],
      })).toEqual({ kind: 'refused', reason: 'outside-workspace', path: 'linked.yaml', written: [] })
      expect(readFileSync(join(outsideDir, 'target.yaml'), 'utf8')).toBe('outside\n')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }

    expect(existsSync(join(root, 'hooks.yaml'))).toBe(false)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('owner bytes\n')
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
  })

  it('the transaction\'s own refusals pass through the direct writer and write nothing', async () => {
    const port = writePort()
    const invalid = await port.applyFields({
      changes: [{ op: 'set', path: ['use', 'parallel'], value: 'sometimes' }],
    })
    expect(invalid).toMatchObject({ kind: 'refused', file: CONFIG_FILE, error: 'validation_failed' })
    expect(invalid.kind === 'refused' ? invalid.issues?.map((issue) => issue.path) : undefined)
      .toContainEqual(['use', 'parallel'])
    expect(await port.applyFields({
      changes: [{ op: 'set', path: ['registry', 'llms', { name: 'absent' }, 'model'], value: 'x' }],
    })).toEqual({ kind: 'refused', file: CONFIG_FILE, error: 'path_not_found' })
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(tempFiles(root)).toEqual([])
  })

  it('a new file in a new directory inside the workspace is created there', async () => {
    expect(await writePort().publishFiles({
      files: [{ path: 'config/hooks/extra.yaml', bytes: utf8(HOOKS_FILE) }],
    })).toEqual({ kind: 'published', written: ['config/hooks/extra.yaml'] })
    expect(readFileSync(join(root, 'config', 'hooks', 'extra.yaml'), 'utf8')).toBe(HOOKS_FILE)
  })

  it('a publication through a symlink keeps the link and the destination mode', async () => {
    const realPath = join(root, 'real-hooks.yaml')
    writeFileSync(realPath, 'hooks: []\n')
    chmodSync(realPath, 0o600)
    symlinkSync(realPath, join(root, 'hooks.yaml'))
    const next = 'hooks:\n  - id: placeholder\n'
    expect(await writePort().publishFiles({
      files: [{ path: 'hooks.yaml', baseDigest: sha('hooks: []\n'), bytes: utf8(next) }],
    })).toEqual({ kind: 'published', written: ['hooks.yaml'] })
    expect(lstatSync(join(root, 'hooks.yaml')).isSymbolicLink()).toBe(true)
    expect(readFileSync(realPath, 'utf8')).toBe(next)
    expect(statSync(realPath).mode & 0o777).toBe(0o600)
  })

  it('a file that changes during publication stops it, naming what was written and what was not', async () => {
    writeFileSync(join(root, 'b.yaml'), 'b: 1\n')
    const { held, release } = await holdQueue(join(root, 'b.yaml'))
    const pending = writePort().publishFiles({
      files: [
        { path: 'a.yaml', bytes: utf8('a: 2\n') },
        { path: 'b.yaml', baseDigest: sha('b: 1\n'), bytes: utf8('b: 2\n') },
        { path: 'c.yaml', bytes: utf8('c: 2\n') },
      ],
    })
    await waitFor(() => existsSync(join(root, 'a.yaml')), 'the first file to be written')
    writeFileSync(join(root, 'b.yaml'), 'b: owner\n')
    release()
    await held

    expect(await pending).toEqual({
      kind: 'interrupted',
      written: ['a.yaml'],
      failed: { path: 'b.yaml', reason: 'file-changed' },
      unwritten: ['c.yaml'],
    })
    expect(readFileSync(join(root, 'a.yaml'), 'utf8')).toBe('a: 2\n')
    expect(readFileSync(join(root, 'b.yaml'), 'utf8')).toBe('b: owner\n')
    expect(existsSync(join(root, 'c.yaml'))).toBe(false)
  })

  it('a write that fails part way reports the files already written and invents nothing', async () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      const outcome = await writePort().publishFiles({
        files: [
          { path: 'first.yaml', bytes: utf8('first: 1\n') },
          { path: 'locked/member.yaml', bytes: utf8('member: 1\n') },
        ],
      })
      expect(outcome).toMatchObject({
        kind: 'interrupted',
        written: ['first.yaml'],
        failed: { path: 'locked/member.yaml', reason: 'write-failed' },
        unwritten: [],
      })
    } finally {
      chmodSync(locked, 0o755)
    }
    expect(readFileSync(join(root, 'first.yaml'), 'utf8')).toBe('first: 1\n')
    expect(existsSync(join(locked, 'member.yaml'))).toBe(false)
    expect(tempFiles(locked)).toEqual([])
  })
})
