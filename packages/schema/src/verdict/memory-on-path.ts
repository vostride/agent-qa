// The low-trust records a run's own served briefs put on a verdict's failing path.

import { z } from 'zod'

import type { BriefLine } from '../brief/served-brief'
import type { StepEvidence } from '../handoff/step-evidence'
import type { RecordId } from '../ids/record-id'

/**
 * How the store itself declares a served record's trust was not established when it was put on
 * a step's path: `'candidate'` is the pre-promotion fold status the serving path already wrote.
 */
export type MemoryOnPathTrust = 'candidate'
export const MEMORY_ON_PATH_TRUSTS = ['candidate'] as const satisfies readonly MemoryOnPathTrust[]

/** One low-trust record the run's own briefs put on a verdict's failing path. */
export interface MemoryOnPathEntry {
  readonly recordId: RecordId
  readonly trust: MemoryOnPathTrust
}

/** One exposure: the same record served on two steps is two sites. */
export interface MemoryOnPathSite extends MemoryOnPathEntry {
  readonly stepIndex: number
}

/**
 * The trust word for one served brief line, or `undefined` when the store's own status says the
 * record's trust WAS established.
 */
export function memoryOnPathTrustOf(line: BriefLine): MemoryOnPathTrust | undefined {
  return line.status === 'candidate' ? 'candidate' : undefined
}

/**
 * Every low-trust EXPOSURE across the given steps, in step order then brief order. One record
 * served on two steps yields two sites; one record served twice within a single step's brief
 * yields one.
 */
export function deriveMemoryOnPathSites(steps: readonly StepEvidence[]): MemoryOnPathSite[] {
  const sites: MemoryOnPathSite[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const line of step.servedBrief.channel1) {
      const trust = memoryOnPathTrustOf(line)
      if (trust === undefined) continue
      const key = siteKey(step.stepIndex, line.id)
      if (seen.has(key)) continue
      seen.add(key)
      sites.push({ stepIndex: step.stepIndex, recordId: line.id, trust })
    }
  }
  return sites
}

/**
 * The record-level fold of {@link deriveMemoryOnPathSites}: one entry per record, in first
 * exposure order. It is the exact shape a verdict's `memoryOnPath` declares, computed from the
 * briefs so the declaration can be CHECKED.
 */
export function deriveMemoryOnPath(steps: readonly StepEvidence[]): MemoryOnPathEntry[] {
  const byRecord = new Map<RecordId, MemoryOnPathTrust>()
  for (const site of deriveMemoryOnPathSites(steps)) {
    if (!byRecord.has(site.recordId)) byRecord.set(site.recordId, site.trust)
  }
  return [...byRecord].map(([recordId, trust]) => ({ recordId, trust }))
}

const SITE_KEY_SEPARATOR = '\u001f'

// `RecordId` is an unconstrained string and `stepIndex` is decimal, so bare concatenation would
// mint one key for `(1, '2abc')` and `(12, 'abc')`.
function siteKey(stepIndex: number, recordId: RecordId): string {
  return `${String(stepIndex)}${SITE_KEY_SEPARATOR}${recordId}`
}

const recordIdSchema = z.custom<RecordId>(
  (value) => typeof value === 'string' && value.length > 0,
  { message: 'expected a non-empty RecordId' },
)

/**
 * The wire shape of ONE declared on-path entry, shared by every reader that validates a present
 * `Verdict.memoryOnPath`: the handoff loader, the analysis-artifact guard and the strict
 * cassette parser.
 */
export const MemoryOnPathEntrySchema = z
  .object({
    recordId: recordIdSchema,
    trust: z.enum(MEMORY_ON_PATH_TRUSTS),
  })
  .strict()

/**
 * Present-implies-valid for a stored verdict's `memoryOnPath`: absent is legal, and a present
 * member must be an array of complete entries, because the validator recomputes against it.
 * Not a total shape check for a verdict; each reader keeps its own rules.
 */
export function hasMemoryOnPathShape(value: Record<string, unknown>): boolean {
  if (!('memoryOnPath' in value)) return true
  const declared = value.memoryOnPath
  if (!Array.isArray(declared)) return false
  return declared.every((entry) => MemoryOnPathEntrySchema.safeParse(entry).success)
}
