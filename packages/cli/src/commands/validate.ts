import { Command } from 'commander'
import {
  formatDiagnostics,
  resolveWorkspacePaths,
  validateProject,
} from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { resolveConfig } from '../config.js'

export function createValidateCommand(): Command {
  const cmd = new Command('validate')
    .description('Validate config, test files, and suite references')
    .argument('[files...]', 'specific files to validate (default: auto-discover all)')
    .action(async (files: string[], _options: unknown, command: Command) => {
      // Commander passes `(files, options, command)`, so the root `--config` comes off the third.
      const configPath = command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
      let workspace
      let resolutionFailure: string | undefined

      try {
        // No auth plugins: validation reads config values, and a missing plugin would fail it.
        const config = await resolveConfig({ configPath, loadAuthPlugins: false })
        workspace = resolveWorkspacePaths({ config, configPath })
      } catch (err) {
        // Every thrown value becomes a message string, so a primitive throw cannot pass as success.
        resolutionFailure = err instanceof Error ? err.message : String(err)
      }

      const result = await validateProject({
        configPath,
        files: files.length > 0 ? files : undefined,
        workspace,
      })

      // THE SUCCESS SENTENCE IS STRUCTURALLY UNREACHABLE FROM A FAILED RESOLUTION.
      // `formatDiagnostics` returns `✔ All files valid (N file(s) checked)` on exactly one
      // condition — an empty diagnostics list — so skipping the write in exactly that case is what
      // makes the attestation impossible rather than merely unlikely. Findings are still printed
      // when there are any, because a person whose config will not resolve still wants to read what
      // the validator did manage to see.
      if (resolutionFailure === undefined || result.diagnostics.length > 0) {
        printRunText(formatDiagnostics(result), (text) => {
          process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
        })
      }

      if (resolutionFailure !== undefined) {
        printRunText(`\nConfig resolution failed: ${resolutionFailure}`, (text) => {
          process.stderr.write(`${text}\n`)
        })
        process.exitCode = 1
        return
      }

      if (result.errorCount > 0) {
        process.exitCode = 1
      }
    })

  return cmd
}
