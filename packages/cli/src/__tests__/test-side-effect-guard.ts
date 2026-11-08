// Loaded before every CLI test file: the default runner refuses a real browser install.
import { afterEach, vi } from 'vitest'

import type * as ProjectHostModule from '../commands/project-host.js'

const RECORD = Symbol.for('agent-qa.test-side-effect-guard')
const ADVICE = 'Pass --no-browsers or inject host.run.'
const REFUSAL = `A test reached the real browser install. ${ADVICE}`

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

export function takeGuardedCalls(): string[] {
  return guardedCalls().splice(0)
}

export function assertNoGuardedCalls(): void {
  const calls = takeGuardedCalls()
  if (calls.length === 0) return
  throw new Error(
    `${calls.length} real side effects reached from this test: ${calls.join('; ')}. ${ADVICE}`,
  )
}

afterEach(() => {
  assertNoGuardedCalls()
})
