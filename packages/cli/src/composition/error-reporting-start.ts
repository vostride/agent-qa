// The root preAction hook awaits this before every action, so reporting is decided once per
// invocation: from the root --config, or for mcp from the project it serves.

import type { Command } from 'commander'

import { defaultCliFailureDeps, installGlobalFailureHandlers } from '../cli-error-handler.js'
import { resolveMcpConfigPath } from '../commands/mcp-project.js'
import { projectHost, type ProjectHost } from '../commands/project-host.js'
import { collectReportFacts, commandPath } from './error-report-facts.js'
import { startErrorReporting } from './error-reporting.js'

export interface CliErrorReportingDeps {
  readonly start?: typeof startErrorReporting
  readonly installHandlers?: () => void
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly host?: Pick<ProjectHost, 'homedir' | 'io'>
}

export async function startCliErrorReporting(
  program: Command,
  action: Command,
  deps: CliErrorReportingDeps = {},
): Promise<void> {
  try {
    const env = deps.env ?? process.env
    const configPath = await decidingConfigPath(program, action, env, deps)
    const reporter = await (deps.start ?? startErrorReporting)({ configPath })
    if (reporter === undefined) return
    // Only with reporting on: with it off, Node's own handling of an escaped error is unchanged.
    const installHandlers =
      deps.installHandlers ?? (() => installGlobalFailureHandlers(defaultCliFailureDeps(program)))
    installHandlers()
    const facts = collectReportFacts({ action, document: reporter.configDocument, env })
    reporter.setFacts(facts)
    reporter.beginCommandSpan(facts.command, facts.flags)
  } catch {
    // Reporting stays off for this invocation, and the command runs.
  }
}

// mcp walks upward from the folder it was started in to find its project, so a server started in
// a subfolder decides from that project's config, as the command itself reads it.
async function decidingConfigPath(
  program: Command,
  action: Command,
  env: NodeJS.ProcessEnv,
  deps: CliErrorReportingDeps,
): Promise<string> {
  const config = program.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
  if (commandPath(action) !== 'mcp') return config
  const location = await resolveMcpConfigPath({
    config,
    env,
    cwd: deps.cwd ?? process.cwd(),
    host: deps.host ?? projectHost(),
  })
  return location.configPath
}
