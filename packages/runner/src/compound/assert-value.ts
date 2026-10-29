// A passing outcome is evidence the verifier may cite, never a pass; the recorder masks values.

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

// gt and lt compare numbers, the rest compare strings; isNull passes only on a null read.
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
