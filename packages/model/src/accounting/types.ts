// Shared type surface for the BYOM token-accounting + degrade substrate.
// The whole substrate operates exclusively on AI SDK `ModelMessage[]`: message
// types are imported from `'ai'` only, never `@ai-sdk/*`. Types-only module: interfaces
// and type aliases only, no runtime value export.

import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { ModelCapabilities } from '@vostride/agent-qa-schema'

/**
 * Caller-supplied degrade controls. Policy-free: no default/safety margin is
 * baked here — Phase 355 supplies the concrete budget and pin predicate.
 *
 * - `budget` — the token ceiling the degraded prompt must fit under.
 * - `pin` — a caller pin predicate; a message matching it is never evicted or truncated.
 *   The substrate stays tier-ignorant (355 pins its tiers explicitly).
 * - `estimate` — the estimator the damage loop re-runs after each eviction. Optional so
 *   `degrade` stays a standalone-testable pure function; the Plan-03 factory passes its own.
 */
export interface DegradeOptions {
  budget: number
  pin?: (message: ModelMessage, index: number) => boolean
  estimate?: (messages: ModelMessage[]) => number
}

/**
 * Discriminated degrade result. `ok:true` carries the fitted messages; `ok:false`
 * is the structured cannot-fit outcome returned when system + final + pinned content alone
 * exceeds the budget — degrade never throws and never violates a pin, returning the
 * best-effort hygiene-reduced messages instead.
 */
export type DegradeOutcome =
  | { ok: true; messages: ModelMessage[] }
  | { ok: false; reason: 'pinned-content-exceeds-budget'; messages: ModelMessage[] }

/**
 * The instance shape returned by the Plan-03 factory and consumed through the runner's
 * provider-neutral port. Prompt tokens only; the substrate is policy-free.
 */
export interface TokenAccounting {
  estimate(messages: ModelMessage[]): number
  recordUsage(usage: LanguageModelUsage, messages: ModelMessage[]): void
  getCeilings(): { contextWindow: number; maxOutput: number }
  degrade(messages: ModelMessage[], options: DegradeOptions): DegradeOutcome
}

/**
 * Factory construction options (Plan 03).
 *
 * - `getCapabilities` — the D-04 lazy ceilings thunk (composes v46 `resolveCapabilities`),
 *   read on every estimate/degrade so a mid-run overflow-learned window shrink applies next turn.
 * - `perImageTokens` — the D-12 injectable flat per-image constant (test/chat-layer tuning).
 */
export interface TokenAccountingOptions {
  getCapabilities: () => ModelCapabilities
  perImageTokens?: number
}
