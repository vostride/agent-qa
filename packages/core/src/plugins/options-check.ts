import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { SECRET_REFERENCE_PATTERN } from '@vostride/agent-qa-schema'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

import type { ResolvedPluginEntry } from './resolve-entries.js'

export const MAX_PLUGIN_SCHEMA_BYTES = 256 * 1024
export const MAX_PLUGIN_SCHEMA_DEPTH = 64

export interface PluginConfigIssue {
  scope: 'options' | 'settings'
  remote?: string
  path: (string | number)[]
  message: string
}

export interface PluginConfigInput {
  options: unknown
  remotes: readonly { name: string; settings?: unknown }[]
}

type Scope = PluginConfigIssue['scope']
type DataPath = (string | number)[]
type JsonObject = Record<string, unknown>

type LoadedSchema =
  | { ok: true; schema: JsonObject; validate: ValidateFunction }
  | { ok: false; message: string }

const WHOLE_REFERENCE = new RegExp(`^${SECRET_REFERENCE_PATTERN.source}$`)
const REFERENCE_PLACEHOLDER = 'secret-reference'
const COMBINATORS = ['allOf', 'anyOf', 'oneOf'] as const

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exceedsDepth(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (depth > MAX_PLUGIN_SCHEMA_DEPTH) return true
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.some((child) => exceedsDepth(child, depth + 1))
}

function loadSchema(packageDir: string, file: string): LoadedSchema {
  const path = resolve(packageDir, file)
  let text: string
  try {
    if (statSync(path).size > MAX_PLUGIN_SCHEMA_BYTES) {
      const kib = MAX_PLUGIN_SCHEMA_BYTES / 1024
      const message = `${file} is larger than ${kib} KiB, the most a plugin schema may be`
      return { ok: false, message }
    }
    text = readFileSync(path, 'utf-8')
  } catch {
    return { ok: false, message: `${file} is not readable JSON` }
  }

  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch {
    return { ok: false, message: `${file} is not readable JSON` }
  }
  if (exceedsDepth(schema, 1)) {
    const levels = MAX_PLUGIN_SCHEMA_DEPTH
    const message = `${file} nests deeper than ${levels} levels, the most a plugin schema may`
    return { ok: false, message }
  }
  if (!isObject(schema)) {
    return { ok: false, message: `${file} is not a valid JSON Schema (not an object)` }
  }

  // Formats stay annotations: strict mode refuses any format it has no validator for.
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false })
  ajv.addKeyword('credential')
  try {
    return { ok: true, schema, validate: ajv.compile(schema) }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]
    return { ok: false, message: `${file} is not a valid JSON Schema (${reason})` }
  }
}

function localDefinition(root: JsonObject, ref: unknown): JsonObject | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return undefined
  const defs = root.$defs
  if (!isObject(defs)) return undefined
  const found = defs[ref.slice('#/$defs/'.length)]
  return isObject(found) ? found : undefined
}

// Pairs each credential-marked schema node with the data at the same place.
function credentialPaths(
  root: JsonObject,
  schema: unknown,
  data: unknown,
  path: DataPath,
  refs: ReadonlySet<string>,
  found: DataPath[],
): void {
  if (!isObject(schema) || data === undefined) return
  if (schema.credential === true) found.push(path)

  const ref = schema.$ref
  const definition = localDefinition(root, ref)
  if (definition && typeof ref === 'string' && !refs.has(ref)) {
    credentialPaths(root, definition, data, path, new Set([...refs, ref]), found)
  }
  for (const combinator of COMBINATORS) {
    const branches = schema[combinator]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) credentialPaths(root, branch, data, path, refs, found)
  }
  if (isObject(schema.properties) && isObject(data)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(data, key)) continue
      credentialPaths(root, child, data[key], [...path, key], refs, found)
    }
  }
  if (isObject(schema.items) && Array.isArray(data)) {
    data.forEach((item, index) => {
      credentialPaths(root, schema.items, item, [...path, index], refs, found)
    })
  }
}

function valueAt(data: unknown, path: DataPath): unknown {
  let current = data
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string | number, unknown>)[segment]
  }
  return current
}

