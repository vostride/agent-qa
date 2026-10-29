// C445-KNOWLEDGE-GITIGNORE (445-06, D-22, D-34): a fresh workspace keeps the writer-authority SQLite files out of git (WINDOWS #510)

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { generateTestId } from '@vostride/agent-qa-ids'
import {
  WRITER_AUTHORITY_DB_FILE,
  acquireWriterLease,
  releaseLease,
} from '@vostride/agent-qa-knowledge-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { refuseWithoutRecordingTools } from './run-doors-fixture.js'
import {
  POPULATED_MODEL_ID,
  POPULATED_PASSING_STEP_TEXT,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv, trackTempRoot } from './spawned-chat.js'

const SQLITE_FILE = /\.sqlite(?:-wal|-shm|-journal)?$/u
const PRE_445_KNOWLEDGE_RULES = [
  'memory/index/',
  'memory/queue/',
  '.lease',
  '.epoch',
  '**/artifacts/',
  'skills/.staging/',
  '.*.agent-qa-init-*.tmp',
]

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface Leg extends Exit {
  output: string
}

interface Scene {
  init?: Leg
  run?: Leg
  rebuildIndex?: Leg
  drain?: Leg
  authorityExists?: boolean
  status?: string[]
  open?: { lease?: string; wal?: boolean; shm?: boolean; status?: string[]; released?: string }
  checkIgnore?: Record<string, number | null>
  refusal?: {
    init?: Leg
    missing?: Leg
    negated?: Leg
    configKeptAfterMissing?: boolean
    configKeptAfterNegated?: boolean
  }
  modelRequests?: number
  error?: string
}

