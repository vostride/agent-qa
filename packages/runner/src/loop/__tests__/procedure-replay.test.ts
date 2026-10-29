// PROC-02 loop-harness suite: step-start procedure consult, guarded per-action
// replay riding the cache-replay discipline, one-shot miss semantics with hint demotion,
// and the typed planSource evidence (D-09..D-12). Follows the brief-routing/failure-cautions
// loop-harness idiom: fake adapter/planner/ports, no real model or storage.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  asRef,
  parseProcedureBody,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BriefBlock,
  CompletedRunHandoff,
  ProcedureBodyPayload,
  ProcedureGuardTarget,
  ProcedureMatch,
  ScreenState,
  ServingRecordMetadata,
} from '@vostride/agent-qa-schema'
import { APP_OBSERVED_DATA_CLOSE, APP_OBSERVED_DATA_OPEN } from '@vostride/agent-qa-safety'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { Action, PlatformAdapter } from '../../platform.js'
import type {
  ActionPlanCache,
  CacheablePlannedAction,
  CachedPlanValue,
} from '../../cache/port.js'
import { executeStep } from '../index.js'
import { buildVolatileTier } from '../prompts.js'
import type { RecordLedger } from '../record-ledger.js'
import type { LoopPorts, ProcedureFlowCarry, WorkingMemoryPort } from '../ports.js'
import type { ActionPlan, Planner, StepContext } from '../types.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeAdapter, makeStepContext, makeVerifier } from './loop-harness.js'
import { noCautions, servedBrief, servedCautions } from './fixtures/served-trace.js'

const emptyBrief: BriefBlock = {
  tiers: { L0: '', L1: '', L2: '' },
  lines: [],
  truncation: '',
  admissions: [],
}

const flowAnchor: Anchor = { t: 'flow', name: 'login' }
const PROCEDURE_ID = asRecordId('proc-login')

function makeMatch(overrides: Partial<ProcedureMatch> = {}): ProcedureMatch {
  return {
    id: PROCEDURE_ID,
    flowAnchor,
    confidence: 0.9,
    authoringModelTier: 'full',
    parameterSchema: [{ name: 'userEmail', type: 'string', required: true }],
    replayRecommendation: 'replay',
    ...overrides,
  }
}

/** Two-action login payload matched against the default makeScreenState fixture. */
function loginPayload(): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [{ name: 'userEmail', type: 'string', required: true }],
    steps: [
      {
        instruction: 'Fill the email field',
        action: {
          type: 'fill',
          targets: { ref: { role: 'textbox', nameNormalized: 'email', name: 'Email' } },
          values: { text: { param: 'userEmail' } },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
          pageAnchor: { t: 'page', route: 'https://example.test/login' },
        },
      },
      {
        instruction: 'Click the Log in button',
        action: {
          type: 'click',
          targets: { ref: { role: 'button', nameNormalized: 'log in', name: 'Log in' } },
          values: {},
        },
        guard: {
          target: { role: 'button', nameNormalized: 'log in', name: 'Log in' },
          pageAnchor: { t: 'page', route: 'https://example.test/login' },
        },
      },
    ],
    successAssertion: 'Login completed',
  }
}

interface ReaderSpy {
  reader: KnowledgeHintReader
  /** One JSON-stringified args entry per reader call, keyed by method name. */
  calls: { method: string; args: string }[]
  countOf(method: string): number
}

function makeReader(input: {
  match?: ProcedureMatch
  payload?: ProcedureBodyPayload
  /** Raw body override — lets a row drive the unparseable / zero-step read outcomes. */
  rawBody?: string
}): ReaderSpy {
  const calls: { method: string; args: string }[] = []
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args: JSON.stringify(args, (_key, value) =>
      typeof value === 'function' ? undefined : value,
    ) })
  }
  const reader: KnowledgeHintReader = {
    getRunBrief(scope, budget) {
      record('getRunBrief', [scope, budget])
      return servedBrief(emptyBrief)
    },
    search(query, options) {
      record('search', [query, options])
      return []
    },
    read(id, options) {
      record('read', [id, options])
      if (input.rawBody === undefined && input.payload === undefined) return undefined
      return {
        id,
        title: 'Login procedure',
        body: input.rawBody ?? serializeProcedureBody(input.payload!),
        anchors: [flowAnchor],
        evidenceDigest: 'digest',
        relations: [],
      }
    },
    getCautions(anchors, budget) {
      record('getCautions', [anchors, budget])
      return noCautions()
    },
    getProcedure(intent, screenState, availability) {
      record('getProcedure', [intent, screenState, availability])
      return input.match
    },
    emitCanaryOutcome(payload) {
      record('emitCanaryOutcome', [payload])
    },
  }
  return { reader, calls, countOf: (method) => calls.filter((c) => c.method === method).length }
}

function capturingAdapter(observeResults: ScreenState[]): { adapter: PlatformAdapter; executed: Action[] } {
  const executed: Action[] = []
  const base = makeAdapter({ observeResults })
  const adapter: PlatformAdapter = {
    ...base,
    async execute(action) {
      executed.push(action)
      return base.execute(action)
    },
  }
  return { adapter, executed }
}

interface PlannerSpy {
  planner: Planner
  /** Volatile-tier learned slots snapshotted at each live planning call. */
  calls: { l1?: string; l2?: string }[]
}

function capturingPlanner(plans: ActionPlan[]): PlannerSpy {
  const calls: { l1?: string; l2?: string }[] = []
  const planner: Planner = {
    async plan(_step, _screen, context) {
      calls.push({ l1: context.knowledgeBriefL1, l2: context.knowledgeBriefL2 })
      const idx = Math.min(calls.length - 1, plans.length - 1)
      return { plan: plans[idx] }
    },
  }
  return { planner, calls }
}

/** A screen whose second stored descriptor ("Log in" button) resolves ambiguously. */
function duplicateButtonScreen(): ScreenState {
  const base = makeScreenState()
  const extraRef = asRef('e3')
  const extraBounds = { x: 20, y: 260, width: 350, height: 44 }
  return {
    ...base,
    tree: `${base.tree}\n- button "Log in" [ref=e3] @(20,260 350x44)`,
    elements: [
      ...base.elements,
      {
        ref: extraRef,
        role: 'button',
        name: 'Log in',
        nameNormalized: 'log in',
        bounds: extraBounds,
        center: { x: 195, y: 282 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Log in' },
        attributes: {},
      },
    ],
    refMap: {
      ...base.refMap,
      [extraRef]: { bounds: extraBounds, center: { x: 195, y: 282 } },
    },
  }
}

/** Two-textbox screen for the value-binding test: Email (e1), Code (e2), Log in (e3). */
function twoFieldScreen(): ScreenState {
  const base = makeScreenState()
  const codeRef = asRef('e5')
  const codeBounds = { x: 20, y: 160, width: 350, height: 44 }
  return {
    ...base,
    tree: `${base.tree}\n- textbox "Code" [ref=e5] @(20,160 350x44)`,
    elements: [
      ...base.elements,
      {
        ref: codeRef,
        role: 'textbox',
        name: 'Code',
        nameNormalized: 'code',
        bounds: codeBounds,
        center: { x: 195, y: 182 },
        state: { enabled: true, focused: false, visible: true },
        labels: { placeholder: 'Code' },
        attributes: {},
      },
    ],
    refMap: {
      ...base.refMap,
      [codeRef]: { bounds: codeBounds, center: { x: 195, y: 182 } },
    },
  }
}

function makeWorkingMemory(entries: { key: string; value: string }[]): WorkingMemoryPort {
  return {
    capture: () => {},
    entries: () =>
      entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        kind: 'extracted-value' as const,
        provenance: 'toolResult' as const,
      })),
    dispose: () => {},
  }
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return makeStepContext({
    testName: 'login',
    variables: { userEmail: 'user@example.com' },
    ...overrides,
  })
}

function singleActionPayload(input: {
  parameters?: ProcedureBodyPayload['parameters']
  type: string
  target?: ProcedureGuardTarget
  values: ProcedureBodyPayload['steps'][number]['action']['values']
  instruction?: string
}): ProcedureBodyPayload {
  const target = input.target ?? { role: 'button', nameNormalized: 'log in', name: 'Log in' }
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: input.parameters ?? [],
    steps: [{
      instruction: input.instruction ?? `Replay ${input.type}`,
      action: {
        type: input.type,
        targets: { ref: target },
        values: input.values,
      },
      guard: {
        target,
        pageAnchor: { t: 'page', route: 'https://example.test/login' },
      },
    }],
    successAssertion: 'The stored action completed',
  }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return { ...overrides }
}

interface SourceAssociationPolarityRow {
  name: string
  parameters: ProcedureBodyPayload['parameters']
  values: ProcedureBodyPayload['steps'][number]['action']['values']
  expectedSlot: string
  expectedSource?: {
    kind: 'variable' | 'memory' | 'secret'
    name: string
    declaredType: ProcedureBodyPayload['parameters'][number]['type']
  }
  variables?: Record<string, string>
  memory?: { key: string; value: string }[]
  secrets?: Record<string, string>
  rawSentinels: string[]
}

