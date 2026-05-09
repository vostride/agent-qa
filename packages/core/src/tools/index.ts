export { ToolRegistry, defaultRegistry } from './registry.js'
export type { ToolDefinition, ToolCategory } from './types.js'
export { MOBILE_ONLY_ACTIONS, WEB_ONLY_ACTIONS } from './actions/platform-filters.js'
export { buildTools, toolCallToActionPlan } from './builder.js'

// Auto-register all built-in actions on the default registry at module load time
import { defaultRegistry } from './registry.js'
import { registerAllActions } from './actions/index.js'
registerAllActions(defaultRegistry)
