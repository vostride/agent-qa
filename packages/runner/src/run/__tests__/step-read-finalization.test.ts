import { describe, expect, test, vi } from 'vitest'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { EvidenceDocument, RunEventEnvelope, StepFinalizedPayload } from '@vostride/agent-qa-schema'
import { createRunEventBus } from '../bus.js'
import { createMemberEventSink } from '../event-sink.js'
import { runMemberTest, type MemberRunConfig, type MemberTest } from '../member-runner.js'
import { fakeModel, makeActionPlan, makeAdapter, makePlanner } from '../../loop/__tests__/loop-harness.js'
import type { AccessibilityViolation, ConsoleLogEntry, NetworkLogEntry } from '../../result.js'
import { projectNetworkEvidence } from '../network-evidence-policy.js'
import { executeStep } from '../../loop/index.js'
import type { LoopPorts } from '../../loop/ports.js'
import { redactSecretValue, SecretRedactor, SecretStore } from '../../loop/secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { VariableStore } from '../../variables/store.js'
import { createStepReadFinalizer } from '../step-read-finalization.js'
import { deriveMemberOutcome } from '../verdict.js'

const secret = 'synthetic-live-secret-423'
const hookId = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const networkRecord = (index: number, status = 200): NetworkLogEntry => ({
  url: `https://example.test/${index}/${secret}`, method: 'POST', status,
  requestHeaders: { 'content-type': 'text/plain', Authorization: 'synthetic-fresh-session' },
  responseHeaders: { 'content-type': 'text/plain', 'set-cookie': 'synthetic-fresh-session' },
  requestBody: secret, body: secret, startTime: 1000 - index, endTime: 2000 - index,
})
function fixture() {
  const events: RunEventEnvelope[] = []
  const documents: EvidenceDocument[] = []
  const ariaDocuments: EvidenceDocument[] = []
  const bus = createRunEventBus({ runId: 'synthetic-run-423' })
  bus.subscribe(1, event => events.push(event))
  const abort = new AbortController()
  const adapter = makeAdapter()
  adapter.drainConsoleLogs = vi.fn((): ConsoleLogEntry[] => [])
  const config: MemberRunConfig = {
    adapter, planner: makePlanner(), plannerModel: fakeModel, verifierModel: fakeModel,
    sink: createMemberEventSink({ bus, mask: (text) => text, testIndex: 3 }), testIndex: 3,
    abortSignal: abort.signal,
    secretRedactor: new SecretRedactor(new SecretStore({ LIVE_423: secret })),
    evidenceArtifacts: {
      persistDecisionScreenshot: () => ({ id: `decision-screenshot:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }),
      getBlob: () => undefined,
      persistEvidenceDocument: value => {
        const lane = value.kind === 'aria' ? ariaDocuments : documents
        lane.push(structuredClone(value))
        return { id: `${value.kind === 'aria' ? 'aria-state' : `${value.kind}-evidence`}:${'b'.repeat(64)}`, sha: 'b'.repeat(64) }
      },
    },
  }
  const member: MemberTest = { testId: 'synthetic-test-423', name: 'Console capture',
    filePath: 'synthetic.yaml', steps: ['Click Log in'] }
  const terminals = () => events.filter(event => event.type === 'stepFinalized').map(
    event => event.payload as StepFinalizedPayload,
  )
  return { events, documents, ariaDocuments, abort, adapter, config, member, terminals }
}

test('VARIABLE-FINAL: capture replaces the seed only before the single final snapshot', async () => {
  const f = fixture()
  f.config.inlineVars = { captured: 'before extraction' }
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'captured', method: 'ai' } }]
  f.config.extractorFactory = () => ({ extract: async () => {
    expect(f.terminals()).toHaveLength(0)
    return { success: true, variableName: 'captured', value: secret, reasoning: 'synthetic' }
  } })
  await runMemberTest(f.member, f.config)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].variableSnapshot).toEqual({ captured: { value: '[secret:LIVE_423]', source: 'capture' } })
  expect(f.terminals()[0].evidence?.variables).toEqual({ kind: 'variables', state: 'present', counts: { count: 1 } })
})

test('VARIABLE-SOURCES: all seven actual store origins survive final publication', async () => {
  const f = fixture()
  f.config.envFileVars = { environment: 'env value' }
  f.config.inlineVars = { inline: 'inline value' }
  f.config.suiteVars = { suite: 'suite value' }
  f.config.cliVars = { cli: 'cli value' }
  f.config.hookSetupVars = { hook: 'hook value' }
  f.config.executeStep = async (instruction, ports, context) => {
    ports.onSetVariable?.('step', 'step value')
    return executeStep(instruction, ports, context)
  }
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'captured', method: 'ai' } }]
  f.config.extractorFactory = () => ({ extract: async () => ({ success: true,
    variableName: 'captured', value: 'capture value', reasoning: 'synthetic' }) })
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].variableSnapshot).toEqual({
    environment: { value: 'env value', source: 'env' }, inline: { value: 'inline value', source: 'inline' },
    suite: { value: 'suite value', source: 'suite' }, cli: { value: 'cli value', source: 'cli' },
    hook: { value: 'hook value', source: 'hook' }, step: { value: 'step value', source: 'step' },
    captured: { value: 'capture value', source: 'capture' },
  })
  expect(f.terminals()[0].evidence?.variables).toMatchObject({ state: 'present', counts: { count: 7 } })
})

test('VARIABLE-MASK-NAMES: declared-secret redaction covers both names and values, and an env-named value stays as written', async () => {
  const f = fixture()
  const declared = 'synthetic-declared-value'
  f.config.envFileVars = { SYNTHETIC_API_KEY: secret }
  f.config.inlineVars = { [`name-${secret}`]: `value-${secret}`, [declared]: declared }
  f.config.secretRedactor = { redactString: text => text.replaceAll(declared, '[secret]') }
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].variableSnapshot).toEqual({
    SYNTHETIC_API_KEY: { value: secret, source: 'env' },
    [`name-${secret}`]: { value: `value-${secret}`, source: 'inline' },
    '[secret]': { value: '[secret]', source: 'inline' },
  })
  expect(JSON.stringify(f.terminals())).not.toContain(declared)
})

test('VARIABLE-LARGE: 1000 variables retain full values without a production cap', async () => {
  const f = fixture()
  const values = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    `variable-${index}`, index === 999 ? 'é'.repeat(40000) : 'v'.repeat(64),
  ]))
  f.config.inlineVars = values
  await runMemberTest(f.member, f.config)
  const snapshot = f.terminals()[0].variableSnapshot
  expect(snapshot).toEqual(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, source: 'inline' }])))
  expect(f.terminals()[0].evidence?.variables).toMatchObject({ state: 'present', counts: { count: 1000 } })
})

test('VARIABLE-PROTOTYPE: the actual snapshot producer preserves own prototype-named data', async () => {
  const store = new VariableStore()
  store.set('__proto__', 'synthetic prototype value', 'step')
  expect(Object.keys(store.snapshot())).toEqual(['__proto__'])
  const f = fixture()
  f.config.inlineVars = Object.fromEntries([['__proto__', secret], ['constructor', 'ordinary value']])
  f.config.secretRedactor = { redactString: text => text.replaceAll(secret, '[secret]') }
  await runMemberTest(f.member, f.config)
  const snapshot = f.terminals()[0].variableSnapshot!
  expect(Object.keys(snapshot)).toEqual(['__proto__', 'constructor'])
  expect(Object.getOwnPropertyDescriptor(snapshot, '__proto__')?.value).toEqual({ value: '[secret]', source: 'inline' })
  expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
  expect(f.terminals()[0].evidence?.variables).toMatchObject({ counts: { count: 2 } })
})

test('VARIABLE-EMPTY: an actual empty snapshot has no invented count', async () => {
  const f = fixture()
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.variables).toEqual({ kind: 'variables', state: 'absent', reason: 'empty' })
  expect(f.terminals()[0]).not.toHaveProperty('variableSnapshot')
})

test('VARIABLE-UNAVAILABLE: a bypass without a supplied snapshot stays not-captured', () => {
  const f = fixture()
  createStepReadFinalizer(f.config, 0, f.member.name, 'synthetic').finish({ name: 'bypass', status: 'failed', duration: 0 })
  expect(f.terminals()[0].evidence?.variables).toEqual({ kind: 'variables', state: 'absent', reason: 'not-captured' })
  expect(f.terminals()[0]).not.toHaveProperty('variableSnapshot')
})

function violations(): AccessibilityViolation[] {
  return (['minor', 'moderate', 'serious', 'critical', 'critical'] as const).map(impact => ({
    ruleId: `rule-${secret}`, impact, description: `description-${secret}`,
    help: `help-${secret}`, helpUrl: `https://example.test/${secret}`,
    nodes: [{ html: `<span>${secret}</span>`, target: [`#${secret}`] }],
  }))
}

test('EVID-A11Y-PRESENT: one live-masked document retains all violations and exact impact counts', async () => {
  const f = fixture()
  f.config.accessibility = { enabled: true }
  f.config.accessibilityCheck = vi.fn(async () => violations())
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'late', method: 'ai' } }]
  f.config.extractorFactory = () => ({ extract: async () => (
    { success: true, variableName: 'late', value: secret, reasoning: 'synthetic' }
  ) })
  const persist = f.config.evidenceArtifacts!.persistEvidenceDocument!
  f.config.evidenceArtifacts!.persistEvidenceDocument = document => {
    expect(f.terminals()).toHaveLength(0)
    expect(JSON.stringify(document)).not.toContain(secret)
    return persist(document)
  }
  await runMemberTest(f.member, f.config)
  expect(f.config.accessibilityCheck).toHaveBeenCalledTimes(1)
  expect(f.documents).toEqual([{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y',
    records: JSON.parse(JSON.stringify(violations()).replaceAll(secret, '[secret:LIVE_423]')) }])
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'present',
    ref: { id: `a11y-evidence:${'b'.repeat(64)}`, sha: 'b'.repeat(64) },
    counts: { minor: 1, moderate: 1, serious: 1, critical: 2 } })
})

