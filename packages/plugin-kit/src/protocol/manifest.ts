import { z } from 'zod'
import { OPTIONAL_PLUGIN_METHODS, PLUGIN_RUN_FACTS, PLUGIN_SERVES } from './messages.js'

// The manifest sits at package.json["agent-qa"].plugin.
export const PLUGIN_MANIFEST_FIELD = 'agent-qa'

const PackagePathSchema = z.string().min(1)

const RemotePluginManifestSchema = z.strictObject({
  kind: z.literal('remote'),
  runs: z.literal('process'),
  protocol: z.number().int().positive(),
  entry: PackagePathSchema,
  serves: z.array(z.enum(PLUGIN_SERVES)).nonempty(),
  methods: z.array(z.enum(OPTIONAL_PLUGIN_METHODS)),
  options: PackagePathSchema,
  settings: PackagePathSchema,
  runFacts: z.array(z.enum(PLUGIN_RUN_FACTS)).optional(),
  skill: PackagePathSchema.optional(),
})

const ModelAuthManifestSchema = z.strictObject({
  kind: z.literal('model-auth'),
  runs: z.literal('in-process'),
  entry: PackagePathSchema,
  options: PackagePathSchema.optional(),
})

const ModelProviderManifestSchema = z.strictObject({
  kind: z.literal('model-provider'),
  runs: z.literal('in-process'),
  entry: PackagePathSchema,
  options: PackagePathSchema.optional(),
})

export const PluginManifestSchema = z.discriminatedUnion('kind', [
  RemotePluginManifestSchema,
  ModelAuthManifestSchema,
  ModelProviderManifestSchema,
])
export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type RemotePluginManifest = z.infer<typeof RemotePluginManifestSchema>
