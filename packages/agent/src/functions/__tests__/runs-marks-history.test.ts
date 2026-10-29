import { describe, expect, it, vi } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  MarkReceiptSchema,
  RunsMarksHistoryResultSchema,
  asRunId,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller, MarkHistoryChangedRecord, MarkReceipt, MaskFn, RunId } from '@vostride/agent-qa-schema'
import { invokeFunction } from '../invoke.js'
import { runsMarksHistorySpec } from '../ops/runs-marks-history.js'
import { createRegistryFromSpecs } from '../registry.js'
import * as spec from '../spec.js'
import type { FunctionDeps, FunctionSpec } from '../spec.js'

const historySpec = () => runsMarksHistorySpec
const resultSchema = () => RunsMarksHistoryResultSchema

const runId = asRunId('run-423-marks-history')
type Address = { testIndex: number; stepIndex?: number; testId?: string }
type ReadEntry = { receipt: MarkReceipt; changedRecords?: MarkHistoryChangedRecord[] }

const markIdOf = (ordinal: number) => `mark_${ordinal.toString(16).padStart(12, '0')}`

function receipt(ordinal: number, address: Address, overrides: Partial<MarkReceipt> = {}): MarkReceipt {
  return MarkReceiptSchema.parse({
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: markIdOf(ordinal), runId, runSlug: 'run-423-marks-history',
    testIndex: address.testIndex,
    ...(address.testId === undefined ? {} : { testId: address.testId }),
    ...(address.stepIndex === undefined ? {} : { stepIndex: address.stepIndex }),
    kind: 'false-fail', origin: 'user', ordinal,
    // Descending on purpose: ordinal, never `markedAt`, decides latest-wins.
    markedAt: 10_000 - ordinal * 10,
    disposition: { kind: 'quarantined', class: 'flake' }, evidence: { confirmed: 0, overturned: 0 },
    ...overrides,
  })
}

// Applied receipts, with the records a knowledge fix changed joined by the host.
const CONTENT = {
  content: 'The saved banner appears after checkout.', summary: 'saved banner', kind: 'fact',
  applicability: { product: 'shop', scope: 'shop', anchors: [], openedAtOrdinal: 1 },
  currentStatus: 'active',
  currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 1 },
} as const satisfies MarkHistoryChangedRecord['recordContent']
const knowledgeFix = (fix: 'fact' | 'caution', recordIds: string[]) =>
  ({ kind: 'applied', fix, change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds } }) as const
const FOUND = (recordId: string): MarkHistoryChangedRecord => ({ recordId, recordContent: { ...CONTENT, applicability: { ...CONTENT.applicability, anchors: [] } } })
const GONE = (recordId: string): MarkHistoryChangedRecord => ({ recordId, contentAbsence: { reason: 'not-found' } })

// Sequence A: run0, step 0:2, run0, run1, step 0:2, run0. Writer-shaped `supersedes` links.
function sequenceA(): ReadEntry[] {
  return [
    { receipt: receipt(1, { testIndex: 0 }, { note: 'first run-level mark',
      disposition: knowledgeFix('fact', ['mem_a1', 'mem_a1b']) }), changedRecords: [FOUND('mem_a1'), GONE('mem_a1b')] },
    { receipt: receipt(2, { testIndex: 0, stepIndex: 2 }, { kind: 'false-pass',
      disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 1, procedureReads: 0, assertionDrift: true } } }) },
    { receipt: receipt(3, { testIndex: 0 }, { kind: 'confirmed-bug', supersedes: markIdOf(1),
      rootCause: { class: 'app_bug', producer: 'verifier' }, isRerun: true,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 2 },
      evidence: { confirmed: 2, overturned: 0 } }) },
    { receipt: receipt(4, { testIndex: 1, testId: 'checkout' }, { kind: 'false-fail',
      disposition: { kind: 'applied', fix: 'test-edit', change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'abc' } } }) },
    { receipt: receipt(5, { testIndex: 0, stepIndex: 2 }, { supersedes: markIdOf(2),
      evidence: { confirmed: 0, overturned: 1 } }) },
    // A legacy receipt from an existing ledger filed a proposal; nothing is joined for it.
    { receipt: receipt(6, { testIndex: 0 }, { supersedes: markIdOf(3), note: 'latest run-level mark',
      disposition: { kind: 'drafted', fix: 'caution', proposalId: 'proposal-a6', proposalKind: 'knowledge' } }) },
  ]
}