const sourceAssociationPolarityRows: SourceAssociationPolarityRow[] = [
  {
    name: 'absent same-name source',
    parameters: [{ name: 'MISSING_SOURCE', type: 'string', required: true }],
    values: { text: { param: 'MISSING_SOURCE' } },
    expectedSlot: 'text <- parameter MISSING_SOURCE (string, required)',
    variables: { OTHER_SOURCE: 'ABSENT_OTHER_RAW_38161' },
    rawSentinels: ['ABSENT_OTHER_RAW_38161'],
  },
  {
    name: 'incapable number variable',
    parameters: [{ name: 'DELAY', type: 'number', required: true }],
    values: { clickDelay: { param: 'DELAY' } },
    expectedSlot: 'clickDelay <- parameter DELAY (number, required)',
    variables: { DELAY: 'NUMBER_INCAPABLE_RAW_38161' },
    rawSentinels: ['NUMBER_INCAPABLE_RAW_38161'],
  },
  {
    name: 'incapable boolean memory',
    parameters: [{ name: 'SUBMIT_NOW', type: 'boolean', required: true }],
    values: { submit: { param: 'SUBMIT_NOW' } },
    expectedSlot: 'submit <- parameter SUBMIT_NOW (boolean, required)',
    memory: [{ key: 'SUBMIT_NOW', value: 'BOOLEAN_INCAPABLE_RAW_38161' }],
    rawSentinels: ['BOOLEAN_INCAPABLE_RAW_38161'],
  },
  {
    name: 'secret-only typed mismatch',
    parameters: [{ name: 'SECRET_DELAY', type: 'number', required: true }],
    values: { clickDelay: { param: 'SECRET_DELAY' } },
    expectedSlot: 'clickDelay <- parameter SECRET_DELAY (number, required)',
    secrets: { SECRET_DELAY: 'SECRET_NUMBER_RAW_38161' },
    rawSentinels: ['SECRET_NUMBER_RAW_38161'],
  },
  {
    name: 'variable before memory precedence',
    parameters: [{ name: 'CONTACT', type: 'string', required: true }],
    values: { text: { param: 'CONTACT' } },
    expectedSlot: 'text <- parameter CONTACT (string, required)',
    expectedSource: { kind: 'variable', name: 'CONTACT', declaredType: 'string' },
    variables: { CONTACT: 'VARIABLE_PRECEDENCE_RAW_38161' },
    memory: [{ key: 'CONTACT', value: 'MEMORY_PRECEDENCE_RAW_38161' }],
    rawSentinels: [
      'VARIABLE_PRECEDENCE_RAW_38161',
      'MEMORY_PRECEDENCE_RAW_38161',
    ],
  },
  {
    name: 'capable memory after incapable number variable',
    parameters: [{ name: 'MEMORY_DELAY', type: 'number', required: true }],
    values: { clickDelay: { param: 'MEMORY_DELAY' } },
    expectedSlot: 'clickDelay <- parameter MEMORY_DELAY (number, required)',
    expectedSource: { kind: 'memory', name: 'MEMORY_DELAY', declaredType: 'number' },
    variables: { MEMORY_DELAY: 'MEMORY_DELAY_INCAPABLE_RAW_38161' },
    memory: [{ key: 'MEMORY_DELAY', value: '38161042' }],
    rawSentinels: ['MEMORY_DELAY_INCAPABLE_RAW_38161', '38161042'],
  },
  {
    name: 'string secret fallback',
    parameters: [{ name: 'SECRET_CONTACT', type: 'string', required: true }],
    values: { text: { param: 'SECRET_CONTACT' } },
    expectedSlot: 'text <- parameter SECRET_CONTACT (string, required)',
    expectedSource: { kind: 'secret', name: 'SECRET_CONTACT', declaredType: 'string' },
    secrets: { SECRET_CONTACT: 'STRING_SECRET_RAW_38161' },
    rawSentinels: ['STRING_SECRET_RAW_38161'],
  },
  {
    name: 'secret parameter ignores the same-named variable',
    parameters: [{ name: 'LOGIN_SECRET', type: 'secret', required: true }],
    values: { text: { param: 'LOGIN_SECRET' } },
    expectedSlot: 'text <- parameter LOGIN_SECRET (secret, required)',
    expectedSource: { kind: 'secret', name: 'LOGIN_SECRET', declaredType: 'secret' },
    variables: { LOGIN_SECRET: 'VARIABLE_SECRET_MISMATCH_RAW_38161' },
    secrets: { LOGIN_SECRET: 'SECRET_BINDING_RAW_38161' },
    rawSentinels: [
      'VARIABLE_SECRET_MISMATCH_RAW_38161',
      'SECRET_BINDING_RAW_38161',
    ],
  },
  {
    name: 'undeclared parameter with a same-named variable',
    parameters: [],
    values: { text: { param: 'UNDECLARED_SOURCE' } },
    expectedSlot: 'text <- parameter UNDECLARED_SOURCE (undeclared)',
    variables: { UNDECLARED_SOURCE: 'UNDECLARED_RAW_38161' },
    rawSentinels: ['UNDECLARED_RAW_38161'],
  },
  {
    name: 'literal-omitted slot',
    parameters: [],
    values: { text: 'LITERAL_OMITTED_RAW_38161' },
    expectedSlot: 'text <- stored literal omitted',
    rawSentinels: ['LITERAL_OMITTED_RAW_38161'],
  },
]

