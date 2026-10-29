// 2026-09-15, 423 D-16: the consequence plan runs.mark consumes, previewed with no write.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as agent from '@vostride/agent-qa-agent'
import { createKnowledgeReader, FsMarkLedger, LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { createRunServiceRoutes, DashboardDatabase, startServer, type RunServicePorts } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { AGENT_QA_OP_CONTRACTS, UNPROJECTED_OPS } from '@vostride/agent-qa-mcp'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { asEvidenceToken, asRecordId, asRunId, RunsEvidenceInputSchema, RunsMarkInputSchema, RunsMarksHistoryInputSchema, RunsMarkOutcomeSchema, RunsMarkPreviewResultSchema, type FeedbackReadsPort, type MarkReceipt, type RunId, type RunsMarkInput, type RunsMarkPreviewResult, type RunsMarksHistoryResult, RunsMarksHistoryResultSchema } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { composeDashboardDoor, DASHBOARD_FUNCTION_CALLER } from '../commands/dashboard.js'
import { createFnCommand } from '../commands/fn.js'
import * as host from '../composition/local-agent-host.js'
import { createFeedbackPortForHost } from '../gates/feedback-host.js'
import { createFeedbackReadsPortForHost, type FeedbackReadsHostDeps } from '../gates/feedback-read-host.js'
import { previewMarkConsequences as preview } from '../gates/feedback-plan.js'
import { files, markFixture } from '../gates/__tests__/feedback-fixture.js'
import { RUN_SERVICE_ROUTE_BINDINGS, registryDeclarations } from './conformance/adapters.js'
import { catalogDocFieldsOf } from './conformance/catalog.js'
import { censusDiff, OP_INPUT_CONTRACTS, scenarioRowFor, scenarioTableOpIds, unprojectedReasonKeyOf } from './conformance/scenario-table.js'

// The preview resolves config through resolveConfig and never touches the eval session or the
// wording model, so both refuse while a preview runs.
const denial = vi.hoisted(() => ({ active: false }))
vi.mock('../eval-session-composition.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../eval-session-composition.js')>()
  return { ...actual,
    resolveEvalSession: async (input?: Parameters<typeof actual.resolveEvalSession>[0]) => {
      if (denial.active) throw new Error('preview must not call resolveEvalSession')
      return await actual.resolveEvalSession(input) } }
})
vi.mock('../gates/feedback-wording.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../gates/feedback-wording.js')>()
  return { ...actual, wordImprovementPlan: async (...args: Parameters<typeof actual.wordImprovementPlan>) => {
    if (denial.active) throw new Error('preview must not call wordImprovementPlan')
    return await actual.wordImprovementPlan(...args) } }
})

const { runsMarksHistorySpec } = await import(new URL('../../../agent/src/functions/ops/runs-marks-history.js', import.meta.url).href)
const { runsMarkPreviewSpec } = await import(new URL('../../../agent/src/functions/ops/runs-mark-preview.js', import.meta.url).href)
const { showRecords } = await import(new URL('../../../knowledge-local/src/show-records.js', import.meta.url).href)
const { appendOutcomeEvent } = await import(new URL('../../../knowledge-local/src/bundle-append.js', import.meta.url).href)
const { createPromotionFloorFixture } = await import(new URL('../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url).href)

const refuse = (name: string) => () => { throw new Error(`preview must not call ${name}`) }
/** Every writer, lease and draft capability throws; only the deterministic reads remain. */
function readOnlyCuration() {
  return { ...LOCAL_CURATION_CAPABILITIES,
    appendMarkEvidence: refuse('appendMarkEvidence'),
    maintenance: { ...LOCAL_CURATION_CAPABILITIES.maintenance,
      acquireWriterLease: refuse('acquireWriterLease'), releaseLease: refuse('releaseLease') } }
}

const hashes = (dir: string) => files(dir).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])

describe('shared mark consequence plan', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  function fixture() {
    const f = markFixture(); roots.push(f.root)
    return { ...f, previewDeps: { configPath: f.configPath, agentQaRoot: f.agentQaRoot, curation: readOnlyCuration() } }
  }

  it('PREVIEW-REFUSAL-PARITY: a missing run, member or step and an ambiguous address match runs.mark with no bytes', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const member = f.handoff.tests[0]!
    f.handoff.tests.push({ ...member, testIndex: 1, testId: 'second-member' }); f.save()
    const port = createFeedbackPortForHost(f.deps)
    const inputs: RunsMarkInput[] = [
      { runId: asRunId(generateRunId()), kind: 'confirmed-bug' },
      { runId, testId: 'absent-member', kind: 'false-fail' },
      { runId, kind: 'confirmed-bug' },
      { runId, testId: member.testId!, stepIndex: 4, kind: 'false-pass' },
    ]
    const kinds: unknown[] = []
    for (const input of inputs) {
      const before = hashes(f.root)
      const previewed = await preview(f.previewDeps, input)
      expect(hashes(f.root)).toEqual(before)
      const written = await port.mark(input)
      expect(previewed).toEqual(written)
      // The strict outcome schema pins the unchanged writer wire shape, which a shared plan could otherwise drift together.
      expect(RunsMarkOutcomeSchema.parse(written)).toEqual(written)
      expect(hashes(f.root)).toEqual(before)
      kinds.push(written.kind)
    }
    expect(kinds).toEqual(['run-not-found', 'member-not-found', 'ambiguous-address', 'step-not-found'])
    expect(new FsMarkLedger({ root: f.agentQaRoot, runId }).read()).toEqual([])
    expect(await port.marksFor(runId)).toEqual([])
    expect(await preview(f.previewDeps, { runId, testId: member.testId!, kind: 'confirmed-bug' }))
      .toMatchObject({ kind: 'consequences', latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 } })
  })

  it('NOTE-ONLY-REPEAT: a note-only change previews already-marked; a changed kind previews supersession', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const port = createFeedbackPortForHost(f.deps)
    const first = await port.mark({ runId, kind: 'confirmed-bug', note: 'first note' })
    if (first.kind !== 'marked') throw new Error('expected the first mark')
    const before = hashes(f.root)
    const repeat: RunsMarkInput = { runId, kind: 'confirmed-bug', note: 'a different note' }
    expect(await preview(f.previewDeps, repeat))
      .toEqual({ kind: 'already-marked', receipt: first.receipt, basis: { ledgerOrdinal: 1, priorOrdinal: 1 } })
    expect(hashes(f.root)).toEqual(before)
    expect(await port.mark(repeat)).toEqual({ kind: 'already-marked', receipt: first.receipt })
    const rekinded: RunsMarkInput = { runId, kind: 'false-fail', note: 'first note' }
    const superseding = await preview(f.previewDeps, rekinded)
    expect(superseding).toMatchObject({ kind: 'consequences',
      latest: { kind: 'supersedes', markId: first.receipt.markId, ordinal: 1 }, basis: { ledgerOrdinal: 1, priorOrdinal: 1 } })
    expect(superseding).not.toHaveProperty('withdraws')
    expect(hashes(f.root)).toEqual(before)
    expect(await port.mark(rekinded))
      .toMatchObject({ kind: 'marked', receipt: { ordinal: 2, supersedes: first.receipt.markId } })
  })

  it('QUARANTINE-ORDER: step refusal precedes quarantine', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const member = f.handoff.tests[0]!
    member.rootCause = { class: 'flake', producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Recorded classification' }, memoryMisdirectionRuledOut: true, perTest: 0 }
    f.save()
    const port = createFeedbackPortForHost(f.deps)
    const before = hashes(f.root)
    const missing: RunsMarkInput = { runId, stepIndex: 3, kind: 'false-fail' }
    const refused = await preview(f.previewDeps, missing)
    expect(refused).toMatchObject({ kind: 'step-not-found', stepCount: 1 })
    expect(refused).toEqual(await port.mark(missing))
    const quarantinable: RunsMarkInput = { runId, kind: 'false-fail' }
    expect(await preview(f.previewDeps, quarantinable)).toEqual({ kind: 'quarantined', class: 'flake', member: { testIndex: 0, testId: member.testId },
      resolvedStep: { stepIndex: 0, reason: 'failing-step' }, latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 } })
    expect(hashes(f.root)).toEqual(before)
    expect(await port.mark(quarantinable)).toMatchObject({ kind: 'marked',
      receipt: { disposition: { kind: 'quarantined', class: 'flake' }, evidence: { confirmed: 0, overturned: 0 } } })
  })

  // No mark withdraws anything: a superseding mark leaves the prior applied fix in place, on every arm.
  it('PRIOR-FIX-STAYS: no preview or superseding mark withdraws the prior applied fix; repeats, refusals and quarantine change nothing', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const port = createFeedbackPortForHost(f.deps)
    const first = await port.mark({ runId, kind: 'false-fail' })
    if (first.kind !== 'marked' || first.receipt.disposition.kind !== 'applied'
      || first.receipt.disposition.change.kind !== 'knowledge') throw new Error('expected an applied knowledge fix')
    const { recordIds } = first.receipt.disposition.change
    const before = hashes(f.root)
    const repeated = await preview(f.previewDeps, { runId, kind: 'false-fail', note: 'only the note moved' })
    expect(repeated).toMatchObject({ kind: 'already-marked' })
    expect(repeated).not.toHaveProperty('withdraws')
    expect(await preview(f.previewDeps, { runId, stepIndex: 2, kind: 'confirmed-bug' })).toMatchObject({ kind: 'step-not-found' })

    const scratch = mkdtempSync(join(tmpdir(), '423-35-withdrawal-')); roots.push(scratch)
    cpSync(f.root, scratch, { recursive: true })
    const copy = { configPath: join(scratch, 'agent-qa.config.yaml'), agentQaRoot: join(scratch, '.agent-qa') }
    const quarantinedHandoff = { ...f.handoff, tests: [{ ...f.handoff.tests[0]!, rootCause: { class: 'timeout' as const, producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Recorded classification' }, memoryMisdirectionRuledOut: true, perTest: 0 } }] }
    writeFileSync(join(copy.agentQaRoot, 'runs', f.runDir.split('/').at(-1)!, 'handoff.json'), JSON.stringify(quarantinedHandoff))
    const quarantined = await preview({ ...copy, curation: readOnlyCuration() }, { runId, kind: 'confirmed-bug' })
    expect(quarantined).toMatchObject({ kind: 'quarantined', class: 'timeout', latest: { kind: 'supersedes', markId: first.receipt.markId } })
    expect(quarantined).not.toHaveProperty('withdraws')
    expect(await createFeedbackPortForHost({ ...f.deps, ...copy }).mark({ runId, kind: 'confirmed-bug' }))
      .toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'quarantined' }, supersedes: first.receipt.markId } })

    const effect = await preview(f.previewDeps, { runId, kind: 'confirmed-bug' })
    expect(effect).toMatchObject({ kind: 'consequences', latest: { kind: 'supersedes', markId: first.receipt.markId, ordinal: 1 } })
    expect(effect).not.toHaveProperty('withdraws')
    expect(hashes(f.root)).toEqual(before)
    expect(await port.mark({ runId, kind: 'confirmed-bug' })).toMatchObject({ kind: 'marked', receipt: { supersedes: first.receipt.markId } })
    const knowledgeRoot = join(f.root, 'agent-qa-knowledge')
    const stored = await createKnowledgeReader(() => knowledgeRoot).showRecords!({ recordIds: [...recordIds] })
    expect(stored.map(result => result.kind), 'the prior applied fix is still in the store').toEqual(recordIds.map(() => 'found'))
    expect(existsSync(join(f.agentQaRoot, 'proposals')), 'nothing is filed or withdrawn').toBe(false)
  })

  it('the previewed step, served evidence and draft target are the ones the writer lands', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const before = hashes(f.root)
    const previewed = await preview(f.previewDeps, { runId, kind: 'false-fail' })
    expect(hashes(f.root)).toEqual(before)
    expect(JSON.stringify(previewed)).not.toMatch(/mark_[0-9a-f]{12}/)
    expect(previewed).toMatchObject({ kind: 'consequences', resolvedStep: { stepIndex: 0, reason: 'failing-step' },
      knowledge: { servedRecordIds: [f.published.id], appendsEvidence: true },
      draft: { kind: 'knowledge', fix: 'fact', target: { grain: 'record', recordId: f.published.id } },
      latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 } })
    const written = await createFeedbackPortForHost(f.deps).mark({ runId, kind: 'false-fail' })
    if (written.kind !== 'marked' || previewed.kind !== 'consequences') throw new Error('expected mark')
    expect(written.receipt.evidence.confirmed).toBe(1)
    // The previewed knowledge fix is the one the writer applies, on the previewed target.
    expect(written.receipt.disposition).toMatchObject({ kind: 'applied', fix: 'fact', change: { kind: 'knowledge' } })
  })
})

