// The CLI's CI posture: stdout's colour follows the one colour rule, and what resuming pending
// work needs.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { colorEnabled, colorsFor, printLogLine } from '@vostride/agent-qa-core/run-text-output'
import type { PostProcessingStatus } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { preparationPendingWarning } from '../composition/in-process-run-execution.js'
import type { KnowledgeSummary } from '../curation/knowledge-summary.js'
import { renderPostProcessingSummaryLine, runPostRunTail } from '../curation/post-run-tail.js'
import type { PostVerdictHandoff } from '../curation/post-verdict-step.js'

type ApplyColorPosture = (env: NodeJS.ProcessEnv, stdoutIsTTY: boolean) => void

const POSTURE_RECORD = Symbol.for('agent-qa.color-posture')

// The module applies the posture to this process on load; the worker's own environment is put back
// and what the posture recorded of it is dropped.
async function loadColorPosture(): Promise<ApplyColorPosture> {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
  vi.resetModules()
  try {
    return (await import('../color-posture.js')).applyColorPosture
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    Reflect.deleteProperty(globalThis, POSTURE_RECORD)
  }
}

// picocolors.js lines 2-4, without its command-line flags.
function libraryReads(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean, platform: string): boolean {
  return (
    !env.NO_COLOR &&
    (!!env.FORCE_COLOR || platform === 'win32' || (stdoutIsTTY && env.TERM !== 'dumb') || !!env.CI)
  )
}

interface PostureCase {
  env: NodeJS.ProcessEnv
  tty: boolean
  after: NodeJS.ProcessEnv
}

const TURNS_OFF: readonly PostureCase[] = [
  { env: {}, tty: false, after: { NO_COLOR: '1' } },
  { env: { CI: 'false' }, tty: false, after: { CI: 'false', NO_COLOR: '1' } },
  { env: { CI: '0' }, tty: false, after: { CI: '0', NO_COLOR: '1' } },
  { env: { FORCE_COLOR: '0' }, tty: true, after: { FORCE_COLOR: '0', NO_COLOR: '1' } },
  { env: { FORCE_COLOR: 'false' }, tty: true, after: { FORCE_COLOR: 'false', NO_COLOR: '1' } },
  { env: { TERM: 'dumb' }, tty: true, after: { TERM: 'dumb', NO_COLOR: '1' } },
]

const FORCES_ON: readonly PostureCase[] = [
  {
    env: { GITHUB_ACTIONS: 'true' },
    tty: false,
    after: { GITHUB_ACTIONS: 'true', FORCE_COLOR: '1' },
  },
  { env: { FORCE_COLOR: '' }, tty: false, after: { FORCE_COLOR: '1' } },
]

const LEAVES_ALONE: readonly Omit<PostureCase, 'after'>[] = [
  { env: { CI: 'true' }, tty: false },
  { env: { FORCE_COLOR: '1' }, tty: false },
  { env: { NO_COLOR: '' }, tty: true },
  { env: { NO_COLOR: '1' }, tty: true },
  { env: { NO_COLOR: '0' }, tty: true },
  { env: {}, tty: true },
]

const AGREEMENT_ENVS: readonly NodeJS.ProcessEnv[] = [
  ...[...TURNS_OFF, ...FORCES_ON, ...LEAVES_ALONE].map(({ env }) => env),
  { NO_COLOR: '1', FORCE_COLOR: '1' },
  { CI: 'true', NO_COLOR: '1' },
  { CI: 'true', FORCE_COLOR: '0' },
  { CI: '' },
  { GITHUB_ACTIONS: 'FALSE' },
  { CI: 'false', GITHUB_ACTIONS: 'true' },
]