test.each(['disabled', 'test-end', 'every-step', 'missing-handler'] as const)(
  'EVID-A11Y-SCHEDULE: %s distinguishes actual zero capture from unstarted or unsupported', async kind => {
    const f = fixture()
    f.member.steps = ['Click Log in', 'Click Log in']
    f.config.accessibility = { enabled: kind !== 'disabled', runAfter: kind === 'test-end' ? 'test-end' : 'every-step' }
    const check = vi.fn(async () => [])
    f.config.accessibilityCheck = kind === 'missing-handler' ? undefined : check
    await runMemberTest(f.member, f.config)
    expect(f.terminals()).toHaveLength(2)
    const reasons = kind === 'disabled' ? ['not-captured', 'not-captured']
      : kind === 'test-end' ? ['not-captured', 'empty']
      : kind === 'missing-handler' ? ['unsupported', 'unsupported'] : ['empty', 'empty']
    expect(f.terminals().map(terminal => terminal.evidence?.a11y)).toEqual(reasons.map(reason => ({ kind: 'a11y', state: 'absent', reason })))
    expect(check).toHaveBeenCalledTimes(kind === 'test-end' ? 1 : kind === 'every-step' ? 2 : 0)
    expect(f.documents).toEqual([])
  },
)

test.each(['axe', 'persist', 'missing-mask', 'missing-store', 'bad-ref', 'mask'] as const)(
  'EVID-CAPTURE-THREW: %s failure never reports a clean accessibility result', async kind => {
    const f = fixture()
    f.config.accessibility = { enabled: true }
    f.config.accessibilityCheck = async () => {
      if (kind === 'axe') throw new Error(`synthetic axe error ${secret}`)
      return violations()
    }
    if (kind === 'persist') f.config.evidenceArtifacts!.persistEvidenceDocument = () => { throw new Error(`synthetic persist ${secret}`) }
    if (kind === 'missing-store') f.config.evidenceArtifacts = undefined
    if (kind === 'missing-mask') f.config.secretRedactor = undefined
    if (kind === 'bad-ref') f.config.evidenceArtifacts!.persistEvidenceDocument = () => ({ id: `console-evidence:${'b'.repeat(64)}`, sha: 'b'.repeat(64) })
    // Armed after the step result's own redaction, so only the accessibility document's mask throws.
    let armed = false
    if (kind === 'mask') {
      f.adapter.drainConsoleLogs = () => { armed = true; return [] }
      f.config.secretRedactor = { redactString: text => {
        if (armed && text.includes(secret)) throw new Error('synthetic mask failure')
        return text
      } }
    }
    const result = await runMemberTest(f.member, f.config)
    expect(result.status).toBe('passed')
    expect(f.terminals()).toHaveLength(1)
    expect(f.terminals()[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'absent', reason: 'failed' })
    expect(f.terminals()[0]).not.toHaveProperty('error')
    expect(f.documents).toEqual([])
  },
)