// 2026-09-15, 423 D-19: marks history over the real ledger, observed with no write.
// 2026-09-30, 432-09 (D-04/D-22/D-25): history projects each mark's applied change and never reads
// the retired proposal inbox, readable or not.
const SECRET = 'synthetic-423-18-history-token'
const CHIP = '[secret:HISTORY_SYNTHETIC_TOKEN]'
type Mask = (text: string) => string
function declaredMask(secrets: Record<string, string>): Mask {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}
const identity: Mask = text => text
type HistoryReadsDeps = FeedbackReadsHostDeps

/** Every path under a root, directories included, so a created directory is a visible change. */
function tree(root: string): [string, string][] {
  if (!existsSync(root)) return [[root, 'absent']]
  const walk = (path: string): [string, string][] => lstatSync(path).isDirectory()
    ? [[path, 'dir'], ...readdirSync(path).sort().flatMap(name => walk(join(path, name)))]
    : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  return walk(root)
}

const readsFor = (deps: HistoryReadsDeps): FeedbackReadsPort => createFeedbackReadsPortForHost(deps)

const historyOf = async (reads: FeedbackReadsPort, runId: RunId, secretMask: Mask | null = identity): Promise<RunsMarksHistoryResult> =>
  await runsMarksHistorySpec.invoke({ runId }, { feedbackReads: reads, ...(secretMask === null ? {} : { secretMask }) } as never)

function historyEntries(result: RunsMarksHistoryResult) {
  if (result.kind !== 'history') throw new Error(`expected history, got ${result.kind}`)
  return result.entries
}

function changedRecordIdsOf(receipt: MarkReceipt): readonly string[] {
  if (receipt.disposition.kind !== 'applied' || receipt.disposition.change.kind !== 'knowledge') {
    throw new Error('expected an applied knowledge change')
  }
  return receipt.disposition.change.recordIds
}

type MarkedTemplate = { root: string; runSlug: string; runId: RunId; receipts: MarkReceipt[] }

/** Three real marks: an applied run-level fix, its confirmed-bug successor (which retracts nothing), and an applied step fix. */
async function markedTemplate(roots: string[]): Promise<MarkedTemplate> {
  const f = markFixture(); roots.push(f.root)
  const runId = f.handoff.runId
  const port = createFeedbackPortForHost(f.deps)
  const receipts: MarkReceipt[] = []
  for (const input of [
    { runId, kind: 'false-fail', note: 'first run-level note' },
    { runId, kind: 'confirmed-bug' },
    { runId, stepIndex: 0, kind: 'false-fail', note: `step note ${SECRET}` },
  ] satisfies RunsMarkInput[]) {
    const outcome = await port.mark(input)
    if (outcome.kind !== 'marked') throw new Error(`fixture mark refused: ${outcome.kind}`)
    receipts.push(outcome.receipt)
  }
  expect(receipts.map(receipt => receipt.disposition.kind)).toEqual(['applied', 'confirmed-bug', 'applied'])
  return { root: f.root, runSlug: f.runDir.split('/').at(-1)!, runId, receipts }
}