const scene: Scene = {}
const children = new Set<ChildProcess>()
let model: StubModelServer | undefined
let target: FixtureServer | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workspace(label: string): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-445-06-${label}-`)))
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'qa@example.com'])
  git(root, ['config', 'user.name', 'agent-qa conformance'])
  return root
}

function git(
  root: string,
  args: readonly string[],
  cwd = root,
): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    env: hermeticEnv(root),
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout }
}

function porcelain(root: string): string[] {
  const result = git(root, ['status', '--porcelain', '--untracked-files=all'])
  if (result.status !== 0) throw new Error(`git status exited ${result.status}`)
  return result.stdout.split('\n').filter((line) => line !== '')
}

async function cli(root: string, args: readonly string[]): Promise<Leg> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    env: {
      ...hermeticEnv(root),
      ...populatedRunSpawnEnv(),
      CI: 'true',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  try {
    const exit = await new Promise<Exit>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => { settle({ code, signal }) })
    })
    return { ...exit, output }
  } finally {
    children.delete(child)
  }
}

function pointConfigAtStubs(root: string, modelBaseUrl: string, targetUrl: string): void {
  const configPath = join(root, 'agent-qa.config.yaml')
  const config = parse(readFileSync(configPath, 'utf8')) as {
    registry: { llms: unknown[]; targets: Record<string, unknown> }
    use: { llm: string }
    plugins?: unknown
  }
  config.registry.llms = [
    {
      name: 'stub',
      provider: 'openai-compatible',
      model: POPULATED_MODEL_ID,
      baseURL: modelBaseUrl,
    },
  ]
  config.registry.targets.local = { platform: 'web', url: targetUrl, environment: 'local' }
  config.use.llm = 'stub'
  delete config.plugins
  writeFileSync(configPath, stringify(config), 'utf8')
  writeFileSync(
    join(root, 'tests', 'sc3.yaml'),
    'name: SC3 knowledge gitignore probe\n'
      + `test-id: ${generateTestId()}\n`
      + 'target: local\n'
      + `steps:\n  - ${POPULATED_PASSING_STEP_TEXT}\n`,
    'utf8',
  )
}

function observeOpenConnection(root: string, knowledgeRoot: string): void {
  const open: NonNullable<Scene['open']> = {}
  scene.open = open
  const acquired = acquireWriterLease(knowledgeRoot, {
    afterMutationLockAcquired: () => {
      open.wal = existsSync(join(knowledgeRoot, `${WRITER_AUTHORITY_DB_FILE}-wal`))
      open.shm = existsSync(join(knowledgeRoot, `${WRITER_AUTHORITY_DB_FILE}-shm`))
      open.status = porcelain(root)
    },
  })
  open.lease = acquired.kind
  if (acquired.kind === 'acquired') {
    open.released = releaseLease({ knowledgeRoot, leaseId: acquired.leaseId }).kind
  }
}

function observeRules(knowledgeRoot: string, root: string): void {
  const paths = [
    '.writer-authority.sqlite-journal',
    'memory/komazon/bundles/.staging/fact.md',
    'memory/komazon/bundles/fact/record.md',
    'policies/global.md',
  ]
  scene.checkIgnore = {}
  for (const path of paths) {
    const absolute = join(knowledgeRoot, path)
    if (!existsSync(absolute)) {
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, 'fixture\n', 'utf8')
    }
    scene.checkIgnore[path] = git(root, ['check-ignore', '--quiet', '--', path], knowledgeRoot)
      .status
  }
}

async function driveRefusal(): Promise<void> {
  const refusal: NonNullable<Scene['refusal']> = {}
  scene.refusal = refusal
  const root = workspace('refusal')
  const knowledgeGitignore = join(root, 'agent-qa-knowledge', '.gitignore')
  const configPath = join(root, 'agent-qa.config.yaml')
  refusal.init = await cli(root, ['init', '--platform', 'web', '--dir', root])
  writeFileSync(knowledgeGitignore, [...PRE_445_KNOWLEDGE_RULES, ''].join('\n'), 'utf8')
  const config = readFileSync(configPath, 'utf8')
  refusal.missing = await cli(root, ['init', '--force', '--platform', 'web', '--dir', root])
  refusal.configKeptAfterMissing = readFileSync(configPath, 'utf8') === config
  const negated = [
    ...PRE_445_KNOWLEDGE_RULES,
    '.writer-authority.sqlite*',
    '!.writer-authority.sqlite',
  ]
  writeFileSync(knowledgeGitignore, [...negated, ''].join('\n'), 'utf8')
  refusal.negated = await cli(root, ['init', '--force', '--platform', 'web', '--dir', root])
  refusal.configKeptAfterNegated = readFileSync(configPath, 'utf8') === config
}

async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer()
  const root = workspace('sc3')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  scene.init = await cli(root, ['init', '--platform', 'web', '--dir', root])
  pointConfigAtStubs(root, model.baseUrl, target.url)
  scene.run = await cli(root, ['run', 'tests/sc3.yaml'])
  scene.rebuildIndex = await cli(root, ['knowledge', 'rebuild-index'])
  scene.drain = await cli(root, ['knowledge', 'drain'])
  scene.modelRequests = model.requests.length
  scene.authorityExists = existsSync(join(knowledgeRoot, WRITER_AUTHORITY_DB_FILE))
  scene.status = porcelain(root)
  observeOpenConnection(root, knowledgeRoot)
  observeRules(knowledgeRoot, root)
  await driveRefusal()
}

function seen(): string {
  return JSON.stringify(
    scene,
    (_key, value: unknown) => typeof value === 'string' && value.length > 600
      ? `…${value.slice(-600)}`
      : value,
    2,
  )
}

function exited(leg: Leg | undefined): Exit | undefined {
  return leg === undefined ? undefined : { code: leg.code, signal: leg.signal }
}

describe('C445-KNOWLEDGE-GITIGNORE', () => {
  beforeAll(async () => {
    refuseWithoutRecordingTools()
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    try {
      await drive()
    } catch (error) {
      scene.error = message(error)
    }
  })

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL')
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  })

  it('after a run and knowledge writes, git status shows no SQLite file in a fresh workspace', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.init), seen()).toEqual({ code: 0, signal: null })
    expect(exited(scene.run), seen()).toEqual({ code: 0, signal: null })
    expect(exited(scene.rebuildIndex), seen()).toEqual({ code: 0, signal: null })
    expect(exited(scene.drain), seen()).toEqual({ code: 0, signal: null })
    expect(scene.modelRequests, `the run reached the stub model\n${seen()}`).toBeGreaterThan(0)
    expect(scene.authorityExists, `the writer-authority database is on disk\n${seen()}`)
      .toBe(true)
    expect(scene.status, `git sees the committed knowledge root\n${seen()}`)
      .toContain('?? agent-qa-knowledge/README.md')
    expect(scene.status?.filter((line) => SQLITE_FILE.test(line)), seen()).toEqual([])
  })

  it('an open writer authority connection leaves its sidecars ignored', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.open?.lease, seen()).toBe('acquired')
    expect(scene.open?.wal, `the -wal sidecar exists while the connection is open\n${seen()}`)
      .toBe(true)
    expect(scene.open?.shm, `the -shm sidecar exists while the connection is open\n${seen()}`)
      .toBe(true)
    expect(scene.open?.status, seen()).toContain('?? agent-qa-knowledge/README.md')
    expect(scene.open?.status?.filter((line) => SQLITE_FILE.test(line)), seen()).toEqual([])
    expect(scene.open?.released, seen()).toBe('released')
  })

  it('the rule covers the journal and the bundle staging directory', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.checkIgnore, seen()).toEqual({
      '.writer-authority.sqlite-journal': 0,
      'memory/komazon/bundles/.staging/fact.md': 0,
      'memory/komazon/bundles/fact/record.md': 1,
      'policies/global.md': 1,
    })
  })

  it('init refuses an older knowledge gitignore that lacks the rule and says which line to add', () => {
    expect(scene.error, seen()).toBeUndefined()
    const refusal = scene.refusal
    expect(exited(refusal?.init), seen()).toEqual({ code: 0, signal: null })
    expect(refusal?.missing?.code, seen()).not.toBe(0)
    expect(refusal?.missing?.output, seen()).toContain('Add ".writer-authority.sqlite*"')
    expect(refusal?.missing?.output, seen())
      .not.toContain('Move ".writer-authority.sqlite*"')
    expect(refusal?.configKeptAfterMissing, `the refusal changed no config byte\n${seen()}`)
      .toBe(true)
    expect(refusal?.negated?.code, seen()).not.toBe(0)
    expect(refusal?.negated?.output, seen())
      .toContain('Move ".writer-authority.sqlite*" after any negation')
    expect(refusal?.configKeptAfterNegated, `the refusal changed no config byte\n${seen()}`)
      .toBe(true)
  })
})