test.each(['android', 'ios'] as const)('EVID-MOBILE-SCOPE: %s accessibility remains unsupported', async platform => {
  const f = fixture()
  f.config.adapter = { ...f.adapter, platform }
  f.member.steps = ['{{appium: mobile: hideKeyboard}}']
  f.config.appiumScript = async () => ({ success: true })
  f.config.accessibility = { enabled: true }
  f.config.accessibilityCheck = vi.fn(async () => violations())
  await runMemberTest(f.member, f.config)
  expect(f.config.accessibilityCheck).not.toHaveBeenCalled()
  expect(f.terminals()[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'absent', reason: 'unsupported' })
})

test.each(['persist-ok', 'persist-fails'] as const)('A11Y-FINAL-VERDICT: %s publishes the post-check verdict once', async kind => {
  const f = fixture()
  f.config.accessibility = { enabled: true, failOnViolation: true }
  f.config.accessibilityCheck = async () => violations()
  if (kind === 'persist-fails') f.config.evidenceArtifacts!.persistEvidenceDocument = () => { throw new Error('synthetic write failure') }
  const result = await runMemberTest(f.member, f.config)
  expect(result.status).toBe('failed')
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('failed')
  expect(f.terminals()[0].error).toBe('Accessibility violations found: 2 critical, 1 serious')
  expect(f.terminals()[0].evidence?.a11y).toMatchObject(kind === 'persist-ok'
    ? { state: 'present', counts: { minor: 1, moderate: 1, serious: 1, critical: 2 } }
    : { state: 'absent', reason: 'failed' })
})

test('EVID-ABORT-DURING: active a11y interruption is failed and retains recorded actions', async () => {
  const f = fixture()
  f.member.steps = ['Click Log in', 'Never starts']
  f.config.accessibility = { enabled: true }
  f.config.accessibilityCheck = async () => {
    f.abort.abort(new Error('synthetic axe abort'))
    return new Promise(() => {})
  }
  const result = await runMemberTest(f.member, f.config)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('cancelled')
  expect(f.terminals()[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'absent', reason: 'failed' })
  expect(result.steps[0].evidence!.subActions.length).toBeGreaterThan(0)
  expect(f.terminals()[0].evidence?.console).toMatchObject({ reason: 'not-captured' })
})

test.each(['abort', 'throw'] as const)('EVID-ABORT-BEFORE: extraction %s retains completed a11y and prior variables', async kind => {
  const f = fixture()
  f.config.inlineVars = { prior: 'retained' }
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'late', method: 'ai' } }, 'Never starts']
  f.config.accessibility = { enabled: true }
  f.config.accessibilityCheck = async () => violations()
  f.config.extractorFactory = () => ({ extract: async () => {
    if (kind === 'throw') throw new Error('synthetic extraction failed')
    f.abort.abort(new Error('synthetic extraction abort'))
    return new Promise(() => {})
  } })
  const result = await runMemberTest(f.member, f.config)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe(kind === 'abort' ? 'cancelled' : 'failed')
  expect(f.terminals()[0].evidence?.a11y).toMatchObject({ state: 'present', counts: { critical: 2 } })
  expect(result.steps[0].accessibilityViolations).toEqual(JSON.parse(JSON.stringify(violations()).replaceAll(secret, '[secret:LIVE_423]')))
  expect(f.terminals()[0].variableSnapshot).toEqual({ prior: { value: 'retained', source: 'inline' } })
  expect(f.terminals()[0].evidence?.console).toMatchObject({ reason: 'not-captured' })
})

