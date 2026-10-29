// THE ENVELOPE SEQUENCE ONE RUN IS DRIVEN OVER (Phase 401 plan 07, D-09 / INVK-01 truth 2).
//
// NOT A TEST FILE: this package's vitest include is `src/**/__tests__/**/*.test.ts`, so this module
// is imported, never collected.
//
// WHAT IT WAS FOR, AND WHAT IT IS FOR NOW. D-09's build-order pin was that the queue, the db
// writes and the live feed were untouched while the PRODUCER underneath them changed from a
// spawned child's scraped stdout to a `RunSession` bus subscription. "Untouched" is only a claim
// if something pins what the consumers receive, so both wires were driven over this sequence and
// compared against a golden captured from the old one before it was deleted.
//
// that comparison is gone with the consumer surface it compared. The
// golden anchored a per-run replay buffer and a second event emission, both deleted with the route
// they fed; two lines that only ever existed on the retired stdout wire went with them. The
// SEQUENCE survives because it is still the best-shaped run in the suite — see below — and the
// cells that drive it now measure what the subscription actually produces.
//
// THE SEQUENCE IS NOT A HAPPY PATH. It deliberately carries the three things a bridge can get
// wrong and a five-event smoke test cannot see:
//   - a `heartbeat`, whose type maps to NO process status (the "leave the running status alone" arm);
//   - a `testFinished` that says `failed` BEFORE a `verdict` that says `passed`, so last-writer-wins
//     at the run level is discriminated from first-writer-wins;
//   - a `stepFinalized` carrying a nested payload, so "carried verbatim" ranges more than scalars.

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

/** The run id both wires are driven with. Fixed so the golden is a literal a human can read. */
export const PARITY_RUN_ID = 'parity-run-0001'

/**
 * The envelope sequence, frozen. `ts` values are fixed rather than minted so the golden needs no
 * timestamp scrubbing — an anchor that has to be scrubbed on a field can hide a change in it.
 */
export const PARITY_ENVELOPES: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 1, ts: '2026-08-23T00:00:00.000Z', runId: PARITY_RUN_ID, type: 'runStarted', payload: { testCount: 1 } },
  { seq: 2, ts: '2026-08-23T00:00:01.000Z', runId: PARITY_RUN_ID, type: 'testStarted', payload: { testId: 't-1', testIndex: 0, name: 'the parity test', filePath: 'tests/parity.yaml', totalSteps: 1 } },
  { seq: 3, ts: '2026-08-23T00:00:02.000Z', runId: PARITY_RUN_ID, type: 'heartbeat', payload: {} },
  { seq: 4, ts: '2026-08-23T00:00:03.000Z', runId: PARITY_RUN_ID, type: 'stepStarted', payload: { testIndex: 0, stepIndex: 0, stepText: 'Verify the page says "Example"' } },
  { seq: 5, ts: '2026-08-23T00:00:04.000Z', runId: PARITY_RUN_ID, type: 'stepFinalized', payload: { testIndex: 0, stepIndex: 0, status: 'healed', durationMs: 12, evidence: { screenshots: ['a.png'], attempts: 2 } } },
  { seq: 6, ts: '2026-08-23T00:00:05.000Z', runId: PARITY_RUN_ID, type: 'testFinished', payload: { testId: 't-1', testIndex: 0, outcome: 'failed', durationMs: 34 } },
  { seq: 7, ts: '2026-08-23T00:00:06.000Z', runId: PARITY_RUN_ID, type: 'verdict', payload: { verdict: 'passed' } },
  { seq: 8, ts: '2026-08-23T00:00:07.000Z', runId: PARITY_RUN_ID, type: 'runFinished', payload: { aggregateVerdict: 'passed' } },
] as unknown as RunEventEnvelope[])
