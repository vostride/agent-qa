// Pure `common_assertValue` comparator — "the runner judges" (Phase 360 · EXEC-07 · D-10/D-11 ·
// spec §7.2/§12.2).
//
// CRITICAL: provider-neutral + storage-neutral. No driver imports, no node:* imports, no ports, no
// loop/index import — a pure function so the Plan 10 dispatch seam composes it without cycles. The
// D-10 division: the adapter reads the value source (url/storage/network/expr) and returns the raw
// actual; this comparator applies exactly one closed op and produces the deterministic outcome. A
// passing outcome is evidence the verifier may cite, never a pass by itself.
//
// The result shape mirrors the schema AssertValueEvidence: sorted keys for a comparison carrying an
// expected value are exactly ["actual","expected","op","passed","source"] (the Plan 01 pin). No
// masking here — value-bearing fields are masked at the recorder boundary by the seam.

import type { AssertValueOp } from '@vostride/agent-qa-schema'

/** Comparator input: the source label, the closed op, the (optional) expected, and the raw actual. */
export interface AssertValueInput {
  source: string
  op: AssertValueOp
  /** Absent for the no-expected ops (isNull/isDefined). */
  expected?: string
  /** The raw value the adapter read. `null` is a read; `undefined` is unread and fails every op. */
  actual?: string | null
  /** Each network log entry's JSON, for `source: 'network'`. Absent or empty is unread. */
  entries?: string[]
}

/** Comparator outcome — projects onto the schema AssertValueEvidence block. */
export interface AssertValueResult {
  source: string
  op: AssertValueOp
  expected?: string
  actual?: string | null
  passed: boolean
}

function toNumber(value: unknown): number {
  return Number(value)
}

/**
 * Apply the closed assertValue op deterministically. Type-aware per the Block A pins: gt/lt coerce
 * numeric; equals/notEquals/contains compare as strings; isNull passes only on a null read. An
 * unread value fails every op. A network read passes only on a matching entry.
 */
export function compareAssertValue(input: AssertValueInput): AssertValueResult {
  const { op, expected, actual } = input
  let passed = false

  if (input.source === 'network') {
    const entries = input.entries ?? []
    if (entries.length > 0) {
      if (op === 'isDefined') passed = true
      else if (op === 'contains') passed = entries.some((entry) => entry.includes(String(expected)))
      else if (op === 'equals') passed = entries.some((entry) => entry === String(expected))
    }
  } else if (actual === null) {
    passed = op === 'isNull'
  } else if (actual !== undefined) {
    switch (op) {
      case 'isNull':
        passed = false
        break
      case 'isDefined':
        passed = true
        break
      case 'equals':
        passed = actual === String(expected)
        break
      case 'notEquals':
        passed = actual !== String(expected)
        break
      case 'gt':
        passed = toNumber(actual) > toNumber(expected)
        break
      case 'lt':
        passed = toNumber(actual) < toNumber(expected)
        break
      case 'contains':
        passed = actual.includes(String(expected))
        break
    }
  }

  const result: AssertValueResult = {
    source: input.source,
    op,
    passed,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
  }
  return result
}
