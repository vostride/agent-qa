import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import {
  C_RRF,
  DIVERSITY_CAP_PER_ANCHOR,
  EXPANSION_DISCOUNT_WEIGHT,
  EXPANSION_FRACTION_F,
  FAN_IN_THRESHOLD_K,
  FAN_OUT_CAP,
  FTS_WEIGHT_CONTENT,
  FTS_WEIGHT_CONTEXT,
  FTS_WEIGHT_IDENTITY,
  HUB_DEGREE_THRESHOLD,
  QUERY_CLASS_WEIGHTS,
  SITUATING_LINE_MAX_CHARS,
  TAU_LEX,
} from '../retrieval/constants.js'
import { classifyQuery } from '../retrieval/query-class.js'

describe('query classification', () => {
  it.each([
    '#submit-btn',
    '[data-testid="cart"]',
    '//div[@id="x"]',
    'https://app.example.com/checkout',
  ])('classifies literal-only query %j as literal', (query) => {
    expect(classifyQuery(query)).toBe('literal')
  })

  it.each([
    'checkout button #submit-btn not clickable',
    'TypeError: cannot read properties of undefined',
  ])('classifies literal-bearing prose %j as mixed', (query) => {
    expect(classifyQuery(query)).toBe('mixed')
  })

  it.each(['how does the user complete checkout', '', '   '])(
    'classifies semantic query %j as semantic',
    (query) => {
      expect(classifyQuery(query)).toBe('semantic')
    },
  )

  it('is total over arbitrary input and returns only the closed union', () => {
    const classes = new Set(['literal', 'mixed', 'semantic'])
    const inputs = [
      '\0',
      '\n\tat render (app.ts:1:2)',
      'getByTestId("checkout")',
      'testid=checkout',
      'plain prose with [ an unmatched bracket',
      '🚦 submit the order',
    ]

    for (const input of inputs) {
      expect(classes.has(classifyQuery(input))).toBe(true)
    }
  })

  it('classifies a 10,000-character adversarial bracket string in under 50ms', () => {
    const adversarial = '["'.repeat(5_000)
    classifyQuery('warm-up')

    const started = performance.now()
    const result = classifyQuery(adversarial)
    const elapsedMs = performance.now() - started

    expect(['literal', 'mixed', 'semantic']).toContain(result)
    expect(elapsedMs).toBeLessThan(50)
  })
})

describe('retrieval constant authority', () => {
  it('pins the locked and provisional pipeline constants', () => {
    expect({
      C_RRF,
      FAN_OUT_CAP,
      TAU_LEX,
      FTS_WEIGHT_IDENTITY,
      FTS_WEIGHT_CONTENT,
      FTS_WEIGHT_CONTEXT,
      SITUATING_LINE_MAX_CHARS,
      EXPANSION_FRACTION_F,
      EXPANSION_DISCOUNT_WEIGHT,
      HUB_DEGREE_THRESHOLD,
      FAN_IN_THRESHOLD_K,
      DIVERSITY_CAP_PER_ANCHOR,
    }).toEqual({
      C_RRF: 60,
      FAN_OUT_CAP: 32,
      TAU_LEX: 6.86,
      FTS_WEIGHT_IDENTITY: 10,
      FTS_WEIGHT_CONTENT: 5,
      FTS_WEIGHT_CONTEXT: 1,
      SITUATING_LINE_MAX_CHARS: 240,
      EXPANSION_FRACTION_F: 0.25,
      EXPANSION_DISCOUNT_WEIGHT: 0.5,
      HUB_DEGREE_THRESHOLD: 64,
      FAN_IN_THRESHOLD_K: 4,
      DIVERSITY_CAP_PER_ANCHOR: 2,
    })
  })

  it('pins one fixed vector for every closed query class', () => {
    expect(QUERY_CLASS_WEIGHTS).toEqual({
      literal: { wLex: 1.5, wDense: 0.5, wAnchor: 2 },
      mixed: { wLex: 1, wDense: 1, wAnchor: 1.5 },
      semantic: { wLex: 0.5, wDense: 1.5, wAnchor: 1 },
    })
  })
})
