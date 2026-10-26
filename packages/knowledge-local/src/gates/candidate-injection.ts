// 2026-09-07, 417 D-01: READS ONLY. The candidate enters replay as brief DATA —
// one rendered line, never a prompt or code edit. ABSENCE IS A ROW; unreadable data throws.
import {
  asRecordId,
  KnowledgeCandidateInjectionResultSchema,
  survivingOutcomeEvents,
  type IndexEntry,
  type KnowledgeCandidateInjectionResult,
} from '@vostride/agent-qa-schema'
import { renderObservationLine } from '@vostride/agent-qa-runner'
import { deriveBundleTrust } from '../bundle-read.js'
import { enumerateMaintenanceBundleDirs, loadMaintenanceBundle } from '../maintenance-scan.js'
import { candidateProvenanceOf } from '../promotion-gate-input.js'
import { renderBriefLine } from '../serving/brief-render.js'

export interface CandidateInjectionForOptions {
  knowledgeRoot: string
  candidateId: string
}

export function candidateInjectionFor(
  options: CandidateInjectionForOptions,
): KnowledgeCandidateInjectionResult {
  const id = asRecordId(options.candidateId)
  for (const entry of enumerateMaintenanceBundleDirs(options.knowledgeRoot)) {
    const bundle = loadMaintenanceBundle(entry)
    if (bundle.manifest.id !== id) continue
    const frontmatter = bundle.frontmatter
    const trust = deriveBundleTrust(bundle)
    const stampedEntry = {
      id, kind: frontmatter.kind, title: bundle.summary, summary: bundle.summary,
      trust: trust.trust, status: trust.status,
      anchors: frontmatter.anchors.map(({ normalized }) => normalized),
      scope: frontmatter.scope,
      validity: trust.validity.closedAtOrdinal === undefined ? 'current'
        : `${trust.validity.openedAtOrdinal}:${trust.validity.closedAtOrdinal}`,
      servedAsCanary: false, originClass: frontmatter.originClass,
    } satisfies IndexEntry & { originClass: typeof frontmatter.originClass }
    // The serving renderer applies tierForEntry to this same origin-stamped input.
    const line = renderBriefLine(stampedEntry).briefLine
    const target = bundle.provenance.mode === 'run-linked' ? {
      runId: bundle.provenance.runId,
      stepIndex: bundle.provenance.stepIndex,
      testId: bundle.provenance.testId,
      ...(bundle.provenance.sourceBuildOrdinal === undefined ? {} : {
        sourceBuildOrdinal: bundle.provenance.sourceBuildOrdinal,
      }),
    } : undefined
    return KnowledgeCandidateInjectionResultSchema.parse({
      kind: 'found', injection: {
        candidateId: id, kind: frontmatter.kind, product: entry.product,
        scope: frontmatter.scope, anchors: frontmatter.anchors, status: trust.status,
        line, renderedLine: renderObservationLine(line),
        provenance: candidateProvenanceOf(entry.dir, bundle),
        ...(target === undefined ? {} : { target }),
        latestOrdinal: Math.max(frontmatter.createdAtOrdinal,
          ...survivingOutcomeEvents(bundle.events).map(event => event.buildOrdinal)),
      },
    })
  }
  return KnowledgeCandidateInjectionResultSchema.parse({
    kind: 'not-found', recordId: options.candidateId,
  })
}
