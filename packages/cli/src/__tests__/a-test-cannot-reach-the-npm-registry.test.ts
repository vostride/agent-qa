// The setup guard refuses the default latest-version ask and fails the test, and a process the
// tests spawn sends its requests to a refusing loopback proxy.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { askLatestVersionByDefault } from '../commands/latest-version-ask.js'
import type * as LatestVersionAskModule from '../commands/latest-version-ask.js'
import { hermeticEnv } from './conformance/spawned-chat.js'
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

// Only a reserved `.invalid` address is fetched, so a lookup that escapes the proxy fails too.
const FETCH_AND_PRINT_THE_ERROR_CODE = `fetch('https://agent-qa.invalid/').then(
  () => console.log('answered'),
  (error) => console.log(String(error.cause?.code ?? error.code ?? error.message)),
)`

async function spawnedFetchErrorCode(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', FETCH_AND_PRINT_THE_ERROR_CODE],
    { env, timeout: 20_000 },
  )
  return stdout.trim()
}

describe('a process the tests spawn', () => {
  it('with the hermetic environment fails its request at the loopback proxy, not at a lookup', async () => {
    const { root } = tempProject('registry')

    const code = await spawnedFetchErrorCode(hermeticEnv(root))

    expect(code).toMatch(/^E[A-Z]+$/u)
    expect(code).not.toMatch(/^(ENOTFOUND|EAI_AGAIN)$/u)
  })

  it("with vitest's environment fails its request at the loopback proxy, not at a lookup", async () => {
    const code = await spawnedFetchErrorCode(process.env)

    expect(code).toMatch(/^E[A-Z]+$/u)
    expect(code).not.toMatch(/^(ENOTFOUND|EAI_AGAIN)$/u)
  })
})
