// The dashboard scene must not close while a run's post-run work is still running, because that
// work logs after the run settles and a line logged after close can outlive the test worker.

import { afterAll, describe, expect, it, vi } from 'vitest'

// Holds the run's post-run drain open until the cell releases it, and records when it finished.
const hold = vi.hoisted(() => {
  let enter: () => void = () => undefined
  let open: () => void = () => undefined
  const entered = new Promise<void>((settle) => { enter = settle })
  const released = new Promise<void>((settle) => { open = settle })
  return {
    entered,
    released,
    enter: (): void => { enter() },
    release: (): void => { open() },
    finishedAt: undefined as number | undefined,
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
          hold.enter()
          try {
            await hold.released
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

import { openDashboardScene, recordedDoorProject, type DashboardScene } from './433-door-fixture.js'
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
  it("the dashboard scene closes only after its runs' post-run work has finished", async () => {
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

      const reached = await firstOf(hold.entered.then(() => 'entered' as const), ENTER_BUDGET_MS, 'never')
      expect(reached, 'the run never reached its post-run work, so the hold never engaged').toBe('entered')

      let closedAt: number | undefined
      const closing = scene.close().then(() => {
        closedAt = Date.now()
        return 'closed' as const
      })
      const first = await firstOf(closing, OPEN_WINDOW_MS, 'open')
      hold.release()
      await closing

      expect(first, 'close returned while post-run work was in flight').toBe('open')
      expect(hold.finishedAt, 'the held post-run work never finished').toBeTypeOf('number')
      expect(hold.finishedAt!, 'the post-run work finished after close returned').toBeLessThanOrEqual(closedAt!)
    } finally {
      hold.release()
      await scene?.close().catch(() => undefined)
      await project.close()
      if (savedCi === undefined) delete process.env.CI
      else process.env.CI = savedCi
      if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
      else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
    }
  }, CELL_BUDGET_MS)
})
