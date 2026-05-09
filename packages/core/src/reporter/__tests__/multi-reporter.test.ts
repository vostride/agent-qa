import { describe, expect, it, vi } from 'vitest'
import type { Reporter } from '../types.js'
import { FatalReporterError, MultiReporter } from '../types.js'
import type { TestDefinition } from '../../types/test.js'

function makeTestDef(): TestDefinition {
  return {
    'test-id': 't_login-test',
    name: 'Login test',
    target: 'default',
    steps: ['Click Login'],
  }
}

describe('MultiReporter fatal error handling', () => {
  it('swallows a normal reporter error and continues to later reporters', async () => {
    const test = makeTestDef()
    const normalReporter: Reporter = {
      onTestStart: vi.fn().mockRejectedValue(new Error('normal reporter failed')),
    }
    const laterReporter: Reporter = {
      onTestStart: vi.fn(),
    }
    const multi = new MultiReporter([normalReporter, laterReporter])

    await expect(multi.onTestStart(test, '/tests/login.yaml')).resolves.toBeUndefined()

    expect(normalReporter.onTestStart).toHaveBeenCalledWith(test, '/tests/login.yaml')
    expect(laterReporter.onTestStart).toHaveBeenCalledWith(test, '/tests/login.yaml')
  })

  it('rethrows FatalReporterError so required artifact writes can fail fast', async () => {
    const test = makeTestDef()
    const reporter: Reporter = {
      onTestStart: vi.fn().mockRejectedValue(new FatalReporterError('artifact persistence failed')),
    }
    const multi = new MultiReporter([reporter])

    await expect(multi.onTestStart(test, '/tests/login.yaml'))
      .rejects.toThrow('artifact persistence failed')
  })
})
