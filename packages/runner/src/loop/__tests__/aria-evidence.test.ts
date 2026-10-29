import { expect, it, vi } from 'vitest'
import {
  AriaEvidenceDocumentSchema,
  sha256hexBytes,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { EvidenceDocument, RunEventEnvelope, SubActionRecordedPayload } from '@vostride/agent-qa-schema'
import { executeStep } from '../index.js'
import type { EvidenceArtifactStorePort, LoopPorts } from '../ports.js'
import { createRunEventBus } from '../../run/bus.js'
import { createMemberEventSink } from '../../run/event-sink.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

function fixture(tree = 'before synthetic-run-secret', declared: Record<string, string> = { RUN_SECRET: 'synthetic-run-secret' }) {
  const secretRedactor = new SecretRedactor(new SecretStore(declared))
  const before = makeScreenState({ tree })
  const after = makeScreenState({ tree: 'after must remain raw synthetic-run-secret' })
  const events: RunEventEnvelope[] = []
  const documents: EvidenceDocument[] = []
  const blobs = new Map<string, Uint8Array>()
  const screenshot = Buffer.from('synthetic decision image')
  const screenshotSha = sha256hexBytes(screenshot)
  const store: EvidenceArtifactStorePort = {
    persistDecisionScreenshot: bytes => {
      blobs.set(screenshotSha, bytes)
      return { id: `decision-screenshot:${screenshotSha}`, sha: screenshotSha }
    },
    persistEvidenceDocument: document => {
      documents.push(structuredClone(document))
      const bytes = new TextEncoder().encode(JSON.stringify(document))
      const sha = sha256hexBytes(bytes)
      blobs.set(sha, bytes)
      return { id: `aria-state:${sha}`, sha }
    },
    getBlob: sha => blobs.get(sha),
  }
  const bus = createRunEventBus({ runId: 'synthetic-aria-run' })
  bus.subscribe(1, event => events.push(event))
  let executed = false
  const adapter = makeAdapter({ screenshot: async () => screenshot })
  adapter.observe = async () => executed ? after : before
  adapter.execute = async () => { executed = true; return { success: true } }
  const observe = vi.spyOn(adapter, 'observe')
  const ports: LoopPorts = {
    adapter, planner: makePlanner(), verifier: makeVerifier(), secretRedactor, evidenceArtifacts: store,
    events: createMemberEventSink({ bus, mask: text => secretRedactor.redactString(text), testIndex: 2 }).loopEmitFor(3),
  }
  const children = () => events.filter(event => event.type === 'subActionRecorded')
    .map(event => event.payload as SubActionRecordedPayload)
  return { before, after, ports, store, secretRedactor, documents, blobs, screenshotSha, children, observe }
}

it('ARIA-LIVE-MASK: the live run mask persists only before tree and leaves raw handoff states unchanged', async () => {
  const f = fixture()
  const raw = JSON.stringify([f.before, f.after])
  const result = await executeStep('Click Log in', f.ports, makeStepContext())
  expect(result.status).toBe('passed')
  expect(f.documents).toEqual([{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: 'before [secret:RUN_SECRET]' }])
  expect(JSON.stringify(f.documents)).not.toContain('synthetic-run-secret')
  expect(JSON.stringify([f.before, f.after])).toBe(raw)
  expect(result.evidence?.subActions[0]?.stateBefore?.tree).toBe(f.before.tree)
  expect(result.evidence?.subActions[0]?.stateAfter).toBe(f.after)
  // Loop-top reads plus the verify-path settle, which needs two equal reads.
  expect(f.observe).toHaveBeenCalledTimes(4)
})

it('ARIA-REF-APPEND: real sink appends one valid ARIA SHA beside the exact decision screenshot before publication', async () => {
  const f = fixture()
  await executeStep('Click Log in', f.ports, makeStepContext())
  expect(f.children()).toHaveLength(1)
  const child = f.children()[0]!
  expect(child.ariaEvidence?.state).toBe('present')
  if (child.ariaEvidence?.state !== 'present') throw new Error('Expected ARIA entry')
  const ref = child.ariaEvidence.ref
  expect(child.artifactRefs).toEqual([
    { id: `decision-screenshot:${f.screenshotSha}`, sha: f.screenshotSha }, ref,
  ])
  const bytes = f.blobs.get(ref.sha)!
  expect(sha256hexBytes(bytes)).toBe(ref.sha)
  expect(ref.id).toBe(`aria-state:${ref.sha}`)
  expect(AriaEvidenceDocumentSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).tree)
    .toBe('before [secret:RUN_SECRET]')
  expect(child).toMatchObject({ testIndex: 2, stepIndex: 3, subActionIndex: 0 })
})

