import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import * as agentLocal from '@vostride/agent-qa-agent-local'
import type { ApplyKnowledgeChangeInput, ExplicitReviewDelegation } from '@vostride/agent-qa-agent-local'
import { asEvidenceToken, asRecordId, type AuthoringDraftEditOutput, type ImprovementPlan, type MarkReceipt } from '@vostride/agent-qa-schema'
import { wordImprovementPlan } from '../feedback-wording.js'
import { createFeedbackPortForHost } from '../feedback-host.js'
import { markFixture, files, loadBundle, bundles, canonicalKnowledge, projectOutsideStores } from './feedback-fixture.js'

const { appendOutcomeEvent } = await import(new URL('../../../../knowledge-local/src/bundle-append.js', import.meta.url).href)
const { applyExplicitReview } = await import(new URL('../../../../knowledge-local/src/review/apply-review.js', import.meta.url).href)

type ApplyChange = typeof agentLocal.applyKnowledgeChange
/** The host's own direct knowledge writer, reached by name so a missing export fails as an assertion. */
function realApply(): ApplyChange {
  const apply = (agentLocal as Record<string, unknown>).applyKnowledgeChange
  expect(typeof apply, 'agent-local exports the direct knowledge change').toBe('function')
  return apply as ApplyChange
}

function applied(receipt: MarkReceipt) {
  expect(receipt.disposition.kind, 'the mark applied its fix').toBe('applied')
  if (receipt.disposition.kind !== 'applied') throw new Error('unreachable')
  return receipt.disposition
}

