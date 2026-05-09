import { Command } from 'commander'
import { validateProject, formatDiagnostics, resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

export function createValidateCommand(): Command {
  const cmd = new Command('validate')
    .description('Validate config, test files, and suite references')
    .argument('[files...]', 'specific files to validate (default: auto-discover all)')
    .action(async (files: string[], command: Command) => {
      const configPath = command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
      let workspace

      try {
        const config = await resolveConfig({ configPath })
        workspace = resolveWorkspacePaths({ config, configPath })
      } catch {
        // validateProject will report config read/schema diagnostics.
      }

      const result = await validateProject({
        configPath,
        files: files.length > 0 ? files : undefined,
        workspace,
      })

      const output = formatDiagnostics(result)
      process.stdout.write(output)

      if (result.errorCount > 0) {
        process.exitCode = 1
      }
    })

  return cmd
}
