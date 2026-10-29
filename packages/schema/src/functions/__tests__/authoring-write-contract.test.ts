import { describe, expect, it } from 'vitest'

import { AuthoringDraftWriteInputSchema } from '../authoring.js'
import { RunsStartInputSchema } from '../runs.js'

describe('AuthoringDraftWriteInputSchema: scope is host-derivable', () => {
  it('accepts an input carrying only intent — scope is optional at the registry', () => {
    const parsed = AuthoringDraftWriteInputSchema.safeParse({ intent: 'x' })
    expect(parsed.success).toBe(true)
    // ABSENT STAYS ABSENT. A default here would be a second resolution mechanism beside the
    // host's, and the op's absence check is what routes to the one deriver.
    expect(parsed.success && Object.hasOwn(parsed.data, 'scope')).toBe(false)
  })

  it('carries a supplied scope through unchanged — an explicit scope always wins', () => {
    const parsed = AuthoringDraftWriteInputSchema.safeParse({
      intent: 'x',
      scope: { tier: 'product', key: 'local-form' },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.scope : undefined)
      .toEqual({ tier: 'product', key: 'local-form' })
  })

  it('still refuses a MALFORMED scope — optional is not unvalidated', () => {
    // The non-vacuity guard on the two cells above: `.optional()` must not have been reached by
    // loosening the field's own shape. An empty key and an unknown tier stay typed refusals.
    expect(AuthoringDraftWriteInputSchema.safeParse({
      intent: 'x',
      scope: { tier: 'product', key: '' },
    }).success).toBe(false)
    expect(AuthoringDraftWriteInputSchema.safeParse({
      intent: 'x',
      scope: { tier: 'application', key: 'local-form' },
    }).success).toBe(false)
    // `.strict()` is untouched: an unrecognized key is still a refusal rather than a silent drop.
    expect(AuthoringDraftWriteInputSchema.safeParse({ intent: 'x', target: 'local-form' }).success)
      .toBe(false)
  })

  it('matches the runs.start precedent this law is borrowed from, field for field', () => {
    // Reads both declarations, so tightening either one fails here.
    const bothOmit = [
      RunsStartInputSchema.safeParse({}).success,
      AuthoringDraftWriteInputSchema.safeParse({ intent: 'x' }).success,
    ]
    expect(bothOmit).toEqual([true, true])
  })
})
