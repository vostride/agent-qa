import { createServer } from 'node:net'
import { NAME_SLUG_PATTERN } from '@vostride/agent-qa-schema'

import type { InitUi } from '../init-ui/init-ui.js'
import type { InitModelSetup, InitModelStatus } from './init-model-choice.js'
import { DASHBOARD_COMMAND } from './init-next-steps.js'
import type { InitStepResult, InitStepRunner } from './init-steps.js'
import { wasCancelled } from './package-manager.js'
import { HANDED_OFF_ENV, findProjectAgentQa, runningAgentQaBin } from './project-agent-qa.js'
import type { ProjectHost, RunResult } from './project-host.js'
import type { ProjectRange } from './project-range.js'

export const DASHBOARD_HOST = '127.0.0.1'
export const DEFAULT_DASHBOARD_PORT = 3470
const MODEL_PAGE = '/config/models'

export interface DashboardPort {
  probe(port: number): Promise<'free' | 'busy'>
  findFree(): Promise<number>
}

// The page that finishes the setup; none opens the runs page.
export function dashboardPage({
  model,
  dashboard,
}: {
  model: InitModelStatus['status']
  dashboard?: InitModelSetup['dashboard']
}): string | undefined {
  if (dashboard !== undefined) {
    const add = `${MODEL_PAGE}?add=${encodeURIComponent(dashboard.add)}`
    const { name } = dashboard
    return name !== undefined && NAME_SLUG_PATTERN.test(name)
      ? `${add}&name=${encodeURIComponent(name)}`
      : add
  }
  return model === 'pending' ? MODEL_PAGE : undefined
}

export function dashboardPortOf(config: Record<string, unknown>): number {
  const services = config.services as { dashboard?: { port?: unknown } } | undefined
  const port = services?.dashboard?.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_DASHBOARD_PORT
}

export function portInUse(port: number): string {
  return `port ${port} is in use`
}

// A port nothing can bind is as good as busy for the dashboard.
export function probeDashboardPort(
  port: number,
  host: string = DASHBOARD_HOST,
): Promise<'free' | 'busy'> {
  return new Promise((settle) => {
    const server = createServer()
    server.unref()
    server.once('error', () => settle('busy'))
    try {
      server.listen({ port, host, exclusive: true }, () => {
        server.close(() => settle('free'))
      })
    } catch {
      // A port outside 0-65535 throws here rather than emitting an error.
      settle('busy')
    }
  })
}

// The port the system hands out on loopback, released at once.
export function findFreePort(host: string = DASHBOARD_HOST): Promise<number> {
  return new Promise((settle, fail) => {
    const server = createServer()
    server.unref()
    server.once('error', fail)
    server.listen({ port: 0, host }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => settle(port))
    })
  })
}

// The dashboard always runs as a child, so a Ctrl-C that stops it ends the child, not init.
export async function runDashboardStep({
  host,
  range,
  page,
}: {
  host: ProjectHost
  range: ProjectRange
  page: string | undefined
}): Promise<RunResult> {
  const copy = await findProjectAgentQa(range, range.start, host.io)
  let bin = copy?.bin
  if (bin === undefined) {
    const running = runningAgentQaBin(host)
    if ('refusal' in running) throw new Error(running.refusal)
    bin = running.bin
  }
  return await host.run(
    host.execPath,
    [bin, 'dashboard', ...(page === undefined ? ['--open'] : ['--open', page])],
    { cwd: host.cwd, env: { ...host.env, [HANDED_OFF_ENV]: '1' }, stdio: 'inherit' },
  )
}

// A dashboard the person stopped, or that ended cleanly, is done; any other end is a failed start.
export function dashboardStepResult(result: RunResult, execPath: string): InitStepResult {
  const failed = (reason: string): InitStepResult => ({
    outcome: 'failed',
    reason,
    command: DASHBOARD_COMMAND,
  })
  if (result.missing === true) return failed(`${execPath} was not found to run the dashboard`)
  if (result.code === 0 || wasCancelled(result)) {
    return { outcome: 'done', text: 'Dashboard stopped' }
  }
  return failed(
    result.code === null
      ? `The dashboard ended by ${result.signal ?? 'a signal'}`
      : `The dashboard exited ${result.code}`,
  )
}

// Starting, or the command the next steps give for it.
export type InitDashboardChoice = 'starting' | { command: string }

// The dashboard step a fresh init and a re-run share.
export interface InitDashboardStep {
  // Records the step skipped for the first reason that holds; `skip` is the caller's own reason.
  decide(
    runner: InitStepRunner,
    options: { port: number; skip?: string },
  ): Promise<InitDashboardChoice>
  start(
    runner: InitStepRunner,
    ui: InitUi,
    options: { port: number; page: string | undefined },
  ): Promise<void>
}

export function initDashboardStep({
  interactive,
  noDashboard,
  host,
  range,
  runningVersion,
  ports,
}: {
  interactive: boolean
  noDashboard: boolean
  host: ProjectHost
  range: ProjectRange
  runningVersion: string
  ports: DashboardPort
}): InitDashboardStep {
  // The page init opens is one only this agent-qa's dashboard is known to take.
  const projectCopyDiffers = async (): Promise<boolean> => {
    const copy = await findProjectAgentQa(range, range.start, host.io)
    return copy !== undefined && copy.version !== runningVersion
  }
  return {
    async decide(runner, { port, skip }) {
      const skipped = (reason: string): InitDashboardChoice => {
        runner.skip('dashboard', `Dashboard: skipped (${reason})`, reason)
        return { command: DASHBOARD_COMMAND }
      }
      if (!interactive) return skipped('not interactive')
      if (noDashboard) return skipped('--no-dashboard')
      if (skip !== undefined) return skipped(skip)
      if (await projectCopyDiffers()) return skipped("the project's agent-qa differs from this one")
      if ((await ports.probe(port)) === 'free') return 'starting'
      // The config names the port, so init never moves the dashboard to another one itself.
      const inUse = portInUse(port)
      runner.skip('dashboard', `Dashboard: skipped (${inUse})`, inUse)
      return { command: `${DASHBOARD_COMMAND} --port ${await ports.findFree()}` }
    },
    async start(runner, ui, { port, page }) {
      ui.line(`Starting the dashboard on http://${DASHBOARD_HOST}:${port} (Ctrl-C stops it)`)
      // Until here a Ctrl-C interrupts init; while the dashboard runs, the host runner alone holds
      // Ctrl-C, so stopping the dashboard is the normal end.
      runner.dispose()
      let ended: RunResult | undefined
      let failure: unknown
      try {
        ended = await runDashboardStep({ host, range, page })
      } catch (error) {
        failure = error
      }
      // Drawn once the child has ended, since the child holds the terminal while it runs.
      await runner.run(
        'dashboard',
        { title: 'Dashboard', command: DASHBOARD_COMMAND },
        async (): Promise<InitStepResult> => {
          if (ended === undefined) throw failure
          return dashboardStepResult(ended, host.execPath)
        },
      )
    },
  }
}