describe('read-only marks history host', () => {
  const roots: string[] = []
  let template: MarkedTemplate

  beforeAll(async () => { template = await markedTemplate(roots) }, 180_000)
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function scene() {
    const root = mkdtempSync(join(tmpdir(), '423-18-history-')); roots.push(root)
    cpSync(template.root, root, { recursive: true })
    const agentQaRoot = join(root, '.agent-qa')
    const runDir = join(agentQaRoot, 'runs', template.runSlug)
    return { root, agentQaRoot, runDir, configPath: join(root, 'agent-qa.config.yaml'),
      ledger: join(runDir, 'marks.jsonl'), proposals: join(agentQaRoot, 'proposals') }
  }

  it('HISTORY-WRITES-NOTHING: history leaves ledger, intent, gold and knowledge byte-identical and creates nothing', async () => {
    const s = scene()
    const [first, second, third] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    // An in-flight intent is exactly what a writer would clean up.
    writeFileSync(join(s.runDir, 'mark-intent.json'), '{"stage":"prepared"}\n')
    const before = tree(s.root)
    const reads = readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath })
    const result = await historyOf(reads, template.runId)
    expect(result).toMatchObject({ kind: 'history', runId: template.runId, entries: [
      { markId: first.markId, ordinal: 1, active: false, supersededBy: second.markId, disposition: { kind: 'applied' } },
      { markId: second.markId, ordinal: 2, active: true, supersedes: first.markId },
      { markId: third.markId, ordinal: 3, active: true, stepIndex: 0, disposition: { kind: 'applied' } },
    ] })
    expect(historyEntries(result)[1]).not.toHaveProperty('changedRecords')
    expect(await historyOf(reads, template.runId)).toEqual(result)
    expect(tree(s.root)).toEqual(before)

    // An unmarked run answers an empty history without creating a ledger, lock or intent.
    const bare = markFixture(); roots.push(bare.root)
    const bareBefore = tree(bare.root)
    expect(await historyOf(readsFor({ agentQaRoot: bare.agentQaRoot }), bare.handoff.runId))
      .toEqual({ kind: 'history', runId: bare.handoff.runId, entries: [] })
    expect(tree(bare.root)).toEqual(bareBefore)

    // A run this root never recorded, and a root that was never created, stay absent.
    const unknown = asRunId(generateRunId())
    expect(await historyOf(reads, unknown)).toEqual({ kind: 'run-not-found', runId: unknown })
    expect(tree(s.root)).toEqual(before)
    const fresh = mkdtempSync(join(tmpdir(), '423-18-fresh-')); roots.push(fresh)
    const absentRoot = join(fresh, 'never-created', '.agent-qa')
    expect(await historyOf(readsFor({ agentQaRoot: absentRoot }), template.runId)).toEqual({ kind: 'run-not-found', runId: template.runId })
    expect(tree(fresh)).toEqual([[fresh, 'dir']])
    expect(existsSync(dirname(absentRoot))).toBe(false)
  })

  // RE-SPELLED 432-09 from 'PROPOSAL-CURRENT/MISSING: drafted receipts join the store classifier
  // state; missing never reads as pending': history now joins the records each fix changed.
  it('each applied fix joins the records it changed, read now; an unbound or missing record is a typed absence', async () => {
    const s = scene()
    const [first, , third] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    const current = historyEntries(await historyOf(readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath }), template.runId))
    expect(current.map(entry => entry.disposition.kind)).toEqual(['applied', 'confirmed-bug', 'applied'])
    // The receipt's own applied change is carried verbatim, precise ids and all.
    expect(current[0]!.disposition).toEqual(first.disposition)
    expect(current[2]!.disposition).toEqual(third.disposition)
    expect(current[0]!.changedRecords!.map(record => record.recordId)).toEqual(changedRecordIdsOf(first))
    expect(current[2]!.changedRecords!.map(record => record.recordId)).toEqual(changedRecordIdsOf(third))
    for (const record of [...current[0]!.changedRecords!, ...current[2]!.changedRecords!]) {
      expect(record.recordContent?.content, record.recordId).toEqual(expect.any(String))
      expect(record).not.toHaveProperty('contentAbsence')
    }
    expect(current[1]).not.toHaveProperty('changedRecords')

    // A host with no knowledge root binds no batch read: the ids stay, the content is a named absence.
    const unbound = historyEntries(await historyOf(readsFor({ agentQaRoot: s.agentQaRoot }), template.runId))
    expect(unbound[0]!.changedRecords).toEqual(changedRecordIdsOf(first).map(recordId => ({ recordId, contentAbsence: { reason: 'not-bound' } })))

    // A record gone from the store keeps its id and reads not-found, never an invented content.
    rmSync(join(s.root, 'agent-qa-knowledge'), { recursive: true, force: true })
    const missing = historyEntries(await historyOf(readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath }), template.runId))
    expect(missing[0]!.changedRecords).toEqual(changedRecordIdsOf(first).map(recordId => ({ recordId, contentAbsence: { reason: 'not-found' } })))
    expect(missing.map(entry => entry.disposition.kind)).toEqual(['applied', 'confirmed-bug', 'applied'])
  })

  it('an unreadable legacy proposal tree changes no history and is never opened or written', async () => {
    const clean = scene()
    const expected = await historyOf(readsFor({ agentQaRoot: clean.agentQaRoot, configPath: clean.configPath }), template.runId)
    const s = scene()
    // Seed exactly what a pre-432 workspace leaves behind: a garbled envelope, a claim and an unreadable directory.
    mkdirSync(join(s.proposals, 'claimed'), { recursive: true })
    writeFileSync(join(s.proposals, 'prop_0123456789ab.json'), '{"not":"a proposal"')
    writeFileSync(join(s.proposals, 'claimed', 'prop_0123456789ab.json'), '\u0000garbled')
    const sealed = join(s.proposals, 'sealed')
    mkdirSync(sealed)
    writeFileSync(join(sealed, 'prop_fedcba987654.json'), '{}')
    const before = tree(s.root)
    // Sealed: any open, stat or listing under the legacy tree now fails, so a reader that touched it could not answer.
    chmodSync(s.proposals, 0o000)
    try {
      const reads = readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath })
      expect(await historyOf(reads, template.runId)).toEqual(expected)
      expect(await historyOf(reads, template.runId)).toEqual(expected)
    } finally { chmodSync(s.proposals, 0o700) }
    expect(tree(s.root), 'the legacy tree and every store are left exactly as they were').toEqual(before)
  })

  // RE-SPELLED 432-09 from 'WITHDRAWAL-REASON: the withdrawn proposal carries its decision reason,
  // and every free-text field crosses the mask': nothing is withdrawn; the joined content is masked.
  it('HISTORY-MASKED: every free-text field and every joined record content crosses the mask', async () => {
    const s = scene()
    const [first, , third] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    const reads = readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath })
    const raw = await reads.history(template.runId)
    if (raw.kind !== 'history') throw new Error('expected a history read')
    expect(raw.entries[0]!.receipt).toEqual(first)
    const content = raw.entries[0]!.changedRecords![0]!.recordContent!.content

    const mask = declaredMask({ HISTORY_SYNTHETIC_TOKEN: SECRET })
    const masked = await historyOf(reads, template.runId, mask)
    const entries = historyEntries(masked)
    expect(entries[0]).toMatchObject({ note: 'first run-level note' })
    expect(entries[0]!.changedRecords![0]!.recordContent!.content).toBe(mask(content))
    expect(entries[2]).toMatchObject({ markId: third.markId, note: `step note ${CHIP}` })
    expect(JSON.stringify(masked)).not.toContain(SECRET)

    await expect(historyOf(reads, template.runId, null)).rejects.toThrow(/no declared-secret mask/)
  })

  it('HISTORY-CORRUPT: corrupt ledgers are typed failures that leave their bytes in place', async () => {
    const torn = scene()
    writeFileSync(torn.ledger, readFileSync(torn.ledger, 'utf8').slice(0, -1))
    const tornBefore = tree(torn.root)
    expect(await historyOf(readsFor({ agentQaRoot: torn.agentQaRoot }), template.runId))
      .toEqual({ kind: 'ledger-corrupt', runId: template.runId, line: 3 })
    expect(tree(torn.root)).toEqual(tornBefore)

    const garbled = scene()
    const lines = readFileSync(garbled.ledger, 'utf8').split('\n')
    lines[1] = '{"torn":'
    writeFileSync(garbled.ledger, lines.join('\n'))
    const garbledBefore = tree(garbled.root)
    expect(await historyOf(readsFor({ agentQaRoot: garbled.agentQaRoot }), template.runId))
      .toEqual({ kind: 'ledger-corrupt', runId: template.runId, line: 2 })
    expect(tree(garbled.root)).toEqual(garbledBefore)

    const unreadable = scene()
    rmSync(unreadable.ledger)
    mkdirSync(unreadable.ledger)
    const unreadableBefore = tree(unreadable.root)
    expect(await historyOf(readsFor({ agentQaRoot: unreadable.agentQaRoot }), template.runId))
      .toEqual({ kind: 'ledger-unavailable', runId: template.runId })
    expect(tree(unreadable.root)).toEqual(unreadableBefore)
  })

  it('HISTORY-HISTORICAL-DRAFT: an older drafted receipt stays readable, and what it changed is not invented', async () => {
    const s = scene()
    const lines = readFileSync(s.ledger, 'utf8').split('\n')
    const original = JSON.parse(lines[2]!) as MarkReceipt
    const historical = { ...original, disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } }
    lines[2] = JSON.stringify(historical)
    writeFileSync(s.ledger, lines.join('\n'))
    const entries = historyEntries(await historyOf(readsFor({ agentQaRoot: s.agentQaRoot, configPath: s.configPath }), template.runId))
    expect(entries[2]!.disposition).toEqual(historical.disposition)
    expect(entries[2]).not.toHaveProperty('changedRecords')
    expect(existsSync(s.proposals)).toBe(false)
  })
})

// 2026-09-15, 423 D-19: runs.marks.history registered and bound on every existing local host composition.
const HISTORY = 'runs.marks.history'

