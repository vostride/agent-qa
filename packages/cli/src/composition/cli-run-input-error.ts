// No imports: `run.ts` extends this class at load time, so an import cycle would hit its TDZ.

/**
 * An input the run path refuses, carrying its own rendered output and its own exit code.
 *
 * EXIT CODES ARE THE COMMAND'S EXISTING ONES, not new ones: `1` for a missing/unreadable
 * configuration file (env, hooks, secrets), `2` for "nothing to run" and for a usage/parse refusal.
 */
export class CliRunInputError extends Error {
  readonly lines: readonly string[]
  readonly exitCode: number

  constructor(lines: readonly string[], exitCode: number) {
    // The message is the lines without their colour codes — a log line for a caller that has no
    // terminal, never the thing the CLI prints (it prints `lines`).
    super(lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '')).join('\n'))
    this.name = 'CliRunInputError'
    this.lines = lines
    this.exitCode = exitCode
  }
}
