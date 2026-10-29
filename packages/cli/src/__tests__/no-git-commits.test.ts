// C432-NO-GIT-COMMIT and C432-LEFTOVERS-UNREAD over ONE project.
//
// agent-qa makes no git commits. A config change, an authored test and a mark's knowledge fix
// are plain uncommitted edits: HEAD, the index and the history stay exactly where the person left
// them, and `git status` shows what changed. The earlier cells prove each publication alone
// (`proposal-author-attribution.test.ts`, `config-direct-write.test.ts`); this file drives all three
// through the shipped CLI composition IN ONE REPOSITORY, then again in a dirty tree and in a
// directory with no repository, and once more with the mark interrupted before its receipt, so a
// retried mark is seen to publish its fix once.
//
// old `grants.jsonl`, `.agent-qa/proposals/*.json` and `execution_audit.jsonl`
// files are never read again. A fresh project neither creates nor needs any of them; a project that
// still holds malformed ones — sealed so that any open, listing or stat under them fails — gets the
// same answers as a clean one, and the legacy bytes and modes are left exactly as they were.
//
// Every fixture lives in a temporary directory (the mark fixture's own `mkdtemp` root).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { invokeFunction, RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import type { RunsMarkOutcome } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import * as cliHost from '../composition/local-agent-host.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import { canonicalKnowledge, markFixture } from '../gates/__tests__/feedback-fixture.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const KNOWLEDGE_DIR = 'agent-qa-knowledge'
const DRAFT = 'tests/.agent-qa-drafts/draft.yaml'
const TARGET = 'tests/drafted.yaml'

const roots: string[] = []
const sealed: string[] = []

afterEach(() => {
  for (const path of sealed.splice(0)) {
    try { chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600) } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Fixture = ReturnType<typeof markFixture>

function project(): Fixture {
  const fixture = markFixture()
  roots.push(fixture.root)
  mkdirSync(join(fixture.root, 'tests', '.agent-qa-drafts'), { recursive: true })
  writeFileSync(join(fixture.root, DRAFT), 'name: a drafted test\n')
  return fixture
}

function gitIn(root: string): (...args: string[]) => string {
  return (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/** A repository whose first commit holds the config and the knowledge root, as a project's does. */
function commitProject(fixture: Fixture): (...args: string[]) => string {
  const git = gitIn(fixture.root)
  writeFileSync(join(fixture.root, '.gitignore'), '.agent-qa/\n')
  git('init', '--quiet')
  git('config', 'user.name', 'A Person')
  git('config', 'user.email', 'a-person@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', '.gitignore', CONFIG_FILE, KNOWLEDGE_DIR)
  git('commit', '--quiet', '-m', 'seed')
  return git
}

function repositoryState(git: (...args: string[]) => string): Record<string, string> {
  return {
    head: git('rev-parse', 'HEAD').trim(),
    count: git('rev-list', '--count', 'HEAD').trim(),
    index: git('ls-files', '--stage'),
    cached: git('diff', '--cached', '--name-status'),
    authors: git('log', '--format=%an <%ae>'),
  }
}

interface Publications {
  readonly mark: RunsMarkOutcome
  readonly config: unknown
  readonly test: unknown
}

/** The three publications D-07 names, each in its one call, through the shipped CLI composition. */
async function publishAll(fixture: Fixture): Promise<Publications> {
  const host = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    resolveExecutionContext: () => 'local-headless',
  })
  try {
    const config = await invokeFunction(
      host.registry, 'config.field.set', { path: 'use.workers', value: 2 }, CLI_FUNCTION_CALLER)
    const mark = RunsMarkOutcomeSchema.parse(await invokeFunction(
      host.registry, RUNS_MARK_FUNCTION_ID, { runId: fixture.handoff.runId, kind: 'false-fail' }, CLI_FUNCTION_CALLER))
    const test = cliHost.publishAuthoredTest({
      configPath: fixture.configPath,
      request: { draftPath: DRAFT, targetPath: TARGET },
    })
    return { mark, config, test }
  } finally {
    await host.close()
  }
}

function expectPublished(fixture: Fixture, published: Publications): void {
  expect(published.config).toMatchObject({ outcome: 'applied', fields: ['use.workers'] })
  expect(readFileSync(fixture.configPath, 'utf8')).toContain('workers: 2')
  expect(published.mark).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'applied', change: { kind: 'knowledge' } } } })
  expect(published.test).toMatchObject({ kind: 'written', filePath: TARGET })
  expect(existsSync(join(fixture.root, TARGET))).toBe(true)
}

