import { writeSync } from 'node:fs'

import type { Command } from 'commander'
import { printRunText, type RunTextEnv } from '@vostride/agent-qa-core/run-text-output'

import { CANCELLED_LINE, CliRefusal, isPromptCancel } from './composition/cli-refusal.js'
import { createDeclaredSecretMask } from './composition/declared-secrets.js'

export interface CliFailureDeps {
  readonly print: (text: string) => void
  readonly printFixed: (line: string) => void
  readonly mask: (text: string) => string
  readonly setExitCode: (code: number) => void
  readonly flush: () => Promise<void>
  readonly exit: (code: number) => void
  readonly env: RunTextEnv
}

const FRAME = /^\s+at /

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((settle) => {
    stream.write('', () => settle())
  })
}

export function defaultCliFailureDeps(program: Command): CliFailureDeps {
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
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack !== undefined ? error.stack.split('\n') : []
  const frames = stack.filter((line) => FRAME.test(line))
  printRunText(deps.mask([`Unexpected error: ${message}`, ...frames].join('\n')), deps.print, {
    env: deps.env,
  })
  return 1
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
    // The code is set before the flush, so a rejection that lands while the process is already
    // exiting still leaves it.
    deps.setExitCode(code)
    await deps.flush()
    deps.exit(code)
  }
}
