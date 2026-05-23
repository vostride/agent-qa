import { Command } from 'commander'
import { VERSION } from './index.js'
import { createRunCommand, createInitCommand, createInstallBrowsersCommand, createInstallMobileDriversCommand, createDoctorCommand, createDashboardCommand, createServeCommand, createMcpCommand, createConfigCommand, createQueueCommand, createCacheCommand, createValidateCommand, createAuthCommand, createAuthStateCommand, createDevicesCommand, createIdsCommand, createCreateTestCommand, createCreateSuiteCommand, createCleanMemoryCommand, createSkillsCommand } from './commands/index.js'
import { rejectRemovedCliSurface } from './removed-cli-surface.js'

rejectRemovedCliSurface()

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

program.addCommand(createRunCommand())
program.addCommand(createInitCommand())
program.addCommand(createInstallBrowsersCommand())
program.addCommand(createInstallMobileDriversCommand())

program.addCommand(createDoctorCommand())
program.addCommand(createDashboardCommand())
program.addCommand(createServeCommand())
program.addCommand(createMcpCommand())
program.addCommand(createConfigCommand())
program.addCommand(createQueueCommand())
program.addCommand(createCacheCommand())
program.addCommand(createValidateCommand())
program.addCommand(createAuthCommand())
program.addCommand(createAuthStateCommand())
program.addCommand(createDevicesCommand())
program.addCommand(createIdsCommand())
program.addCommand(createCreateTestCommand())
program.addCommand(createCreateSuiteCommand())
program.addCommand(createCleanMemoryCommand())
program.addCommand(createSkillsCommand())

program.parse()

export { program }
