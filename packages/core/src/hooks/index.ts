// Hook parsing stays in core; hook execution lives in runner, which owns these types.
export type { HookRuntime, HookDefinition, HookResult } from '@vostride/agent-qa-runner'
export { RUNTIME_IMAGE_MAP, hookRunnerImage } from '@vostride/agent-qa-runner'
export * from './schema.js'
export { parseHooksFile } from './parser.js'
