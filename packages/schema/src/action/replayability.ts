// One shared list: the cache write guard, extraction and procedure replay all read it.

// `setVariable` reads env, AI judgments are never persisted, `tapCoordinate` is coordinate-driven.
export const NON_REPLAYABLE_ACTION_TYPES: readonly string[] = [
  'setVariable',
  'assertAI',
  'extractAI',
  'tapCoordinate',
]

// A raw-coordinate binding cannot be re-grounded against a fresh observation.
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