// Sequence B: step 1:0, run1, run0, run1 under another testId, step 1:0. No `supersedes` links at all.
function sequenceB(): ReadEntry[] {
  return [
    { receipt: receipt(1, { testIndex: 1, stepIndex: 0 }) },
    { receipt: receipt(2, { testIndex: 1 }, { kind: 'false-pass' }) },
    { receipt: receipt(3, { testIndex: 0 }, { kind: 'confirmed-bug', disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } }) },
    { receipt: receipt(4, { testIndex: 1, testId: 'renamed-member' }) },
    { receipt: receipt(5, { testIndex: 1, stepIndex: 0 }, { note: 'second step mark' }) },
  ]
}

// Hand-spelled oracles, independent of any implementation rule.
const EXPECTED = {
  A: { active: [4, 5, 6], supersededBy: { 1: 3, 2: 5, 3: 6 } as Record<number, number> },
  B: { active: [3, 4, 5], supersededBy: { 1: 5, 2: 4 } as Record<number, number> },
}
const SEQUENCES = { A: sequenceA, B: sequenceB } as const

function port(read: unknown) {
  return { history: vi.fn(async (_runId: RunId) => read) }
}

function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}

function deps(feedbackReads?: ReturnType<typeof port>, secretMask: MaskFn | null = text => text) {
  const forbidden = vi.fn(() => { throw new Error('history must not touch runs, config or the mark writer') })
  return {
    forbidden,
    deps: {
      runs: { list: forbidden, get: forbidden, readEvents: forbidden, readStepEvidence: forbidden },
      knowledge: { listBundles: forbidden, inspectRecords: forbidden, diffSince: forbidden, showRecord: forbidden },
      entities: { resolve: forbidden, get: forbidden },
      config: { getMasked: forbidden },
      feedback: { mark: forbidden, marksFor: forbidden },
      ...(feedbackReads === undefined ? {} : { feedbackReads }),
      ...(secretMask === null ? {} : { secretMask }),
    } as unknown as FunctionDeps,
  }
}

async function read(entries: readonly ReadEntry[], secretMask?: MaskFn | null) {
  const reads = port({ kind: 'history', entries })
  const { deps: bound, forbidden } = deps(reads, secretMask)
  const result = await historySpec().invoke({ runId }, bound)
  expect(forbidden).not.toHaveBeenCalled()
  expect(reads.history).toHaveBeenCalledWith(runId)
  return result as unknown as { kind: string; runId: RunId; entries: Record<string, unknown>[] }
}

function expectedFacts(value: MarkReceipt): Record<string, unknown> {
  const { schemaVersion: _version, runSlug: _slug, ...facts } = value
  return facts
}

