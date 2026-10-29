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
      // THREE PARAMETERS, BECAUSE THIS COMMAND TAKES AN ARGUMENT. Commander invokes
      // an action with `(...declaredArguments, options, command)`. `validate` declares `[files...]`,
      // so the Command arrives THIRD. Bound as `(files, command)` the second name held the OPTIONS
      // OBJECT, `command.parent` was undefined, and `--config` fell through to the default below —
      // silently on the pre-395-21 road, and loudly after it: every `--config` invocation failed
      // naming `agent-qa.config.yaml`, a file the person had not mentioned. The derivation now reads
      // the ROOT program's opts exactly as `ask.ts`'s `globalOptions` does.
      const configPath = command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
      let workspace
      let resolutionFailure: string | undefined

      try {
        // NO AUTH PLUGINS ON THE VALIDATION ROAD (395-21 · F-05). Validation reads config VALUES:
        // which files the workspace names, which globs discover them, which schema they must
        // satisfy. Auth plugins are EXECUTION machinery — loading one cannot change which files
        // exist or which schema applies, and it can only add a way for resolution to fail. It did:
        // the product's own `agent-qa init --platform web` declares an optional subscription-auth
        // package that a fresh project has not installed yet, `loadLLMAuthPlugins` resolves it with
        // a bare `require.resolve`, and the throw reached the catch below. The measured
        // consequence was a validator that reported `All files valid (0 file(s) checked)` over a
        // project holding eight test files.
        const config = await resolveConfig({ configPath, loadAuthPlugins: false })
        workspace = resolveWorkspacePaths({ config, configPath })
      } catch (err) {
        // CAPTURED, NOT SWALLOWED. This used to be a bare `catch {}` whose comment said
        // `validateProject will report config read/schema diagnostics` — true, and not enough:
        // `workspace` stays undefined, so the bare road discovers NOTHING and the explicit-file
        // road loses the workspace-match gate. The diagnostics are still deferred (the config arm
        // at core/src/validation/validate.ts:40-88 re-detects read, parse and schema faults), but
        // the failure itself is now held and surfaced below.
        //
        // ONLY THE MESSAGE. No `cause`, no stack, no file bytes — the loader's messages have been
        // position-only since 395-16, and (Z2)'s zero-occurrence assertion is the watchdog on this
        // road.
        //
        // EVERY THROWN VALUE PRODUCES A STRING. This reached `.message` through an
        // `err as Error` cast, and a cast is not a check: a plugin doing
        // `throw 'boom'` left `resolutionFailure` UNDEFINED, and the guard below reads undefined as
        // "resolution succeeded" — the false green 395-21 exists to kill, re-entered through a
        // different door. `throw null` was worse still: the property read TypeErrors inside the
        // catch. Reachable only through third-party plugin code, and that is precisely the code this
        // process does not control.
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