test.each(['no-subaction', 'hook-only', 'hook-error', 'hook-throw', 'template', 'execute-throw', 'appium-error'] as const)(
  'EVID-BYPASS-TERMINAL: %s keeps one row and only actually captured evidence', async kind => {
    const f = fixture()
    f.config.inlineVars = { prior: 'retained' }
    f.config.accessibility = { enabled: true }
    f.config.accessibilityCheck = vi.fn(async () => [])
    f.config.executeStep = async () => {
      if (kind === 'execute-throw') throw new Error('synthetic execute failure')
      return { name: 'synthetic bypass', status: 'passed', duration: 0 }
    }
    if (kind.startsWith('hook')) {
      f.member.steps = [`{{runHook:"${hookId}"}}`]
      f.config.inlineHookDefs = new Map([[hookId, { id: hookId, name: 'synthetic', runtime: 'node', file: 'synthetic.js', deps: [], timeout: 1000, network: false }]])
      f.config.hookExecutor = { execute: async () => {
        if (kind === 'hook-throw') throw new Error('synthetic hook failure')
        return { success: kind === 'hook-only', duration: 1, stdout: '', stderr: '', output: '', variables: { hooked: 'hook value' } }
      } }
    }
    if (kind === 'template') f.member.steps = ['Click {{env:MISSING}}']
    if (kind === 'appium-error') {
      f.member.steps = ['{{appium: mobile: hideKeyboard}}']
      f.config.appiumScript = async () => { throw new Error('synthetic appium failure') }
    }
    const result = await runMemberTest(f.member, f.config)
    const captured = ['no-subaction', 'hook-only', 'appium-error'].includes(kind)
    expect(f.events.filter(event => event.type === 'stepStarted')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'subActionRecorded')).toHaveLength(0)
    expect(f.terminals()).toHaveLength(1)
    expect(f.terminals()[0].status).toBe(result.steps[0].status)
    expect(f.terminals()[0].evidence?.a11y).toEqual({ kind: 'a11y', state: 'absent', reason: captured ? 'empty' : 'not-captured' })
    expect(f.config.accessibilityCheck).toHaveBeenCalledTimes(captured ? 1 : 0)
    expect(f.terminals()[0].variableSnapshot?.prior).toEqual({ value: 'retained', source: 'inline' })
    if (kind === 'hook-only') expect(f.terminals()[0].variableSnapshot?.hooked).toEqual({ value: 'hook value', source: 'hook' })
  },
)

test('EVID-WEB-PRESENT: live masked records/counts publish after a11y and variable capture', async () => {
  const f = fixture()
  let terminalsAtA11y = -1
  let subActionsAtA11y = -1
  f.adapter.drainConsoleLogs = () => [
    { level: 'warn', text: secret, timestamp: 20, location: { url: `https://example.test/${secret}`, lineNumber: 2, columnNumber: 1 } },
    { level: 'error', text: 'second', timestamp: 10 },
  ]
  f.config.accessibility = { enabled: true }
  f.config.accessibilityCheck = async () => {
    terminalsAtA11y = f.terminals().length
    subActionsAtA11y = f.events.filter(event => event.type === 'subActionRecorded').length
    return []
  }
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'captured', method: 'ai' } }]
  f.config.extractorFactory = () => ({ extract: async () => (
    { success: true, variableName: 'captured', value: secret, reasoning: 'synthetic capture' }
  ) })
  const result = await runMemberTest(f.member, f.config)
  expect(terminalsAtA11y).toBe(0)
  expect(subActionsAtA11y).toBeGreaterThan(0)
  expect(result.steps[0].variableSnapshot?.captured.value).toBe('[secret:LIVE_423]')
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'present',
    ref: { id: `console-evidence:${'b'.repeat(64)}`, sha: 'b'.repeat(64) },
    counts: { total: 2, errors: 1, warnings: 1 } })
  expect(f.documents).toEqual([{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [
    { level: 'warn', text: '[secret:LIVE_423]', timestamp: 20, location: { url: 'https://example.test/[secret:LIVE_423]', lineNumber: 2, columnNumber: 1 } },
    { level: 'error', text: 'second', timestamp: 10 },
  ] }])
  expect(JSON.stringify(f.documents)).not.toContain(secret)
})

test('NETWORK-COUNTS: one document and exact persisted total/failed/errored counts precede terminal', async () => {
  const f = fixture()
  const records = [networkRecord(0, 200), networkRecord(1, 400), networkRecord(2, 503), networkRecord(3, 0), networkRecord(4, 399)]
  f.adapter.drainNetworkLogs = vi.fn(() => records)
  f.member.steps = [{ step: 'Click Log in', capture: { variable: 'captured', method: 'ai' } }]
  f.config.extractorFactory = () => ({ extract: async () => (
    { success: true, variableName: 'captured', value: secret, reasoning: 'synthetic' }
  ) })
  const persist = f.config.evidenceArtifacts!.persistEvidenceDocument!
  f.config.evidenceArtifacts!.persistEvidenceDocument = value => {
    expect(f.terminals()).toHaveLength(0)
    return persist(value)
  }
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.network).toMatchObject({ kind: 'network', state: 'present', counts: { total: 5, failed: 2, errored: 1 } })
  expect(f.documents).toHaveLength(1)
  expect(f.documents[0]).toEqual(projectNetworkEvidence(records, text => redactSecretValue(text, f.config.secretRedactor)))
  expect(JSON.stringify(f.documents)).not.toContain(secret)
  expect(JSON.stringify(f.documents)).toContain('synthetic-fresh-session')
  expect(f.adapter.drainNetworkLogs).toHaveBeenCalledTimes(1)
})

