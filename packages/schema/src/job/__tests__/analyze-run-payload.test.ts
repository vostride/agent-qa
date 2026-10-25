// The analyze-run payload mirror (393 D-20, WTST-06's schema-validated half).
//
// The back-compat case is the load-bearing one: the enqueue site ships a four-field payload
// today, and a schema that only accepts the new six-field shape would refuse every job the
// running system produces. Both halves are pinned here so a later edit cannot quietly make the
// flags mandatory.

import { describe, expect, it } from 'vitest'

import { AnalyzeRunPayloadSchema } from '../analyze-run-payload'

/** Byte-for-byte the shape `post-run-tail.ts` enqueues today. */
const CURRENT_PAYLOAD = {
  runId: 'r_ponent-fram-south-origin-flat',
  handoffDigest: 'sha256:3f9a1c',
  handoffSchemaVersion: 6,
  executionContext: 'local-interactive',
} as const

describe('AnalyzeRunPayloadSchema', () => {
  it('accepts the current four-field payload unchanged (back-compat)', () => {
    expect(AnalyzeRunPayloadSchema.parse(CURRENT_PAYLOAD)).toEqual(CURRENT_PAYLOAD)
  })

  it('accepts the payload with both D-20 flags', () => {
    const flagged = { ...CURRENT_PAYLOAD, gateRun: true, excludedFromOutcomes: true } as const
    expect(AnalyzeRunPayloadSchema.parse(flagged)).toEqual(flagged)
  })

  it('accepts each flag independently — they are DISTINCT axes', () => {
    // C8: a gate run still feeds curation, so `gateRun` without `excludedFromOutcomes` is a
    // real combination and must not be schema-coupled to its sibling.
    expect(
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, gateRun: true }),
    ).toMatchObject({ gateRun: true })
    expect(
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, excludedFromOutcomes: true }),
    ).toMatchObject({ excludedFromOutcomes: true })
  })

  it('accepts a payload with no executionContext', () => {
    const { executionContext: _dropped, ...withoutContext } = CURRENT_PAYLOAD
    expect(AnalyzeRunPayloadSchema.parse(withoutContext)).toEqual(withoutContext)
  })

  it('refuses gateRun: false — only the literal marker is meaningful', () => {
    expect(() =>
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, gateRun: false }),
    ).toThrow()
  })

  it('refuses excludedFromOutcomes: false for the same reason', () => {
    expect(() =>
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, excludedFromOutcomes: false }),
    ).toThrow()
  })

  it('refuses an unknown key (.strict() on the producer side)', () => {
    expect(() =>
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, gateRunReason: 'draft-eval' }),
    ).toThrow()
  })

  it('refuses an empty runId and an empty handoffDigest', () => {
    expect(() => AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, runId: '' })).toThrow()
    expect(() =>
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, handoffDigest: '' }),
    ).toThrow()
  })

  it('refuses a missing handoffDigest — the digest is what names the analysed bytes', () => {
    const { handoffDigest: _dropped, ...withoutDigest } = CURRENT_PAYLOAD
    expect(() => AnalyzeRunPayloadSchema.parse(withoutDigest)).toThrow()
  })

  it('refuses an executionContext outside the closed vocabulary', () => {
    expect(() =>
      AnalyzeRunPayloadSchema.parse({ ...CURRENT_PAYLOAD, executionContext: 'staging' }),
    ).toThrow()
  })
})
