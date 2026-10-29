// The budget arithmetic touches no terminal, so it sits beside the reader binding it sizes.

import type { ModelCapabilities } from '@vostride/agent-qa-schema'

/** Provisional share of usable model context reserved for the frozen Channel-1 brief. */
export const BRIEF_FRACTION = 0.05

/** Provisional share of usable model context reserved for one-shot Channel-3 cautions. */
export const CAUTION_FRACTION = 0.01

/** Provisional non-zero Channel-1 floor; field evidence may tune it in a later milestone. */
export const MIN_BRIEF = 256

/** Provisional non-zero Channel-3 floor sized to preserve at least one concise caution line. */
export const MIN_CAUTION = 64

/** Provisional upper bound for learned Channel-1 brief tokens, independent of model size. */
export const BRIEF_CEILING = 2_048

/** Provisional share of usable context available to cumulative Channel-2 record bodies per turn. */
export const READ_BODY_FRACTION = 0.1

/** Provisional hard cap on distinct records admitted across all three channels in one turn. */
export const GLOBAL_RECORD_CAP = 24

/** Provisional multiplier applied to the distinct-record cap for gate-failing weak models. */
export const WEAK_MODEL_CAP_SCALE = 0.5

/** Provisional minimum context window required before the optional Channel-2 tool surface is useful. */
export const MIN_MEMORY_TOOL_CONTEXT_WINDOW = 16_384

export interface KnowledgeBudgets {
  brief: number
  /** Wrapper-fixed Channel-2 search-result budget; never exposed in the tool schema. */
  searchResults: number
  caution: number
  readBody: number
  recordCap: number
}

export interface ComputeKnowledgeBudgetsInput {
  contextWindow: number
  reservedOutput: number
  qaRulesTokens: number
  workingContextTokens: number
}

function floorFinite(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER
  if (value === Number.NEGATIVE_INFINITY) return Number.MIN_SAFE_INTEGER
  return Math.floor(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

// The raw fraction is floored before the clamp; the reader and loop receive only plain numbers.
export function computeKnowledgeBudgets(input: ComputeKnowledgeBudgetsInput): KnowledgeBudgets {
  const usableContext = input.contextWindow
    - input.reservedOutput
    - input.qaRulesTokens
    - input.workingContextTokens

  const brief = clamp(
    floorFinite(usableContext * BRIEF_FRACTION),
    MIN_BRIEF,
    BRIEF_CEILING,
  )
  const caution = Math.max(MIN_CAUTION, floorFinite(usableContext * CAUTION_FRACTION))
  const readBody = Math.max(MIN_BRIEF, floorFinite(usableContext * READ_BODY_FRACTION))

  // Search entries and Channel-1 learned lines are both summary-sized projections. Reuse the
  // same bounded allocation rather than inventing a model-controlled or unbounded search knob.
  const searchResults = brief
  return { brief, searchResults, caution, readBody, recordCap: GLOBAL_RECORD_CAP }
}

// Channel 2 is absent when the model cannot call tools, is text-only or has too little context.
export function memoryToolGate(capabilities: ModelCapabilities): boolean {
  return capabilities.toolCalling
    && capabilities.vision
    && capabilities.contextWindow >= MIN_MEMORY_TOOL_CONTEXT_WINDOW
}

// Applies the weak-model cap reduction through the same gate predicate.
export function scaledRecordCap(capabilities: ModelCapabilities): number {
  if (memoryToolGate(capabilities)) return GLOBAL_RECORD_CAP
  return Math.max(1, Math.floor(GLOBAL_RECORD_CAP * WEAK_MODEL_CAP_SCALE))
}
