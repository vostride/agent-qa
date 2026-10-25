// The low-trust records a run's own served briefs put on a verdict's failing path.

import { z } from 'zod'

import type { BriefLine } from '../brief/served-brief'
import type { StepEvidence } from '../handoff/step-evidence'
import type { RecordId } from '../ids/record-id'

/**
 * The two ways the store itself declares a served record's trust was not established when it
 * was put on a step's path — `'candidate'` is the pre-promotion fold status, and
 * `'low-trust-active'` is an active record served as a CANARY, deliberately on probation to
 * gather outcome evidence. No minted threshold and no second spelling of the trust fold: both
 * words read a marker the serving path already wrote.
 */
export type MemoryOnPathTrust = 'candidate' | 'low-trust-active'
// prettier-ignore
export const MEMORY_ON_PATH_TRUSTS = ['candidate', 'low-trust-active'] as const satisfies readonly MemoryOnPathTrust[]

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
 * The trust word for one served brief line, or `undefined` when the store's own markers say
 * the record's trust WAS established. Pre-promotion status is checked first: a candidate that
 * also rode a canary slot is still a candidate, which is the stronger disclosure.
 */
export function memoryOnPathTrustOf(line: BriefLine): MemoryOnPathTrust | undefined {
  if (line.status === 'candidate') return 'candidate'
  if (line.servedAsCanary) return 'low-trust-active'
  return undefined
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
 * The record-level fold of {@link deriveMemoryOnPathSites} — the exact shape a verdict's
 * `memoryOnPath` declares, computed from the briefs so the declaration can be CHECKED. A
 * record exposed as both a candidate and a canary reads `'candidate'`: the stronger of the two
 * disclosures survives the fold, so folding can never soften what a site recorded.
 */
export function deriveMemoryOnPath(steps: readonly StepEvidence[]): MemoryOnPathEntry[] {
  const byRecord = new Map<RecordId, MemoryOnPathTrust>()
  for (const site of deriveMemoryOnPathSites(steps)) {
    const previous = byRecord.get(site.recordId)
    if (previous === 'candidate') continue
    byRecord.set(site.recordId, site.trust)
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