test('NETWORK-MULTIPAGE: all drained page records survive in capture order without a global 500 cap', async () => {
  const f = fixture()
  const pages = [Array.from({ length: 400 }, (_, i) => networkRecord(i, 404)),
    Array.from({ length: 350 }, (_, i) => networkRecord(i + 400, 0))]
  f.adapter.drainNetworkLogs = () => pages.flat()
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.network).toMatchObject({ state: 'present', counts: { total: 750, failed: 400, errored: 350 } })
  expect(f.documents).toHaveLength(1)
  const document = f.documents[0]
  expect(document.kind).toBe('network')
  if (document.kind !== 'network') throw new Error('Expected network')
  expect(document.records.map(record => record.startTime)).toEqual(pages.flat().map(record => record.startTime))
})

test('NETWORK-BYTE-STRESS: 600 request plus response 32-KiB bodies retain masked bounds and small row facts', async () => {
  const f = fixture()
  const declared: Record<string, string> = { LIVE_423: secret }
  for (let index = 0; index < 20; index++) declared[`UNUSED_${index}`] = `synthetic-unused-secret-${index}`
  const redactor = new SecretRedactor(new SecretStore(declared))
  f.config.secretRedactor = redactor
  const body = secret + 'é'.repeat(Math.floor((32768 - secret.length) / 2)) + 'a'.repeat((32768 - secret.length) % 2)
  expect(Buffer.byteLength(body)).toBe(32768)
  const records = Array.from({ length: 600 }, (_, i) => ({ ...networkRecord(i), body, requestBody: body }))
  let firstYieldMs: number | undefined
  let drainStarted = 0
  f.adapter.drainNetworkLogs = () => {
    drainStarted = performance.now()
    setTimeout(() => { firstYieldMs = performance.now() - drainStarted }, 0)
    return records
  }
  const persist = f.config.evidenceArtifacts!.persistEvidenceDocument!
  f.config.evidenceArtifacts!.persistEvidenceDocument = value => {
    expect(firstYieldMs).toBeDefined()
    expect(JSON.stringify(value)).not.toContain(secret)
    return persist(value)
  }
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.network).toMatchObject({ state: 'present', counts: { total: 600, failed: 0, errored: 0 } })
  const document = f.documents[0]
  if (document.kind !== 'network') throw new Error('Expected network')
  for (const record of document.records) {
    expect(record.body).toContain('[secret:LIVE_423]')
    expect(record.requestBody).toBe(record.body)
    expect(Buffer.byteLength(record.body!)).toBeLessThanOrEqual(32768)
  }
  const rowEvidenceBytes = Buffer.byteLength(JSON.stringify(f.terminals()[0].evidence))
  expect(rowEvidenceBytes).toBeLessThan(1000)
})

test('NETWORK-CANCEL-DURING-BATCH: cancellation retains all drained content and one cancelled terminal', async () => {
  const f = fixture()
  const records = Array.from({ length: 65 }, (_, index) => networkRecord(index))
  f.adapter.drainNetworkLogs = () => {
    setTimeout(() => f.abort.abort(new Error('synthetic batch cancellation')), 0)
    return records
  }
  const result = await runMemberTest(f.member, f.config)
  expect(f.terminals()).toHaveLength(1)
  expect(result.status).toBe('cancelled')
  expect(result.steps[0].networkLogs).toEqual(records)
  expect(result.steps[0].evidence!.subActions.length).toBeGreaterThan(0)
  expect(f.terminals()[0].status).toBe('cancelled')
  expect(f.terminals()[0].evidence?.network).toMatchObject({ state: 'present', counts: { total: 65, failed: 0, errored: 0 } })
})

test.each(['empty', 'disabled', 'android', 'ios', 'capture-error', 'persist-error', 'missing-mask', 'missing-store', 'missing-drain'] as const)(
  'NETWORK-STATES: %s retains honest absence and the original verdict', async kind => {
    const f = fixture()
    f.adapter.drainNetworkLogs = vi.fn(() => {
      if (kind === 'capture-error') throw new Error('synthetic capture error')
      return kind === 'empty' ? [] : [networkRecord(0)]
    })
    if (kind === 'disabled') f.config.logCapture = { network: false }
    if (kind === 'android' || kind === 'ios') {
      f.config.adapter = { ...f.adapter, platform: kind }
      f.member.steps = ['{{appium: mobile: hideKeyboard}}']
      f.config.appiumScript = async () => ({ success: true })
    }
    if (kind === 'persist-error') f.config.evidenceArtifacts!.persistEvidenceDocument = () => { throw new Error('synthetic persist error') }
    if (kind === 'missing-mask') f.config.secretRedactor = undefined
    if (kind === 'missing-store') f.config.evidenceArtifacts = undefined
    if (kind === 'missing-drain') f.adapter.drainNetworkLogs = undefined
    const result = await runMemberTest(f.member, f.config)
    expect(result.status).toBe('passed')
    const reason = kind === 'empty' ? 'empty' : kind === 'disabled' ? 'not-captured'
      : ['android', 'ios', 'missing-drain'].includes(kind) ? 'unsupported' : 'failed'
    expect(f.terminals()[0].evidence?.network).toEqual({ kind: 'network', state: 'absent', reason })
    expect(f.documents).toEqual([])
    if (kind === 'disabled') expect(f.adapter.drainNetworkLogs).not.toHaveBeenCalled()
    if (kind === 'android' || kind === 'ios') expect(result.steps[0].networkLogs).toEqual([networkRecord(0)])
  },
)

