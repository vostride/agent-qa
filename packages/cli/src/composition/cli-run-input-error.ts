// The typed input failure of the in-process run path (Phase 401 plan 11).
//
// WHY IT IS A THROW AND NOT AN EXIT. `agent-qa run`'s input preflight used to answer a missing
// `.env`, an unreadable hooks file or a pattern that matched nothing by RENDERING a message and
// calling `process.exit`. That is correct for a command and fatal for a library: the same preflight
// is now reachable from the daemon and from the chat host, and a daemon that dies on a config typo
// is T-401-31. So every input failure on the in-process path becomes one of these instead, and the
// DOOR decides what to do with it — the CLI prints `lines` and exits with `exitCode`, byte for byte
// as before; the daemon turns it into a job failure and keeps serving.
//
// `lines` CARRIES FULLY RENDERED STRINGS, colour codes included. They are the exact strings the
// command used to print, moved rather than paraphrased — which is what makes the parity
// differential (`run-parity.e2e.test.ts`) a byte comparison instead of an approximation.
//
// IT LIVES IN ITS OWN MODULE, WITH NO IMPORTS, ON PURPOSE. `in-process-run-execution.ts` imports
// its producers relatively from `commands/run.ts` (the surface-firewall route table's answer for
// vocabulary that may not leave that file), and `run.ts` needs this class — so the two form an ESM
// cycle. A cycle is survivable while every edge is used at CALL time; a top-level
// `class CliRunParseError extends CliRunInputError` in `run.ts` is not, because `extends` is
// evaluated while the module graph is still initialising and would read a TDZ binding whenever the
// composition module is entered first (the daemon's and the chat host's entry order). A leaf module
// removes the hazard rather than documenting it.
//
// NOT WHAT D-03 FORBIDS. D-03 rules out defensive catch-all handling that absorbs crashes; this is
// ordinary control flow for a decision the caller has to make. A crash still crashes through.

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
