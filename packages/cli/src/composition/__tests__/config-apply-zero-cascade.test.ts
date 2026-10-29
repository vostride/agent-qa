// CFGM-03's non-triggering clause, measured (395-07 · D-06).
//
// "AGENT COMMITS ARE NON-TRIGGERING" IS AN ABSENCE, and an absence is the easiest thing in this
// repository to assert vacuously: "the apply enqueued no jobs" passes just as happily against a
// harness where nothing could ever enqueue, against a store that was never opened, and against a
// probe that reads the wrong file. So the delta is taken with a probe that is PROVEN, in the same
// cell, on the same store, to see an enqueue when one happens — and only then is its emptiness
// across the accept treated as evidence.
//
// WHAT EACH HALF MUST RED ON:
//
//   (Z1) the empty delta        — a config apply that enqueued anything: a post-apply hook, a
//                                 revalidation job, a "config changed" watcher. Today's absence is
//                                 by construction, which is exactly why it is pinned now: D-06's
//                                 committed contract is a law tomorrow's watchers inherit, and this
//                                 cell is where a future one announces itself.
//   (Z2) the integrity half     — a probe that cannot see an enqueue at all. It runs INSIDE (Z1),
//                                 after the absence has been asserted, through the SAME
//                                 `dumpState()` call on the SAME store handle, and it fails if the
//                                 delta stays empty when something really is enqueued. Without it
//                                 (Z1) would be a measurement of the probe rather than of the apply.
//   (Z3) the runs half          — the same arrangement one directory over. "Zero enqueued jobs OR
//                                 runs" names two observables, and a cell that watched only the
//                                 queue would miss an apply that started a run directly.
//
// THE CHANGE IS ASSERTED TO HAVE HAPPENED FIRST, and that ordering is the third thing keeping this
// honest: an empty delta across a change that refused or found nothing is not a fact about
// cascading. The written bytes carry the change before any absence below is read.
//
// 2026-10-01, 432-16 D-07: (Z1)-(Z3) used to drive a pre-432 record through `proposals.accept`,
// which committed it. No host binds that apply now; the same absences are measured across the
// direct `config.field.set`, which makes no commit (the count stays 1).
//
// THE HOST IS THE PRODUCTION ONE and the store is the real sqlite queue `composeLocalAgent` opens —
// the same handle a post-run tail would enqueue through. A double would have made this cell a
// statement about the double.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps, JobModelCapability } from '@vostride/agent-qa-agent'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import * as hostModule from '../local-agent-host.js'

const CONFIG_FILE = 'agent-qa.config.yaml'

/** The queue's model handle. Never called: nothing here runs a job, it only enqueues one. */
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:config-apply-zero-cascade',
  generate: () => Promise.resolve({ text: 'no job is ever run in this suite' }),
}

const SEEDED_CONFIG = `# agent-qa Configuration

workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`

let root: string
let configPath: string
let agentQaRoot: string

function git(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // 395-24 · WR-12 — a `git` that ran and failed must not return quietly; see
    // validate-resolution-surface.test.ts for the full note.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout }
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim())
}

