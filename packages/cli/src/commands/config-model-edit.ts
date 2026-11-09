import { isDeepStrictEqual } from 'node:util'

import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import pc from 'picocolors'
import {
  CST,
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  Parser,
  stringify,
  YAMLSeq,
  type Document,
  type YAMLMap,
} from 'yaml'

import { CliRefusal } from '../composition/cli-refusal.js'
import { normalizeConfigForValidation } from '../config.js'
import type { InitModelEntry } from './init-model-choice.js'
import { configWithEntry } from './plugins-add.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

function refuse(line: string): never {
  throw new CliRefusal([pc.red(line)], 2)
}

function isAbsent(node: unknown): boolean {
  return node === undefined || node === null || (isScalar(node) && node.value === null)
}

// A missing or empty key becomes an empty block mapping; anything else must already be one.
function mappingAt(doc: Document, key: string, given: string): void {
  const node = doc.get(key, true)
  if (isAbsent(node)) {
    doc.set(key, doc.createNode({}))
    return
  }
  if (!isMap(node)) refuse(`${key} in ${given} is not a mapping.`)
}

function checked(edited: string, given: string): string {
  const result = AgentQaConfigSchema.safeParse(normalizeConfigForValidation(parse(edited)))
  if (result.success) return edited
  const issue = result.error.issues[0]
  const path = issue?.path.map(String).join('.') ?? ''
  refuse(`Setting the model would leave ${given} invalid: ${path}: ${issue?.message ?? ''}`)
}

interface PluginEntry {
  name: string
  package: string
}

interface DocumentEdit {
  text: string
  // The plugins entry the edit adds, when it adds one.
  plugin?: PluginEntry
}

function documentEdit(
  text: string,
  given: string,
  entry: InitModelEntry,
  subscription: boolean,
): DocumentEdit {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) refuse(`${given} is not valid YAML: ${doc.errors[0]!.message}`)
  if (!isMap(doc.contents)) refuse(`${given} must hold a YAML mapping.`)

  mappingAt(doc, 'registry', given)
  const current = doc.getIn(['registry', 'llms'], true)
  const absent = isAbsent(current)
  if (!absent && !isSeq(current)) refuse(`registry.llms in ${given} is not a list.`)
  const llms = absent ? new YAMLSeq() : (current as YAMLSeq)

  const node = doc.createNode({ ...entry }) as YAMLMap
  const at = llms.items.findIndex((item) => isMap(item) && item.get('name') === entry.name)
  if (at === -1) {
    if (llms.items.length === 0) llms.flow = false
    llms.items.push(node)
  } else {
    const replaced = llms.items[at] as YAMLMap
    node.commentBefore = replaced.commentBefore
    node.comment = replaced.comment
    llms.items[at] = node
  }
  if (absent) doc.setIn(['registry', 'llms'], llms)

  mappingAt(doc, 'use', given)
  doc.setIn(['use', 'llm'], entry.name)
  const edited = doc.toString()
  if (!subscription) return { text: edited }
  // plugins add's own edit, which keeps an entry that already declares the package.
  const plugin = configWithEntry(edited, given, SUBSCRIPTION_AUTH_PACKAGE, undefined)
  if (plugin.content === undefined) return { text: edited }
  return {
    text: plugin.content,
    plugin: { name: plugin.entryName, package: SUBSCRIPTION_AUTH_PACKAGE },
  }
}

// The token edit below keeps every byte it does not change, which a Document re-render does not:
// it re-indents some comments and drops trailing blank lines.

type Collection = CST.BlockMap | CST.BlockSequence

const PLACEHOLDER_KEY = 'agent-qa-placeholder'

function scalarOf(token: CST.Token | null | undefined): string | undefined {
  if (token === null || token === undefined || !CST.isScalar(token)) return undefined
  return CST.resolveAsScalar(token)?.value
}

function pairOf(map: CST.BlockMap, key: string): CST.BlockMap['items'][number] | undefined {
  return map.items.find((item) => scalarOf(item.key) === key)
}

// A collection ends with an item that holds only the comments and blank lines after it.
function isReal(item: CST.CollectionItem): boolean {
  return (
    (item.key !== undefined && item.key !== null) ||
    item.value !== undefined ||
    item.start.some((token) => token.type === 'seq-item-ind' || token.type === 'explicit-key-ind')
  )
}

