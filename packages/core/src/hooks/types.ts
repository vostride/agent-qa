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
