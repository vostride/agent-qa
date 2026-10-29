// Who a config-apply commit says proposed it.
//
// no door mints a config proposal any more — the config operations write
// in the call. The apply path still read the records already on disk until 432-16/17.
//
// agent-qa MAKES NO GIT COMMITS, so there is no author to attribute. The
// one-commit config apply, its human-first preserve commit, the `Agent-QA-Proposal:` trailer and
// the per-surface author map are deleted, and the CLI host binds no config apply port. The cells
// that read the author off `git log` are re-spelled as the claim that replaces them: a config
// change from every door — the co-hosted MCP endpoint included — writes the file and leaves HEAD,
// the index and the history where they were, and a pre-432 record handed to the old accept verb
// is refused by name without touching the file or the history.
//
// 430-REVIEW WR-01 IS CLOSED BY DELETION. It was a config proposal minted over the co-hosted MCP
// endpoint committing under an unrecorded surface: the dashboard's composition supplied no minting
// surface, so the commit's author read `unrecorded` although a known door had asked. The comment
// this file used to carry beside cell (1) said stored `origin.surface: 'dashboard'` values came
// only from dashboard-chat proposals; that was wrong, since co-hosted MCP proposals reached the same
// composition with no surface at all. Neither kind of record is applied or attributed now.
//
// MODEL-FREE. `chatModel` is unsupplied on every composition here, which is the shipped headless
// posture rather than a stub — `config.field.set` is a deterministic op and reaches no provider.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { invokeFunction, RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { composeDashboardDoor } from '../commands/dashboard.js'
import { MCP_FUNCTION_CALLER } from '../commands/mcp.js'
import * as cliHost from '../composition/local-agent-host.js'
import { composeCliLocalAgent, CLI_FUNCTION_CALLER } from '../composition/local-agent-host.js'
import { filePre432ConfigProposal } from '../composition/__tests__/pre-432-config-proposal.js'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'
import { SURFACE_ROSTER } from './conformance/roster.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The chat door's caller surface (`CHAT_SURFACE` until 432-17 deleted it with `mintingSurface`). */
const CHAT_SURFACE = 'chat'
const PACKAGES_ROOT = join(HERE, '..', '..', '..')

/**
 * A pre-432 config proposal's bytes, as the shipped propose path wrote them at commit `b87b4f48`
 * No `surface` is recorded in its origin.
 */
const LEGACY_FIXTURE = join(HERE, 'fixtures', 'legacy-config-proposal.json')

/** `config-apply-discipline.test.ts`'s seed, so the legacy record's `baseDigest` matches it. */
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

const CONFIG_FILE = 'agent-qa.config.yaml'

interface Workspace {
  readonly root: string
  readonly configPath: string
  readonly agentQaRoot: string
  git(...args: string[]): string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seedWorkspace(options: { readonly repository?: boolean } = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'proposal-author-'))
  roots.push(root)
  const configPath = join(root, CONFIG_FILE)
  const agentQaRoot = join(root, '.agent-qa')
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  writeFileSync(configPath, SEEDED_CONFIG)
  if (options.repository === false) return { root, configPath, agentQaRoot, git }
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n')
  git('init', '--quiet')
  git('config', 'user.name', 'A Person')
  git('config', 'user.email', 'a-person@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', '.gitignore', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'seed')

  return { root, configPath, agentQaRoot, git }
}

/** What git holds, read off git: the tip, the history length, the index and what is staged. */
function repositoryState(workspace: Workspace): Record<string, string> {
  return {
    head: workspace.git('rev-parse', 'HEAD').trim(),
    count: workspace.git('rev-list', '--count', 'HEAD').trim(),
    index: workspace.git('ls-files', '--stage'),
    cached: workspace.git('diff', '--cached', '--name-status'),
  }
}

interface Door {
  readonly name: string
  readonly caller: FunctionCaller
  readonly compose: (workspace: Workspace) => {
    readonly registry: Parameters<typeof invokeFunction>[0]
    close(): Promise<void>
  }
}

