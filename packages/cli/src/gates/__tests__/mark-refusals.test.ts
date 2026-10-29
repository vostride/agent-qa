// 2026-10-03 (quick 261003-lgd, Phase 432 review WR-04 and IN-11): the mark host's refusals say
// what a retry can and cannot do, and who holds the writer lease.
//
// These cells live in their own file because the 432 mutation driver counts the cells of
// feedback-host.test.ts exactly.

import { describe, expect, it } from 'vitest'

import {
  KnowledgeWriterLeaseBusyError,
  MarkFixNotAppliedError,
  MarkWriterLeaseBusyError,
} from '../feedback-host.js'

describe('mark refusals name the way out', () => {
  // the target-not-found cell that stood here asserted a refusal
  // naming the intent file to remove. A refused planned fix now closes the mark under its own
  // identity with a not-applied receipt (mark-refused-fix-close.test.ts), and removing the intent
  // was measured not to free the address anyway (the gold freeze refused the next mark).
  it('a test-edit refusal a retry can clear still says to retry', () => {
    expect(new MarkFixNotAppliedError('write-failed').message).toContain('Retry the mark.')
    expect(new MarkFixNotAppliedError('target-changed').message).toContain('Retry the mark.')
  })

  // OBSERVED RED on agent-qa 481f0a153: both messages read "Another agent-qa process (pid <this pid>)".
  it('a lease held by this very process is not called another process', () => {
    const own = new MarkWriterLeaseBusyError(process.pid, 10_000).message
    expect(own).not.toContain('Another agent-qa process')
    expect(own).toContain(`This agent-qa process (pid ${process.pid}) is already writing to this knowledge store`)
    expect(own).toContain('Retry the mark when it finishes')
    const ownChange = new KnowledgeWriterLeaseBusyError(process.pid).message
    expect(ownChange).not.toContain('Another agent-qa process')
    expect(ownChange).toContain(`This agent-qa process (pid ${process.pid}) is already writing`)
    expect(ownChange).toContain('Retry the change when it finishes')
    const other = process.pid + 1
    expect(new MarkWriterLeaseBusyError(other, 10_000).message).toContain(`Another agent-qa process (pid ${other})`)
    expect(new KnowledgeWriterLeaseBusyError(other).message).toContain(`Another agent-qa process (pid ${other})`)
  })
})
