import { describe, expect, it } from 'vitest'

import { shortRunId } from '../../reporters/short-run-id.js'
import {
  knowledgeHeadline,
  knowledgeItemLines,
  knowledgePendingResumeWords,
  knowledgeResumeWords,
  knowledgeSecondLine,
  knowledgeSummaryOfDrain,
  knowledgeTaggedMessage,
  type KnowledgeSummary,
  type KnowledgeSummaryItem,
} from '../knowledge-summary.js'

const CI_RESUME =
  "resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up"

const LOCAL_RESUME = 'resumes on the next run'
const LOCAL_PENDING = 'resumes on a later local run'

const ID_A = '0b0a3ce0'.padEnd(64, 'a')
const ID_B = '2300c56a'.padEnd(64, 'b')
const ID_C = '39f2eea3'.padEnd(64, 'c')
const ID_D = '7b5465ff'.padEnd(64, 'd')
const ID_E = 'e1e1e1e1'.padEnd(64, 'e')

function summary(overrides: Partial<KnowledgeSummary> = {}): KnowledgeSummary {
  return { learned: 2, held: 1, proposed: 0, items: [], ...overrides }
}

describe('the summary of a drain', () => {
  it('counts what was learned, held and kept proposed, and lists the decisions in order', () => {
    const result = knowledgeSummaryOfDrain({
      runId: 'r_phasis-label-purple-ligne',
      executionContext: 'local',
      complete: true,
      drain: {
        kind: 'drained',
        committed: 7,
        evidenceCommitted: 2,
        downgraded: 0,
        requeued: 0,
        promotions: [
          { candidateId: ID_A, promotionPath: 'deterministic-verdict-floor' },
          { candidateId: ID_B, promotionHoldReason: 'no-element-observation' },
          { candidateId: ID_C, promotionHoldReason: 'no-element-observation' },
          { candidateId: ID_D, promotionPath: 'user-sovereign' },
          { candidateId: ID_E, promotionHoldReason: 'missing-root-cause' },
        ],
      },
    })
    const items: KnowledgeSummaryItem[] = [
      { outcome: 'learned', id: ID_A, reason: 'deterministic-verdict-floor' },
      { outcome: 'held', id: ID_B, reason: 'no-element-observation' },
      { outcome: 'held', id: ID_C, reason: 'no-element-observation' },
      { outcome: 'learned', id: ID_D, reason: 'user-sovereign' },
      { outcome: 'held', id: ID_E, reason: 'missing-root-cause' },
    ]
    expect(result).toEqual({
      runId: 'r_phasis-label-purple-ligne',
      learned: 5,
      held: 3,
      proposed: 0,
      items,
    })
    expect(result).not.toHaveProperty('instead')
    expect(result).not.toHaveProperty('unfinished')
  })

  it.each([
    {
      title: 'a change kept proposed in ci is not counted as learned',
      executionContext: 'ci',
      committed: 1,
      evidenceCommitted: undefined,
      downgraded: 1,
      expected: { learned: 0, proposed: 1 },
    },
    {
      title: 'kept proposed is capped at the number of changes',
      executionContext: 'ci',
      committed: 2,
      evidenceCommitted: undefined,
      downgraded: 5,
      expected: { learned: 0, proposed: 2 },
    },
    {
      title: 'evidence commits are not changes, and no number goes below zero',
      executionContext: 'local',
      committed: 1,
      evidenceCommitted: 3,
      downgraded: 2,
      expected: { learned: 0, proposed: 0 },
    },
    {
      title: 'a negative kept-proposed count counts as zero',
      executionContext: 'local',
      committed: 3,
      evidenceCommitted: undefined,
      downgraded: -1,
      expected: { learned: 3, proposed: 0 },
    },
  ])('$title', ({ executionContext, committed, evidenceCommitted, downgraded, expected }) => {
    const result = knowledgeSummaryOfDrain({
      executionContext,
      complete: true,
      drain: {
        kind: 'drained',
        committed,
        ...(evidenceCommitted === undefined ? {} : { evidenceCommitted }),
        downgraded,
        requeued: 0,
      },
    })
    expect(result).toMatchObject({ ...expected, held: 0, items: [] })
    expect(result).not.toHaveProperty('runId')
  })

  it('a drain handed to a daemon says so in place of the numbers', () => {
    const result = knowledgeSummaryOfDrain({
      runId: 'r_phasis-label-purple-ligne',
      executionContext: 'local',
      complete: true,
      drain: { kind: 'handed-off', committed: 0, downgraded: 0, requeued: 0 },
    })
    expect(result.instead).toBe('handed to the daemon')
  })

  it.each([
    { context: 'local', resume: 'resumes on the next run' },
    { context: undefined, resume: 'resumes on the next run' },
    { context: 'ci', resume: CI_RESUME },
    { context: 'cloud', resume: CI_RESUME },
  ])('an unfinished drain in $context names the changes not written and when they resume', ({
    context,
    resume,
  }) => {
    const result = knowledgeSummaryOfDrain({
      executionContext: context,
      complete: false,
      drain: { kind: 'drained', committed: 5, downgraded: 0, requeued: 1 },
    })
    expect(result.unfinished).toEqual({ notWritten: 1, resume })
  })
})

describe('the resume words', () => {
  it.each([
    { context: 'local', resume: LOCAL_RESUME, pending: LOCAL_PENDING },
    { context: undefined, resume: LOCAL_RESUME, pending: LOCAL_PENDING },
    { context: 'ci', resume: CI_RESUME, pending: CI_RESUME },
    { context: 'cloud', resume: CI_RESUME, pending: CI_RESUME },
  ])('in $context a fold that ran here and a pending curation resume as they can', ({
    context,
    resume,
    pending,
  }) => {
    expect(knowledgeResumeWords(context)).toBe(resume)
    expect(knowledgePendingResumeWords(context)).toBe(pending)
  })
})

