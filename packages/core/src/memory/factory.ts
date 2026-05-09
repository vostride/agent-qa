import type { MemoryProvider } from './provider.js'
import { DEFAULT_MEMORY_DIR } from './config.js'

export async function createMemoryProvider(config: { provider: string; memoryRoot?: string; curatorLockTimeout?: number }): Promise<MemoryProvider> {
  if (config.provider === 'local') {
    const { LocalMemoryProvider } = await import('./local-provider.js')
    return new LocalMemoryProvider({
      memoryRoot: config.memoryRoot ?? DEFAULT_MEMORY_DIR,
      curatorLockTimeout: config.curatorLockTimeout,
    })
  }
  throw new Error(`Unknown memory provider: ${config.provider}`)
}
