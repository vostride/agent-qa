import { getAgentQaVersion } from '@vostride/agent-qa-core'

export * from '@vostride/agent-qa-core'
export const VERSION = getAgentQaVersion()
export * from './config.js'
export * from './targets.js'
export { purgeTest, purgeAll } from './commands/cache.js'
