// The `@vostride/agent-qa-mcp` public surface.
//
// WHY THIS FILE LOOKS LIKE THIS. Every v1 export — `startMcpServer`, `createAgentQaMcpServer`, the
// `agent-qa://schema/*` reference tables, the hand-rolled loopback HTTP bridge — was deleted with
// the 33-tool server. Nothing v1 survives here.
//
// THE V1 ENTRY POINTS ARE GONE RATHER THAN RENAMED, because the wire has no place left for them.
// `startMcpServer` served one long-lived session; SEP-2575 removed the `initialize` handshake, the
// `Mcp-Session-Id` header and SSE resumability outright, so a session is no longer a thing a server
// can hold on this revision. What replaces it is a per-request factory plus the declared data
// behind it, with every cross-call handle travelling as an ordinary tool argument (SEP-2567) — this
// product's run ids and knowledge change `operationId` are exactly that pattern, and it is why
// nothing below mints state.
//
// What a HOST needs is the factory and the data behind it. What a TEST needs is the two predicates,
// so they can be driven directly rather than only observed through a running server — the layers
// below `buildAgentQaMcpServer` are exported for that reason and not because anything else calls
// them. The ownership contract is exported because it describes this package.

export { buildAgentQaMcpServer, AGENT_QA_MCP_SERVER_VERSION } from './catalog.js'
export type { AgentQaMcpServerDeps } from './catalog.js'

// the server's initialize instructions, so the CLI's parity cell compares the
// shipped stdio answer against this one source.
export { AGENT_QA_MCP_INSTRUCTIONS } from './instructions.js'

export { createAgentQaMcpNodeHandler } from './http.js'
export type { AgentQaMcpDepsResolver } from './http.js'

// the schema-comparison lens, published for the SAME reason the two
// predicates above it are — so it can be driven directly rather than only observed through a
// running server. Pure normalisations over plain objects; nothing here builds, converts or
// reaches anything, so publishing them hands a consumer no capability. They are on the barrel
// because 397's conformance suite compares an advertised document against the function layer's own
// projection from a different package, and the alternative to sharing this object is a second
// conversion recipe for one comparison — which D-06 rules out by name.
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

// the MCP App surface, published on the same
// driven-directly reasoning as everything above it — the registration gate, the read handler and
// the wrapper renderer each fail in a different direction, and a cell that could only observe them
// through a running protocol server could measure at most one of the three. Publishing them hands a
// consumer no capability it did not already have: `registerAppResources` needs a registry and a
// caller it must already hold, the read handler is a closure over a wall it cannot widen, and
// `renderAppWrapperPage` is a pure function of values its caller composed. The constants are on the
// barrel because Plan 06's census pins them against the ext-apps package from outside this one.
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
  // 2026-08-31 (Phase 408 plan 06 Task 1 · A5): the three handshake constants join the sentence
  // constants on the barrel for the same reason they have — plan 06's harness asserts the
  // `ui/initialize` message the page really posts, and a harness that restated these values would
  // be checking its own transcription rather than the product's.
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

// the permanent link-out. On the barrel
// because two HOSTS compose the supplier that feeds it — the standalone `agent-qa mcp` command and
// the co-hosted mount inside `agent-qa dashboard` — and plan 04's App-less scan cell asserts
// against the SAME line helpers this surface prints rather than against a transcription of them.
// Publishing them hands a consumer no capability: three pure functions over strings it already
// holds, and one constant that is deliberately not an address.
//
// `LIVE_LINK_NO_RUN_LINE` joins them for the SAME reason, and it is
// the reason rather than a habit — the arm it names (a dashboard configured, no resolvable run id)
// had no cell at all, and a cell that transcribed its bytes could pass while the shipped sentence
// said something else. Two constants now, because there are two absences: no base, and no run.
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

// `visibleToCaller` is deleted with the per-caller visibility law; every
// caller sees the same catalogue.

// THE OWNERSHIP CONTRACT IS DELIBERATELY NOT RE-EXPORTED, and a running guard is why. Plan 01 first
// published it here on the reasoning that it describes this package; `pnpm validate:publish` refused
// the build outright — "dist must not ship the ownership contract" — because the contract is an
// internal architectural declaration and a published one becomes something a consumer can read and
// depend on. `packages/arch`'s manifest imports it by relative path, which is the sanctioned route
// and needs no barrel entry.
