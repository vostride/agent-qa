import {
  EvidenceDocumentSchema, EvidenceEntrySchema, RunsEvidenceInputSchema, RunsEvidenceOutputContract,
  RunsEvidenceResultSchema, sha256hexBytes, utf8Decode, utf8Encode,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  EvidenceDocument, EvidenceEntry, MaskFn, RunDetailRows, RunsEvidenceInput, RunsEvidenceResult,
} from '@vostride/agent-qa-schema'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'
import { IN_RUNS_DATABASE, RunNotFoundError } from './runs-get.js'

export const RUNS_EVIDENCE_FUNCTION_ID = 'runs.evidence'

// Only free-text maps mask keys. Schema keys, kind/source/impact enums and SHA identities
// remain structural data. Refuse collisions rather than silently losing a recorded value.
function maskMap<T, U>(value: Record<string, T>, mask: MaskFn, project: (item: T) => U): Record<string, U> {
  const entries = Object.entries(value).map(([key, item]) => [mask(key), project(item)] as const)
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Masked key collision')
  return Object.fromEntries(entries)
}

function maskDocument(document: EvidenceDocument, mask: MaskFn): EvidenceDocument {
  switch (document.kind) {
    case 'aria': return { ...document, tree: mask(document.tree) }
    case 'variables': return { ...document, records: maskMap(document.records, mask, item => ({ ...item, value: mask(item.value) })) }
    case 'console': return { ...document, records: document.records.map(item => ({
      ...item, level: mask(item.level), text: mask(item.text),
      ...(item.location === undefined ? {} : { location: { ...item.location, url: mask(item.location.url) } }),
    })) }
    case 'network': return { ...document, records: document.records.map(item => ({
      ...item, url: mask(item.url), method: mask(item.method),
      requestHeaders: maskMap(item.requestHeaders, mask, mask),
      responseHeaders: maskMap(item.responseHeaders, mask, mask),
      ...(item.body === undefined ? {} : { body: mask(item.body) }),
      ...(item.requestBody === undefined ? {} : { requestBody: mask(item.requestBody) }),
      ...(item.timing === undefined ? {} : { timing: maskMap(item.timing, mask, value => value) }),
    })) }
    case 'a11y': return { ...document, records: document.records.map(item => ({
      ...item, ruleId: mask(item.ruleId), description: mask(item.description), help: mask(item.help),
      helpUrl: mask(item.helpUrl), nodes: item.nodes.map(node => ({ html: mask(node.html), target: node.target.map(mask) })),
    })) }
  }
}

