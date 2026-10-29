// Per-request factory plus declared data; cross-call handles travel as tool arguments (SEP-2567).

export { buildAgentQaMcpServer, AGENT_QA_MCP_SERVER_VERSION } from './catalog.js'
export type { AgentQaMcpServerDeps } from './catalog.js'

// The CLI's parity cell compares the shipped stdio instructions against this one source.
export { AGENT_QA_MCP_INSTRUCTIONS } from './instructions.js'

export { createAgentQaMcpNodeHandler } from './http.js'
export type { AgentQaMcpDepsResolver } from './http.js'

// Published so the cli conformance suite reuses this lens rather than a second conversion recipe.
export {
  armWithoutDiscriminant,
  foldArmFindings,
  stripRedundantObjectStamp,
  withoutDialect,
  withoutLegacyResultWrap,
} from './conformance-support.js'
export type { JsonDocument } from './conformance-support.js'

export {
  advertisedContracts,
  AGENT_QA_COMPOSED_CONTRACTS,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
  DEGRADED_OUTPUT_CONTRACTS,
  UNPROJECTED_OPS,
} from './mapping.js'
export type {
  OutputSchemaDegradation,
  ToolComposition,
  ToolOpContracts,
  ToolProjection,
  ToolProjectionKind,
  UnprojectedOp,
} from './mapping.js'

// This surface's one render, published so the rendered-output matrix measures the shipped door.
export { maskedToolResult } from './masked-result.js'

// Exported so cells drive each piece directly; each needs inputs its caller already holds.
export {
  APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY,
  APP_RESOURCE_MIME_TYPE,
  APP_RESOURCE_NAME,
  APP_RESOURCE_URI_TEMPLATE,
  AppResourceNegotiationError,
  AppResourceOriginSpanError,
  AppResourceReadError,
  AppResourceUriError,
  MCP_APPS_EXTENSION_ID,
  appResourceUriFor,
  createAppResourceReadHandler,
  negotiatedAppsExtension,
  parseAppUri,
  registerAppResources,
} from './app-resource.js'
export type {
  AppReadContext,
  AppResourceDeps,
  AppResourceInvoke,
  AppResourceReadDeps,
  AppResourceRegistrar,
} from './app-resource.js'

export {
  // The `ui/initialize` handshake constants are exported so the harness asserts the real message.
  APP_WRAPPER_APP_NAME,
  APP_WRAPPER_APP_VERSION,
  APP_WRAPPER_CONNECTING_HINT,
  APP_WRAPPER_CONNECTING_MESSAGE,
  APP_WRAPPER_EXPIRED_HINT,
  APP_WRAPPER_EXPIRED_MESSAGE,
  APP_WRAPPER_LIVE_MESSAGE,
  APP_WRAPPER_LOAD_TIMEOUT_MS,
  APP_WRAPPER_PERMANENT_LINK_LABEL,
  APP_WRAPPER_RUN_ENDED_MESSAGE,
  APP_WRAPPER_STATES,
  APP_WRAPPER_UI_PROTOCOL_VERSION,
  APP_WRAPPER_UNREACHABLE_MESSAGE,
  renderAppWrapperPage,
} from './app-wrapper.js'
export type { AppWrapperInput, AppWrapperMint, AppWrapperState } from './app-wrapper.js'

// Exported because two hosts compose the supplier, and cells assert against these exact lines.
export {
  LIVE_LINK_ABSENT_LINE,
  LIVE_LINK_NO_RUN_LINE,
  liveLinkLine,
  liveLinkLineFor,
  liveRunLinkOf,
} from './live-link.js'
export type { LiveLinkSupplier } from './live-link.js'

export { McpProjectionError, toRegisterToolConfig } from './projection.js'
export type { ProjectedOpSpec, RegisterToolConfig } from './projection.js'

// Not re-exported: `validate:publish` refuses a dist that ships the ownership contract.
