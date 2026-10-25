// `agent-qa agent-jobs` — the surface half of 413 D-04 / D-06.
//
// Three claims, none of them a snapshot: the help obeys the three-queue vocabulary relation
// `queue-help.test.ts` enforces for every other queue surface; `--only` refuses an undeclared kind
// by NAMING the declared ones (a driver that mistypes a kind must be told the vocabulary, not just
// that it was wrong); and `list --json` prints a DTO that carries a run id and no payload body —
// the T-413-47 disclosure boundary, asserted on the bytes an operator actually sees.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRealJobKindRegistry } from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import {
  DIGEST_JOB_ID_SOURCE,
  LOCAL_CURATION_CAPABILITIES,
  composeJobRecovery,
} from '@vostride/agent-qa-agent-local'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentJobsCommand } from '../agent-jobs.js'
import type { AgentJobsOpsDeps } from '../../composition/agent-jobs-ops.js'

/**
 * The three-queue vocabulary relation, copied from `queue-help.test.ts` rather than imported.
 *
 * Copied deliberately: that file's helpers are private to it, and the relation is the CONTRACT —
 * a surface that borrowed a helper could be exempted by an edit to the helper. Two independent
 * spellings of the same relation cannot be relaxed in one place.
 */
const QUALIFIERS = ['run', 'curation', 'agent job'] as const
const CANONICAL_ORDER = ['run queue', 'curation queue', 'agent job queue'] as const

function helpOutput(cmd: Command): string {
  let buffer = ''
  cmd.configureOutput({ writeOut: (str) => (buffer += str) })
  cmd.outputHelp()
  return buffer
}

function proseOf(help: string): string {
  return help
    .split('\n')
    .filter((line) => !line.startsWith('Usage:'))
    .join('\n')
}

function qualifiersIn(prose: string): string[] {
  const found = new Set<string>()
  // Both boundaries, not just the trailing one. The trailing lookahead alone made the relation
  // fire inside `requeue` — a VERB whose last five letters happen to spell the noun — and would
  // have forced the 413-14 subcommand to be named something other than what it does. A compound
  // word is not an unqualified use of the noun; a bare "the queue" still is, and the control cell
  // below still reddens on it.
  const singular = /(?<![\w-])queue(?![\w-])/g
  for (let m = singular.exec(prose); m !== null; m = singular.exec(prose)) {
    const before = prose.slice(0, m.index)
    const qualifier = QUALIFIERS.find((q) => before.endsWith(`${q} `))
    found.add(qualifier ?? `UNQUALIFIED:${JSON.stringify(before.slice(-24))}`)
  }
  return [...found].sort()
}

const NEVER_AUTHORS: JobModelCapability = {
  modelId: 'test:none',
  generate: () => Promise.reject(new Error('the stand-in never authors')),
}

const clock = { now: (): string => new Date().toISOString() }

let roots: string[] = []

function harnessDeps(): { deps: AgentJobsOpsDeps; seed: (payload: unknown) => Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-413-10-cmd-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })

  const open = (): ReturnType<typeof composeJobRecovery> =>
    composeJobRecovery({
      agentQaRoot,
      clock,
      idSource: DIGEST_JOB_ID_SOURCE,
      model: NEVER_AUTHORS,
      jobKinds: createRealJobKindRegistry(),
    })

  const maintenance = LOCAL_CURATION_CAPABILITIES.maintenance
  return {
    deps: {
      composeJobs: async () => {
        const host = open()
        return {
          jobs: {
            store: host.store,
            kinds: host.kinds,
            queue: host.queue,
            model: NEVER_AUTHORS,
            idSource: DIGEST_JOB_ID_SOURCE,
            // Stated, not omitted: this double composes no posture, and the empty set is a fact
            // about it rather than a field nobody got round to (CR-02).
            unclaimableKinds: [],
          },
          close: async () => {
            host.close()
          },
        }
      },
      knowledgeRoot: async () => knowledgeRoot,
      clock,
      acquireWriterLease: maintenance.acquireWriterLease,
      releaseLease: maintenance.releaseLease,
      refreshWriterLeaseAuthority: maintenance.refreshWriterLeaseAuthority,
    },
    async seed(payload) {
      const host = open()
      try {
        await host.queue.enqueue('analyze-run', payload, 'r_list')
      } finally {
        host.close()
      }
    },
  }
}

let priorExitCode: number | string | undefined

