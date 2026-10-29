// The first signal cancels and arms the backstop; a second SIGINT or SIGTERM exits 130 at once.

export interface ShutdownControllerDeps {
  /** Route the abort into the active RunSession (`activeRunSession?.cancel()`). Best-effort. */
  cancel: () => void
  /** Hard force-exit. Used ONLY on a second-and-further SIGINT or SIGTERM, immediately. */
  exit: (code: number) => void
  /** Mark the graceful exit code + shutdown-requested state on the first signal (`process.exitCode = code`). */
  setExitCode: (code: number) => void
  /** Arm the caller's unref'd force-exit backstop. Invoked once, on the first signal only. */
  armGrace: () => void
}

export interface ShutdownController {
  /** The single SIGINT, SIGTERM and SIGHUP handler registered via `process.on` at both run sites. */
  handleSignal: (signal?: NodeJS.Signals) => void
  /** Detach at teardown so a late signal after `session.done` is inert (mirrors removeListener). */
  dispose: () => void
}

export function createShutdownController(deps: ShutdownControllerDeps): ShutdownController {
  let signalCount = 0
  let disposed = false

  const handleSignal = (signal?: NodeJS.Signals): void => {
    if (disposed) return
    if (signal === 'SIGHUP' && signalCount >= 1) return
    signalCount += 1

    if (signalCount >= 2) {
      // HARD second-signal force-exit: fires immediately, independent of the grace timer and of any
      // wedged async work. A repeated Ctrl+C always terminates the CLI once the event loop is free.
      deps.exit(130)
      return
    }

    // First signal — the graceful path. Never force-exits synchronously.
    deps.setExitCode(130)
    try {
      deps.cancel()
    } catch {
      /* cancel is best-effort */
    }
    deps.armGrace()
  }

  const dispose = (): void => {
    disposed = true
  }

  return { handleSignal, dispose }
}
