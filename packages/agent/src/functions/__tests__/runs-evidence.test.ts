import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  asRunId, EvidenceEntrySchema, RunsEvidenceInputSchema, RunsEvidenceResultSchema,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  EvidenceDocument, EvidenceEntry, EvidenceKind, FunctionCaller, MaskFn, RunDetailRows, RunDetailStep,
  RunDetailSubAction, RunsEvidenceInput,
} from '@vostride/agent-qa-schema'
import { runsEvidenceSpec } from '../ops/runs-evidence.js'
import { sniffEvidenceContentType } from '../ops/runs-artifact.js'
import { FunctionNotBoundError, type FunctionDeps } from '../spec.js'
import { RunNotFoundError } from '../ops/runs-get.js'
import { createFunctionRegistry } from '../registry.js'
import { invokeFunction } from '../invoke.js'

const runId = asRunId('run-evidence-read')
const kinds = ['console', 'network', 'a11y', 'aria', 'variables'] as const
const documents: Record<EvidenceKind, EvidenceDocument> = {
  console: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [{ level: 'error', text: 'recorded console', timestamp: 2 }] },
  network: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{ url: 'https://example.test/api', method: 'GET', status: 403, requestHeaders: {}, responseHeaders: {}, startTime: 1, endTime: 2, body: 'recorded response' }] },
  a11y: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y', records: [{ ruleId: 'label', impact: 'serious', description: 'recorded violation', help: 'label input', helpUrl: 'https://example.test/rule', nodes: [{ html: '<input>', target: ['#field'] }] }] },
  aria: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: 'button "recorded before tree"' },
  variables: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: { captured: { value: 'recorded value', source: 'capture' } } },
}
const counts = {
  console: { total: 1, errors: 1, warnings: 0 }, network: { total: 1, failed: 1, errored: 0 },
  a11y: { minor: 0, moderate: 0, serious: 1, critical: 0 }, variables: { count: 1 },
}
function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}
const identity: MaskFn = text => text
function bytesOf(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)) }
function entryFor(kind: EvidenceKind, bytes: Uint8Array): EvidenceEntry {
  if (kind === 'variables') return { kind, state: 'present', counts: counts.variables }
  const sha = createHash('sha256').update(bytes).digest('hex')
  const ref = { id: `${kind === 'aria' ? 'aria-state' : `${kind}-evidence`}:${sha}`, sha }
  return EvidenceEntrySchema.parse({ kind, state: 'present', ref, ...(kind === 'aria' ? {} : { counts: counts[kind] }) })
}
function fixture(kind: EvidenceKind, document: unknown = documents[kind], secretMask: MaskFn | null = identity) {
  const bytes = bytesOf(document)
  const entry = entryFor(kind, bytes)
  const evidence = {
    console: { kind: 'console', state: 'absent', reason: 'empty' },
    network: { kind: 'network', state: 'absent', reason: 'not-captured' },
    a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
    variables: { kind: 'variables', state: 'absent', reason: 'failed' },
    ...(kind === 'aria' ? {} : { [kind]: entry }),
  } as RunDetailStep['evidence']
  const step: RunDetailStep = {
    testIndex: 2, stepIndex: 3, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: 'done' },
    selfHealOccurred: false, briefDigest: 'brief', evidence,
    ...(kind === 'variables' ? { variableSnapshot: documents.variables.kind === 'variables' ? documents.variables.records : {} } : {}),
  }
  const child: RunDetailSubAction = {
    testIndex: 2, stepIndex: 3, subActionIndex: 4, plan: 'recorded', plannedAction: { type: 'navigate', to: 'url', url: 'https://example.test' },
    result: { success: true }, screenStateHash: 'before',
    ...(kind === 'aria' ? { ariaEvidence: entry as RunDetailSubAction['ariaEvidence'], artifactRefs: 'ref' in entry ? [entry.ref] : [] } : {}),
  }
  const rows: RunDetailRows = { runId, members: [{ testIndex: 2, attempts: 1 }], steps: [step], subActions: [child] }
  const readBlob = vi.fn(async () => ({ status: 'found' as const, bytes }))
  const forbidden = vi.fn(() => { throw new Error('No handoff, configuration or mutation is permitted') })
  const deps = {
    runDetail: { read: vi.fn(async () => rows) }, evidenceBlobs: { read: readBlob },
    runs: { get: forbidden }, config: { getMasked: forbidden },
    ...(secretMask === null ? {} : { secretMask }),
  } as unknown as FunctionDeps
  const address: RunsEvidenceInput = { runId, testIndex: 2, stepIndex: 3, kind, ...(kind === 'aria' ? { subActionIndex: 4 } : {}) }
  return { bytes, entry, step, child, rows, deps, readBlob, forbidden, address,
    read: () => runsEvidenceSpec.invoke(address, deps) }
}