/**
 * The doors a config change arrives through. The co-hosted MCP endpoint is the dashboard door's
 * own registry (`composeDashboardDoor`, which `mountCoHostedMcp` serves) called by an MCP caller;
 * that composition supplies no minting surface, which is the WR-01 arrangement.
 */
const DOORS: readonly Door[] = [
  {
    name: 'cli',
    caller: CLI_FUNCTION_CALLER,
    compose: (workspace) => composeCliLocalAgent({
      agentQaRoot: workspace.agentQaRoot,
      configPath: workspace.configPath,
    }),
  },
  {
    name: 'chat',
    caller: { ...CLI_FUNCTION_CALLER, surface: CHAT_SURFACE },
    compose: (workspace) => composeCliLocalAgent({
      agentQaRoot: workspace.agentQaRoot,
      configPath: workspace.configPath,
    }),
  },
  {
    name: 'mcp',
    // the one tokenless MCP caller. 2026-10-02: the legacy full scope set it
    // carried is deleted with the caller field; nothing read it.
    caller: MCP_FUNCTION_CALLER,
    compose: (workspace) => composeCliLocalAgent({
      agentQaRoot: workspace.agentQaRoot,
      configPath: workspace.configPath,
    }),
  },
  {
    name: 'co-hosted mcp',
    // the one tokenless MCP caller. 2026-10-02: the legacy full scope set it
    // carried is deleted with the caller field; nothing read it.
    caller: MCP_FUNCTION_CALLER,
    compose: (workspace) => composeDashboardDoor({
      agentQaRoot: workspace.agentQaRoot,
      configPath: workspace.configPath,
      boundOrigin: () => undefined,
    }).host,
  },
]

async function changeStep(door: Door, workspace: Workspace): Promise<{ outcome: string }> {
  const host = door.compose(workspace)
  try {
    return await invokeFunction(
      host.registry, 'config.field.set', { path: 'use.timeout.step', value: '45s' }, door.caller,
    ) as { outcome: string }
  } finally {
    await host.close()
  }
}

/** The pre-432 accept, from the host where a person used to accept proposals. */
async function acceptPre432(workspace: Workspace, proposalId: string): Promise<unknown> {
  const host = composeCliLocalAgent({
    agentQaRoot: workspace.agentQaRoot,
    configPath: workspace.configPath,
    resolveExecutionContext: () => 'local-interactive',
  })
  try {
    return await invokeFunction(
      host.registry, 'proposals.accept', { proposalId }, CLI_FUNCTION_CALLER,
    )
  } finally {
    await host.close()
  }
}

/** Product source with comments removed, so history notes may name what the code must not do. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/**
 * A git argv that makes history: `commit` or `add` followed by one of their own flags or the `--`
 * separator. The curation drain's `'commit'` stage name is followed by an ordinary argument and is
 * not matched.
 */
