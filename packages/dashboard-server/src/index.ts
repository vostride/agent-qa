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
// 404-05 (D-16): the post-processing chip relay — the in-process bridge between the CLI's chip
// emitter and this server's dedicated stream. Published because `agent-qa dashboard` creates the
// ONE instance and threads both halves: `publish` into the run door's bridge, the relay itself
// into `startServer`.
export {
  createPostProcessingRelay,
  type PostProcessingListener,
  type PostProcessingRelay,
} from './execution/post-processing-relay.js'
// 404-05 (D-18/D-23): the joined read and its vocabulary, published for the conformance cells and
// for a client that needs the server's own terminal predicate rather than a second copy of it.
export {
  POST_PROCESSING_STREAM_HEARTBEAT_MS,
  isPostProcessingTerminal,
  readPostProcessing,
  servePostProcessingRead,
  servePostProcessingStream,
  type PostProcessingReadBody,
  type PostProcessingStageFailure,
} from './run-service/post-processing-routes.js'
// 405-01 (D-03): the durable run-detail read and the reader adapter the CLI composition binds.
//
// `createDashboardRunDetailReader` is published because the composition root that owns this
// server's ONE database handle lives in `packages/cli` — this package cannot reach the function
// layer to bind itself, which is the whole of the storage/composition split. `readRunDetail` is
// published on `readPostProcessing`'s footing: a second door answers with byte-identical bytes by
// CALLING it, never by a second spelling that agrees today.
export {
  createDashboardRunDetailReader,
  type DashboardRunDetailReader,
} from './run-service/run-detail-reader.js'
export {
  readRunDetail,
  serveRunDetailRead,
  type RunDetailReadOutcome,
  // 405-05 (D-12/D-13): the ref-resolving pair, on the two names above's exact footing — the
  // authed remote door answers with byte-identical bytes by CALLING `serveRunArtifact`.
  readRunArtifact,
  serveRunArtifact,
  type RunArtifactReadOutcome,
} from './run-service/run-detail-routes.js'
export { TestFileManager } from './tests/test-file-manager.js'
export type { TestFileInfo, TestValidationResult, TestValidationError } from './tests/test-file-manager.js'
// 402-01 (D-02/D-06/D-13 · INVK-03): the authed run service — a mountable module whose every
// reach into the world arrives as injected ports. The CLI's `dashboard` command composes the
// ports and hands them to `startServer`; the route table is published so a census cell can
// enumerate every path this door answers.
export {
  // 405-05 (D-12 / 402 D-16): the two READ rows' templates, published on their siblings' footing
  // so the conformance route census can name the paths it drives rather than spell them.
  // 406-01 (D-04): the analysis row's template, on the same footing.
  RUN_SERVICE_ANALYSIS_TEMPLATE,
  RUN_SERVICE_ARTIFACT_TEMPLATE,
  RUN_SERVICE_DETAIL_TEMPLATE,
  RUN_SERVICE_EVENTS_TEMPLATE,
  // 423-21 (D-04/D-18): the evidence and the two feedback read rows, on the same footing.
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
// 403 D-06: the live-view surface — the served page, the frame proxy, and the wire vocabulary
// both ends type against. Published because the CLI composes the proxy's deps and the conformance
// cells drive the page.
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
// 428 D-07: the editor-subject registry the frame socket reads editor sessions from.
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
// 428 P5: the control socket's close code for a session this process does not hold. The dashboard
// UI spells the same number, and the CLI's conformance cells pin the two equal.
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
