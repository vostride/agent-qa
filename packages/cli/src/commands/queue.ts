import { Command } from 'commander'
import pc from 'picocolors'
import { resolveConfig } from '../config.js'

// All triggers (dashboard, webhook, CLI, API) route through JobQueue — see Phase 60

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
    const port = (config as any).dashboard?.port || 3470
    return `http://localhost:${port}`
  } catch {
    return 'http://localhost:3470'
  }
}

export function createQueueCommand(): Command {
  const cmd = new Command('queue')
    .description('Manage the test execution queue')

  cmd
    .command('list')
    .description('Show pending and running jobs in the queue')
    .option('--json', 'output raw JSON')
    .option('--all', 'include recently completed jobs')
    .option('--server <url>', 'dashboard server URL')
    .action(async (opts: { json?: boolean; all?: boolean; server?: string }, command: Command) => {
      try {
        const program = command.parent!.parent!
        const globalOpts = program.opts<{ config?: string }>()
        const serverUrl = await resolveServerUrl(opts, globalOpts)
        const endpoint = `${serverUrl}/api/queue/status?completed=${opts.all ? 'true' : 'false'}`

        let data: any
        try {
          const response = await fetch(endpoint)
          if (!response.ok) {
            console.error(pc.red(`Server returned ${response.status}: ${response.statusText}`))
            process.exit(1)
          }
          data = await response.json()
        } catch {
          console.error(pc.red(`Could not connect to dashboard server at ${serverUrl}`))
          console.error(pc.dim('Make sure the dashboard is running: agent-qa dashboard'))
          process.exit(1)
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2))
          return
        }

        console.log()
        console.log(pc.bold('Queue Status'))
        console.log(`  Concurrency: ${pc.blue(String(data.concurrency))} slots (${pc.yellow(String(data.activeSlots))} active)`)
        console.log()

        const pending = data.pending?.jobs ?? []
        const running = data.running?.jobs ?? []

        if (pending.length === 0 && running.length === 0) {
          console.log(pc.dim('  Queue is empty — no pending or running jobs'))
          console.log()
          return
        }

        if (pending.length > 0) {
          console.log(pc.bold(`Pending (${pending.length} jobs):`))
          console.log(pc.dim('  #   ID            Name                Priority  Source      Queued'))
          for (let i = 0; i < pending.length; i++) {
            const job = pending[i]
            const num = String(i + 1).padEnd(3)
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const priority = String(job.priority ?? 0).padEnd(8)
            const source = (job.source ?? '').padEnd(10)
            const queued = job.createdAt ? timeAgo(job.createdAt) : ''
            console.log(`  ${num} ${pc.dim(id)}  ${name}  ${priority}  ${source}  ${pc.dim(queued)}`)
          }
          console.log()
        }

        if (running.length > 0) {
          console.log(pc.bold(`Running (${running.length} jobs):`))
          console.log(pc.dim('  ID            Name                Source      Started'))
          for (const job of running) {
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const source = (job.source ?? '').padEnd(10)
            const started = job.startedAt ? timeAgo(job.startedAt) : ''
            console.log(`  ${pc.green(id)}  ${name}  ${source}  ${pc.dim(started)}`)
          }
          console.log()
        }

        if (opts.all && data.recent?.length > 0) {
          console.log(pc.bold(`Recent (${data.recent.length} jobs):`))
          console.log(pc.dim('  ID            Name                Status    Duration'))
          for (const job of data.recent) {
            const id = (job.id ?? '').slice(0, 12).padEnd(12)
            const name = (job.name ?? '').slice(0, 18).padEnd(18)
            const status = (job.status ?? '').padEnd(8)
            const duration = job.duration ? `${Math.round(job.duration / 1000)}s` : ''
            const statusColor = job.status === 'passed' ? pc.green : job.status === 'failed' ? pc.red : pc.dim
            console.log(`  ${pc.dim(id)}  ${name}  ${statusColor(status)}  ${pc.dim(duration)}`)
          }
          console.log()
        }
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }
    })

  cmd
    .command('cancel')
    .description('Cancel a pending or running job')
    .argument('<runId>', 'ID of the job to cancel')
    .option('--server <url>', 'dashboard server URL')
    .action(async (runId: string, opts: { server?: string }, command: Command) => {
      try {
        const program = command.parent!.parent!
        const globalOpts = program.opts<{ config?: string }>()
        const serverUrl = await resolveServerUrl(opts, globalOpts)

        let response: Response
        try {
          response = await fetch(`${serverUrl}/api/runs/${runId}/cancel`, { method: 'POST' })
        } catch {
          console.error(pc.red(`Could not connect to dashboard server at ${serverUrl}`))
          console.error(pc.dim('Make sure the dashboard is running: agent-qa dashboard'))
          process.exit(1)
        }

        if (response.ok) {
          const data = await response.json() as any
          if (data.cancelled) {
            console.log(pc.green(`✓ Cancelled job ${runId}`))
          } else {
            console.log(pc.red(`Failed to cancel: ${data.error ?? 'Unknown error'}`))
          }
        } else if (response.status === 404) {
          console.log(pc.red(`Job not found: ${runId}`))
        } else {
          const data = await response.json().catch(() => ({})) as any
          console.log(pc.red(`Failed to cancel: ${data.error ?? response.statusText}`))
        }
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }
    })

  return cmd
}
