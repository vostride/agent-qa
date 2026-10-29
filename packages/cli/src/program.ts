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
  createQueueCommand,
  createRunCommand,
  createServeCommand,
  createSkillsCommand,
  createValidateCommand,
} from './commands/index.js'
import { createRunsCommand } from './commands/runs.js'

/** The whole `agent-qa` command tree, unparsed; `cli.ts` parses it and tests read it. */
export function createAgentQaProgram(): Command {
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

  // A process runs one action, and a --json action's stdout stays reserved until the process
  // exits: a detached run tail or host teardown can still print after the action returns.
  program.hook('preAction', (_program, action) => {
    if (action.opts<{ json?: unknown }>().json === true) reserveStdoutForData()
  })

  program.addCommand(createRunCommand())
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
