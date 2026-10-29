// The ONE deterministic sentence renderer.
//
// Four claims, each an obligation the composed sentence carries: the verbatim grounding
// quote with its step ref, the discriminator, the recurrence clause (a LIVE join through
// the provider seam — never a stored number), and the recommended next action with its
// `agentqa://` links. The renderer is producer-keyed by CONSTRUCTION: it composes typed
// parts identically whoever authored them, which is what lets plan 04's LLM parts and the
// deterministic template parts flow through one rule — and what makes SC3's
// "no second code path" structural when plan 07's CLI print imports this same symbol.

import type {
  QuarantineLadderState,
  Verdict,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { renderVerdictSentence } from '../render-sentence.js'
import type {
  RecurrenceAnswer,
  RecurrenceProvider,
  RecurrenceQuery,
} from '../render-sentence.js'

const QUERY: RecurrenceQuery = {
  product: 'shop',
  filePath: 'tests/checkout.yaml',
  testName: 'checks out',
}

function verdictOf(
  overrides: Partial<Pick<Verdict, 'class' | 'producer' | 'confidence' | 'perTest'>> = {},
): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: [2],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'classifier self-trace — never the sentence',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
    ...overrides,
  } as Verdict
}

const LLM_PARTS: VerdictSentenceParts = {
  perTest: 0,
  groundingQuote: { stepIndex: 2, quote: 'Error: element "Submit" not found' },
  discriminator: 'the submit button disappeared after the cart update',
  nextAction: 'file the failure against the application with the quoted evidence',
  links: ['agentqa://memory/MEM-001', 'agentqa://run/RUN-042'],
}

const TEMPLATE_PARTS: VerdictSentenceParts = {
  perTest: 1,
  groundingQuote: { stepIndex: 0, quote: 'net::ERR_CONNECTION_REFUSED' },
  discriminator: 'environment: the app under test refused the connection',
  nextAction: 'check the environment or infrastructure dependency the run relied on',
  links: [],
}

const HONEST_UNKNOWN_PARTS: VerdictSentenceParts = {
  perTest: 2,
  groundingQuote: { source: 'test-outcome', quote: 'failed' },
  discriminator: 'root cause undetermined',
  nextAction: 'inspect the run manually — no deterministic signal matched',
  links: [],
}

interface RecordingProvider {
  readonly provider: RecurrenceProvider
  readonly asked: RecurrenceQuery[]
}

function providerAnswering(
  answer: () => RecurrenceAnswer | undefined,
): RecordingProvider {
  const asked: RecurrenceQuery[] = []
  return {
    provider: {
      failureRecurrence(query) {
        asked.push(query)
        return answer()
      },
    },
    asked,
  }
}

describe('renderVerdictSentence — the four obligations', () => {
  it('renders quote, discriminator, recurrence and next action, each at its section marker', () => {
    const { provider } = providerAnswering(() => ({ kth: 3, windowBuilds: 5 }))
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)

    // Obligation a: the verbatim quote, with its step ref.
    expect(sentence).toContain('observed (step 2): "Error: element "Submit" not found"')
    // Obligation b: the discriminator, verbatim.
    expect(sentence).toContain('the submit button disappeared after the cart update')
    // Obligation c: the recurrence clause — typed data in, prose out.
    expect(sentence).toContain('failure 3 of this test in the last 5 builds')
    // Obligation d: the next action with its agentqa:// links.
    expect(sentence).toContain(
      'next: file the failure against the application with the quoted evidence',
    )
    expect(sentence).toContain('see: agentqa://memory/MEM-001, agentqa://run/RUN-042')
    // The lead frame is the RESOLVED class, from the verdict — the one field every reader
    // wants before the prose starts.
    expect(sentence.startsWith('app_bug: ')).toBe(true)
  })

  it('renders the step-less grounding arm as the typed test-outcome ref, never a step index', () => {
    const { provider } = providerAnswering(() => undefined)
    const sentence = renderVerdictSentence(
      verdictOf({ class: 'unknown', producer: 'deterministic-classifier', confidence: 0 }),
      HONEST_UNKNOWN_PARTS,
      provider,
      QUERY,
    )

    expect(sentence).toContain('observed (test outcome): "failed"')
    expect(sentence).not.toContain('observed (step')
  })
})