function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

describe('three publications in one project leave git alone', () => {
  it('a config change, a mark fix and an authored test leave HEAD, the index and the history alone; git status shows each edit', async () => {
    const fixture = project()
    const git = commitProject(fixture)
    const before = repositoryState(git)

    expectPublished(fixture, await publishAll(fixture))

    expect(repositoryState(git), 'agent-qa committed, staged or authored something').toEqual(before)
    const status = git('status', '--porcelain', '--untracked-files=all')
    expect(status).toContain(` M ${CONFIG_FILE}`)
    expect(status).toContain(`?? ${TARGET}`)
    expect(status.split('\n').some((line) => line.slice(3).startsWith(`${KNOWLEDGE_DIR}/`)), status).toBe(true)
    expect(git('log', '--format=%s')).toBe('seed\n')
  }, 120_000)

  it('the same three land in a dirty tree, keeping the person\'s own uncommitted edit, and nothing is staged', async () => {
    const fixture = project()
    const git = commitProject(fixture)
    writeFileSync(join(fixture.root, '.gitignore'), '.agent-qa/\n# a person was here\n')
    git('add', '--', '.gitignore')
    writeFileSync(join(fixture.root, '.gitignore'), '.agent-qa/\n# a person was here\n# and still editing\n')
    const before = repositoryState(git)

    expectPublished(fixture, await publishAll(fixture))

    expect(repositoryState(git), 'the person\'s staged change moved or a commit was made').toEqual(before)
    expect(readFileSync(join(fixture.root, '.gitignore'), 'utf8')).toContain('# and still editing')
  }, 120_000)

  it('the same three land in a directory with no repository, and none is created', async () => {
    const fixture = project()
    expectPublished(fixture, await publishAll(fixture))
    expect(existsSync(join(fixture.root, '.git')), 'a repository was created').toBe(false)
  }, 120_000)

  // Repeated mark faults do not duplicate fixes (C432-MARK-RETRY-ONCE's claim, through the composed
  // CLI host): the receipt write is blocked once, the call fails, and the retry lands the same fix
  // without publishing it a second time — and still commits nothing.
  it('a mark interrupted before its receipt lands its fix once on retry, and commits nothing either time', async () => {
    const fixture = project()
    const git = commitProject(fixture)
    const before = repositoryState(git)
    const blocked = join(fixture.runDir, 'marks.jsonl.pending')
    mkdirSync(blocked)

    const host = composeCliLocalAgent({ agentQaRoot: fixture.agentQaRoot, configPath: fixture.configPath, resolveExecutionContext: () => 'local-headless' })
    try {
      await expect(invokeFunction(host.registry, RUNS_MARK_FUNCTION_ID,
        { runId: fixture.handoff.runId, kind: 'false-fail' }, CLI_FUNCTION_CALLER)).rejects.toThrow()
      expect(existsSync(join(fixture.runDir, 'marks.jsonl')), 'a receipt was written past the fault').toBe(false)
      const knowledgeAfterFault = canonicalKnowledge(fixture.knowledgeRoot)
      rmSync(blocked, { recursive: true, force: true })

      const retried = RunsMarkOutcomeSchema.parse(await invokeFunction(host.registry, RUNS_MARK_FUNCTION_ID,
        { runId: fixture.handoff.runId, kind: 'false-fail' }, CLI_FUNCTION_CALLER))
      expect(retried).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, disposition: { kind: 'applied' } } })
      expect(canonicalKnowledge(fixture.knowledgeRoot), 'the retry published the fix a second time').toEqual(knowledgeAfterFault)
      expect(readFileSync(join(fixture.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
      const again = RunsMarkOutcomeSchema.parse(await invokeFunction(host.registry, RUNS_MARK_FUNCTION_ID,
        { runId: fixture.handoff.runId, kind: 'false-fail' }, CLI_FUNCTION_CALLER))
      expect(again.kind).toBe('already-marked')
    } finally {
      await host.close()
    }
    expect(repositoryState(git)).toEqual(before)
  }, 120_000)
})