describe('marks history registration and host binding', () => {
  const roots: string[] = []
  const closers: Array<() => void | Promise<void>> = []
  let template: MarkedTemplate

  beforeAll(async () => { template = await markedTemplate(roots) }, 180_000)
  afterEach(async () => {
    process.exitCode = 0
    for (const close of closers.splice(0).reverse()) await close()
  })
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function coldScene() {
    const root = mkdtempSync(join(tmpdir(), '423-18-binding-')); roots.push(root)
    cpSync(template.root, root, { recursive: true })
    // The note's synthetic token is a declared secret, so a cold host's live mask must hide it.
    writeFileSync(join(root, '.env.secrets.local'), `HISTORY_SYNTHETIC_TOKEN=${SECRET}\n`)
    const agentQaRoot = join(root, '.agent-qa')
    return { root, configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot,
      stores: [join(agentQaRoot, 'runs'), join(agentQaRoot, 'proposals'), join(root, 'agent-qa-knowledge')] }
  }
  const storeMaps = (stores: readonly string[]) => stores.map(tree)

  function expectMaskedOrdinalHistory(value: unknown) {
    const result = RunsMarksHistoryResultSchema.parse(value)
    const entries = historyEntries(result)
    const [first, second, third] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    expect(entries.map(entry => [entry.markId, entry.ordinal, entry.active, entry.supersededBy ?? null, entry.disposition.kind]))
      .toEqual([[first.markId, 1, false, second.markId, 'applied'], [second.markId, 2, true, null, 'confirmed-bug'], [third.markId, 3, true, null, 'applied']])
    // 2026-10-14 (441-16, D-06): a cold host masks the declared secret and leaves the rest as written.
    expect(entries.map(entry => entry.note ?? null)).toEqual(['first run-level note', null, `step note ${CHIP}`])
    // 432-09: the applied fix's records are joined by id, and their content crosses the same mask.
    expect(entries[0]!.changedRecords!.map(record => record.recordId)).toEqual(changedRecordIdsOf(first))
    expect(entries[0]!).not.toHaveProperty('proposal')
    expect(JSON.stringify(result)).not.toContain(SECRET)
    return result
  }

  it('HISTORY-REGISTRY-BINDING: the cold CLI host binds the read host, and a registry without feedbackReads stays unbound', async () => {
    expect(Reflect.get(agent, 'RUNS_MARKS_HISTORY_FUNCTION_ID')).toBe(HISTORY)
    expect(Reflect.get(agent, 'runsMarksHistorySpec')).toBeUndefined()

    const s = coldScene()
    const composed = host.composeCliLocalAgent({ configPath: s.configPath, agentQaRoot: s.agentQaRoot,
      resolveExecutionContext: () => 'local-headless' })
    closers.push(() => composed.close())
    expect(composed.registry.list(host.CLI_FUNCTION_CALLER).find(entry => entry.id === HISTORY)).toMatchObject({
      bindingStatus: 'bound', resultKind: 'unary', risk: { readOnly: true } })
    const before = storeMaps(s.stores)
    expectMaskedOrdinalHistory(await agent.invokeFunction(composed.registry, HISTORY, { runId: template.runId }, host.CLI_FUNCTION_CALLER))
    expect(storeMaps(s.stores)).toEqual(before)
    expect(existsSync(join(s.agentQaRoot, 'runs', template.runSlug, 'mark-intent.json'))).toBe(false)

    // The mark writer is not a history binding; an absent read port is refused by name.
    const writerOnly = agent.createFunctionRegistry({
      deps: { feedback: { mark: refuse('feedback.mark'), marksFor: refuse('feedback.marksFor') } } as never })
    expect(writerOnly.list(host.CLI_FUNCTION_CALLER).find(entry => entry.id === HISTORY)?.bindingStatus).toBe('unbound')
    await expect(agent.invokeFunction(writerOnly, HISTORY, { runId: template.runId }, host.CLI_FUNCTION_CALLER))
      .rejects.toBeInstanceOf(agent.FunctionNotBoundError)
  })

  it('HISTORY-FN-PARITY: agent-qa fn, the CLI registry and the dashboard door return one masked history with unchanged stores', async () => {
    const s = coldScene()
    const before = storeMaps(s.stores)

    const stdout: string[] = []
    const stderr: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { stdout.push(values.map(String).join(' ')) })
    const errors = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => { stderr.push(values.map(String).join(' ')) })
    process.exitCode = undefined
    try {
      await new Command().exitOverride().option('--config <path>').addCommand(createFnCommand())
        .parseAsync(['--config', s.configPath, 'fn', HISTORY, '--input', JSON.stringify({ runId: template.runId }), '--json'], { from: 'user' })
    } finally { log.mockRestore(); errors.mockRestore() }
    expect(stderr).toEqual([])
    expect(process.exitCode).toBeUndefined()
    const viaFn = expectMaskedOrdinalHistory(JSON.parse(stdout.join('\n')))

    const composed = host.composeCliLocalAgent({ configPath: s.configPath, agentQaRoot: s.agentQaRoot,
      resolveExecutionContext: () => 'local-headless' })
    closers.push(() => composed.close())
    const viaRegistry = expectMaskedOrdinalHistory(
      await agent.invokeFunction(composed.registry, HISTORY, { runId: template.runId }, host.CLI_FUNCTION_CALLER))

    const door = composeDashboardDoor({ configPath: s.configPath, agentQaRoot: s.agentQaRoot, boundOrigin: () => undefined })
    closers.push(() => door.host.close())
    expect(door.host.registry.list(DASHBOARD_FUNCTION_CALLER).find(entry => entry.id === HISTORY)?.bindingStatus).toBe('bound')
    const viaDashboard = expectMaskedOrdinalHistory(
      await agent.invokeFunction(door.host.registry, HISTORY, { runId: template.runId }, DASHBOARD_FUNCTION_CALLER))

    expect(viaFn).toEqual(viaRegistry)
    expect(viaDashboard).toEqual(viaRegistry)
    expect(storeMaps(s.stores)).toEqual(before)
  })
})

// 2026-09-15, 423 D-16/D-17: runs.mark.preview through the read host, content-led and write-free.
const CONTENT_SECRET = 'Held checkout marked'
type PreviewFixture = ReturnType<typeof markFixture>
type Consequences = Extract<RunsMarkPreviewResult, { kind: 'consequences' }>
const MARK_ID = /mark_[0-9a-f]{12}/g

/** Writer lease, ledger transaction/intent, eval initialization and the wording model all throw. */
async function denying<T>(run: () => Promise<T>): Promise<T> {
  const spies = (['transact', 'prepareIntent', 'checkpointIntent', 'append'] as const)
    .map(name => vi.spyOn(FsMarkLedger.prototype, name).mockImplementation(refuse(`FsMarkLedger.${name}`) as never))
  denial.active = true
  try { return await run() } finally {
    denial.active = false
    for (const spy of spies) spy.mockRestore()
  }
}

function previewReadsFor(f: { agentQaRoot: string; configPath: string }, extra: Partial<FeedbackReadsHostDeps> = {}): FeedbackReadsPort {
  return createFeedbackReadsPortForHost({ agentQaRoot: f.agentQaRoot, configPath: f.configPath, curation: readOnlyCuration(), ...extra })
}

function previewPort(reads: FeedbackReadsPort) {
  expect(typeof reads.preview, 'gates/feedback-read-host must expose preview').toBe('function')
  return reads.preview!.bind(reads)
}

/** The host answer, unmasked, under every negative capability. */
async function rawPreview(reads: FeedbackReadsPort, input: RunsMarkInput): Promise<RunsMarkPreviewResult> {
  const preview = previewPort(reads)
  return await denying(() => preview(input))
}

/** The real op: exact input parse, live mask and strict result parse over the host answer. */
async function opPreview(reads: FeedbackReadsPort, input: RunsMarkInput, secretMask: Mask | null = identity): Promise<RunsMarkPreviewResult> {
  previewPort(reads)
  return await denying(async () => await runsMarkPreviewSpec.invoke(input,
    { feedbackReads: reads, ...(secretMask === null ? {} : { secretMask }) } as never) as RunsMarkPreviewResult)
}

function consequencesOf(result: RunsMarkPreviewResult): Consequences {
  if (result.kind !== 'consequences') throw new Error(`expected consequences, got ${result.kind}`)
  return result
}

/** No receipt, cassette id, timestamp or fresh mark id: only mark ids already in the ledger may appear. */
function expectNoMint(result: RunsMarkPreviewResult, known: readonly string[] = []) {
  const text = JSON.stringify(result)
  expect(text).not.toMatch(/"(markedAt|cassetteId|receipt|proposalUuid)"/)
  expect([...new Set(text.match(MARK_ID) ?? [])].filter(id => !known.includes(id))).toEqual([])
}

function bundleDirOf(f: PreviewFixture, recordId: string) {
  return join(f.knowledgeRoot, 'memory', 'storefront', 'bundles', recordId)
}

