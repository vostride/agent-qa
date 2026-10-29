// Mark history reads on a config that does not load. The history reads on a config that loads are
// in packages/cli/src/__tests__/mark-preview-history.test.ts.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import type { MarkReceipt } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { createFeedbackPortForHost } from '../feedback-host.js'
import { createFeedbackReadsPortForHost } from '../feedback-read-host.js'
import { files, markFixture } from './feedback-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('mark history on a config that does not load', () => {
  // A config holding a removed key fails strictly, and the MCP server deliberately starts on
  // one. OBSERVED RED on agent-qa 481f0a153: history() rejected with the config's own error.
  it('answers the changed records not-bound, and the rest of the history renders', async () => {
    const f = markFixture(); roots.push(f.root)
    const marked = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    if (marked.kind !== 'marked') throw new Error('expected a mark')
    const { disposition } = marked.receipt
    if (disposition.kind !== 'applied' || disposition.change.kind !== 'knowledge') throw new Error('expected a knowledge fix')
    const recordIds = disposition.change.recordIds
    expect(recordIds.length).toBeGreaterThan(0)
    writeFileSync(f.configPath, `${readFileSync(f.configPath, 'utf8')}safety:\n  trustMode: ask\n`)
    const before = files(f.root)

    const history = await createFeedbackReadsPortForHost({ agentQaRoot: f.agentQaRoot, configPath: f.configPath })
      .history(f.handoff.runId)
      .catch((error: unknown) => ({ kind: 'threw', name: (error as Error).name, message: (error as Error).message }))

    expect(history).toEqual({ kind: 'history', entries: [{ receipt: marked.receipt as MarkReceipt,
      changedRecords: recordIds.map(recordId => ({ recordId, contentAbsence: { reason: 'not-bound' } })) }] })
    expect(files(f.root), 'a read writes nothing').toEqual(before)
  })
})
