// Hook execution vocabulary (Phase 363 D-06). Moved byte-equivalently from
// core/src/hooks/types.ts — the runner now owns the hook contracts so the D-06
// port + orchestration can live here (impl in runner-local). Pure types + one
// const map; provider-neutral + storage-neutral (no node:* imports).

export type HookRuntime = 'node' | 'bun' | 'python' | 'bash'

export interface HookDefinition {
  id: string
  name: string
  runtime: HookRuntime
  file: string
  deps: string[]
  packageFile?: string
  timeout: number
  network: boolean
}

export interface HookResult {
  success: boolean
  variables: Record<string, string>
  output: string
  stdout: string
  stderr: string
  duration: number
  error?: string
}

export const RUNTIME_IMAGE_MAP: Record<HookRuntime, string> = {
  node: 'vostride/agent-qa-hook-runner-node',
  bun: 'vostride/agent-qa-hook-runner-bun',
  python: 'vostride/agent-qa-hook-runner-python',
  bash: 'vostride/agent-qa-hook-runner-bash',
}

export function hookRunnerImage(runtime: HookRuntime, version: string): string {
  return `${RUNTIME_IMAGE_MAP[runtime]}:${version}`
}