describe('content-led consequence preview over the read host', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  function fixture() {
    const f = markFixture(); roots.push(f.root)
    return f
  }
  function copyOf(f: PreviewFixture) {
    const root = mkdtempSync(join(tmpdir(), '423-19-scene-')); roots.push(root)
    cpSync(f.root, root, { recursive: true })
    const rebase = (path: string) => join(root, path.slice(f.root.length))
    return { ...f, root, agentQaRoot: rebase(f.agentQaRoot), configPath: rebase(f.configPath), knowledgeRoot: rebase(f.knowledgeRoot),
      runDir: rebase(f.runDir), deps: { ...f.deps, agentQaRoot: rebase(f.agentQaRoot), configPath: rebase(f.configPath) } }
  }

  it('PREVIEW-WRITES-NOTHING: valid, refused, repeated, quarantined, false-pass, missing and corrupt previews keep every path and byte', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const prior = await createFeedbackPortForHost(f.deps).mark({ runId, stepIndex: 0, kind: 'false-fail' })
    if (prior.kind !== 'marked') throw new Error('expected the prior step mark')
    const known = [prior.receipt.markId]
    // An orphaned intent is exactly what a writer transaction would inspect and clean up.
    writeFileSync(join(f.runDir, 'mark-intent.json'), '{"stage":"prepared"}\n')
    const reads = previewReadsFor(f)
    const before = tree(f.root)
    const cases: [RunsMarkInput, RunsMarkPreviewResult['kind']][] = [
      [{ runId, kind: 'false-fail' }, 'consequences'],
      [{ runId, kind: 'confirmed-bug' }, 'consequences'],
      [{ runId, kind: 'false-pass' }, 'consequences'],
      [{ runId, stepIndex: 5, kind: 'false-fail' }, 'step-not-found'],
      [{ runId, testId: 'absent-member', kind: 'confirmed-bug' }, 'member-not-found'],
      [{ runId: asRunId(generateRunId()), kind: 'confirmed-bug' }, 'run-not-found'],
      [{ runId, stepIndex: 0, kind: 'false-fail', note: 'only the note moved' }, 'already-marked'],
    ]
    for (const [input, kind] of cases) {
      const result = await opPreview(reads, input)
      expect(result.kind, JSON.stringify(input)).toBe(kind)
      expectNoMint(result, known)
      expect(tree(f.root)).toEqual(before)
    }

    const quarantine = copyOf(f)
    const quarantinedHandoff = { ...f.handoff, tests: [{ ...f.handoff.tests[0]!, rootCause: { class: 'environment' as const, producer: 'deterministic-classifier', confidence: 1, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Recorded classification' }, memoryMisdirectionRuledOut: true, perTest: 0 } }] }
    writeFileSync(join(quarantine.runDir, 'handoff.json'), JSON.stringify(quarantinedHandoff))
    const quarantineBefore = tree(quarantine.root)
    expect(await opPreview(previewReadsFor(quarantine), { runId, kind: 'false-pass' }))
      .toMatchObject({ kind: 'quarantined', prospective: true, markKind: 'false-pass', class: 'environment', member: { testIndex: 0 } })
    expect(tree(quarantine.root)).toEqual(quarantineBefore)

    // A purged served record and a corrupt served bundle are typed absences, not writes or crashes.
    const purged = copyOf(f)
    rmSync(bundleDirOf(purged, f.published.id), { recursive: true })
    const purgedBefore = tree(purged.root)
    expect(consequencesOf(await opPreview(previewReadsFor(purged), { runId, kind: 'confirmed-bug' })).knowledge.records)
      .toEqual([{ recordId: f.published.id, contentAbsence: { reason: 'not-found' }, served: true, evidence: { kind: 'unreadable' } }])
    expect(tree(purged.root)).toEqual(purgedBefore)
    const corrupt = copyOf(f)
    writeFileSync(join(bundleDirOf(corrupt, f.published.id), 'manifest.json'), '{"torn":')
    const corruptBefore = tree(corrupt.root)
    expect(consequencesOf(await opPreview(previewReadsFor(corrupt), { runId, kind: 'confirmed-bug' })).knowledge)
      .toMatchObject({ records: [{ recordId: f.published.id, contentAbsence: { reason: 'scan-incomplete' }, served: true, evidence: { kind: 'unreadable' } }],
        evidence: { confirmed: 0, overturned: 0 } })
    expect(tree(corrupt.root)).toEqual(corruptBefore)

    // A corrupt ledger refuses the read the writer would refuse, with its bytes left in place.
    const torn = copyOf(f)
    writeFileSync(join(torn.runDir, 'marks.jsonl'), '{"torn":\n')
    const tornBefore = tree(torn.root)
    await expect(denying(() => previewPort(previewReadsFor(torn))({ runId, kind: 'confirmed-bug' }))).rejects.toThrow()
    expect(tree(torn.root)).toEqual(tornBefore)

    // A host without a config binds history only, so preview stays unbound by name.
    expect(createFeedbackReadsPortForHost({ agentQaRoot: f.agentQaRoot }).preview).toBeUndefined()
  }, 120_000)

  it('INTENT-UNCHANGED: an in-flight mark intent is observed without cleanup, and only the writer resumes it', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const input: RunsMarkInput = { runId, kind: 'false-fail', note: 'interrupted' }
    await expect(createFeedbackPortForHost({ ...f.deps, word: async () => { throw new Error('model unavailable') } }).mark(input))
      .rejects.toThrow('model unavailable')
    const intentPath = join(f.runDir, 'mark-intent.json')
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as { stage: string; mark: MarkReceipt }
    expect(intent.stage).toBe('evidence')
    expect(new FsMarkLedger({ root: f.agentQaRoot, runId }).read()).toEqual([])
    const before = tree(f.root)
    const intentBytes = readFileSync(intentPath)

    const reads = previewReadsFor(f)
    const previewed = consequencesOf(await rawPreview(reads, input))
    expect(previewed).toMatchObject({ latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 },
      knowledge: { evidence: { confirmed: 1, overturned: 0 } } })
    expect(previewed.basis).not.toHaveProperty('priorMarkOrdinal')
    // The intent's id and time belong to the writer. Its evidence already landed, so the id appears only
    // as the served record's current trust token, read-time state, and the preview mints nothing else.
    expectNoMint(previewed, [intent.mark.markId])
    expect(previewed.knowledge.records[0]!.recordContent!.currentTrust.evidenceTokens).toContain(`mark:${intent.mark.markId}`)
    const { recordContent: _current, ...planned } = previewed.knowledge.records[0]!
    expect(JSON.stringify({ ...previewed, knowledge: { ...previewed.knowledge, records: [planned] } })).not.toContain(intent.mark.markId)
    expect(JSON.stringify(previewed)).not.toContain(String(intent.mark.markedAt))
    expect(readFileSync(intentPath)).toEqual(intentBytes)
    expect(tree(f.root)).toEqual(before)

    const resumed = await createFeedbackPortForHost(f.deps).mark(input)
    expect(resumed).toMatchObject({ kind: 'marked', receipt: { markId: intent.mark.markId, markedAt: intent.mark.markedAt, ordinal: 1,
      evidence: previewed.knowledge.evidence } })
    expect(existsSync(intentPath)).toBe(false)
  }, 120_000)

  it('BASIS-RACE: the basis is an observation; a mark landing after preview is re-evaluated by the unchanged writer', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const port = createFeedbackPortForHost(f.deps)
    const reads = previewReadsFor(f)
    const input: RunsMarkInput = { runId, kind: 'false-fail' }
    const stale = consequencesOf(await opPreview(reads, input))
    expect(stale).toMatchObject({ latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 } })
    // The observed basis is not a token runs.mark accepts.
    expect(RunsMarkInputSchema.safeParse({ ...input, basis: stale.basis }).success).toBe(false)
    expect(RunsMarkInputSchema.safeParse({ ...input, priorMarkOrdinal: 0 }).success).toBe(false)

    const racing = await port.mark({ runId, kind: 'confirmed-bug' })
    if (racing.kind !== 'marked') throw new Error('expected the racing mark')
    const landed = await port.mark(input)
    expect(landed).toMatchObject({ kind: 'marked', receipt: { ordinal: 2, supersedes: racing.receipt.markId } })

    const fresh = await opPreview(reads, { runId, kind: 'confirmed-bug' })
    expect(fresh).toMatchObject({ kind: 'consequences', latest: { kind: 'supersedes', ordinal: 2 },
      basis: { ledgerOrdinal: 2, priorMarkOrdinal: 2 } })
    // A stale consequences preview never outranks the writer's identical-repeat rule.
    const repeatPreview = consequencesOf(await opPreview(reads, { runId, kind: 'confirmed-bug', note: 'raced' }))
    expect(repeatPreview.basis).toEqual({ ledgerOrdinal: 2, priorMarkOrdinal: 2 })
    expect(await port.mark({ runId, kind: 'confirmed-bug' })).toMatchObject({ kind: 'marked', receipt: { ordinal: 3 } })
    expect(await port.mark({ runId, kind: 'confirmed-bug', note: 'raced' })).toMatchObject({ kind: 'already-marked' })
    expect(await opPreview(reads, { runId, kind: 'confirmed-bug', note: 'raced' }))
      .toMatchObject({ kind: 'already-marked', prior: { ordinal: 3, kind: 'confirmed-bug', testIndex: 0 }, basis: { ledgerOrdinal: 3, priorMarkOrdinal: 3 } })
  }, 120_000)

  it('PREVIEW-CONTENT: served targets lead with joined content and their effects; typed absences keep ids and effects', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const reads = previewReadsFor(f)
    const before = tree(f.root)
    const raw = consequencesOf(await rawPreview(reads, { runId, kind: 'false-fail' }))
    const [shown] = showRecords({ knowledgeRoot: f.knowledgeRoot, recordIds: [f.published.id] })
    if (shown?.kind !== 'found') throw new Error('expected the served record to be shown')
    expect(raw.knowledge).toEqual({ servedRecordIds: [f.published.id], appendsEvidence: true,
      records: [{ recordId: f.published.id, recordContent: {
        content: shown.body, summary: shown.summary, kind: shown.record.kind,
        applicability: { product: shown.record.product, scope: shown.record.scope, anchors: shown.record.anchors,
          openedAtOrdinal: shown.record.openedAtOrdinal },
        currentStatus: shown.record.status,
        currentTrust: { confirmations: shown.record.confirmations, contradictions: shown.record.contradictions,
          evidenceTokens: shown.record.evidenceTokens, lastEventOrdinal: shown.record.lastEventOrdinal,
          ...(shown.record.trustNarrative ? { trustNarrative: shown.record.trustNarrative } : {}) } },
      served: true, evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] } }],
      evidence: { confirmed: 1, overturned: 0 } })
    // Content leads the record: identity first, then the joined content, then its effects.
    expect(Object.keys(raw.knowledge.records[0]!)).toEqual(['recordId', 'recordContent', 'served', 'evidence'])
    expect(raw.knowledge.records[0]!.recordContent!.content).toContain(CONTENT_SECRET)
    expect(tree(f.root)).toEqual(before)

    // Joined content crosses the declared mask; without one the read refuses.
    const mask = declaredMask({ CONTENT_441: CONTENT_SECRET })
    const masked = consequencesOf(await opPreview(reads, { runId, kind: 'false-fail' }, mask))
    expect(masked.knowledge.records[0]!.recordContent).toMatchObject({ content: mask(shown.body), summary: mask(shown.summary) })
    expect(JSON.stringify(masked)).not.toContain(CONTENT_SECRET)
    expect(masked.knowledge.records[0]).toMatchObject({ recordId: f.published.id, served: true, evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] } })
    await expect(opPreview(reads, { runId, kind: 'false-fail' }, null)).rejects.toThrow(/no declared-secret mask/)

    // A reader with no batch join keeps the record id and its effect under a named absence.
    const unbatched = { ...createKnowledgeReader(() => f.knowledgeRoot), showRecords: undefined }
    const unjoined = consequencesOf(await rawPreview(previewReadsFor(f, { reader: unbatched }), { runId, kind: 'false-fail' }))
    expect(unjoined.knowledge.records).toEqual([{ recordId: f.published.id, contentAbsence: { reason: 'not-bound' }, served: true,
      evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] } }])
    expect(tree(f.root)).toEqual(before)

    const written = await createFeedbackPortForHost(f.deps).mark({ runId, kind: 'false-fail' })
    expect(written).toMatchObject({ kind: 'marked', receipt: { evidence: raw.knowledge.evidence } })
  }, 120_000)

  it('CORRELATED-EVIDENCE: false-pass keeps both directions on a served record and overturns correlated unserved records', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const unserved = createPromotionFloorFixture({ knowledgeRoot: f.knowledgeRoot }).publishHeldCandidate('unserved').published
    const unrelated = createPromotionFloorFixture({ knowledgeRoot: f.knowledgeRoot }).publishHeldCandidate('unrelated').published
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture must hold writer authority')
    const helpful = (recordId: string, observationId: string, token: string) => expect(appendOutcomeEvent({ knowledgeRoot: f.knowledgeRoot,
      productKey: 'storefront', writerLeaseId: lease.leaseId, writerEpoch: lease.epoch },
    asRecordId(recordId), { type: 'helpful', evidenceToken: asEvidenceToken(token), curationJobId: `canary-${token}`, buildOrdinal: 43, observationId }).kind).toBe('appended')
    // The deterministic emitter's persisted observation address for this run's step.
    helpful(f.published.id, `${runId}:test-0:step-0`, 'served-positive')
    helpful(unserved.id, `${runId}:test-0:step-0`, 'unserved-positive')
    helpful(unrelated.id, 'another-run:test-0:step-0', 'unrelated-positive')
    expect(LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: lease.leaseId }).kind).toBe('released')

    const reads = previewReadsFor(f)
    const before = tree(f.root)
    const previewed = consequencesOf(await rawPreview(reads, { runId, kind: 'false-pass' }))
    expect(tree(f.root)).toEqual(before)
    expect(previewed.knowledge.records.map(record => [record.recordId, record.served, record.evidence])).toEqual([
      [f.published.id, true, { kind: 'effects', effects: [{ direction: 'confirm' },
        { direction: 'overturn', overturnsEvidenceToken: 'served-positive', overturnsCurationJobId: 'canary-served-positive' }] }],
      [unserved.id, false, { kind: 'effects', effects: [
        { direction: 'overturn', overturnsEvidenceToken: 'unserved-positive', overturnsCurationJobId: 'canary-unserved-positive' }] }],
    ])
    expect(previewed.knowledge.servedRecordIds).toEqual([f.published.id])
    // Correlated records carry joined content too; the unrelated positive is never reached.
    expect(previewed.knowledge.records[1]!.recordContent?.summary).toContain('unserved')
    expect(JSON.stringify(previewed)).not.toContain(unrelated.id)
    expect(previewed.knowledge.evidence).toEqual({ confirmed: 1, overturned: 2 })

    const written = await createFeedbackPortForHost(f.deps).mark({ runId, kind: 'false-pass' })
    expect(written).toMatchObject({ kind: 'marked', receipt: { evidence: { confirmed: 1, overturned: 2 } } })
  }, 120_000)

  it('false-pass previews the passing-verdict step with no minted id, receipt or time', async () => {
    const f = fixture()
    const runId = f.handoff.runId
    const reads = previewReadsFor(f)
    const before = tree(f.root)
    const previewed = consequencesOf(await opPreview(reads, { runId, kind: 'false-pass' }))
    expect(tree(f.root)).toEqual(before)
    expectNoMint(previewed)
    expect(RunsMarkPreviewResultSchema.parse(previewed)).toEqual(previewed)
    expect(previewed).toMatchObject({ prospective: true, markKind: 'false-pass', member: { testIndex: 0, testId: f.handoff.tests[0]!.testId },
      resolvedStep: { stepIndex: 0, reason: 'passing-verdict' } })
  }, 120_000)
})

