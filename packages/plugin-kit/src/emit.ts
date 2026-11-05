import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PluginDefinition } from './define-plugin.js'
import {
  PLUGIN_MANIFEST_FIELD,
  PluginManifestSchema,
  type RemotePluginManifest,
} from './protocol/manifest.js'
import { PLUGIN_PROTOCOL_VERSION } from './protocol/messages.js'

export interface EmitPluginFilesInput<
  OptionsSchema extends z.ZodType,
  SettingsSchema extends z.ZodType,
> {
  definition: PluginDefinition<OptionsSchema, SettingsSchema>
  packageDir: string
}

export interface EmittedPluginFiles {
  manifest: RemotePluginManifest
  optionsSchemaFile: string
  settingsSchemaFile: string
  packageJsonChanged: boolean
}

const OPTIONS_SCHEMA_PATH = './dist/options.schema.json'
const SETTINGS_SCHEMA_PATH = './dist/settings.schema.json'

export function pluginManifest<OptionsSchema extends z.ZodType, SettingsSchema extends z.ZodType>(
  definition: PluginDefinition<OptionsSchema, SettingsSchema>,
): RemotePluginManifest {
  const manifest = PluginManifestSchema.parse({
    protocol: PLUGIN_PROTOCOL_VERSION,
    kind: 'remote',
    runs: 'process',
    entry: './dist/main.js',
    serves: [...definition.serves],
    methods: [...definition.methods],
    options: OPTIONS_SCHEMA_PATH,
    settings: SETTINGS_SCHEMA_PATH,
    ...(definition.runFacts === undefined ? {} : { runFacts: [...definition.runFacts] }),
    ...(definition.skill === undefined ? {} : { skill: definition.skill }),
  })
  if (manifest.kind !== 'remote') throw new Error('a plugin built with the kit is remote')
  return manifest
}

function schemaText(schema: z.ZodType): string {
  return `${JSON.stringify(z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }), null, 2)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emitPluginFiles<OptionsSchema extends z.ZodType, SettingsSchema extends z.ZodType>(
  input: EmitPluginFilesInput<OptionsSchema, SettingsSchema>,
): EmittedPluginFiles {
  const { definition, packageDir } = input
  const manifest = pluginManifest(definition)
  const optionsSchemaFile = join(packageDir, OPTIONS_SCHEMA_PATH)
  const settingsSchemaFile = join(packageDir, SETTINGS_SCHEMA_PATH)
  mkdirSync(join(packageDir, 'dist'), { recursive: true })
  writeFileSync(optionsSchemaFile, schemaText(definition.options))
  writeFileSync(settingsSchemaFile, schemaText(definition.settings))

  const packageJsonFile = join(packageDir, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(packageJsonFile, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`${packageJsonFile} is not a JSON object`)
  const field = isRecord(parsed[PLUGIN_MANIFEST_FIELD]) ? parsed[PLUGIN_MANIFEST_FIELD] : {}
  const packageJsonChanged = !isDeepStrictEqual(field.plugin, manifest)
  if (packageJsonChanged) {
    const next = { ...parsed, [PLUGIN_MANIFEST_FIELD]: { ...field, plugin: manifest } }
    writeFileSync(packageJsonFile, `${JSON.stringify(next, null, 2)}\n`)
  }
  return { manifest, optionsSchemaFile, settingsSchemaFile, packageJsonChanged }
}
