import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  findChromium,
  findChromiumByDefault,
  resolveWebPlaywrightCore,
} from '../commands/browser-resolver.js'
import { resolvePlaywrightCoreCli } from '../commands/install-browsers.js'
import { cleanupTempProjects, tempProject, writeInstalledPackage } from './project-fixtures.js'
import { assertNoGuardedCalls, takeGuardedCalls } from './test-side-effect-guard.js'

const CHROMIUM = '/browsers/chromium-1/chrome'

function playwrightCore(executablePath: () => string) {
  const launch = vi.fn(() => {
    throw new Error('launched a browser')
  })
  return { module: { chromium: { executablePath, launch } }, launch }
}

// A project's own agent-qa, with its web package and that package's playwright-core.
function projectAgentQa(): { agentQaDir: string; playwrightCoreDir: string } {
  const { root } = tempProject('browser-resolver')
  const agentQa = writeInstalledPackage(root, 'agent-qa', '1.2.3', {
    packageJson: { bin: { 'agent-qa': 'cli.js' } },
    files: { 'cli.js': '' },
  })
  const web = writeInstalledPackage(root, '@vostride/agent-qa-web', '1.2.3', {
    packageJson: { main: 'index.js' },
    files: { 'index.js': 'module.exports = {}\n' },
  })
  const core = writeInstalledPackage(dirname(web), 'playwright-core', '1.0.0', {
    packageJson: { main: 'index.js' },
    files: {
      'index.js':
        "exports.chromium = { executablePath: () => require('node:path').join(__dirname, 'chrome') }\n",
      'cli.js': '',
    },
  })
  return { agentQaDir: dirname(agentQa), playwrightCoreDir: dirname(core) }
}

afterEach(() => {
  cleanupTempProjects()
})

describe('findChromium', () => {
  it('answers found with the path when executablePath names a file that exists, launching nothing', () => {
    const { module, launch } = playwrightCore(() => CHROMIUM)

    const answer = findChromium({ playwrightCore: module, exists: (path) => path === CHROMIUM })

    expect(answer).toEqual({ found: true, path: CHROMIUM })
    expect(launch).not.toHaveBeenCalled()
  })

  it('answers not found, naming the path, when no file is there', () => {
    const { module, launch } = playwrightCore(() => CHROMIUM)

    const answer = findChromium({ playwrightCore: module, exists: () => false })

    expect(answer).toEqual({ found: false, reason: `no file at ${CHROMIUM}` })
    expect(launch).not.toHaveBeenCalled()
  })

  it('answers not found with the error when executablePath throws', () => {
    const { module } = playwrightCore(() => {
      throw new Error('unsupported host')
    })

    const answer = findChromium({ playwrightCore: module, exists: () => true })

    expect(answer).toEqual({ found: false, reason: 'unsupported host' })
  })
})

describe('resolveWebPlaywrightCore', () => {
  it("resolves the playwright-core of the given agent-qa folder's web package", () => {
    const { agentQaDir, playwrightCoreDir } = projectAgentQa()

    const resolved = resolveWebPlaywrightCore(agentQaDir)

    expect(resolved.chromium.executablePath()).toBe(join(playwrightCoreDir, 'chrome'))
  })

  it("resolves the running agent-qa's playwright-core when given no folder", () => {
    const entry = join(dirname(resolvePlaywrightCoreCli()), 'index.js')

    expect(resolveWebPlaywrightCore()).toBe(createRequire(import.meta.url)(entry))
  })
})

describe('install-browsers', () => {
  it('resolves the same playwright-core the resolver does', () => {
    const { agentQaDir, playwrightCoreDir } = projectAgentQa()

    expect(resolvePlaywrightCoreCli(agentQaDir)).toBe(join(playwrightCoreDir, 'cli.js'))
    expect(dirname(resolveWebPlaywrightCore(agentQaDir).chromium.executablePath())).toBe(
      dirname(resolvePlaywrightCoreCli(agentQaDir)),
    )
  })
})

describe('the default Chromium resolver in a test', () => {
  const REFUSAL = "A test reached this machine's browser cache. Inject hooks.chromium."

  it('is refused and recorded', () => {
    expect(() => findChromiumByDefault({})).toThrow(REFUSAL)

    expect(takeGuardedCalls()).toEqual(['chromium'])
  })

  it('fails the check after the test, naming hooks.chromium', () => {
    try {
      findChromiumByDefault({})
    } catch {}

    expect(() => assertNoGuardedCalls()).toThrow(
      /^1 real side effects reached from this test: chromium\. Inject hooks\.chromium\.$/u,
    )
  })
})