describe('the recurrence clause is a LIVE join', () => {
  it('reflects each provider answer at call time — nothing cached, nothing stored', () => {
    let current: { kth: number; windowBuilds: number } | undefined = { kth: 2, windowBuilds: 6 }
    const recording = providerAnswering(() => current)

    const first = renderVerdictSentence(verdictOf(), LLM_PARTS, recording.provider, QUERY)
    current = { kth: 7, windowBuilds: 9 }
    const second = renderVerdictSentence(verdictOf(), LLM_PARTS, recording.provider, QUERY)

    expect(first).toContain('failure 2 of this test in the last 6 builds')
    expect(second).toContain('failure 7 of this test in the last 9 builds')
    expect(first).not.toBe(second)
    // The provider was consulted per call, with the caller's query, both times.
    expect(recording.asked).toEqual([QUERY, QUERY])
  })

  it('renders the explicit no-history clause when no provider is bound at all', () => {
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, undefined, QUERY)

    expect(sentence).toContain('no failure history is recorded for this test')
  })

  it('renders the explicit no-history clause when the provider answers undefined', () => {
    const { provider } = providerAnswering(() => undefined)
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)

    expect(sentence).toContain('no failure history is recorded for this test')
  })

  it('renders the explicit no-history clause for the zero-history answer {0, 0}', () => {
    const { provider } = providerAnswering(() => ({ kth: 0, windowBuilds: 0 }))
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)

    expect(sentence).toContain('no failure history is recorded for this test')
  })

  it('says honestly when a window exists but records no prior failure of this test', () => {
    const { provider } = providerAnswering(() => ({ kth: 0, windowBuilds: 4 }))
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)

    expect(sentence).toContain('no prior failure of this test is recorded in the last 4 builds')
  })
})

// ---- 390 D-17: the ladder arms ------------------------------------------------------------
//
// The clause is TOTAL over `QuarantineLadderState | undefined` — four arms over a three-member
// union, with absence as the fourth. Every case below pins the WHOLE composed sentence rather
// than a substring, because a table-driven case that derives its expectation from the same
// table the renderer reads stays green while the table is wrong (390-05's probe D). The one
// table-shaped assertion here is the totality check, and it is a COMPILE-time one: the literal
// is written `satisfies Record<QuarantineLadderState, string>`, so a fourth ladder state fails
// to compile in this file too.

/** The full sentence LLM_PARTS composes, with the recurrence clause spliced in. */
function llmSentenceWith(clause: string): string {
  return [
    'app_bug: observed (step 2): "Error: element "Submit" not found"',
    'the submit button disappeared after the cart update',
    clause,
    'next: file the failure against the application with the quoted evidence',
    'see: agentqa://memory/MEM-001, agentqa://run/RUN-042',
  ].join(' — ')
}

function renderWith(answer: RecurrenceAnswer | undefined): string {
  const { provider } = providerAnswering(() => answer)
  return renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)
}

