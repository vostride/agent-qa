// The CLI's CI posture: no colour without a terminal, and what resuming pending work needs.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PostProcessingStatus } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { preparationPendingWarning } from '../composition/in-process-run-execution.js'
import { renderPostProcessingSummaryLine, runPostRunTail } from '../curation/post-run-tail.js'
import type { PostVerdictHandoff } from '../curation/post-verdict-step.js'

type ApplyColorPosture = (env: NodeJS.ProcessEnv, stdoutIsTTY: boolean) => void

// The module applies the posture to this process on load; the worker's own environment is put back.
async function loadColorPosture(): Promise<ApplyColorPosture> {
  const saved = process.env.NO_COLOR
  try {
    return (await import('../color-posture.js')).applyColorPosture
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = saved
  }
}

describe('colour posture', () => {
  it('the posture turns colour off when stdout is not a terminal', async () => {
    const applyColorPosture = await loadColorPosture()
    const env: NodeJS.ProcessEnv = {}
    applyColorPosture(env, false)
    expect(env).toEqual({ NO_COLOR: '1' })

    const ciEnv: NodeJS.ProcessEnv = { CI: 'true' }
    applyColorPosture(ciEnv, false)
    expect(ciEnv).toEqual({ CI: 'true', NO_COLOR: '1' })
  })

  it('the posture leaves a terminal, FORCE_COLOR and an existing NO_COLOR alone', async () => {
    const applyColorPosture = await loadColorPosture()
    const cases: readonly { env: NodeJS.ProcessEnv; tty: boolean }[] = [
      { env: {}, tty: true },
      { env: { CI: 'true' }, tty: true },
      { env: { FORCE_COLOR: '1' }, tty: false },
      { env: { FORCE_COLOR: '' }, tty: false },
      { env: { NO_COLOR: '' }, tty: false },
      { env: { NO_COLOR: '0' }, tty: false },
      { env: { NO_COLOR: '1', FORCE_COLOR: '1' }, tty: true },
    ]
    for (const { env, tty } of cases) {
      const before = { ...env }
      applyColorPosture(env, tty)
      expect(env, JSON.stringify({ before, tty })).toEqual(before)
    }
  })
})

const RUN_ID = 'run_444_14_ci_pending'
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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-444-14-pending-'))
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
    log: { warn: (message) => lines.push(message), info: (message) => lines.push(message) },
    postVerdict,
    ...(executionContext === undefined ? {} : { executionContext }),
  })
  await tail.finish()
  const pending = lines.filter((message) => message.includes('hand-off pending'))
  expect(pending, String(executionContext)).toHaveLength(1)
  return pending[0]!
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
})
