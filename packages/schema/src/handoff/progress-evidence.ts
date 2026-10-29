/**
 * The §A8 progress-evidence vocabulary (Phase 358, D-07; spec `tools-and-actions.md`
 * §12.16, reconciled into `eval-and-core-types.md` §A8 with the dated 2026-07-06 note).
 * Follows 357's evidence-by-construction precedent: these blocks are recorded at the
 * machinery, impossible to skip, redaction-before-record preserved.
 *
 * Event-scoped, never per-iteration: `LocalEffectEvidence` rides a sub-action's
 * differential-observation oracle result; `StagnationEvidence`/`CycleEvidence` are
 * terminal blocks present only at a step's terminal fail (the stagnation tree at fail)
 * and the cycle flag respectively.
 *
 * Pure type-only DTOs: no runtime code, no host APIs (schema ownership contract).
 */

/**
 * The §12.16(a) per-sub-action differential-observation oracle outcome:
 * which oracle row evaluated the action's local intended effect, and whether it was
 * achieved. A missing per-verb signal degrades the row to the `hash-fallback` oracle.
 */
export interface LocalEffectEvidence {
  /** The verb class the oracle row keyed on (e.g. 'fill', 'scroll', 'tap'). */
  verbClass: string
  /** Which oracle row produced the achieved/absent verdict. */
  oracle: 'fill-reread' | 'scroll' | 'checkable-state' | 'navigation' | 'hash-fallback'
  /** True ⇒ local effect achieved ⇒ progress (never flagged); false ⇒ absent. */
  achieved: boolean
}

/**
 * The five identity-keyed stagnation ladder classes. Anything the
 * deterministic classifier cannot place increments the `unresponsive` track.
 */
export type StagnationClass =
  | 'transient-load'
  | 'obstruction'
  | 'off-screen'
  | 'input-didnt-land'
  | 'unresponsive'

/**
 * The per-element bounded stagnation tree state captured at a terminal `stepFailed`
 * Keyed on the element anchor (`role + nameNormalized + ordinal`),
 * never description text. Counts reset on any confirmed local effect for the anchor —
 * these are bounded, identity-keyed, reset-on-progress counters, NOT a blanket step
 * counter (LOOP-02 law).
 */
export interface StagnationEvidence {
  /** The element anchor key whose ladder terminated. */
  anchorKey: string
  /** Per-class no-effect increment counts at fail time. */
  counts: Array<{ class: StagnationClass; count: number }>
  /** Total no-effect increments for the anchor (≤ the per-anchor bound). */
  total: number
}

/**
 * The cycle-flag terminal block. Present only when a true cycle is
 * flagged — state revisitation AND no task progress across the W=5 window, never on
 * action repetition alone.
 */
export interface CycleEvidence {
  /** The revisitation key (settle hash + url/route or activity/screen id) that recurred. */
  revisitedKey: string
  /** The W-window summary the cycle-break turn was shown. */
  windowSummary: string[]
  /** Why the cycle was flagged (the terminal reason). */
  reason: string
}