function testBugFixture() {
  const f = markFixture()
  const member = f.handoff.tests[0]!
  member.steps[0]!.servedBrief.channel3 = []
  member.rootCause = { class: 'test_bug', producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Assertion drift' }, memoryMisdirectionRuledOut: true, perTest: 0 }
  f.save()
  return f
}

/** An edit that wrote the member's file: the digest is of the exact UTF-8 bytes it wrote. */
function writtenEdit(filePath: string, testName: string, testId: string, text = 'steps:\n  - naïve café ✓ — 日本\n'): AuthoringDraftEditOutput {
  const contentDigest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  const draftRef = { filePath, testId, testName, contentDigest }
  // the edit answer carries no test-draft proposal arm.
  return { draftRef, editedFrom: { filePath, testName, boundBy: 'exact-ref' }, patches: [], thoughts: 'Correct assertion',
    written: { kind: 'written', filePath, contentDigest } }
}

/** Blocks the ledger's one atomic append, so the mark fails after every effect and before its receipt. */
function blockReceipt(runDir: string) {
  const staged = join(runDir, 'marks.jsonl.pending')
  mkdirSync(staged)
  return () => rmSync(staged, { recursive: true, force: true })
}

describe('feedback host', () => {
  let root: string | undefined
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const hashes = (dir: string) => files(dir).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
  // RE-SPELLED 432-09 from 'draft false-fail files a real mark fact proposal with user Supersede and
  // floor wording': the same floor-worded user Supersede now lands in the call.
  it('draft false-fail applies a real mark fact as a user Supersede with floor wording', async () => {
    const f = markFixture(); root = f.root
    let worded: ImprovementPlan | undefined
    const word = vi.fn<typeof wordImprovementPlan>(async input => { worded = await wordImprovementPlan(input); return worded })
    const port = createFeedbackPortForHost({ ...f.deps, word })
    const result = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge' } }, evidence: { confirmed: 1 } } })
    if (result.kind !== 'marked') throw new Error('expected a mark')
    const { change } = applied(result.receipt)
    if (change.kind !== 'knowledge') throw new Error('expected a knowledge change')
    const [replacementId] = change.recordIds
    expect(replacementId).toBeDefined()
    expect(replacementId).not.toBe(f.published.id)
    const victim = bundles(f.knowledgeRoot).find(row => row.id === f.published.id)!
    expect(victim.bundle.events).toContainEqual(expect.objectContaining({ type: 'superseded', byRecordId: replacementId }))
    expect(worded).toMatchObject({ wording: 'floor' })
    expect(existsSync(join(f.agentQaRoot, 'proposals')), 'nothing is filed for review').toBe(false)
    const before = hashes(root)
    expect(await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })).toEqual({ kind: 'already-marked', receipt: result.receipt })
    expect(hashes(root)).toEqual(before)
    expect(word).toHaveBeenCalledOnce()
    const next = await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
    expect(next).toMatchObject({ kind: 'marked', receipt: { supersedes: result.receipt.markId } })
    // The later mark supersedes this one and retracts nothing it applied.
    expect(bundles(f.knowledgeRoot).map(row => row.id)).toContain(replacementId)
  })

  it('resumes the same mark after a real busy knowledge lease without cleanup or a new ordinal', async () => {
    const f = markFixture(); root = f.root
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected authority')
    try {
      await expect(createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' }))
        .rejects.toThrow('writer lease held')
    } finally { LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: lease.leaseId }) }
    const outsideBefore = projectOutsideStores(f)
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 }, disposition: { kind: 'applied' } } })
    expect(projectOutsideStores(f)).toEqual(outsideBefore)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(files(f.runDir).some(path => path.endsWith('mark-intent.json'))).toBe(false)
    expect(await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' }))
      .toMatchObject({ kind: 'already-marked' })
  })

  it('resumes after fix publication and before receipt with one applied fix and its evidence', async () => {
    const f = markFixture(); root = f.root
    await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    const unblock = blockReceipt(f.runDir)
    await expect(createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-pass' })).rejects.toThrow()
    unblock()
    const outsideBefore = projectOutsideStores(f)
    const knowledgeBefore = canonicalKnowledge(f.knowledgeRoot)
    const word = vi.fn<typeof wordImprovementPlan>()
    const result = await createFeedbackPortForHost({ ...f.deps, word }).mark({ runId: f.handoff.runId, kind: 'false-pass' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 2 } })
    expect(word).not.toHaveBeenCalled()
    expect(projectOutsideStores(f)).toEqual(outsideBefore)
    expect(canonicalKnowledge(f.knowledgeRoot)).toEqual(knowledgeBefore)
    expect(existsSync(join(f.agentQaRoot, 'proposals'))).toBe(false)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('draft false-pass adds a caution and cancels this run helpful attribution', async () => {
    const f = markFixture(); root = f.root
    f.handoff.tests[0]!.steps[0]!.verifierVerdict.pass = true; f.save()
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected authority')
    try {
      appendOutcomeEvent({ knowledgeRoot: f.knowledgeRoot,
        productKey: 'storefront', writerLeaseId: lease.leaseId, writerEpoch: lease.epoch },
      asRecordId(f.published.id), { type: 'helpful', evidenceToken: asEvidenceToken('prior-feedback'),
        curationJobId: 'fixture-job', buildOrdinal: 45, observationId: `${f.handoff.runId}:test-0:step-0` })
    } finally { LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: lease.leaseId }) }
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-pass' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'applied', fix: 'caution' }, evidence: { overturned: 1 } } })
    expect(loadBundle(f.published.dir).bundle.events).toContainEqual(expect.objectContaining({ type: 'overturned' }))
  })
  it('false-pass overturns run evidence even with no served records on the marked step', async () => {
    const f = markFixture(); root = f.root
    f.handoff.tests[0]!.steps[0]!.servedBrief.channel3 = []
    f.handoff.tests[0]!.steps[0]!.verifierVerdict.pass = true; f.save()
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected authority')
    try {
      appendOutcomeEvent({ knowledgeRoot: f.knowledgeRoot,
        productKey: 'storefront', writerLeaseId: lease.leaseId, writerEpoch: lease.epoch },
      asRecordId(f.published.id), { type: 'helpful', evidenceToken: asEvidenceToken('unserved-feedback'),
        curationJobId: 'fixture-job', buildOrdinal: 45, observationId: `${f.handoff.runId}:test-0:step-0` })
    } finally { LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: lease.leaseId }) }
    expect(await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-pass' }))
      .toMatchObject({ kind: 'marked', receipt: { evidence: { confirmed: 0, overturned: 1 } } })
    expect(loadBundle(f.published.dir).bundle.events).toContainEqual(expect.objectContaining({ type: 'overturned' }))
  })

  // RE-SPELLED 432-09 from 'draft test_bug invokes authoring edit and files its real pending
  // test-draft identity': the edit writes the file in the call, and the receipt names that file.
  it('draft test_bug invokes authoring edit and records the test file it wrote', async () => {
    const f = testBugFixture(); root = f.root
    const member = f.handoff.tests[0]!
    const edited = writtenEdit(member.filePath!, member.testName!, member.testId!)
    const invokeAuthoringDraftEdit = vi.fn(async () => edited)
    const port = createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit })
    const result = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(invokeAuthoringDraftEdit).toHaveBeenCalledWith({ testRef: `${member.filePath}::${member.testName}`, intent: expect.any(String) })
    expect(result).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'applied', fix: 'test-edit',
      change: { kind: 'test-file', filePath: member.filePath, contentDigest: edited.written.kind === 'written' ? edited.written.contentDigest : '' } } } })
    expect(existsSync(join(f.agentQaRoot, 'proposals')), 'nothing is filed for review').toBe(false)
    // A later mark leaves the written file's fix standing and invokes no second edit.
    await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
    expect(invokeAuthoringDraftEdit).toHaveBeenCalledOnce()
  })

  it('a test edit that was not written leaves no receipt, and the retry edits again', async () => {
    const f = testBugFixture(); root = f.root
    const member = f.handoff.tests[0]!
    const edited = writtenEdit(member.filePath!, member.testName!, member.testId!)
    const refused: AuthoringDraftEditOutput = { ...edited, written: { kind: 'not-written', targetPath: member.filePath!, reason: 'target-changed' } }
    const invokeAuthoringDraftEdit = vi.fn<() => Promise<AuthoringDraftEditOutput>>()
      .mockResolvedValueOnce(refused).mockResolvedValueOnce(edited)
    const port = createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit })
    await expect(port.mark({ runId: f.handoff.runId, kind: 'false-fail' })).rejects.toThrow('target-changed')
    expect(existsSync(join(f.runDir, 'marks.jsonl'))).toBe(false)
    const result = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, disposition: { kind: 'applied', fix: 'test-edit' } } })
    expect(invokeAuthoringDraftEdit).toHaveBeenCalledTimes(2)
  })

  it('draft no-draftable-fix names the empty resolved evidence without filing a fallback', async () => {
    const f = markFixture(); root = f.root
    const member = f.handoff.tests[0]!
    member.steps[0]!.servedBrief.channel3 = []
    member.steps[0]!.verifierVerdict.pass = true
    member.rootCause = { class: 'app_bug', producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [], citedAnchors: [], citedArtifacts: [], rationale: 'Application bug' }, memoryMisdirectionRuledOut: true, perTest: 0 }
    f.save()
    const invokeAuthoringDraftEdit = vi.fn()
    const result = await createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit }).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false, rootCause: 'app_bug' } } } })
    expect(existsSync(join(f.agentQaRoot, 'proposals'))).toBe(false)
    expect(invokeAuthoringDraftEdit).not.toHaveBeenCalled()
  })

  it.each(['flake', 'environment', 'timeout'] as const)('quarantines %s with no knowledge bytes or proposal', async klass => {
    const f = markFixture(); root = f.root
    f.handoff.tests[0]!.rootCause = { class: klass, producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Recorded classification' }, memoryMisdirectionRuledOut: true, perTest: 0 }
    f.save()
    const before = [hashes(f.knowledgeRoot), projectOutsideStores(f)]
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'quarantined', class: klass }, rootCause: { class: klass, producer: 'deterministic-classifier' }, evidence: { confirmed: 0, overturned: 0 } } })
    expect([hashes(f.knowledgeRoot), projectOutsideStores(f)]).toEqual(before)
    expect(existsSync(join(f.agentQaRoot, 'proposals'))).toBe(false)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('already-marked repeats write no bytes; a changed re-mark supersedes the prior mark with ordinal 2', async () => {
    const f = markFixture(); root = f.root
    const port = createFeedbackPortForHost(f.deps)
    const first = await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
    if (first.kind !== 'marked') throw new Error('expected mark')
    const before = hashes(root)
    expect(await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })).toEqual({ kind: 'already-marked', receipt: first.receipt })
    expect(hashes(root)).toEqual(before)
    const second = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(second).toMatchObject({ kind: 'marked', receipt: { ordinal: 2, supersedes: first.receipt.markId } })
    if (second.kind !== 'marked') throw new Error('expected re-mark')
    expect(await port.marksFor(f.handoff.runId)).toEqual([second.receipt])
  })

  it('refuses ambiguous-address, member-not-found and step-not-found without appending', async () => {
    const f = markFixture(); root = f.root
    const port = createFeedbackPortForHost(f.deps)
    f.handoff.tests.push({ ...f.handoff.tests[0]!, testIndex: 1, testId: 'second-member' }); f.save()
    expect(await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })).toMatchObject({ kind: 'ambiguous-address', candidates: [{ testIndex: 0 }, { testIndex: 1 }] })
    expect(await port.mark({ runId: f.handoff.runId, testId: 'nope', kind: 'confirmed-bug' })).toMatchObject({ kind: 'member-not-found' })
    expect(await port.mark({ runId: f.handoff.runId, testId: f.handoff.tests[0]!.testId, stepIndex: 1, kind: 'confirmed-bug' })).toMatchObject({ kind: 'step-not-found', stepCount: 1 })
    expect(files(f.runDir).some(path => path.endsWith('marks.jsonl'))).toBe(false)
    expect(await port.mark({ runId: f.handoff.runId, testId: f.handoff.tests[0]!.testId, stepIndex: 0, kind: 'confirmed-bug' })).toMatchObject({ kind: 'marked' })
  })

  it('rerun members remain sovereign and disclose isRerun', async () => {
    const f = markFixture(); root = f.root
    f.handoff.tests[0]!.isRerun = true; f.save()
    expect(await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })).toMatchObject({ kind: 'marked', receipt: { isRerun: true } })
  })
  it('refuses an explicit duplicate test ID with the true member indexes before side effects', async () => {
    const f = markFixture(); root = f.root
    const first = f.handoff.tests[0]!
    f.handoff.tests.push({ ...first, testIndex: 1 }); f.save()
    const before = hashes(root)
    expect(await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId,
      testId: first.testId, kind: 'confirmed-bug' })).toEqual({
      kind: 'ambiguous-address', runId: f.handoff.runId,
      candidates: [{ testIndex: 0, testId: first.testId }, { testIndex: 1, testId: first.testId }],
    })
    expect(hashes(root)).toEqual(before)
  })
  it('a confirmed-bug mark records evidence and one ledger receipt and changes nothing outside .agent-qa and the knowledge root', async () => {
    const f = markFixture(); root = f.root
    const outside = projectOutsideStores(f)
    const port = createFeedbackPortForHost(f.deps)
    const result = await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, origin: 'user', disposition: { kind: 'confirmed-bug', confirmedRecords: 1 }, evidence: { confirmed: 1, overturned: 0 } } })
    if (result.kind !== 'marked') throw new Error('expected mark')
    expect(projectOutsideStores(f)).toEqual(outside)
    const lines = readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toEqual([result.receipt])
    expect(await port.marksFor(f.handoff.runId)).toEqual(lines)
    expect(loadBundle(f.published.dir).bundle.events).toContainEqual(expect.objectContaining({ type: 'confirmed', evidenceToken: `mark:${result.receipt.markId}` }))
    expect(existsSync(join(f.agentQaRoot, 'proposals'))).toBe(false)
  })
})

