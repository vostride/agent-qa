// Prints the `runs.digest` result's bytes, and closes the host so no sqlite handle outlives it.

import { dirname, resolve } from 'node:path'

import { invokeFunction, RUNS_DIGEST_FUNCTION_ID } from '@vostride/agent-qa-agent'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import type { RunDigest, RunSummary } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'

/**
 * The listing capability this verb is a client of when no run is named.
 *
 * A literal for the reason `entities.ts` writes its own: an id is a WIRE NAME, and a surface
 * coupled to a declaring module in order to name a capability is coupled to the wrong thing.
 * `runs.digest`'s id is imported instead, because the exit line and this verb must put the SAME
 * string in front of a person — a fetch command that does not match the verb is worse than none.
 */
const RUNS_LIST_ID = 'runs.list'

interface DigestOptions {
  json?: boolean
}

class DigestCommandError extends Error {
  constructor(readonly code: 'no-runs', message: string) {
    super(message)
    this.name = 'DigestCommandError'
  }
}

function compositionInput(command: Command): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(
    command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml',
  )
  return { agentQaRoot: resolve(dirname(configPath), '.agent-qa'), configPath }
}

// `runs.list` orders newest finished first with `runId` breaking ties, so one row suffices.
function mostRecent(summaries: readonly RunSummary[]): string {
  const latest = summaries[0]
  if (latest === undefined) {
    throw new DigestCommandError(
      'no-runs',
      'No completed runs are recorded for this project, so there is no digest to render.',
    )
  }
  return String(latest.runId)
}

export function createDigestCommand(): Command {
  return new Command('digest')
    .description("Render one run's digest: verdicts and its post-run chain")
    .argument('[runId]', 'the run to digest; omitted means the most recently finished run')
    .option('--json', 'emit the structured digest instead of its rendered lines')
    .action(async (runId: string | undefined, options: DigestOptions, command: Command) => {
      const host = composeCliLocalAgent(compositionInput(command))
      const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
      try {
        const target = runId ?? mostRecent(
          await invokeFunction(
            host.registry,
            RUNS_LIST_ID,
            { limit: 1 },
            CLI_FUNCTION_CALLER,
          ) as RunSummary[],
        )
        const digest = await invokeFunction(
          host.registry,
          RUNS_DIGEST_FUNCTION_ID,
          { runId: target },
          CLI_FUNCTION_CALLER,
        ) as RunDigest

        if (options.json === true) {
          console.log(guardJsonText(JSON.stringify(digest, null, 2)))
          return
        }
        // The op's own bytes, joined and printed. Nothing is added, reordered or annotated.
        printRunText(digest.lines.join('\n'))
      } catch (error) {
        printRunText(
          pc.red(
            `Digest error [${error instanceof Error ? error.name : 'unknown'}]: ${
              error instanceof Error ? error.message : String(error)}`,
          ),
          (line) => console.error(line),
        )
        process.exitCode = 1
      } finally {
        try {
          await host.close()
        } finally {
          releaseStdout?.()
        }
      }
    })
}
