// Barrel for @vostride/agent-qa-runner-local.
//
// The storageImplementation home for the concrete filesystem + git-branch
// action-plan cache store behind the runner ActionPlanCache port (Phase 356).

// Neutral port + key types this package's store implements. These type
// re-exports also anchor the runner + schema workspace dependencies the
// ownership contract declares.
export type { ActionPlanCache, StorageStatePort, StorageStateReference, StorageStateBlob } from '@vostride/agent-qa-runner'
export type { CacheKey } from '@vostride/agent-qa-schema'

// Concrete filesystem store + its bumped on-disk schema version (D-03/D-06/D-14).
export { FsActionCache, CACHE_SCHEMA_VERSION, purgeActionCache } from './fs-action-cache.js'
export type { FsActionCacheConfig } from './fs-action-cache.js'

// Concrete filesystem storage-state store (D-14) — raw-but-local auth persistence.
export { FsStorageStateStore, STORAGE_STATES_SUBDIR } from './storage-state-store.js'
export type { FsStorageStateStoreConfig } from './storage-state-store.js'

// Injectable git-branch resolver + slug sanitizer (security V5).
export { resolveBranch, slugBranch } from './branch-resolver.js'
export type { BranchResolverOptions, ResolvedBranch } from './branch-resolver.js'

// Branch write-skip policy (D-14).
export { shouldWrite } from './write-policy.js'
export type { CachePolicy } from './write-policy.js'

// Runner-local persistence tier (Phase 361, D-05/D-06/D-17/D-18/D-19).
// JSONL event log + completed-run handoff store + per-product buildOrdinal counter,
// each behind a runner-declared port (EventLogPort/HandoffStorePort) or a thin fs leg.
export { FsEventLog, RUNS_SUBDIR, EVENTS_FILE } from './event-log.js'
export type { FsEventLogConfig } from './event-log.js'
export { FsHandoffStore, loadCompletedRunHandoff, HANDOFF_FILE } from './handoff-store.js'
export type { FsHandoffStoreConfig } from './handoff-store.js'

// Phase 363 D-08 — the fs run-artifact store behind the runner RunArtifactStorePort. Writes one
// artifact.json into the SAME <root>/runs/<slug(runId)>/ family as events.jsonl / handoff.json.
export { FsRunArtifactStore, ARTIFACT_FILE } from './run-artifact-store.js'
export type { FsRunArtifactStoreConfig } from './run-artifact-store.js'

// Phase 367 CASS-02 — the content-addressed evidence artifact store behind the runner
// EvidenceArtifactStorePort. Writes decision-screenshot bytes to blobs/<sha> in the SAME
// <root>/runs/<slug(runId)>/ family as events.jsonl / handoff.json / artifact.json.
export { FsEvidenceArtifactStore, RUN_EVIDENCE_BLOBS_SUBDIR } from './evidence-artifact-store.js'
export type { FsEvidenceArtifactStoreConfig } from './evidence-artifact-store.js'

// Phase 363 D-08 / Q10 — the sharp screenshot compressor behind the runner ScreenshotCompressor
// port (sharp's host-adapter home; banned in the storage-neutral runner). `alignToWindow` /
// `getImageDimensions` are host-side sharp utilities the mobile adapters call directly.
export {
  SharpScreenshotCompressor,
  alignToWindow,
  flattenOntoWhite,
  getImageDimensions,
} from './screenshot-compressor.js'
export type {
  AlignOptions,
  CompressOptions,
  CompressResult,
  ImageDimensions,
  ScreenshotCompressorLogger,
} from './screenshot-compressor.js'
export {
  BuildOrdinalReservationError,
  nextBuildOrdinal,
  reserveBuildOrdinalForProducts,
  BUILD_ORDINALS_FILE,
} from './build-ordinal.js'
export type {
  BuildOrdinalReservation,
  BuildOrdinalReservationErrorCode,
  NextBuildOrdinalOptions,
  ReserveBuildOrdinalForProductsOptions,
  ReserveBuildOrdinalForProductsResult,
} from './build-ordinal.js'
// Phase 375 D-14/D-16/D-17 — sibling durable tag truth uses first-seen ordinals; latest ordinal is
// exposed as a pure read so derived-index consumers never advance the run-start counter.
export {
  BUILD_TAGS_FILE,
  latestBuildOrdinal,
  readBuildTagMap,
  recordBuildTag,
  resolveBuildTag,
} from './build-tag-map.js'
export type { BuildTagMap } from './build-tag-map.js'

// Phase 363 D-06 — the Docker hook-execution impl behind the runner HookExecutorPort.
// The sandbox-runner body (node:child_process + node:fs) lives here; the runner stays
// storageNeutral. `checkDockerAvailable` is re-homed from core for the CLI doctor command.
export { DockerHookExecutor, checkDockerAvailable } from './hook-executor.js'
export type { DockerHookExecutorConfig } from './hook-executor.js'
