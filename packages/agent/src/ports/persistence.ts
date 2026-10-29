// Only patches remain; the `keyof PersistencePort` pin in the port type tests holds the line.

import type { Patch, PatchId } from '@vostride/agent-qa-schema'

export interface PersistencePort {
  savePatch(patch: Patch): Promise<void>
  getPatch(id: PatchId): Promise<Patch | undefined>
}
