import { fileURLToPath } from 'node:url'
import { expectManifestCurrent, runConformance } from '@vostride/agent-qa-plugin-kit/testing'
import { describe, expect, it } from 'vitest'
import plugin from '../plugin.js'
import { startFakeHyperbrowserApi } from './fake-hyperbrowser-api.js'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))

describe('the Hyperbrowser plugin against the kit', () => {
  it('passes every conformance check against a loopback fake Hyperbrowser API and stops every session it created', async () => {
    const api = await startFakeHyperbrowserApi()
    try {
      const report = await runConformance({
        packageDir,
        options: { apiKey: 'test-key', apiUrl: api.url },
      })

      expect(report.checks.filter((check) => !check.ok)).toEqual([])
      expect(report.checks.map((check) => check.name).sort()).toEqual([
        'answered-cancel',
        'clean-stdout',
        'exit-on-stdin-close',
        'handshake',
        'idempotent-release',
        'manifest',
        'unknown-method',
      ])
      expect(api.createdIds()).not.toEqual([])
      expect([...new Set(api.stoppedIds())].sort()).toEqual(api.createdIds().sort())
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
