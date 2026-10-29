export type RunStatus = 'passed' | 'failed' | 'healed' | 'timeout' | 'cancelled'

export type ExecutionContext = 'local-interactive' | 'local-headless' | 'ci' | 'cloud'

// A value, so more than one zod schema can enumerate it without its own copy.
export const EXECUTION_CONTEXT_VALUES = [
  'local-interactive',
  'local-headless',
  'ci',
  'cloud',
] as const satisfies readonly ExecutionContext[]