describe('procedure guarded replay', () => {
  it('authored prose cannot override structured parameter provenance', async () => {
    const handoffBytes = readFileSync(
      new URL('./fixtures/f-381-54-1/handoff.json', import.meta.url),
    )
    const recordBytes = readFileSync(
      new URL('./fixtures/f-381-54-1/procedure-record.md', import.meta.url),
    )
    expect(createHash('sha256').update(handoffBytes).digest('hex')).toBe(
      '3a157aa7bfc864af87771c5747fde2ab4bd096ea7cb2e4f473aea43b7f5e4288',
    )
    expect(createHash('sha256').update(recordBytes).digest('hex')).toBe(
      'e4a660e14e87763afdb1ac51675b3839820e15811cdc07290812d1bc296e6e3e',
    )

    const handoff = JSON.parse(handoffBytes.toString('utf8')) as CompletedRunHandoff
    const failedTest = handoff.tests[0]!
    const failedStep = failedTest.steps[0]!
    const failedSubAction = failedStep.subActions[0]!
    expect(handoff.aggregateVerdict).toBe('failed')
    expect(failedTest.outcome).toBe('failed')
    expect(failedStep.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: 'procedure-flow-t-posing-clock-inject-pill-adds-i-29ff61a3638ac355',
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'descriptor-missing' },
      },
      flow: { cursor: 0, length: 2 },
    })
    expect(failedStep.termination).toMatchObject({ kind: 'infeasible' })
    if (failedStep.termination?.kind !== 'infeasible') {
      throw new Error('fixture step must preserve the infeasible termination')
    }
    expect(failedStep.termination.reason).toContain('<EMAIL_0>')
    expect(failedSubAction.plannedAction).toMatchObject({
      type: 'fill',
      ref: 'e2',
      text: '<EMAIL_0>',
      elementDescription: expect.stringContaining('Account name'),
    })
    expect(failedStep.interpolatedVariables).toEqual([
      { name: 'PROBE_USER', value: 'qa.user+381@example.com' },
    ])

    const payload = parseProcedureBody(recordBytes.toString('utf8'))
    if (!payload) throw new Error('fixture procedure body must parse')
    expect(payload.parameters).toEqual([
      { name: 'PROBE_USER', type: 'string', required: true },
    ])
    expect(payload.steps[0]).toMatchObject({
      instruction: 'Type "<EMAIL_0>" into the Username field',
      action: {
        type: 'fill',
        values: { text: { param: 'PROBE_USER' } },
      },
    })

    const fixtureSource = failedStep.planSource
    if (fixtureSource?.kind !== 'procedure-replay') {
      throw new Error('fixture step must preserve procedure replay provenance')
    }
    const screen = failedSubAction.stateBefore
    const accountField = screen.elements.find((element) => element.nameNormalized === 'account name')!
    const match = makeMatch({
      id: fixtureSource.procedureId,
      flowAnchor: { t: 'flow', name: failedTest.testId },
      parameterSchema: payload.parameters,
    })
    const reader = makeReader({ match, payload })
    const events: string[] = []
    const executed: Action[] = []
    const baseAdapter = makeAdapter({ observeResults: [screen] })
    const adapter: PlatformAdapter = {
      ...baseAdapter,
      async execute(action) {
        events.push(`adapter:${action.type}`)
        executed.push(action)
        return baseAdapter.execute(action)
      },
    }
    const plannerCalls: { l1?: string; l2?: string }[] = []
    const planner: Planner = {
      async plan(_step, _screen, plannerContext) {
        events.push('planner')
        plannerCalls.push({
          l1: plannerContext.knowledgeBriefL1,
          l2: plannerContext.knowledgeBriefL2,
        })
        return {
          plan: makeActionPlan({
            reasoning: 'Use the sole visible text field to finish the characterized step',
            action: {
              type: 'fill',
              ref: accountField.ref,
              text: 'qa.user+381@example.com',
              elementDescription: 'Account name',
              clearMode: 'replace',
              submit: false,
            },
            stepComplete: true,
          }),
        }
      },
    }

    const result = await executeStep(
      failedStep.stepText,
      ports({ adapter, planner, knowledgeReader: reader.reader }),
      context({
        stepInstruction: failedStep.stepText,
        testName: failedTest.testName,
        variables: { PROBE_USER: 'qa.user+381@example.com' },
        interpolatedVariables: failedStep.interpolatedVariables,
      }),
    )

    expect(result.status).toBe('passed')
    expect(reader.countOf('getProcedure')).toBe(1)
    expect(plannerCalls).toHaveLength(1)
    expect(events).toEqual(['planner', 'adapter:fill'])
    expect(executed).toMatchObject([{ type: 'fill', ref: accountField.ref }])
    expect(result.evidence?.planSource).toEqual(fixtureSource)

    const l2 = plannerCalls[0]!.l2 ?? ''
    expect(l2).toContain(APP_OBSERVED_DATA_OPEN)
    expect(l2).toContain(APP_OBSERVED_DATA_CLOSE)
    expect(l2).not.toContain('Type "<EMAIL_0>" into the Username field')
    expect(l2).toContain('miss reason: descriptor-missing')
    expect(l2).toContain('miss location: action-target lane=ref')
    expect(l2).toContain('text <- parameter PROBE_USER (string, required)')
    expect(l2).toContain('variable sources:')
    expect(l2).toContain(
      'PROBE_USER (canBindNumber=false, canBindBoolean=false)',
    )
    expect(l2).toContain('interpolatedInCurrentStep=true')
    expect(l2).not.toContain('ref=e2')
    expect(l2).not.toContain('qa.user+381@example.com')

    const authoredInstruction = 'Type "<EMAIL_0>" into the Username field'
    const desiredContract =
      !l2.includes(authoredInstruction) &&
      l2.includes('text <- parameter PROBE_USER') &&
      l2.includes('interpolatedInCurrentStep=true')
    expect(desiredContract, 'F-381-54-1_EXPECTED_RED_CONTRACT').toBe(true)
  })

  it('projects the real renamed screen as one advisory textbox candidate', async () => {
    // 381-54-EVIDENCE records both renamed-screen failures. This row derives the candidate
    // from the preserved stateBefore; it makes no Username/Account-name equivalence claim.
    const handoff = JSON.parse(readFileSync(
      new URL('./fixtures/f-381-54-1/handoff.json', import.meta.url),
      'utf8',
    )) as CompletedRunHandoff
    const record = readFileSync(
      new URL('./fixtures/f-381-54-1/procedure-record.md', import.meta.url),
      'utf8',
    )
    const payload = parseProcedureBody(record)
    if (!payload) throw new Error('fixture procedure body must parse')
    const failedTest = handoff.tests[0]!
    const failedStep = failedTest.steps[0]!
    const screen = failedStep.subActions[0]!.stateBefore
    const source = failedStep.planSource
    if (source?.kind !== 'procedure-replay') {
      throw new Error('fixture step must preserve procedure replay provenance')
    }
    const reader = makeReader({
      match: makeMatch({
        id: source.procedureId,
        flowAnchor: { t: 'flow', name: failedTest.testId },
        parameterSchema: payload.parameters,
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([screen])
    const submit = screen.elements.find((element) => element.nameNormalized === 'submit')!
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: submit.ref }, stepComplete: true }),
    ])

    const result = await executeStep(
      failedStep.stepText,
      ports({ adapter, planner: planner.planner, knowledgeReader: reader.reader }),
      context({
        stepInstruction: failedStep.stepText,
        testName: failedTest.testName,
        variables: { PROBE_USER: 'qa.user+381@example.com' },
        interpolatedVariables: failedStep.interpolatedVariables,
      }),
    )

    expect(result.status).toBe('passed')
    expect(executed).toMatchObject([{ type: 'click', ref: submit.ref }])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    const candidateRows = learned.split('\n').filter((line) => line.startsWith('- role='))
    expect(candidateRows).toEqual([
      '- role=textbox; name=Account name',
    ])
    expect(learned).toContain('Recovery evidence is advisory only; it is not replay authorization')
    expect(candidateRows.join('\n').toLowerCase()).not.toMatch(/\b(rename|match|equivalent)\b/)
    expect(learned).not.toContain('ref=e2')
    expect(learned).not.toContain('Type "<EMAIL_0>" into the Username field')
  })

  it('source-bound email recovery marks the PROBE_USER slot as supplied without exposing its value', async () => {
    const handoff = JSON.parse(readFileSync(
      new URL('./fixtures/f-381-54-1/handoff.json', import.meta.url),
      'utf8',
    )) as CompletedRunHandoff
    const record = readFileSync(
      new URL('./fixtures/f-381-54-1/procedure-record.md', import.meta.url),
      'utf8',
    )
    const payload = parseProcedureBody(record)
    if (!payload) throw new Error('fixture procedure body must parse')
    const failedTest = handoff.tests[0]!
    const failedStep = failedTest.steps[0]!
    const failedSubAction = failedStep.subActions[0]!
    const source = failedStep.planSource
    if (source?.kind !== 'procedure-replay') {
      throw new Error('fixture step must preserve procedure replay provenance')
    }
    const reader = makeReader({
      match: makeMatch({
        id: source.procedureId,
        flowAnchor: { t: 'flow', name: failedTest.testId },
        parameterSchema: payload.parameters,
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([failedSubAction.stateBefore])
    const submit = failedSubAction.stateBefore.elements.find(
      (element) => element.nameNormalized === 'submit',
    )!
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: submit.ref }, stepComplete: true }),
    ])

    const result = await executeStep(
      failedStep.stepText,
      ports({ adapter, planner: planner.planner, knowledgeReader: reader.reader }),
      context({
        stepInstruction: failedStep.stepText,
        testName: failedTest.testName,
        variables: { PROBE_USER: 'qa.user+381@example.com' },
        interpolatedVariables: failedStep.interpolatedVariables,
      }),
    )

    expect(result.status).toBe('passed')
    expect(reader.countOf('getProcedure')).toBe(1)
    expect(planner.calls).toHaveLength(1)
    expect(executed).toMatchObject([{ type: 'click', ref: submit.ref }])
    expect(result.evidence?.planSource).toEqual(source)

    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss reason: descriptor-missing')
    expect(learned).toContain('miss location: action-target lane=ref')
    expect(learned).not.toContain('qa.user+381@example.com')
    expect(learned).toContain(
      'text <- parameter PROBE_USER (string, required); supplied loop-side '
        + '(sourceKind=variable; sourceName=PROBE_USER; declaredType=string); not unresolved',
    )
  })

  it.each(sourceAssociationPolarityRows)(
    'source-association polarity: $name',
    async (row) => {
      const missingTarget = { role: 'textbox', nameNormalized: 'missing-recovery-target' }
      const payload = singleActionPayload({
        parameters: row.parameters,
        type: 'fill',
        target: missingTarget,
        values: row.values,
        instruction: 'AUTHORED_SOURCE_ASSOCIATION_PROSE_38161',
      })
      const reader = makeReader({
        match: makeMatch({ parameterSchema: row.parameters }),
        payload,
      })
      const { adapter, executed } = capturingAdapter([makeScreenState()])
      const planner = capturingPlanner([
        makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
      ])
      const flowCell: { carry?: ProcedureFlowCarry } = {}

      const result = await executeStep(
        `Recover the ${row.name} case`,
        ports({
          adapter,
          planner: planner.planner,
          knowledgeReader: reader.reader,
          recordLedger: makeLedgerSpy(true).ledger,
          procedureFlow: flowCell,
          ...(row.memory === undefined ? {} : { workingMemory: makeWorkingMemory(row.memory) }),
          ...(row.secrets === undefined ? {} : { secretStore: new SecretStore(row.secrets) }),
        }),
        context({ variables: row.variables ?? {} }),
      )

      expect(result.status).toBe('passed')
      expect(reader.countOf('getProcedure')).toBe(1)
      expect(planner.calls).toHaveLength(1)
      // The only dispatch is the live planner's click. The stored fill never executes after
      // descriptor-missing, and replay does not re-enter after the one-shot miss.
      expect(executed).toMatchObject([{ type: 'click', ref: 'e2' }])
      expect(executed).toHaveLength(1)
      expect(flowCell.carry).toBeUndefined()
      expect(result.evidence?.planSource).toEqual({
        kind: 'procedure-replay',
        procedureId: PROCEDURE_ID,
        guard: {
          checksPassed: 0,
          total: 1,
          miss: { procedureStepIndex: 0, reason: 'descriptor-missing' },
        },
        flow: { cursor: 0, length: 1 },
      })

      const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
      expect(learned).toContain('miss location: action-target lane=ref')
      expect(learned).toContain(row.expectedSlot)
      const slotRow = learned.split('\n').find((line) => line.includes(row.expectedSlot)) ?? ''
      if (row.expectedSource === undefined) {
        expect(slotRow).not.toContain('supplied loop-side')
        expect(slotRow).not.toContain('sourceKind=')
      } else {
        expect(slotRow).toContain(
          `supplied loop-side (sourceKind=${row.expectedSource.kind}; `
            + `sourceName=${row.expectedSource.name}; `
            + `declaredType=${row.expectedSource.declaredType}); not unresolved`,
        )
      }
      expect(learned).not.toContain('AUTHORED_SOURCE_ASSOCIATION_PROSE_38161')
      for (const sentinel of row.rawSentinels) {
        expect(learned).not.toContain(sentinel)
      }
    },
  )

  it('Test 1: a replay-recommendation match drives the step\'s one body step with no planning-turn LLM call', async () => {
    // F-381-51-1 · D-09 rewrite: the old law pinned the WHOLE 2-action body replaying
    // inside one test step (fold 2/2). The new law: each test step consumes exactly the
    // one body step at the cursor — the fill here; the click belongs to the NEXT test
    // step via the carry (procedure-step-boundary.test.ts pins the cross-step half).
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(executed.map((action) => action.type)).toEqual(['fill'])

    const evidence = result.evidence!
    expect(evidence.subActions).toHaveLength(1)
    for (const sub of evidence.subActions) {
      expect(sub.grounding).toBeDefined()
      expect(sub.grounding!.attempts.length).toBeGreaterThan(0)
    }
    expect(evidence.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: { checksPassed: 1, total: 1 },
      flow: { cursor: 0, length: 2 },
    })
  })

  it('aborts after a replayed adapter execution fails without advancing the guard fold', async () => {
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const executed: Action[] = []
    const base = makeAdapter({
      observeResults: [makeScreenState()],
      executeResults: [
        { success: false, error: 'simulated replay adapter failure' },
        { success: true },
      ],
    })
    const adapter: PlatformAdapter = {
      ...base,
      async execute(action) {
        executed.push(action)
        return base.execute(action)
      },
    }
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed).toMatchObject([
      { type: 'fill', ref: 'e1' },
      { type: 'click', ref: 'e1' },
    ])
    expect(executed).not.toContainEqual(expect.objectContaining({ type: 'click', ref: 'e2' }))

    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('Fill the email field')
    expect(learned).toContain('simulated replay adapter failure')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        // Per-step fold: total = the one stored action THIS test step
        // attempted, not the whole body length the old law recorded here.
        checksPassed: 0,
        total: 1,
        executionFailure: { procedureStepIndex: 0 },
      },
      flow: { cursor: 0, length: 2 },
    })
  })

  it('preserves literal boolean value slots instead of treating them as parameter refs', async () => {
    const payload = loginPayload()
    payload.steps[0].action.values.submit = true
    const spy = makeReader({ match: makeMatch(), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed[0]).toMatchObject({ type: 'fill', submit: true })
  })

  it('preserves literal numeric value slots as numbers through replay', async () => {
    const payload = singleActionPayload({
      type: 'doubleClick',
      values: { clickDelay: 4 },
    })
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Double-click Log in with the stored delay',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed[0]).toMatchObject({ type: 'doubleClick', clickDelay: 4 })
    expect(typeof (executed[0] as Extract<Action, { type: 'doubleClick' }>).clickDelay)
      .toBe('number')
  })

  it('unwraps a tagged file list before canonical file-upload validation and execution', async () => {
    const payload = singleActionPayload({
      type: 'fileUpload',
      values: { files: { json: ['a.png'] } },
    })
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Upload the stored file list',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed[0]).toMatchObject({ type: 'fileUpload' })
    expect((executed[0] as Extract<Action, { type: 'fileUpload' }>).files).toEqual([
      'a.png',
    ])
  })

  it('unwraps a tagged relative position before canonical double-click execution', async () => {
    const payload = singleActionPayload({
      type: 'doubleClick',
      values: { relativePosition: { json: { x: 5, y: 7 } } },
    })
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Double-click at the stored relative position',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed[0]).toMatchObject({
      type: 'doubleClick',
      relativePosition: { x: 5, y: 7 },
    })
  })

  it('keeps a navigating carried replay guard on its own pre-action page', async () => {
    // F-381-51-1 · D-09 rewrite: the old law pinned the whole body in one step with the
    // FINAL action's guard on the pre-action page. The new law strengthens the pin: EVERY
    // replayed body step's guard is evaluated on its OWN test step's pre-action screen —
    // the navigating click replays at test step 1 via the carry, its guard passes on the
    // login page it observes, and StepEvidence records the honest post-action navigation.
    // Neither side may silently drift to the other's URL semantics.
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const login = makeScreenState()
    const dashboard = makeScreenState({ url: 'https://example.test/dashboard' })
    // quick 261004-lsa: each verify-path settle reads one more frame, so step 0 consumes four.
    const { adapter, executed } = capturingAdapter([login, login, login, login, login, login, dashboard])
    const planner = capturingPlanner([makeActionPlan()])
    const verifier = makeVerifier()
    const sharedPorts = () => ports({
      adapter,
      planner: planner.planner,
      verifier,
      knowledgeReader: spy.reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep('Fill the email field', sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(executed.map((action) => action.type)).toEqual(['fill'])
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Click the Log in button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed.map((action) => action.type)).toEqual(['fill', 'click'])
    expect(step1.evidence?.planSource?.kind).toBe('procedure-replay')
    if (step1.evidence?.planSource?.kind !== 'procedure-replay') {
      throw new Error('expected procedure-replay planSource')
    }
    expect(step1.evidence.planSource.guard.miss).toBeUndefined()
    expect(step1.evidence.planSource.guard.checksPassed).toBe(
      step1.evidence.planSource.guard.total,
    )
    const completing = step1.evidence.subActions.at(-1)!
    expect(completing.stateBefore.url).toBe('https://example.test/login')
    expect(completing.stateAfter?.url).toBe('https://example.test/dashboard')
    expect(completing.stateAfter?.url).not.toBe(completing.stateBefore.url)
  })

  it('Test 2: an ambiguous carried descriptor aborts once and projects ordered structural recovery evidence', async () => {
    // F-381-51-1 · D-09 rewrite: the old law hit the ambiguous second descriptor INSIDE
    // one test step (fold 1-of-2 with the miss). The new law reaches body step 1 at its
    // own test step via the carry — the miss aborts one-shot THERE (per-step fold 0-of-1),
    // projects structural recovery, and the flow is over for the run (no carry).
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const stable = makeScreenState()
    const drifted = duplicateButtonScreen()
    const { adapter, executed } = capturingAdapter([stable, stable, drifted])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const sharedPorts = () => ports({
      adapter,
      planner: planner.planner,
      knowledgeReader: spy.reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep('Fill the email field', sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Click the Log in button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    // Replay drove step 0's fill; the carried click missed and planning took over — once.
    expect(executed.map((action) => action.type)).toEqual(['fill', 'click'])
    expect(planner.calls).toHaveLength(1)
    // The miss reaches planning only through the generated structural recovery projection.
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('Guarded replay recovery evidence for procedure step 2')
    expect(learned).toContain('miss reason: descriptor-ambiguous')
    expect(learned).toContain('miss location: action-target lane=ref')
    expect(learned).toContain('Recovery evidence is advisory only; it is not replay authorization')
    expect(learned).not.toContain('Fill the email field')
    expect(learned).not.toContain('Click the Log in button')
    const candidates = learned.slice(learned.indexOf('fresh same-role candidates:'))
    // both candidates are named by role and exact name, in screen order, with no
    // position for the planner to pick by.
    expect(candidates).toContain(
      'fresh same-role candidates:\n- role=button; name=Log in\n- role=button; name=Log in',
    )
    expect(candidates).not.toMatch(/ordinal/i)
    expect(candidates).not.toContain('ref=e2')
    expect(candidates).not.toContain('ref=e3')
    const candidateRows = candidates.split('\n').filter((line) => line.startsWith('- role='))
    expect(candidateRows.join('\n').toLowerCase()).not.toMatch(/\b(rename|match|equivalent)\b/)

    expect(step1.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 1, reason: 'descriptor-ambiguous' },
      },
      flow: { cursor: 1, length: 2 },
    })
    expect(flowCell.carry).toBeUndefined()
  })

  it('aborts before dispatch when the declared guard target is missing even though the action target resolves', async () => {
    const payload = loginPayload()
    payload.steps = [{
      ...payload.steps[0],
      guard: {
        ...payload.steps[0].guard,
        target: { role: 'button', nameNormalized: 'reset password' },
      },
    }]
    const spy = makeReader({ match: makeMatch(), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss location: guard-target')
    expect(learned).toContain(
      'declared guard target: role=button; name=reset password',
    )
    expect(learned).toContain('fresh same-role candidates:')
    expect(learned).toContain('fresh same-role candidates:\n- role=button; name=Log in')
    expect(learned).not.toContain('Fill the email field')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'descriptor-missing' },
      },
      flow: { cursor: 0, length: 1 },
    })
  })

  it('aborts before dispatch when the declared guard target is ambiguous even though the action target resolves', async () => {
    const payload = loginPayload()
    payload.steps = [{
      ...payload.steps[0],
      guard: {
        ...payload.steps[0].guard,
        target: { role: 'button', nameNormalized: 'log in', name: 'Log in' },
      },
    }]
    const spy = makeReader({ match: makeMatch(), payload })
    const { adapter, executed } = capturingAdapter([duplicateButtonScreen()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss reason: descriptor-ambiguous')
    expect(learned).toContain('miss location: guard-target')
    const candidates = learned.slice(learned.indexOf('fresh same-role candidates:'))
    expect(candidates).toContain(
      'fresh same-role candidates:\n- role=button; name=Log in\n- role=button; name=Log in',
    )
    expect(candidates).not.toMatch(/ordinal/i)
    expect(learned).not.toContain('Fill the email field')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'descriptor-ambiguous' },
      },
      flow: { cursor: 0, length: 1 },
    })
  })

  it('projects zero candidates only for the failed lane of a multi-lane action', async () => {
    const payload: ProcedureBodyPayload = {
      schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
      parameters: [],
      steps: [{
        instruction: 'Drag using authored prose that recovery must omit',
        action: {
          type: 'drag',
          targets: {
            fromRef: { role: 'button', nameNormalized: 'log in', name: 'Log in' },
            toRef: { role: 'link', nameNormalized: 'destination' },
          },
          values: {},
        },
        guard: {
          target: { role: 'button', nameNormalized: 'log in', name: 'Log in' },
          pageAnchor: { t: 'page', route: 'https://example.test/login' },
        },
      }],
      successAssertion: 'The drag completed',
    }
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Recover from the unavailable drag destination',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(executed.map((action) => action.type)).toEqual(['click'])
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss location: action-target lane=toRef')
    const candidates = learned.slice(learned.indexOf('fresh same-role candidates:'))
    expect(candidates).toContain('fresh same-role candidates:\n- none')
    expect(candidates).not.toContain('role=button')
    expect(candidates).not.toContain('name=Log in')
    expect(learned).not.toContain('Drag using authored prose that recovery must omit')
    expect(result.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'descriptor-missing' } },
    })
  })

  it('keeps raw variable, memory, secret, and literal values behind the recovery firewall', async () => {
    const payload: ProcedureBodyPayload = {
      schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
      parameters: [
        { name: 'VAR_NAME', type: 'string', required: true },
        { name: 'MEM_NAME', type: 'number', required: false },
        { name: 'SECRET_NAME', type: 'secret', required: true },
      ],
      steps: [{
        instruction: 'AUTHORED_RECOVERY_PROSE_38155',
        action: {
          type: 'fill',
          targets: { ref: { role: 'textbox', nameNormalized: 'mask-me-missing' } },
          values: {
            text: { param: 'VAR_NAME' },
            clickDelay: { param: 'MEM_NAME' },
            secretField: { param: 'SECRET_NAME' },
            literalField: 'LITERAL_RAW_38155',
            jsonField: { json: { nested: 'JSON_RAW_38155' } },
          },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'mask-me-missing' },
          pageAnchor: {
            t: 'page',
            route: 'https://example.test/login?STORED_QUERY_RAW_38155',
          },
        },
      }],
      successAssertion: 'The action completed',
    }
    const baseScreen = makeScreenState({
      url: 'https://example.test/login?LIVE_QUERY_RAW_38155',
    })
    const screen: ScreenState = {
      ...baseScreen,
      tree: `${baseScreen.tree}\nTREE_RAW_38155`,
      elements: baseScreen.elements.map((element, index) =>
        index === 0
          ? {
              ...element,
              ref: asRef('SCREEN_REF_RAW_38155'),
              value: 'SCREEN_VALUE_RAW_38155',
              labels: { ariaLabel: 'SCREEN_LABEL_RAW_38155' },
              attributes: { sentinel: 'SCREEN_ATTRIBUTE_RAW_38155' },
            }
          : element
      ),
    }
    const spy = makeReader({ match: makeMatch({ parameterSchema: payload.parameters }), payload })
    const { adapter } = capturingAdapter([screen])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const ledgerSpy = makeLedgerSpy(true)

    const result = await executeStep(
      'Recover without exposing values',
      ports({
        adapter,
        planner: planner.planner,
        knowledgeReader: spy.reader,
        recordLedger: ledgerSpy.ledger,
        workingMemory: makeWorkingMemory([{ key: 'MEM_NAME', value: 'MEMORY_RAW_38155' }]),
        secretStore: new SecretStore({ SECRET_NAME: 'SECRET_RAW_38155' }),
        secretRedactor: new SecretRedactor(new SecretStore({ DESCRIPTOR_38155: 'mask-me-missing' })),
      }),
      context({
        variables: { VAR_NAME: 'VARIABLE_RAW_38155' },
        interpolatedVariables: [{ name: 'VAR_NAME', value: 'VARIABLE_RAW_38155' }],
      }),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('name=[secret:DESCRIPTOR_38155]')
    expect(learned).not.toContain('mask-me-missing')
    expect(learned).toContain('text <- parameter VAR_NAME (string, required)')
    expect(learned).toContain('clickDelay <- parameter MEM_NAME (number, optional)')
    expect(learned).toContain('secretField <- parameter SECRET_NAME (secret, required)')
    expect(learned).toContain('literalField <- stored literal omitted')
    expect(learned).toContain('jsonField <- stored literal omitted')
    expect(learned).toContain('VAR_NAME (canBindNumber=false, canBindBoolean=false)')
    expect(learned).toContain('MEM_NAME (canBindNumber=false, canBindBoolean=false)')
    expect(learned).toContain('secret sources: SECRET_NAME')
    expect(learned).toContain('interpolatedInCurrentStep=true')
    expect(learned).not.toContain('its value is already present there')
    for (const forbidden of [
      'VARIABLE_RAW_38155',
      'MEMORY_RAW_38155',
      'SECRET_RAW_38155',
      'LITERAL_RAW_38155',
      'JSON_RAW_38155',
      'AUTHORED_RECOVERY_PROSE_38155',
      'TREE_RAW_38155',
      'SCREEN_REF_RAW_38155',
      'SCREEN_VALUE_RAW_38155',
      'SCREEN_LABEL_RAW_38155',
      'SCREEN_ATTRIBUTE_RAW_38155',
      'STORED_QUERY_RAW_38155',
      'LIVE_QUERY_RAW_38155',
      '{{secret:SECRET_NAME}}',
      'ref=e1',
      'ref=e2',
    ]) {
      expect(learned).not.toContain(forbidden)
    }
  })

  it('drops dynamic grounding errors and refs at the typed grounding-gate location', async () => {
    const baseScreen = makeScreenState()
    const gateRef = asRef('GATE_ERROR_REF_RAW_38155')
    const screen: ScreenState = {
      ...baseScreen,
      elements: baseScreen.elements.map((element) =>
        element.role === 'button'
          ? {
              ...element,
              ref: gateRef,
              name: 'Gate target',
              nameNormalized: 'gate target',
            }
          : element
      ),
      // Deliberately retain the old refMap: the descriptor resolves to gateRef, then the
      // grounding gate raises a dynamic ref-not-in-snapshot error containing that sentinel.
      refMap: baseScreen.refMap,
    }
    const payload = singleActionPayload({
      type: 'click',
      target: { role: 'button', nameNormalized: 'gate target', name: 'Gate target' },
      values: {},
      instruction: 'AUTHORED_GATE_PROSE_38155',
    })
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([screen])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Recover after the grounding gate refuses a stale ref',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(executed).toMatchObject([{ type: 'click', ref: 'e1' }])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss reason: gate-refused')
    expect(learned).toContain('miss location: grounding-gate')
    expect(learned).toContain('role=button; name=Gate target')
    expect(learned).not.toContain('fresh same-role candidates:')
    expect(learned).not.toContain('GATE_ERROR_REF_RAW_38155')
    expect(learned).not.toContain('ref_not_in_snapshot')
    expect(learned).not.toContain('AUTHORED_GATE_PROSE_38155')
    expect(result.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'gate-refused' } },
    })
  })

  it('Test 3: a live page anchor differing from the stored one is a miss even with a unique descriptor', async () => {
    const payload = loginPayload()
    payload.steps = [
      {
        ...payload.steps[1],
        guard: {
          target: { role: 'button', nameNormalized: 'log in', name: 'Log in' },
          pageAnchor: { t: 'page', route: 'https://example.test/checkout' },
        },
      },
    ]
    const spy = makeReader({ match: makeMatch(), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    // No replayed action executed — the click came from the planning turn.
    expect(executed.map((action) => action.type)).toEqual(['click'])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss location: page-anchor')
    expect(learned).toContain('page anchor equality: false')
    expect(learned).not.toContain('fresh same-role candidates:')
    expect(learned).not.toContain('https://example.test/checkout')
    expect(learned).not.toContain('Click the Log in button')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'page-anchor-mismatch' },
      },
      flow: { cursor: 0, length: 1 },
    })
  })

  it('Test 4: a test step never consumes past its one body step and body exhaustion leaves no carry', async () => {
    // F-381-51-1 · D-09 rewrite: the old law pinned in-step exhaustion ("replayed actions
    // never exceed the sequence length"). The new law: exhaustion happens ACROSS steps —
    // the carry ends after the LAST body step's test step, so a single-step body's step
    // both exhausts the flow and (on rejection) demotes with no replay re-entry and no
    // carry for any later step.
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const payload = loginPayload()
    payload.steps = [payload.steps[1]]
    const spy = makeReader({ match: makeMatch(), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const verifier = makeVerifier([
      { success: false, reasoning: 'not done yet', isAppError: false },
      { success: true, reasoning: 'done', isAppError: false },
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({
        adapter,
        planner: planner.planner,
        verifier,
        knowledgeReader: spy.reader,
        procedureFlow: flowCell,
      }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    // One replayed click, then the verifier rejection forced a live planning turn (no replay
    // re-entry within the step, D-11).
    expect(executed.map((action) => action.type)).toEqual(['click', 'click'])
    expect(planner.calls).toHaveLength(1)
    const l2 = planner.calls[0].l2 ?? ''
    const open = l2.indexOf(APP_OBSERVED_DATA_OPEN)
    const close = l2.indexOf(APP_OBSERVED_DATA_CLOSE)
    const divergence = l2.indexOf('Guarded replay verifier rejected procedure step 1')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(divergence).toBeGreaterThan(open)
    expect(l2).toContain('not done yet')
    expect(close).toBeGreaterThan(divergence)
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 1,
        total: 1,
        verifierRejection: { procedureStepIndex: 0 },
      },
      flow: { cursor: 0, length: 1 },
    })
    // Exhausted AND rejected — either alone forbids a carry.
    expect(flowCell.carry).toBeUndefined()
  })

  it('a verifier rejection aborts a multi-step flow with no carry — not just replay re-entry within the step', async () => {
    // F-381-51-1 · D-09 rewrite: the old law replayed BOTH body steps in one test step and
    // pinned the rejection of the second (fold 2/2, rejection at index 1, no in-step
    // re-entry). The new law rejects the FIRST body step at its own test step (per-step
    // fold 1/1, rejection at index 0) and strengthens the pin: the rejection kills the
    // whole flow — the carry cell stays empty, so no later step can resume the body.
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
    ])
    const verifier = makeVerifier([
      { success: false, reasoning: 'stored login did not complete', isAppError: false },
      { success: true, reasoning: 'live recovery completed', isAppError: false },
    ])

    const result = await executeStep(
      'Log in as the saved user',
      ports({
        adapter,
        planner: planner.planner,
        verifier,
        knowledgeReader: spy.reader,
        procedureFlow: flowCell,
      }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(planner.calls).toHaveLength(1)
    expect(executed).toMatchObject([
      { type: 'fill', ref: 'e1' },
      { type: 'click', ref: 'e1' },
    ])
    // The stored click (body step 1) never dispatched anywhere — its step was never earned.
    expect(executed.filter((action) => action.type === 'click' && action.ref === 'e2'))
      .toHaveLength(0)
    const l2 = planner.calls[0].l2 ?? ''
    expect(l2).toContain(APP_OBSERVED_DATA_OPEN)
    expect(l2).toContain('Guarded replay verifier rejected procedure step 1')
    expect(l2).toContain('stored login did not complete')
    expect(l2).toContain(APP_OBSERVED_DATA_CLOSE)
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 1,
        total: 1,
        verifierRejection: { procedureStepIndex: 0 },
      },
      flow: { cursor: 0, length: 2 },
    })
    expect(flowCell.carry).toBeUndefined()
  })

  it('Test 5a: an unbound reader leaves the loop behavior unchanged with no planSource', async () => {
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Click the Log in button',
      ports({ adapter, planner: planner.planner }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    expect(result.evidence?.planSource).toBeUndefined()
  })

  it('Test 5b: a hint-recommendation match triggers no replay and no read-body requirement failure', async () => {
    const spy = makeReader({ match: makeMatch({ replayRecommendation: 'hint' }), payload: undefined })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Click the Log in button',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(planner.calls).toHaveLength(1)
    // No replayed action — the planner drove the single click.
    expect(executed.map((action) => action.type)).toEqual(['click'])
  })

  it('Test 6: parameter values bind loop-side by NAME and never cross the reader port', async () => {
    const payload: ProcedureBodyPayload = {
      schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
      parameters: [
        { name: 'userEmail', type: 'string', required: true },
        { name: 'otpCode', type: 'string', required: true },
      ],
      steps: [
        {
          instruction: 'Fill the email field',
          action: {
            type: 'fill',
            targets: { ref: { role: 'textbox', nameNormalized: 'email', name: 'Email' } },
            values: { text: { param: 'userEmail' } },
          },
          guard: {
            target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
            pageAnchor: { t: 'page', route: 'https://example.test/login' },
          },
        },
        {
          instruction: 'Fill the one-time code',
          action: {
            type: 'fill',
            targets: { ref: { role: 'textbox', nameNormalized: 'code', name: 'Code' } },
            values: { text: { param: 'otpCode' } },
          },
          guard: {
            target: { role: 'textbox', nameNormalized: 'code', name: 'Code' },
            pageAnchor: { t: 'page', route: 'https://example.test/login' },
          },
        },
      ],
      successAssertion: 'Both fields are filled',
    }
    const spy = makeReader({
      match: makeMatch({
        parameterSchema: [
          { name: 'userEmail', type: 'string', required: true },
          { name: 'otpCode', type: 'string', required: true },
        ],
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([twoFieldScreen()])
    const planner = capturingPlanner([makeActionPlan()])
    // F-381-51-1 · D-09 rewrite: the old law bound both parameters inside one test step.
    // The new law binds each at its OWN test step — the carried body step re-runs the
    // loop-side binder against the same source-tagged availability contract, and the carry
    // substitutes the second consult entirely (one matcher call for the whole flow).
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const sharedPorts = () => ports({
      adapter,
      planner: planner.planner,
      knowledgeReader: spy.reader,
      workingMemory: makeWorkingMemory([{ key: 'otpCode', value: '123456' }]),
      procedureFlow: flowCell,
    })

    const step0 = await executeStep('Fill the email field', sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Fill the one-time code', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(spy.countOf('getProcedure')).toBe(1)
    expect(planner.calls).toHaveLength(0)
    const fills = executed as Extract<Action, { type: 'fill' }>[]
    expect(fills.map((action) => action.type)).toEqual(['fill', 'fill'])
    expect(fills[0].text).toBe('user@example.com')
    expect(fills[1].text).toBe('123456')
    expect(flowCell.carry).toBeUndefined()

    // Binding names + capability bits crossed the reader port; bound VALUES never did — in
    // any argument of any reader call.
    const getProcedureArgs = JSON.parse(
      spy.calls.find((call) => call.method === 'getProcedure')!.args,
    ) as [unknown, unknown, unknown]
    expect(getProcedureArgs[2]).toEqual({
      variables: [{ name: 'userEmail', canBindNumber: false, canBindBoolean: false }],
      memory: [{ name: 'otpCode', canBindNumber: true, canBindBoolean: false }],
      secrets: [],
    })
    for (const call of spy.calls) {
      expect(call.args).not.toContain('user@example.com')
      expect(call.args).not.toContain('123456')
    }
  })

  it('assembles capability bits from raw values through the shared law — values never cross', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'delay', type: 'number', required: true }],
      type: 'doubleClick',
      values: { clickDelay: { param: 'delay' } },
    })
    const match = makeMatch({
      parameterSchema: [{ name: 'delay', type: 'number', required: true }],
    })

    const recordedAvailability = async (delayRaw: string): Promise<{
      availability: unknown
      argsJson: string
    }> => {
      const spy = makeReader({ match, payload })
      const { adapter } = capturingAdapter([makeScreenState()])
      const planner = capturingPlanner([
        makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
      ])
      await executeStep(
        'Assemble availability from the raw delay',
        ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
        context({ variables: { delay: delayRaw } }),
      )
      const call = spy.calls.find((entry) => entry.method === 'getProcedure')!
      const args = JSON.parse(call.args) as [unknown, unknown, unknown]
      return { availability: args[2], argsJson: call.args }
    }

    // Seam agreement: the capability bit the matcher sees and the binder's verdict
    // are the same shared coercion evaluated on the same raw value.
    const incapable = await recordedAvailability('not-a-number')
    expect(incapable.availability).toEqual({
      variables: [{ name: 'delay', canBindNumber: false, canBindBoolean: false }],
      memory: [],
      secrets: [],
    })
    expect(incapable.argsJson).not.toContain('not-a-number')

    const capable = await recordedAvailability('250')
    expect(capable.availability).toEqual({
      variables: [{ name: 'delay', canBindNumber: true, canBindBoolean: false }],
      memory: [],
      secrets: [],
    })
    expect(JSON.stringify(capable.availability)).not.toContain('250')
  })

  it('falls through a type-invalid variable to a type-valid memory value (try-in-order)', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'delay', type: 'number', required: true }],
      type: 'doubleClick',
      values: { clickDelay: { param: 'delay' } },
    })
    const spy = makeReader({
      match: makeMatch({
        parameterSchema: [{ name: 'delay', type: 'number', required: true }],
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      'Rescue the delay from working memory',
      ports({
        adapter,
        planner: planner.planner,
        knowledgeReader: spy.reader,
        workingMemory: makeWorkingMemory([{ key: 'delay', value: '250' }]),
      }),
      context({ variables: { delay: 'not-a-number' } }),
    )

    // The binder takes the FIRST source whose value passes the shared coercion — a
    // type-invalid variable value falls through to the type-valid memory value instead of
    // hard-failing, exactly matching the matcher's per-source capability OR.
    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(0)
    expect(executed[0]).toMatchObject({ type: 'doubleClick', clickDelay: 250 })
  })

  it('reports a missing loop-side value as parameter-unbound, then plans with the demoted hint', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'missingEmail', type: 'string', required: true }],
      type: 'fill',
      target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
      values: { text: { param: 'missingEmail' } },
      instruction: 'Fill the missing email',
    })
    const spy = makeReader({
      match: makeMatch({
        parameterSchema: [{ name: 'missingEmail', type: 'string', required: true }],
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Continue after the unavailable email',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss location: parameter field=text; name=missingEmail')
    expect(learned).toContain('text <- parameter missingEmail (string, required)')
    expect(learned).toContain('variable sources: none')
    expect(learned).toContain('memory sources: none')
    expect(learned).toContain('secret sources: none')
    expect(learned).not.toContain('fresh same-role candidates:')
    expect(learned).not.toContain('Fill the missing email')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'parameter-unbound' },
      },
      flow: { cursor: 0, length: 1 },
    })
  })

  it('coerces a finite number parameter and rejects a non-number as parameter-unbound', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'delay', type: 'number', required: true }],
      type: 'doubleClick',
      values: { clickDelay: { param: 'delay' } },
    })
    const match = makeMatch({
      parameterSchema: [{ name: 'delay', type: 'number', required: true }],
    })

    const validSpy = makeReader({ match, payload })
    const validAdapter = capturingAdapter([makeScreenState()])
    const validPlanner = capturingPlanner([makeActionPlan()])
    const valid = await executeStep(
      'Double-click with a numeric delay',
      ports({
        adapter: validAdapter.adapter,
        planner: validPlanner.planner,
        knowledgeReader: validSpy.reader,
      }),
      context({ variables: { delay: '5' } }),
    )

    expect(valid.status).toBe('passed')
    expect(validPlanner.calls).toHaveLength(0)
    expect(validAdapter.executed[0]).toMatchObject({ type: 'doubleClick', clickDelay: 5 })
    expect(typeof (validAdapter.executed[0] as Extract<Action, { type: 'doubleClick' }>).clickDelay)
      .toBe('number')

    const invalidSpy = makeReader({ match, payload })
    const invalidAdapter = capturingAdapter([makeScreenState()])
    const invalidPlanner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const invalid = await executeStep(
      'Fall back when the delay is not numeric',
      ports({
        adapter: invalidAdapter.adapter,
        planner: invalidPlanner.planner,
        knowledgeReader: invalidSpy.reader,
      }),
      context({ variables: { delay: 'not-a-number' } }),
    )

    expect(invalid.status).toBe('passed')
    expect(invalidPlanner.calls).toHaveLength(1)
    expect(invalidAdapter.executed.map((action) => action.type)).toEqual(['click'])
    expect(invalid.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'parameter-unbound' } },
    })
  })

  it('maps strict boolean strings to booleans and rejects non-strict spellings', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'submitNow', type: 'boolean', required: true }],
      type: 'fill',
      target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
      values: { text: 'user@example.com', submit: { param: 'submitNow' } },
    })
    const match = makeMatch({
      parameterSchema: [{ name: 'submitNow', type: 'boolean', required: true }],
    })

    const validSpy = makeReader({ match, payload })
    const validAdapter = capturingAdapter([makeScreenState()])
    const validPlanner = capturingPlanner([makeActionPlan()])
    await executeStep(
      'Fill and submit using a strict boolean',
      ports({
        adapter: validAdapter.adapter,
        planner: validPlanner.planner,
        knowledgeReader: validSpy.reader,
      }),
      context({ variables: { submitNow: 'true' } }),
    )

    expect(validPlanner.calls).toHaveLength(0)
    expect(validAdapter.executed[0]).toMatchObject({ type: 'fill', submit: true })
    expect(typeof (validAdapter.executed[0] as Extract<Action, { type: 'fill' }>).submit)
      .toBe('boolean')

    const invalidSpy = makeReader({ match, payload })
    const invalidAdapter = capturingAdapter([makeScreenState()])
    const invalidPlanner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const invalid = await executeStep(
      'Reject a non-strict boolean spelling',
      ports({
        adapter: invalidAdapter.adapter,
        planner: invalidPlanner.planner,
        knowledgeReader: invalidSpy.reader,
      }),
      context({ variables: { submitNow: 'TRUE' } }),
    )

    expect(invalidPlanner.calls).toHaveLength(1)
    expect(invalidAdapter.executed.map((action) => action.type)).toEqual(['click'])
    expect(invalid.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'parameter-unbound' } },
    })
  })

  it.each([
    {
      type: 'number' as const,
      name: 'delay',
      secretValue: '5',
      payload: singleActionPayload({
        parameters: [{ name: 'delay', type: 'number', required: true }],
        type: 'doubleClick',
        values: { clickDelay: { param: 'delay' } },
      }),
    },
    {
      type: 'boolean' as const,
      name: 'submitNow',
      secretValue: 'true',
      payload: singleActionPayload({
        parameters: [{ name: 'submitNow', type: 'boolean', required: true }],
        type: 'fill',
        target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
        values: { text: 'user@example.com', submit: { param: 'submitNow' } },
      }),
    },
  ])('fails safe when a stale replay recommendation offers a secret-only $type', async ({
    type,
    name,
    secretValue,
    payload,
  }) => {
    const spy = makeReader({
      // Force the stale/over-admitted recommendation so this test exercises the independent
      // loop-side half of WR-01 even though the corrected matcher now downranks it to a hint.
      match: makeMatch({
        parameterSchema: [{ name, type, required: true }],
        replayRecommendation: 'replay',
      }),
      payload,
    })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      `Fall back from a secret-only ${type} binding`,
      ports({
        adapter,
        planner: planner.planner,
        knowledgeReader: spy.reader,
        secretStore: new SecretStore({ [name]: secretValue }),
      }),
      context({ variables: {} }),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain(`name=${name}`)
    expect(learned).toContain(`parameter ${name} (${type}, required)`)
    expect(learned).toContain(`secret sources: ${name}`)
    expect(learned).not.toContain('fresh same-role candidates:')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 0, reason: 'parameter-unbound' },
      },
      flow: { cursor: 0, length: 1 },
    })
  })

  it('binds a secret parameter only from the secret store, never from variables', async () => {
    const payload = singleActionPayload({
      parameters: [{ name: 'loginSecret', type: 'secret', required: true }],
      type: 'fill',
      target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
      values: { text: { param: 'loginSecret' } },
    })
    const match = makeMatch({
      parameterSchema: [{ name: 'loginSecret', type: 'secret', required: true }],
    })
    const variableOnlySpy = makeReader({ match, payload })
    const variableOnlyAdapter = capturingAdapter([makeScreenState()])
    const variableOnlyPlanner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const variableOnly = await executeStep(
      'Do not use a variable as a secret',
      ports({
        adapter: variableOnlyAdapter.adapter,
        planner: variableOnlyPlanner.planner,
        knowledgeReader: variableOnlySpy.reader,
      }),
      context({ variables: { loginSecret: 'variable-value' } }),
    )

    expect(variableOnlyPlanner.calls).toHaveLength(1)
    expect(variableOnlyAdapter.executed.map((action) => action.type)).toEqual(['click'])
    expect(variableOnly.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'parameter-unbound' } },
    })

    const storeSpy = makeReader({ match, payload })
    const storeAdapter = capturingAdapter([makeScreenState()])
    const storePlanner = capturingPlanner([makeActionPlan()])
    const storeBacked = await executeStep(
      'Use the provisioned secret',
      ports({
        adapter: storeAdapter.adapter,
        planner: storePlanner.planner,
        knowledgeReader: storeSpy.reader,
        secretStore: new SecretStore({ loginSecret: 'store-value' }),
      }),
      context({ variables: { loginSecret: 'variable-value' } }),
    )

    expect(storeBacked.status).toBe('passed')
    expect(storePlanner.calls).toHaveLength(0)
    expect(storeAdapter.executed[0]).toMatchObject({ type: 'fill', text: 'store-value' })
  })

  it('rejects a schema-invalid rebuilt action before it reaches the adapter', async () => {
    const payload = singleActionPayload({
      type: 'fill',
      target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
      values: { submit: true },
      instruction: 'Invalid fill missing its required text',
    })
    const spy = makeReader({ match: makeMatch({ parameterSchema: [] }), payload })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])

    const result = await executeStep(
      'Fall back from an invalid stored fill',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    expect(result.evidence?.planSource).toMatchObject({
      guard: { miss: { reason: 'non-replayable-action' } },
    })
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('miss location: action-schema')
    expect(learned).toContain('submit <- stored literal omitted')
    expect(learned).not.toContain('fresh same-role candidates:')
    expect(learned).not.toContain('Invalid fill missing its required text')
  })
})

