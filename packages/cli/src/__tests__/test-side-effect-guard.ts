// Loaded before every CLI test file: the default runner refuses a real browser install and a real
// dashboard, the dashboard command's default opener refuses to open a real browser, the
// dashboard's port probe refuses a fixed port, the update notice's default spawn refuses to
// start a real registry refresh, the default latest-version ask refuses to reach the registry, the
// default Chromium resolver refuses to read this machine's browser cache, the default Playground
// download refuses to reach its GitHub release, and the default Android and iOS listers refuse to
// list this machine's phones, emulators and simulators.
import type * as AndroidModule from '@vostride/agent-qa-android'
import type * as IOSModule from '@vostride/agent-qa-ios'
import { afterEach, vi } from 'vitest'

import type * as BrowserResolverModule from '../commands/browser-resolver.js'
import type * as InitDashboardModule from '../commands/init-dashboard.js'
import type * as LatestVersionAskModule from '../commands/latest-version-ask.js'
import type * as OpenUrlModule from '../commands/open-url.js'
import type * as PlaygroundAppFetchModule from '../commands/playground-app-fetch.js'
import type * as ProjectHostModule from '../commands/project-host.js'
import type * as VersionRefreshSpawnModule from '../version-refresh-spawn.js'

const RECORD = Symbol.for('agent-qa.test-side-effect-guard')
const INSTALL_ADVICE = 'Pass --no-browsers or inject host.run.'
const DASHBOARD_ADVICE = 'Inject host.run or pass --no-dashboard.'
const OPENER_ADVICE = 'Pass an opener to createDashboardCommand.'
const PROBE_ADVICE = 'Inject hooks.dashboardPort or pass --no-dashboard.'
const REFRESH_ADVICE = 'Inject spawnRefresh.'
const REGISTRY_ADVICE = 'Inject hooks.latestVersion.'
const CHROMIUM_ADVICE = 'Inject hooks.chromium.'
const PLAYGROUND_ADVICE = 'Inject hooks.playgroundApp.'
const DEVICES_ADVICE = 'Inject listDevicesHere.'
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

// Only the address's origin is recorded: the rest of an address can carry session state.
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
  const refuse = (url: string): never => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push(`open ${origin(url)}`)
    throw new Error(
      'A test reached the real browser opener. Pass an opener to createDashboardCommand.',
    )
  }
  // The dashboard command's default opener is this export.
  const systemBrowserOpener: OpenUrlModule.BrowserOpener = {
    platform: process.platform,
    spawn: (_command, args) => refuse(String(args.at(-1)).replace(/^"|"$/gu, '')),
  }
  return { ...real, systemBrowserOpener }
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

vi.mock('../version-refresh-spawn.js', async (importOriginal) => {
  const real = await importOriginal<typeof VersionRefreshSpawnModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const spawnVersionRefresh: VersionRefreshSpawnModule.VersionRefreshSpawn = () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('refresh registry')
    throw new Error(`A test reached a real registry refresh. ${REFRESH_ADVICE}`)
  }
  return { ...real, spawnVersionRefresh }
})

vi.mock('../commands/latest-version-ask.js', async (importOriginal) => {
  const real = await importOriginal<typeof LatestVersionAskModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const askLatestVersionByDefault: LatestVersionAskModule.LatestVersionAsk = async () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('registry ask')
    throw new Error(`A test reached the npm registry. ${REGISTRY_ADVICE}`)
  }
  return { ...real, askLatestVersionByDefault }
})

vi.mock('../commands/browser-resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof BrowserResolverModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const findChromiumByDefault: BrowserResolverModule.ChromiumResolver = () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('chromium')
    throw new Error(`A test reached this machine's browser cache. ${CHROMIUM_ADVICE}`)
  }
  return { ...real, findChromiumByDefault }
})

vi.mock('../commands/playground-app-fetch.js', async (importOriginal) => {
  const real = await importOriginal<typeof PlaygroundAppFetchModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const fetchPlaygroundAppByDefault: typeof real.fetchPlaygroundAppByDefault = async () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('playground release')
    throw new Error(`A test reached the Playground release. ${PLAYGROUND_ADVICE}`)
  }
  return { ...real, fetchPlaygroundAppByDefault }
})

vi.mock('@vostride/agent-qa-android', async (importOriginal) => {
  const real = await importOriginal<typeof AndroidModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const listAndroidDevicesHere: typeof real.listAndroidDevicesHere = async () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('list devices')
    throw new Error("A test reached this machine's device listing. Inject listDevicesHere.")
  }
  return { ...real, listAndroidDevicesHere }
})

vi.mock('@vostride/agent-qa-ios', async (importOriginal) => {
  const real = await importOriginal<typeof IOSModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const listIOSSimulatorsHere: typeof real.listIOSSimulatorsHere = async () => {
    const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
    calls.push('list devices')
    throw new Error("A test reached this machine's device listing. Inject listDevicesHere.")
  }
  return { ...real, listIOSSimulatorsHere }
})

function adviceFor(call: string): string {
  if (call === 'chromium') return CHROMIUM_ADVICE
  if (call === 'list devices') return DEVICES_ADVICE
  if (call.startsWith('open ')) return OPENER_ADVICE
  if (call.startsWith('refresh ')) return REFRESH_ADVICE
  if (call.startsWith('registry ')) return REGISTRY_ADVICE
  if (call.startsWith('playground ')) return PLAYGROUND_ADVICE
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
