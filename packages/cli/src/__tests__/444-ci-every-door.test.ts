// 2026-10-18 (444-20, D-48 extended): in `ci` and `cloud` every line that promises a resume states
// the resume limit instead, chosen by the drainer of the work it names; other contexts read as before.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { DRAIN_BUDGET_MS } from '@vostride/agent-qa-agent-local'
import { generateRunId } from '@vostride/agent-qa-ids'
import { acquireWriterLease, releaseLease } from '@vostride/agent-qa-knowledge-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId, computeBriefDigest, guardCompletedRunHandoff, sha256hex } from '@vostride/agent-qa-schema'
import type { ServedBrief } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createRunCommand } from '../commands/run.js'
import * as drive from '../composition/in-process-run-execution.js'
import { runInProcessCliRun } from '../composition/in-process-run-execution.js'
import {
  CountingTarget,
  closeTestRunRecords,
  createInProcessFixture,
  testRunRecord,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import * as localAgentHost from '../composition/local-agent-host.js'
import { runCurationTail } from '../curation/curation-tail.js'
import { runPostRunTail } from '../curation/post-run-tail.js'
import * as tailComposition from '../curation/post-run-tail-composition.js'
import {
  ownPostVerdictContinuation,
  postVerdictPendingPath,
  recoverPendingPostVerdictContinuations,
} from '../curation/post-verdict-continuation.js'
import { dispositionOf, type PostVerdictHandoff } from '../curation/post-verdict-step.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

/** Every analyze-run enqueue the run's own post-verdict step makes throws. */
function failAnalysisEnqueue(): void {
  const actual = localAgentHost.composeCliLocalAgent
  vi.spyOn(localAgentHost, 'composeCliLocalAgent').mockImplementation((input) => {
    const host = actual(input)
    return { ...host, jobs: async () => {
      const jobs = await host.jobs()
      return { ...jobs, queue: { ...jobs.queue, enqueue: async (...args: Parameters<typeof jobs.queue.enqueue>) => {
        if (args[0] === 'analyze-run') throw new Error('fixture enqueue failure')
        return await jobs.queue.enqueue(...args)
      } } }
    } }
  })
}

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

// Spelled here rather than imported, so the cells pin the words (D-22, 444-14).
const ANY_HOST = "resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up"
const LOCAL_RUN = "resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up"
const CI_CONTEXTS = ['ci', 'cloud'] as const
type Context = 'ci' | 'cloud' | 'local-headless'
// Every marker a product reader takes as CI, taken from the readers themselves: safety-local's
// context detector (env.CI plus CI_VENDOR_VARS, which its package index does not re-export) and
// run.ts's cache-policy list, which is module-private and so is read from its source.
const { CI_VENDOR_VARS: CONTEXT_VENDOR_VARS } = await import(
  new URL('../../../safety-local/src/execution-context-detector.js', import.meta.url).href
) as { CI_VENDOR_VARS: ReadonlySet<string> }
function runCommandCiVars(): string[] {
  const source = readFileSync(new URL('../commands/run.ts', import.meta.url), 'utf8')
  const list = /const CI_VENDOR_VARS = \[([^\]]*)\]/u.exec(source)?.[1] ?? ''
  const names = [...list.matchAll(/'([A-Z0-9_]+)'/gu)].map((match) => match[1]!)
  if (names.length === 0) throw new Error('run.ts no longer declares CI_VENDOR_VARS as a literal list; read it from its new home')
  return names
}
const CI_MARKERS = [...new Set(['CI', ...CONTEXT_VENDOR_VARS, ...runCommandCiVars()])]

const roots: string[] = []
const targets: CountingTarget[] = []

afterEach(async () => {
  closeTestRunRecords()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const target of targets.splice(0)) await target.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => { removeInProcessFixtures() })

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')