/** Every run directory this runtime root holds — the second observable D-06's sentence names. */
function runDirectories(): string[] {
  const runs = join(agentQaRoot, 'runs')
  return existsSync(runs) ? readdirSync(runs).sort() : []
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-apply-zero-cascade-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  writeFileSync(configPath, SEEDED_CONFIG)

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa zero cascade test')
  git('config', 'user.email', 'zero-cascade-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n')
  git('add', '--', '.gitignore', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('an accepted config apply cascades into nothing', () => {
  it('the job store is deep-equal across the accept, and the same probe DOES see an enqueue',
    async () => {
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath,
        model: () => TEST_MODEL,
      })
      try {
        // THE REAL QUEUE, OPENED BEFORE THE APPLY. Opening it here rather than after is what makes
        // the two dumps comparable at all — a store first opened afterwards would have its own
        // creation in the delta, and a cell that then subtracted it would be subtracting exactly
        // the kind of change it is looking for.
        const jobs = await host.jobs()

        // RE-SPELLED 2026-10-01 (432-16, D-07): the change is the direct one. The pre-432 accept
        // this cell drove made a commit through a config apply port no host binds any more.
        const before = await jobs.store.dumpState()
        const runsBefore = runDirectories()

        const changed = await runSafetyScope({ executionContext: 'local-interactive' }, async () =>
          await invokeFunction(
            host.registry,
            'config.field.set',
            { path: 'use.timeout.step', value: '45s' },
            CLI_FUNCTION_CALLER,
          ) as ConfigChangeOutput)

        // THE CHANGE REALLY HAPPENED. Everything below is an absence, and an absence across a
        // change that did nothing is not a statement about cascading.
        expect(changed.outcome).toBe('applied')
        expect(commitCount()).toBe(1)
        expect(readFileSync(configPath, 'utf8'))
          .toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))

        // (Z1) ZERO ENQUEUED JOBS. Deep equality over the WHOLE dump — schema version, epoch and
        // every row — rather than a count, so a row that was replaced rather than added fails too.
        const after = await jobs.store.dumpState()
        expect(after).toEqual(before)
        expect(after.jobs).toHaveLength(0)

        // (Z3) ZERO STARTED RUNS, the other observable in D-06's sentence.
        expect(runDirectories()).toEqual(runsBefore)

        // (Z2) THE INTEGRITY HALF — the same store, the same handle, the same `dumpState()` call.
        // If this probe could not see an enqueue, the emptiness above would be a fact about the
        // probe. `analyze-run` is a real declared kind; nothing runs it, and nothing needs to.
        const enqueued = await jobs.queue.enqueue(
          'analyze-run',
          { runId: 'run_zero_cascade_probe' },
          'zero-cascade-probe',
        )
        expect(enqueued.deduped).toBe(false)
        expect(enqueued.job.kind).toBe('analyze-run')

        const afterEnqueue = await jobs.store.dumpState()
        expect(afterEnqueue).not.toEqual(before)
        expect(afterEnqueue.jobs).toHaveLength(1)
        expect(afterEnqueue.jobs[0]?.kind).toBe('analyze-run')

        // AND THE SAME FOR THE RUNS PROBE, so neither absence rests on a reader that reads nothing.
        mkdirSync(join(agentQaRoot, 'runs', 'run_zero_cascade_probe'), { recursive: true })
        expect(runDirectories()).not.toEqual(runsBefore)
        expect(runDirectories()).toContain('run_zero_cascade_probe')
      } finally {
        await host.close()
      }
    })
})

// 2026-09-30, 432-07 D-05/D-07: the same absence for the direct writer. A config change is a file
// edit and nothing else: it starts no run and enqueues no job, and it makes no commit either.
describe('a direct config write cascades into nothing', () => {
  it('the job store and the runs directory are unchanged across a direct write, and the probe still sees an enqueue',
    async () => {
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath,
        model: () => TEST_MODEL,
      })
      try {
        const jobs = await host.jobs()
        const create = (hostModule as Record<string, unknown>).createConfigWritePort
        expect(typeof create, 'the direct config writer is exported').toBe('function')
        const port = (create as (path: string) => NonNullable<FunctionDeps['configWrite']>)(configPath)

        const before = await jobs.store.dumpState()
        const runsBefore = runDirectories()

        const outcome = await port.applyFields({
          changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
        })

        expect(outcome.kind).toBe('applied')
        expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
        expect(commitCount()).toBe(1)

        const after = await jobs.store.dumpState()
        expect(after).toEqual(before)
        expect(after.jobs).toHaveLength(0)
        expect(runDirectories()).toEqual(runsBefore)

        // 432-11: the op itself, through the composed host, cascades into nothing either.
        const answer = await invokeFunction(
          host.registry,
          'config.field.set',
          { path: 'use.timeout.test', value: '60m' },
          CLI_FUNCTION_CALLER,
        ) as ConfigChangeOutput
        expect(answer).toMatchObject({ outcome: 'applied', files: [CONFIG_FILE] })
        expect(readFileSync(configPath, 'utf8')).toContain('test: 60m')
        expect(await jobs.store.dumpState()).toEqual(before)
        expect(runDirectories()).toEqual(runsBefore)
        expect(commitCount()).toBe(1)

        await jobs.queue.enqueue('analyze-run', { runId: 'run_direct_probe' }, 'direct-config-probe')
        expect((await jobs.store.dumpState()).jobs).toHaveLength(1)
      } finally {
        await host.close()
      }
    })
})
