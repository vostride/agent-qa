// The setup guard refuses the default latest-version ask and fails the test.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { askLatestVersionByDefault } from '../commands/latest-version-ask.js'
import type * as LatestVersionAskModule from '../commands/latest-version-ask.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'
import { assertNoGuardedCalls, takeGuardedCalls } from './test-side-effect-guard.js'

const coreAsks = vi.hoisted(() => [] as unknown[])

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...real,
    askLatestAgentQaVersion: async (options: unknown) => {
      coreAsks.push(options)
      return { source: 'none' as const }
    },
  }
})

const REFUSAL = 'A test reached the npm registry. Inject hooks.latestVersion.'

afterEach(() => {
  coreAsks.length = 0
  cleanupTempProjects()
})

describe('the default latest-version ask in a test', () => {
  it('is refused before any request and records it', async () => {
    const { home } = tempProject('registry')

    const refusal = await askLatestVersionByDefault(home).then(
      () => 'the ask answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    expect(refusal).toBe(REFUSAL)
    expect(takeGuardedCalls()).toEqual(['registry ask'])
    expect(coreAsks).toEqual([])
  })

  it('the check after each test names the hook to inject', async () => {
    const { home } = tempProject('registry')
    await askLatestVersionByDefault(home).catch(() => undefined)

    expect(() => assertNoGuardedCalls()).toThrow(
      /^1 real side effects reached from this test: registry ask\. Inject hooks\.latestVersion\.$/u,
    )
    expect(takeGuardedCalls()).toEqual([])
  })
})

describe('the default latest-version ask outside a test', () => {
  it('hands core the global fetch, the home folder and a 1,500 ms deadline', async () => {
    const real = await vi.importActual<typeof LatestVersionAskModule>(
      '../commands/latest-version-ask.js',
    )
    const { home } = tempProject('registry')

    await real.askLatestVersionByDefault(home)

    expect(real.LATEST_VERSION_DEADLINE_MS).toBe(1_500)
    expect(coreAsks).toEqual([{ homeDir: home, fetchImpl: globalThis.fetch, timeoutMs: 1_500 }])
  })
})
