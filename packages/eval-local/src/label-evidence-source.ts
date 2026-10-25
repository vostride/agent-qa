import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { canonicalJson, deriveRunSlug, resolveProductPartition, type CommittedCorpusSnapshot, type GoldMark } from '@vostride/agent-qa-eval'
import { HANDOFF_FILE, RUNS_SUBDIR, loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import { guardCompletedRunHandoff, type CompletedRunHandoff } from '@vostride/agent-qa-schema'

export interface LoadLabelEvidenceInput {
  snapshot: CommittedCorpusSnapshot
  agentQaRoot: string
  incoming?: CompletedRunHandoff
}
export interface LabelEvidenceRead {
  handoffs: CompletedRunHandoff[]
  marks: GoldMark[]
  refusals: { runId: string; reason: 'invalid-run-link' | 'handoff-unavailable' | 'run-identity-mismatch'
    | 'product-mismatch' | 'path-outside-root' | 'conflicting-handoff' }[]
}

function contained(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

/** Load only positively linked runs. A slug locates bytes; the guarded run identity authorizes them. */
export function loadLabelEvidence(input: LoadLabelEvidenceInput): LabelEvidenceRead {
  const result: LabelEvidenceRead = { handoffs: [], marks: [], refusals: [] }
  const links = new Map<string, { slug: string; products: Set<string>; invalid: boolean }>()
  for (const entry of input.snapshot.entries) {
    const { runId, runSlug } = entry.run_links
    const link = links.get(runId) ?? { slug: runSlug, products: new Set<string>(), invalid: false }
    link.invalid ||= runSlug !== deriveRunSlug(runId) || link.slug !== runSlug
    link.products.add(entry.product); links.set(runId, link)
  }
  if (input.incoming && !links.has(input.incoming.runId)) {
    links.set(input.incoming.runId, { slug: deriveRunSlug(input.incoming.runId),
      products: new Set([resolveProductPartition(input.incoming.scope)]), invalid: false })
  }
  const loaded = new Map<string, CompletedRunHandoff>()
  const refused = new Set<string>()
  const refuse = (runId: string, reason: LabelEvidenceRead['refusals'][number]['reason']) => {
    result.refusals.push({ runId, reason }); refused.add(runId)
  }
  for (const [runId, link] of links) {
    if (link.invalid) { refuse(runId, 'invalid-run-link'); continue }
    const path = resolve(input.agentQaRoot, RUNS_SUBDIR, link.slug, HANDOFF_FILE)
    try {
      if (!contained(input.agentQaRoot, path)) { refuse(runId, 'path-outside-root'); continue }
      const handoff = loadCompletedRunHandoff(path)
      if (handoff.runId !== runId) { refuse(runId, 'run-identity-mismatch'); continue }
      if (link.products.size !== 1 || !link.products.has(resolveProductPartition(handoff.scope))) {
        refuse(runId, 'product-mismatch'); continue
      }
      loaded.set(runId, handoff)
    } catch { refuse(runId, 'handoff-unavailable') }
  }
  if (input.incoming) {
    const incoming = guardCompletedRunHandoff(input.incoming)
    const existing = loaded.get(incoming.runId)
    if (existing && canonicalJson(existing) !== canonicalJson(incoming)) {
      loaded.delete(incoming.runId); refuse(incoming.runId, 'conflicting-handoff')
    } else if (!refused.has(incoming.runId)) loaded.set(incoming.runId, incoming)
  }
  result.handoffs.push(...loaded.values())
  result.handoffs.sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
  return result
}