async function project(): Promise<ReturnType<typeof createInProcessFixture>> {
  const target = new CountingTarget()
  await target.listen()
  targets.push(target)
  const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
  roots.push(fixture.project)
  // An empty browsers root: the suite arm still reaches a verdict, and nothing launches.
  const browsersRoot = join(fixture.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', browsersRoot)
  return fixture
}

async function waitFor<T>(read: () => T | undefined, what: string, budgetMs = 60_000): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function idleHandoff(): PostVerdictHandoff {
  return {
    outcome: undefined,
    pendingPath: '/workspace/.agent-qa/runs/run/post-verdict-pending.json',
    takeAcquiredLease: () => undefined,
    takeUnclaimedLease: () => undefined,
  }
}

describe('C444-CI-EVERY-DOOR', () => {
  it('in ci the runs.start door exit line states each pending stage\'s resume limit', async () => {
    const expected: Record<'ci' | 'local-headless', readonly string[]> = {
      ci: [`analysis: pending (${ANY_HOST})`, `curation: pending (${LOCAL_RUN})`],
      // This door pumps nothing when it took no lease, so locally the posture adds no suffix.
      'local-headless': ['analysis: pending', 'curation: pending'],
    }
    for (const context of ['local-headless', 'ci'] as const) {
      const fixture = await project()
      // A held lease is a handed-off chain: the door's tail drains nothing and prints its posture.
      const knowledgeRoot = join(fixture.project, 'agent-qa-knowledge')
      const lease = acquireWriterLease(knowledgeRoot)
      if (lease.kind !== 'acquired') throw new Error(`expected a writer lease: ${lease.kind}`)
      const warnings: string[] = []
      vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(plain(String(message))) })
      const host = composeCliLocalAgent({
        agentQaRoot: fixture.agentQaRoot,
        configPath: fixture.configPath,
        resolveExecutionContext: () => context,
      })
      try {
        const ack = await invokeFunction(host.registry, 'runs.start',
          { patterns: [fixture.suitePattern] }, CLI_FUNCTION_CALLER) as { runId: string }
        const line = await waitFor(() => warnings.find((message) => message.startsWith('post-processing — ')),
          `${context}'s exit line`)
        const stages = line.replace('post-processing — ', '').split(' · ').slice(0, 2)
        expect(stages, `${context} ${ack.runId}\n${warnings.join('\n')}`).toEqual(expected[context])
      } finally {
        await host.close().catch(() => undefined)
        releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
        vi.restoreAllMocks()
      }
    }
  }, 240_000)

  it('in ci the runs.start door tail-failure warning states the resume limit', async () => {
    const expected: Record<'ci' | 'local-headless', string> = {
      ci: `); queued work ${ANY_HOST}.`,
      'local-headless': '); queued work will resume on the next run or when the daemon drains it.',
    }
    for (const context of ['local-headless', 'ci'] as const) {
      const fixture = await project()
      const warnings: string[] = []
      const outcome = await runInProcessCliRun({
        runRecord: testRunRecord(),
        configPath: fixture.configPath,
        agentQaRoot: fixture.agentQaRoot,
        executionContext: context,
        warn: (message) => { warnings.push(message) },
        postRunTail: async () => { throw new Error('the queue database is unreadable') },
      }, { patterns: [fixture.suitePattern] })
      await outcome.settled
      const named = warnings.filter((message) => message.includes('the post-run tail did not complete'))
      expect(named, `${context}\n${warnings.join('\n')}`).toEqual([
        `Run ${outcome.runId}: the post-run tail did not complete (the queue database is unreadable${expected[context]}`,
      ])
    }
  }, 240_000)

  it('in ci a failed preparation or enqueue states the resume limit', async () => {
    const expected: Record<'ci' | 'local-headless', string> = {
      ci: `It ${ANY_HOST}; conflicting or unsafe state remains refused.`,
      'local-headless': 'The next local run or daemon drain resumes eligible pending hand-offs; conflicting or unsafe state remains refused.',
    }
    failAnalysisEnqueue()
    for (const context of ['local-headless', 'ci'] as const) {
      const fixture = await project()
      const warnings: string[] = []
      const outcome = await runInProcessCliRun({
        runRecord: testRunRecord(),
        configPath: fixture.configPath,
        agentQaRoot: fixture.agentQaRoot,
        executionContext: context,
        warn: (message) => { warnings.push(message) },
      }, { patterns: [fixture.suitePattern] })
      await outcome.settled
      const failed = await waitFor(
        () => warnings.find((message) => message.includes('analysis enqueue failed or was refused')),
        `${context}'s enqueue failure`, 10_000,
      )
      expect(failed.startsWith(`Run ${outcome.runId}: analysis enqueue failed or was refused (`), failed).toBe(true)
      expect(failed.endsWith(expected[context]), `${context}\n${failed}`).toBe(true)
    }
  }, 240_000)

  it('in ci the post-run tail drain failure states the resume limit', async () => {
    const expected: Record<Context, string> = {
      ci: `queued work ${ANY_HOST}.`,
      cloud: `queued work ${ANY_HOST}.`,
      'local-headless': 'queued work will resume on the next run or when the daemon drains it.',
    }
    for (const context of ['local-headless', ...CI_CONTEXTS] as const) {
      const warnings: string[] = []
      const tail = runPostRunTail({
        runId: 'run_444_20_drain',
        agentQaRoot: '/workspace/.agent-qa',
        configPath: '/workspace/agent-qa.config.yaml',
        configDir: '/workspace',
        knowledgeConfig: { dir: 'knowledge' },
        log: { warn: (message) => warnings.push(message), info: () => undefined },
        executionContext: context,
        operations: { resolveKnowledgeRoot: () => { throw new Error('fixture root failure') } },
      })
      await tail.drain({ takeLease: () => undefined })
      expect(warnings, context).toEqual([
        `Post-run processing stopped early for run_444_20_drain (fixture root failure); ${expected[context]}`,
      ])
    }
  })

  it('in ci the run command unexpected curation-tail error states the resume limit, on both of its tail sites', async () => {
    const expected: Record<'ci' | 'local-headless', string> = {
      ci: `Warning: Post-verdict knowledge curation incomplete; it ${LOCAL_RUN}.`,
      'local-headless': 'Warning: Post-verdict knowledge curation incomplete; it will resume on the next run.',
    }
    for (const mode of ['direct', 'suite'] as const) {
      for (const context of ['local-headless', 'ci'] as const) {
        const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
        roots.push(fixture.project)
        if (context === 'ci') vi.stubEnv('CI', 'true')
        else for (const marker of CI_MARKERS) vi.stubEnv(marker, '')
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const warnings: string[] = []
        vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(plain(String(message))) })
        vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
        vi.spyOn(tailComposition, 'composeCliPostRunTail').mockImplementation(() => ({
          drain: async () => { throw new Error('fixture tail failure') },
          finish: async () => undefined,
          report: () => ({ drain: 'not-attempted', jobsRun: 0 }),
        }) as never)
        vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
          const produced = await input.produceMembers!({} as never)
          try {
            const runId = String(request.runId)
            const exitCode = await input.afterVerdict!({
              verdict: 'failed', exitCode: input.freezeVerdict!('failed'), runId,
              configDir: fixture.project, configFilePath: fixture.configPath,
              postVerdict: idleHandoff(), postVerdictDeadlineMs: Date.now() - 1,
            } as never)
            return { runId, verdict: 'failed', exitCode } as never
          } finally { await produced.finalize?.() }
        })
        const program = new Command().option('--config <path>').addCommand(createRunCommand())
        await expect(program.parseAsync(['--config', fixture.configPath, 'run',
          mode === 'suite' ? fixture.suitePattern : fixture.testPattern], { from: 'user' }))
          .rejects.toThrow('fixture command exit')
        expect(warnings.filter((message) => message.includes('Post-verdict knowledge curation incomplete')),
          `${mode} ${context}\n${warnings.join('\n')}`).toEqual([expected[context]])
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
      }
    }
  }, 120_000)

  it('in ci the curation fold incomplete warning states the resume limit', async () => {
    const expected: Record<Context, string> = {
      ci: `it ${LOCAL_RUN}.`,
      cloud: `it ${LOCAL_RUN}.`,
      'local-headless': 'it will resume on the next run.',
    }
    for (const context of ['local-headless', ...CI_CONTEXTS] as const) {
      const warnings: string[] = []
      await runCurationTail({
        runId: 'run_444_20_fold',
        agentQaRoot: '/workspace/.agent-qa',
        knowledgeConfig: { dir: 'knowledge' },
        configDir: '/workspace',
        log: { warn: (message: string) => { warnings.push(message) }, info: () => undefined },
        operations: {
          loadCompletedRunHandoff: (() => ({ runId: 'run_444_20_fold', executionContext: context })) as never,
          resolveKnowledgeRoot: () => { throw new Error('fixture root failure') },
        },
      })
      expect(warnings, context).toEqual([
        `Post-verdict knowledge curation incomplete for run_444_20_fold; ${expected[context]}`,
      ])
    }
  })

  // No door reaches this arm: the step always probes the lease before it decides (probeWriterLease
  // is total), so the decision function itself is the line's only caller.
  it('in ci the post-verdict decision without a lease capability states the resume limit', () => {
    const expected: Record<Context, string> = {
      ci: `from this process. It ${ANY_HOST}.`,
      cloud: `from this process. It ${ANY_HOST}.`,
      'local-headless': 'from this process. The next local run or `agent-qa daemon` drains it.',
    }
    for (const context of ['local-headless', ...CI_CONTEXTS] as const) {
      const outcome = dispositionOf({
        enqueue: 'enqueued',
        leaseSkipped: false,
        executionContext: context,
      } as Parameters<typeof dispositionOf>[0])
      expect(outcome.disposition, context).toBe('detached')
      const message = (outcome as { warning?: { message: string } }).warning?.message ?? ''
      expect(message.startsWith('No writer-lease capability is composed on this host'), message).toBe(true)
      expect(message.endsWith(expected[context]), `${context}\n${message}`).toBe(true)
    }
  })

  it('in ci a recovered preparation that fails states the resume limit', async () => {
    const expected: Record<'ci' | 'local-headless', string> = {
      ci: `; it ${ANY_HOST}.`,
      'local-headless': '; the next local run or daemon drain retries eligible pending work.',
    }
    for (const context of ['local-headless', 'ci'] as const) {
      const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
      roots.push(fixture.project)
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
      const input = { ...fixture, runId: generateRunId(), knowledgeRoot: join(fixture.project, 'knowledge') }
      const runDir = join(input.agentQaRoot, 'runs', input.runId)
      mkdirSync(runDir, { recursive: true })
      const brief: ServedBrief = {
        scope: { tier: 'product', key: fixture.targetName }, asOfBuild: 1, budget: 1000, truncation: 'none',
        channel1: [{ id: asRecordId(`rec-${sha256hex(fixture.directTestId)}`), kind: 'fact',
          summary: 'checkout candidate', trust: 0.5, status: 'candidate', servedAsCanary: false, tier: 'L1' }],
        channel2: [], channel3: [], briefDigest: '',
      }
      writeFileSync(join(runDir, 'handoff.json'), JSON.stringify(guardCompletedRunHandoff({
        schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId: input.runId, scope: { tier: 'product', key: fixture.targetName },
        buildOrdinal: 1, executionContext: context, aggregateVerdict: 'failed',
        configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' }, startedAt: 1, endedAt: 2,
        tests: [{ testId: fixture.directTestId, testName: 'checkout', filePath: 'tests/direct.yaml',
          testIndex: 0, outcome: 'failed', steps: [{ stepIndex: 0, stepText: 'Open checkout', cacheStatus: 'miss',
            servedBrief: { ...brief, briefDigest: computeBriefDigest(brief) }, subActions: [],
            verifierVerdict: { pass: false, reasoning: 'checkout remains closed' } }] }],
      })))
      // An intent left behind by a run that stopped after recording it.
      await expect(ownPostVerdictContinuation({
        ...input,
        enqueue: async () => 'enqueued' as const,
        queued: async () => { throw new Error('stop after intent before enqueue') },
      })).rejects.toThrow('stop after intent before enqueue')
      const pendingPath = postVerdictPendingPath(input)

      const warnings: string[] = []
      failAnalysisEnqueue()
      const recovered = await recoverPendingPostVerdictContinuations({
        ...input,
        deadlineMs: Date.now() + DRAIN_BUDGET_MS,
        log: { warn: (message) => { warnings.push(message) } },
        executionContext: context,
      })
      expect(recovered.map((result) => result.runId), `${context}\n${warnings.join('\n')}`).toEqual([input.runId])
      const retry = warnings.filter((message) => message.startsWith(`Run ${input.runId}: analysis enqueue failed or was refused (`))
      expect(retry, `${context}\n${warnings.join('\n')}`).toHaveLength(1)
      expect(retry[0]!.endsWith(`Intent: ${pendingPath}${expected[context]}`), `${context}\n${retry[0]}`).toBe(true)
      vi.restoreAllMocks()
    }
  }, 120_000)
})
