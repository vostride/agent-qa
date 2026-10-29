// `.strict()` turns an added confidence member into a parse refusal, not an ignored key.

import { describe, expect, it } from 'vitest'

import {
  ExplainCitationSchema,
  ExplainInputSchema,
  ExplainOutputSchema,
} from '../explain'

describe('ExplainInputSchema', () => {
  it('accepts a non-empty query and refuses an empty one', () => {
    expect(ExplainInputSchema.parse({ query: 'how do I start a run?' })).toEqual({
      query: 'how do I start a run?',
    })
    expect(ExplainInputSchema.safeParse({ query: '' }).success).toBe(false)
  })

  it('refuses an unknown key — the input is closed', () => {
    expect(ExplainInputSchema.safeParse({ query: 'x', sessionId: 'abc' }).success).toBe(false)
  })
})

describe('ExplainCitationSchema — the closed LLM-output contract', () => {
  it('accepts row-id citations with no prose at all', () => {
    const parsed = ExplainCitationSchema.parse({ citedRowIds: ['op:runs.start'] })
    expect(parsed.citedRowIds).toEqual(['op:runs.start'])
  })

  it('accepts ordered prose segments that reference citations BY INDEX', () => {
    const parsed = ExplainCitationSchema.parse({
      citedRowIds: ['op:runs.start'],
      segments: [
        { kind: 'text', text: 'That is what this does:' },
        { kind: 'citation', citationIndex: 0 },
      ],
    })
    expect(parsed.segments).toHaveLength(2)
  })

  it('has NO field that could carry a command string from the LLM side', () => {
    for (const commandCarrier of [
      { citedRowIds: ['op:runs.start'], command: '/run tests/checkout.test.yaml' },
      { citedRowIds: ['op:runs.start'], invocation: 'agent-qa run --all' },
      { citedRowIds: ['op:runs.start'], renderedLines: ['/deploy --prod'] },
    ]) {
      expect(ExplainCitationSchema.safeParse(commandCarrier).success).toBe(false)
    }
  })

  it('refuses a citation segment carrying its own text alongside the index', () => {
    expect(
      ExplainCitationSchema.safeParse({
        citedRowIds: ['op:runs.start'],
        segments: [{ kind: 'citation', citationIndex: 0, text: 'run it with /run' }],
      }).success,
    ).toBe(false)
  })
})

describe('ExplainOutputSchema — a binary union with no confidence member', () => {
  const answer = {
    kind: 'answer' as const,
    citations: [
      {
        rowId: 'op:runs.start',
        rowKind: 'op' as const,
        invocation: '/fn runs.start',
        description: 'Start one run.',
        requiredParams: ['target'],
        docPath: null,
      },
    ],
    renderedLines: ['`/fn runs.start` — Start one run. (required input: target)'],
  }

  const abstention = {
    kind: 'abstention' as const,
    is_uncertain: true as const,
    closestRowIds: ['op:runs.start'],
    renderedLines: ['I am not certain.'],
    docsGap: { logged: false },
  }

  it('parses exactly the two arms', () => {
    expect(ExplainOutputSchema.parse(answer).kind).toBe('answer')
    expect(ExplainOutputSchema.parse(abstention).kind).toBe('abstention')
    expect(ExplainOutputSchema.safeParse({ ...answer, kind: 'partial' }).success).toBe(false)
  })

  it('refuses a payload carrying a confidence field — on EITHER arm', () => {
    expect(ExplainOutputSchema.safeParse({ ...answer, confidence: 0.9 }).success).toBe(false)
    expect(ExplainOutputSchema.safeParse({ ...abstention, confidence: 0.2 }).success).toBe(false)
  })

  it('requires is_uncertain as a literal true on the abstention arm', () => {
    expect(ExplainOutputSchema.safeParse({ ...abstention, is_uncertain: false }).success).toBe(false)
    const { is_uncertain: _dropped, ...withoutFlag } = abstention
    expect(ExplainOutputSchema.safeParse(withoutFlag).success).toBe(false)
  })

  it('does not let the answer arm carry an uncertainty flag, nor abstention carry citations', () => {
    expect(ExplainOutputSchema.safeParse({ ...answer, is_uncertain: true }).success).toBe(false)
    expect(
      ExplainOutputSchema.safeParse({ ...abstention, citations: answer.citations }).success,
    ).toBe(false)
  })
})