describe('the flake ladder arms', () => {
  const EXPIRES_AT = '2026-09-04T12:00:00.000Z'

  it('renders the no-ladder arm as the occurrence count alone — byte-unchanged from the ladderless sentence', () => {
    expect(renderWith({ kth: 3, windowBuilds: 5 }))
      .toBe(llmSentenceWith('failure 3 of this test in the last 5 builds'))
  })

  it('renders the flagged arm: suspected flaky, no deadline, one build of warning', () => {
    expect(renderWith({ kth: 2, windowBuilds: 5, ladder: { state: 'flagged' } }))
      .toBe(llmSentenceWith('failure 2 of this test in the last 5 builds; suspected flaky'))
  })

  it('renders the quarantined arm with the expiry — the one detail that changes what a reader does', () => {
    expect(renderWith({
      kth: 3,
      windowBuilds: 5,
      ladder: { state: 'quarantined', expiresAt: EXPIRES_AT },
    })).toBe(llmSentenceWith(
      'failure 3 of this test in the last 5 builds; quarantined until Sep 4',
    ))
  })

  it('renders the expired arm saying failures count again', () => {
    expect(renderWith({
      kth: 4,
      windowBuilds: 5,
      ladder: { state: 'expired', expiresAt: EXPIRES_AT },
    })).toBe(llmSentenceWith(
      'failure 4 of this test in the last 5 builds; quarantine expired Sep 4 — failures count again',
    ))
  })

  it('is TOTAL over the ladder union — every state renders a distinct, non-empty suffix', () => {
    // Compile-time: a fourth `QuarantineLadderState` member is a type error HERE, not a state
    // that silently renders the bare occurrence count.
    const suffixes = {
      flagged: '; suspected flaky',
      quarantined: '; quarantined until Sep 4',
      expired: '; quarantine expired Sep 4 — failures count again',
    } as const satisfies Record<QuarantineLadderState, string>

    for (const [state, suffix] of Object.entries(suffixes)) {
      const rendered = renderWith({
        kth: 3,
        windowBuilds: 5,
        ladder: { state: state as QuarantineLadderState, expiresAt: EXPIRES_AT },
      })
      expect(rendered).toBe(
        llmSentenceWith(`failure 3 of this test in the last 5 builds${suffix}`),
      )
    }
  })

  it('formats the deadline in UTC, locale-free — a date near midnight cannot slide a day', () => {
    // A local-time renderer answers "Dec 31" for this instant in every negative-offset zone.
    expect(renderWith({
      kth: 1,
      windowBuilds: 2,
      ladder: { state: 'quarantined', expiresAt: '2026-01-01T00:30:00.000Z' },
    })).toBe(llmSentenceWith('failure 1 of this test in the last 2 builds; quarantined until Jan 1'))
  })

  it('shows a hand-edited unparseable deadline VERBATIM rather than inventing one', () => {
    // The ledger is committed text a human may edit; the fold treats an unparseable
    // deadline as lapsed, and the clause quotes what the file actually says.
    expect(renderWith({
      kth: 3,
      windowBuilds: 5,
      ladder: { state: 'expired', expiresAt: 'soon' },
    })).toBe(llmSentenceWith(
      'failure 3 of this test in the last 5 builds; quarantine expired soon — failures count again',
    ))
  })

  it('keeps BOTH honest-absence clauses byte-identical even when a ladder is present', () => {
    // Load-bearing negative: the ladder IS supplied on every leg below, so an implementation
    // that appended the suffix unconditionally would change these bytes. No reader may lose
    // the explicit no-history answer to a quarantine note.
    const quarantined = { state: 'quarantined', expiresAt: EXPIRES_AT } as const

    expect(renderWith({ kth: 0, windowBuilds: 0, ladder: quarantined }))
      .toBe(llmSentenceWith('no failure history is recorded for this test'))
    expect(renderWith({ kth: 0, windowBuilds: 0 }))
      .toBe(llmSentenceWith('no failure history is recorded for this test'))
    expect(renderWith(undefined))
      .toBe(llmSentenceWith('no failure history is recorded for this test'))
  })

  it('keeps the kth-0 clause byte-identical even when a ladder is present', () => {
    const expired = { state: 'expired', expiresAt: EXPIRES_AT } as const

    expect(renderWith({ kth: 0, windowBuilds: 4, ladder: expired }))
      .toBe(llmSentenceWith('no prior failure of this test is recorded in the last 4 builds'))
    expect(renderWith({ kth: 0, windowBuilds: 4 }))
      .toBe(llmSentenceWith('no prior failure of this test is recorded in the last 4 builds'))
  })

  it('carries the fingerprint on the query the provider is asked with', () => {
    const recording = providerAnswering(() => ({ kth: 1, windowBuilds: 1 }))
    const keyed: RecurrenceQuery = { ...QUERY, fingerprint: '{"t":"error","message":"boom"}::flake' }

    renderVerdictSentence(verdictOf(), LLM_PARTS, recording.provider, keyed)

    expect(recording.asked).toEqual([keyed])
  })
})

describe('producer-keyed composition through ONE rule', () => {
  it('renders LLM parts for producer analyze-run', () => {
    const { provider } = providerAnswering(() => ({ kth: 1, windowBuilds: 3 }))
    const sentence = renderVerdictSentence(
      verdictOf({ producer: 'analyze-run' }),
      LLM_PARTS,
      provider,
      QUERY,
    )

    expect(sentence).toContain('observed (step 2)')
    expect(sentence).toContain('the submit button disappeared after the cart update')
  })

  it('renders template parts for producer deterministic-classifier, absence as absence', () => {
    const { provider } = providerAnswering(() => ({ kth: 1, windowBuilds: 3 }))
    const sentence = renderVerdictSentence(
      verdictOf({ class: 'environment', producer: 'deterministic-classifier', confidence: 1 }),
      TEMPLATE_PARTS,
      provider,
      QUERY,
    )

    expect(sentence).toContain('observed (step 0): "net::ERR_CONNECTION_REFUSED"')
    expect(sentence).toContain('environment: the app under test refused the connection')
    expect(sentence).toContain('failure 1 of this test in the last 3 builds')
    expect(sentence).toContain('next: check the environment or infrastructure dependency')
    // Empty links render as NO see-section — never a dangling header.
    expect(sentence).not.toContain('see:')
  })

  it('renders the honest root-cause-undetermined sentence with a manual-inspection action', () => {
    const sentence = renderVerdictSentence(
      verdictOf({ class: 'unknown', producer: 'deterministic-classifier', confidence: 0 }),
      HONEST_UNKNOWN_PARTS,
      undefined,
      QUERY,
    )

    expect(sentence).toContain('root cause undetermined')
    expect(sentence).toContain('next: inspect the run manually — no deterministic signal matched')
    // Obligation c still renders, honestly, on the fallback sentence too.
    expect(sentence).toContain('no failure history is recorded for this test')
  })
})

