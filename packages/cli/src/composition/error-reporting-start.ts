// The root preAction hook awaits this before every action, so reporting is decided once per
// invocation, from the root --config.

import type { Command } from 'commander'

import { startErrorReporting } from './error-reporting.js'

export interface CliErrorReportingDeps {
  readonly start?: typeof startErrorReporting
}

export async function startCliErrorReporting(
  program: Command,
  _action: Command,
  deps: CliErrorReportingDeps = {},
): Promise<void> {
  try {
    const configPath = program.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
    await (deps.start ?? startErrorReporting)({ configPath })
  } catch {
    // Reporting stays off for this invocation, and the command runs.
  }
}
