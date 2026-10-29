// Recorded per event; stagnation and cycle blocks appear only at a terminal fail.

// A missing per-verb signal degrades the row to the `hash-fallback` oracle.
export interface LocalEffectEvidence {
  /** The verb class the oracle row keyed on (e.g. 'fill', 'scroll', 'tap'). */
  verbClass: string
  /** Which oracle row produced the achieved/absent verdict. */
  oracle: 'fill-reread' | 'scroll' | 'checkable-state' | 'navigation' | 'hash-fallback'
  /** True ⇒ local effect achieved ⇒ progress (never flagged); false ⇒ absent. */
  achieved: boolean
}

// Anything the classifier cannot place counts toward the `unresponsive` track.
export type StagnationClass =
  | 'transient-load'
  | 'obstruction'
  | 'off-screen'
  | 'input-didnt-land'
  | 'unresponsive'

// Keyed on the element anchor, never description text; counts reset on any confirmed local effect.
export interface StagnationEvidence {
  /** The element anchor key whose ladder terminated. */
  anchorKey: string
  /** Per-class no-effect increment counts at fail time. */
  counts: Array<{ class: StagnationClass; count: number }>
  /** Total no-effect increments for the anchor (≤ the per-anchor bound). */
  total: number
}

// Flagged only on state revisitation with no task progress, never on repeated actions alone.
export interface CycleEvidence {
  /** The revisitation key (settle hash + url/route or activity/screen id) that recurred. */
  revisitedKey: string
  /** The W-window summary the cycle-break turn was shown. */
  windowSummary: string[]
  /** Why the cycle was flagged (the terminal reason). */
  reason: string
}