it('ARIA-ROTATED-SECRET: two runs use their own independent declared masks', async () => {
  for (const [name, secret] of [['FIRST_RUN', 'synthetic-first-run'], ['SECOND_RUN', 'synthetic-second-run']] as const) {
    const f = fixture(`before ${secret}`, { [name]: secret })
    await executeStep('Click Log in', f.ports, makeStepContext())
    expect(f.documents).toEqual([{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: `before [secret:${name}]` }])
    expect(JSON.stringify(f.documents)).not.toContain(secret)
    expect(f.before.tree).toContain(secret)
  }
})

for (const failure of ['write', 'mask', 'missing-mask', 'missing-store', 'invalid-ref'] as const) {
  it(`ARIA-WRITE-FAILED: ${failure} retains the action and screenshot with failed evidence`, async () => {
    const f = fixture()
    if (failure === 'write') f.store.persistEvidenceDocument = () => { throw new Error('synthetic write failure') }
    if (failure === 'missing-mask') f.ports.secretRedactor = undefined
    if (failure === 'missing-store') f.store.persistEvidenceDocument = undefined
    if (failure === 'invalid-ref') f.store.persistEvidenceDocument = () => ({ id: `console-evidence:${'a'.repeat(64)}`, sha: 'a'.repeat(64) })
    // Isolate a failing ARIA mask from the loop's unrelated narrative masking sites.
    if (failure === 'mask') f.ports.secretRedactor = { redactString: text => {
      if (text === f.before.tree) throw new Error('synthetic tree mask failure')
      return f.secretRedactor.redactString(text)
    } }
    const result = await executeStep('Click Log in', f.ports, makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence?.subActions).toHaveLength(1)
    expect(f.children()).toHaveLength(1)
    expect(f.children()[0]?.ariaEvidence).toEqual({ kind: 'aria', state: 'absent', reason: 'failed' })
    expect(f.children()[0]?.artifactRefs).toEqual([{ id: `decision-screenshot:${f.screenshotSha}`, sha: f.screenshotSha }])
  })
}

it('ARIA-EMPTY: an existing empty before tree emits empty without writing a document', async () => {
  const f = fixture('')
  await executeStep('Click Log in', f.ports, makeStepContext())
  expect(f.children()[0]?.ariaEvidence).toEqual({ kind: 'aria', state: 'absent', reason: 'empty' })
  expect(f.documents).toEqual([])
})

for (const platform of ['android', 'ios'] as const) {
  it(`EVID-MOBILE-TREE: ${platform} uses its existing screen tree with no new capture`, async () => {
    const f = fixture(`native ${platform} synthetic-run-secret`)
    f.ports.adapter = { ...f.ports.adapter, platform }
    f.before.platform = platform
    f.after.platform = platform
    f.ports.planner = makePlanner([makeActionPlan({ action: { type: 'wait' } })])
    await executeStep('Wait', f.ports, makeStepContext())
    expect(f.documents).toEqual([{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: `native ${platform} [secret:RUN_SECRET]` }])
    expect(f.children()[0]?.ariaEvidence?.state).toBe('present')
    expect(f.observe).toHaveBeenCalledTimes(4)
  })
}
