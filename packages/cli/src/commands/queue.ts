import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import { Command } from 'commander'
import pc from 'picocolors'
import { resolveConfig } from '../config.js'

// This command drives the dashboard server's run queue, which every run trigger goes through.
// It is not the curation queue or the agent job queue.

async function refusalWord(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error: unknown }
      if (typeof error === 'string') return ` (${error})`
    }
  } catch {
    // Not a JSON body: the status line says all there is.
  }
  return ''
}

function printError(text: string): void {
  printRunText(text, (block) => console.error(block))
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

async function resolveServerUrl(opts: { server?: string }, globalOpts: { config?: string }): Promise<string> {
  if (opts.server) return opts.server
  const envUrl = process.env.AGENT_QA_DASHBOARD_URL
  if (envUrl) return envUrl
  try {
    const config = await resolveConfig({ configPath: globalOpts.config })
    const port = config.services?.dashboard?.port ?? 3470
    return `http://localhost:${port}`
  } catch {
    return 'http://localhost:3470'
  }
}

export function createQueueCommand(): Command {
  const cmd = new Command('queue')
    .description("Manage the dashboard's run queue")
    .addHelpText(
      'after',
      '\nagent-qa runs three separate queues; this command manages the first only:\n' +
        '  run queue        test executions dispatched by the dashboard server (this command)\n' +
        '  curation queue   knowledge curation work, drained under the writer lease\n' +
        '  agent job queue  durable background agent jobs in .agent-qa/agent-jobs.db\n' +
        '\nSee https://vostride.com/docs/agent-qa/daemon.\n',
    )

  cmd
    .command('list')
    .description('Show pending and running jobs in the run queue')
    .option('--json', 'output raw JSON')
    .option('--all', 'include recently completed jobs')
    .option('--server <url>', 'dashboard server URL')
    .action(async (opts: { json?: boolean; all?: boolean; server?: string }, command: Command) => {
      const releaseStdout = opts.json ? reserveStdoutForData() : undefined
      try {
        const program = command.parent!.parent!
        const globalOpts = program.opts<{ config?: string }>()
        const serverUrl = await resolveServerUrl(opts, globalOpts)
        const endpoint = `${serverUrl}/api/queue/status?completed=${opts.all ? 'true' : 'false'}`

        let data: any
        try {
          const response = await fetch(endpoint)
          if (!response.ok) {
            const word = await refusalWord(response)
            printError(pc.red(`Server returned ${response.status}: ${response.statusText}${word}`))
            process.exit(1)
          }
          data = await response.json()
        } catch {
          console.error(pc.red(`Could not connect to dashboard server at ${serverUrl}`))
          console.error(pc.dim('Make sure the dashboard is running: agent-qa dashboard'))
          process.exit(1)
        }

        if (opts.json) {
          console.log(guardJsonText(JSON.stringify(data, null, 2)))
          return
        }

        console.log()
        console.log(pc.bold('Run Queue Status'))
        console.log(`  Concurrency: ${pc.blue(String(data.concurrency))} slots (${pc.yellow(String(data.activeSlots))} active)`)
        console.log()

        const pending = data.pending?.jobs ?? []
        const running = data.running?.jobs ?? []

        if (pending.length === 0 && running.length === 0) {
          console.log(pc.dim('  Run queue is empty — no pending or running jobs'))
          console.log()
          return
        }

        if (pending.length > 0) {
          console.log(pc.bold(`Pending (${pending.length} jobs):`))
          console.log(pc.dim('  #   ID            Name                Priority  Source      Queued'))
          const rows: string[] = []
          for (let i = 0; i < pending.length; i++) {
            const job = pending[i]
            const num = String(i + 1).padEnd(3)
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const priority = String(job.priority ?? 0).padEnd(8)
            const source = (job.source ?? '').padEnd(10)
            const queued = job.createdAt ? timeAgo(job.createdAt) : ''
            rows.push(`  ${num} ${pc.dim(id)}  ${name}  ${priority}  ${source}  ${pc.dim(queued)}`)
          }
          printRunText(rows.join('\n'))
          console.log()
        }

        if (running.length > 0) {
          console.log(pc.bold(`Running (${running.length} jobs):`))
          console.log(pc.dim('  ID            Name                Source      Started'))
          const rows: string[] = []
          for (const job of running) {
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const source = (job.source ?? '').padEnd(10)
            const started = job.startedAt ? timeAgo(job.startedAt) : ''
            rows.push(`  ${pc.green(id)}  ${name}  ${source}  ${pc.dim(started)}`)
          }
          printRunText(rows.join('\n'))
          console.log()
        }

        if (opts.all && data.recent?.length > 0) {
          console.log(pc.bold(`Recent (${data.recent.length} jobs):`))
          console.log(pc.dim('  ID            Name                Status    Duration'))
          const rows: string[] = []
          for (const job of data.recent) {
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const status = (job.status ?? '').padEnd(8)
            const duration = job.duration ? `${Math.round(job.duration / 1000)}s` : ''
            const statusColor = job.status === 'passed' ? pc.green : job.status === 'failed' ? pc.red : pc.dim
            rows.push(`  ${pc.dim(id)}  ${name}  ${statusColor(status)}  ${pc.dim(duration)}`)
          }
          printRunText(rows.join('\n'))
          console.log()
        }
      } catch (err) {
        printError(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      } finally {
        releaseStdout?.()
      }
    })

  cmd
    .command('cancel')
    .description('Cancel a pending or running job in the run queue')
    .argument('<runId>', 'ID of the job to cancel')
    .option('--server <url>', 'dashboard server URL')
    .action(async (runId: string, opts: { server?: string }, command: Command) => {
      try {
        const program = command.parent!.parent!
        const globalOpts = program.opts<{ config?: string }>()
        const serverUrl = await resolveServerUrl(opts, globalOpts)

        let response: Response
        try {
          response = await fetch(`${serverUrl}/api/runs/${encodeURIComponent(runId)}/cancel`, {
            method: 'POST',
          })
        } catch {
          console.error(pc.red(`Could not connect to dashboard server at ${serverUrl}`))
          console.error(pc.dim('Make sure the dashboard is running: agent-qa dashboard'))
          process.exit(1)
        }

        // A 2xx prints the route's message; refusals exit 1 on stderr.
        if (response.ok) {
          const data = await response.json() as { message?: string }
          if (typeof data.message === 'string') {
            printRunText(data.message)
          } else {
            console.log(pc.red('Failed to cancel: Unknown error'))
            process.exit(1)
          }
          return
        }
        if (response.status === 404) {
          console.error(pc.red(`Job not found: ${runId}`))
        } else {
          const data = await response.json().catch(() => ({})) as { error?: string }
          printError(pc.red(data.error ?? `Failed to cancel: ${response.statusText}`))
        }
        process.exit(1)
      } catch (err) {
        printError(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }
    })

  return cmd
}
