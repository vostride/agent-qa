import type { RunAttributes } from '@vostride/agent-qa-core'
import type { EventEmitter } from 'node:events'

// 2026-08-27 (405-07, D-19) — THE LEGACY LIVE-EVENT SHAPE IS GONE FROM THIS INTERFACE.
//
// A consumer-facing event type and a per-run replay-buffer getter stood at the top of this file
// since 401-07, both there to serve one retired SSE route. 405-03 removed the browser half of that
// feed and this plan removes the server half, so the type had no consumer and the getter had no
// caller. What replaces them for a live reader is the run-stream SSE over the frozen envelope
// shape; what replaces them for a finished run is the durable `runs.detail` read. One live wire,
// one durable read — which is the whole of D-19.

export interface ExecuteOptions {
  runId: string
  args: string[]
  source: string
  attributes?: RunAttributes
  timeout?: number
  /**
   * The Appium lease URL for a mobile run, AS DATA (401-07, D-01/D-12).
   *
   * The bundled Appium spawn is design-of-record and stays exactly where it is; what changed is the
   * DELIVERY. It used to ride `AGENT_QA_APPIUM_URL` in a child's environment, and a child env is
   * something only a child has. The run happens in this process now, so the lease travels as an
   * argument and is handed to the run through an injected resolver.
   */
  appiumUrl?: string
  // 2026-10-01 (432-14, D-03/D-14): the confirm scope that rode here from the trigger to the run
  // door is deleted with the run-confirm pair. A dashboard run asks nobody, so it names nobody.
}

/**
 * A run has reached a terminal state (401-07, D-04/D-12).
 *
 * THE TYPED SUCCESSOR TO THE CHILD'S `close` EVENT. The host reconciles a db row still reading
 * `running`, releases the run's Appium lease and frees the queue slot off this — exactly what it did
 * off the process exit — but the status is now the bus's own ground truth and the `details` carry
 * the failure's REASON rather than a scraped tail of stderr.
 *
 * `'run-settled'` is now the WHOLE of this emitter's contract. A second event carried the retired
 * live feed's frames and went with it (405-07, D-19).
 */
export interface RunSettledDetails {
  /**
   * A human-readable reason when the run did not simply finish. 2026-09-30, 432-09 (D-15): a
   * refusal is this plain reason. No remedy list rides the settle; nothing asks the reader to act.
   */
  readonly reason?: string
  /**
   * The run NEVER BEGAN — the gate or the host refused it (401-18, G-401-16).
   *
   * A FACT, NOT AN INFERENCE. `settle` has always known this — a rejection with no started session
   * is a denial, a refused request field or an input error — and threw the knowledge away, leaving
   * the host's reconciliation to guess from a regex over the diagnostic lines. It guessed
   * `Process exited before test completed`, which is a sentence about a process, for a run where
   * nothing was ever started to exit.
   *
   * DELIBERATELY A BOOLEAN AND NOT A CLASS. Which refusal it was — `fail-closed-denied`, `blocked`,
   * `session-pin-denied`, an unrecognised request field, a plain input error — is not something the
   * reconciliation branches on, and a prose name for it here would be the same defect one layer
   * down. If a class is ever needed it arrives as a closed-set value owned by `schema`.
   *
   * ABSENT ON A RUN THAT STARTED, including one that started and then failed. That asymmetry is the
   * scope guarantee: every other arm of the reconciliation reads exactly what it read before.
   */
  readonly refusedBeforeStart?: true
  /** Diagnostic lines — a rejection's own message. The typed successor to scraped stderr. */
  readonly output: readonly string[]
}

export type RunSettledStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface ExecutionBackend extends EventEmitter {
  execute(opts: ExecuteOptions): void
  kill(runId: string): boolean
  killAll(): void
  /**
   * The runs this backend currently has in flight, as `GET /api/execution/active` serves them.
   *
   * `testName` IS ON THE INTERFACE (405-07, D-19). It used to be produced by scanning a per-run
   * event buffer for a `testStarted` frame — a read that only the concrete class could perform,
   * through a member the interface did not declare. It is now recorded on the run handle by the
   * backend's own bus subscription, so the field is part of the contract every implementation
   * answers rather than a property of one implementation's internal storage.
   *
   * ABSENT MEANS NO MEMBER HAS STARTED YET, which is a real state on a run between its start and
   * its first `testStarted`; it is never filled with the run id or a placeholder.
   */
  getActiveExecutions(): {
    runId: string
    status: string
    startedAt: string
    duration: number
    testName?: string
  }[]
}
