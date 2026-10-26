import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  canonicalJson,
  guardDistilledObservation,
  isPromotionReceipt,
  survivingOutcomeEvents,
  supersessionKey,
} from '@vostride/agent-qa-schema'
import type { GateReceipt, PromotionCandidateProvenance, PromotionGateInput } from '@vostride/agent-qa-schema'

import { deriveBundleTrust, readGateReceipts } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import { scanCanonicalBundles } from './lineage-fold.js'

function promotionObservations(
  bundleDir: string,
): PromotionGateInput['distilledObservations'] {
  const file = join(bundleDir, 'observations.jsonl')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (text === '') return []
  if (!text.endsWith('\n')) {
    throw new SyntaxError('observations.jsonl must end with a newline')
  }
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => guardDistilledObservation(JSON.parse(line)))
}

function memoryOffForBundle(
  knowledgeRoot: string,
  bundle: LoadedBundle,
): boolean {
  const anchors = bundle.frontmatter.anchors.map(({ normalized }) => normalized)
  const markerPrefix = `thrash:${supersessionKey(anchors)}:window:`
  const scope = canonicalJson(bundle.frontmatter.scope)
  // The lineage scan exposes status and identity only; this memory-off check never reads trust.
  return scanCanonicalBundles(knowledgeRoot).some((candidate) =>
    candidate.kind === 'unknown'
    && candidate.status !== 'deprecated'
    && candidate.status !== 'superseded'
    && canonicalJson(candidate.scope) === scope
    && candidate.anchors[0]?.t === 'flow'
    && candidate.anchors[0].name.startsWith(markerPrefix),
  )
}

/**
 * One durable evidence assembly for both admission and later promote().
 * The pure schema gate remains the only verdict authority; this storage-side view
 * performs strict loading and folds current canonical truth without index authority.
 */
export function assemblePromotionGateInput(input: {
  knowledgeRoot: string
  bundleDir: string
  bundle: LoadedBundle
}): PromotionGateInput {
  const trust = deriveBundleTrust(input.bundle)
  const survivingEvents = survivingOutcomeEvents(input.bundle.events)
  const runLinkedProvenance = input.bundle.provenance.mode === 'run-linked'
    ? input.bundle.provenance
    : undefined
  const gateLines = readGateReceipts(input.bundleDir, input.bundle.manifest.id) ?? []
  return {
    gateReceipts: gateLines.filter((line): line is GateReceipt => !isPromotionReceipt(line)),
    kind: input.bundle.frontmatter.kind,
    ...(input.bundle.frontmatter.subtype === undefined
      ? {}
      : { subtype: input.bundle.frontmatter.subtype }),
    status: trust.status,
    validityOpen: trust.validity.closedAtOrdinal === undefined,
    anchors: input.bundle.frontmatter.anchors.map(({ normalized }) => normalized),
    originClass: input.bundle.frontmatter.originClass,
    withheld: runLinkedProvenance?.withheld === true,
    needsEnrichment: runLinkedProvenance?.needsEnrichment === true,
    evidenceIncomplete: input.bundle.manifest.evidenceIncomplete,
    distilledObservations: promotionObservations(input.bundleDir),
    confirmedOutcomeEvidenceTokens: survivingEvents.flatMap((event) =>
      event.type === 'confirmed' ? [event.evidenceToken] : [],
    ),
    // The current lifecycle event shape does not carry Deprecate origin. Treating
    // any surviving deprecation as sovereign is the fail-closed interpretation;
    // a retracted deprecation is removed above before this evidence is assembled.
    hasUserDeprecateInLineage: survivingEvents.some((event) => event.type === 'deprecated'),
    memoryOffForAnchorGroup: memoryOffForBundle(input.knowledgeRoot, input.bundle),
  }
}

/** The provenance the candidate read reports for a bundle. */
export function candidateProvenanceOf(
  bundleDir: string,
  bundle: LoadedBundle,
): PromotionCandidateProvenance {
  const runLinked = bundle.provenance.mode === 'run-linked' ? bundle.provenance : undefined
  const gateLines = readGateReceipts(bundleDir, bundle.manifest.id) ?? []
  return {
    runIds: runLinked === undefined ? [] : [runLinked.runId],
    receiptDigests: gateLines.map(line => line.receiptDigest),
    capturedAtOrdinals: [...new Set([
      ...(runLinked?.sourceBuildOrdinal === undefined ? [] : [runLinked.sourceBuildOrdinal]),
      ...survivingOutcomeEvents(bundle.events).map(event => event.buildOrdinal),
    ].filter(Number.isInteger))].sort((left, right) => left - right),
  }
}
