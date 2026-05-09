import path from 'node:path'

export const DEFAULT_MEMORY_DIR = 'agent-qa-memory'

export interface MemoryRootConfig {
  services?: {
    memory?: {
      dir?: string
    }
  }
}

export function resolveMemoryRoot(config: MemoryRootConfig | undefined, configDir: string): string {
  const memoryDir = config?.services?.memory?.dir ?? DEFAULT_MEMORY_DIR
  return path.isAbsolute(memoryDir) ? path.normalize(memoryDir) : path.resolve(configDir, memoryDir)
}
