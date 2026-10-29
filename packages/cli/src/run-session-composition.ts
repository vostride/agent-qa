// The terminal-bound part of run composition: reporter attachment and its live line.

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

// Seqs start at 1; `subscribe(0)` would demand a seq-0 prefix and raise `ReplayIncompleteError`.
export const REPLAY_FROM_START = 1

// One factory for both `startRun` sites, so the subscriber cannot be configured differently.
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
  // The set `startRun` was given; this is the one place either reporter is constructed.
  quarantined?: readonly QuarantineAppliedEntry[]
}

// One attach for both `startRun` sites; `flush()` awaits every subscriber before the verdict maps.
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
    // `allSettled`, so one subscriber's fault never aborts the others or the run.
    async flush(): Promise<void> {
      await Promise.allSettled(flushes.map((f) => f()))
    },
  }
}
