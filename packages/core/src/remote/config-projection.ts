import { isSeq, parseDocument, stringify } from 'yaml'
import { projectConfigRemotes } from '@vostride/agent-qa-schema'

const REMOTES_PATH = ['registry', 'remotes']

// The remotes block is replaced whole: comments inside it can sit beside endpoints and credentials.
export function projectRemotesInConfigText(raw: string): string {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) return raw
  if (!isSeq(doc.getIn(REMOTES_PATH, true))) return raw
  const json = doc.toJS() as Record<string, unknown> | null
  const projected = projectConfigRemotes(json)
  const remotes = (projected?.registry as Record<string, unknown> | undefined)?.remotes
  try {
    doc.setIn(REMOTES_PATH, remotes)
    return doc.toString({ lineWidth: 0 })
  } catch {
    return stringify(projected, { lineWidth: 0 })
  }
}
