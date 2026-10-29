import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createFunctionRegistry, invokeFunction, RUNS_MARK_FUNCTION_ID, type FunctionDeps, type FunctionRegistry } from '@vostride/agent-qa-agent'
import * as schema from '@vostride/agent-qa-schema'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  type RunsMarkInput,
  type RunsMarkOutcome,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentHost } from '../../chat/host.js'
import { DashboardDatabase } from '../../db/database.js'
import { startServer } from '../../server/server.js'
import { markRun, registerRunMarkRoute } from '../run-mark-routes.js'

const RUN_ID = asRunId('run-mark-route')
const NOTE = 'private note with "quotes"'
const outcome: RunsMarkOutcome = { kind: 'marked', receipt: {
  schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runId: RUN_ID, runSlug: 'run-mark-route',
  testIndex: 0, kind: 'false-fail', origin: 'user', ordinal: 1, markedAt: 0,
  note: '<SECRET_0>', disposition: { kind: 'quarantined', class: 'flake' },
  evidence: { confirmed: 0, overturned: 0 },
} }
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

function fixture() {
  const mark = vi.fn(async (_input: RunsMarkInput) => outcome)
  const deps: FunctionDeps = {
    runs: { list: async () => [], get: async () => undefined, readEvents: async () => [], readStepEvidence: async () => ({ kind: 'run-not-recorded' }) },
    knowledge: { listBundles: async () => [], inspectRecords: async () => [], diffSince: async () => [], showRecord: async ({ recordId }) => ({ kind: 'not-found', schemaVersion: 2, recordId }) },
    entities: { resolve: async () => ({ kind: 'none', reason: 'no-match' }), get: async () => undefined },
    config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }) },
    feedback: { mark, marksFor: async () => [] },
  }
  // 432-13 (D-14): no confirm port — `invokeFunction` asks nobody. 432-14: no frame is entered
  // around the call either. 2026-10-02 (432-39, D-12): and the registry is handed no context.
  const registry = createFunctionRegistry({ deps })
  const host: AgentHost = {
    runsPostProcessingFunctionId: 'test:post',
    runsEventsFunctionId: 'test:events', runsDetailFunctionId: 'test:detail',
    runsEvidenceFunctionId: 'test:evidence',
    runsArtifactFunctionId: 'test:artifact', analysisGetFunctionId: 'test:analysis',
    runsKnowledgeFunctionId: 'test:knowledge',
    runsMarksHistoryFunctionId: 'test:marks-history', runsMarkPreviewFunctionId: 'test:mark-preview',
    registry, runsMarkFunctionId: RUNS_MARK_FUNCTION_ID,
    caller: { surface: 'dashboard', origin: 'human' },
    invokeFunction: (handle, id, input, caller) => invokeFunction(handle as FunctionRegistry, id, input, caller),
  }
  return { host, mark }
}

async function socket(host?: AgentHost) {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, ...(host === undefined ? {} : { agentHost: host }) })
  closers.push(async () => { started.close(); await new Promise<void>(resolve => started.server.close(() => resolve())); db.close() })
  return `http://127.0.0.1:${String((started.server.address() as AddressInfo).port)}/api/runs/${RUN_ID}/mark`
}