describe('runs.marks.history contract', () => {
  it.each(['A', 'B'] as const)('HISTORY-ORDINAL: sequence %s returns every receipt fact in ledger ordinal order', async name => {
    const entries = SEQUENCES[name]()
    const result = await read(entries)
    expect(resultSchema().parse(result)).toEqual(result)
    expect(result.kind).toBe('history')
    expect(result.runId).toBe(runId)
    expect(result.entries.map(entry => entry.ordinal)).toEqual(entries.map((_, index) => index + 1))
    result.entries.forEach((entry, index) => {
      const source = entries[index]!
      expect(entry).toMatchObject(expectedFacts(source.receipt))
      // Absent optional facts stay absent keys, never null.
      expect(Object.values(entry)).not.toContain(null)
      expect(Object.values(entry)).not.toContain(undefined)
      if (source.receipt.note === undefined) expect(Object.keys(entry)).not.toContain('note')
      if (source.receipt.stepIndex === undefined) expect(Object.keys(entry)).not.toContain('stepIndex')
    })
  })

  it('HISTORY-ORDINAL: a port read out of ordinal order or for another run is a corrupt ledger, never re-sorted', async () => {
    const [first, second, third] = sequenceB()
    const swapped = await read([first!, third!, second!])
    expect(swapped).toEqual({ kind: 'ledger-corrupt', runId, line: 2 })
    const foreign = { receipt: { ...second!.receipt, runId: asRunId('run-423-other') } }
    expect(await read([first!, foreign])).toEqual({ kind: 'ledger-corrupt', runId, line: 2 })
  })

  it.each(['A', 'B'] as const)('ACTIVE-ADDRESS: sequence %s marks only the highest ordinal per member/step address active', async name => {
    const result = await read(SEQUENCES[name]())
    const active = result.entries.filter(entry => entry.active === true).map(entry => entry.ordinal)
    expect(active).toEqual(EXPECTED[name].active)
    expect(result.entries.every(entry => typeof entry.active === 'boolean')).toBe(true)
  })

  it.each(['A', 'B'] as const)('SUPERSEDED-BY: sequence %s links each superseded receipt to the next mark on its address', async name => {
    const result = await read(SEQUENCES[name]())
    const links = Object.fromEntries(result.entries
      .filter(entry => 'supersededBy' in entry)
      .map(entry => [entry.ordinal, entry.supersededBy]))
    expect(links).toEqual(Object.fromEntries(Object.entries(EXPECTED[name].supersededBy)
      .map(([ordinal, next]) => [ordinal, markIdOf(next)])))
    for (const entry of result.entries) expect(entry.active).toBe(!('supersededBy' in entry))
  })

  it('SUPERSEDED-BY: applied knowledge receipts carry the records they changed beside their historical disposition', async () => {
    const result = await read(sequenceA())
    const byOrdinal = new Map(result.entries.map(entry => [entry.ordinal, entry]))
    expect(byOrdinal.get(1)).toMatchObject({ disposition: knowledgeFix('fact', ['mem_a1', 'mem_a1b']),
      changedRecords: [FOUND('mem_a1'), GONE('mem_a1b')] })
    expect(byOrdinal.get(4)).toMatchObject({ disposition: { kind: 'applied', change: { kind: 'test-file', filePath: 'tests/checkout.yaml' } } })
    expect(byOrdinal.get(6)).toMatchObject({ disposition: { kind: 'drafted', proposalId: 'proposal-a6' } })
    for (const ordinal of [2, 3, 4, 5, 6]) expect(Object.keys(byOrdinal.get(ordinal)!)).not.toContain('changedRecords')
    // An applied knowledge receipt with no join, a join naming other records, or a join on any other
    // disposition is refused.
    const [, second, third] = sequenceA()
    const unjoined = { receipt: receipt(1, { testIndex: 0 }, { disposition: knowledgeFix('fact', ['mem_x']) }) }
    await expect(read([unjoined])).rejects.toThrow()
    await expect(read([{ ...unjoined, changedRecords: [FOUND('mem_other')] }])).rejects.toThrow()
    await expect(read([{ receipt: receipt(1, { testIndex: 0 }), changedRecords: [FOUND('mem_x')] }, second!, third!])).rejects.toThrow()
  })

  it('HISTORY-EMPTY: an unmarked run answers an empty history, distinct from a missing run', async () => {
    const result = await read([])
    expect(result).toEqual({ kind: 'history', runId, entries: [] })
    expect(resultSchema().parse(result)).toEqual(result)
    expect(historySpec().classify(RunsMarksHistoryResultSchema.parse(result))).toEqual({ status: 'executed', outcome: 'history: 0 marks' })
  })

  it('HISTORY-ERRORS: no-run, corrupt and unavailable ledgers are typed arms; an absent port is unbound', async () => {
    const cases = [
      [{ kind: 'run-not-found' }, { kind: 'run-not-found', runId }, 'refused'],
      [{ kind: 'ledger-corrupt', line: 3 }, { kind: 'ledger-corrupt', runId, line: 3 }, 'failed'],
      [{ kind: 'ledger-unavailable' }, { kind: 'ledger-unavailable', runId }, 'failed'],
    ] as const
    for (const [answer, expected, status] of cases) {
      const { deps: bound } = deps(port(answer))
      const result = await historySpec().invoke({ runId }, bound)
      expect(result).toEqual(expected)
      expect(resultSchema().parse(result)).toEqual(expected)
      expect(historySpec().classify(result).status).toBe(status)
    }
    const { deps: unbound } = deps()
    await expect(historySpec().invoke({ runId }, unbound)).rejects.toBeInstanceOf(spec.FunctionNotBoundError)
  })

  it('HISTORY-READ-TIER: read scope, read-only risk and a feedbackReads binding separate from the mark writer', async () => {
    const op = historySpec()
    expect(op.id).toBe('runs.marks.history')
    expect(op.resultKind).toBe('unary')
    expect(op.risk).toEqual({ name: 'fn:runs.marks.history', recognized: true, readOnly: true })
    expect(op.boundThrough).toBe('feedbackReads')
    expect(spec.OPTIONAL_FUNCTION_DEP_KEYS).toContain('feedbackReads')
    expect(spec.OPTIONAL_FUNCTION_DEP_KEYS).toContain('feedback')

    const reads = port({ kind: 'history', entries: sequenceB() })
    const { deps: bound, forbidden } = deps(reads)
    const options = { deps: bound }
    const caller: FunctionCaller = { surface: 'mcp', origin: 'agent' }
    const registry = createRegistryFromSpecs([{ ...op } as FunctionSpec], options)
    expect(registry.list(caller).find(entry => entry.id === 'runs.marks.history')?.bindingStatus).toBe('bound')
    const result = await invokeFunction(registry, 'runs.marks.history', { runId }, caller) as { entries: unknown[] }
    expect(result.entries).toHaveLength(5)
    expect(forbidden).not.toHaveBeenCalled()

    const unbound = createRegistryFromSpecs([{ ...op } as FunctionSpec], { ...options, deps: deps().deps })
    expect(unbound.list(caller).find(entry => entry.id === 'runs.marks.history')?.bindingStatus).toBe('unbound')
    await expect(invokeFunction(unbound, 'runs.marks.history', { runId }, caller)).rejects.toBeInstanceOf(spec.FunctionNotBoundError)
  })

  it('HISTORY-MASK: note, root-cause producer and changed record content cross the live mask; identities do not', async () => {
    const secret = 'synthetic-sensitive-token'
    const mask = declaredMask({ TOKEN_441: secret })
    const entries: ReadEntry[] = [
      { receipt: receipt(1, { testIndex: 0, testId: 'member-a' }, { note: `note ${secret}`,
        rootCause: { class: 'app_bug', producer: `producer ${secret}` },
        disposition: knowledgeFix('fact', ['mem_m1']) }),
      changedRecords: [{ recordId: 'mem_m1', recordContent: { ...CONTENT, applicability: { ...CONTENT.applicability, anchors: [] }, content: `content ${secret}` } }] },
    ]
    const result = await read(entries, mask)
    const [entry] = result.entries
    expect(entry).toMatchObject({
      markId: markIdOf(1), testId: 'member-a', note: mask(`note ${secret}`),
      rootCause: { class: 'app_bug', producer: mask(`producer ${secret}`) },
      disposition: knowledgeFix('fact', ['mem_m1']),
      changedRecords: [{ recordId: 'mem_m1', recordContent: { content: mask(`content ${secret}`) } }],
    })
    expect(JSON.stringify(result)).not.toContain(secret)

    expect(entry).toMatchObject({ note: 'note [secret:TOKEN_441]' })
    await expect(read(entries, null)).rejects.toThrow(/no declared-secret mask/)
    const unreadable = () => { throw new Error('synthetic unreadable secrets file') }
    await expect(read(entries, unreadable)).rejects.toThrow('synthetic unreadable secrets file')
  })
})