// 2026-09-15, 423 D-16/D-18: runs.mark.preview registered and bound on every CLI host composition.
// Plan 423-21 projects it to MCP as agent_qa_preview_run_mark; fn reaches it now, with no model.
const PREVIEW = 'runs.mark.preview'

describe('runs.mark.preview registration and composed invocation', () => {
  const roots: string[] = []
  const closers: Array<() => void | Promise<void>> = []
  let template: MarkedTemplate

  beforeAll(async () => { template = await markedTemplate(roots) }, 180_000)
  afterEach(async () => {
    process.exitCode = 0
    for (const close of closers.splice(0).reverse()) await close()
  })
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function coldScene() {
    const root = mkdtempSync(join(tmpdir(), '423-19-binding-')); roots.push(root)
    cpSync(template.root, root, { recursive: true })
    writeFileSync(join(root, '.env.secrets.local'), `HISTORY_SYNTHETIC_TOKEN=${SECRET}\n`)
    const agentQaRoot = join(root, '.agent-qa')
    return { root, configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot,
      stores: [join(agentQaRoot, 'runs'), join(agentQaRoot, 'proposals'), join(agentQaRoot, 'eval'), join(root, 'agent-qa-knowledge')] }
  }
  const storeMaps = (stores: readonly string[]) => stores.map(tree)
  // The run-level address's latest mark is the confirmed-bug at ordinal 2, so a false-pass supersedes it.
  const input = (): RunsMarkInput => ({ runId: template.runId, kind: 'false-pass', note: `preview ${SECRET}` })

  /** 2026-10-14 (441-16, D-06): a cold host masks with the project's declared secrets. */
  async function expectedColdPreview(s: ReturnType<typeof coldScene>) {
    const reads = createFeedbackReadsPortForHost({ agentQaRoot: s.agentQaRoot, configPath: s.configPath })
    expect(typeof reads.preview, 'gates/feedback-read-host must expose preview').toBe('function')
    return await runsMarkPreviewSpec.invoke(input(),
      { feedbackReads: reads, secretMask: declaredMask({ HISTORY_SYNTHETIC_TOKEN: SECRET }) } as never) as RunsMarkPreviewResult
  }

  function expectColdMaskedPreview(value: unknown) {
    const result = consequencesOf(RunsMarkPreviewResultSchema.parse(value))
    const [, second] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    expect(result).toMatchObject({ runId: template.runId, prospective: true, markKind: 'false-pass', member: { testIndex: 0 },
      resolvedStep: { stepIndex: 0, reason: 'passing-verdict' }, latest: { kind: 'supersedes', markId: second.markId, ordinal: 2 },
      basis: { ledgerOrdinal: 3, priorMarkOrdinal: 2 } })
    expect(result.knowledge.records[0]).toMatchObject({ served: true,
      recordContent: { content: 'The Held checkout marked button was resolved and verified.' } })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expectNoMint(result, template.receipts.map(receipt => receipt.markId))
    return result
  }

  it('PREVIEW-REGISTRY-BINDING: the cold CLI host binds preview through the read host; history-only or writer-only bindings stay unbound', async () => {
    expect(Reflect.get(agent, 'RUNS_MARK_PREVIEW_FUNCTION_ID')).toBe(PREVIEW)
    expect(Reflect.get(agent, 'runsMarkPreviewSpec')).toBeUndefined()

    const s = coldScene()
    const composed = host.composeCliLocalAgent({ configPath: s.configPath, agentQaRoot: s.agentQaRoot,
      resolveExecutionContext: () => 'local-headless' })
    closers.push(() => composed.close())
    expect(composed.registry.list(host.CLI_FUNCTION_CALLER).find(entry => entry.id === PREVIEW)).toMatchObject({
      bindingStatus: 'bound', resultKind: 'unary', risk: { readOnly: true } })
    // runs.mark keeps its own tier and binding beside the read.
    expect(composed.registry.list(host.CLI_FUNCTION_CALLER).find(entry => entry.id === 'runs.mark'))
      .toMatchObject({ bindingStatus: 'bound', risk: { readOnly: false } })
    const before = storeMaps(s.stores)
    const expected = await expectedColdPreview(s)
    const composedResult = await agent.invokeFunction(composed.registry, PREVIEW, input(), host.CLI_FUNCTION_CALLER)
    expect(composedResult).toEqual(expected)
    expectColdMaskedPreview(composedResult)
    expect(storeMaps(s.stores)).toEqual(before)
    expect(existsSync(join(s.agentQaRoot, 'runs', template.runSlug, 'mark-intent.json'))).toBe(false)
    // The exact input is still refused before the port: a preview basis is not an input field.
    await expect(agent.invokeFunction(composed.registry, PREVIEW, { ...input(), basis: { ledgerOrdinal: 3 } }, host.CLI_FUNCTION_CALLER)).rejects.toThrow()

    const historyOnly = agent.createFunctionRegistry({
      deps: { feedbackReads: createFeedbackReadsPortForHost({ agentQaRoot: s.agentQaRoot }) } as never })
    await expect(agent.invokeFunction(historyOnly, PREVIEW, input(), host.CLI_FUNCTION_CALLER)).rejects.toBeInstanceOf(agent.FunctionNotBoundError)
    const writerOnly = agent.createFunctionRegistry({
      deps: { feedback: { mark: refuse('feedback.mark'), marksFor: refuse('feedback.marksFor') } } as never })
    expect(writerOnly.list(host.CLI_FUNCTION_CALLER).find(entry => entry.id === PREVIEW)?.bindingStatus).toBe('unbound')
    await expect(agent.invokeFunction(writerOnly, PREVIEW, input(), host.CLI_FUNCTION_CALLER)).rejects.toBeInstanceOf(agent.FunctionNotBoundError)
    expect(storeMaps(s.stores)).toEqual(before)
  }, 180_000)

  it('PREVIEW-FN-PARITY: agent-qa fn, the CLI registry and the dashboard door return one masked preview with unchanged stores', async () => {
    const s = coldScene()
    const before = storeMaps(s.stores)

    const stdout: string[] = []
    const stderr: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { stdout.push(values.map(String).join(' ')) })
    const errors = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => { stderr.push(values.map(String).join(' ')) })
    process.exitCode = undefined
    try {
      await new Command().exitOverride().option('--config <path>').addCommand(createFnCommand())
        .parseAsync(['--config', s.configPath, 'fn', PREVIEW, '--input', JSON.stringify(input()), '--json'], { from: 'user' })
    } finally { log.mockRestore(); errors.mockRestore() }
    expect(stderr).toEqual([])
    expect(process.exitCode).toBeUndefined()
    const viaFn = expectColdMaskedPreview(JSON.parse(stdout.join('\n')))

    const composed = host.composeCliLocalAgent({ configPath: s.configPath, agentQaRoot: s.agentQaRoot,
      resolveExecutionContext: () => 'local-headless' })
    closers.push(() => composed.close())
    const viaRegistry = expectColdMaskedPreview(await agent.invokeFunction(composed.registry, PREVIEW, input(), host.CLI_FUNCTION_CALLER))

    const door = composeDashboardDoor({ configPath: s.configPath, agentQaRoot: s.agentQaRoot, boundOrigin: () => undefined })
    closers.push(() => door.host.close())
    expect(door.host.registry.list(DASHBOARD_FUNCTION_CALLER).find(entry => entry.id === PREVIEW)?.bindingStatus).toBe('bound')
    const viaDashboard = expectColdMaskedPreview(await agent.invokeFunction(door.host.registry, PREVIEW, input(), DASHBOARD_FUNCTION_CALLER))

    expect(viaFn).toEqual(viaRegistry)
    expect(viaDashboard).toEqual(viaRegistry)
    expect(viaRegistry).toEqual(await expectedColdPreview(s))
    expect(storeMaps(s.stores)).toEqual(before)

    // The writer still lands what the preview promised, through its own unchanged transaction.
    const marked = await createFeedbackPortForHost({ configPath: s.configPath, agentQaRoot: s.agentQaRoot, randomUuid: () => '00000000-0000-4000-8000-00000000abcd' })
      .mark(input())
    expect(marked).toMatchObject({ kind: 'marked', receipt: { ordinal: 4, supersedes: template.receipts[1]!.markId,
      evidence: viaRegistry.knowledge.evidence } })
  }, 180_000)

  it('PREVIEW-LEDGER-CORRUPT-PARITY: preview reads the ledger once, and a corrupt ledger fails it with runs.mark\'s own typed error', async () => {
    const s = coldScene()
    const composed = host.composeCliLocalAgent({ configPath: s.configPath, agentQaRoot: s.agentQaRoot,
      resolveExecutionContext: () => 'local-interactive' })
    closers.push(() => composed.close())
    const failureOf = async (opId: string) => await agent.invokeFunction(composed.registry, opId, input(), host.CLI_FUNCTION_CALLER)
      .then(result => { throw new Error(`${opId} answered ${JSON.stringify(result)} over a corrupt ledger`) }, (error: unknown) => error)
    const reads = vi.spyOn(FsMarkLedger.prototype, 'read')
    try {
      expect(await agent.invokeFunction(composed.registry, PREVIEW, input(), host.CLI_FUNCTION_CALLER))
        .toMatchObject({ kind: 'consequences', basis: { ledgerOrdinal: 3, priorMarkOrdinal: 2 } })
      expect(reads).toHaveBeenCalledTimes(1)

      // The HISTORY-CORRUPT fixture: the second receipt line is torn.
      const ledger = join(s.agentQaRoot, 'runs', template.runSlug, 'marks.jsonl')
      const lines = readFileSync(ledger, 'utf8').split('\n')
      lines[1] = '{"torn":'
      writeFileSync(ledger, lines.join('\n'))
      const before = storeMaps(s.stores)

      reads.mockClear()
      const previewed = await failureOf(PREVIEW)
      expect(reads).toHaveBeenCalledTimes(1)
      expect(storeMaps(s.stores)).toEqual(before)
      const marked = await failureOf('runs.mark')
      expect(storeMaps(s.stores)).toEqual(before)

      expect(marked).toMatchObject({ name: 'MarkLedgerCorruptError', line: 2 })
      expect(previewed).toMatchObject({ name: 'MarkLedgerCorruptError', line: 2 })
      expect((previewed as Error).constructor).toBe((marked as Error).constructor)
      expect((previewed as Error).message).toBe((marked as Error).message)
    } finally { reads.mockRestore() }
  }, 180_000)
})

