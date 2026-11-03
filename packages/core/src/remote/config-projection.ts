import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
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

// The remotes block is replaced whole: comments inside it can sit beside endpoints and credentials.
// An anchor inside it, or one it aliases, is replaced wherever it appears, so no copy keeps them.
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

    const hidden = new Set<unknown>([remotes])
    visit(remotes, (_key, node) => {
      hidden.add(node)
    })
    // Each alias into the block is resolved before any node is replaced, while its anchor exists.
    const leaking = new Map<unknown, boolean>()
    visit(doc, (_key, node) => {
      if (!isAlias(node)) return
      const target = node.resolve(doc)
      if (hidden.has(target)) leaking.set(node, target === remotes)
    })

    const shown = shownRemotes(doc, remotes)
    visit(doc, (_key, node) => {
      if (node === remotes) return doc.createNode(shown)
      const wholeBlock = leaking.get(node)
      if (wholeBlock === undefined) return undefined
      return doc.createNode(wholeBlock ? shown : null)
    })
    registry.set('remotes', doc.createNode(shown))
    return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  } catch {
    return UNSHOWABLE
  }
}