export const runsEvidenceSpec: FunctionSpec<RunsEvidenceInput, RunsEvidenceResult> = {
  id: RUNS_EVIDENCE_FUNCTION_ID,
  summary: 'Read validated evidence recorded on one run step or ARIA sub-action.',
  resultKind: 'unary',
  boundThrough: 'runDetail',
  input: RunsEvidenceInputSchema,
  output: RunsEvidenceResultSchema,
  // The declared output is the canonical document; validation stays on `output`.
  outputRepresentation: RunsEvidenceOutputContract,
  risk: { name: `fn:${RUNS_EVIDENCE_FUNCTION_ID}`, recognized: true, readOnly: true },
  classify(output) {
    return { status: output.outcome === 'read-error' ? 'failed' : 'executed', outcome: output.outcome }
  },
  async invoke(input, deps) {
    const address = RunsEvidenceInputSchema.parse(input)
    const detail = deps.runDetail
    const blobs = deps.evidenceBlobs
    if (detail === undefined || blobs === undefined) throw new FunctionNotBoundError(RUNS_EVIDENCE_FUNCTION_ID)
    const error = (code: Extract<RunsEvidenceResult, { outcome: 'read-error' }>['code'], capture?: EvidenceEntry): RunsEvidenceResult => ({
      address, outcome: 'read-error', code, ...(capture === undefined ? {} : { capture }),
    })
    const absent = (reason: 'unavailable' | 'not-captured', incomplete = false): RunsEvidenceResult => ({
      address, outcome: 'absent', evidence: { kind: address.kind, state: 'absent', reason,
        ...(incomplete ? { evidenceIncomplete: true } : {}),
      },
    })
    let rows: RunDetailRows | undefined
    try { rows = await detail.read(address.runId) } catch { return error('storage-read-failed') }
    if (rows === undefined) throw new RunNotFoundError(String(address.runId), IN_RUNS_DATABASE)
    if (rows.runId !== address.runId) return error('ref-not-owned')
    const steps = rows.steps.filter(row => row.testIndex === address.testIndex && row.stepIndex === address.stepIndex)
    if (steps.length === 0) return error('address-not-found')
    if (steps.length !== 1) return error('ambiguous-address')
    const step = steps[0]!
    let rawEntry: unknown
    let child: RunDetailRows['subActions'][number] | undefined
    if (address.kind === 'aria') {
      if (address.subActionIndex === undefined) return absent('not-captured')
      const children = rows.subActions.filter(row => row.testIndex === address.testIndex
        && row.stepIndex === address.stepIndex && row.subActionIndex === address.subActionIndex)
      if (children.length === 0) return error('address-not-found')
      if (children.length !== 1) return error('ambiguous-address')
      child = children[0]!
      if (child.ariaEvidence === undefined) return absent('unavailable')
      rawEntry = child.ariaEvidence
    } else {
      if (step.evidence === undefined) return absent('unavailable')
      rawEntry = step.evidence?.[address.kind]
    }
    const parsedEntry = EvidenceEntrySchema.safeParse(rawEntry)
    if (!parsedEntry.success || parsedEntry.data.kind !== address.kind) return error('invalid-entry')
    const capture = parsedEntry.data
    if (capture.state === 'absent') return { address, outcome: 'absent', evidence: capture }

    let rawDocument: unknown
    if (capture.kind === 'variables') {
      if (step.variableSnapshot === undefined) return error('snapshot-missing', capture)
      rawDocument = {
        schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
        kind: 'variables',
        records: step.variableSnapshot,
      }
    } else {
      if (capture.kind === 'aria' && !child?.artifactRefs?.some(ref => ref.id === capture.ref.id && ref.sha === capture.ref.sha)) {
        return error('ref-not-owned', capture)
      }
      let lookup
      try { lookup = await blobs.read(address.runId, capture.ref.sha) } catch { return error('storage-read-failed', capture) }
      if (lookup.status === 'unknown_run') throw new RunNotFoundError(String(address.runId))
      if (lookup.status === 'blob_absent') return absent('unavailable', true)
      // Integrity is checked over immutable bytes before any text decoding or masking.
      if (sha256hexBytes(lookup.bytes) !== capture.ref.sha) return error('sha-mismatch', capture)
      try {
        const text = utf8Decode(lookup.bytes)
        const roundtrip = utf8Encode(text)
        if (roundtrip.length !== lookup.bytes.length || !roundtrip.every((byte, index) => byte === lookup.bytes[index])) {
          return error('invalid-document', capture)
        }
        rawDocument = JSON.parse(text)
      } catch { return error('invalid-document', capture) }
    }
    const parsed = EvidenceDocumentSchema.safeParse(rawDocument)
    if (!parsed.success || parsed.data.kind !== address.kind) return error('invalid-document', capture)
    // A valid document that cannot be masked is unreadable, never evidence and never invalid.
    const declared = deps.secretMask
    if (declared === undefined) return error('masking-unavailable', capture)
    let maskFailed = false
    const mask: MaskFn = text => {
      try { return declared(text) } catch (cause) { maskFailed = true; throw cause }
    }
    try {
      const document = maskDocument(parsed.data, mask)
      return RunsEvidenceResultSchema.parse({ address, outcome: 'ready', evidence: capture, document })
    } catch { return error(maskFailed ? 'masking-unavailable' : 'invalid-document', capture) }
  },
}
