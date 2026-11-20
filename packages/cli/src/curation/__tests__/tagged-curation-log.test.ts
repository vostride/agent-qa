import { describe, expect, it } from 'vitest'

import type { KnowledgeSummary } from '../knowledge-summary.js'
import { createTaggedCurationLog } from '../tagged-curation-log.js'

interface PrintedLine {
  tag: string
  level: 'warn' | 'info'
  message: string
}

const RUN_ID = 'run-fixture-1'

const SUMMARY: KnowledgeSummary = {
  runId: RUN_ID,
  learned: 2,
  held: 1,
  proposed: 0,
  items: [
    { outcome: 'learned', id: '0b0a3ce0aa11bb22', reason: 'deterministic-verdict-floor' },
    { outcome: 'held', id: '2300c56acc33dd44', reason: 'no-element-observation' },
  ],
}

function logAt(logLevel: string) {
  const printed: PrintedLine[] = []
  const log = createTaggedCurationLog({
    logLevel,
    print: (line) => {
      printed.push({ ...line })
    },
  })
  return { log, printed }
}

describe('the tagged curation log', () => {
  it('prints the summary as one knowledge line and drops detail at the default level', () => {
    const { log, printed } = logAt('warn')

    log.summary?.(SUMMARY)
    log.detail?.('digest — run run-fixture-1', 'post-run')
    log.detail?.('commit was a no-op')

    expect(printed).toEqual([
      { tag: 'knowledge', level: 'info', message: 'Learned 2, held 1 · run-fixture' },
    ])
  })

  it('puts the second line of an unfinished summary after a line break', () => {
    const { log, printed } = logAt('warn')

    log.summary?.({
      ...SUMMARY,
      unfinished: { notWritten: 1, resume: 'resumes on the next run' },
    })

    expect(printed).toEqual([
      {
        tag: 'knowledge',
        level: 'info',
        message: 'Learned 2, held 1 · run-fixture\n1 change not written, resumes on the next run',
      },
    ])
  })

  it('prints a warning as one post-run warn line', () => {
    const { log, printed } = logAt('warn')

    log.warn('quarantined test still failing')

    expect(printed).toEqual([
      { tag: 'post-run', level: 'warn', message: 'quarantined test still failing' },
    ])
  })

  it('prints detail lines under their own tag, or knowledge, and adds the items to the summary at debug', () => {
    const { log, printed } = logAt('debug')

    log.detail?.('digest — run run-fixture-1', 'post-run')
    log.detail?.('commit was a no-op')
    log.summary?.(SUMMARY)

    expect(printed).toEqual([
      { tag: 'post-run', level: 'info', message: 'digest — run run-fixture-1' },
      { tag: 'knowledge', level: 'info', message: 'commit was a no-op' },
      {
        tag: 'knowledge',
        level: 'info',
        message: [
          'Learned 2, held 1 · run-fixture',
          'learned  0b0a3ce0  verdict floor',
          'held     2300c56a  no element observation',
        ].join('\n'),
      },
    ])
  })
})
