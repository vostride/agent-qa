import { dirname, join } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { InitRefusal } from './init-refusal.js'
import type { ProjectIo } from './project-host.js'
import { nearestFile, type ProjectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

const PACKAGE_JSON_FILE = 'package.json'
const NEW_ENTRY_BLOCK = 'devDependencies'
const DEPENDENCY_BLOCKS = [
  'devDependencies',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const
const FIRST_PARTY_PLUGIN = /^@vostride\/agent-qa-plugin-[a-z0-9][a-z0-9._-]*$/u
const MAX_PACKAGE_NAME_LENGTH = 214

export function installedAgentQaVersion(): string {
  const version = getAgentQaVersion().trim()
  const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
  if (!exactSemver.test(version) || version === '0.0.0') {
    throw new Error(
      'Unable to resolve the installed agent-qa version; refusing to write a dependency range.',
    )
  }
  return version
}

export function sanitizedPackageName(folderName: string): string {
  const name = folderName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gu, '-')
    .replace(/^[._]+/u, '')
    .slice(0, MAX_PACKAGE_NAME_LENGTH)
  return name.length > 0 ? name : 'agent-qa-project'
}

export interface DeclaredDependency {
  name: string
  version: string
}

export function projectDependencies(input: {
  runningVersion: string
  usesSubscription: boolean
  plugins: readonly { package?: unknown }[]
}): DeclaredDependency[] {
  const names = ['agent-qa']
  if (input.usesSubscription) names.push(SUBSCRIPTION_AUTH_PACKAGE)
  for (const plugin of input.plugins) {
    if (typeof plugin.package === 'string' && FIRST_PARTY_PLUGIN.test(plugin.package)) {
      names.push(plugin.package)
    }
  }
  return [...new Set(names)].map((name) => ({ name, version: input.runningVersion }))
}

export type EntryOutcome = 'added' | 'pinned' | 'kept' | 'newer' | 'unchanged'

export interface PackageJsonEntry {
  name: string
  version: string
  spec: string
  block: string
  outcome: EntryOutcome
}

export interface PackageJsonPlan {
  path: string
  root: string
  existed: boolean
  before: string | undefined
  content: string
  changed: boolean
  entries: PackageJsonEntry[]
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function parsePackageJson(path: string, text: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new InitRefusal(`Refusing to update ${path}: it is not valid JSON (${message}).`)
  }
  const object = asObject(value)
  if (object === undefined) {
    throw new InitRefusal(`${path} must contain a JSON object to declare agent-qa.`)
  }
  return object
}

function formattingOf(text: string): FormattingOptions {
  const indent = /^[ \t]+(?=")/mu.exec(text)?.[0] ?? '  '
  const tabs = indent.includes('\t')
  return {
    insertSpaces: !tabs,
    tabSize: tabs ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  }
}

function setEntry(text: string, block: string, name: string, version: string): string {
  const formattingOptions = formattingOf(text)
  const withBlock =
    asObject(JSON.parse(text)[block]) === undefined
      ? applyEdits(text, modify(text, [block], {}, { formattingOptions }))
      : text
  const getInsertionIndex = (keys: string[]): number => {
    const at = keys.findIndex((key) => key > name)
    return at < 0 ? keys.length : at
  }
  return applyEdits(
    withBlock,
    modify(withBlock, [block, name], version, { formattingOptions, getInsertionIndex }),
  )
}

function isNonRegistrySpec(spec: string): boolean {
  return spec.includes(':') || spec.includes('/')
}

export function planPackageJson(input: {
  path: string
  text: string | undefined
  folderName: string
  dependencies: readonly DeclaredDependency[]
}): PackageJsonPlan {
  const { path, text, dependencies } = input
  const base =
    text ??
    `${JSON.stringify({ name: sanitizedPackageName(input.folderName), private: true }, null, 2)}\n`
  const declared = parsePackageJson(path, base)
  const newEntryBlock = declared[NEW_ENTRY_BLOCK]
  if (newEntryBlock !== undefined && asObject(newEntryBlock) === undefined) {
    throw new InitRefusal(
      `Refusing to update ${path}: its ${NEW_ENTRY_BLOCK} is not a JSON object.`,
    )
  }

  let content = base
  const entries: PackageJsonEntry[] = []
  for (const { name, version } of dependencies) {
    const block = DEPENDENCY_BLOCKS.find((candidate) =>
      Object.hasOwn(asObject(declared[candidate]) ?? {}, name),
    )
    if (block === undefined) {
      content = setEntry(content, NEW_ENTRY_BLOCK, name, version)
      entries.push({ name, version, spec: version, block: NEW_ENTRY_BLOCK, outcome: 'added' })
      continue
    }
    const current = (declared[block] as JsonObject)[name]
    if (current === version) {
      entries.push({ name, version, spec: version, block, outcome: 'unchanged' })
      continue
    }
    if (typeof current === 'string' && isNonRegistrySpec(current)) {
      entries.push({ name, version, spec: current, block, outcome: 'kept' })
      continue
    }
    content = setEntry(content, block, name, version)
    entries.push({ name, version, spec: version, block, outcome: 'pinned' })
  }

  return {
    path,
    root: dirname(path),
    existed: text !== undefined,
    before: text,
    content,
    changed: content !== text,
    entries,
  }
}

export function readProjectPackageJson(
  range: ProjectRange,
  io: ProjectIo,
): { path: string; text: string | undefined } {
  const found = nearestFile(range, PACKAGE_JSON_FILE, io)
  if (found === undefined) return { path: join(range.start, PACKAGE_JSON_FILE), text: undefined }
  return { path: found, text: io.readText(found) }
}
