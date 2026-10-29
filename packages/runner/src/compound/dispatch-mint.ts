// Pure runner-mint builders for the platform-less termination verbs (Phase 360 · EXEC-05/EXEC-06 ·
// D-01/D-16 · spec §9.1/§12.10).
//
// CRITICAL: provider-neutral + storage-neutral. No driver imports, no node:* imports, no ports,
// no loop/index import — pure functions only, so the Plan 10 dispatch seam composes them at the
// ONE chokepoint (357 law) without import cycles. `reportValue` and `uniqueValue` are minted here
// (never adapter.execute): the seam calls these builders to produce the success ActionResult with
// the typed metadata block, exactly like the 359 idempotentNoop mint.
//
// MINT_VERBS is the closed set of runner-minted verb names. assertAI/extractAI/assertValue are
// seam-ORCHESTRATED (judge lane / adapter-read + comparator), NOT simple mints — they are excluded
// here and handled by Plans 09/10; the catalog roll-call (Plan 02) walks this set for the
// dispatch-totality proof.

import type { ActionResult } from '../platform.js'

/** The closed set of runner-minted (platform-less) verb names dispatched without adapter.execute. */
export const MINT_VERBS = ['reportValue', 'uniqueValue'] as const

export type MintVerb = (typeof MINT_VERBS)[number]

/** Emission params for a `reportValue` mint (mirrors reportValueSchema). */
export interface ReportValueInput {
  value: string
}

/**
 * Mint the D-01/D-03 `reportValue` success result. The answer rides `metadata.reportedValue`
 * (readReportedValueMeta narrows it). NOTE: `value` here is the emission value — the Plan 10 seam
 * masks before recording into StepEvidence.reportedValue (masked-before-record, T-360-01).
 */
export function mintReportedValue(input: ReportValueInput): ActionResult {
  return { success: true, metadata: { reportedValue: { value: input.value } } }
}

/** Emission params for a `uniqueValue` mint (mirrors uniqueValueSchema). */
export interface UniqueValueInput {
  prefix: string
}

/**
 * The injectable suffix generator (353 K=2 determinism, D-16): a pure `() => string` overridden in
 * tests for deterministic output, defaulting to {@link defaultUniqueValueGenerator}.
 */
export type UniqueValueGenerator = () => string

/**
 * Mint the D-16 `uniqueValue` success result: `prefix` + a generated suffix, carried on
 * `metadata.uniqueValue` ({ value, prefix }). The generator is injectable for deterministic tests;
 * uniqueness is the semantic, so cache replay re-mints fresh. The Plan 10 seam auto-writes the
 * minted value into run-scoped working memory keyed by the prefix.
 */
export function mintUniqueValue(
  input: UniqueValueInput,
  generator: UniqueValueGenerator = defaultUniqueValueGenerator,
): ActionResult {
  const value = `${input.prefix}${generator()}`
  return { success: true, metadata: { uniqueValue: { value, prefix: input.prefix } } }
}

/**
 * Default suffix source: timestamp + entropy, base36-encoded, non-empty and distinct across
 * calls. Injectable so deterministic tests pass a fixed generator instead. Randomness/time IS the
 * semantic here (uniqueness), unlike the deterministic app-resolution ladder.
 */
export function defaultUniqueValueGenerator(): string {
  const timestamp = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 10)
  return `${timestamp}${entropy}`
}
