// Loaded before every CLI test file: the default runner refuses a real browser install and a real
// dashboard, the default opener refuses to open a real browser, and the dashboard's port probe
// refuses a fixed port.
import { afterEach, vi } from 'vitest'

import type * as InitDashboardModule from '../commands/init-dashboard.js'
import type * as OpenUrlModule from '../commands/open-url.js'
import type * as ProjectHostModule from '../commands/project-host.js'

const RECORD = Symbol.for('agent-qa.test-side-effect-guard')
const INSTALL_ADVICE = 'Pass --no-browsers or inject host.run.'
const DASHBOARD_ADVICE = 'Inject host.run or pass --no-dashboard.'
const OPENER_ADVICE = 'Inject hooks.openUrl.'
const PROBE_ADVICE = 'Inject hooks.dashboardPort or pass --no-dashboard.'
const REFUSAL = `A test reached the real browser install. ${INSTALL_ADVICE}`
const DASHBOARD_REFUSAL = `A test reached a real dashboard. ${DASHBOARD_ADVICE}`
// Linux hands out ports from 32768 and macOS and Windows from 49152, so a lower one is fixed.
const FIRST_ASSIGNED_PORT = 32768

type GuardedGlobal = Record<symbol, string[] | undefined>

function guardedCalls(): string[] {
  return ((globalThis as unknown as GuardedGlobal)[RECORD] ??= [])
}

vi.mock('../commands/project-host.js', async (importOriginal) => {
  const real = await importOriginal<typeof ProjectHostModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const guarded: ProjectHostModule.CommandRunner = async (command, args, options) => {
    const refusal = args.includes('install-browsers')
      ? REFUSAL
      : args.includes('dashboard')
        ? DASHBOARD_REFUSAL
        : undefined
    if (refusal !== undefined) {
      const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
      calls.push([command, ...args].join(' '))
      throw new Error(refusal)
    }
    return await real.spawnRunner(command, args, options)
  }
  return {
    ...real,
    spawnRunner: guarded,
    projectHost: (overrides: Partial<ProjectHostModule.ProjectHost> = {}) =>
      real.projectHost({ ...overrides, run: overrides.run ?? guarded }),
  }
})

// Only the address's origin is recorded: the rest of a sign-in address carries session state.
vi.mock('../commands/open-url.js', async (importOriginal) => {
  const real = await importOriginal<typeof OpenUrlModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const origin = (url: string): string => {
    try {
      return new URL(url).origin
    } catch {
      return 'an address that does not parse'
    }
  }
  return {
    ...real,
    openInBrowser: (url: string, opener?: OpenUrlModule.BrowserOpener) => {
      if (opener !== undefined) return real.openInBrowser(url, opener)
      const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
      calls.push(`open ${origin(url)}`)
      throw new Error('A test reached the real browser opener. Inject hooks.openUrl.')
    },
  }
})

vi.mock('../commands/init-dashboard.js', async (importOriginal) => {
  const real = await importOriginal<typeof InitDashboardModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  return {
    ...real,
    probeDashboardPort: async (port: number, host?: string) => {
      if (port >= FIRST_ASSIGNED_PORT) return await real.probeDashboardPort(port, host)
      const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
      calls.push(`probe ${port}`)
      throw new Error(`A test reached a real probe of port ${port}. ${PROBE_ADVICE}`)
    },
  }
})

function adviceFor(call: string): string {
  if (call.startsWith('open ')) return OPENER_ADVICE
  if (call.startsWith('probe ')) return PROBE_ADVICE
  return call.split(' ').includes('install-browsers') ? INSTALL_ADVICE : DASHBOARD_ADVICE
}

export function takeGuardedCalls(): string[] {
  return guardedCalls().splice(0)
}

export function assertNoGuardedCalls(): void {
  const calls = takeGuardedCalls()
  if (calls.length === 0) return
  const advice = [...new Set(calls.map(adviceFor))]
  throw new Error(
    `${calls.length} real side effects reached from this test: ${calls.join('; ')}. ` +
      advice.join(' '),
  )
}

afterEach(() => {
  assertNoGuardedCalls()
})