// 2026-09-15, 423-21 D-18: both feedback reads over the shipped dashboard door's two HTTP boundaries,
// against the same real ledger, proposals store and preview inputs the fn parity cells use.
describe('feedback reads over both HTTP doors', () => {
  const roots: string[] = []
  const closers: Array<() => void | Promise<void>> = []
  let template: MarkedTemplate

  beforeAll(async () => { template = await markedTemplate(roots) }, 180_000)
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close()
  })
  afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  async function httpScene() {
    const root = mkdtempSync(join(tmpdir(), '423-21-http-')); roots.push(root)
    cpSync(template.root, root, { recursive: true })
    writeFileSync(join(root, '.env.secrets.local'), `HISTORY_SYNTHETIC_TOKEN=${SECRET}\n`)
    const agentQaRoot = join(root, '.agent-qa')
    const configPath = join(root, 'agent-qa.config.yaml')
    const door = composeDashboardDoor({ configPath, agentQaRoot, boundOrigin: () => undefined })
    closers.push(() => door.host.close())
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    closers.push(() => db.close())
    const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: door.agentHost })
    closers.push(() => started.close())
    const remote: Server = createServer(createRunServiceRoutes({ agentHost: door.agentHost } as unknown as RunServicePorts))
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>(resolve => remote.close(() => resolve())))
    const port = (server: { address(): unknown }) => (server.address() as { port: number }).port
    return { root, agentQaRoot, configPath, door,
      stores: [join(agentQaRoot, 'runs'), join(agentQaRoot, 'proposals'), join(agentQaRoot, 'eval'), join(root, 'agent-qa-knowledge')],
      doors: [
        { name: 'local-human', base: `http://127.0.0.1:${port(started.server)}/api/runs`, headers: {} as Record<string, string> },
        // 432-21 (D-12): the run service is tokenless — the machine door sends no credential.
        { name: 'remote-machine', base: `http://127.0.0.1:${port(remote)}/run`, headers: {} as Record<string, string> },
      ] }
  }
  const storeMaps = (stores: readonly string[]) => stores.map(tree)
  const previewBody = (): RunsMarkInput => ({ runId: template.runId, kind: 'false-pass', note: `preview ${SECRET}` })
  const post = (url: string, body: unknown, headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('HTTP-MARKS-HISTORY: GET marks on both doors equals the registry and fn result over the real ledger', async () => {
    const s = await httpScene()
    const before = storeMaps(s.stores)
    const viaRegistry = await agent.invokeFunction(s.door.host.registry, HISTORY, { runId: template.runId }, DASHBOARD_FUNCTION_CALLER)
    const viaOp = await historyOf(createFeedbackReadsPortForHost({ agentQaRoot: s.agentQaRoot, configPath: s.configPath }), template.runId,
      declaredMask({ HISTORY_SYNTHETIC_TOKEN: SECRET }))
    expect(viaRegistry).toEqual(viaOp)
    const entries = historyEntries(RunsMarksHistoryResultSchema.parse(viaRegistry))
    expect(entries.map(entry => [entry.ordinal, entry.active, entry.disposition.kind]))
      .toEqual([[1, false, 'applied'], [2, true, 'confirmed-bug'], [3, true, 'applied']])
    for (const door of s.doors) {
      const response = await fetch(`${door.base}/${template.runId}/marks`, { headers: door.headers })
      expect(response.status, door.name).toBe(200)
      const raw = await response.text()
      expect(JSON.parse(raw), door.name).toEqual(viaRegistry)
      expect(raw, door.name).not.toContain(SECRET)
    }
    expect(storeMaps(s.stores)).toEqual(before)
  }, 180_000)

  it('HTTP-MARK-PREVIEW: POST mark-preview on both doors equals the registry preview over the real stores', async () => {
    const s = await httpScene()
    const before = storeMaps(s.stores)
    const viaRegistry = await agent.invokeFunction(s.door.host.registry, PREVIEW, previewBody(), DASHBOARD_FUNCTION_CALLER)
    const viaOp = await runsMarkPreviewSpec.invoke(previewBody(), { feedbackReads: createFeedbackReadsPortForHost({
      agentQaRoot: s.agentQaRoot, configPath: s.configPath }), secretMask: declaredMask({ HISTORY_SYNTHETIC_TOKEN: SECRET }) } as never)
    expect(viaRegistry).toEqual(viaOp)
    const [, second] = template.receipts as [MarkReceipt, MarkReceipt, MarkReceipt]
    expect(consequencesOf(RunsMarkPreviewResultSchema.parse(viaRegistry))).toMatchObject({ prospective: true, markKind: 'false-pass',
      latest: { kind: 'supersedes', markId: second.markId, ordinal: 2 }, basis: { ledgerOrdinal: 3, priorMarkOrdinal: 2 } })
    for (const door of s.doors) {
      const response = await post(`${door.base}/${template.runId}/mark-preview`, previewBody(), door.headers)
      expect(response.status, door.name).toBe(200)
      const raw = await response.text()
      expect(JSON.parse(raw), door.name).toEqual(viaRegistry)
      expect(raw, door.name).not.toContain(SECRET)
      const refused = await post(`${door.base}/${template.runId}/mark-preview`, { ...previewBody(), runId: asRunId(generateRunId()) }, door.headers)
      expect(refused.status, door.name).toBe(400)
      expect(await refused.json()).toEqual({ error: 'run_id_mismatch' })
    }
    expect(storeMaps(s.stores)).toEqual(before)
  }, 180_000)

  // RE-AIMED 2026-10-14 (441-16, D-06/D-12): both doors mask a cold read with the project's declared
  // secrets, so the declared span reads as its `[secret:<name>]` marker and the rest as written. The
  // cold read scope, its allowlist and the installed warm context are gone, and so is the warm half.
  it('HTTP-FEEDBACK-HUMAN-POSTURE: both doors show cold read-scope free text with declared-secret chips, and warm text as the read masked it', async () => {
    const s = await httpScene()
    const [human, machine] = s.doors as [typeof s.doors[0], typeof s.doors[1]]
    const read = async (door: typeof human) => {
      const history = RunsMarksHistoryResultSchema.parse(await (await fetch(`${door.base}/${template.runId}/marks`, { headers: door.headers })).json())
      const preview = consequencesOf(RunsMarkPreviewResultSchema.parse(
        await (await post(`${door.base}/${template.runId}/mark-preview`, previewBody(), door.headers)).json()))
      // The served record leads; the correlated unserved records follow in record-id order, and the
      // two applied fixes' ids are minted per run, so their relative order is compared as a set.
      const [served, ...unserved] = preview.knowledge.records.map(record => record.recordContent?.content ?? null)
      return { notes: historyEntries(history).map(entry => entry.note ?? null),
        content: [served, ...unserved.sort()] }
    }
    const redacted = CHIP
    // 432-09 (D-04): the template's two false-fail marks applied their fixes, so the store now holds
    // those records and this false-pass preview reaches them after the served one. Their content is
    // the floor-worded fix, and the user's note inside it crosses the same mask as the note itself.
    const appliedFix = (note: string) => 'false-fail / fact: Click Continue\n'
      + 'Overturned verifier reading: The recorded state advanced\n'
      + 'Superseded claim: Held checkout marked selector\n'
      + `User note: ${note}`
    const content = ['The Held checkout marked button was resolved and verified.',
      ...[appliedFix('first run-level note'), appliedFix(`step note ${redacted}`)].sort()]
    const cold = { notes: ['first run-level note', null, `step note ${redacted}`],
      content }
    const coldHuman = await read(human)
    const coldMachine = await read(machine)
    expect(coldHuman).toEqual(cold)
    expect(coldMachine).toEqual(cold)
    expect(JSON.stringify([coldHuman, coldMachine])).not.toContain(SECRET)
  }, 180_000)

  it('FEEDBACK-HTTP-WRITES-NOTHING: HTTP history and preview leave every store byte-identical and create nothing', async () => {
    const s = await httpScene()
    const runDir = join(s.agentQaRoot, 'runs', template.runSlug)
    // 432-09 (D-22): a legacy proposal tree is left as it is; neither door opens or reaps it.
    mkdirSync(join(s.agentQaRoot, 'proposals'), { recursive: true })
    writeFileSync(join(s.agentQaRoot, 'proposals', 'prop_0123456789ab.json.claim-1'), '{"legacy":true}')
    const before = storeMaps(s.stores)
    const unknown = asRunId(generateRunId())
    for (const door of s.doors) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect((await fetch(`${door.base}/${template.runId}/marks`, { headers: door.headers })).status).toBe(200)
        expect((await post(`${door.base}/${template.runId}/mark-preview`, previewBody(), door.headers)).status).toBe(200)
      }
      expect(await (await fetch(`${door.base}/${unknown}/marks`, { headers: door.headers })).json()).toEqual({ kind: 'run-not-found', runId: unknown })
      expect(await (await post(`${door.base}/${unknown}/mark-preview`, { ...previewBody(), runId: unknown }, door.headers)).json())
        .toEqual({ kind: 'run-not-found', runId: unknown })
    }
    expect(storeMaps(s.stores)).toEqual(before)
    expect(existsSync(join(runDir, 'mark-intent.json'))).toBe(false)
  }, 180_000)
})

