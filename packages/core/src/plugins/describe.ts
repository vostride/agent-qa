import { loadPluginSchema } from './options-check.js'
import type { ResolvedPluginEntry } from './resolve-entries.js'

export interface PluginField {
  path: string
  type: string
  required: boolean
  default?: unknown
  description?: string
  credential: boolean
}

export interface PluginDescription {
  entry: string
  package?: string
  path?: string
  origin: ResolvedPluginEntry['origin']
  version?: string
  protocol?: number
  serves: string[]
  methods: string[]
  runFacts: string[]
  skill?: string
  options: PluginField[]
  settings: PluginField[]
}

type JsonObject = Record<string, unknown>

interface SchemaNode {
  node: JsonObject
  refs: ReadonlySet<string>
}

const CHOICES = ['anyOf', 'oneOf'] as const

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A local $ref is followed into $defs, with the referring node's own keywords kept over it.
function follow(root: JsonObject, value: unknown, refs: ReadonlySet<string>): SchemaNode {
  if (!isObject(value)) return { node: {}, refs }
  const ref = value.$ref
  const defs = root.$defs
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/') || refs.has(ref) || !isObject(defs)) {
    return { node: value, refs }
  }
  const { $ref: _ref, ...own } = value
  const target = follow(root, defs[ref.slice('#/$defs/'.length)], new Set([...refs, ref]))
  return { node: { ...target.node, ...own }, refs: target.refs }
}

function literal(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value)
}

function typeOf(root: JsonObject, schema: SchemaNode): string {
  const { node, refs } = schema
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(' | ')
  if ('const' in node) return literal(node.const)
  for (const choice of CHOICES) {
    const branches = node[choice]
    if (!Array.isArray(branches)) continue
    const types = branches.map((branch) => typeOf(root, follow(root, branch, refs)))
    return [...new Set(types)].join(' | ')
  }
  const type = node.type
  if (type === 'array') {
    const items = typeOf(root, follow(root, node.items, refs))
    return items.includes(' | ') ? `(${items})[]` : `${items}[]`
  }
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.map(String).join(' | ')
  return isObject(node.properties) ? 'object' : 'any'
}

function isCredential(root: JsonObject, schema: SchemaNode): boolean {
  const { node, refs } = schema
  if (node.credential === true) return true
  return CHOICES.some((choice) => {
    const branches = node[choice]
    return Array.isArray(branches)
      && branches.some((branch) => isCredential(root, follow(root, branch, refs)))
  })
}

function collectFields(
  root: JsonObject,
  parent: SchemaNode,
  prefix: string,
  fields: PluginField[],
): void {
  const properties = parent.node.properties
  if (!isObject(properties)) return
  const required = Array.isArray(parent.node.required) ? parent.node.required : []
  for (const [key, child] of Object.entries(properties)) {
    const schema = follow(root, child, parent.refs)
    const path = prefix === '' ? key : `${prefix}.${key}`
    const { node } = schema
    fields.push({
      path,
      type: typeOf(root, schema),
      required: required.includes(key),
      ...('default' in node ? { default: node.default } : {}),
      ...(typeof node.description === 'string' ? { description: node.description } : {}),
      credential: isCredential(root, schema),
    })
    collectFields(root, schema, path, fields)
  }
}

export function schemaFieldsOf(schema: JsonObject): PluginField[] {
  const fields: PluginField[] = []
  collectFields(schema, { node: schema, refs: new Set() }, '', fields)
  return fields
}

function schemaFields(resolved: ResolvedPluginEntry, packageDir: string, file: string) {
  const loaded = loadPluginSchema(packageDir, file)
  if (!loaded.ok) throw new Error(`Plugin entry ${resolved.name}: ${loaded.message}.`)
  return schemaFieldsOf(loaded.schema)
}

export function describePlugin(resolved: ResolvedPluginEntry): PluginDescription {
  const { manifest, packageDir } = resolved
  if (manifest === undefined || packageDir === undefined) {
    throw new Error(resolved.reason ?? `Plugin entry ${resolved.name} has no readable manifest.`)
  }
  const remote = manifest.kind === 'remote' ? manifest : undefined
  return {
    entry: resolved.name,
    ...(resolved.origin === 'path' ? { path: resolved.label } : { package: resolved.label }),
    origin: resolved.origin,
    ...(resolved.version ? { version: resolved.version } : {}),
    ...(remote === undefined ? {} : { protocol: remote.protocol }),
    serves: [...(remote?.serves ?? [])],
    methods: [...(remote?.methods ?? [])],
    runFacts: [...(remote?.runFacts ?? [])],
    ...(remote?.skill === undefined ? {} : { skill: remote.skill }),
    options:
      manifest.options === undefined ? [] : schemaFields(resolved, packageDir, manifest.options),
    settings: remote === undefined ? [] : schemaFields(resolved, packageDir, remote.settings),
  }
}
