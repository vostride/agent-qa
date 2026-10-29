// Not a happy path: a heartbeat, a failed member before a passed verdict, and a nested payload.

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
