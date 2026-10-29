// Neutral port + key types this package's store implements. These type
// re-exports also anchor the runner + schema workspace dependencies the
// ownership contract declares.
export type { ActionPlanCache, StorageStatePort, StorageStateReference, StorageStateBlob } from '@vostride/agent-qa-runner'
export type { CacheKey } from '@vostride/agent-qa-schema'

// Concrete filesystem store and its on-disk schema version.
export { FsActionCache, CACHE_SCHEMA_VERSION, purgeActionCache } from './fs-action-cache.js'
export type { FsActionCacheConfig } from './fs-action-cache.js'

// Concrete filesystem storage-state store — raw-but-local auth persistence.
export { FsStorageStateStore, STORAGE_STATES_SUBDIR } from './storage-state-store.js'
export type { FsStorageStateStoreConfig } from './storage-state-store.js'

// Injectable git-branch resolver + slug sanitizer (security V5).
export { resolveBranch, slugBranch } from './branch-resolver.js'
export type { BranchResolverOptions, ResolvedBranch } from './branch-resolver.js'

// Branch write-skip policy.
export { shouldWrite } from './write-policy.js'
export type { CachePolicy } from './write-policy.js'

// Runner-local persistence: event log, handoff store and build-ordinal counter.
export { FsEventLog, RUNS_SUBDIR, EVENTS_FILE } from './event-log.js'
export type { FsEventLogConfig } from './event-log.js'
export { FsHandoffStore, loadCompletedRunHandoff, HANDOFF_FILE } from './handoff-store.js'
export type { FsHandoffStoreConfig } from './handoff-store.js'

// Writes `artifact.json` into the same run dir as `events.jsonl` and `handoff.json`.
export { FsRunArtifactStore, ARTIFACT_FILE } from './run-artifact-store.js'
export type { FsRunArtifactStoreConfig } from './run-artifact-store.js'

// Writes decision-screenshot bytes to `blobs/<sha>` in the same run dir.
export { FsEvidenceArtifactStore, RUN_EVIDENCE_BLOBS_SUBDIR } from './evidence-artifact-store.js'
export type { FsEvidenceArtifactStoreConfig } from './evidence-artifact-store.js'

// The sharp compressor and the image utilities the mobile adapters call directly.
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
// Tags keep first-seen ordinals; the latest ordinal is a pure read that never advances the counter.
export {
  BUILD_TAGS_FILE,
  latestBuildOrdinal,
  readBuildTagMap,
  recordBuildTag,
  resolveBuildTag,
} from './build-tag-map.js'
export type { BuildTagMap } from './build-tag-map.js'

// The Docker hook executor; `checkDockerAvailable` serves the CLI doctor command.
export { DockerHookExecutor, checkDockerAvailable } from './hook-executor.js'
export type { DockerHookExecutorConfig } from './hook-executor.js'