test('EVID-ZERO: captured zero records is empty without counts or a blob', async () => {
  const f = fixture()
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'empty' })
  expect(f.documents).toEqual([])
})

test('EVID-DISABLED: explicit console disable is not-captured and never drains', async () => {
  const f = fixture()
  f.config.logCapture = { console: false }
  await runMemberTest(f.member, f.config)
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'not-captured' })
  expect(f.adapter.drainConsoleLogs).not.toHaveBeenCalled()
  expect(f.documents).toEqual([])
})

test.each(['template', 'hook', 'appium'] as const)(
  'EVID-BYPASS-TERMINAL: %s produces one started terminal with final status', async kind => {
    const f = fixture()
    if (kind === 'template') f.member.steps = ['Click {{env:MISSING}}']
    if (kind === 'hook') {
      f.member.steps = [`{{runHook:"${hookId}"}} Click Log in`]
      f.config.inlineHookDefs = new Map([[hookId, { id: hookId, name: 'synthetic', runtime: 'node', file: 'synthetic.js', deps: [], timeout: 1000, network: false }]])
      f.config.hookExecutor = { execute: async () => ({ success: false, duration: 1, stdout: '', stderr: '', output: '', variables: {} }) }
    }
    if (kind === 'appium') {
      f.member.steps = ['{{appium: mobile: hideKeyboard}}']
      f.config.appiumScript = async () => ({ success: true })
    }
    const result = await runMemberTest(f.member, f.config)
    expect(f.events.filter(event => event.type === 'stepStarted')).toHaveLength(1)
    expect(f.terminals()).toHaveLength(1)
    expect(f.terminals()[0].status).toBe(result.steps[0].status)
    expect(f.terminals()[0].cacheStatus).toBe('bypass')
    expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent',
      reason: kind === 'appium' ? 'empty' : 'not-captured' })
  },
)

test('EVID-ABORT-BEFORE: pre-aborted navigation creates no unstarted result or terminal', async () => {
  const f = fixture()
  f.member.url = 'https://example.test/'
  f.abort.abort(new Error('synthetic cancellation'))
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps).toEqual([])
  expect(f.terminals()).toEqual([])
  expect(f.events.filter(event => event.type === 'stepStarted')).toEqual([])
})

test('EVID-TIMEOUT-NAVIGATE: a navigation timeout records one paired failed row and a timeout outcome', async () => {
  const f = fixture()
  f.member.url = 'https://example.test/'
  f.config.timeouts = { test: 5 }
  f.adapter.execute = async action => {
    if (action.type === 'navigate') return new Promise(() => {})
    return { success: true }
  }
  const result = await runMemberTest(f.member, f.config)
  expect(result.status).toBe('failed')
  expect(result.steps).toHaveLength(1)
  expect(result.steps[0]).toMatchObject({ name: 'Navigate to test URL', status: 'failed' })
  expect(result.steps[0].error).toMatch(/^Test timed out after \d+ms$/)
  const started = f.events.filter(event => event.type === 'stepStarted')
  expect(started.map(event => event.payload)).toEqual([
    expect.objectContaining({ stepIndex: 0, stepText: 'Navigate to test URL' }),
  ])
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0]).toMatchObject({ stepIndex: 0, status: 'failed', error: result.steps[0].error })
  expect(result.failureSummary).toContain('timed out')
  expect(deriveMemberOutcome(result)).toBe('timeout')
})

// the deadline is read from a controlled performance.now clock
// that only the busy step advances, past the test budget. The cell used a real 5 ms budget and a
// 20 ms busy-wait, so any 5 ms of wall time spent before the first step (the real deadline timer
// or the between-steps check) timed out 'Busy step' itself; it failed that way at load 142
// 38.5. The budget is now 60 s of real time, so its real timer cannot fire
// inside the cell, and the controlled clock crosses it by 20 ms during the busy step: the same
// between-steps deadline, with no wall-clock race.
test('EVID-TIMEOUT-DEADLINE: a deadline between steps records the unstarted step as one paired timeout row', async () => {
  const f = fixture()
  f.member.steps = ['Busy step', 'Never starts']
  f.config.timeouts = { test: 60_000 }
  let clock = 1_000
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  f.config.executeStep = async instruction => {
    clock += 60_020
    return { name: instruction, status: 'passed', duration: 60_020 }
  }
  let result: Awaited<ReturnType<typeof runMemberTest>>
  try { result = await runMemberTest(f.member, f.config) } finally { now.mockRestore() }
  expect(result.status).toBe('failed')
  expect(result.steps).toHaveLength(2)
  expect(result.steps[0].status).toBe('passed')
  expect(result.steps[1]).toMatchObject({ name: 'Never starts', status: 'failed' })
  expect(result.steps[1].error).toMatch(/^Test timed out after \d+ms$/)
  expect(f.events.filter(event => event.type === 'stepStarted')).toHaveLength(2)
  expect(f.terminals()).toHaveLength(2)
  expect(f.terminals()[1]).toMatchObject({ stepIndex: 1, status: 'failed', error: result.steps[1].error })
  expect(result.failureSummary).toContain('timed out')
  expect(deriveMemberOutcome(result)).toBe('timeout')
})

