// Loaded before every CLI test file: the default runner refuses a real browser install, and the
// default opener refuses to open a real browser.
import { afterEach, vi } from 'vitest'

import type * as OpenUrlModule from '../commands/open-url.js'
import type * as ProjectHostModule from '../commands/project-host.js'

const RECORD = Symbol.for('agent-qa.test-side-effect-guard')
const INSTALL_ADVICE = 'Pass --no-browsers or inject host.run.'
const OPENER_ADVICE = 'Inject hooks.openUrl.'
const REFUSAL = `A test reached the real browser install. ${INSTALL_ADVICE}`

type GuardedGlobal = Record<symbol, string[] | undefined>

function guardedCalls(): string[] {
  return ((globalThis as unknown as GuardedGlobal)[RECORD] ??= [])
}

vi.mock('../commands/project-host.js', async (importOriginal) => {
  const real = await importOriginal<typeof ProjectHostModule>()
  const store = Symbol.for('agent-qa.test-side-effect-guard')
  const guarded: ProjectHostModule.CommandRunner = async (command, args, options) => {
    if (args.includes('install-browsers')) {
      const calls = ((globalThis as unknown as GuardedGlobal)[store] ??= [])
      calls.push([command, ...args].join(' '))
      throw new Error(REFUSAL)
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

export function takeGuardedCalls(): string[] {
  return guardedCalls().splice(0)
}

export function assertNoGuardedCalls(): void {
  const calls = takeGuardedCalls()
  if (calls.length === 0) return
  const advice = [
    ...(calls.some((call) => !call.startsWith('open ')) ? [INSTALL_ADVICE] : []),
    ...(calls.some((call) => call.startsWith('open ')) ? [OPENER_ADVICE] : []),
  ]
  throw new Error(
    `${calls.length} real side effects reached from this test: ${calls.join('; ')}. ` +
      advice.join(' '),
  )
}

afterEach(() => {
  assertNoGuardedCalls()
})
