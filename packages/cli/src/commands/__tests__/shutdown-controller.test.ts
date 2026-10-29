// The first signal cancels the run and arms the backstop; a second SIGINT or SIGTERM exits at once.
import { describe, it, expect, vi } from 'vitest'
import { createShutdownController, type ShutdownControllerDeps } from '../shutdown-controller.js'

function makeDeps(overrides: Partial<ShutdownControllerDeps> = {}): ShutdownControllerDeps {
  return {
    cancel: vi.fn(),
    exit: vi.fn(),
    setExitCode: vi.fn(),
    armGrace: vi.fn(),
    ...overrides,
  }
}

describe('createShutdownController — first-vs-second-signal contract', () => {
  it('first signal runs the graceful path and NEVER exits synchronously', () => {
    const deps = makeDeps()
    const controller = createShutdownController(deps)

    controller.handleSignal()

    expect(deps.setExitCode).toHaveBeenCalledWith(130)
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
    // The graceful path must not force-exit — it hands the process to the RunSession cancel and the
    // unref'd grace-timer backstop, so a clean settle exits through the verdict map.
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it('second signal HARD force-exits with 130 immediately, independent of the grace timer', () => {
    const deps = makeDeps()
    const controller = createShutdownController(deps)

    controller.handleSignal()
    // Re-arming / re-cancelling must not happen on the second signal — it goes straight to exit.
    ;(deps.cancel as ReturnType<typeof vi.fn>).mockClear()
    ;(deps.armGrace as ReturnType<typeof vi.fn>).mockClear()

    controller.handleSignal()

    expect(deps.exit).toHaveBeenCalledWith(130)
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(deps.armGrace).not.toHaveBeenCalled()
  })

  it('a third-and-further signal keeps force-exiting (a repeated Ctrl+C is always effective)', () => {
    const deps = makeDeps()
    const controller = createShutdownController(deps)

    controller.handleSignal() // graceful
    controller.handleSignal() // force-exit
    controller.handleSignal() // force-exit again

    expect(deps.exit).toHaveBeenCalledTimes(2)
    expect(deps.exit).toHaveBeenNthCalledWith(1, 130)
    expect(deps.exit).toHaveBeenNthCalledWith(2, 130)
    // cancel/armGrace only ever fire on the first (graceful) signal.
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
  })

  it('a throwing cancel never escapes the handler and does not block arming the backstop', () => {
    const deps = makeDeps({
      cancel: vi.fn(() => {
        throw new Error('cancel exploded')
      }),
    })
    const controller = createShutdownController(deps)

    expect(() => controller.handleSignal()).not.toThrow()
    // The unref'd grace-timer backstop is still armed so an un-settleable run cannot hang.
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
  })

  it('after dispose, a late signal is inert (the listener has been detached at teardown)', () => {
    const deps = makeDeps()
    const controller = createShutdownController(deps)

    controller.dispose()
    controller.handleSignal()

    expect(deps.setExitCode).not.toHaveBeenCalled()
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(deps.armGrace).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
  })
})

describe('the shutdown controller cancels only its own run', () => {
  it("the shutdown controller cancels this process's own run once, on the first signal", () => {
    const deps = makeDeps()
    const controller = createShutdownController(deps)

    controller.handleSignal()
    controller.handleSignal()
    controller.handleSignal()

    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledTimes(2)
  })
})
