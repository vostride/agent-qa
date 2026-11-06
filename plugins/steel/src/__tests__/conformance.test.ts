import { fileURLToPath } from 'node:url'
import { expectManifestCurrent, runConformance } from '@vostride/agent-qa-plugin-kit/testing'
import { describe, expect, it } from 'vitest'
import plugin from '../plugin.js'
import { startFakeSteelApi } from './fake-steel-api.js'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))

describe('the Steel plugin against the kit', () => {
  it('passes every conformance check against a loopback fake Steel API and releases every session it created', async () => {
    const api = await startFakeSteelApi()
    try {
      const report = await runConformance({
        packageDir,
        options: { apiKey: 'test-key', apiUrl: api.url },
      })

      expect(report.checks.filter((check) => !check.ok)).toEqual([])
      expect(report.checks).not.toEqual([])
      expect(api.createdIds()).not.toEqual([])
      expect([...new Set(api.releasedIds())].sort()).toEqual(api.createdIds().sort())
    } finally {
      await api.close()
    }
  })

  it('keeps the committed manifest equal to the one the build generates', () => {
    expectManifestCurrent(packageDir, plugin)
  })

  it('finds the manifest stale when the definition changes without a rebuild', () => {
    expect(() => expectManifestCurrent(packageDir, { ...plugin, serves: ['playwright'] })).toThrow(
      /serves/,
    )
  })
})