describe('EVIDENCE-ALL-KINDS', () => {
  it.each(kinds)('%s present returns its validated recorded document', async kind => {
    const f = fixture(kind)
    const before = JSON.stringify(f.rows)
    expect(await f.read()).toEqual({ address: f.address, outcome: 'ready', evidence: f.entry, document: documents[kind] })
    expect(RunsEvidenceResultSchema.safeParse(await f.read()).success).toBe(true)
    if (kind === 'variables') expect(f.readBlob).not.toHaveBeenCalled()
    else expect(f.readBlob).toHaveBeenCalledWith(runId, 'ref' in f.entry ? f.entry.ref.sha : '')
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(JSON.stringify(f.rows)).toBe(before)
  })
  it.each(kinds)('%s absent preserves capture-time reason without reading bytes', async kind => {
    const f = fixture(kind)
    const absent = { kind, state: 'absent' as const, reason: 'failed' as const }
    if (kind === 'aria') f.child.ariaEvidence = { ...absent, kind }
    else f.step.evidence = { ...f.step.evidence!, [kind]: absent }
    expect(await f.read()).toEqual({ address: f.address, outcome: 'absent', evidence: absent })
    expect(f.readBlob).not.toHaveBeenCalled()
  })
  it.each(kinds)('%s historical absence does not backfill a cleartext handoff', async kind => {
    const f = fixture(kind)
    delete f.step.evidence
    delete f.step.variableSnapshot
    delete f.child.ariaEvidence
    expect(await f.read()).toEqual({ address: f.address, outcome: 'absent', evidence: { kind, state: 'absent', reason: 'unavailable' } })
    expect(f.readBlob).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})

it('EVID-MISSING-BLOB returns unavailable plus evidenceIncomplete without mutating capture', async () => {
  const f = fixture('console')
  f.deps.evidenceBlobs!.read = async () => ({ status: 'blob_absent' })
  expect(await f.read()).toEqual({ address: f.address, outcome: 'absent', evidence: { kind: 'console', state: 'absent', reason: 'unavailable', evidenceIncomplete: true } })
  expect(f.step.evidence?.console).toEqual(f.entry)
})

it.each(['kind', 'schemaVersion', 'records', 'unknown-field', 'json', 'utf8'])(
  'EVID-BAD-BLOB %s is a typed read error preserving runtime capture', async fault => {
    const bad = { ...(fault === 'kind' ? documents.network : documents.console),
      ...(fault === 'schemaVersion' ? { schemaVersion: 3 } : {}),
      ...(fault === 'records' ? { records: 'bad' } : {}), ...(fault === 'unknown-field' ? { secret: 'synthetic' } : {}) }
    const f = fixture('console', bad)
    if (fault === 'json' || fault === 'utf8') {
      const bytes = fault === 'json' ? new TextEncoder().encode('{') : new Uint8Array([
        ...new TextEncoder().encode('{"schemaVersion":2,"kind":"console","records":[{"level":"error","text":"'),
        0xff,
        ...new TextEncoder().encode('","timestamp":1}]}'),
      ])
      f.step.evidence = { ...f.step.evidence!, console: entryFor('console', bytes) as NonNullable<RunDetailStep['evidence']>['console'] }
      f.deps.evidenceBlobs!.read = async () => ({ status: 'found', bytes })
    }
    const capture = f.step.evidence!.console
    expect(await f.read()).toEqual({ address: f.address, outcome: 'read-error', code: 'invalid-document', capture })
    expect(f.step.evidence!.console).toEqual(capture)
  },
)
it('EVIDENCE-SHA-MISMATCH hashes exact bytes before JSON parsing or masking', async () => {
  const f = fixture('console')
  f.deps.evidenceBlobs!.read = async () => ({ status: 'found', bytes: bytesOf(documents.aria) })
  expect(await f.read()).toEqual({ address: f.address, outcome: 'read-error', code: 'sha-mismatch', capture: f.entry })
})

describe('EVID-ADDRESS-REFUSAL', () => {
  it('rejects noncanonical paths, fractional/negative indexes, extra SHA and child-addressed console', () => {
    const f = fixture('console')
    for (const patch of [{ runId: '../run' }, { runId: 'run/name' }, { testIndex: -1 }, { stepIndex: 0.5 }, { subActionIndex: 2 }, { sha: 'a'.repeat(64) }, { kind: 'other' }]) {
      expect(RunsEvidenceInputSchema.safeParse({ ...f.address, ...patch }).success).toBe(false)
    }
  })
  it('refuses a different run returned by the port before any blob access', async () => {
    const f = fixture('console')
    f.rows.runId = 'other-run'
    expect(await f.read()).toMatchObject({ outcome: 'read-error', code: 'ref-not-owned' })
    expect(f.readBlob).not.toHaveBeenCalled()
  })
  it.each(['member', 'step', 'child', 'duplicate'])('%s never falls back to a nearby row', async missing => {
    const f = fixture('aria')
    if (missing === 'member') f.address.testIndex = 1
    if (missing === 'step') f.address.stepIndex = 1
    if (missing === 'child') f.address.subActionIndex = 1
    if (missing === 'duplicate') f.rows.subActions = [f.child, { ...f.child }]
    expect(await f.read()).toMatchObject({ outcome: 'read-error', code: missing === 'duplicate' ? 'ambiguous-address' : 'address-not-found' })
    expect(f.readBlob).not.toHaveBeenCalled()
  })
  it('refuses malformed/cross-kind refs on the addressed row', async () => {
    const f = fixture('console')
    f.step.evidence = { ...f.step.evidence!, console: { ...f.entry, ref: { id: 'aria-state:bad', sha: 'bad' } } } as RunDetailStep['evidence']
    expect(await f.read()).toMatchObject({ outcome: 'read-error', code: 'invalid-entry' })
    expect(f.readBlob).not.toHaveBeenCalled()
  })
  it('requires ARIA ref ownership in the selected child artifactRefs', async () => {
    const f = fixture('aria')
    f.child.artifactRefs = []
    expect(await f.read()).toEqual({ address: f.address, outcome: 'read-error', code: 'ref-not-owned', capture: f.entry })
    expect(f.readBlob).not.toHaveBeenCalled()
  })
})

it('ARIA-SELECTION selects the exact child and reports no selection as not-captured', async () => {
  const f = fixture('aria')
  f.rows.subActions = [{ ...f.child, subActionIndex: 0, ariaEvidence: { kind: 'aria', state: 'absent', reason: 'failed' } }, f.child]
  expect(await f.read()).toMatchObject({ outcome: 'ready', document: documents.aria })
  delete f.address.subActionIndex
  expect(await f.read()).toMatchObject({ outcome: 'absent', evidence: { kind: 'aria', state: 'absent', reason: 'not-captured' } })
  f.rows.subActions = []
  expect(await f.read()).toMatchObject({ outcome: 'absent', evidence: { reason: 'not-captured' } })
})
it('VARIABLES-INLINE preserves source and prototype names and rejects a missing snapshot', async () => {
  const f = fixture('variables')
  f.step.variableSnapshot = JSON.parse('{"__proto__":{"value":"[secret]","source":"hook"}}')
  expect(await f.read()).toMatchObject({ outcome: 'ready', document: { records: f.step.variableSnapshot } })
  delete f.step.variableSnapshot
  expect(await f.read()).toMatchObject({ outcome: 'read-error', code: 'snapshot-missing', capture: f.entry })
  expect(f.readBlob).not.toHaveBeenCalled()
})
it('EVIDENCE-MASK masks free-text keys and values with the live context while preserving bytes', async () => {
  const mask = declaredMask({ SYN_KEY: 'synthetic-sensitive' })
  const f = fixture('console', { ...documents.console, records: [{ level: 'error', text: 'synthetic-sensitive operator@example.test', timestamp: 1 }] }, mask)
  const before = Array.from(f.bytes)
  const result = await f.read()
  expect(result).toMatchObject({ outcome: 'ready', document: { records: [{ text: '[secret:SYN_KEY] operator@example.test' }] } })
  expect(JSON.stringify(result)).not.toContain('synthetic-sensitive')
  expect(f.bytes).toEqual(new Uint8Array(before))
  const variables = fixture('variables', documents.variables, mask)
  variables.step.variableSnapshot = { 'synthetic-sensitive': { value: 'synthetic-sensitive', source: 'capture' } }
  expect(await variables.read()).toMatchObject({ outcome: 'ready', document: { records: { '[secret:SYN_KEY]': { value: '[secret:SYN_KEY]', source: 'capture' } } } })
})
it('EVIDENCE-MASK-NO-CONTEXT refuses a valid document it cannot mask as masking-unavailable', async () => {
  const f = fixture('console', documents.console, null)
  const result = await f.read()
  expect(result).toEqual({ address: f.address, outcome: 'read-error', code: 'masking-unavailable', capture: f.entry })
  expect(JSON.stringify(result)).not.toContain('recorded console')
  expect(JSON.stringify(result)).not.toContain('"document"')
  expect(JSON.stringify(result)).not.toContain('masked:')
  expect(f.readBlob).toHaveBeenCalledWith(runId, 'ref' in f.entry ? f.entry.ref.sha : '')
})
it('EVIDENCE-MULTI-KEY keeps distinct keys, empty maps and stored order, and refuses masked key collisions', async () => {
  const mask = declaredMask({ BODY_KEY: 'recorded response' })
  const network: EvidenceDocument = { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [
    { url: 'https://example.test/api', method: 'POST', status: 200,
      requestHeaders: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      responseHeaders: { 'x-trace': 'trace-1', 'content-type': 'text/plain' },
      startTime: 1, endTime: 2, body: 'recorded response' },
    { url: 'https://example.test/health', method: 'GET', status: 204, requestHeaders: {}, responseHeaders: {}, startTime: 3, endTime: 4 },
  ] }
  const f = fixture('network', network, mask)
  const read = await f.read()
  expect(read).toMatchObject({ outcome: 'ready' })
  const records = (read as { document: Extract<EvidenceDocument, { kind: 'network' }> }).document.records
  const stored = (network as Extract<EvidenceDocument, { kind: 'network' }>).records
  expect(records).toHaveLength(stored.length)
  stored.forEach((record, index) => {
    expect(records[index]!.url).toBe(record.url)
    expect(Object.entries(records[index]!.requestHeaders)).toEqual(Object.entries(record.requestHeaders))
    expect(Object.entries(records[index]!.responseHeaders)).toEqual(Object.entries(record.responseHeaders))
  })
  expect(records[1]!.requestHeaders).toEqual({})
  expect(records[1]!.responseHeaders).toEqual({})
  expect(records[0]!.body).toBe('[secret:BODY_KEY]')

  const variables = fixture('variables', documents.variables, mask)
  variables.step.variableSnapshot = { second: { value: 'two', source: 'env' }, first: { value: 'one', source: 'inline' } }
  const snapshot = await variables.read()
  expect(snapshot).toMatchObject({ outcome: 'ready' })
  expect(Object.entries((snapshot as { document: { records: object } }).document.records))
    .toEqual([['second', { value: 'two', source: 'env' }], ['first', { value: 'one', source: 'inline' }]])

  const collapsed = fixture('network', network, () => 'collapsed')
  expect(await collapsed.read()).toEqual({ address: collapsed.address, outcome: 'read-error', code: 'invalid-document', capture: collapsed.entry })
})
it('EVIDENCE-PORTS reports missing bindings, missing runs and storage errors distinctly', async () => {
  const f = fixture('console')
  await expect(runsEvidenceSpec.invoke(f.address, {} as FunctionDeps)).rejects.toBeInstanceOf(FunctionNotBoundError)
  await expect(runsEvidenceSpec.invoke(f.address, { runDetail: f.deps.runDetail } as FunctionDeps)).rejects.toBeInstanceOf(FunctionNotBoundError)
  f.deps.runDetail!.read = async () => undefined
  await expect(f.read()).rejects.toBeInstanceOf(RunNotFoundError)
  f.deps.runDetail!.read = async () => f.rows
  f.deps.evidenceBlobs!.read = async () => { throw new Error('synthetic private storage path') }
  expect(await f.read()).toEqual({ address: f.address, outcome: 'read-error', code: 'storage-read-failed', capture: f.entry })
})
it('EVIDENCE-CONTRACT rejects crossed documents, extra fields and false ready states', async () => {
  const f = fixture('console')
  const valid = { address: f.address, outcome: 'ready', evidence: f.entry, document: documents.console }
  expect(RunsEvidenceResultSchema.safeParse(valid).success).toBe(true)
  for (const value of [{ ...valid, document: documents.aria }, { ...valid, leaked: true }, { ...valid, evidence: { kind: 'console', state: 'absent', reason: 'empty' } }]) {
    expect(RunsEvidenceResultSchema.safeParse(value).success).toBe(false)
  }
  expect(runsEvidenceSpec.resultKind).toBe('unary')
  expect(runsEvidenceSpec.risk.readOnly).toBe(true)
  expect(sniffEvidenceContentType(f.bytes)).toBe('application/octet-stream')
})

describe('runs.evidence masks with the declared mask', () => {
  const caller = { surface: 'test', origin: 'agent' } as FunctionCaller
  const aria: EvidenceDocument = { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria',
    tree: 'textbox "Password" value="Hunter-42-zz" for qa@example.com; cookie session=undeclared-cookie' }
  const readThroughRegistry = (deps: FunctionDeps, address: RunsEvidenceInput) =>
    invokeFunction(createFunctionRegistry({ deps }), 'runs.evidence', address, caller)

  it('runs.evidence masks a stored document with the declared mask', async () => {
    const f = fixture('aria', aria, declaredMask({ PW_KEY: 'Hunter-42-zz' }))
    const result = await readThroughRegistry(f.deps, f.address)
    expect(result).toMatchObject({ outcome: 'ready',
      document: { kind: 'aria',
        tree: 'textbox "Password" value="[secret:PW_KEY]" for qa@example.com; cookie session=undeclared-cookie' } })
    expect(JSON.stringify(result)).not.toContain('Hunter-42-zz')
  })

  it('runs.evidence answers masking-unavailable without a mask', async () => {
    const unbound = fixture('aria', aria, null)
    const throwing = fixture('aria', aria, () => { throw new Error('synthetic unreadable secrets file') })
    for (const f of [unbound, throwing]) {
      const result = await readThroughRegistry(f.deps, f.address)
      expect(result).toEqual({ address: f.address, outcome: 'read-error', code: 'masking-unavailable', capture: f.entry })
      expect(JSON.stringify(result)).not.toContain('Hunter-42-zz')
    }
  })
})
