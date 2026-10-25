import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import {
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryResultSchema,
  type MarkHistoryEntry,
} from '@vostride/agent-qa-schema'
import { fetchMarkPreview, fetchMarksHistory } from '../api'

const RUN_ID = generateRunId()
const TEST_ID = generateTestId()
const ENCODED = encodeURIComponent(RUN_ID)

afterEach(() => {
  vi.unstubAllGlobals()
})

const CONSEQUENCES = RunsMarkPreviewResultSchema.parse({
  kind: 'consequences',
  runId: RUN_ID,
  prospective: true,
  markKind: 'false-fail',
  member: { testIndex: 0, testId: TEST_ID },
  resolvedStep: { stepIndex: 2, reason: 'step-mark' },
  latest: { kind: 'first' },
  basis: { ledgerOrdinal: 0 },
  knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
  draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
})

function historyEntry(ordinal: number, over: Partial<MarkHistoryEntry> = {}): MarkHistoryEntry {
  return {
    markId: `mark_00000000000${String(ordinal)}`,
    runId: RUN_ID,
    testIndex: 0,
    testId: TEST_ID,
    kind: 'false-fail',
    origin: 'user',
    ordinal,
    markedAt: 1_758_600_000_000 + ordinal,
    disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
    evidence: { confirmed: 0, overturned: 0 },
    active: true,
    ...over,
  } as MarkHistoryEntry
}

const FIRST = historyEntry(1, { active: false, supersededBy: 'mark_000000000002' })
const SECOND = historyEntry(2, { kind: 'confirmed-bug', disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } })

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('426-01 feedback read clients', () => {
  // 432-14: the page holds no confirm scope to leak; the body is still exactly the preview input.
  it('PREVIEW-CLIENT-BODY posts runId and never the confirm scope, and returns the parsed read', async () => {
    const fetchMock = respond(200, CONSEQUENCES)
    vi.stubGlobal('fetch', fetchMock)
    const read = await fetchMarkPreview(RUN_ID, { kind: 'false-fail', testId: TEST_ID, stepIndex: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/runs/${ENCODED}/mark-preview`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual({ runId: RUN_ID, kind: 'false-fail', testId: TEST_ID, stepIndex: 2 })
    expect(body).not.toHaveProperty('confirmScope')
    expect(read).toEqual({ kind: 'read', result: CONSEQUENCES })
  })

  it.each([
    ['500 read_failed MarkLedgerCorruptError', respond(500, { error: 'read_failed', reason: 'MarkLedgerCorruptError' }), 'ledger-corrupt'],
    ['500 read_failed KnowledgeReadError', respond(500, { error: 'read_failed', reason: 'KnowledgeReadError' }), 'ledger-unavailable'],
    ['400 invalid input', respond(400, { error: 'invalid_mark_preview_input' }), 'refused'],
    ['404 unknown run', respond(404, { error: 'unknown_run' }), 'refused'],
    ['503 unbound host', respond(503, { error: 'agent_host_unavailable', reason: 'not bound' }), 'refused'],
    ['200 schema mismatch', respond(200, { kind: 'nope' }), 'shape'],
    ['thrown fetch', vi.fn(async () => { throw new TypeError('offline') }), 'network'],
  ] as const)('PREVIEW-CLIENT-FAILURES maps %s to a typed failure', async (_label, fetchMock, reason) => {
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchMarkPreview(RUN_ID, { kind: 'confirmed-bug', testId: TEST_ID })).resolves.toEqual({ kind: 'failed', reason })
  })

  it.each([
    ['history', { kind: 'history', runId: RUN_ID, entries: [FIRST, SECOND] }],
    ['run-not-found', { kind: 'run-not-found', runId: RUN_ID }],
    ['ledger-corrupt', { kind: 'ledger-corrupt', runId: RUN_ID, line: 3 }],
    ['ledger-unavailable', { kind: 'ledger-unavailable', runId: RUN_ID }],
  ] as const)('HISTORY-CLIENT-ARMS returns the %s arm as a read', async (kind, body) => {
    const fetchMock = respond(200, RunsMarksHistoryResultSchema.parse(body))
    vi.stubGlobal('fetch', fetchMock)
    const read = await fetchMarksHistory(RUN_ID)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/runs/${ENCODED}/marks`)
    expect(read).toEqual({ kind: 'read', result: body })
    expect(read.kind === 'read' ? read.result.kind : undefined).toBe(kind)
  })

  it.each([
    ['an out-of-order entry list', respond(200, { kind: 'history', runId: RUN_ID, entries: [SECOND, FIRST] }), 'shape'],
    ['503', respond(503, { error: 'agent_host_unavailable', reason: 'not bound' }), 'refused'],
    ['a thrown fetch', vi.fn(async () => { throw new TypeError('offline') }), 'network'],
  ] as const)('HISTORY-CLIENT-ARMS maps %s to a typed failure', async (_label, fetchMock, reason) => {
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchMarksHistory(RUN_ID)).resolves.toEqual({ kind: 'failed', reason })
  })
})