// 2026-09-15, 423-21 D-04/D-18: the three new read ops, adjudicated against the one registry by the
// conformance tables every surface leg reads: input contract, scenario row, MCP ruling, doc
// adjudication, authed remote route binding and read policy points.
describe('read-op adjudication', () => {
  const NEW_READS = ['runs.evidence', 'runs.marks.history', 'runs.mark.preview'] as const
  const declarationOf = (opId: string) => {
    const declaration = registryDeclarations().find(entry => entry.id === opId)
    if (declaration === undefined) throw new Error(`${opId} is not registered`)
    return declaration
  }

  it('OP-INPUT-PARTITION: each new read pairs its own input singleton, once, and the table keys equal the registry', () => {
    const contracts = OP_INPUT_CONTRACTS as Record<string, unknown>
    expect(contracts['runs.evidence']).toBe(RunsEvidenceInputSchema)
    expect(contracts['runs.marks.history']).toBe(RunsMarksHistoryInputSchema)
    // The preview is runs.mark's exact input: one schema object serves both ops.
    expect(contracts['runs.mark.preview']).toBe(RunsMarkInputSchema)
    expect(contracts['runs.mark']).toBe(RunsMarkInputSchema)
    for (const opId of ['runs.marks.history', 'runs.mark.preview'] as const) {
      expect(AGENT_QA_OP_CONTRACTS[opId]?.input, opId).toBe(contracts[opId])
    }
    // 2026-09-28 (431-04 D-07): runs.evidence is projected through the evidence fold, so the MCP
    // contract table carries its own input singleton too.
    expect(AGENT_QA_OP_CONTRACTS['runs.evidence']?.input).toBe(contracts['runs.evidence'])
    const registryIds = registryDeclarations().map(entry => entry.id)
    // 2026-09-25 (428 D-07): 52 — editor.liveurl registered, dashboard-only and MCP-unprojected.
    // 2026-09-29 (431-08 D-06): 53 — runs.overview registered, with its own input singleton.
    // 2026-10-01 (432-17 D-05): 46 — the seven proposal-inbox, apply and undo-propose ops deleted.
    // 2026-10-01 (432-18 D-15): 44 — grants.list and grants.revoke deleted with the ledger.
    expect(registryIds).toHaveLength(44)
    expect(censusDiff(registryIds, Object.keys(contracts))).toEqual({ missing: [], stray: [] })
  })

  it('OP-REGISTRY-SCENARIO: one scenario row, one MCP ruling, one doc adjudication and one remote route per new read', () => {
    expect(censusDiff(registryDeclarations().map(entry => entry.id), scenarioTableOpIds())).toEqual({ missing: [], stray: [] })
    const tools: Record<string, unknown> = {
      'runs.evidence': { reachable: { tool: 'agent_qa_get_run_evidence' } },
      'runs.marks.history': { reachable: { tool: 'agent_qa_get_run_marks' } },
      'runs.mark.preview': { reachable: { tool: 'agent_qa_preview_run_mark' } },
    }
    const routes: Record<string, string> = {
      'runs.evidence': 'GET /run/:runId/evidence',
      'runs.marks.history': 'GET /run/:runId/marks',
      'runs.mark.preview': 'POST /run/:runId/mark-preview',
    }
    for (const opId of NEW_READS) {
      const rows = scenarioTableOpIds().filter(id => id === opId)
      expect(rows, opId).toHaveLength(1)
      const row = scenarioRowFor(opId)!
      const contract = (OP_INPUT_CONTRACTS as Record<string, { safeParse(value: unknown): { success: boolean } }>)[opId]!
      expect(contract.safeParse(row.input).success, `${opId} scenario input`).toBe(true)
      expect(row.perSurface).toEqual({ chat: { reachable: true }, mcp: tools[opId], fn: { reachable: true } })
      // Markers are the op's required first-arm output fields, derived by the table's one rule.
      const output = declarationOf(opId).output as { oneOf?: Array<{ required?: string[] }>; anyOf?: Array<{ required?: string[] }>; required?: string[] }
      const first = output.oneOf?.[0] ?? output.anyOf?.[0] ?? output
      expect([...row.renderExpect.markers].sort(), `${opId} markers`).toEqual([...(first.required ?? [])].sort())
      expect(() => catalogDocFieldsOf(opId), `${opId} doc adjudication`).not.toThrow()
      expect(RUN_SERVICE_ROUTE_BINDINGS.filter(binding => 'opId' in binding && binding.opId === opId).map(binding => binding.key), opId)
        .toEqual([routes[opId]])
    }
    // 2026-09-28 (431-04 D-10): the 423 ruling moved to the projected side with a dated addendum.
    expect(UNPROJECTED_OPS.filter(entry => entry.opId === 'runs.evidence')).toEqual([])
    // The widened completed-run reads keep the same one-rule marker sets over the 51-op registry.
    for (const opId of ['runs.detail', 'runs.postprocessing', 'runs.knowledge'] as const) {
      const output = declarationOf(opId).output as { oneOf?: Array<{ required?: string[] }>; anyOf?: Array<{ required?: string[] }>; required?: string[] }
      const first = output.oneOf?.[0] ?? output.anyOf?.[0] ?? output
      expect([...scenarioRowFor(opId)!.renderExpect.markers].sort(), `${opId} markers`).toEqual([...(first.required ?? [])].sort())
    }
  })

  it('READ-POLICY-POINTS: the new reads carry read policy points and read-tier declarations; runs.mark stays a writer', () => {
    const readPoints = scenarioRowFor('runs.postprocessing')!.policyPoints
    // 432-20 (D-12): the refuse point is `allow` — nothing is refused for its grants.
    expect(readPoints).toEqual({ grant: 'allow', refuse: 'allow' })
    for (const opId of NEW_READS) {
      expect(scenarioRowFor(opId)?.policyPoints, opId).toEqual(readPoints)
      const declaration = declarationOf(opId)
      expect(Object.keys(declaration), opId).not.toContain('requiredScopes')
      expect(declaration.risk, opId).toMatchObject({ readOnly: true })
      expect(Object.keys(declaration), opId).not.toContain('requiresHumanOrigin')
    }
    expect(scenarioRowFor('runs.mark')?.policyPoints).toEqual(readPoints)
    expect(declarationOf('runs.mark').risk.readOnly).toBe(false)
  })
})
