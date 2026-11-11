import { writeSync } from 'node:fs'

import type { Command } from 'commander'
import { printRunText, type RunTextEnv } from '@vostride/agent-qa-core/run-text-output'

import { CANCELLED_LINE, CliRefusal, isPromptCancel } from './composition/cli-refusal.js'
import { createDeclaredSecretMask } from './composition/declared-secrets.js'
import { errorReporter, settleReporting } from './composition/error-reporting.js'

export interface CliFailureDeps {
  readonly print: (text: string) => void
  readonly printFixed: (line: string) => void
  readonly mask: (text: string) => string
  readonly setExitCode: (code: number) => void
  readonly capture: (error: unknown) => void
  readonly settle: () => Promise<void>
  readonly flush: () => Promise<void>
  readonly exit: (code: number) => void
  readonly env: RunTextEnv
}

export interface GlobalFailureDeps extends CliFailureDeps {
  // Makes `code` the exit code of every later exit of the process, whatever that exit passes.
  readonly holdExitCode: (code: number) => void
}

const FRAME = /^\s+at /

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((settle) => {
    stream.write('', () => settle())
  })
}

export function defaultCliFailureDeps(program: Command): GlobalFailureDeps {
  return {
    print: (text) => console.error(text),
    // Synchronous, so the line still lands when a prompt was rejected while the process exits.
    printFixed: (line) => {
      writeSync(2, `${line}\n`)
    },
    // Read at call time, after parsing has set the root --config.
    mask: (text) => {
      const configPath = program.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
      try {
        return createDeclaredSecretMask(configPath).mask(text)
      } catch {
        return text
      }
    },
    setExitCode: (code) => {
      process.exitCode = code
    },
    // Node reads the exit code after the exit listeners run, both for process.exit(n) and for a
    // process that ends on its own.
    holdExitCode: (code) => {
      process.exitCode = code
      process.on('exit', () => {
        process.exitCode = code
      })
    },
    capture: (error) => {
      errorReporter()?.capture(error)
    },
    settle: () => settleReporting(),
    flush: async () => {
      await Promise.all([drain(process.stdout), drain(process.stderr)])
    },
    exit: (code) => process.exit(code),
    env: process.env,
  }
}

export function reportCliFailure(error: unknown, deps: CliFailureDeps): number {
  if (isPromptCancel(error)) {
    deps.printFixed(CANCELLED_LINE)
    return 130
  }
  if (error instanceof CliRefusal) {
    if (error.lines.length > 0) {
      printRunText(deps.mask(error.lines.join('\n')), deps.print, { env: deps.env })
    }
    return error.exitCode === 0 ? 1 : error.exitCode
  }
  printUnexpected(error, deps)
  return 1
}

function printUnexpected(error: unknown, deps: CliFailureDeps): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack !== undefined ? error.stack.split('\n') : []
  const frames = stack.filter((line) => FRAME.test(line))
  printRunText(deps.mask([`Unexpected error: ${message}`, ...frames].join('\n')), deps.print, {
    env: deps.env,
  })
}

// Every path ends in exit 1, as Node's own handling does: a listener that returned would let the
// process go on, or end it with 0. The 1 is held from the first error on, so a command that exits
// while the report settles still exits 1.
export function createGlobalFailureHandler(
  deps: GlobalFailureDeps,
): (error: unknown) => Promise<void> {
  let handling = false
  return async (error) => {
    if (handling) {
      deps.exit(1)
      return
    }
    handling = true
    deps.holdExitCode(1)
    try {
      printUnexpected(error, deps)
      if (!isPromptCancel(error)) deps.capture(error)
      await deps.settle()
      await deps.flush()
    } catch {
      // The exit below still runs.
    }
    deps.exit(1)
  }
}

export function installGlobalFailureHandlers(deps: GlobalFailureDeps): () => void {
  const handle = createGlobalFailureHandler(deps)
  // An unhandled rejection's first argument is its reason.
  const listener = (error: unknown) => {
    void handle(error)
  }
  process.on('uncaughtException', listener)
  process.on('unhandledRejection', listener)
  return () => {
    process.off('uncaughtException', listener)
    process.off('unhandledRejection', listener)
  }
}

export async function runCli(
  program: Command,
  argv: readonly string[] = process.argv,
  deps: CliFailureDeps = defaultCliFailureDeps(program),
): Promise<void> {
  try {
    await program.parseAsync(argv)
  } catch (error) {
    const code = reportCliFailure(error, deps)
    // The code is set before the settle and the flush, so a rejection that lands while the process
    // is already exiting still leaves it.
    deps.setExitCode(code)
    // What exits 130 is a cancellation, not an error.
    if (code !== 130) deps.capture(error)
    await deps.settle()
    await deps.flush()
    deps.exit(code)
    return
  }
  // No exit on success: dashboard and serve return while they serve.
  await deps.settle()
}
