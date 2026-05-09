import type { z } from 'zod'
import type { AgentQaConfigSchema } from '../schema/config-schema.js'
import type { WorkspaceSchema } from '../schema/workspace-schema.js'
import type { ServicesSchema } from '../schema/services-schema.js'
import type { RegistrySchema } from '../schema/registry-schema.js'
import type { UseSchema } from '../schema/use-schema.js'

export type AgentQaConfig = z.infer<typeof AgentQaConfigSchema>
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>
export type ServicesConfig = z.infer<typeof ServicesSchema>
export type RegistryConfig = z.infer<typeof RegistrySchema>
export type UseConfig = z.infer<typeof UseSchema>
