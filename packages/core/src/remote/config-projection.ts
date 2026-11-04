import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { Document, Node } from 'yaml'
import { projectConfigRemotes } from '@vostride/agent-qa-schema'

const UNSHOWABLE = '# This config cannot be shown without its remote endpoints.\n'

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

function nodesUnder(node: Node): unknown[] {
  const nodes: unknown[] = []
  visit(node, (_key, child) => {
    nodes.push(child)
  })
  return nodes
}

// The remotes block is replaced whole: comments inside it can sit beside endpoints and credentials.
// Every anchor the block holds or reaches through aliases is replaced, and so is every alias of it.
export function projectRemotesInConfigText(raw: string): string {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) return raw
  try {
    const root = resolved(doc, doc.contents)
    if (!isMap(root)) return raw
    const registry = resolved(doc, root.get('registry', true))
    if (!isMap(registry)) return raw
    const remotes = resolved(doc, registry.get('remotes', true))
    if (!isNode(remotes) || (isScalar(remotes) && remotes.value === null)) return raw

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