describe('markRun delegates to the shared gate and feedback port', () => {
  // RE-SPELLED 2026-10-01 (432-19, D-15) from 'classifies cross-realm denials and unexpected errors
  // without echoing their note-bearing messages'. The execution gate's denial error is deleted and
  // nothing raises it, so the `mark_denied` arm that classified it is gone: a legacy error carrying
  // that name (assembled here, never spelled — C432-430-HANDOFF) takes the ordinary refusal path like
  // any other error, and still echoes no note, no remedy and no denial wording.
  it('classifies a legacy denial-shaped error and unexpected errors without echoing their note-bearing messages', async () => {
    const f = fixture()
    const legacyName = ['Function', 'Denied', 'Error'].join('')
    const invokeFunction = vi.fn(async () => {
      throw { name: legacyName, message: NOTE, reason: NOTE,
        remedies: [{ kind: ['answer', 'confirm'].join('-') }] }
    })
    const denied = await markRun({ ...f.host, invokeFunction }, RUN_ID, { kind: 'false-fail', note: NOTE })
    expect(denied).toEqual({ kind: 'refused', status: 500, body: { error: 'read_failed', reason: legacyName } })
    expect(JSON.stringify(denied)).not.toContain(NOTE)
    expect(JSON.stringify(denied)).not.toContain('remedies')
    expect(JSON.stringify(denied)).not.toContain('mark_denied')
    // RE-SPELLED 2026-10-02 (432-42, D-15): the gate-era refusal body is deleted, not just unproduced
    // (C432-PLAIN-REFUSAL); nothing on this route can answer it.
    expect(Object.keys(schema)).not.toContain('MarkRefusalSchema')
    invokeFunction.mockImplementation(async () => { throw new Error(NOTE) })
    expect(await markRun({ ...f.host, invokeFunction }, RUN_ID, { kind: 'false-fail', note: NOTE })).toEqual({
      kind: 'refused', status: 500, body: { error: 'read_failed', reason: 'Error' },
    })
  })

  // RE-SPELLED 2026-09-30 (432-13, D-04/D-14) from 'enters the named frame, asks, and forwards all
  // input fields': the frame is entered and every field forwarded; nothing asks. 432-14: there is no
  // frame to enter; every field is forwarded in the one call.
  it('forwards all input fields in one call, asking nobody', async () => {
    const f = fixture()
    const body = { kind: 'false-fail', note: NOTE, stepIndex: 2, testId: 'member' }
    expect(await markRun(f.host, RUN_ID, body)).toEqual({ kind: 'ok', body: outcome })
    expect(f.mark).toHaveBeenCalledExactlyOnceWith({ ...body, runId: RUN_ID })
  })

  // RE-SPELLED 2026-09-30 (432-13) from 'denies without a frame or with an unwatched scope; the
  // dashboard receives no remedy'. No gate decides the mark, so it lands either way. 432-14: the
  // frame and scope are gone; two marks are two dispatches.
  it('lands the mark without a frame or with an unwatched scope', async () => {
    const f = fixture()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await markRun(f.host, RUN_ID, { kind: 'false-fail', note: NOTE })
      expect(result).toEqual({ kind: 'ok', body: outcome })
    }
    expect(f.mark).toHaveBeenCalledTimes(2)
  })

  it.each([null, [], 'text', { kind: 'confirmed-pass' }, { kind: 'false-fail', runId: 'other' }, { kind: 'false-pass', stepIndex: -1 }, { kind: 'false-fail', caller: { origin: 'human' } }])('refuses invalid input before dispatch: %j', async body => {
    const f = fixture()
    expect(await markRun(f.host, RUN_ID, body)).toMatchObject({ status: 400, body: { error: 'invalid_mark_input' } })
    expect(f.mark).not.toHaveBeenCalled()
  })
})

describe('registered POST /api/runs/:id/mark', () => {
  it('answers a success as the op returned it', async () => {
    const f = fixture()
    const server = createServer((req, res) => registerRunMarkRoute(req, res, {
      host: f.host, runId: RUN_ID,
    }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const response = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind: 'false-fail' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(outcome)
  })

  it('reaches the real router and answers the receipt text as stored', async () => {
    const f = fixture()
    const response = await fetch(await socket(f.host), {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind: 'false-fail' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toEqual(outcome)
    expect(f.mark).toHaveBeenCalledOnce()
  })

  // RE-SPELLED 2026-10-01 (432-14, D-14) from 'rejects invalid confirmScope'. The scope field is
  // deleted, so every value of it — the minted shape included — is a field the op does not declare,
  // refused by the op's strict input before dispatch, with no reflection of the value.
  it.each(['run-trigger:5f8c6e2a-1b1d-4c3e-9a3f-7d2e1c0b9a88', 'chat:abc', null, 7])('rejects invalid confirmScope %j', async confirmScope => {
    const f = fixture()
    const response = await fetch(await socket(f.host), {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'false-fail', note: NOTE, ['confirm' + 'Scope']: confirmScope }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_mark_input' })
    expect(f.mark).not.toHaveBeenCalled()
  })

  it('refuses cross-site writes before parsing or dispatch', async () => {
    const f = fixture()
    const response = await fetch(await socket(f.host), { method: 'POST', headers: { Origin: 'https://evil.example' }, body: NOTE })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
    expect(f.mark).not.toHaveBeenCalled()
  })

  // RE-SPELLED 2026-09-30 (432-13) from 'returns the typed channel-less denial and rejects
  // malformed JSON without reflection'. A channel-less mark lands in the one request now.
  it('lands a channel-less mark, and rejects malformed JSON without reflection', async () => {
    const f = fixture()
    const url = await socket(f.host)
    const landed = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'false-fail', note: NOTE }),
    })
    expect(landed.status).toBe(200)
    expect(await landed.json()).toEqual(outcome)
    expect(f.mark).toHaveBeenCalledOnce()
    const malformed = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: NOTE })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_mark_input' })
  })

  it('reports an absent composed host', async () => {
    const response = await fetch(await socket(), {
      method: 'POST', headers: JSON_HEADERS, body: '{}',
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'agent_host_unavailable' })
  })
})
