export type { PlatformBase, TimeoutConfig } from './base'
export {
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  platformBase,
  platformBaseShape,
  timeoutConfigSchema,
} from './base'
// the field-merge write DTO PATCH /api/config parses; 429-04 D-24 adds
// the Undo DTOs beside it.
export type {
  ConfigActionRefusal,
  ConfigChange,
  ConfigNamedArray,
  ConfigPathSegment,
  ConfigUndoRequest,
  ConfigUndoResult,
  ConfigWriteIssue,
  ConfigWriteOp,
  ConfigWriteRefusal,
  ConfigWriteRequest,
  ConfigWriteResult,
} from './config-write'
// the page write door's denied roots and path policy.
export type { ConfigWriteDeniedRoot } from './config-write'
export {
  CONFIG_ACTION_REFUSALS,
  CONFIG_NAMED_ARRAYS,
  CONFIG_REVISION_ABSENT,
  CONFIG_WRITE_DENIED_ROOTS,
  CONFIG_WRITE_OPS,
  CONFIG_WRITE_REFUSALS,
  ConfigChangeSchema,
  ConfigPathSegmentSchema,
  ConfigUndoRequestSchema,
  ConfigWriteRequestSchema,
  isPageWritableConfigPath,
  MARKER_WRITTEN_BACK_SENTENCE,
} from './config-write'
// The published config schema's leaf list; 441-40 deleted the masking map it came from.
export type { ConfigLeafPattern } from './leaves'
export { CONFIG_SCHEMA_LEAVES, configLeafOwner, isConfigSchemaPath } from './leaves'
export type { BrowserConfig } from './browser'
export { appStateSchema, browserConfigSchema, viewportSchema } from './browser'
export type { DeviceConfig } from './device'
export { deviceConfigSchema } from './device'
export type { EffectiveWorkersInput } from './use'
export { DEFAULT_PARALLEL_WORKERS, resolveEffectiveWorkers } from './use'
// 2026-10-07 (436-04, D-01..D-03): the per-step planner limits' one default pair and resolver.
export type { PlannerLimits, PlannerLimitsPerTest, PlannerLimitsRecord } from './planner-limits'
export { DEFAULT_PLANNER_LIMITS, PLANNER_LIMIT_KEYS, resolvePlannerLimits } from './planner-limits'
