// What is left of the CLI run-session composition after the D-13 dissection (Phase 385 plan 08).
//
// Until this phase this module was 1035 lines and held the whole composition. The host-neutral
// majority now lives in the local agent package's composition subtree, beside where every other
// host will reach it, and this file holds ONLY the part that a terminal is required to run: the
// reporter attachment and the live-line seam those reporters own. 2026-10-01 (432-14, D-03/D-14):
// the readline default is gone — nothing in a run asks, so the CLI hands the per-run registrar no
// confirm channel at all; 432-19 deleted the human-output unmasking confirm decorator with the
// confirm port it wrapped.
//
// There is deliberately NO compatibility re-export here. A module that re-published the moved
// symbols would let every call site keep naming this path, and then nothing would have moved except
// some text: the carve-out would be measuring a fiction. Consumers name the composition package
// directly, and `run-composition.test.ts` pins this file's export set so a shim cannot creep back.
//
// The dissection rule itself is written down once, in the composition package's presentation-ports
// module. Everything below is on the presentation side of it because a headless drainer would have
// to substitute something else for each one.

import type { QuarantineAppliedEntry } from '@vostride/agent-qa-schema'
import type {
  AttachableRunSession,
  RunSubscriberHandle,
} from '@vostride/agent-qa-agent-local'
import { createAnalyticsRunSubscriber } from '@vostride/agent-qa-analytics'
import type { CliAnalyticsHost } from './composition/analytics-host.js'
import {
  createConsoleReporter,
  createJunitReporter,
  createWireReporter,
} from './reporters/index.js'
import type {
  ConsoleReporterHandle,
  ConsoleReporterOptions,
  JunitReporterHandle,
} from './reporters/index.js'

// The bus assigns sequence numbers from 1 (seq 0 never exists). Subscribing at seq 1 replays every
// retained event then goes live — a subscribe(0) would demand a seq-0 prefix the log can never supply
// and raise ReplayIncompleteError (bus.ts collectReplay/D-07). This is the full replay-then-live floor.
export const REPLAY_FROM_START = 1

// 2026-10-02 (432-42, D-14): the console pause/resume seam is deleted. It let the confirm decorator
// clear the live line before a prompt; 432-19 deleted the decorator and nothing read the seam since.

// 2026-10-01 (432-19, D-14/D-15): `buildUnmaskingConfirm` is deleted with `ConfirmPort`. It
// unmasked the action name on a confirm prompt for a person to read; nothing in a run asks any more,
// so there is no prompt to unmask and no port to decorate.

// 2026-10-15 (441-30, D-12/D-15): the per-run hook registrar's CLI assembly is deleted. Its hooks
// carried only the masking and guardrail provider hooks this phase removes, so a run binds none.

/**
 * The run-completion analytics subscriber, built from the host's composed port (398-10, D-17/D-20).
 *
 * IT LIVES HERE, BESIDE `attachRunSubscribers`, FOR THE REASON THAT HELPER DOES: `run.ts` has two
 * `startRun` sites (Pitfall 8) and a subscriber constructed separately at each is a subscriber that
 * can be configured differently at each. One factory, both sites.
 *
 * WHAT MOVED IN THE REWIRE, and it is only the wiring: the subscriber now comes from
 * `@vostride/agent-qa-analytics` rather than `@vostride/agent-qa-core`, and it is handed a PORT the
 * command composed instead of a `config` it would consult itself. The bus-facing shape —
 * `{ handler, flush }` — is byte-for-byte the one `attachRunSubscribers` already subscribes.
 *
 * The trigger source and the runner are passed in by the caller that resolved the run's
 * attributes. The privacy posture is expressed by which transport the composed port holds.
 */
export function buildAnalyticsRunSubscriber(input: {
  /** The invocation's composed analytics. Opted out ⇒ its port has no transport. */
  analytics: CliAnalyticsHost
  /** `agent-qa.trigger` off the resolved run attributes. Anything unrecognised normalises to `unknown`. */
  triggerSource?: string
  /** `agent-qa.runner` off the same attributes, on the same normalisation. */
  runner?: string
}): RunSubscriberHandle {
  return createAnalyticsRunSubscriber({
    port: input.analytics.port,
    standardProperties: input.analytics.properties,
    ...(input.triggerSource === undefined ? {} : { triggerSource: input.triggerSource }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  })
}

export interface AttachRunSubscribersInput {
  session: AttachableRunSession
  /** Console reporter options, or `false` to skip the console surface for this run. */
  console?: ConsoleReporterOptions | false
  /** JUnit output path — when set, the masked durable JUnit subscriber is attached and flushed. */
  junitOutputPath?: string
  /** Prebuilt out-of-package subscribers (dashboard ingest, analytics) constructed by run.ts. */
  extraSubscribers?: readonly RunSubscriberHandle[]
  /**
   * The run-start quarantine snapshot (390 D-15/D-16) — the SAME resolved set `startRun` was given.
   *
   * It arrives here rather than on the bus because this is the one place either reporter is
   * constructed (Pitfall 8), so this is the one place the disposition can be dropped. Both surfaces
   * receive it; both match through schema's single predicate.
   */
  quarantined?: readonly QuarantineAppliedEntry[]
}

/**
 * Attach the run's bus subscribers at a startRun site (used by BOTH sites — Pitfall 8). Constructs
 * the CLI-owned reporters (console, junit and wire print the payloads as masked; wire env-gated),
 * subscribes each via `session.subscribe(REPLAY_FROM_START, …)` alongside any `extraSubscribers`
 * (dashboard/analytics), and returns a single `flush()` awaiting every subscriber's flush (JUnit write, dashboard finalize, analytics
 * drain) — the CLI awaits this after `session.done` before mapping the verdict to the exit code.
 *
 * This is the clearest presentation symbol in the file: three of the four things it constructs
 * render for a human, and a daemon would attach its own subscribers over the same vocabulary
 * instead of inheriting these.
 */
export function attachRunSubscribers(input: AttachRunSubscribersInput): { flush: () => Promise<void> } {
  const flushes: Array<() => Promise<void>> = []

  const quarantined = input.quarantined

  let consoleHandle: ConsoleReporterHandle | undefined
  if (input.console !== false) {
    consoleHandle = createConsoleReporter({
      ...(input.console ?? {}),
      ...(quarantined === undefined ? {} : { quarantined }),
    })
    input.session.subscribe(REPLAY_FROM_START, consoleHandle.handler)
    flushes.push(consoleHandle.flush)
  }

  if (input.junitOutputPath) {
    const junit: JunitReporterHandle = createJunitReporter({
      outputPath: input.junitOutputPath,
      ...(quarantined === undefined ? {} : { quarantined }),
    })
    input.session.subscribe(REPLAY_FROM_START, junit.handler)
    flushes.push(junit.flush)
  }

  // Wire is AGENT_QA_LIVE_EVENTS-gated internally; always attach (no flush — synchronous printer).
  const wire = createWireReporter()
  input.session.subscribe(REPLAY_FROM_START, wire.handler)

  for (const sub of input.extraSubscribers ?? []) {
    input.session.subscribe(REPLAY_FROM_START, sub.handler)
    if (sub.flush) flushes.push(sub.flush)
  }

  return {
    // `allSettled`: every subscriber's flush runs to completion and a single fault (a best-effort
    // analytics/dashboard write) never aborts the others or the run (D-08 detach-on-error philosophy,
    // RUNX-03). All flushes complete BEFORE the caller maps the verdict / exits (Pitfall 6/8).
    async flush(): Promise<void> {
      await Promise.allSettled(flushes.map((f) => f()))
    },
  }
}
