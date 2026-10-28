import { guardJsonText } from '@vostride/agent-qa-core/run-text-output'
import type { RunTextEnv } from '@vostride/agent-qa-core/run-text-output'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

// The stdout wire is captured by operators and CI, so it stays masked: payloads are masked at the
// sink and printed as they are, and nothing restores an original here.

const WIRE_PREFIX = 'AGENT_QA_EVENT:'

export interface WireReporterTarget {
  write: (chunk: string) => void
  env?: RunTextEnv
}

export interface WireReporterHandle {
  handler: (envelope: RunEventEnvelope) => void
}

/**
 * `createWireReporter` is one of the two writers on the `AGENT_QA_EVENT:` stdout channel, a
 * supported opt-in.
 *
 * Gated by `AGENT_QA_LIVE_EVENTS === 'true'`, read here on every envelope; prints one line per
 * envelope: the 15-char `AGENT_QA_EVENT:` prefix immediately followed by
 * `JSON.stringify(envelope)`. Under GitHub Actions every `#` in it is escaped as `\u0023`, so no
 * line can carry `##[`, and `JSON.parse` reads back the same envelope. The reporter is attached
 * unconditionally by `run-session-composition.ts` and gated internally: attachment is not arming.
 *
 * Nothing in the product sets the variable; `composition/__tests__/spawn-absence-census.test.ts`
 * holds that absence. A consumer that sees these lines set the variable deliberately.
 *
 * The second writer on the same prefix is `core/src/logging/log-manager.ts`'s `emitNdjson`, which
 * prints `{"type":"log", ...}` entries and is switched on from the same variable in
 * `commands/run.ts`. A change to the line shape here that is not mirrored there leaves the channel
 * half-described. The user-facing contract for both is README.md, "Live events on stdout (opt-in)".
 */
export function createWireReporter(target?: WireReporterTarget): WireReporterHandle {
  const sink = target?.write ?? ((chunk: string) => void process.stdout.write(chunk))
  const env = target?.env ?? process.env
  function handler(envelope: RunEventEnvelope): void {
    if (process.env.AGENT_QA_LIVE_EVENTS !== 'true') return
    sink(`${WIRE_PREFIX}${guardJsonText(JSON.stringify(envelope), env)}\n`)
  }
  return { handler }
}
