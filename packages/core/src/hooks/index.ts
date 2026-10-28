// Hook PARSING stays in core (feeds the resolved RunConfig, D-05). Hook EXECUTION
// (orchestrator, sandbox-runner, types) moved to @vostride/agent-qa-runner /
// -runner-local in Phase 363 D-06 — no core re-export of runHooks/DockerHookExecutor
// (no shim). The hook TYPE vocabulary is re-exported from runner so core parser/schema
// consumers keep resolving through the core barrel.
export type { HookRuntime, HookDefinition, HookResult } from '@vostride/agent-qa-runner'
export { RUNTIME_IMAGE_MAP, hookRunnerImage } from '@vostride/agent-qa-runner'
export * from './schema.js'
export { parseHooksFile } from './parser.js'
