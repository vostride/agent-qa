import { expect, test, vi } from 'vitest'
import { createMemberEventSink, createRunEventBus, runMemberTest, SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type { MemberRunConfig, PlatformAdapter } from '@vostride/agent-qa-runner'
import type { EvidenceDocument, StepFinalizedPayload } from '@vostride/agent-qa-schema'
import { buildMemberRunConfig } from '../run-composition.js'

vi.mock('@vostride/agent-qa-web', () => ({ runAccessibilityCheck: vi.fn(async () => []) }))

function fixture() {
  const terminals: StepFinalizedPayload[] = []
  const documents: EvidenceDocument[] = []
  const bus = createRunEventBus({ runId: 'synthetic-composition-423' })
  bus.subscribe(1, event => {
    if (event.type === 'stepFinalized') terminals.push(event.payload as StepFinalizedPayload)
  })
  const secretRedactor = new SecretRedactor(new SecretStore())
  const adapter: PlatformAdapter = {
    platform: 'web', setup: async () => {}, cleanup: async () => {},
    observe: async () => { throw new Error('No extra capture permitted') },
    execute: async () => ({ success: true }),
  }
  const input = {
    adapter, secretRedactor,
    planner: { plan: async () => { throw new Error('No model call permitted') } },
    verifier: { verify: async () => { throw new Error('No model call permitted') } },
    plannerModel: {} as MemberRunConfig['plannerModel'], verifierModel: {} as MemberRunConfig['verifierModel'],
    sink: createMemberEventSink({ bus, mask: text => secretRedactor.redactString(text), testIndex: 0 }),
    testIndex: 0, abortSignal: new AbortController().signal, filePath: 'synthetic.yaml',
    accessibility: { enabled: true },
    evidenceArtifacts: {
      persistDecisionScreenshot: () => ({ id: `decision-screenshot:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }),
      getBlob: () => undefined,
      persistEvidenceDocument: (document: EvidenceDocument) => {
        documents.push(structuredClone(document))
        return { id: `${document.kind}-evidence:${'b'.repeat(64)}`, sha: 'b'.repeat(64) }
      },
    },
  }
  const member = { testId: 'synthetic-member-423', name: 'Synthetic capture', filePath: input.filePath,
    steps: ['{{appium: mobile: hideKeyboard}}'] }
  return { input, member, terminals, documents, adapter }
}

test.each(['no-getter', 'non-callable', 'no-page', 'getter-throws', 'captured-zero'] as const)(
  'EVID-COMPOSED-CAPABILITY: %s reports actual availability through the member finalizer', async kind => {
    const f = fixture()
    if (kind === 'non-callable') Object.assign(f.adapter, { getPage: 'not callable' })
    if (kind === 'no-page') Object.assign(f.adapter, { getPage: () => undefined })
    if (kind === 'getter-throws') Object.assign(f.adapter, { getPage: () => { throw new Error('Synthetic lost page') } })
    if (kind === 'captured-zero') Object.assign(f.adapter, { getPage: () => ({}) })
    const result = await runMemberTest(f.member, buildMemberRunConfig(f.input))
    const reason = ['no-getter', 'non-callable'].includes(kind) ? 'unsupported'
      : kind === 'captured-zero' ? 'empty' : 'failed'
    expect(result.status).toBe('passed')
    expect(f.terminals).toHaveLength(1)
    expect(f.terminals[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'absent', reason })
    expect(f.documents).toEqual([])
  },
)