describe('byte determinism', () => {
  it('same (verdict, parts, provider answer) → the same string, byte for byte', () => {
    const first = renderVerdictSentence(
      verdictOf(),
      LLM_PARTS,
      providerAnswering(() => ({ kth: 3, windowBuilds: 5 })).provider,
      QUERY,
    )
    const second = renderVerdictSentence(
      verdictOf(),
      LLM_PARTS,
      providerAnswering(() => ({ kth: 3, windowBuilds: 5 })).provider,
      QUERY,
    )

    expect(first).toBe(second)
  })
})

// The D-12 quote leg: quoted producer text is cleaned in the ONE renderer (406, DETL-04).
//
// The 399 seeded-red sentence is the canonical "before". Pinning it HERE — through
// `renderVerdictSentence`, not through the sanitizer alone — is what makes the single code
// path structural: the CLI print, 392's chat and the run page all compose their sentence with
// this function, so a surface cannot read a differently-cleaned quote without a second
// renderer, which is the drift D-12 exists to forbid. ESC is spelled as an escape, never as a
// literal byte, so the cell about invisible characters is itself readable.

const ESC = '\u001b'

/** Copied from `demo/acceptance/399/399-analysis-seeded-red.json` — Playwright's raw error. */
const SEEDED_RED_399_QUOTE =
  'locator.click: Timeout 30000ms exceeded.\n'
  + 'Call log:\n'
  + `${ESC}[2m  - waiting for getByRole('button', { name: 'Close ad', exact: true }).first()`
  + `${ESC}[22m\n`

const SEEDED_RED_399_PARTS: VerdictSentenceParts = {
  perTest: 0,
  groundingQuote: { stepIndex: 1, quote: SEEDED_RED_399_QUOTE },
  discriminator: 'root cause undetermined',
  nextAction: 'inspect the run manually — no deterministic signal matched',
  links: [],
}

describe('quote sanitization — the recorded before/after through the ONE renderer', () => {
  it('renders the seeded-red sentence as readable prose, pinned verbatim', () => {
    const sentence = renderVerdictSentence(
      verdictOf({ class: 'unknown', producer: 'deterministic-classifier', confidence: 0 }),
      SEEDED_RED_399_PARTS,
      undefined,
      QUERY,
    )

    expect(sentence).toBe(
      'unknown: observed (step 1): "locator.click: Timeout 30000ms exceeded. '
        + "Call log: - waiting for getByRole('button', { name: 'Close ad', exact: true }).first()\""
        + ' — root cause undetermined'
        + ' — no failure history is recorded for this test'
        + ' — next: inspect the run manually — no deterministic signal matched',
    )
    expect(sentence).not.toContain(ESC)
    expect(sentence).not.toContain('\n')
  })

  it('cleans the test-outcome arm through the same leg — one rule, both arms', () => {
    const sentence = renderVerdictSentence(
      verdictOf({ class: 'unknown', producer: 'deterministic-classifier', confidence: 0 }),
      {
        ...HONEST_UNKNOWN_PARTS,
        groundingQuote: { source: 'test-outcome', quote: `${ESC}[31mtimed\nout${ESC}[39m` },
      },
      undefined,
      QUERY,
    )

    expect(sentence).toContain('observed (test outcome): "timed out"')
    expect(sentence).not.toContain(ESC)
  })

  it('leaves an already-clean quote byte-identical — every prior pin stays green', () => {
    const { provider } = providerAnswering(() => ({ kth: 3, windowBuilds: 5 }))
    const sentence = renderVerdictSentence(verdictOf(), LLM_PARTS, provider, QUERY)

    expect(sentence).toContain('observed (step 2): "Error: element "Submit" not found"')
  })
})