// ---------------------------------------------------------------------------
// Task 2: planSource evidence + hint rendering through the ledger
// ---------------------------------------------------------------------------

function makeCacheSpy(hit: CachedPlanValue | null): { cache: ActionPlanCache; gets: () => number } {
  let gets = 0
  return {
    cache: {
      async get() { gets++; return hit },
      async set() {},
      async invalidate() {},
    },
    gets: () => gets,
  }
}

interface LedgerSpy {
  ledger: RecordLedger
  admits: ServingRecordMetadata[]
}

function makeLedgerSpy(admitted: boolean): LedgerSpy {
  const admits: ServingRecordMetadata[] = []
  const decision = admitted ? { admitted: true as const } : { admitted: false as const, reason: 'budget-cap' as const }
  return {
    admits,
    ledger: {
      inspect: () => decision,
      admit: (record) => { admits.push(record); return decision },
      resetTurn: () => {},
      size: () => 0,
      spent: () => 0,
    },
  }
}

describe('planSource evidence + ledger-metered hint rendering', () => {
  it('Test 1: replay planSource and cache-hit provenance never coexist on one step', async () => {
    // A replayed step: the cache is bound but never consulted; evidence carries the
    // procedure-replay planSource and no cache-hit fold.
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const { adapter } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])
    const cacheSpy = makeCacheSpy(null)

    const replayed = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: spy.reader, cache: cacheSpy.cache }),
      context(),
    )

    expect(replayed.status).toBe('passed')
    expect(replayed.evidence?.planSource?.kind).toBe('procedure-replay')
    expect(replayed.evidence?.cacheStatus).not.toBe('hit')
    expect(cacheSpy.gets()).toBe(0)

    // A cache-hit step (no procedure match): cacheStatus folds to hit and no planSource
    // is written — the two provenances never coexist.
    const noMatch = makeReader({ match: undefined, payload: undefined })
    const hit: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const hitCache = makeCacheSpy(hit)
    const { adapter: hitAdapter } = capturingAdapter([makeScreenState()])
    const hitPlanner = capturingPlanner([makeActionPlan()])

    const cachedStep = await executeStep(
      'Click the Log in button',
      ports({
        adapter: hitAdapter,
        planner: hitPlanner.planner,
        knowledgeReader: noMatch.reader,
        cache: hitCache.cache,
      }),
      context(),
    )

    expect(cachedStep.status).toBe('passed')
    expect(hitPlanner.calls).toHaveLength(0)
    expect(cachedStep.evidence?.cacheStatus).toBe('hit')
    expect(cachedStep.evidence?.planSource).toBeUndefined()
  })

  it('Test 2: a hint-mode match records planSource procedure-hint and renders DATA-wrapped under the hypotheses preamble with ledger admission', async () => {
    const spy = makeReader({ match: makeMatch({ replayRecommendation: 'hint' }), payload: loginPayload() })
    const { adapter } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])
    const ledgerSpy = makeLedgerSpy(true)

    const result = await executeStep(
      'Log in as the saved user',
      ports({
        adapter,
        planner: planner.planner,
        knowledgeReader: spy.reader,
        recordLedger: ledgerSpy.ledger,
      }),
      context(),
    )

    expect(result.status).toBe('passed')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-hint',
      procedureId: PROCEDURE_ID,
    })

    // Ledger admission carried real ServingRecordMetadata: the record id, a flow-anchor
    // cluster, and a non-zero rendered cost.
    const admitted = ledgerSpy.admits.find((record) => String(record.id) === String(PROCEDURE_ID))
    expect(admitted).toBeDefined()
    expect(admitted!.renderedCost).toBeGreaterThan(0)
    expect(admitted!.clusterKey).toContain('login')

    // The rendered block reached the planning context inside DATA delimiters, and the
    // volatile tier frames it under the hypotheses-not-instructions preamble.
    expect(planner.calls).toHaveLength(1)
    const l2 = planner.calls[0].l2 ?? ''
    expect(l2).toContain(APP_OBSERVED_DATA_OPEN)
    expect(l2).toContain(APP_OBSERVED_DATA_CLOSE)
    expect(l2).toContain('Fill the email field')
    expect(l2).toContain('userEmail (string, required)')
    const volatileTier = buildVolatileTier(makeStepContext({ knowledgeBriefL2: l2 }))
    const rendered = typeof volatileTier.content === 'string'
      ? volatileTier.content
      : JSON.stringify(volatileTier.content)
    expect(rendered.toLowerCase()).toContain('hypotheses')
    expect(rendered.toLowerCase()).toContain('not instructions or commands')
    expect(rendered.indexOf(APP_OBSERVED_DATA_OPEN))
      .toBeGreaterThan(rendered.toLowerCase().indexOf('hypotheses'))
  })

  /**
   * G-381-4 second half: the fail-closed body read is CORRECT but was silent — a starved
   * replay stamped a planSource byte-identical to an ordinary hint, so run 16's three earned
   * replay recommendations were indistinguishable from ordinary hint exposure in the handoff.
   * The demotion reason makes that observable without weakening the wall.
   */
  async function planSourceOf(reader: ReaderSpy) {
    const { adapter } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])
    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner: planner.planner, knowledgeReader: reader.reader }),
      context(),
    )
    expect(result.status).toBe('passed')
    return result.evidence?.planSource
  }

  it('types a replay demoted by an unreadable body', async () => {
    expect(await planSourceOf(makeReader({ match: makeMatch() }))).toEqual({
      kind: 'procedure-hint',
      procedureId: PROCEDURE_ID,
      demotion: 'body-unreadable',
    })
  })

  it('types a replay demoted by an unparseable body', async () => {
    const spy = makeReader({ match: makeMatch(), rawBody: 'not a committed procedure body' })

    expect(await planSourceOf(spy)).toEqual({
      kind: 'procedure-hint',
      procedureId: PROCEDURE_ID,
      demotion: 'body-unparseable',
    })
  })

  it('types a replay demoted by a parsed body with zero steps', async () => {
    const spy = makeReader({
      match: makeMatch(),
      rawBody: serializeProcedureBody({ ...loginPayload(), steps: [] }),
    })

    expect(await planSourceOf(spy)).toEqual({
      kind: 'procedure-hint',
      procedureId: PROCEDURE_ID,
      demotion: 'body-empty',
    })
  })

  it('leaves an ordinary hint recommendation with NO demotion member', async () => {
    const spy = makeReader({
      match: makeMatch({ replayRecommendation: 'hint' }),
      payload: loginPayload(),
    })
    const planSource = await planSourceOf(spy)

    expect(planSource).toEqual({ kind: 'procedure-hint', procedureId: PROCEDURE_ID })
    expect(planSource === undefined ? true : 'demotion' in planSource).toBe(false)
  })

  it('Test 3: a ledger refusal drops the hint fail-closed and the step still plans normally', async () => {
    const spy = makeReader({ match: makeMatch({ replayRecommendation: 'hint' }), payload: loginPayload() })
    const { adapter, executed } = capturingAdapter([makeScreenState()])
    const planner = capturingPlanner([makeActionPlan()])
    const ledgerSpy = makeLedgerSpy(false)

    const result = await executeStep(
      'Log in as the saved user',
      ports({
        adapter,
        planner: planner.planner,
        knowledgeReader: spy.reader,
        recordLedger: ledgerSpy.ledger,
      }),
      context(),
    )

    // The refusal drops the block, never the turn: the step plans and passes normally.
    expect(result.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    expect(executed.map((action) => action.type)).toEqual(['click'])
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).not.toContain(APP_OBSERVED_DATA_OPEN)
    expect(learned).not.toContain('Fill the email field')
    // Never rendered ⇒ no served-hint exposure is claimed in evidence.
    expect(result.evidence?.planSource).toBeUndefined()
  })

  it('Test 4: post-miss recovery evidence renders in the SAME hypotheses frame', async () => {
    // F-381-51-1 · D-09 rewrite: the old law surfaced the miss inside one test step. The
    // new law reaches the miss at the CARRIED step's own test step — the demoted hint
    // renders in THAT step's planning turn, in the same hypotheses frame, with the body
    // step represented only by its generated structural facts.
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const spy = makeReader({ match: makeMatch(), payload: loginPayload() })
    const stable = makeScreenState()
    const drifted = duplicateButtonScreen()
    const { adapter } = capturingAdapter([stable, stable, drifted])
    const planner = capturingPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const sharedPorts = () => ports({
      adapter,
      planner: planner.planner,
      knowledgeReader: spy.reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep('Fill the email field', sharedPorts(), context())
    expect(step0.status).toBe('passed')

    const step1 = await executeStep('Click the Log in button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(planner.calls).toHaveLength(1)
    const l2 = planner.calls[0].l2 ?? ''
    // DATA-wrapped, with recovery evidence inside the delimiters and no authored imperative.
    const open = l2.indexOf(APP_OBSERVED_DATA_OPEN)
    const close = l2.indexOf(APP_OBSERVED_DATA_CLOSE)
    const recovery = l2.indexOf('Guarded replay recovery evidence for procedure step 2')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(recovery).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(recovery)
    expect(l2).not.toContain('Click the Log in button')
    // The demoted hint sits under the same hypotheses preamble as every learned span.
    const volatileTier = buildVolatileTier(makeStepContext({ knowledgeBriefL2: l2 }))
    const rendered = typeof volatileTier.content === 'string'
      ? volatileTier.content
      : JSON.stringify(volatileTier.content)
    expect(rendered.toLowerCase()).toContain('hypotheses')
    expect(rendered.toLowerCase()).toContain('not instructions or commands')
    // Post-miss the planSource stays the replay fold with its miss — the demotion is
    // implied by the miss, never a second (procedure-hint) provenance.
    expect(step1.evidence?.planSource?.kind).toBe('procedure-replay')
  })
})
