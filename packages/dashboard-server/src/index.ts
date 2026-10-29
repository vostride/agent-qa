export * from './db/index.js'
export * from './reporter/index.js'
export * from './server/index.js'
export * from './config/index.js'
export {
  InProcessExecutionBackend,
  createInProcessExecutionBackend,
  type InProcessExecutionBackendOptions,
  type InProcessRunStarter,
  type InProcessRunStartInput,
  type InProcessRunStatus,
} from './execution/in-process-backend.js'
export type {
  ExecuteOptions,
  ExecutionBackend,
  RunSettledDetails,
  RunSettledStatus,
} from './execution/execution-backend.js'
export { AppiumManager } from './execution/appium-manager.js'
// Published because `agent-qa dashboard` creates the one relay and threads both halves.
export {
  createPostProcessingRelay,
  type PostProcessingListener,
  type PostProcessingRelay,
} from './execution/post-processing-relay.js'
// The joined read and its vocabulary, for conformance cells and clients needing its predicate.
export {
  POST_PROCESSING_STREAM_HEARTBEAT_MS,
  isPostProcessingTerminal,
  readPostProcessing,
  servePostProcessingRead,
  servePostProcessingStream,
  type PostProcessingReadBody,
  type PostProcessingStageFailure,
} from './run-service/post-processing-routes.js'
// Published because the CLI composition root owns this server's one database handle.
export {
  createDashboardRunDetailReader,
  type DashboardRunDetailReader,
} from './run-service/run-detail-reader.js'
export {
  readRunDetail,
  serveRunDetailRead,
  type RunDetailReadOutcome,
  // The ref-resolving pair; the authed door answers by calling `serveRunArtifact`.
  readRunArtifact,
  serveRunArtifact,
  type RunArtifactReadOutcome,
} from './run-service/run-detail-routes.js'
export { TestFileManager } from './tests/test-file-manager.js'
export type { TestFileInfo, TestValidationResult, TestValidationError } from './tests/test-file-manager.js'
// A mountable module whose ports the CLI's `dashboard` command composes; the table is enumerable.
export {
  // Route templates, published so the conformance census names the paths it drives.
  RUN_SERVICE_ANALYSIS_TEMPLATE,
  RUN_SERVICE_ARTIFACT_TEMPLATE,
  RUN_SERVICE_DETAIL_TEMPLATE,
  RUN_SERVICE_EVENTS_TEMPLATE,
  // The evidence and the two feedback read rows, on the same footing.
  RUN_SERVICE_EVIDENCE_TEMPLATE,
  RUN_SERVICE_LIVE_URL_TEMPLATE,
  RUN_SERVICE_MARK_PREVIEW_TEMPLATE,
  RUN_SERVICE_MARKS_TEMPLATE,
  RUN_SERVICE_OK_ROUTE,
  RUN_SERVICE_ROUTE_TABLE,
  RUN_SERVICE_START_ROUTE,
  createRunServiceRoutes,
  matchRunServiceRoute,
  ownsRunServicePath,
} from './run-service/run-service-routes.js'
// The live-view surface, published because the CLI composes the proxy and conformance drives it.
export {
  LIVE_EMBED_EXPIRED_MESSAGE,
  LIVE_EMBED_HOST_PARAM,
  LIVE_EMBED_NO_STREAM_MESSAGE,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_EMBED_REPORT_INTERVAL_MS,
  LIVE_EMBED_SESSION_ENDED_MESSAGE,
  LIVE_EMBED_STATES,
  renderLiveEmbedPage,
} from './live-view/embed-page.js'
export { createFrameProxy } from './live-view/frame-proxy.js'
// The editor-subject registry the frame socket reads editor sessions from.
export { createLiveEditorSubjects } from './live-view/editor-subjects.js'
export type { LiveEditorAttachment, LiveEditorSubjects } from './live-view/editor-subjects.js'
export {
  LIVE_EMBED_PATH_PREFIX,
  LIVE_VIEW_END_REASONS,
  LIVE_VIEW_HELLO_MAX_BYTES,
  LIVE_VIEW_PING_MS,
  LIVE_VIEW_REFUSAL_CLOSE_CODE,
  LIVE_VIEW_REFUSAL_REASONS,
  LIVE_VIEW_SLOW_VIEWER_BYTES,
  LIVE_VIEW_WS_PATH,
} from './live-view/protocol.js'
// The control socket's close codes; the dashboard UI spells the same numbers.
export { LIVE_EDITOR_SUPERSEDED_CLOSE_CODE, LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from './live-editor/types.js'
export type {
  LiveViewClientMessage,
  LiveViewRefusalReason,
  LiveViewServerMessage,
} from './live-view/protocol.js'
export type { LiveEmbedReportEvent, LiveEmbedState } from './live-view/embed-page.js'
export type {
  MintLiveUrlInput,
  ResumePoint,
  RunServicePorts,
  RunServiceRouteHandlerName,
  RunServiceRouteMatch,
  RunServiceRouteRow,
  RunServiceRouter,
  RunServiceStartInput,
} from './run-service/run-service-routes.js'
export { markRun, registerRunMarkRoute, type RunMarkOutcome } from './run-service/run-mark-routes.js'
