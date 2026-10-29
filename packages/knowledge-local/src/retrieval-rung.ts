// The host's ladder at serve time, folded once so the banner and the doctor row agree.
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

// `schema-version` and `corrupt` share a cause; no current fold mints `index-unavailable`.
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

// The index axis comes first: a `scan` face is `bundle-scan` even with a live native embedder.
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
  probes?: EmbedderProbes
}

// Never throws, downloads or writes: a probe that fetched a model would change its own answer.
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