beforeEach(() => {
  roots = []
  priorExitCode = process.exitCode ?? undefined
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  process.exitCode = priorExitCode
  vi.restoreAllMocks()
})

describe('agent-qa agent-jobs help text — the three-queue vocabulary', () => {
  it('is named agent-jobs, carrying the queue qualifier the page enforces', () => {
    expect(createAgentJobsCommand().name()).toBe('agent-jobs')
  })

  it('names all three queues and qualifies every "queue" it prints', () => {
    const help = helpOutput(createAgentJobsCommand())
    for (const name of CANONICAL_ORDER) expect(help).toContain(name)
    expect(qualifiersIn(proseOf(help))).toEqual([...QUALIFIERS].sort())
    expect(help).toContain('https://vostride.com/docs/agent-qa/daemon')
  })

  it('detects a collapsed vocabulary — the control for the assertion above', () => {
    const collapsed = proseOf(helpOutput(createAgentJobsCommand()))
      .replaceAll('curation queue', 'agent job queue')
    expect(qualifiersIn(collapsed)).not.toEqual([...QUALIFIERS].sort())
  })
})

describe('agent-qa agent-jobs pump --only', () => {
  it('refuses an undeclared kind and names the five declared ones', async () => {
    let stderr = ''
    const cmd = createAgentJobsCommand({
      opsFor: () => {
        throw new Error('the parser must refuse before anything composes a host')
      },
    })
    // Applied to the SUBCOMMAND as well as the parent: commander copies inherited settings when a
    // subcommand is CREATED, so configuring the parent afterwards would leave `pump` writing its
    // refusal to the real stderr and calling the real `process.exit`.
    for (const target of [cmd, ...cmd.commands]) {
      target.configureOutput({ writeErr: (str) => (stderr += str) })
      target.exitOverride((error) => {
        process.exitCode = error.exitCode
        throw error
      })
    }

    await expect(cmd.parseAsync(['pump', '--only', 'bogus'], { from: 'user' })).rejects.toThrow()

    expect(process.exitCode).toBe(1)
    for (const kind of [
      'chat',
      'analyze-run',
      'curate-memory',
      'consolidate',
    ]) {
      expect(stderr).toContain(kind)
    }
  })
})

describe('agent-qa agent-jobs list --json', () => {
  it('prints the row with its run id and no payload key', async () => {
    const harness = harnessDeps()
    await harness.seed({ runId: 'r_list', secret: 'must-never-be-printed' })

    let stdout = ''
    const log = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      stdout += String(value)
    })

    const cmd = createAgentJobsCommand({ opsFor: async () => harness.deps })
    await cmd.parseAsync(['list', '--json'], { from: 'user' })
    log.mockRestore()

    const dto = JSON.parse(stdout) as {
      epoch: number
      jobs: { id: string; kind: string; runId?: string }[]
    }
    expect(dto.jobs).toHaveLength(1)
    expect(dto.jobs[0]).toMatchObject({ kind: 'analyze-run', runId: 'r_list' })
    expect(Object.keys(dto.jobs[0]!)).not.toContain('payload')
    // The disclosure boundary asserted on the BYTES, not on a key name: a payload field added
    // anywhere in the DTO would carry this string onto an operator's terminal.
    expect(stdout).not.toContain('must-never-be-printed')
  })
})

describe('agent-qa agent-jobs requeue <jobId>', () => {
  it('prints the not-terminal DTO for a queued row and does not fail the process', async () => {
    const harness = harnessDeps()
    await harness.seed({ runId: 'r_list' })

    let stdout = ''
    const log = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      stdout += String(value)
    })

    // The id is read off the shipped listing rather than reached for inside the store, so this
    // cell exercises the same two verbs an operator types in sequence.
    await createAgentJobsCommand({ opsFor: async () => harness.deps })
      .parseAsync(['list', '--json'], { from: 'user' })
    const jobId = (JSON.parse(stdout) as { jobs: { id: string }[] }).jobs[0]?.id
    expect(jobId).toBeDefined()

    stdout = ''
    process.exitCode = undefined
    await createAgentJobsCommand({ opsFor: async () => harness.deps })
      .parseAsync(['requeue', jobId!, '--json'], { from: 'user' })
    log.mockRestore()

    // A queued row is DATA about what the store found, not a command failure: an operator who
    // requeues a row a drainer already owns must be told, and must not have their driver abort.
    expect(stdout).toBe('{"kind":"not-terminal","status":"queued"}')
    expect(process.exitCode).not.toBe(1)
  })
})