// A mark applies its fix in the call and returns an applied receipt.
describe('marks apply their fix once and return an applied receipt', () => {
  let root: string | undefined
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('the receipt names the records or test file changed, exactly as stored, and nothing is filed', async () => {
    const f = markFixture(); root = f.root
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    if (result.kind !== 'marked') throw new Error('expected a mark')
    const disposition = applied(result.receipt)
    expect(disposition).toMatchObject({ fix: 'fact', change: { kind: 'knowledge' } })
    if (disposition.change.kind !== 'knowledge') throw new Error('expected knowledge')
    const intentUuid = disposition.change.changeId.replace(/^prop_/, '')
    expect(disposition.change.changeId).toMatch(/^prop_[0-9a-f-]{36}$/)
    expect(intentUuid).toHaveLength(36)
    const stored = new Set(bundles(f.knowledgeRoot).map(row => row.id))
    expect(disposition.change.recordIds.length).toBeGreaterThan(0)
    for (const recordId of disposition.change.recordIds) expect(stored.has(recordId), recordId).toBe(true)
    // the receipt is the stored line, value for value; no ordinal or address is re-derived.
    const line = readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim()
    expect(JSON.parse(line)).toEqual(result.receipt)
    expect(Number.isInteger(result.receipt.ordinal) && result.receipt.ordinal === 1).toBe(true)
    expect([result.receipt.testIndex, result.receipt.stepIndex]).toEqual([f.handoff.tests[0]!.testIndex, undefined])
    expect(existsSync(join(f.agentQaRoot, 'proposals')), 'no inbox envelope').toBe(false)
    expect(existsSync(join(f.runDir, 'mark-intent.json'))).toBe(false)

    // The test-file arm keeps the digest of the exact UTF-8 bytes the edit wrote.
    const t = testBugFixture()
    try {
      const member = t.handoff.tests[0]!
      const edited = writtenEdit(member.filePath!, member.testName!, member.testId!)
      const marked = await createFeedbackPortForHost({ ...t.deps, invokeAuthoringDraftEdit: async () => edited })
        .mark({ runId: t.handoff.runId, kind: 'false-fail' })
      if (marked.kind !== 'marked') throw new Error('expected a mark')
      const written = edited.written.kind === 'written' ? edited.written : undefined
      expect(applied(marked.receipt)).toEqual({ kind: 'applied', fix: 'test-edit',
        change: { kind: 'test-file', filePath: member.filePath, contentDigest: written!.contentDigest } })
      expect(readFileSync(join(t.runDir, 'marks.jsonl'), 'utf8')).toContain(`"contentDigest":"${written!.contentDigest}"`)
      expect(existsSync(join(t.agentQaRoot, 'proposals'))).toBe(false)
    } finally { rmSync(t.root, { recursive: true, force: true }) }
  })

  const checkpoints = ['after evidence', 'after fix publication', 'before receipt'] as const
  it.each(checkpoints)('a knowledge mark interrupted %s lands its fix exactly once on retry', async checkpoint => {
    const f = markFixture(); root = f.root
    const real = realApply()
    let publications = 0
    let failPublication = checkpoint === 'after fix publication'
    const applyKnowledgeChange = vi.fn(async (input: ApplyKnowledgeChangeInput) => {
      const answer = await real(input)
      publications += 1
      if (failPublication) { failPublication = false; throw new Error('injected crash after publication') }
      return answer
    })
    let failWording = checkpoint === 'after evidence'
    const word = vi.fn<typeof wordImprovementPlan>(async input => {
      if (failWording) { failWording = false; throw new Error('injected crash after evidence') }
      return await wordImprovementPlan(input)
    })
    const deps = { ...f.deps, applyKnowledgeChange, word }
    let release = () => {}
    if (checkpoint === 'before receipt') release = blockReceipt(f.runDir)
    await expect(createFeedbackPortForHost(deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })).rejects.toThrow()
    release()
    expect(existsSync(join(f.runDir, 'marks.jsonl')), 'no receipt before the retry').toBe(false)
    const outside = projectOutsideStores(f)
    const knowledge = canonicalKnowledge(f.knowledgeRoot)
    const callsBefore = applyKnowledgeChange.mock.calls.length

    const result = await createFeedbackPortForHost(deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 }, disposition: { kind: 'applied', fix: 'fact' } } })
    expect(projectOutsideStores(f), 'nothing outside the stores is written').toEqual(outside)
    if (checkpoint === 'after fix publication' || checkpoint === 'before receipt') {
      expect(canonicalKnowledge(f.knowledgeRoot), 'the published fix is not published again').toEqual(knowledge)
    }
    if (checkpoint === 'before receipt') {
      expect(applyKnowledgeChange.mock.calls.length, 'a persisted applied fix is read back, never re-applied').toBe(callsBefore)
    }
    expect(publications, 'one publication per attempt that reached it').toBe(checkpoint === 'after fix publication' ? 2 : 1)
    if (result.kind !== 'marked') throw new Error('expected a mark')
    const { change } = applied(result.receipt)
    if (change.kind !== 'knowledge') throw new Error('expected knowledge')
    const victim = bundles(f.knowledgeRoot).find(row => row.id === f.published.id)!
    expect(victim.bundle.events.filter((event: { type: string }) => event.type === 'superseded')).toHaveLength(1)
    expect(victim.bundle.events.filter((event: { type: string; evidenceToken?: string }) =>
      event.type === 'confirmed' && event.evidenceToken === `mark:${result.receipt.markId}`), 'evidence once').toHaveLength(1)
    expect(bundles(f.knowledgeRoot)).toHaveLength(2)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(await createFeedbackPortForHost(deps).mark({ runId: f.handoff.runId, kind: 'false-fail' }))
      .toEqual({ kind: 'already-marked', receipt: result.receipt })
  })

  it('a test-edit mark interrupted before its receipt reuses the written file without a second edit', async () => {
    const f = testBugFixture(); root = f.root
    const member = f.handoff.tests[0]!
    const edited = writtenEdit(member.filePath!, member.testName!, member.testId!)
    const invokeAuthoringDraftEdit = vi.fn(async () => edited)
    const unblock = blockReceipt(f.runDir)
    await expect(createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit }).mark({ runId: f.handoff.runId, kind: 'false-fail' })).rejects.toThrow()
    unblock()
    const result = await createFeedbackPortForHost({ ...f.deps, invokeAuthoringDraftEdit }).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, disposition: { kind: 'applied', change: { kind: 'test-file', filePath: member.filePath } } } })
    expect(invokeAuthoringDraftEdit, 'the file is written once').toHaveBeenCalledOnce()
  })

  it('a fix that finds the writer lease held refuses by name, hands a delegate the validated request, and never steals the lease', async () => {
    const f = markFixture(); root = f.root
    const real = realApply()
    let holder: { leaseId: string; epoch: number } | undefined
    // The holder appears after evidence, exactly when the fix asks for the lease.
    const applyKnowledgeChange = vi.fn(async (input: ApplyKnowledgeChangeInput) => {
      const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
      if (lease.kind !== 'acquired') throw new Error('expected authority')
      holder = { leaseId: lease.leaseId, epoch: lease.epoch }
      return await real(input)
    })
    const releaseHolder = () => {
      if (holder !== undefined) LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: holder.leaseId })
      holder = undefined
    }
    try {
      await expect(createFeedbackPortForHost({ ...f.deps, applyKnowledgeChange }).mark({ runId: f.handoff.runId, kind: 'false-fail' }))
        .rejects.toThrow('writer lease for this knowledge root is held')
      expect(existsSync(join(f.runDir, 'marks.jsonl'))).toBe(false)
      expect(existsSync(join(f.runDir, 'mark-intent.json')), 'the intent survives for the retry').toBe(true)
      const lineageBefore = bundles(f.knowledgeRoot).map(row => row.id)
      releaseHolder()

      // With a delegate bound, the held lease routes the same request and identity to its holder.
      const delegations: ExplicitReviewDelegation[] = []
      const knowledgeChangeDelegate = vi.fn(async (delegation: ExplicitReviewDelegation) => {
        delegations.push(delegation)
        return await applyExplicitReview({ agentQaRoot: f.agentQaRoot, knowledgeRoot: f.knowledgeRoot,
          request: delegation.request, operationId: delegation.operationId, opId: 'runs.mark',
          executionContext: 'local-interactive', writerAuthority: holder })
      })
      const result = await createFeedbackPortForHost({ ...f.deps, applyKnowledgeChange, knowledgeChangeDelegate })
        .mark({ runId: f.handoff.runId, kind: 'false-fail' })
      expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 }, disposition: { kind: 'applied', fix: 'fact' } } })
      expect(knowledgeChangeDelegate).toHaveBeenCalledOnce()
      expect(Object.keys(delegations[0]!).sort()).toEqual(['operationId', 'request'])
      expect(delegations[0]!.request).toMatchObject({ verb: 'mark', input: { mark: { kind: 'false-fail' } } })
      if (result.kind !== 'marked') throw new Error('expected a mark')
      const { change } = applied(result.receipt)
      if (change.kind !== 'knowledge') throw new Error('expected knowledge')
      expect(change.changeId).toBe(`prop_${delegations[0]!.operationId}`)
      expect(bundles(f.knowledgeRoot).map(row => row.id)).toEqual(expect.arrayContaining(lineageBefore))
      // The lease was never taken from its holder: it is still the holder's to release.
      expect(LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot).kind).toBe('held')
    } finally { releaseHolder() }
  })

  it('a new mark on the address supersedes the earlier one, and the earlier applied fix stays readable', async () => {
    const f = markFixture(); root = f.root
    const port = createFeedbackPortForHost(f.deps)
    const first = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
    if (first.kind !== 'marked') throw new Error('expected a mark')
    const { change } = applied(first.receipt)
    if (change.kind !== 'knowledge') throw new Error('expected knowledge')
    const second = await port.mark({ runId: f.handoff.runId, kind: 'false-fail', note: 'The coupon field was hidden' })
    expect(second).toMatchObject({ kind: 'already-marked' })
    const third = await port.mark({ runId: f.handoff.runId, kind: 'confirmed-bug' })
    if (third.kind !== 'marked') throw new Error('expected a re-mark')
    expect(third.receipt).toMatchObject({ ordinal: 2, supersedes: first.receipt.markId })
    expect(await port.marksFor(f.handoff.runId), 'the latest mark is the one that counts').toEqual([third.receipt])
    const ids = bundles(f.knowledgeRoot).map(row => row.id)
    for (const recordId of change.recordIds) expect(ids, 'the earlier fix is not retracted').toContain(recordId)
    const ledger = readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as MarkReceipt)
    expect(ledger.map(receipt => receipt.disposition.kind)).toEqual(['applied', 'confirmed-bug'])
    expect(ledger[0]).toEqual(first.receipt)
    expect(existsSync(join(f.agentQaRoot, 'proposals')), 'no withdrawal is written anywhere').toBe(false)
  })
})
