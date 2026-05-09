import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const { mockRunTest } = vi.hoisted(() => ({
  mockRunTest: vi.fn(),
}))

vi.mock('../../agent/runner.js', () => ({
  runTest: mockRunTest,
}))

import { runSuite } from '../runner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runnerPath = join(__dirname, '..', 'runner.ts')

describe('suite runner compatibility (Phase 181)', () => {
  it('runner.ts contains no references to (suite as any).variables after cleanup', async () => {
    const content = await readFile(runnerPath, 'utf-8')
    expect(content).not.toContain('(suite as any).variables')
    expect(content).not.toContain('suite.variables')
  })

  it('runner.ts still references suiteHookVars (hook-derived vars remain)', async () => {
    const content = await readFile(runnerPath, 'utf-8')
    expect(content).toContain('suiteHookVars')
  })
})

function deferredTestResult(name: string) {
  let resolveResult!: () => void
  const promise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveResult = () => resolvePromise({
      name,
      status: 'passed',
      steps: [],
      duration: 100,
    })
  })
  return { promise, resolve: resolveResult }
}

async function waitForCondition(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('suite runner member ordering', () => {
  it('keeps suite members sequential when suite use.parallel is true', async () => {
    mockRunTest.mockReset()
    const dir = await mkdtemp(join(tmpdir(), 'agent-qa-suite-member-order-'))
    try {
      const firstPath = join(dir, 'first.yaml')
      const secondPath = join(dir, 'second.yaml')
      await writeFile(firstPath, 'name: First member\n')
      await writeFile(secondPath, 'name: Second member\n')

      const first = deferredTestResult('First member')
      const second = deferredTestResult('Second member')
      const started: string[] = []
      mockRunTest.mockImplementation((test: { name: string }) => {
        started.push(test.name)
        return test.name === 'First member' ? first.promise : second.promise
      })

      const suitePromise = runSuite(
        {
          name: 'Ordered suite',
          target: 'web',
          use: { parallel: true },
          tests: [
            { test: firstPath, id: 'first-member' },
            { test: secondPath, id: 'second-member' },
          ],
        } as any,
        [
          [{ name: 'First member', target: 'web', steps: [] } as any, firstPath],
          [{ name: 'Second member', target: 'web', steps: [] } as any, secondPath],
        ],
        {
          adapter: {
            setup: vi.fn().mockResolvedValue(undefined),
            cleanup: vi.fn().mockResolvedValue(undefined),
          },
          platformConfig: { platform: 'web' },
          planner: {},
          healingConfig: { maxAttempts: 0 },
          plannerModel: {},
          verifierModel: {},
        } as any,
      )

      await waitForCondition(() => started.length >= 1)
      expect(started).toEqual(['First member'])

      first.resolve()
      await waitForCondition(() => started.length >= 2)
      expect(started).toEqual(['First member', 'Second member'])

      second.resolve()
      const result = await suitePromise
      expect(result.status).toBe('passed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes provided memoryRoot to suite member memory initialization', async () => {
    mockRunTest.mockReset()
    mockRunTest.mockResolvedValue({
      name: 'Memory member',
      status: 'passed',
      steps: [],
      duration: 100,
    })
    const dir = await mkdtemp(join(tmpdir(), 'agent-qa-suite-memory-root-'))
    try {
      const testPath = join(dir, 'memory.yaml')
      await writeFile(testPath, 'name: Memory member\n')

      await runSuite(
        {
          name: 'Memory suite',
          target: 'web',
          tests: [{ test: testPath, id: 'memory-member' }],
        } as any,
        [[{ name: 'Memory member', target: 'web', steps: [] } as any, testPath]],
        {
          adapter: {
            setup: vi.fn().mockResolvedValue(undefined),
            cleanup: vi.fn().mockResolvedValue(undefined),
          },
          platformConfig: { platform: 'web' },
          planner: {},
          healingConfig: { maxAttempts: 0 },
          plannerModel: {},
          verifierModel: {},
          memoryProvider: { getInjectedObservations: vi.fn(() => []) },
          memoryRoot: '/tmp/custom-agent-qa-memory',
          memoryConfig: { enabled: true, curatorEnabled: false, ablationEnabled: false },
          product: 'custom-product',
        } as any,
      )

      expect(mockRunTest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          memoryInitParams: expect.objectContaining({
            memoryRoot: '/tmp/custom-agent-qa-memory',
            product: 'custom-product',
            testId: 'Memory member',
          }),
        }),
        expect.anything(),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
