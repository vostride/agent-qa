// `agent-qa digest` — the per-run digest, on demand (Phase 391, D-17).
//
// The third of D-17's three channels. The tail prints the block when this process's own pump
// completed the analysis under the one budget; the exit line points here when it did not; and
// this verb answers whenever somebody asks. All three render the SAME `runs.digest` result, so
// there is one story about a run and no channel can tell a different version of it.
//
// IT PRINTS THE OP RESULT'S BYTES AND COMPOSES NOTHING. `RunDigest.lines` exists precisely so a
// surface never lays out a run's facts for itself — the digest op renders them once, beside the
// projection that produced them. What this file owns is which run to ask about and whether the
// answer goes out as text or as JSON; everything else would be a second story.
//
// Shaped after `entities.ts`, deliberately: resolve a project root, build the registry at the
// composition root, call `invokeFunction`, print what comes back. The host is CLOSED here,
// which `entities.ts` does not do — the digest opens the durable job store to read chain state,
// and a one-shot verb that leaves a sqlite handle open is a handle the next command inherits.

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

/**
 * The most recently FINISHED run: the first row of a one-row `runs.list`.
 *
 * The op orders completed runs newest finished first with `runId` breaking a tie (431 D-08), the
 * same first row the chat banner digests, so this verb asks for exactly one row rather than
 * re-sorting a capped page it would otherwise have to trust was complete.
 */
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
        releaseStdout?.()
        await host.close()
      }
    })
}
