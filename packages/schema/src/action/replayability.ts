// Pitfall 6: the ONE shared non-replayable action-class list. The runner's cache write guard,
// the extraction disposition, and procedure replay all consume THIS list —
// it must never fork. Mirrors the runner's current exclusion lists member-for-member
// (loop/index.ts COORDINATE_KEYS / COORDINATE_ACTION_TYPES + the setVariable/assertAI/extractAI
// cache no-op guards); consumers swap their local copies for these in later plans.

/**
 * Action types that are never replayable: `setVariable` (env provenance), `assertAI`/`extractAI`
 * (AI-judgment plans are never persisted, D-08), and `tapCoordinate` (inherently
 * coordinate-driven even after raw coordinates are sanitized out).
 */
export const NON_REPLAYABLE_ACTION_TYPES: readonly string[] = [
  'setVariable',
  'assertAI',
  'extractAI',
  'tapCoordinate',
]

/**
 * Raw-coordinate keys whose presence makes an action shape non-replayable (Pitfall 5b): a
 * coordinate binding cannot be re-grounded against a fresh observation.
 */
export const COORDINATE_ACTION_KEYS: readonly string[] = [
  'x',
  'y',
  'coordinates',
  'coords',
  'startX',
  'startY',
  'endX',
  'endY',
]

/**
 * Pure shape predicate: an action is replayable iff its type is outside
 * {@link NON_REPLAYABLE_ACTION_TYPES} AND none of its keys is a raw-coordinate key.
 */
export function isReplayableActionShape(type: string, keys: Iterable<string>): boolean {
  if (NON_REPLAYABLE_ACTION_TYPES.includes(type)) return false
  for (const key of keys) {
    if (COORDINATE_ACTION_KEYS.includes(key)) return false
  }
  return true
}
