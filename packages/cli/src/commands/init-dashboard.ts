import { createServer } from 'node:net'
import { NAME_SLUG_PATTERN } from '@vostride/agent-qa-schema'

import type { InitModelSetup, InitModelStatus } from './init-model-choice.js'
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
  return typeof port === 'number' && Number.isInteger(port) && port > 0
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
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => settle('free'))
    })
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

// The dashboard always runs as a child, so its own exit, a Ctrl-C included, never decides init's.
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
