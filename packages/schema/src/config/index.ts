export type { PlatformBase, TimeoutConfig } from './base'
export {
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  platformBase,
  platformBaseShape,
  timeoutConfigSchema,
} from './base'
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
export type { ConfigLeafPattern } from './leaves'
export { CONFIG_SCHEMA_LEAVES, configLeafOwner, isConfigSchemaPath } from './leaves'
export type { BrowserConfig } from './browser'
export { appStateSchema, browserConfigSchema, viewportSchema } from './browser'
export type { DeviceConfig } from './device'
export { deviceConfigSchema } from './device'
export type { EffectiveWorkersInput } from './use'
export { DEFAULT_PARALLEL_WORKERS, resolveEffectiveWorkers } from './use'
export type { PlannerLimits, PlannerLimitsPerTest, PlannerLimitsRecord } from './planner-limits'
export { DEFAULT_PLANNER_LIMITS, PLANNER_LIMIT_KEYS, resolvePlannerLimits } from './planner-limits'
