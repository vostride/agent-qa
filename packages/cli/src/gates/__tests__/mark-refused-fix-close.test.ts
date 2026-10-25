// A mark whose own planned fix is refused closes under its own identity with a terminal
// not-applied receipt.
//
// A retry reuses the fix the mark already planned, so a refusal that comes from that plan (its
// knowledge target is gone, its policy text is refused, its test file is outside the workspace)
// would recur on every retry. The mark closes with `{ kind: 'not-applied', fix, reason }` instead:
// its evidence stays counted once under its own markId, an identical repeat answers
// `already-marked`, and the run takes a new mark.
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { ApplyKnowledgeChangeInput } from '@vostride/agent-qa-agent-local'
import type { AuthoringDraftEditOutput } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFeedbackPortForHost } from '../feedback-host.js'
import { bundles, files, markFixture } from './feedback-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function markTokens(f: ReturnType<typeof markFixture>, markId: string): number {
  const victim = bundles(f.knowledgeRoot).find(row => row.id === f.published.id)!
  return victim.bundle.events.filter((event: { evidenceToken?: string }) =>
    event.evidenceToken === `mark:${markId}`).length
}

describe('a refused planned fix closes the mark under its own identity (261003-mqc)', () => {
  it.each(['target-not-found', 'policy-materialize-refused'] as const)(
    'a knowledge fix answered %s: one not-applied receipt, evidence once, and the run takes a new mark',
    async outcome => {
      const f = markFixture(); roots.push(f.root)
      const applyKnowledgeChange = vi.fn(async (input: ApplyKnowledgeChangeInput) => ({
        outcome, verb: 'mark' as const, changeId: `prop_${input.operationId}`,
        ...(outcome === 'target-not-found' ? { target: { grain: 'record' as const, recordId: 'rec-gone' } } : {}),
      }) as never)
      const port = () => createFeedbackPortForHost({ ...f.deps, applyKnowledgeChange })

      const first = await port().mark({ runId: f.handoff.runId, kind: 'false-fail' })
        .catch((error: unknown) => ({ kind: 'threw' as const, name: (error as Error).name }))

      expect(first).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, kind: 'false-fail',
        disposition: { kind: 'not-applied', reason: outcome } } })
      if (first.kind !== 'marked') throw new Error('expected a receipt')
      expect(first.receipt.disposition).toMatchObject({ fix: expect.any(String) })
      expect(applyKnowledgeChange, 'the planned fix was attempted once').toHaveBeenCalledOnce()
      expect(markTokens(f, first.receipt.markId), 'evidence once under the mark\'s own id').toBe(1)
      expect(files(f.runDir).filter(path => path.includes('mark-intent') || path.includes('mark-edit')))
        .toEqual([])

      // An identical repeat answers the receipt; nothing is planned or counted again.
      expect(await port().mark({ runId: f.handoff.runId, kind: 'false-fail' }))
        .toEqual({ kind: 'already-marked', receipt: first.receipt })
      expect(applyKnowledgeChange).toHaveBeenCalledOnce()

      // The run takes a new mark, which supersedes the closed one.
      const next = await port().mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
      expect(next).toMatchObject({ kind: 'marked', receipt: { ordinal: 2, kind: 'confirmed-bug',
        supersedes: first.receipt.markId } })
      expect(markTokens(f, first.receipt.markId), 'the closed mark\'s evidence still counts once').toBe(1)
      expect(existsSync(join(f.runDir, 'mark-intent.json'))).toBe(false)
    },
  )

  it('a test edit refused as outside-workspace: one not-applied receipt, and the run takes a new mark', async () => {
    const f = markFixture(); roots.push(f.root)
    const member = f.handoff.tests[0]!
    member.steps[0]!.servedBrief.channel3 = []
    member.rootCause = { class: 'test_bug', producer: 'deterministic-classifier', confidence: 1,
      evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Assertion drift' },
      memoryMisdirectionRuledOut: true, perTest: 0 }
    f.save()
    const filePath = member.filePath!
    const refusal: AuthoringDraftEditOutput = {
      draftRef: { filePath, testId: member.testId!, testName: member.testName!, contentDigest: 'a'.repeat(64) },
      editedFrom: { filePath, testName: member.testName!, boundBy: 'exact-ref' }, patches: [],
      thoughts: 'Correct assertion', written: { kind: 'not-written', targetPath: filePath, reason: 'outside-workspace' },
    }
    const invokeAuthoringDraftEdit = vi.fn(async () => refusal)
    const port = () => createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit })

    const first = await port().mark({ runId: f.handoff.runId, kind: 'false-fail' })
      .catch((error: unknown) => ({ kind: 'threw' as const, name: (error as Error).name }))

    expect(first).toMatchObject({ kind: 'marked', receipt: { ordinal: 1,
      disposition: { kind: 'not-applied', fix: 'test-edit', reason: 'outside-workspace' } } })
    if (first.kind !== 'marked') throw new Error('expected a receipt')
    expect(invokeAuthoringDraftEdit, 'the model was asked once').toHaveBeenCalledOnce()
    expect(await port().mark({ runId: f.handoff.runId, kind: 'false-fail' }))
      .toEqual({ kind: 'already-marked', receipt: first.receipt })
    expect(invokeAuthoringDraftEdit).toHaveBeenCalledOnce()
    expect(await port().mark({ runId: f.handoff.runId, kind: 'confirmed-bug' }))
      .toMatchObject({ kind: 'marked', receipt: { ordinal: 2, supersedes: first.receipt.markId } })
  })

  it('a refusal a retry can clear still throws and keeps the intent for the retry', async () => {
    const f = markFixture(); roots.push(f.root)
    const member = f.handoff.tests[0]!
    member.steps[0]!.servedBrief.channel3 = []
    member.rootCause = { class: 'test_bug', producer: 'deterministic-classifier', confidence: 1,
      evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Assertion drift' },
      memoryMisdirectionRuledOut: true, perTest: 0 }
    f.save()
    const filePath = member.filePath!
    const invokeAuthoringDraftEdit = vi.fn(async (): Promise<AuthoringDraftEditOutput> => ({
      draftRef: { filePath, testId: member.testId!, testName: member.testName!, contentDigest: 'a'.repeat(64) },
      editedFrom: { filePath, testName: member.testName!, boundBy: 'exact-ref' }, patches: [],
      thoughts: 'Correct assertion', written: { kind: 'not-written', targetPath: filePath, reason: 'write-failed' },
    }))
    await expect(createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit })
      .mark({ runId: f.handoff.runId, kind: 'false-fail' })).rejects.toThrow('Retry the mark.')
    expect(existsSync(join(f.runDir, 'mark-intent.json'))).toBe(true)
    expect(existsSync(join(f.runDir, 'marks.jsonl'))).toBe(false)
  })
})
