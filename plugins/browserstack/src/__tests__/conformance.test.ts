import { fileURLToPath } from 'node:url'
import { expectManifestCurrent, runConformance } from '@vostride/agent-qa-plugin-kit/testing'
import { describe, expect, it } from 'vitest'
import plugin from '../plugin.js'
import { BROWSERSTACK_PLAYWRIGHT_VERSIONS } from '../playwright-versions.js'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const OLDEST = BROWSERSTACK_PLAYWRIGHT_VERSIONS[0]
const NEWEST = BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]

const options = {
  username: 'bs-test-user',
  accessKey: 'bs-test-access-key',
  apiUrl: 'http://127.0.0.1:9',
  appApiUrl: 'http://127.0.0.1:9',
  hubUrl: 'http://127.0.0.1:9/wd/hub',
  playwrightUrl: 'ws://127.0.0.1:9/playwright',
}

describe('the BrowserStack plugin against the kit', () => {
  it('passes every conformance check when the host carries a Playwright version BrowserStack lists', async () => {
    const report = await runConformance({
      packageDir,
      options,
      host: { playwrightVersion: `${NEWEST}.0` },
    })

    expect(report.checks.filter((check) => !check.ok)).toEqual([])
    expect(report.checks).not.toEqual([])
  })

  it("fails the acquire checks with the version refusal on the kit's default Playwright version", async () => {
    const report = await runConformance({ packageDir, options })

    const release = report.checks.find((check) => check.name === 'idempotent-release')
    expect(release?.ok).toBe(false)
    expect(release?.detail).toContain(
      `BrowserStack lists Playwright ${OLDEST} to ${NEWEST}, and agent-qa's Playwright version is unknown,`,
    )
    expect(release?.detail).toContain('(kind version)')
    const failed = report.checks.filter((check) => !check.ok)
    expect(failed.filter((check) => !check.detail?.includes('(kind version)'))).toEqual([])
  })

  it('keeps the committed manifest equal to the one the build generates', () => {
    expectManifestCurrent(packageDir, plugin)
  })

  it('finds the manifest stale when the definition changes without a rebuild', () => {
    expect(() => expectManifestCurrent(packageDir, { ...plugin, serves: ['cdp'] })).toThrow(
      /serves/,
    )
  })
})
