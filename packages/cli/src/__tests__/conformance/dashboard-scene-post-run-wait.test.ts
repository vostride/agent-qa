// The dashboard scene must not close while a run is still on its way to its post-run work, or while
// that work is running, because that work logs after the run settles and a line logged after close
// can outlive the test worker.

import { afterAll, describe, expect, it, vi } from 'vitest'

// Two gates the cell releases: one holds the run between its runFinished event and the start of its
// post-run work, the other holds that work's drain open and records when the drain finished.
const hold = vi.hoisted(() => {
  const gate = () => {
    let enter: () => void = () => undefined
    let open: () => void = () => undefined
    const entered = new Promise<void>((settle) => { enter = settle })
    const released = new Promise<void>((settle) => { open = settle })
    return {
      entered,
      released,
      enter: (): void => { enter() },
      release: (): void => { open() },
    }
  }
  return {
    drive: gate(),
    drain: gate(),
    finishedAt: undefined as number | undefined,
  }
})

vi.mock('../../curation/post-verdict-continuation.js', async (importOriginal) => {
  type Continuation = typeof import('../../curation/post-verdict-continuation.js')
  const original = await importOriginal<Continuation>()
  return {
    ...original,
    waitForPostVerdictContinuation: async (
      ...args: Parameters<typeof original.waitForPostVerdictContinuation>
    ): Promise<boolean> => {
      hold.drive.enter()
      await hold.drive.released
      return original.waitForPostVerdictContinuation(...args)
    },
  }
})

vi.mock('../../curation/post-run-tail-composition.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../curation/post-run-tail-composition.js')>()
  return {
    ...original,
    composeCliPostRunTail: (...args: Parameters<typeof original.composeCliPostRunTail>) => {
      const tail = original.composeCliPostRunTail(...args)
      return {
        drain: async (input?: Parameters<typeof tail.drain>[0]): Promise<void> => {
          hold.drain.enter()
          try {
            await hold.drain.released
            await tail.drain(input)
          } finally {
            hold.finishedAt = Date.now()
          }
        },
        finish: (input?: Parameters<typeof tail.finish>[0]) => tail.finish(input),
        report: () => tail.report(),
      }
    },
  }
})

import {
  openDashboardScene,
  recordedDoorProject,
  runStoreEvents,
  type DashboardScene,
} from './run-doors-fixture.js'
import { populatedRunSpawnEnv } from './populated-run-fixture.js'
import { cleanupTempRoots } from './spawned-chat.js'

const CELL_BUDGET_MS = 300_000
const ENTER_BUDGET_MS = 180_000
const OPEN_WINDOW_MS = 5_000

afterAll(() => {
  cleanupTempRoots()
})

async function firstOf<T, L extends string>(work: Promise<T>, ms: number, label: L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<L>((done) => { timer = setTimeout(() => { done(label) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('the dashboard scene', () => {
  it('the dashboard scene closes only after its runs and their post-run work have finished', async () => {
    const project = await recordedDoorProject('scene-post-run-wait')
    const savedCi = process.env.CI
    const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
    process.env.CI = 'true'
    const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
    if (browsers !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
    let scene: DashboardScene | undefined
    try {
      scene = await openDashboardScene(project)
      const response = await fetch(`${scene.origin}/api/runs/trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: project.testPath }),
      })
      const body = await response.json() as { runId?: string; error?: string }
      expect(body.runId, JSON.stringify(body)).toBeTypeOf('string')
      const runId = body.runId!

      const atFinish = await firstOf(hold.drive.entered.then(() => 'entered' as const),
        ENTER_BUDGET_MS, 'never')
      expect(atFinish, 'the run never finished, so the hold before its post-run work never engaged')
        .toBe('entered')
      const logged = runStoreEvents(project, runId).map((event) => event.type)
      expect(logged, 'the run had not logged runFinished').toContain('runFinished')

      let closedAt: number | undefined
      const closing = scene.close().then(() => {
        closedAt = Date.now()
        return 'closed' as const
      })
      const beforeTail = await firstOf(closing, OPEN_WINDOW_MS, 'open')
      expect(beforeTail, 'close returned while the run was still on its way to its post-run work')
        .toBe('open')
      hold.drive.release()

      const atDrain = await firstOf(hold.drain.entered.then(() => 'entered' as const),
        ENTER_BUDGET_MS, 'never')
      expect(atDrain, 'the run never reached its post-run work, so the drain hold never engaged')
        .toBe('entered')
      const duringTail = await firstOf(closing, OPEN_WINDOW_MS, 'open')
      expect(duringTail, 'close returned while post-run work was in flight').toBe('open')
      hold.drain.release()
      await closing

      expect(hold.finishedAt, 'the held post-run work never finished').toBeTypeOf('number')
      expect(hold.finishedAt!, 'the post-run work finished after close returned').toBeLessThanOrEqual(closedAt!)
    } finally {
      hold.drive.release()
      hold.drain.release()
      await scene?.close().catch(() => undefined)
      await project.close()
      if (savedCi === undefined) delete process.env.CI
      else process.env.CI = savedCi
      if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
      else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
    }
  }, CELL_BUDGET_MS)
})
