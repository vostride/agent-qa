// Imports only the import-free refusal module: `run.ts` extends this class at load time.
import { CliRefusal } from './cli-refusal.js'

/**
 * An input the run path refuses, carrying its own rendered output and its own exit code.
 *
 * EXIT CODES ARE THE COMMAND'S EXISTING ONES, not new ones: `1` for a missing/unreadable
 * configuration file (env, hooks, secrets), `2` for "nothing to run" and for a usage/parse refusal.
 */
export class CliRunInputError extends CliRefusal {
  constructor(lines: readonly string[], exitCode: number, options?: ErrorOptions) {
    super(lines, exitCode, options)
    this.name = 'CliRunInputError'
  }
}
