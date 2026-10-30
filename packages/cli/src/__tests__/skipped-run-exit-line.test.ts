// Gate and outcome-excluded runs print the skipped exit line, and their tail starts no drain.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { POST_PROCESSING_SKIP_REASON_WORDS } from '@vostride/agent-qa-schema'
import type { PostProcessingSkipReason, PostProcessingStatus, RunDigest } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { runPostRunTail, type PostRunTailOperations } from '../curation/post-run-tail.js'
import type { PostVerdictHandoff } from '../curation/post-verdict-step.js'

const RUN_ID = 'run_skipped_exit_line'
const CONTEXTS = ['local-headless', 'ci'] as const

const DRAIN_OPERATIONS = [
  'resolveKnowledgeRoot',
  'recoverPendingPostVerdictContinuations',
  'acquireWriterLease',
  'releaseLease',
  'nudgeDaemon',
  'curateCompletedRun',
  'runCurationTail',
  'resolveRunCurationContext',
  'createChipEmitter',
  'loadCompletedRunHandoff',
] as const satisfies readonly (keyof PostRunTailOperations)[]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface SkippedTailRun {
  readonly lines: readonly string[]
  readonly warnings: readonly string[]
  readonly drainCalls: readonly string[]
  readonly leaseTakes: number
  readonly report: ReturnType<ReturnType<typeof runPostRunTail>['report']>
}

async function runSkippedTail(
  reason: PostProcessingSkipReason,
  executionContext: (typeof CONTEXTS)[number],
  detached: boolean,
): Promise<SkippedTailRun> {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-skipped-'))
  roots.push(root)
  const lines: string[] = []
  const warnings: string[] = []
  const drainCalls: string[] = []
  let leaseTakes = 0
  const postVerdict: PostVerdictHandoff = {
    outcome: undefined,
    enqueueState: 'skipped',
    takeAcquiredLease: () => undefined,
    takeUnclaimedLease: () => undefined,
  }
  const sentinels = Object.fromEntries(DRAIN_OPERATIONS.map((name) => [name, () => {
    drainCalls.push(name)
    throw new Error(`${name} ran for a skipped run`)
  }])) as unknown as Partial<PostRunTailOperations>
  const status = {
    runId: RUN_ID,
    chips: { analysis: 'pending', curation: 'pending' },
    skipped: { reason },
  } as PostProcessingStatus
  const host = { close: async () => undefined } as unknown as LocalAgentHost
  const tail = runPostRunTail({
    runId: RUN_ID,
    agentQaRoot: join(root, '.agent-qa'),
    configPath: join(root, 'agent-qa.config.yaml'),
    configDir: root,
    knowledgeConfig: { dir: 'knowledge' },
    log: { warn: (message) => warnings.push(message), info: (message) => lines.push(message) },
    postVerdict,
    executionContext,
    operations: {
      ...sentinels,
      composeHost: () => host,
      readPostProcessingStatus: async () => status,
      readRunDigest: async () => ({ runId: RUN_ID, lines: [], markChanges: [] }) as unknown as RunDigest,
      now: () => Date.now(),
    },
  })
  await tail.drain({ takeLease: () => { leaseTakes += 1; return undefined } })
  await tail.finish(detached ? { detached: true } : {})
  return { lines, warnings, drainCalls, leaseTakes, report: tail.report() }
}

async function expectSkippedExitLine(reason: PostProcessingSkipReason): Promise<number> {
  const word = POST_PROCESSING_SKIP_REASON_WORDS[reason]
  const head = `post-processing — analysis: skipped (${word}) · curation: skipped (${word}) · `
  let checked = 0
  for (const context of CONTEXTS) {
    for (const detached of [false, true]) {
      const key = `${reason} ${context} detached=${String(detached)}`
      const ran = await runSkippedTail(reason, context, detached)
      const seen = JSON.stringify({ lines: ran.lines, warnings: ran.warnings })
      const exitLines = ran.lines.filter((line) => line.startsWith('post-processing — '))
      expect(exitLines, `${key} prints one exit line ${seen}`).toHaveLength(1)
      const line = exitLines[0]!
      expect(line.startsWith(head), `${key} ${line}`).toBe(true)
      expect(line, key).not.toContain('pending')
      expect(line, key).not.toContain('resumes only if')
      expect(line, key).not.toContain('daemon')
      expect(line, key).not.toMatch(/\bdone\b|(?<!outcome-)\bexcluded\b/)
      expect(ran.lines, `${key} prints the exit line and nothing else`).toEqual([line])
      expect(ran.warnings, key).toEqual([])
      expect(ran.drainCalls, `${key} starts no drain`).toEqual([])
      expect(ran.leaseTakes, `${key} takes no lease`).toBe(0)
      expect(ran.report, key).toEqual({ enqueue: 'skipped', drain: 'not-attempted', jobsRun: 0 })
      checked += 1
    }
  }
  return checked
}

describe('the skipped run exit line', () => {
  it("a gate run's tail prints skipped (gate run) for both stages and starts no drain", async () => {
    expect(await expectSkippedExitLine('gate-run')).toBe(4)
  })

  it("an outcome-excluded run's tail prints skipped (outcome-excluded) for both stages and starts no drain", async () => {
    expect(await expectSkippedExitLine('outcome-excluded')).toBe(4)
  })
})
