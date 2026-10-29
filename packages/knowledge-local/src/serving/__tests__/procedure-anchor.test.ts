// D-17's two halves, measured through the REAL matcher.
//
// Procedure-by-reference is a claim with two parts, and this file exists because only one of them
// can be checked where the authoring code lives.
//
//   THE COMMITTED FILE CARRIES NO RECORD ID.  A property of what the compile prompt renders, and
//   `packages/agent`'s own suite owns it.
//   THE STEP'S WORDS ACTUALLY REACH THE PROCEDURE.  A property of `matchProcedure`, and nothing in
//   `packages/agent` can see it: that matcher lives here, and `agent` declares exactly `runner`,
//   `safety`, `schema`, `ai` and `zod`, so importing it there is a `validate:arch` violation with
//   no legal repair. This package already depends on `agent`, so the link is expressible in this
//   direction and in no other.
//
// WHY THE MEASUREMENT MATTERS RATHER THAN THE ASSERTION. "Author the step in the anchor's
// vocabulary" is a design choice that could easily be decorative — the matcher admits on ANCHOR
// overlap, which is a fact about the screen rather than about the step text, so a reader could
// reasonably conclude the words make no difference. They do, and the difference is the one that
// decides whether a procedure is REPLAYED or merely hinted at: the step text enters the fold as a
// lexical term, and on a partially-matched anchor set it is what carries the composed confidence
// across the replay floor. Both directions are driven below over one candidate that differs in
// nothing but the intent it is asked about.

import {
  asRecordId,
  normalizeAnchor,
  procedureSourceBinding,
  procedureStepVocabulary,
  serializeProcedureBody,
  type Anchor,
  type BundleProvenance,
  type ProcedureBindingAvailability,
  type ProcedureSourceBinding,
} from '@vostride/agent-qa-schema'
import { BundleOutcomeEventSchema } from '@vostride/agent-qa-schema'
import type { BundleOutcomeEvent } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { makeProcedureBodyPayloadFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import { matchProcedure, type ProcedureMatchCandidate } from '../get-procedure.js'

/** The record's flow anchor — the one D-17 says a compiled step is authored in the words of. */
const SIGN_IN_FLOW: Anchor = { t: 'flow', name: 'Sign in with a saved account' }

/**
 * TWO flow/page anchors on the record, and the screen supplies ONE.
 *
 * Load-bearing rather than incidental. `anchorRelevance` is the MATCHED SHARE of the record's
 * flow/page anchors, and the composed relevance is clamped at 1 — so with every anchor matched the
 * lexical term is absorbed by the clamp and the vocabulary makes no observable difference at all.
 * A cell built that way would report "the words do not matter", which is true only of the
 * configuration it chose. A partially-matched anchor set is the configuration in which the claim
 * is falsifiable, and it is also the ordinary case: a screen is one page, and a procedure that
 * spans a flow names more than one.
 */
const RECORD_ANCHORS: readonly Anchor[] = [SIGN_IN_FLOW, { t: 'page', route: '/login' }]
const SCREEN_ANCHORS: readonly Anchor[] = [SIGN_IN_FLOW]

const FULL_AUTHORSHIP = {
  path: 'llm',
  model: { id: 'claude-sonnet-4' },
  executionContext: 'local-interactive',
} as const

const CREATION_JOB = 'job-anchor-creation'

function events(): BundleOutcomeEvent[] {
  return [
    BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: 'confirm-anchor-creation',
      curationJobId: CREATION_JOB,
      buildOrdinal: 9,
    }),
    ...Array.from({ length: 2 }, (_unused, index) =>
      BundleOutcomeEventSchema.parse({
        type: 'confirmed',
        evidenceToken: `confirm-anchor-${index}`,
        curationJobId: `job-anchor-${index}`,
        buildOrdinal: 10 + index,
      })),
  ]
}

const PROVENANCE: BundleProvenance = {
  schemaVersion: 1,
  mode: 'run-linked',
  originClass: 'agent-verified',
  runId: 'run-anchor',
  testId: 'test-anchor',
  stepIndex: 0,
  curationJobId: CREATION_JOB,
  authorship: FULL_AUTHORSHIP,
}

/**
 * The summary carries the anchor's OWN words, which is what makes the lexical term measurable.
 *
 * It is not hand-tuned to the test: a procedure record's summary describing the flow it performs
 * is the ordinary shape, and `procedureStepVocabulary` reads the same anchor the record was
 * indexed under — so the overlap is a consequence of the design rather than a fixture that was
 * arranged to agree with it.
 */
const SUMMARY = 'Sign in with a saved account and land on the dashboard'

function signInCandidate(): ProcedureMatchCandidate {
  return {
    entry: {
      id: asRecordId('proc-sign-in-anchor'),
      kind: 'procedure',
      title: SUMMARY,
      summary: SUMMARY,
      trust: 0.6,
      anchors: RECORD_ANCHORS.map(normalizeAnchor),
      status: 'candidate',
      servedAsCanary: false,
      scope: { tier: 'product', key: 'anchor-store' },
      validity: 'current',
    },
    bundle: {
      summary: SUMMARY,
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      events: events(),
      provenance: PROVENANCE,
    },
  }
}

