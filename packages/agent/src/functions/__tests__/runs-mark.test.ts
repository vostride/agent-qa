import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  RunDetailProjectionSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  FeedbackPort,
  FunctionCaller,
  MarkReceipt,
  RunDetailRows,
  RunsMarkInput,
  RunsMarkOutcome,
} from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'

import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { RUNS_MARK_FUNCTION_ID, runsMarkSpec } from '../ops/runs-mark.js'
import { runsDetailSpec } from '../ops/runs-detail.js'
import { createFunctionRegistry } from '../registry.js'
import type { FunctionDeps } from '../spec.js'

const RUN_ID = asRunId('run-alpha')
const INPUT: RunsMarkInput = { runId: RUN_ID, kind: 'false-fail', note: 'private note' }
const CALLER: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}
// 2026-10-01 (432-21, D-12): `STANDING_APPROVAL_SCOPE` is deleted with the MCP bearer credential, so
// the legacy credential a pre-432 bearer carried is spelled as its bytes. Nothing reads it.
// 2026-10-02 (432-39, D-02/D-12): the caller's `credential` member is deleted, so the legacy bytes
// are smuggled past the type with a cast; the cells below still prove nothing consults them.
const TRUSTED = { ...CALLER, credential: { scope: { project: 'local-workspace' } } } as FunctionCaller

function receipt(overrides: Partial<MarkReceipt> = {}): MarkReceipt {
  return {
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION,
    markId: 'mark_0123456789ab',
    runId: RUN_ID,
    runSlug: 'run-alpha',
    testIndex: 0,
    kind: 'false-fail',
    origin: 'user',
    ordinal: 1,
    markedAt: 0,
    note: INPUT.note,
    disposition: { kind: 'quarantined', class: 'flake' },
    evidence: { confirmed: 0, overturned: 0 },
    ...overrides,
  }
}

function deps(feedback?: FeedbackPort): FunctionDeps {
  return {
    runs: {
      list: async () => [], get: async () => undefined, readEvents: async () => [],
      readStepEvidence: async () => ({ kind: 'run-not-recorded' }),
    },
    knowledge: {
      listBundles: async () => [], inspectRecords: async () => [], diffSince: async () => [],
      showRecord: async ({ recordId }) => ({ kind: 'not-found', schemaVersion: 2, recordId }),
    },
    entities: { resolve: async () => ({ kind: 'none', reason: 'no-match' }), get: async () => undefined },
    config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }) },
    ...(feedback === undefined ? {} : { feedback }),
  }
}

function host(feedback?: FeedbackPort) {
  return createFunctionRegistry({
    deps: deps(feedback),
  })
}

function stub() {
  const outcome: RunsMarkOutcome = { kind: 'marked', receipt: receipt() }
  const mark = vi.fn(async (_input: RunsMarkInput) => outcome)
  const port: FeedbackPort = { mark, marksFor: async () => [] }
  return { port, mark, outcome }
}

