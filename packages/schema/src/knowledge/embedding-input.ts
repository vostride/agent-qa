import type { Anchor } from '../identity/anchor'
import { normalizeAnchor } from '../identity/normalize-anchor'

function normalizedAnchorText(anchor: Anchor): string {
  const normalized = normalizeAnchor(anchor)
  switch (normalized.t) {
    case 'page':
      return normalized.route
    case 'flow':
      return normalized.name
    case 'el':
      return [normalized.role, normalized.name, normalized.ordinal]
        .filter((part) => part !== undefined)
        .join(':')
    case 'platform':
      return normalized.platform
    case 'selector':
      return normalized.literal
    case 'error':
      return normalized.message
  }
}

/**
 * PROVISIONAL Phase 374 rendering. Phase 376's embedding bench may refine this function, while
 * each manifest preserves the exact publish-time bytes for deterministic index rebuilds.
 */
export function renderEmbeddingInput(input: {
  summary: string
  body: string
  anchors: readonly Anchor[]
}): string {
  return [
    input.summary,
    '',
    input.body,
    '',
    ...input.anchors.map(
      (anchor) => `anchor: ${anchor.t}:${normalizedAnchorText(anchor)}`,
    ),
  ].join('\n')
}

/** one replay-consumable canonical JSON document per pre-action screen state. */
export function screenStateSnapshotRelPath(stepIndex: number): string {
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new RangeError('screen-state stepIndex must be a non-negative integer')
  }
  return `evidence/screenstates/step-${stepIndex}.json`
}
