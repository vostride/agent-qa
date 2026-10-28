// `agent-qa agent-jobs` operates the AGENT JOB QUEUE — the v52 durable background-job substrate in
// `.agent-qa/agent-jobs.db`. It is not the run queue (v1 test executions, `agent-qa queue`) and not
// the curation queue (v51 knowledge curation, drained under the writer lease). D-21's three names
// are load-bearing here for one concrete reason: the D-06 disposal step discards CURATOR jobs, and
// an operator who reached for `agent-qa queue cancel` would be cancelling rows in a different
// store entirely.
//
// 413 D-04 / D-06: `pump --only <kind>` is the in-process, writer-lease-holding, kind-filtered
// drain. The campaign driver pumps `analyze-run` per leg so seeding reads real verdicts, and the
// `curate-memory` successor that drain enqueues stays queued for the disposal step to list and
// cancel. See `../composition/agent-jobs-ops.ts` for why the filter is a construction option on the
// queue rather than a check in a loop.

import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'

import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import type { JobKind } from '@vostride/agent-qa-schema'

import type {
  AgentJobsOpsDeps,
  CancelAgentJobOutcome,
  ListAgentJobsOutcome,
  PumpAgentJobsOutcome,
  RequeueAgentJobOutcome,
} from '../composition/agent-jobs-ops.js'

/**
 * The declared kinds, spelled as a total `Record` rather than an array.
 *
 * `jobKindValues` is deliberately not on the schema barrel (its own comment says publishing it
 * would invite a parallel registry), so the vocabulary is restated here — but as a total record,
 * so a kind added to `JobKind` fails to COMPILE here instead of silently becoming an `--only`
 * value this parser rejects.
 */
const JOB_KIND_DECLARED: Record<JobKind, true> = Object.freeze({
  chat: true,
  'analyze-run': true,
  'curate-memory': true,
  consolidate: true,
})

const AGENT_JOB_KINDS = Object.freeze(Object.keys(JOB_KIND_DECLARED) as JobKind[])

function parseOnlyKind(value: string): JobKind {
  if (!(value in JOB_KIND_DECLARED)) {
    throw new InvalidArgumentError(
      `--only must name one agent job kind, got "${value}". `
      + `Declared kinds: ${AGENT_JOB_KINDS.join(', ')}.`,
    )
  }
  return value as JobKind
}

export interface AgentJobsCommandDeps {
  /**
   * The ops dependencies for a config path, resolved lazily.
   *
   * Async so the production binding can defer `import('../composition/agent-jobs-ops.js')` into the
   * action: that module reaches the local composition root, and `agent-qa --help` must never
   * compose a host to print a usage line.
   */
  opsFor(configPath: string): Promise<AgentJobsOpsDeps>
}

const DEFAULT_DEPS: AgentJobsCommandDeps = {
  opsFor: async (configPath) => {
    const ops = await import('../composition/agent-jobs-ops.js')
    return ops.defaultAgentJobsOpsDeps(configPath)
  },
}

function configPathFor(command: Command): string {
  let root = command
  while (root.parent !== null) root = root.parent
  const globalOpts = root.opts<{ config?: string }>()
  return globalOpts.config ?? 'agent-qa.config.yaml'
}

/** The refusal render both write verbs share. `held` names the holder an operator must wait on. */
function renderRefusal(refusal: Extract<PumpAgentJobsOutcome, { kind: 'refused' }>): string {
  const detail = refusal.holder === undefined
    ? refusal.message ?? 'the agent job queue could not be claimed'
    : `writer lease is held by pid ${refusal.holder.pid}, `
      + `lease ${refusal.holder.leaseId}, epoch ${refusal.holder.epoch}`
  return pc.red(`agent job queue: refusal [${refusal.reason}]: ${detail}`)
}

/**
 * The listing, with the 422 D-16 conclusion column beside the kind it explains.
 *
 * The column is ALWAYS printed, not added only when some row has a conclusion. A table whose
 * shape depended on its contents would mean an operator comparing two listings could not tell a
 * queue with no quarantines from a build that does not report them, and a driver parsing columns
 * by position would silently read the run id as a conclusion the first time one appeared.
 */