const GIT_HISTORY_ARGV = /['"](?:commit|add|update-index)['"]\s*,\s*['"]--?[a-z-]*['"]/u

function historyWritingSources(): string[] {
  const hits: string[] = []
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSorted(dir)) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      const rel = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else if (/\.[cm]?tsx?$/u.test(entry.name) && !/\.test(?:-d)?\.[cm]?tsx?$/u.test(entry.name)) {
        if (GIT_HISTORY_ARGV.test(code(full))) hits.push(rel)
      }
    }
  }
  for (const pkg of readdirSorted(PACKAGES_ROOT)) {
    if (!pkg.isDirectory()) continue
    const src = join(PACKAGES_ROOT, pkg.name, 'src')
    try {
      walk(src, `${pkg.name}/src`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return hits
}

function readdirSorted(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
}

describe('a config change has no author because it makes no commit', () => {
  it('the CLI host exports no commit, preserve-commit, trailer or author machinery', () => {
    const exported = Object.keys(cliHost)
    for (const name of [
      'applyConfigProposalAsOneCommit',
      'applyTestDraftAsOneCommit',
      'createConfigApplyPort',
      'createTestDraftApplyPort',
      'HUMAN_FIRST_COMMIT_SUBJECT',
      'AGENT_CONFIG_PROPOSAL_TRAILER_KEY',
      'AGENT_CONFIG_COMMIT_AUTHOR_BY_SURFACE',
      'AGENT_CONFIG_COMMIT_AUTHOR_UNRECORDED',
      'AGENT_CONFIG_COMMIT_AUTHOR_UNRECOGNISED',
      'CONFIG_COMMIT_AUTHOR_SURFACES',
      'agentConfigCommitAuthor',
      'runGitAdd',
      'runGitCommit',
      'runGitHeadHash',
      'runGitStatusPorcelain',
      'captureIndexEntry',
      'restoreIndexEntry',
      'APPLY_GIT_TIMEOUT_MS',
    ]) {
      expect(exported, name).not.toContain(name)
    }
    // The direct writers that replaced them are what the host exports instead.
    expect(exported).toContain('createConfigWritePort')
    expect(exported).toContain('publishAuthoredTest')
  })

  it('no product source passes git a commit, add or update-index argv', () => {
    // The matcher sees the shapes the deleted apply used, and not the drain's stage name.
    expect(GIT_HISTORY_ARGV.test("['commit', '--quiet', '-m', message, '--', targetPath]")).toBe(true)
    expect(GIT_HISTORY_ARGV.test("'commit', '--quiet', '-m', message,")).toBe(true)
    expect(GIT_HISTORY_ARGV.test("exec('git', ['add', '--', targetPath]")).toBe(true)
    expect(GIT_HISTORY_ARGV.test("['update-index', '--index-info']")).toBe(true)
    expect(GIT_HISTORY_ARGV.test("recordFailure(report, 'commit', outcome.reason, job.candidateId)"))
      .toBe(false)

    expect(historyWritingSources()).toEqual([])
  })

  it.each(DOORS.map((door) => [door.name, door] as const))(
    'a config change over the %s door writes the file and leaves HEAD, the index and the history alone',
    async (_name, door) => {
      const workspace = seedWorkspace()
      const before = repositoryState(workspace)

      const answer = await changeStep(door, workspace)

      expect(answer.outcome).toBe('applied')
      expect(readFileSync(workspace.configPath, 'utf8'))
        .toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
      expect(repositoryState(workspace)).toEqual(before)
      expect(workspace.git('status', '--porcelain').trim()).toBe(`M ${CONFIG_FILE}`)
      expect(workspace.git('log', '--format=%an <%ae>')).not.toContain('agent-qa')
    },
  )

  it('a config change lands in a dirty tree and in a directory with no repository', async () => {
    const dirty = seedWorkspace()
    writeFileSync(join(dirty.root, 'notes.md'), 'a person\'s own work\n')
    writeFileSync(join(dirty.root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n# edited\n')
    dirty.git('add', '--', '.gitignore')
    const before = repositoryState(dirty)

    expect((await changeStep(DOORS[0] as Door, dirty)).outcome).toBe('applied')
    expect(repositoryState(dirty)).toEqual(before)
    expect(dirty.git('diff', '--cached', '--name-only').trim()).toBe('.gitignore')

    const bare = seedWorkspace({ repository: false })
    expect((await changeStep(DOORS[0] as Door, bare)).outcome).toBe('applied')
    expect(readFileSync(bare.configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
  })
})

// 432-16 task 2: the other two publications D-07 names — an authored test and a mark's fix — and
// the retry edge of a config change, each read back off git.
describe('every publication leaves the history alone', () => {
  it('a mark lands its gold, evidence and knowledge fix and leaves HEAD, the index and the history alone', async () => {
    const f = markFixture()
    roots.push(f.root)
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' })
    writeFileSync(join(f.root, '.gitignore'), '.agent-qa/\n')
    git('init', '--quiet')
    git('config', 'user.name', 'A Person')
    git('config', 'user.email', 'a-person@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    // The knowledge root is committed, as a project's is; the runtime root is not.
    git('add', '--', '.gitignore', CONFIG_FILE, 'agent-qa-knowledge')
    git('commit', '--quiet', '-m', 'seed')
    const state = (): Record<string, string> => ({
      head: git('rev-parse', 'HEAD').trim(),
      count: git('rev-list', '--count', 'HEAD').trim(),
      index: git('ls-files', '--stage'),
      cached: git('diff', '--cached', '--name-status'),
    })
    const before = state()

    const host = composeCliLocalAgent({
      agentQaRoot: f.agentQaRoot,
      configPath: f.configPath,
      resolveExecutionContext: () => 'local-headless',
    })
    let outcome: ReturnType<typeof RunsMarkOutcomeSchema.parse>
    try {
      outcome = RunsMarkOutcomeSchema.parse(await invokeFunction(
        host.registry, RUNS_MARK_FUNCTION_ID, { runId: f.handoff.runId, kind: 'false-fail' }, CLI_FUNCTION_CALLER,
      ))
    } finally {
      await host.close()
    }

    expect(outcome.kind).toBe('marked')
    if (outcome.kind !== 'marked') throw new Error('unreachable')
    // The fix was applied in the call — and applied as an uncommitted change under the knowledge root.
    expect(outcome.receipt.disposition.kind).toBe('applied')
    expect(state()).toEqual(before)
    expect(git('status', '--porcelain', '--', 'agent-qa-knowledge').trim()).not.toBe('')
    expect(git('log', '--format=%an <%ae>')).not.toContain('agent-qa')
  })

  it('an authored test is written to its target and leaves HEAD, the index and the history alone', () => {
    const workspace = seedWorkspace()
    mkdirSync(join(workspace.root, 'tests', '.agent-qa-drafts'), { recursive: true })
    writeFileSync(join(workspace.root, 'tests', '.agent-qa-drafts', 'draft.yaml'), 'name: a drafted test\n')
    const before = repositoryState(workspace)

    expect(cliHost.publishAuthoredTest({
      configPath: workspace.configPath,
      request: { draftPath: 'tests/.agent-qa-drafts/draft.yaml', targetPath: 'tests/drafted.yaml' },
    })).toMatchObject({ kind: 'written', filePath: 'tests/drafted.yaml' })

    expect(repositoryState(workspace)).toEqual(before)
    expect(workspace.git('status', '--porcelain', '--', 'tests/drafted.yaml').trim()).toBe('?? tests/drafted.yaml')
  })

  it('retrying the same config change answers no-change and still commits nothing', async () => {
    const workspace = seedWorkspace()
    const before = repositoryState(workspace)
    const door = DOORS[0] as Door

    expect((await changeStep(door, workspace)).outcome).toBe('applied')
    const once = readFileSync(workspace.configPath, 'utf8')
    expect((await changeStep(door, workspace)).outcome).toBe('no-change')

    expect(readFileSync(workspace.configPath, 'utf8')).toBe(once)
    expect(repositoryState(workspace)).toEqual(before)
  })
})

describe('an older config record is never applied or committed', () => {
  // RE-SPELLED 2026-10-01: cells (1)-(4) accepted a stored record and read its author off
  // `git log` — a dashboard-surfaced record (1), a chat-minted one (2), an unrecognised surface (4)
  // and a legacy record with none (3). The CLI host binds no config apply port now, so each of them
  // is refused by name before any file or ref moves. 432-17 deleted the accept verb itself, so the
  // refusal is now `UnknownFunctionError` rather than `FunctionNotBoundError`, and still nothing moves.
  const LEGACY_RECORD = JSON.parse(readFileSync(LEGACY_FIXTURE, 'utf8')) as {
    id: string
    origin: Record<string, unknown>
  }

  function plantLegacy(workspace: Workspace, surface?: string): string {
    const record = structuredClone(LEGACY_RECORD)
    if (surface !== undefined) record.origin.surface = surface
    mkdirSync(join(workspace.agentQaRoot, 'proposals'), { recursive: true })
    writeFileSync(
      join(workspace.agentQaRoot, 'proposals', `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    )
    return record.id
  }

  it.each([
    ['(1) a dashboard-surfaced record', 'dashboard'],
    ['(3) a legacy record with no surface', undefined],
    ['(4) a record naming a surface this build does not know', 'voice> <someone-else@example.invalid'],
  ] as const)('%s is refused as unknown, and the file and history stay put',
    async (_label, surface) => {
      const workspace = seedWorkspace()
      const id = plantLegacy(workspace, surface)
      // The legacy bytes record no surface at all, which is what made them a legacy envelope.
      expect(Object.keys(LEGACY_RECORD.origin)).not.toContain('surface')
      const before = repositoryState(workspace)

      vi.useFakeTimers({ toFake: ['Date'], now: Number(LEGACY_RECORD.origin.at) + 1 })
      try {
        await expect(acceptPre432(workspace, id)).rejects.toMatchObject({ name: 'UnknownFunctionError' })
      } finally {
        vi.useRealTimers()
      }

      expect(readFileSync(workspace.configPath, 'utf8')).toBe(SEEDED_CONFIG)
      expect(repositoryState(workspace)).toEqual(before)
      expect(workspace.git('status', '--porcelain').trim()).toBe('')
    })

  it('(2) a chat-minted record is refused as unknown, and the file and history stay put', async () => {
    const workspace = seedWorkspace()
    const { proposalId } = await filePre432ConfigProposal({
      configPath: workspace.configPath,
      agentQaRoot: workspace.agentQaRoot,
      edits: [{ path: 'use.timeout.step', value: '45s' }],
      surface: CHAT_SURFACE,
    })
    const before = repositoryState(workspace)

    await expect(acceptPre432(workspace, proposalId)).rejects.toMatchObject({ name: 'UnknownFunctionError' })

    expect(readFileSync(workspace.configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(repositoryState(workspace)).toEqual(before)
  })
})

describe('no door supplies a minting surface', () => {
  it('(5) no rostered door supplies a minting surface — the census, over the roster itself', () => {
    // RE-SPELLED 2026-10-01: `mintingSurface` stamped the proposal records the inbox held,
    // and is deleted with them. The census now proves no door module still supplies one.
    const MODULE_FOR_DOOR: Readonly<Record<string, string>> = {
      chat: 'chat.ts',
      mcp: 'mcp.ts',
      fn: 'fn.ts',
    }
    // the run-service door's exemption was its least-privilege scope list, deleted
    // with its tokens. It is exempt because it has no change route at all — it starts and reads runs.
    const CANNOT_MINT: Readonly<Record<string, string>> = {
      'run-service': 'no change route: the door starts runs and reads them',
    }
    expect(SURFACE_ROSTER.length).toBeGreaterThan(0)
    expect(
      Object.keys(MODULE_FOR_DOOR).sort(),
      'MODULE_FOR_DOOR must name exactly the rostered doors that CANNOT_MINT does not exempt',
    ).toEqual(
      SURFACE_ROSTER.map((entry) => entry.id)
        .filter((id) => CANNOT_MINT[id] === undefined)
        .sort(),
    )
    for (const entry of SURFACE_ROSTER) {
      if (CANNOT_MINT[entry.id] !== undefined) continue
      const module = MODULE_FOR_DOOR[entry.id]
      if (module === undefined) {
        throw new Error(`the roster carries a door this census has no module for: ${entry.id}.`)
      }
      const source = readFileSync(join(HERE, '..', 'commands', module), 'utf8')
      expect(`${entry.id}: ${source.includes('mintingSurface') ? 'supplies' : 'omits'}`)
        .toBe(`${entry.id}: omits`)
    }
  })
})