function replaceAt(data: unknown, path: DataPath, value: unknown): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (Array.isArray(data)) {
    const copy = [...data]
    copy[head as number] = replaceAt(copy[head as number], rest, value)
    return copy
  }
  const record = data as JsonObject
  return { ...record, [head]: replaceAt(record[head], rest, value) }
}

function pointerOf(path: DataPath): string {
  return path
    .map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`)
    .join('')
}

function pathOfPointer(pointer: string): DataPath {
  if (pointer === '') return []
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment))
}

function dotted(scope: Scope, path: DataPath): string {
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`,
    scope,
  )
}

function describeError(scope: Scope, error: ErrorObject): { path: DataPath; sentence: string } {
  const at = pathOfPointer(error.instancePath)
  const params = error.params as Record<string, unknown>
  const extra = params.additionalProperty ?? params.unevaluatedProperty
  if (
    (error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties')
    && typeof extra === 'string'
  ) {
    const path = [...at, extra]
    const noun = scope === 'options' ? 'an option' : 'a setting'
    return { path, sentence: `${dotted(scope, path)} is not ${noun} this plugin takes` }
  }
  if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
    const path = [...at, params.missingProperty]
    return { path, sentence: `${dotted(scope, path)} is required` }
  }
  return { path: at, sentence: `${dotted(scope, at)} ${error.message ?? 'is not valid'}` }
}

function checkValue(
  loaded: Extract<LoadedSchema, { ok: true }>,
  scope: Scope,
  value: unknown,
  speaker: string,
  remote: string | undefined,
): PluginConfigIssue[] {
  const data: unknown = value ?? {}
  const marked: DataPath[] = []
  credentialPaths(loaded.schema, loaded.schema, data, [], new Set(), marked)

  let checked = data
  const references = new Set<string>()
  const literals = new Map<string, DataPath>()
  for (const path of marked) {
    const held = valueAt(data, path)
    if (typeof held !== 'string') continue
    if (WHOLE_REFERENCE.test(held)) {
      checked = replaceAt(checked, path, REFERENCE_PLACEHOLDER)
      references.add(pointerOf(path))
    } else {
      literals.set(pointerOf(path), path)
    }
  }

  const issue = (path: DataPath, sentence: string): PluginConfigIssue => ({
    scope,
    ...(remote === undefined ? {} : { remote }),
    path,
    message: `${speaker}: ${sentence}.`,
  })

  const issues: PluginConfigIssue[] = []
  if (!loaded.validate(checked)) {
    for (const error of loaded.validate.errors ?? []) {
      if (references.has(error.instancePath)) continue
      const { path, sentence } = describeError(scope, error)
      issues.push(issue(path, sentence))
    }
  }
  for (const path of literals.values()) {
    const sentence =
      `${dotted(scope, path)} is a credential; write it as a {{secret:NAME}} reference to `
      + 'workspace.secretsFile'
    issues.push(issue(path, sentence))
  }
  return issues
}

export function checkPluginConfig(
  resolved: ResolvedPluginEntry,
  config: PluginConfigInput,
): PluginConfigIssue[] {
  const { manifest, packageDir } = resolved
  if (!manifest || !packageDir) return []
  const entrySpeaker = `Plugin entry ${resolved.name}`
  const issues: PluginConfigIssue[] = []

  if (manifest.options !== undefined) {
    const loaded = loadSchema(packageDir, manifest.options)
    if (loaded.ok) {
      issues.push(...checkValue(loaded, 'options', config.options, entrySpeaker, undefined))
    } else {
      issues.push({ scope: 'options', path: [], message: `${entrySpeaker}: ${loaded.message}.` })
    }
  }

  if (manifest.kind === 'remote' && config.remotes.length > 0) {
    const loaded = loadSchema(packageDir, manifest.settings)
    if (!loaded.ok) {
      issues.push({ scope: 'settings', path: [], message: `${entrySpeaker}: ${loaded.message}.` })
      return issues
    }
    for (const remote of config.remotes) {
      const speaker = `Remote ${remote.name}`
      issues.push(...checkValue(loaded, 'settings', remote.settings, speaker, remote.name))
    }
  }

  return issues
}
