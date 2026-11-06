import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, visit } from 'yaml'
import type { Document, Node, YAMLMap } from 'yaml'
import { projectConfigRemotes } from '@vostride/agent-qa-schema'

const MARK_KEY = 'agent-qa-mark'

interface ShownBlock {
  readonly path: readonly [string, ...string[]]
  readonly unshowable: string
  readonly named: RegExp
  shown(doc: Document, block: Node): unknown
  // What an anchor the block reaches outside itself shows as.
  reached(doc: Document, block: Node, shown: unknown, target: Node): unknown
}

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

const REMOTES: ShownBlock = {
  path: ['registry', 'remotes'],
  unshowable: '# This config cannot be shown without its remote endpoints.\n',
  named: /(?<![\w-])remotes(?![\w-])/,
  shown: shownRemotes,
  reached(doc, remotes, shown, target) {
    const urls = entryUrls(doc, remotes)
    const index =
      isScalar(target) && typeof target.value === 'string' ? urls.indexOf(target.value) : -1
    const entry = (shown as unknown[])[index] as { url?: unknown } | undefined
    return index >= 0 && entry !== undefined ? entry.url : null
  },
}

const PLUGINS: ShownBlock = {
  path: ['plugins'],
  unshowable: '# This config cannot be shown without its plugin options.\n',
  named: /(?<![\w-])plugins(?![\w-])/,
  shown(doc, plugins) {
    try {
      return projectConfigRemotes({ plugins: plugins.toJS(doc) as unknown }).plugins
    } catch {
      return []
    }
  },
  reached: () => null,
}

interface FoundBlock {
  readonly root: YAMLMap
  // Every map on the path from the root, the block's own parent last.
  readonly maps: readonly YAMLMap[]
  readonly block: Node
}

function blockAt(doc: Document, path: ShownBlock['path']): FoundBlock | undefined {
  const root = resolved(doc, doc.contents)
  if (!isMap(root)) return undefined
  const maps: YAMLMap[] = [root]
  for (const key of path.slice(0, -1)) {
    const next = resolved(doc, maps[maps.length - 1]!.get(key, true))
    if (!isMap(next)) return undefined
    maps.push(next)
  }
  const block = resolved(doc, maps[maps.length - 1]!.get(path[path.length - 1], true))
  if (!isNode(block) || (isScalar(block) && block.value === null)) return undefined
  return { root, maps, block }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// What the config loader reads: yaml's parse is parseDocument followed by toJS.
function loadedAt(doc: Document, path: ShownBlock['path']): unknown {
  let loaded: unknown = doc.toJS()
  for (const key of path) {
    if (!isRecord(loaded)) return undefined
    loaded = loaded[key]
  }
  return loaded
}

// The marker goes inside the block, not in its place, so every anchor in the block still resolves.
function loadsFromBlock(doc: Document, path: ShownBlock['path']): boolean {
  const copy = doc.clone()
  const found = blockAt(copy, path)
  if (found === undefined) return false
  const mark = {}
  const { block } = found
  if (isSeq(block)) {
    block.add(new Scalar(mark))
    const loaded = loadedAt(copy, path)
    return Array.isArray(loaded) && loaded[loaded.length - 1] === mark
  }
  if (isMap(block)) {
    // A merge converts the map it copies again, so a second conversion means a merge reached it.
    let conversions = 0
    block.set(MARK_KEY, {
      toJSON: () => {
        conversions += 1
        return mark
      },
    })
    const loaded = loadedAt(copy, path)
    return conversions === 1 && isRecord(loaded) && loaded[MARK_KEY] === mark
  }
  if (!isScalar(block)) return false
  const marker = new Scalar(mark)
  marker.anchor = block.anchor
  found.maps[found.maps.length - 1]!.set(path[path.length - 1], marker)
  return loadedAt(copy, path) === mark
}

function nodesUnder(node: Node): unknown[] {
  const nodes: unknown[] = []
  visit(node, (_key, child) => {
    nodes.push(child)
  })
  return nodes
}

// The block is replaced whole: comments inside it can sit beside endpoints and credentials.
// Every anchor the block holds or reaches through aliases is replaced, and so is every alias of it.
// Text whose block may not be that block, or that does not parse and names it: one line.
function projectBlockInText(raw: string, shape: ShownBlock): string {
  // yaml's warnings quote the file's text, so only its errors are reported.
  const doc = parseDocument(raw, { logLevel: 'error' })
  if (doc.errors.length > 0) return shape.named.test(raw) ? shape.unshowable : raw
  try {
    const found = blockAt(doc, shape.path)
    if (found === undefined) return loadedAt(doc, shape.path) == null ? raw : shape.unshowable
    if (!loadsFromBlock(doc, shape.path)) return shape.unshowable
    const { root, maps, block } = found

    const hidden = new Set<unknown>(nodesUnder(block))
    const reached: Node[] = []
    const pending = nodesUnder(block).filter(isAlias)
    for (let alias = pending.pop(); alias !== undefined; alias = pending.pop()) {
      const target = alias.resolve(doc)
      if (!isNode(target) || hidden.has(target)) continue
      const under = nodesUnder(target)
      if (
        target === root ||
        maps.some((map) => map !== root && under.includes(map)) ||
        under.includes(block)
      ) {
        return shape.unshowable
      }
      for (const node of under) hidden.add(node)
      reached.push(target)
      pending.push(...under.filter(isAlias))
    }

    const shown = shape.shown(doc, block)
    const replacements = new Map<unknown, unknown>([[block, shown]])
    for (const target of reached) {
      replacements.set(target, shape.reached(doc, block, shown, target))
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
    maps[maps.length - 1]!.set(shape.path[shape.path.length - 1], doc.createNode(shown))
    return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  } catch {
    return shape.unshowable
  }
}

// A served config's text shows remotes by name and protocol or plugins entry, and plugins entries
// by name and package or path; endpoints, credentials and plugin options stay in the file.
export function projectRemotesInConfigText(raw: string): string {
  const withoutRemotes = projectBlockInText(raw, REMOTES)
  if (withoutRemotes === REMOTES.unshowable) return withoutRemotes
  return projectBlockInText(withoutRemotes, PLUGINS)
}
