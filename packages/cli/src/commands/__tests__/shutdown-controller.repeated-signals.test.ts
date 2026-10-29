// C444-HANGUP-ONCE (444-30, D-63): a terminal close under interactive zsh delivers SIGHUP twice,
// about 1 ms apart, so a SIGHUP after the first signal is never a second ask. A SIGINT or SIGTERM
// after any first signal still force-exits. Signals are delivered the way `process.on` calls a
// listener: with the signal's name as the first argument.
import { describe, expect, it, vi } from 'vitest'

import { createShutdownController, type ShutdownControllerDeps } from '../shutdown-controller.js'

function makeDeps(): ShutdownControllerDeps {
  return {
    cancel: vi.fn(),
    exit: vi.fn(),
    setExitCode: vi.fn(),
    armGrace: vi.fn(),
  }
}

function controllerFor(deps: ShutdownControllerDeps): NodeJS.SignalsListener {
  const deliver: NodeJS.SignalsListener = createShutdownController(deps).handleSignal
  return deliver
}

describe('repeated hang-up and interrupt signals', () => {
  it('a second SIGHUP gives one cancel, one grace timer and no exit', () => {
    const deps = makeDeps()
    const deliver = controllerFor(deps)

    deliver('SIGHUP')
    deliver('SIGHUP')

    expect(deps.setExitCode).toHaveBeenCalledTimes(1)
    expect(deps.setExitCode).toHaveBeenCalledWith(130)
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it('a SIGHUP after a SIGINT gives no exit', () => {
    const deps = makeDeps()
    const deliver = controllerFor(deps)

    deliver('SIGINT')
    deliver('SIGHUP')

    expect(deps.exit).not.toHaveBeenCalled()
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
  })

  it('a SIGINT or a SIGTERM after a SIGHUP still exits 130', () => {
    for (const second of ['SIGINT', 'SIGTERM'] as const) {
      const deps = makeDeps()
      const deliver = controllerFor(deps)

      deliver('SIGHUP')
      deliver(second)

      expect(deps.exit, `SIGHUP then ${second}`).toHaveBeenCalledTimes(1)
      expect(deps.exit, `SIGHUP then ${second}`).toHaveBeenCalledWith(130)
      expect(deps.cancel, `SIGHUP then ${second}`).toHaveBeenCalledTimes(1)
      expect(deps.armGrace, `SIGHUP then ${second}`).toHaveBeenCalledTimes(1)
    }
  })

  it('a second SIGINT still exits 130', () => {
    const deps = makeDeps()
    const deliver = controllerFor(deps)

    deliver('SIGINT')
    deliver('SIGINT')

    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(130)
  })
})