function renderList(result: ListAgentJobsOutcome): string {
  if (result.jobs.length === 0) return 'agent job queue: empty'
  const header = [
    'id', 'kind', 'status', 'conclusion', 'attempts', 'claimed', 'cancel-requested', 'run',
  ]
  const rows = result.jobs.map((job) => [
    job.id,
    job.kind,
    job.status,
    job.conclusionKind ?? '-',
    String(job.attempts),
    String(job.claimed),
    String(job.cancelRequested),
    job.runId ?? '-',
  ])
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

function renderPump(result: Extract<PumpAgentJobsOutcome, { kind: 'pumped' }>): string {
  const lines = result.outcomes.map(
    (outcome) =>
      `agent job ${outcome.kind} ${outcome.jobId} run=${outcome.runId ?? '-'} `
      + `-> ${outcome.disposition} (attempt ${outcome.attempt})`,
  )
  lines.push(
    `agent job queue: pumped ${result.ran} ${result.only} job(s), `
    + `stopped on ${result.stoppedOn}, excluded kinds: ${result.excludedKinds.join(', ')}`,
  )
  return lines.join('\n')
}

function renderCancel(jobId: string, result: CancelAgentJobOutcome): string {
  const word = result.kind === 'already-terminal'
    ? `already-terminal (${result.status})`
    : result.kind
  return `agent job queue: ${jobId} ${word}`
}

/**
 * What a requeue did, in the operator's words.
 *
 * `not-terminal` is DATA and exits 0: a driver that read "this row is queued" as a command failure
 * would abort a campaign over a row somebody else legitimately owns. The requeued line names every
 * medium the forget touched — the attempts, the checkpoints and the run's chain-terminal
 * notification — because a line that named fewer than the verb clears is how an operator learns
 * about the third one from a stale dashboard receipt instead of from here. It points at the pump
 * rather than performing one.
 */
function renderRequeue(jobId: string, result: RequeueAgentJobOutcome): string {
  if (result.kind === 'not-terminal') {
    return `agent job queue: ${jobId} not-terminal (${result.status}) `
      + '\u2014 only a done, failed or cancelled agent job can be requeued'
  }
  return `agent job queue: ${jobId} requeued `
    + '(attempts reset, checkpoints and run notification forgotten; '
    + 'pump --only <kind> to run it)'
}

function reportError(verb: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  printRunText(pc.red(`agent job queue ${verb} error: ${message}`), (block) => console.error(block))
  process.exitCode = 1
}

function printRefusal(refusal: Extract<PumpAgentJobsOutcome, { kind: 'refused' }>): void {
  printRunText(renderRefusal(refusal), (block) => console.error(block))
}

function holdStdoutForJson(json: boolean | undefined): (() => void) | undefined {
  return json === true ? reserveStdoutForData() : undefined
}

export function createAgentJobsCommand(deps: AgentJobsCommandDeps = DEFAULT_DEPS): Command {
  const cmd = new Command('agent-jobs')
    .description('Inspect, pump and requeue rows of the agent job queue (.agent-qa/agent-jobs.db)')
    .addHelpText(
      'after',
      '\nagent-qa runs three separate queues; this command manages the third only:\n' +
        '  run queue        test executions dispatched by the dashboard server (never served here)\n' +
        '  curation queue   knowledge curation work drained under the writer lease (not this one)\n' +
        '  agent job queue  durable background agent jobs in .agent-qa/agent-jobs.db (this command)\n' +
        '\nSee https://vostride.com/docs/agent-qa/daemon.\n',
    )

  cmd
    .command('list')
    .description('Show every row of the agent job queue, without any payload body')
    .option('--json', 'emit the typed result DTO to stdout')
    .action(async (opts: { json?: boolean }, command: Command) => {
      const releaseStdout = holdStdoutForJson(opts.json)
      try {
        const ops = await import('../composition/agent-jobs-ops.js')
        const result = await ops.listAgentJobs(await deps.opsFor(configPathFor(command)))
        if (opts.json === true) console.log(guardJsonText(JSON.stringify(result)))
        else printRunText(renderList(result))
      } catch (error) {
        reportError('list', error)
      } finally {
        releaseStdout?.()
      }
    })

  cmd
    .command('pump')
    .description('Drain one kind under the writer lease, leaving every other kind queued')
    .requiredOption('--only <kind>', 'the one agent job kind this pump may claim', parseOnlyKind)
    .option('--json', 'emit the typed result DTO to stdout')
    .action(async (opts: { only: JobKind; json?: boolean }, command: Command) => {
      const releaseStdout = holdStdoutForJson(opts.json)
      try {
        const ops = await import('../composition/agent-jobs-ops.js')
        const result = await ops.pumpAgentJobs(
          { only: opts.only },
          await deps.opsFor(configPathFor(command)),
        )
        if (opts.json === true) {
          console.log(guardJsonText(JSON.stringify(result)))
          if (result.kind === 'refused') process.exitCode = 1
          return
        }
        if (result.kind === 'refused') {
          printRefusal(result)
          process.exitCode = 1
          return
        }
        // A pumped outcome always exits 0. A failed or retry-scheduled disposition is DATA about
        // what the queue durably did — a driver that read it as a command failure would abort a
        // campaign leg over a job the queue has already scheduled to retry.
        printRunText(renderPump(result))
      } catch (error) {
        reportError('pump', error)
      } finally {
        releaseStdout?.()
      }
    })

  cmd
    .command('cancel')
    .description('Request cancellation of one agent job queue row')
    .argument('<jobId>', 'the agent job id to cancel')
    .option('--json', 'emit the typed result DTO to stdout')
    .action(async (jobId: string, opts: { json?: boolean }, command: Command) => {
      const releaseStdout = holdStdoutForJson(opts.json)
      try {
        const ops = await import('../composition/agent-jobs-ops.js')
        const result = await ops.cancelAgentJob(jobId, await deps.opsFor(configPathFor(command)))
        if (opts.json === true) {
          console.log(guardJsonText(JSON.stringify(result)))
          if (result.kind === 'refused') process.exitCode = 1
          return
        }
        if (result.kind === 'refused') {
          printRefusal(result)
          process.exitCode = 1
          return
        }
        printRunText(renderCancel(jobId, result))
      } catch (error) {
        reportError('cancel', error)
      } finally {
        releaseStdout?.()
      }
    })

  cmd
    .command('requeue')
    .description('Return one done, failed or cancelled row to the agent job queue')
    .argument('<jobId>', 'the agent job id to return to the agent job queue')
    .option('--json', 'emit the typed result DTO to stdout')
    .action(async (jobId: string, opts: { json?: boolean }, command: Command) => {
      const releaseStdout = holdStdoutForJson(opts.json)
      try {
        const ops = await import('../composition/agent-jobs-ops.js')
        const result = await ops.requeueAgentJob(jobId, await deps.opsFor(configPathFor(command)))
        if (opts.json === true) {
          console.log(guardJsonText(JSON.stringify(result)))
          if (result.kind === 'refused') process.exitCode = 1
          return
        }
        if (result.kind === 'refused') {
          printRefusal(result)
          process.exitCode = 1
          return
        }
        printRunText(renderRequeue(jobId, result))
      } catch (error) {
        reportError('requeue', error)
      } finally {
        releaseStdout?.()
      }
    })

  return cmd
}