/**
 * The bindings the fixture body declares, assembled through the REAL sanitizer.
 *
 * Not decoration: `procedureParameterFillability` halves the composed confidence AND hard-walls a
 * match out of replay when a required parameter cannot be filled, so an empty availability would
 * pin `hint` for BOTH directions below and the vocabulary claim would be unmeasurable — the pair
 * would agree for a reason that has nothing to do with the words. Built through
 * `procedureSourceBinding` rather than typed as literals so the fixture carries the capability
 * bits the loop assembler actually produces.
 */
const AVAILABILITY: ProcedureBindingAvailability = {
  variables: Object.entries({ email: 'user@example.test' })
    .map(([name, raw]) => procedureSourceBinding(name, raw))
    .filter((entry): entry is ProcedureSourceBinding => entry !== undefined),
  memory: [],
  secrets: ['password'],
}

function matchFor(intent: string) {
  return matchProcedure({
    entries: [signInCandidate()],
    intent,
    anchors: [...SCREEN_ANCHORS],
    availability: AVAILABILITY,
  })
}

describe('a step authored in the anchor vocabulary reaches the procedure', () => {
  it('is REPLAYED when the step is written in the flow own words', () => {
    // The vocabulary comes out of the shared function the compile prompt renders — not out of a
    // string typed here. That is the whole link: what `packages/agent` tells a model to write is
    // what this matcher is asked about, and a change to either side moves this cell.
    const step = procedureStepVocabulary(SIGN_IN_FLOW)

    const match = matchFor(step)

    expect(match?.id).toBe('proc-sign-in-anchor')
    expect(match?.replayRecommendation).toBe('replay')
  })

  it('degrades to a HINT for the same procedure when the step uses unrelated words', () => {
    // Identical candidate, identical screen anchors, identical availability. The ONLY difference
    // is which words the step is written in — so a green pair here cannot be explained by anything
    // except the vocabulary, and a matcher that ignored intent text entirely would fail this cell
    // by answering `replay` for both.
    const match = matchFor('Reconcile the discounted invoice against the quarterly ledger')

    expect(match?.id).toBe('proc-sign-in-anchor')
    expect(match?.replayRecommendation).toBe('hint')
  })

  it('carries a strictly higher confidence for the anchor-vocabulary step', () => {
    const onVocabulary = matchFor(procedureStepVocabulary(SIGN_IN_FLOW))
    const offVocabulary = matchFor('Reconcile the discounted invoice against the quarterly ledger')

    // Stated as an inequality rather than as two constants, because the constants are PROVISIONAL
    // (`get-procedure.ts` says so on each of them) and a pin on their current values would red on
    // a calibration change that left this claim entirely intact.
    expect(onVocabulary?.confidence).toBeGreaterThan(offVocabulary?.confidence ?? 1)
  })
})

describe('a step that matches no procedure simply plans normally', () => {
  it('answers undefined rather than a weak match when the screen anchors overlap nothing', () => {
    const match = matchProcedure({
      entries: [signInCandidate()],
      intent: procedureStepVocabulary(SIGN_IN_FLOW),
      anchors: [{ t: 'page', route: '/settings/billing' }],
      availability: AVAILABILITY,
    })

    // D-17's graceful miss, at the seam that decides it. `undefined` is what the runner's step-start
    // consult reads as "no procedure applies", and it then plans the step exactly as it plans any
    // other — so an authored step whose flow this project has never learned costs nothing and
    // behaves like ordinary prose, which is the property that makes authoring to the vocabulary
    // safe to do unconditionally.
    expect(match).toBeUndefined()
  })
})

describe('the vocabulary is derived from the anchor alone', () => {
  it('renders every anchor arm in the record own words, and can carry no record id', () => {
    // The function's ARGUMENT is the mitigation: a `ProcedureMatch` carries `id`, and a
    // vocabulary derived from an `Anchor` has no id in scope to leak into an authored file. This
    // cell states that as a property of the values it produces, arm by arm, so a later widening of
    // the signature to take the whole match would have to move this line too.
    const rendered = [
      procedureStepVocabulary({ t: 'flow', name: 'Sign in with a saved account' }),
      procedureStepVocabulary({ t: 'page', route: '/login' }),
      procedureStepVocabulary({ t: 'el', role: 'button', name: 'Sign in' }),
      procedureStepVocabulary({ t: 'platform', platform: 'web' }),
      procedureStepVocabulary({ t: 'selector', literal: '#sign-in' }),
      procedureStepVocabulary({ t: 'error', message: 'Invalid credentials' }),
    ]

    expect(rendered).toEqual([
      'Sign in with a saved account',
      '/login',
      'button Sign in',
      'web',
      '#sign-in',
      'Invalid credentials',
    ])
    for (const text of rendered) expect(text).not.toContain('proc-sign-in-anchor')
  })
})
