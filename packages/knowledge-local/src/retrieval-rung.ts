/**
 * The ONE fold from the host's two retrieval axes to the recorded rung.
 *
 * ONE resolver, three callers: the runner's evidence recorder stamps the value into
 * `StepEvidence.retrievalRung`, `doctor` grades it live, and the run header banner
 * renders the recorded copy. Three callers deriving a rung independently from the same
 * two axes is exactly how a banner and a doctor row come to disagree about one machine, so the
 * fold table lives here once and its cells are pinned by `__tests__/retrieval-rung.test.ts`.
 *
 * WHAT THE VALUE MEANS. It is the HOST's ladder at serve time — never a claim about how any
 * individual brief line was ranked. The run-brief serve path reads index rows directly and
 * attributes channels 1 and 3 to the `anchor` leg by construction; the dense leg and the
 * bundle-scan fallback belong to the general `retrieve()` path the curator, the entity resolver
 * and the authoring reader use. A surface renders "retrieval was on rung X for this run".
 *
 * This module lives in knowledge-local because it is the only package that can see either axis:
 * the index face is `index-reader`'s degrade ladder and the embedder outcome is
 * `embedder-acquire`'s capability probe. What it hands back is the schema-owned value.
 */
import {
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type RecordedRetrievalRung,
  type RetrievalRungReason,
} from '@vostride/agent-qa-schema'

import {
  resolveEmbedderCapability,
  type AcquireEmbedderOutcome,
  type DeferReason,
  type EmbedderProbes,
} from './embedder-acquire.js'
import { classifyIndexFace, type IndexFace } from './index-reader.js'
import type { RebuildReason } from './rebuild-marker.js'

/** The index half of the fold — `index-reader`'s degrade ladder, read without side effects. */
export type IndexAxis = IndexFace

/** The embedder half of the fold — `embedder-acquire`'s capability outcome, unchanged. */
export type EmbedderAxis = AcquireEmbedderOutcome

/**
 * `RebuildReason` → the recorded cause, as a total map for the same reason as below.
 *
 * `schema-version` and `corrupt` share one cause: both mean "rebuild requested" and the operator
 * does the same thing for either. `index-unavailable` is deliberately NOT a value here — it is the
 * historical word for a scan whose cause was never recorded, and no current fold may mint it.
 */
const INDEX_REASONS: Record<RebuildReason, RetrievalRungReason> = {
  absent: 'index-not-built',
  locked: 'index-locked',
  corrupt: 'index-corrupt',
  'schema-version': 'index-corrupt',
}

/**
 * `DeferReason` → the recorded reason word, as a total map rather than a switch with a default.
 * A new `DeferReason` arm becomes a compile error here instead of silently folding to a wrong
 * word that a banner would then print to a person.
 */
const DEFERRED_REASONS: Record<DeferReason, RetrievalRungReason> = {
  'cold-artifact': 'model-not-downloaded',
  'load-failure': 'embedder-load-failed',
  'worker-unavailable': 'profile-unresolved',
}

/**
 * Fold the two axes into the value that gets recorded.
 *
 * ORDERING IS PART OF THE CONTRACT: the index axis is consulted FIRST. No dense leg can run
 * against an index that will not open, whatever the embedder resolved to, so a `scan` face is
 * `bundle-scan` even on a host with a live native embedder. Folding the embedder first would
 * label a host with an unopenable index `memidex` and make the banner lie.
 *
 * `reason` is ABSENT for `memidex` — the top rung is not a degradation and has no cause to name.
 * Every lower rung carries one, which is what lets the banner say rung AND cause in one line.
 */
export function foldRetrievalRung(
  index: IndexAxis,
  embedder: EmbedderAxis,
  preferredProfile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE,
): RecordedRetrievalRung {
  if (index.source === 'scan') {
    return { schemaVersion: 2, rung: 'bundle-scan', reason: INDEX_REASONS[index.reason] }
  }

  if (embedder.kind === 'ready') {
    if (embedder.rung === 'native') {
      return { schemaVersion: 2, rung: 'memidex' }
    }
    // Same rung, two different truths. A static PREFERRED profile means the floor is serving
    // because it was asked for; anything else means the native runtime could not load. An
    // operator reading `native-runtime-unavailable` on a deliberately-static host would go
    // hunting for a fault that does not exist.
    return {
      schemaVersion: 2,
      rung: 'static-floor',
      reason:
        preferredProfile.backend === 'static'
          ? 'profile-static-configured'
          : 'native-runtime-unavailable',
    }
  }

  if (embedder.kind === 'deferred') {
    return { schemaVersion: 2, rung: 'lexical-only', reason: DEFERRED_REASONS[embedder.reason] }
  }

  return { schemaVersion: 2, rung: 'lexical-only', reason: 'floor-disabled' }
}

export interface ResolveRetrievalRungOptions {
  knowledgeRoot: string
  /** Explicit hosted runtime root for worker discovery; defaults to the acquirer's own rule. */
  agentQaRoot?: string
  preferredProfile?: EmbeddingProfile
  /** D-12/D-17 test seam, passed through unchanged. Production callers omit it. */
  probes?: EmbedderProbes
}

/**
 * Probe both axes and fold them. NEVER throws, NEVER downloads, NEVER writes.
 *
 * - `allowDownload: false` is hard-coded, not an option: this call answers "what is this host
 *   doing today", and a probe that fetched a model would change the answer by asking it.
 * - A `scan` face short-circuits before the embedder is touched at all. The fold does not need the
 *   embedder axis in that arm, and the probe can cost a model load.
 * - A rejected capability probe folds to `deferred/load-failure` rather than propagating. This
 *   resolver's callers are a banner, a doctor row and an evidence recorder; none of them has a
 *   sensible behaviour for "asking about the ladder threw".
 * - `classifyIndexFace` writes no rebuild marker, so asking is not a mutation of the knowledge root.
 *
 * The memo inside `resolveEmbedderCapability` is what makes a second call in the same process free,
 * which is why `doctor` and the runner can both ask without paying twice.
 */
export async function resolveRetrievalRung(
  options: ResolveRetrievalRungOptions,
): Promise<RecordedRetrievalRung> {
  const preferredProfile = options.preferredProfile ?? DEFAULT_EMBEDDING_PROFILE
  const index = classifyIndexFace(options.knowledgeRoot)
  if (index.source === 'scan') {
    return foldRetrievalRung(index, { kind: 'lexical-only' }, preferredProfile)
  }

  let embedder: EmbedderAxis
  try {
    embedder = await resolveEmbedderCapability({
      preferredProfile,
      allowDownload: false,
      agentQaRoot: options.agentQaRoot,
      probes: options.probes,
    })
  } catch {
    embedder = { kind: 'deferred', reason: 'load-failure' }
  }

  return foldRetrievalRung(index, embedder, preferredProfile)
}