describe('runs.mark registration and binding (419 GATE3-01)', () => {
  it('declares the lowercase-dot identity, write scope, shared risk and feedback binding', () => {
    expect(RUNS_MARK_FUNCTION_ID).toBe('runs.mark')
    expect(RUNS_MARK_FUNCTION_ID).toMatch(/^[a-z]+(?:\.[a-z]+)+$/)
    expect(runsMarkSpec.id).toBe(RUNS_MARK_FUNCTION_ID)
    // RE-SPELLED 2026-10-01 (432-24, D-12) from `requiredScopes` equal to ['knowledge-write']: the
    // op declares no scope; its write is stated by the shared-tier risk below.
    expect(runsMarkSpec).not.toHaveProperty('requiredScopes')
    expect(runsMarkSpec.risk.declaredTier).toBe('mutating-shared')
    expect(runsMarkSpec.risk.readOnly).toBe(false)
    expect(runsMarkSpec).not.toHaveProperty('requiresHumanOrigin')
    expect(runsMarkSpec.boundThrough).toBe('feedback')
  })

  it('lists an unbound host by name and refuses through the registry and body', async () => {
    const registry = host()
    expect(registry.list(CALLER).find(({ id }) => id === RUNS_MARK_FUNCTION_ID)?.bindingStatus).toBe('unbound')
    // 2026-10-02 (432-39): no gate precedes the binding check; any caller observes the named absence.
    await expect(invokeFunction(registry, RUNS_MARK_FUNCTION_ID, INPUT, TRUSTED)).rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(runsMarkSpec.invoke(INPUT, {} as FunctionDeps)).rejects.toBeInstanceOf(FunctionNotBoundError)
  })

  it('forwards the complete false-fail input and returns the port outcome unchanged', async () => {
    const { port, mark, outcome } = stub()
    expect(await runsMarkSpec.invoke(INPUT, deps(port))).toBe(outcome)
    expect(await invokeFunction(host(port), RUNS_MARK_FUNCTION_ID, INPUT, TRUSTED)).toEqual(outcome)
    expect(mark.mock.calls).toEqual([[INPUT], [INPUT]])
  })

  // RE-SPELLED 2026-10-01 (432-20, D-12) from 'requires knowledge-write even when the caller holds
  // a standing credential'. No scope is required: a read-only caller's mark reaches the port once.
  it('marks for a caller holding only read, reaching the port once', async () => {
    const { port, mark, outcome } = stub()
    const readOnly = { ...TRUSTED, grantedScopes: ['read'] } as FunctionCaller
    await expect(invokeFunction(host(port), RUNS_MARK_FUNCTION_ID, INPUT, readOnly))
      .resolves.toEqual(outcome)
    expect(mark.mock.calls).toEqual([[INPUT]])
  })
})

// RE-SPELLED 2026-09-30 (432-13, D-04/D-14) from 'no-TTY gate on the actual mark op (419
// D-13/D-20)'. The op gate is gone: a mark from a no-TTY caller reaches the port once, whatever
// credential it carries or lacks, and nobody is asked.
describe('C432-INVOKE-DIRECT — the mark op reaches its port in one call (432-13)', () => {
  it('C432-INVOKE-DIRECT: an uncredentialed MCP agent reaches the port once, with no refusal', async () => {
    const { port, mark, outcome } = stub()
    expect(await invokeFunction(host(port), RUNS_MARK_FUNCTION_ID, INPUT, CALLER)).toEqual(outcome)
    expect(mark.mock.calls).toEqual([[INPUT]])
  })

  it('lets the same MCP agent reach the port once with the exact standing scope', async () => {
    const { port, mark, outcome } = stub()
    expect(await invokeFunction(host(port), RUNS_MARK_FUNCTION_ID, INPUT, TRUSTED)).toEqual(outcome)
    expect(mark.mock.calls).toEqual([[INPUT]])
  })

  it('C432-INVOKE-DIRECT: a mismatched credential is not consulted, and the port is reached once', async () => {
    const { port, mark, outcome } = stub()
    expect(await invokeFunction(host(port), RUNS_MARK_FUNCTION_ID, INPUT, {
      ...CALLER, credential: { scope: { project: 'another-workspace' } },
    } as FunctionCaller)).toEqual(outcome)
    expect(mark.mock.calls).toEqual([[INPUT]])
  })
})

