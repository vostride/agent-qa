// No imports: classes in the run graph extend this at load time, so an import cycle would hit its TDZ.

export class CliRefusal extends Error {
  readonly lines: readonly string[]
  readonly exitCode: number

  constructor(lines: readonly string[], exitCode: number, options?: ErrorOptions) {
    super(lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '')).join('\n'), options)
    this.name = 'CliRefusal'
    this.lines = lines
    this.exitCode = exitCode
  }
}

// A handed-off agent-qa exited with this code. It printed and reported its own failure, so this
// process passes the code on and reports nothing.
export class HandedOffExit extends CliRefusal {
  constructor(exitCode: number) {
    super([], exitCode)
    this.name = 'HandedOffExit'
  }
}

export const CANCELLED_LINE = 'Cancelled.'

export class PromptCancelled extends Error {
  constructor() {
    super(CANCELLED_LINE)
    this.name = 'PromptCancelled'
  }
}

// `@inquirer/core`'s ExitPromptError is recognised by name, so the CLI needs no import of it.
export function isPromptCancel(error: unknown): boolean {
  return (
    error instanceof PromptCancelled || (error instanceof Error && error.name === 'ExitPromptError')
  )
}
