import { installSdkWarningLogger } from '@vostride/agent-qa-agent-local'
import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import { Command } from 'commander'
import { VERSION } from './index.js'
import {
  createAgentJobsCommand,
  createAuthCommand,
  createAuthStateCommand,
  createCacheCommand,
  createConfigCommand,
  createDashboardCommand,
  createDaemonCommand,
  createDevicesCommand,
  createDoctorCommand,
  createEntitiesCommand,
  createEvalCommand,
  createDigestCommand,
  createAskCommand,
  createChatCommand,
  createFnCommand,
  createInitCommand,
  createInstallBrowsersCommand,
  createInstallMobileDriversCommand,
  createKnowledgeCommand,
  createMcpCommand,
  createPluginCommand,
  createPluginsCommand,
  createQueueCommand,
  createRunCommand,
  createServeCommand,
  createSkillsCommand,
  createValidateCommand,
} from './commands/index.js'
import { createRunsCommand } from './commands/runs.js'
import type { UpdateNotice } from './update-notice-gate.js'

export type { UpdateNotice }

export type StartReporting = (program: Command, action: Command) => Promise<void>

/** The whole `agent-qa` command tree, unparsed; `cli.ts` parses it and tests read it. */
export function createAgentQaProgram({
  updateNotice,
  startReporting,
}: { updateNotice?: UpdateNotice; startReporting?: StartReporting } = {}): Command {
  const program = new Command()
  program.enablePositionalOptions()

  program
    .name('agent-qa')
    .description('The self-improving Agentic QA harness with Memory')
    .version(VERSION)

  program
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    .option('--log-level <level>', 'log verbosity: silent|error|warn|info|debug')
    .option('--verbose', 'shorthand for --log-level debug')
    .option('--quiet', 'shorthand for --log-level silent')

  // Only the CLI entry hands in a reporting starter and a notice, so a program built elsewhere
  // starts no reporter, reads no home and starts no request.

  // A process runs one action, and a --json action's stdout stays reserved until the process
  // exits: a detached run tail or host teardown can still print after the action returns. The
  // AI SDK warning logger stays for the same reason. Reporting is started here, before the action
  // runs; --help, --version and a parse error never reach this hook.
  program.hook('preAction', async (root, action) => {
    if (action.opts<{ json?: unknown }>().json === true) reserveStdoutForData()
    installSdkWarningLogger()
    if (!startReporting) return
    try {
      await startReporting(root, action)
    } catch {
      // A starter that fails leaves reporting off and never fails the command.
    }
  })

  // A command that ends through process.exit never reaches this hook.
  program.hook('postAction', async (_program, action) => {
    if (!updateNotice) return
    try {
      const opts = action.optsWithGlobals<{ json?: unknown; quiet?: unknown; logLevel?: unknown }>()
      await updateNotice({
        json: opts.json === true,
        logLevel:
          opts.quiet === true
            ? 'silent'
            : typeof opts.logLevel === 'string'
              ? opts.logLevel
              : undefined,
      })
    } catch {
      // The notice never changes a command's outcome.
    }
  })

  program.addCommand(createRunCommand({ updateNotice }))
  program.addCommand(createRunsCommand())
  program.addCommand(createInitCommand())
  program.addCommand(createInstallBrowsersCommand())
  program.addCommand(createInstallMobileDriversCommand())

  program.addCommand(createDoctorCommand())
  program.addCommand(createDashboardCommand())
  program.addCommand(createServeCommand())
  program.addCommand(createMcpCommand())
  program.addCommand(createConfigCommand())
  program.addCommand(createQueueCommand())
  program.addCommand(createKnowledgeCommand())
  program.addCommand(createCacheCommand())
  program.addCommand(createValidateCommand())
  program.addCommand(createPluginsCommand())
  program.addCommand(createPluginCommand())
  program.addCommand(createAuthCommand())
  program.addCommand(createAuthStateCommand())
  program.addCommand(createDevicesCommand())
  program.addCommand(createEntitiesCommand())
  program.addCommand(createEvalCommand())
  program.addCommand(createSkillsCommand())
  program.addCommand(createFnCommand())
  // The one-shot chat verb, beside `fn`: a thin client invoking one op through `invokeFunction`.
  program.addCommand(createAskCommand())
  // The REPL shares the one-shot verb's turn engine; they differ only in session and loop.
  program.addCommand(createChatCommand())
  // The per-run digest on demand.
  program.addCommand(createDigestCommand())
  program.addCommand(createDaemonCommand())
  // Beside the daemon that drains it; `pump --only <kind>` drains one kind in process.
  program.addCommand(createAgentJobsCommand())

  return program
}