test('EVID-ABORT-DURING: runJS cancellation produces exactly one cancelled terminal', async () => {
  const f = fixture()
  f.member.steps = ['Click {{runJS:"value"}}', 'Never starts']
  f.config.runJs = async () => { f.abort.abort(new Error('synthetic cancellation')); return { value: 'cancelled' } }
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps).toHaveLength(1)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('cancelled')
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'not-captured' })
})

test('EVID-A11Y-FINAL: final status includes late accessibility verdict changes', async () => {
  const f = fixture()
  f.config.accessibility = { enabled: true, failOnViolation: true }
  f.config.accessibilityCheck = async () => [{ ruleId: 'synthetic-rule', impact: 'critical',
    description: 'synthetic violation', help: 'Fix it', helpUrl: 'https://example.test/', nodes: [] }]
  const result = await runMemberTest(f.member, f.config)
  expect(result.status).toBe('failed')
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('failed')
  expect(f.terminals()[0].error).toBe(result.steps[0].error)
})

test.each(['drain', 'persist'] as const)('EVID-FAILED: %s failure marks evidence failed without changing verdict', async kind => {
  const f = fixture()
  f.adapter.drainConsoleLogs = () => {
    if (kind === 'drain') throw new Error('synthetic capture failed')
    return [{ level: 'error', text: secret, timestamp: 1 }]
  }
  f.config.evidenceArtifacts!.persistEvidenceDocument = () => { throw new Error('synthetic blob failed') }
  const outcome = await runMemberTest(f.member, f.config).then(value => value, error => ({ error }))
  expect(outcome).toMatchObject({ status: 'passed' })
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'failed' })
})

test('EVID-MOBILE-SCOPE: device logs remain captured while browser evidence is unsupported', async () => {
  const f = fixture()
  f.config.adapter = { ...f.adapter, platform: 'android' }
  f.member.steps = ['{{appium: mobile: hideKeyboard}}']
  f.config.appiumScript = async () => ({ success: true })
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps[0].consoleLogs).toEqual([])
  expect(f.terminals()[0]?.evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'unsupported' })
})

test('EVID-ABORT-DURING: an interrupted active console poll is failed, not an empty capture', async () => {
  const f = fixture()
  Object.assign(f.adapter, { pollDeviceLogs: async () => {
    f.abort.abort(new Error('synthetic poll cancellation'))
    return new Promise<void>(() => {})
  } })
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps).toHaveLength(1)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('cancelled')
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'failed' })
  expect(f.adapter.drainConsoleLogs).not.toHaveBeenCalled()
})

test('EVID-ABORT-BEFORE: cancellation after loop execution skips unstarted capture', async () => {
  const f = fixture()
  f.config.executeStep = async (instruction, ports, context) => {
    const result = await executeStep(instruction, ports, context)
    f.abort.abort(new Error('synthetic cancellation before drain'))
    return result
  }
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps).toHaveLength(1)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('cancelled')
  expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent', reason: 'not-captured' })
  expect(f.adapter.drainConsoleLogs).not.toHaveBeenCalled()
})

test('EVID-ONCE: duplicate and late loop terminals cannot overwrite final member facts', async () => {
  const f = fixture()
  let late: (() => void) | undefined
  f.config.executeStep = async (instruction, ports, context) => {
    const result = await executeStep(instruction, ports, context)
    const emit = () => ports.events?.stepFinalized(result.evidence!, { status: 'failed', error: 'stale callback' })
    emit()
    late = emit
    return result
  }
  await runMemberTest(f.member, f.config)
  late?.()
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('passed')
  expect(f.terminals()[0]).not.toHaveProperty('error')
})

test('EVID-ABORT-DURING: the real loop retains completed sub-action evidence before its cancellation funnel', async () => {
  const f = fixture()
  let actions = 0
  f.config.planner = makePlanner([
    makeActionPlan({ stepComplete: false }),
    makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
  ])
  f.adapter.execute = async () => {
    if (++actions === 2) f.abort.abort(new Error('synthetic action cancellation'))
    return { success: true }
  }
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps).toHaveLength(1)
  expect(result.steps[0].evidence).toBeDefined()
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('cancelled')
  const children = f.events.filter(event => event.type === 'subActionRecorded')
  expect(children.length).toBeGreaterThan(0)
  expect(children.length).toBe(result.steps[0].evidence!.subActions.length)
  expect(f.events.at(-1)?.type).toBe('stepFinalized')
})

test('EVID-TIMEOUT: non-cooperative started execution gets one timeout row and no later row', async () => {
  const f = fixture()
  f.config.timeouts = { step: 5 }
  f.member.steps = ['Never resolves', 'Never starts']
  let startedPorts: LoopPorts | undefined
  f.config.executeStep = async (_instruction, ports) => {
    startedPorts = ports
    return new Promise(() => {})
  }
  const result = await runMemberTest(f.member, f.config)
  expect(startedPorts).toBeDefined()
  expect(result.steps).toHaveLength(1)
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].status).toBe('failed')
  expect(f.terminals()[0].error).toContain('Step timed out')
})

