/** Why a bound element could not be acted on. */
export type BindingOutcome =
  | 'stale-observation'
  | 'frame-detached'
  | 'binding-lost'
  | 'binding-changed'

// The element observed under `ref` differs from the one on the page, so nothing was sent.
export interface BindingOutcomeMeta {
  outcome: BindingOutcome
  ref: string
  inputSent: false
  heal?: 'absent' | 'not-unique'
}

export const BINDING_OUTCOME_KEYS = ['outcome', 'ref', 'inputSent', 'heal'] as const

const OUTCOMES: ReadonlySet<unknown> = new Set([
  'stale-observation',
  'frame-detached',
  'binding-lost',
  'binding-changed',
])
const HEALS: ReadonlySet<unknown> = new Set(['absent', 'not-unique'])

// Narrows field by field; a hand-edited or partial block reads as undefined.
export function readBindingOutcomeMeta(
  result?: { metadata?: Record<string, unknown> },
): BindingOutcomeMeta | undefined {
  const raw = result?.metadata?.['binding']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { outcome, ref, inputSent, heal } = raw as Record<string, unknown>
  if (!OUTCOMES.has(outcome) || typeof ref !== 'string' || inputSent !== false) return undefined
  if (heal !== undefined && !HEALS.has(heal)) return undefined
  return {
    outcome: outcome as BindingOutcome,
    ref,
    inputSent,
    ...(heal !== undefined ? { heal: heal as NonNullable<BindingOutcomeMeta['heal']> } : {}),
  }
}