/** The pre-432 leftovers a workspace may still hold, malformed on purpose. */
function plantLegacy(fixture: Fixture): { readonly files: readonly string[]; readonly dirs: readonly string[] } {
  const grants = join(fixture.knowledgeRoot, 'grants.jsonl')
  writeFileSync(grants, '{"kind":"grant-issued","actionClass":"fn:runs.mark"\n\u0000garbled\n')
  const proposals = join(fixture.agentQaRoot, 'proposals')
  mkdirSync(join(proposals, 'claimed'), { recursive: true })
  writeFileSync(join(proposals, 'prop_0123456789ab.json'), '{"not":"a proposal"')
  writeFileSync(join(proposals, 'claimed', 'prop_0123456789ab.json'), '\u0000garbled')
  const rootAudit = join(fixture.agentQaRoot, 'execution_audit.jsonl')
  const runAudit = join(fixture.runDir, 'execution_audit.jsonl')
  writeFileSync(rootAudit, '{"decision":"ask"\n')
  writeFileSync(runAudit, 'not json at all\n')
  return { files: [grants, rootAudit, runAudit], dirs: [proposals] }
}

/** Whether a chmod seal binds this process: not as root, and not on Windows. */
const canSealFiles = process.platform !== 'win32' && process.getuid?.() !== 0

describe('legacy approval state is neither created, needed nor opened', () => {
  it('a fresh project publishes all three without creating a grant ledger, a proposal store or an execution audit', async () => {
    const fixture = project()
    expectPublished(fixture, await publishAll(fixture))
    expect(existsSync(join(fixture.knowledgeRoot, 'grants.jsonl'))).toBe(false)
    expect(existsSync(join(fixture.agentQaRoot, 'proposals'))).toBe(false)
    const audits = Object.keys(digestTree(fixture.root)).filter((path) => path.endsWith('execution_audit.jsonl'))
    expect(audits, 'an execution audit was written').toEqual([])
  }, 120_000)

  // 2026-10-03 (quick-261003-tsr, IN-17): a mode-0 seal binds no reader running as root, nor on
  // Windows, so there the cell could not measure "never opened"; it runs only where the seal holds,
  // and checks that it does.
  it.runIf(canSealFiles)('present malformed legacy files, sealed against any open, change no answer and are left byte- and mode-identical', async () => {
    const clean = project()
    const expected = await publishAll(clean)
    expectPublished(clean, expected)

    const fixture = project()
    const legacy = plantLegacy(fixture)
    const legacyBytes = Object.fromEntries(legacy.files.map((file) => [file, readFileSync(file, 'utf8')]))
    const legacyTree = digestTree(legacy.dirs[0]!)
    // Sealed: a reader that opened, listed or stat'ed under any of them could not answer.
    for (const file of legacy.files) { chmodSync(file, 0o000); sealed.push(file) }
    for (const dir of legacy.dirs) { chmodSync(dir, 0o000); sealed.push(dir) }
    expect(() => readFileSync(legacy.files[0]!), 'the seal did not take effect').toThrow()

    let published: Publications
    try {
      published = await publishAll(fixture)
    } finally {
      for (const path of [...legacy.files, ...legacy.dirs]) {
        expect(statSync(path).mode & 0o777, `${path} changed mode`).toBe(0)
      }
      for (const file of legacy.files) chmodSync(file, 0o600)
      for (const dir of legacy.dirs) chmodSync(dir, 0o700)
    }
    expectPublished(fixture, published)
    expect(published.mark.kind).toBe(expected.mark.kind)
    expect(published.config).toEqual(expected.config)
    expect(published.test).toEqual(expected.test)
    for (const file of legacy.files) expect(readFileSync(file, 'utf8'), file).toBe(legacyBytes[file])
    expect(digestTree(legacy.dirs[0]!), 'the legacy proposal tree changed').toEqual(legacyTree)
  }, 180_000)
})
