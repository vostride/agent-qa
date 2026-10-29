import type { AgentQaAnalyticsEvent } from './events.js'
import type { AnalyticsPort } from './port.js'

// The `@vostride/agent-qa-analytics` public surface.
//
// WHAT IS DELIBERATELY ABSENT. There is no `getAnalytics()`, no `captureAnalytics()`, no
// `flushAnalytics()` — no way to reach telemetry without having been handed a port. The v1 module
// published exactly those three, and the consequence was that any file in the process could emit,
// carrying whatever privacy decision the first constructor happened to make. A host that wants to
// emit here has to name this package at its composition root and hold the object.
//
// The ownership contract is NOT re-exported: `pnpm validate:publish` refuses a dist that ships it,
// and `packages/arch` imports it by relative path, which is the sanctioned route.

export { composeAnalytics } from './compose.js'
export type {
  AnalyticsOptOutConfig,
  AnalyticsOptOutReason,
  AnalyticsTransportKind,
  ComposeAnalyticsOptions,
  ComposedAnalytics,
} from './compose.js'

export { createAnalyticsPort } from './port.js'
export type {
  AnalyticsCapturePayload,
  AnalyticsEventEnvelope,
  AnalyticsIdentity,
  AnalyticsIdentityResolver,
  AnalyticsPort,
  AnalyticsPortOptions,
  AnalyticsPropertyValue,
  AnalyticsTransport,
} from './port.js'

// The closed union, its vocabularies, and the range guard. `assertNoUnconstrainedStrings` is
// published rather than kept private for the same reason the two MCP predicates are: it is a pure
// walk over schemas that grants a consumer no capability, and a later phase adding a member wants
// to range its own union with the SAME checker rather than a second, kinder one.
export {
  AgentQaAnalyticsEventSchema,
  ANALYTICS_AGENT_PRODUCTS,
  ANALYTICS_CHAT_END_REASONS,
  ANALYTICS_DAEMON_JOB_KINDS,
  ANALYTICS_DAEMON_JOB_OUTCOMES,
  ANALYTICS_EMITTING_HOSTS,
  ANALYTICS_EVENT_MEMBERS,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_SCHEMA_BY_NAME,
  ANALYTICS_FAILURE_CATEGORIES,
  ANALYTICS_INIT_MODES,
  ANALYTICS_INIT_OUTCOMES,
  ANALYTICS_KNOWN_ID_MARKER,
  ANALYTICS_MCP_ERROR_CATEGORIES,
  ANALYTICS_MCP_SERVER_STATES,
  ANALYTICS_MCP_TOOL_NAMES,
  ANALYTICS_MCP_TOOL_STATUSES,
  ANALYTICS_MCP_TRANSPORTS,
  ANALYTICS_PLATFORMS,
  ANALYTICS_RUN_STATUSES,
  ANALYTICS_RUNNERS,
  ANALYTICS_RUNTIME_CONTEXTS,
  ANALYTICS_SUITE_EXECUTION_MODES,
  ANALYTICS_TRIGGER_SOURCES,
  ANALYTICS_VOCABULARY_META_KEY,
  analyticsRunId,
  analyticsSuiteId,
  analyticsTestId,
  assertNoUnconstrainedStrings,
  RETIRED_V33_EVENT_NAMES,
} from './events.js'
export type { AgentQaAnalyticsEvent, AnalyticsEventName } from './events.js'

// The send seam. `maskEventForSend` is published so a later transport (a second sink, a batching
// relay) composes the SAME seam rather than writing its own. The host hands it the declared-secret
// mask.
export { maskEventForSend } from './masking-seam.js'
export type { AnalyticsMaskingContext } from './masking-seam.js'

// The anonymous identity store, re-homed from `core`.
// The store functions are published rather than hidden behind `resolveAnalyticsIdentity` because a
// host that wants to REPORT the identity (a doctor command, a `--verbose` line) should read the
// same record the resolver reads instead of re-deriving the path its own way.
export {
  ANALYTICS_USER_ID_PREFIX,
  ANALYTICS_USER_ID_WORDS,
  generateAnalyticsUserId,
  getAnalyticsIdentityPath,
  readAnalyticsIdentity,
  resolveAnalyticsAgentProduct,
  resolveAnalyticsIdentity,
} from './identity.js'
export type {
  AnalyticsAgentProduct,
  AnalyticsIdentityStore,
  AnalyticsRuntimeContext,
  ResolveAnalyticsIdentityOptions,
  ResolvedAnalyticsIdentity,
} from './identity.js'

// The run-completion bus subscriber. Its `{ handler, flush }` shape is the one plan 10 attaches at
// the CLI root, unchanged from the module it replaces so the rewire is an import and nothing else.
export { createAnalyticsRunSubscriber } from './run-subscriber.js'
export type {
  AnalyticsRunner,
  AnalyticsRunStandardProperties,
  AnalyticsRunSubscriber,
  AnalyticsRunSubscriberOptions,
  AnalyticsTriggerSource,
} from './run-subscriber.js'

export { createPosthogTransport } from './transports.js'
export type {
  PosthogAnalyticsClient,
  PosthogTransportFactory,
  PosthogTransportOptions,
} from './transports.js'

// The port as a HOST should hold it: parameterised by the closed union, so `capture` refuses an
// event that is not a member at the call site, before any parse. `AnalyticsPort` on its own is the
// structural floor the transports are written against; this is the type with the union in it.
export type AgentQaAnalyticsPort = AnalyticsPort<AgentQaAnalyticsEvent>