test('EVID-CATCH-REDACTED: a thrown step error crosses the declared-secret redactor before it is recorded', async () => {
  const f = fixture()
  // Three characters sit below the live masker's floor, so only the declared redactor can catch it.
  // Letters outside hex keep a digest in the record from matching it by chance.
  f.config.secretRedactor = { redactString: text => text.replaceAll('xyz', '[secret]') }
  f.config.executeStep = async () => { throw new Error('provider said xyz twice: xyz') }
  const result = await runMemberTest(f.member, f.config)
  expect(result.steps[0].status).toBe('failed')
  expect(result.steps[0].error).toBe('provider said [secret] twice: [secret]')
  expect(f.terminals()).toHaveLength(1)
  expect(f.terminals()[0].error).not.toContain('xyz')
  expect(JSON.stringify(result)).not.toContain('xyz')
})

test.each(['missing-mask', 'missing-store', 'bad-ref', 'missing-drain'] as const)(
  'EVID-UNBOUND: %s does not claim successful durable content', async kind => {
    const f = fixture()
    f.adapter.drainConsoleLogs = () => [{ level: 'error', text: secret, timestamp: 1 }]
    if (kind === 'missing-mask') f.config.secretRedactor = undefined
    if (kind === 'missing-store') f.config.evidenceArtifacts = undefined
    if (kind === 'bad-ref') f.config.evidenceArtifacts!.persistEvidenceDocument = () => ({ id: 'console-evidence:bad', sha: 'b'.repeat(64) })
    if (kind === 'missing-drain') f.adapter.drainConsoleLogs = undefined
    const result = await runMemberTest(f.member, f.config)
    expect(result.status).toBe('passed')
    expect(f.terminals()[0].evidence?.console).toEqual({ kind: 'console', state: 'absent',
      reason: kind === 'missing-drain' ? 'unsupported' : 'failed' })
    expect(f.documents).toEqual([])
  },
)

describe('run records mask declared values in ARIA, console, accessibility and variable evidence', () => {
  const email = 'qa.user@example.com'
  const marker = '[secret:LIVE_423]'

  function memberWithEveryDocument() {
    const f = fixture()
    const screen = makeScreenState({ tree: `- textbox "${secret}" [ref=e1]\n- text "${email}"` })
    f.adapter.observe = async () => screen
    f.adapter.drainConsoleLogs = () => [{ level: 'info', text: `token ${secret} for ${email}`, timestamp: 1 }]
    f.config.accessibility = { enabled: true }
    f.config.accessibilityCheck = async () => [{ ruleId: 'label', impact: 'serious',
      description: `field ${secret} owned by ${email}`, help: 'Label it', helpUrl: 'https://example.test/',
      nodes: [{ html: `<input value="${secret}" placeholder="${email}">`, target: ['#login'] }] }]
    f.config.inlineVars = { login: email }
    f.member.steps = [{ step: 'Click Log in', capture: { variable: 'token', method: 'ai' } }]
    f.config.extractorFactory = () => ({ extract: async () => (
      { success: true, variableName: 'token', value: secret, reasoning: 'synthetic' }
    ) })
    return f
  }

  test('ARIA, console, accessibility and variable evidence mask a declared value and keep the rest', async () => {
    const f = memberWithEveryDocument()
    await runMemberTest(f.member, f.config)
    const persisted = [...f.ariaDocuments, ...f.documents]
    expect(persisted.map(document => document.kind).sort()).toEqual(['a11y', 'aria', 'console'])
    for (const document of persisted) {
      const text = JSON.stringify(document)
      expect(text).toContain(marker)
      expect(text).toContain(email)
      expect(text).not.toContain(secret)
    }
    const terminal = f.terminals()[0]
    expect(terminal.variableSnapshot).toEqual({
      login: { value: email, source: 'inline' }, token: { value: marker, source: 'capture' },
    })
    expect(terminal.evidence).toMatchObject({
      console: { state: 'present' }, a11y: { state: 'present' }, variables: { state: 'present' },
    })
    expect(f.events.filter(event => event.type === 'subActionRecorded')
      .map(event => (event.payload as { ariaEvidence?: { state: string } }).ariaEvidence?.state)).toContain('present')
  })

  test('evidence is withheld when the member has no redactor', async () => {
    const f = memberWithEveryDocument()
    f.adapter.drainNetworkLogs = () => [networkRecord(0)]
    f.config.secretRedactor = undefined
    const result = await runMemberTest(f.member, f.config)
    expect(result.status).toBe('passed')
    expect(f.ariaDocuments).toEqual([])
    expect(f.documents).toEqual([])
    const terminal = f.terminals()[0]
    expect(terminal.evidence).toEqual({
      console: { kind: 'console', state: 'absent', reason: 'failed' },
      network: { kind: 'network', state: 'absent', reason: 'failed' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'failed' },
      variables: { kind: 'variables', state: 'absent', reason: 'failed' },
    })
    expect(terminal).not.toHaveProperty('variableSnapshot')
    expect(f.events.filter(event => event.type === 'subActionRecorded')
      .map(event => (event.payload as { ariaEvidence?: unknown }).ariaEvidence))
      .toEqual(expect.arrayContaining([{ kind: 'aria', state: 'absent', reason: 'failed' }]))
  })
})
