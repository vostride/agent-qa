import type { AgentQaAnalyticsEvent } from './events.js'
import type { AnalyticsPort } from './port.js'

// No ambient getter or capture helper: a host reaches telemetry only through a port it holds.

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

// `assertNoUnconstrainedStrings` is published so a consumer checks its own union the same way.
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

// Published so a host reporting the identity reads the same record the resolver reads.
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

// The run-completion subscriber; its `{ handler, flush }` shape attaches at the CLI root.
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