describe('the headline', () => {
  it.each([
    {
      title: 'learned and held',
      input: summary({ learned: 5, held: 3 }),
      line: 'learned 5, held 3',
    },
    {
      title: 'proposed is added when it is not zero',
      input: summary({ learned: 0, held: 0, proposed: 1 }),
      line: 'learned 0, held 0, proposed 1',
    },
    {
      title: 'words in place of the numbers stand alone',
      input: summary({ learned: 0, held: 0, instead: 'handed to the daemon' }),
      line: 'handed to the daemon',
    },
  ])('$title', ({ input, line }) => {
    expect(knowledgeHeadline(input)).toBe(line)
  })
})

describe('the second line', () => {
  it.each([
    { title: 'a finished summary has none', unfinished: undefined, line: undefined },
    {
      title: 'one change not written',
      unfinished: { notWritten: 1, resume: 'resumes on the next run' },
      line: '1 change not written, resumes on the next run',
    },
    {
      title: 'two changes not written',
      unfinished: { notWritten: 2, resume: 'resumes on the next run' },
      line: '2 changes not written, resumes on the next run',
    },
    {
      title: 'no count of changes reads not finished',
      unfinished: { notWritten: 0, resume: 'resumes on the next run' },
      line: 'not finished, resumes on the next run',
    },
    {
      title: 'the resume words are the ones the summary carries',
      unfinished: { notWritten: 0, resume: 'resumes on a later local run' },
      line: 'not finished, resumes on a later local run',
    },
    {
      title: 'in ci the second line is the resume limit',
      unfinished: { notWritten: 1, resume: CI_RESUME },
      line: `1 change not written, ${CI_RESUME}`,
    },
  ])('$title', ({ unfinished, line }) => {
    const input = summary(unfinished === undefined ? {} : { unfinished })
    expect(knowledgeSecondLine(input)).toBe(line)
  })
})

describe('the item lines', () => {
  it('give the outcome, eight characters of the id and the reason in plain words', () => {
    const input = summary({
      items: [
        { outcome: 'learned', id: ID_A, reason: 'deterministic-verdict-floor' },
        { outcome: 'held', id: ID_B, reason: 'no-element-observation' },
        { outcome: 'learned', id: ID_D, reason: 'user-sovereign' },
        { outcome: 'held', id: ID_E, reason: 'memory-off-anchor' },
      ],
    })
    expect(knowledgeItemLines(input)).toEqual([
      'learned  0b0a3ce0  verdict floor',
      'held     2300c56a  no element observation',
      'learned  7b5465ff  your decision',
      'held     e1e1e1e1  memory off for this anchor',
    ])
  })

  it('a summary with no items has no item lines', () => {
    expect(knowledgeItemLines(summary())).toEqual([])
  })
})

describe('the tagged message of the dashboard and the daemon', () => {
  const runId = 'r_phasis-label-purple-ligne'
  const items: KnowledgeSummaryItem[] = [
    { outcome: 'learned', id: ID_A, reason: 'deterministic-verdict-floor' },
    { outcome: 'held', id: ID_B, reason: 'no-element-observation' },
  ]

  it.each([
    {
      title: 'the headline with a capital and the short run id',
      input: summary({ runId, items }),
      verbose: false,
      message: 'Learned 2, held 1 · r_phasis-label',
    },
    {
      title: 'an unfinished summary adds its second line',
      input: summary({ runId, unfinished: { notWritten: 1, resume: 'resumes on the next run' } }),
      verbose: false,
      message: 'Learned 2, held 1 · r_phasis-label\n1 change not written, resumes on the next run',
    },
    {
      title: 'verbose adds each item line',
      input: summary({ runId, items }),
      verbose: true,
      message: [
        'Learned 2, held 1 · r_phasis-label',
        'learned  0b0a3ce0  verdict floor',
        'held     2300c56a  no element observation',
      ].join('\n'),
    },
    {
      title: 'verbose puts the item lines after the second line',
      input: summary({
        runId,
        items,
        unfinished: { notWritten: 0, resume: 'resumes on a later local run' },
      }),
      verbose: true,
      message: [
        'Learned 2, held 1 · r_phasis-label',
        'not finished, resumes on a later local run',
        'learned  0b0a3ce0  verdict floor',
        'held     2300c56a  no element observation',
      ].join('\n'),
    },
    {
      title: 'words in place of the numbers take the capital',
      input: summary({ runId, instead: 'handed to the daemon' }),
      verbose: false,
      message: 'Handed to the daemon · r_phasis-label',
    },
    {
      title: 'a summary with no run has nothing after the headline',
      input: summary({ items }),
      verbose: false,
      message: 'Learned 2, held 1',
    },
  ])('$title', ({ input, verbose, message }) => {
    expect(knowledgeTaggedMessage(input, { verbose })).toBe(message)
  })
})

describe('the short run id', () => {
  it.each([
    { runId: 'r_phasis-label-purple-ligne-asta', short: 'r_phasis-label' },
    { runId: 'r_phasis-label-purple', short: 'r_phasis-label' },
    { runId: 'r_phasis-label', short: 'r_phasis-label' },
    { runId: 'r_phasis', short: 'r_phasis' },
    { runId: 'run-fixture-1', short: 'run-fixture' },
  ])('$runId reads $short', ({ runId, short }) => {
    expect(shortRunId(runId)).toBe(short)
  })
})
