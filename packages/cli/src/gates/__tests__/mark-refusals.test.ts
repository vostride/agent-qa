// The mark host's refusals say what a retry can do and who holds the writer lease.

import { describe, expect, it } from 'vitest'

import {
  KnowledgeWriterLeaseBusyError,
  MarkFixNotAppliedError,
  MarkWriterLeaseBusyError,
} from '../feedback-host.js'

describe('mark refusals name the way out', () => {
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