// The rendered YAML is parsed at the collection's indent behind a placeholder item, so its items
// carry the indentation a later item of the collection carries.
function graft(collection: Collection, rendered: string): boolean {
  const items: readonly CST.CollectionItem[] = collection.items
  let at = items.length
  while (at > 0 && !isReal(items[at - 1]!)) at -= 1
  if (at === 0) return false
  const before = collection.items
    .slice(0, at)
    .map((item) => CST.stringify(item))
    .join('')
  if (!before.endsWith('\n')) return false
  const pad = ' '.repeat(collection.indent)
  const head = collection.type === 'block-map' ? `${PLACEHOLDER_KEY}: 0` : '- 0'
  const lines = rendered.replace(/\n$/u, '').split('\n')
  const snippet = [head, ...lines].map((line) => `${pad}${line}`).join('\n')
  const tokens = [...new Parser().parse(`${snippet}\n`)]
  const [document] = tokens
  if (tokens.length !== 1 || document?.type !== 'document') return false
  const value = document.value
  if (value?.type !== collection.type) return false
  const grafted = value.items.slice(1) as CST.BlockMap['items']
  collection.items.splice(at, 0, ...grafted)
  return true
}

function replaceEntry(map: CST.BlockMap, entry: InitModelEntry): boolean {
  const fields: Record<string, string> = { ...entry }
  for (const [key, value] of Object.entries(fields)) {
    const pair = pairOf(map, key)
    if (pair === undefined) {
      if (!graft(map, stringify({ [key]: value }))) return false
      continue
    }
    if (pair.value === undefined || !CST.isScalar(pair.value)) return false
    if (scalarOf(pair.value) !== value) CST.setScalarValue(pair.value, value)
  }
  for (let at = map.items.length - 1; at >= 0; at -= 1) {
    const item = map.items[at]!
    if (!isReal(item)) continue
    const key = scalarOf(item.key)
    if (key !== undefined && Object.hasOwn(fields, key)) continue
    // The first pair's indent sits in the tokens before the mapping.
    if (at === 0) return false
    map.items.splice(at, 1)
  }
  return true
}

function setModelEntry(top: CST.BlockMap, entry: InitModelEntry): boolean {
  const registry = pairOf(top, 'registry')
  if (registry === undefined) return graft(top, stringify({ registry: { llms: [entry] } }))
  if (registry.value?.type !== 'block-map') return false
  const llms = pairOf(registry.value, 'llms')
  if (llms === undefined) return graft(registry.value, stringify({ llms: [entry] }))
  if (llms.value?.type !== 'block-seq') return false
  const item = llms.value.items.find(
    (candidate) =>
      candidate.value?.type === 'block-map' &&
      scalarOf(pairOf(candidate.value, 'name')?.value) === entry.name,
  )
  if (item === undefined) return graft(llms.value, stringify([entry]))
  return replaceEntry(item.value as CST.BlockMap, entry)
}

function setUseLlm(top: CST.BlockMap, name: string): boolean {
  const use = pairOf(top, 'use')
  if (use === undefined) return graft(top, stringify({ use: { llm: name } }))
  if (use.value?.type !== 'block-map') return false
  const llm = pairOf(use.value, 'llm')
  if (llm === undefined) return graft(use.value, stringify({ llm: name }))
  if (llm.value === undefined || !CST.isScalar(llm.value)) return false
  if (scalarOf(llm.value) !== name) CST.setScalarValue(llm.value, name)
  return true
}

function addPlugin(top: CST.BlockMap, plugin: PluginEntry): boolean {
  const plugins = pairOf(top, 'plugins')
  if (plugins === undefined) return graft(top, stringify({ plugins: [plugin] }))
  if (plugins.value?.type !== 'block-seq') return false
  return graft(plugins.value, stringify([plugin]))
}

function tokenEdit(
  text: string,
  entry: InitModelEntry,
  plugin: PluginEntry | undefined,
): string | undefined {
  const tokens = [...new Parser().parse(text)]
  const documents = tokens.filter((token) => token.type === 'document')
  const [document] = documents
  if (documents.length !== 1 || document?.value?.type !== 'block-map') return undefined
  const top = document.value
  if (!setModelEntry(top, entry) || !setUseLlm(top, entry.name)) return undefined
  if (plugin !== undefined && !addPlugin(top, plugin)) return undefined
  return tokens.map((token) => CST.stringify(token)).join('')
}

function sameConfig(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(parse(a), parse(b))
  } catch {
    return false
  }
}

// parseDocument decides and checks the edit; the token edit is written only when it reads the same.
// A subscription model also declares the subscription plugin.
export function configWithModelEntry(
  text: string,
  given: string,
  entry: InitModelEntry,
  options: { subscription: boolean },
): string {
  const edit = documentEdit(text, given, entry, options.subscription)
  const edited = checked(edit.text, given)
  const kept = tokenEdit(text, entry, edit.plugin)
  return kept !== undefined && sameConfig(kept, edited) ? kept : edited
}
