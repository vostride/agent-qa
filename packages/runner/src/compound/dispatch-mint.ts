// Pure builders, so the dispatch seam composes them without import cycles; never adapter.execute.

import type { ActionResult } from '../platform.js'

/** The closed set of runner-minted (platform-less) verb names dispatched without adapter.execute. */
export const MINT_VERBS = ['reportValue', 'uniqueValue'] as const

export type MintVerb = (typeof MINT_VERBS)[number]

/** Emission params for a `reportValue` mint (mirrors reportValueSchema). */
export interface ReportValueInput {
  value: string
}

// `value` is the emission value; the dispatch seam masks it before recording.
export function mintReportedValue(input: ReportValueInput): ActionResult {
  return { success: true, metadata: { reportedValue: { value: input.value } } }
}

/** Emission params for a `uniqueValue` mint (mirrors uniqueValueSchema). */
export interface UniqueValueInput {
  prefix: string
}

// Overridden in tests for deterministic output; defaults to `defaultUniqueValueGenerator`.
export type UniqueValueGenerator = () => string

// Uniqueness is the point, so cache replay mints a fresh value.
export function mintUniqueValue(
  input: UniqueValueInput,
  generator: UniqueValueGenerator = defaultUniqueValueGenerator,
): ActionResult {
  const value = `${input.prefix}${generator()}`
  return { success: true, metadata: { uniqueValue: { value, prefix: input.prefix } } }
}

// Time and entropy are the point here, unlike the deterministic app-resolution ladder.
export function defaultUniqueValueGenerator(): string {
  const timestamp = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 10)
  return `${timestamp}${entropy}`
}
