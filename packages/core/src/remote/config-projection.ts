import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, visit } from 'yaml'
import type { Document, Node, YAMLMap } from 'yaml'
import { projectConfigRemotes } from '@vostride/agent-qa-schema'

const UNSHOWABLE = '# This config cannot be shown without its remote endpoints.\n'
const NAMES_REMOTES = /(?<![\w-])remotes(?![\w-])/
const MARK_KEY = 'agent-qa-mark'

function resolved(doc: Document, node: unknown): unknown {
  return isAlias(node) ? node.resolve(doc) : node
}

function shownRemotes(doc: Document, remotes: Node): unknown[] {
  try {
    const projected = projectConfigRemotes({ registry: { remotes: remotes.toJS(doc) as unknown } })
    return projected.registry.remotes as unknown[]
  } catch {
    return []
  }
}

function entryUrls(doc: Document, remotes: Node): unknown[] {
  if (!isSeq(remotes)) return []
  return remotes.items.map((item) => {
    const entry = resolved(doc, item)
    const url = isMap(entry) ? resolved(doc, entry.get('url', true)) : undefined
    return isScalar(url) && typeof url.value === 'string' ? url.value : undefined
  })
}

interface RemotesBlock {
  readonly root: YAMLMap
  readonly registry: YAMLMap
  readonly remotes: Node
}

function remotesBlock(doc: Document): RemotesBlock | undefined {
  const root = resolved(doc, doc.contents)
  if (!isMap(root)) return undefined
  const registry = resolved(doc, root.get('registry', true))
  if (!isMap(registry)) return undefined
  const remotes = resolved(doc, registry.get('remotes', true))
  if (!isNode(remotes) || (isScalar(remotes) && remotes.value === null)) return undefined
  return { root, registry, remotes }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// What the config loader reads: yaml's parse is parseDocument followed by toJS.
function loadedRemotes(doc: Document): unknown {
  const loaded: unknown = doc.toJS()
  if (!isRecord(loaded) || !isRecord(loaded.registry)) return undefined
  return loaded.registry.remotes
}

// The marker goes inside the block, not in its place, so every anchor in the block still resolves.
function loadsFromBlock(doc: Document): boolean {
  const copy = doc.clone()
  const found = remotesBlock(copy)
  if (found === undefined) return false
  const mark = {}
  const block = found.remotes
  if (isSeq(block)) {
    block.add(new Scalar(mark))
    const loaded = loadedRemotes(copy)
    return Array.isArray(loaded) && loaded[loaded.length - 1] === mark
  }
  if (isMap(block)) {
    block.set(MARK_KEY, new Scalar(mark))
    const loaded = loadedRemotes(copy)
    return isRecord(loaded) && loaded[MARK_KEY] === mark
  }
  if (!isScalar(block)) return false
  const marker = new Scalar(mark)
  marker.anchor = block.anchor
  found.registry.set('remotes', marker)
  return loadedRemotes(copy) === mark
}

function nodesUnder(node: Node): unknown[] {
  const nodes: unknown[] = []
  visit(node, (_key, child) => {
    nodes.push(child)
  })
  return nodes
}

// The remotes block is replaced whole: comments inside it can sit beside endpoints and credentials.
// Every anchor the block holds or reaches through aliases is replaced, and so is every alias of it.
// Text whose loaded remotes are not that block, or that does not parse and names remotes: one line.
export function projectRemotesInConfigText(raw: string): string {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) return NAMES_REMOTES.test(raw) ? UNSHOWABLE : raw
  try {
    const found = remotesBlock(doc)
    if (found === undefined) return loadedRemotes(doc) == null ? raw : UNSHOWABLE
    if (!loadsFromBlock(doc)) return UNSHOWABLE
    const { root, registry, remotes } = found

    const hidden = new Set<unknown>(nodesUnder(remotes))
    const reached: Node[] = []
    const pending = nodesUnder(remotes).filter(isAlias)
    for (let alias = pending.pop(); alias !== undefined; alias = pending.pop()) {
      const target = alias.resolve(doc)
      if (!isNode(target) || hidden.has(target)) continue
      const under = nodesUnder(target)
      if (target === root || under.includes(registry) || under.includes(remotes)) return UNSHOWABLE
      for (const node of under) hidden.add(node)
      reached.push(target)
      pending.push(...under.filter(isAlias))
    }

    const shown = shownRemotes(doc, remotes)
    const urls = entryUrls(doc, remotes)
    const replacements = new Map<unknown, unknown>([[remotes, shown]])
    for (const target of reached) {
      const index =
        isScalar(target) && typeof target.value === 'string' ? urls.indexOf(target.value) : -1
      const entry = shown[index] as { url?: unknown } | undefined
      replacements.set(target, index >= 0 && entry !== undefined ? entry.url : null)
    }
    // Each alias of a hidden node is resolved before any node is replaced, while its anchor exists.
    visit(doc, (_key, node) => {
      if (!isAlias(node)) return
      const target = node.resolve(doc)
      if (hidden.has(target)) replacements.set(node, replacements.get(target) ?? null)
    })

    visit(doc, (_key, node) =>
      replacements.has(node) ? doc.createNode(replacements.get(node)) : undefined,
    )
    registry.set('remotes', doc.createNode(shown))
    return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  } catch {
    return UNSHOWABLE
  }
}