describe('colour posture', () => {
  it('sets NO_COLOR when the rule turns colour off for stdout', async () => {
    const applyColorPosture = await loadColorPosture()
    for (const { env, tty, after } of TURNS_OFF) {
      const copy = { ...env }
      applyColorPosture(copy, tty)
      expect(copy, JSON.stringify({ env, tty })).toEqual(after)
    }
  })

  it('sets FORCE_COLOR when the rule turns colour on and the colour library would not', async () => {
    const applyColorPosture = await loadColorPosture()
    for (const { env, tty, after } of FORCES_ON) {
      const copy = { ...env }
      applyColorPosture(copy, tty)
      expect(copy, JSON.stringify({ env, tty })).toEqual(after)
    }
  })

  it('leaves the environment alone when the colour library already reads it as the rule does', async () => {
    const applyColorPosture = await loadColorPosture()
    for (const { env, tty } of LEAVES_ALONE) {
      const copy = { ...env }
      applyColorPosture(copy, tty)
      expect(copy, JSON.stringify({ env, tty })).toEqual(env)
    }
  })

  it('makes the colour library read every environment as the rule does, on POSIX and on Windows', async () => {
    const applyColorPosture = await loadColorPosture()
    for (const platform of ['linux', 'win32']) {
      for (const env of AGREEMENT_ENVS) {
        for (const tty of [false, true]) {
          const copy = { ...env }
          applyColorPosture(copy, tty)
          expect(libraryReads(copy, tty, platform), JSON.stringify({ env, tty, platform })).toBe(
            colorEnabled(env, tty),
          )
        }
      }
    }
  })

  it("importing the module leaves this process's NO_COLOR and FORCE_COLOR as they were", async () => {
    vi.stubEnv('NO_COLOR', undefined)
    vi.stubEnv('FORCE_COLOR', undefined)
    vi.stubEnv('CI', '')
    vi.stubEnv('GITHUB_ACTIONS', '')
    try {
      await loadColorPosture()
      expect(process.env.NO_COLOR).toBeUndefined()
      expect(process.env.FORCE_COLOR).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the colour of each stream once the posture has run', () => {
  const RED_X = '\u001b[31mx\u001b[39m'
  const YELLOW = '\u001b[33m'
  const streams = [process.stdout, process.stderr] as const
  let savedTTY: (PropertyDescriptor | undefined)[] = []

  beforeEach(() => {
    savedTTY = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    Reflect.deleteProperty(globalThis, POSTURE_RECORD)
    streams.forEach((stream, index) => {
      const saved = savedTTY[index]
      if (saved === undefined) Reflect.deleteProperty(stream, 'isTTY')
      else Object.defineProperty(stream, 'isTTY', saved)
    })
  })

  // Runs the module as the CLI's first import does, in a process with these streams and variables.
  async function startCli(
    terminals: { stdout: boolean; stderr: boolean },
    env: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CI', 'GITHUB_ACTIONS', 'TERM']) {
      vi.stubEnv(name, env[name])
    }
    Object.defineProperty(process.stdout, 'isTTY', { value: terminals.stdout, configurable: true })
    Object.defineProperty(process.stderr, 'isTTY', { value: terminals.stderr, configurable: true })
    vi.resetModules()
    await import('../color-posture.js')
  }

  function coloured(): { stdout: boolean; stderr: boolean } {
    return {
      stdout: colorsFor(process.stdout).red('x') === RED_X,
      stderr: colorsFor(process.stderr).red('x') === RED_X,
    }
  }

  it('keeps colour on a terminal stderr when stdout goes to a file', async () => {
    await startCli({ stdout: false, stderr: true })

    expect(process.env.NO_COLOR).toBe('1')
    expect(coloured()).toEqual({ stdout: false, stderr: true })
  })

  it('prints a warning yellow on a terminal stderr when stdout goes to a file', async () => {
    await startCli({ stdout: false, stderr: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    printLogLine({ tag: 'server', level: 'warn', message: 'careful' })

    expect(String(warn.mock.calls[0]?.[0])).toContain(`${YELLOW}careful`)
  })

  it('keeps colour codes out of a stderr file when stdout is a terminal', async () => {
    await startCli({ stdout: true, stderr: false })

    expect(coloured()).toEqual({ stdout: true, stderr: false })
  })

  it('colours neither stream when both go to a file', async () => {
    await startCli({ stdout: false, stderr: false })

    expect(coloured()).toEqual({ stdout: false, stderr: false })
  })

  it.each([
    [{ NO_COLOR: '1' }],
    [{ FORCE_COLOR: '0' }],
    [{ FORCE_COLOR: 'false' }],
    [{ TERM: 'dumb' }],
  ])('colours neither stream, terminal or not, when the user set %j', async (env) => {
    await startCli({ stdout: false, stderr: true }, env)
    expect(coloured()).toEqual({ stdout: false, stderr: false })

    await startCli({ stdout: true, stderr: true }, env)
    expect(coloured()).toEqual({ stdout: false, stderr: false })
  })

  it.each([
    [{ FORCE_COLOR: '1' }],
    [{ FORCE_COLOR: '' }],
    [{ CI: 'true' }],
    [{ GITHUB_ACTIONS: 'true' }],
  ])('colours both streams, terminal or not, when the user set %j', async (env) => {
    await startCli({ stdout: false, stderr: false }, env)

    expect(coloured()).toEqual({ stdout: true, stderr: true })
  })

  it('reads a colour variable changed after the posture ran as it now stands', async () => {
    await startCli({ stdout: false, stderr: true })
    vi.stubEnv('NO_COLOR', 'yes')

    expect(coloured()).toEqual({ stdout: false, stderr: false })
  })

  it("reads an environment that is not the process's own as it is given", async () => {
    await startCli({ stdout: false, stderr: true })

    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false)
    expect(colorsFor(process.stderr, { NO_COLOR: '1' }).red('x')).toBe('x')
  })
})

const RUN_ID = 'run_ci_pending'
const WORKSPACE_KEPT = "resumes only if this workspace's .agent-qa/ is kept"
const ANALYSIS_LIMIT =
  `analysis: pending (${WORKSPACE_KEPT} and a later run or the daemon picks it up)`
const CURATION_LIMIT = `curation: pending (${WORKSPACE_KEPT} and a later local run picks it up)`
const PREPARATION_LIMIT =
  "It resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up."
const LOCAL_PREPARATION_PROMISE =
  'The next local run or daemon drain resumes eligible pending hand-offs.'
const PENDING_PATH = '/workspace/.agent-qa/runs/run/post-verdict-pending.json'
const PREPARATION_HEAD = `Run ${RUN_ID}: post-verdict hand-off pending; analysis is not yet queued.`
const POSTURES = ['handed-off', 'backlog-exhausted', 'none'] as const
const CI_CONTEXTS = ['ci', 'cloud'] as const

type Context = Parameters<typeof renderPostProcessingSummaryLine>[2]
type Posture = Parameters<typeof renderPostProcessingSummaryLine>[1]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The first two stages of the exit line, analysis then curation.
function stagesOf(
  analysis: string,
  curation: string,
  posture: Posture,
  context: Context,
): string[] {
  const status = { runId: RUN_ID, chips: { analysis, curation } } as PostProcessingStatus
  const line = renderPostProcessingSummaryLine(status, posture, context)
  return line.replace('post-processing — ', '').split(' · ').slice(0, 2)
}

async function tailPreparationLine(executionContext: Context): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-pending-'))
  roots.push(root)
  const lines: string[] = []
  const postVerdict: PostVerdictHandoff = {
    outcome: undefined,
    pendingPath: PENDING_PATH,
    takeAcquiredLease: () => undefined,
    takeUnclaimedLease: () => undefined,
  }
  const tail = runPostRunTail({
    runId: RUN_ID,
    agentQaRoot: join(root, '.agent-qa'),
    configPath: join(root, 'agent-qa.config.yaml'),
    configDir: root,
    knowledgeConfig: { dir: 'knowledge' },
    log: { warn: (message) => lines.push(message), detail: (message) => lines.push(message) },
    postVerdict,
    ...(executionContext === undefined ? {} : { executionContext }),
  })
  await tail.finish()
  const pending = lines.filter((message) => message.includes('hand-off pending'))
  expect(pending, String(executionContext)).toHaveLength(1)
  return pending[0]!
}

async function tailPreparationSummaries(executionContext: Context): Promise<KnowledgeSummary[]> {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-pending-'))
  roots.push(root)
  const summaries: KnowledgeSummary[] = []
  const tail = runPostRunTail({
    runId: RUN_ID,
    agentQaRoot: join(root, '.agent-qa'),
    configPath: join(root, 'agent-qa.config.yaml'),
    configDir: root,
    knowledgeConfig: { dir: 'knowledge' },
    log: {
      warn: () => undefined,
      detail: () => undefined,
      summary: (summary) => { summaries.push(summary) },
    },
    postVerdict: {
      outcome: undefined,
      pendingPath: PENDING_PATH,
      takeAcquiredLease: () => undefined,
      takeUnclaimedLease: () => undefined,
    },
    ...(executionContext === undefined ? {} : { executionContext }),
  })
  await tail.finish()
  return summaries
}

describe('the pending stage suffix in CI', () => {
  it('in CI a pending analysis stage says a later run or the daemon must pick it up in this workspace', () => {
    let checked = 0
    for (const context of CI_CONTEXTS) {
      for (const posture of POSTURES) {
        const stages = stagesOf('pending', 'complete', posture, context)
        expect(stages, `${context} ${posture}`).toEqual([ANALYSIS_LIMIT, 'curation: complete'])
        checked += 1
      }
    }
    expect(checked).toBe(6)
  })

  it('in CI a pending curation stage names only a later local run', () => {
    let checked = 0
    for (const context of CI_CONTEXTS) {
      for (const posture of POSTURES) {
        const [, curation] = stagesOf('complete', 'pending', posture, context)
        expect(curation, `${context} ${posture}`).toBe(CURATION_LIMIT)
        expect(curation).not.toContain('daemon')
        checked += 1
      }
    }
    expect(checked).toBe(6)
  })

  it('a finished stage carries no suffix in CI', () => {
    const finished = [['complete', 'failed'], ['failed', 'complete'], ['running', 'complete']]
    for (const context of CI_CONTEXTS) {
      for (const [analysis, curation] of finished) {
        expect(stagesOf(analysis!, curation!, 'handed-off', context), context)
          .toEqual([`analysis: ${analysis}`, `curation: ${curation}`])
      }
      expect(stagesOf('pending', 'pending', 'none', context))
        .toEqual([ANALYSIS_LIMIT, CURATION_LIMIT])
    }
  })

  it('outside CI the posture suffix is unchanged', () => {
    for (const context of ['local-interactive', 'local-headless', undefined] as const) {
      expect(stagesOf('pending', 'pending', 'handed-off', context), String(context)).toEqual([
        'analysis: pending (daemon will drain)',
        'curation: pending (deferred to a later local run)',
      ])
      expect(stagesOf('pending', 'pending', 'none', context))
        .toEqual(['analysis: pending', 'curation: pending'])
    }
  })

  it("the drive's preparation-pending warning in CI states the resume limit", async () => {
    for (const context of CI_CONTEXTS) {
      const line = await tailPreparationLine(context)
      expect(line).toBe(`${PREPARATION_HEAD} ${PREPARATION_LIMIT} Durable intent: ${PENDING_PATH}.`)
      expect(line).not.toContain(LOCAL_PREPARATION_PROMISE)
      expect(preparationPendingWarning(RUN_ID, PENDING_PATH, context)).toBe(line)
    }
    const local = await tailPreparationLine('local-headless')
    expect(local)
      .toBe(`${PREPARATION_HEAD} Durable intent: ${PENDING_PATH}. ${LOCAL_PREPARATION_PROMISE}`)
    expect(preparationPendingWarning(RUN_ID, PENDING_PATH, 'local-interactive')).toBe(local)
  })

  it("in CI a pending curation's summary carries the resume limit on its second line", async () => {
    const summary = (resume: string): KnowledgeSummary => ({
      runId: RUN_ID,
      learned: 0,
      held: 0,
      proposed: 0,
      items: [],
      instead: 'pending',
      unfinished: { notWritten: 0, resume },
    })
    for (const context of CI_CONTEXTS) {
      expect(await tailPreparationSummaries(context), context)
        .toEqual([summary(`${WORKSPACE_KEPT} and a later local run picks it up`)])
    }
    expect(await tailPreparationSummaries('local-headless'))
      .toEqual([summary('resumes on a later local run')])
  })
})