describe('mark outcome classifications omit producer text', () => {
  it.each<RunsMarkOutcome>([
    { kind: 'run-not-found', runId: RUN_ID },
    { kind: 'member-not-found', runId: RUN_ID, testId: 'private member name' },
    { kind: 'step-not-found', runId: RUN_ID, testIndex: 0, stepIndex: 9, stepCount: 3 },
    { kind: 'ambiguous-address', runId: RUN_ID, candidates: [{ testIndex: 0 }, { testIndex: 1 }] },
  ])('classifies $kind as refused', output => {
    expect(runsMarkSpec.classify!(output).status).toBe('refused')
    expect(runsMarkSpec.classify!(output).outcome).not.toContain('private')
  })

  it('classifies new and identical marks as executed without including the note', () => {
    expect(runsMarkSpec.classify!({ kind: 'marked', receipt: receipt() })).toEqual({
      status: 'executed', outcome: 'marked false-fail · quarantined',
    })
    expect(runsMarkSpec.classify!({ kind: 'already-marked', receipt: receipt() })).toEqual({
      status: 'executed', outcome: 'already marked: identical repeat, prior receipt returned',
    })
  })

  // 432-09 (D-04): an applied fix classifies by its governed kind only; the ids, path and note it
  // changed stay on the receipt and never reach the receipt line.
  it('classifies an applied fix by kind alone, never by the records or file it changed', () => {
    const knowledge = receipt({ disposition: { kind: 'applied', fix: 'fact',
      change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_private_record'] } } })
    const file = receipt({ disposition: { kind: 'applied', fix: 'test-edit',
      change: { kind: 'test-file', filePath: 'tests/private-path.yaml', contentDigest: 'abc' } } })
    for (const value of [knowledge, file]) {
      const verdict = runsMarkSpec.classify!({ kind: 'marked', receipt: value })
      expect(verdict).toEqual({ status: 'executed', outcome: 'marked false-fail · applied' })
      expect(verdict.outcome).not.toMatch(/private|prop_/)
    }
    expect(runsMarkSpec.summary).toContain('apply the fix')
    expect(runsMarkSpec.summary).not.toMatch(/proposal/)
  })
})

describe('runs.detail mark projection (419 D-11/D-15)', () => {
  const rows: RunDetailRows = {
    runId: RUN_ID,
    // Deliberately not positional: marks join by testIndex, not by array offset.
    members: [{ testIndex: 4, attempts: 1 }, { testIndex: 0, attempts: 1 }],
    steps: [],
    subActions: [],
  }

  function detailDeps(feedback?: FeedbackPort): FunctionDeps {
    return { ...deps(feedback), runDetail: { read: async () => rows } }
  }

  it('projects latest ordinals per address, run-level first then ascending step indexes', async () => {
    const run = receipt({ ordinal: 3, kind: 'confirmed-bug' })
    const step = receipt({ stepIndex: 2 })
    const stepZero = receipt({ stepIndex: 0, ordinal: 2 })
    // Out of ordinal order so taking the last array entry is observably wrong.
    const history = [step, run, receipt(), stepZero]
    const before = JSON.stringify(history)
    const marksFor = vi.fn(async () => history)
    const result = await runsDetailSpec.invoke({ runId: RUN_ID }, detailDeps({ ...stub().port, marksFor }))
    expect(marksFor.mock.calls).toEqual([[RUN_ID]])
    expect(result.members[1]!.marks).toEqual([run, stepZero, step].map(mark => ({
      markId: mark.markId, kind: mark.kind, ordinal: mark.ordinal,
      ...(mark.stepIndex === undefined ? {} : { stepIndex: mark.stepIndex }),
      disposition: mark.disposition,
    })))
    expect(result.members[0]!.marks).toEqual([])
    expect('marks' in rows.members[1]!).toBe(false)
    expect(JSON.stringify(history)).toBe(before)
    expect(RunDetailProjectionSchema.parse(result)).toEqual(result)
  })

  it('omits marks only when unbound and enables first-use controls with a bound empty ledger', async () => {
    const unbound = await runsDetailSpec.invoke({ runId: RUN_ID }, detailDeps())
    const empty = await runsDetailSpec.invoke({ runId: RUN_ID }, detailDeps(stub().port))
    expect(empty.members.map(member => member.marks)).toEqual([[], []])
    expect(RunDetailProjectionSchema.parse(empty)).toEqual(empty)
    expect(unbound.members.every(member => !('marks' in member))).toBe(true)
    expect(RunDetailProjectionSchema.parse(unbound)).toEqual(unbound)
  })

  it('propagates a bound marksFor failure instead of presenting an unmarked run', async () => {
    const failure = new Error('ledger unavailable')
    await expect(runsDetailSpec.invoke({ runId: RUN_ID }, detailDeps({
      ...stub().port, marksFor: async () => { throw failure },
    }))).rejects.toBe(failure)
  })
})
