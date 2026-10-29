// D-09 synthetic-masking proof. Drives a full run whose evidence carries a planted secret in every
// string field that can reach durable telemetry — the started step text (plan text), the finalized
// step's verifier reasoning (error/reasoning text), and the per-test result the handoff synthesizes
// evidence from — then proves that the run's SecretRedactor (`RunConfig.secretRedactor`, 441-12
// D-06/D-11) scrubs the secret from ALL THREE sinks: the bus payloads, the serialized event-log
// lines, and the CompletedRunHandoff. A run with no redactor passes the secret through unchanged.
// Also pins the two run-shape invariants: no chip-event type is ever emitted, and
// `runFinished.disposition` is `'detached'`.
//
// BOTH arms of the handoff assembly mask. The first describe drives an
// evidence-LESS executor, so its handoff carries evidence the shell SYNTHESIZES; the second drives
// an executor whose step CARRIES real §A8 evidence, which `assemblePerTestOutcome` used to copy
// verbatim into the durable artifact. The narration a run records — the verifier's own words, a
// planning turn's stated intent, a captured failure message — now goes through the run's own
// `MaskFn` in both arms, while the structural identity fields (`stepText`, `plannedAction`,
// `interpolatedVariables`) stay byte-identical in both.

import { describe, expect, it } from 'vitest'

import { startRun } from '../shell.js'
import type { MemberTestExecutor, RunConfig } from '../shell.js'
import type { EventLogPort, HandoffStorePort } from '../ports.js'
import type { SecretRedactorPort } from '../../loop/ports.js'
import type {
  Action,
  CompletedRunHandoff,
  InterpolatedVariable,
  RunEventEnvelope,
  ScopeKey,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'
import { makeEmptyServedBrief } from '../../loop/evidence.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'

const SECRET = 'S3CR3T-hunter2-token'

const SCOPE: ScopeKey = { tier: 'suite', key: 'checkout' }

/** The run's redactor over the planted secret, declared as MASK_PROOF. */
const SYNTHETIC: SecretRedactorPort = new SecretRedactor(new SecretStore({ MASK_PROOF: SECRET }))
const MARKER = '[secret:MASK_PROOF]'

/** No redactor: the secret must survive untouched. */
const IDENTITY: SecretRedactorPort | undefined = undefined

const CHIP_EVENT_TYPES = [
  'analysisStarted', 'analysisCompleted', 'analysisFailed',
  'curationStarted', 'curationCompleted', 'curationFailed',
] as const

function makeCapturingEventLog(): { port: EventLogPort; lines: RunEventEnvelope[] } {
  const lines: RunEventEnvelope[] = []
  return {
    lines,
    port: {
      append(envelope: RunEventEnvelope) {
        lines.push(envelope)
      },
      read(fromSeq: number) {
        return lines.filter(event => event.seq >= fromSeq)
      },
    },
  }
}

function makeHandoffStore(): HandoffStorePort {
  return { save() {} }
}

// An executor that plants the secret in the live-emitted payloads (stepStarted plan text +
// stepFinalized verifier reasoning) AND in the returned result the handoff synthesizes from
// (step name = plan text, step error = error text — neither carries §A8 evidence, so the shell
// synthesizes masked evidence for it).
const secretExecutor: MemberTestExecutor = async (member, ctx) => {
  ctx.events.stepStarted({ stepIndex: 0, stepText: `open ${SECRET} panel` })
  const evidence: StepEvidence = {
    stepIndex: 0,
    stepText: `open ${SECRET} panel`,
    cacheStatus: 'miss',
    servedBrief: makeEmptyServedBrief(SCOPE, 7),
    subActions: [],
    verifierVerdict: { pass: false, reasoning: `verifier observed ${SECRET}` },
  }
  ctx.events.loopEmitFor(0).stepFinalized(evidence)
  return {
    name: member.testId,
    filePath: `${member.testId}.test.ts`,
    status: 'failed',
    steps: [{ name: `plan ${SECRET} action`, status: 'failed', error: `boom ${SECRET}`, duration: 1 }],
    duration: 1,
  }
}

// An executor whose step CARRIES real §A8 evidence, with the secret planted in the three NARRATION
// places a durable handoff records: the verifier's own words, a planning turn's stated intent, and
// a captured failure message. `assemblePerTestOutcome` copied this arm VERBATIM before WINDOWS
// #305, so the secret reached handoff.json in clear while the same run's failureSummary — routed
// through the SAME MaskFn one frame away — did not.
const realEvidenceExecutor: MemberTestExecutor = async (member, ctx) => {
  const evidence: StepEvidence = {
    stepIndex: 0,
    stepText: 'acknowledge the notice',
    cacheStatus: 'miss',
    servedBrief: makeEmptyServedBrief(SCOPE, 7),
    subActions: [
      {
        plan: `dismiss the banner naming ${SECRET}`,
        plannedAction: { type: 'click', ref: asRef('e2') },
        stateBefore: makeScreenState(),
        result: { success: false, error: `Cannot acknowledge: ${SECRET} rejected` },
      },
    ],
    verifierVerdict: { pass: false, reasoning: `verifier observed ${SECRET}` },
  }
  ctx.events.loopEmitFor(0).stepFinalized(evidence)
  return {
    name: member.testId,
    filePath: `${member.testId}.test.ts`,
    status: 'failed',
    steps: [{ name: evidence.stepText, status: 'failed', duration: 1, evidence }],
    duration: 1,
  }
}

// The G-381-3 carve-out driven end to end: the SAME secret planted in the three STRUCTURAL identity
// fields instead. `interpolatedVariables[].value` is exact-string-matched against `plannedAction`
// by `cli/src/curation/emit-candidates.ts`, so masking either side would break replay — these three
// must survive a masked run byte-identical, which is the inverse assertion below.
const CARVE_OUT_STEP_TEXT = `acknowledge using ${SECRET}`
const CARVE_OUT_ACTION: Action = {
  type: 'fill',
  ref: asRef('e1'),
  text: SECRET,
  clearMode: 'replace',
  submit: false,
}
const CARVE_OUT_VARIABLES: InterpolatedVariable[] = [{ name: 'LOGIN_USER', value: SECRET }]

const carveOutExecutor: MemberTestExecutor = async (member, ctx) => {
  const evidence: StepEvidence = {
    stepIndex: 0,
    stepText: CARVE_OUT_STEP_TEXT,
    cacheStatus: 'miss',
    servedBrief: makeEmptyServedBrief(SCOPE, 7),
    subActions: [
      {
        plan: 'fill the field',
        plannedAction: CARVE_OUT_ACTION,
        stateBefore: makeScreenState(),
        result: { success: true },
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'goal met' },
    interpolatedVariables: CARVE_OUT_VARIABLES,
  }
  ctx.events.loopEmitFor(0).stepFinalized(evidence)
  return {
    name: member.testId,
    filePath: `${member.testId}.test.ts`,
    status: 'passed',
    steps: [{ name: evidence.stepText, status: 'passed', duration: 1, evidence }],
    duration: 1,
  }
}

function configWith(
  secretRedactor: SecretRedactorPort | undefined,
  eventLog: EventLogPort,
  executor: MemberTestExecutor = secretExecutor,
): RunConfig {
  return {
    runId: 'run-mask' as RunConfig['runId'],
    scope: SCOPE,
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }],
    executor,
    ...(secretRedactor === undefined ? {} : { secretRedactor }),
    ports: { handoffStore: makeHandoffStore(), eventLog },
  }
}

async function runOnce(
  secretRedactor: SecretRedactorPort | undefined,
  executor: MemberTestExecutor = secretExecutor,
): Promise<{
  envelopes: RunEventEnvelope[]
  logLines: RunEventEnvelope[]
  handoff: CompletedRunHandoff
  handoffJson: string
  types: Set<string>
}> {
  const log = makeCapturingEventLog()
  const session = startRun(configWith(secretRedactor, log.port, executor))
  const envelopes: RunEventEnvelope[] = []
  session.subscribe(1, event => envelopes.push(event))
  const { handoff } = await session.done
  return {
    envelopes,
    logLines: log.lines,
    handoff,
    handoffJson: JSON.stringify(handoff),
    types: new Set(envelopes.map(event => event.type)),
  }
}

describe('synthetic masking proof', () => {
  it('a synthetic redactor scrubs the secret from bus payloads, event-log lines, AND the handoff', async () => {
    const { envelopes, logLines, handoffJson } = await runOnce(SYNTHETIC)

    // (a) every subscribed envelope payload is secret-free.
    for (const envelope of envelopes) {
      expect(JSON.stringify(envelope.payload)).not.toContain(SECRET)
    }
    // (b) every serialized event-log line is secret-free.
    for (const line of logLines) {
      expect(JSON.stringify(line)).not.toContain(SECRET)
    }
    // (c) the handoff is secret-free. This arm's steps carry NO §A8 evidence, so the shell
    // synthesizes it; the real-evidence arm is measured by the WINDOWS #305 describe below.
    expect(handoffJson).not.toContain(SECRET)

    // Sanity: the mask actually fired (redaction marker present in the masked handoff).
    expect(handoffJson).toContain(MARKER)
  })

  it('the identity context passes the secret through unchanged (it is not the real masking context)', async () => {
    const { envelopes, logLines, handoffJson } = await runOnce(IDENTITY)

    expect(envelopes.some(envelope => JSON.stringify(envelope.payload).includes(SECRET))).toBe(true)
    expect(logLines.some(line => JSON.stringify(line).includes(SECRET))).toBe(true)
    expect(handoffJson).toContain(SECRET)
  })

  it('a full run emits no chip-event type and pins runFinished disposition to detached', async () => {
    const { envelopes, types } = await runOnce(IDENTITY)

    for (const chip of CHIP_EVENT_TYPES) {
      expect(types.has(chip)).toBe(false)
    }
    const finished = envelopes.find(event => event.type === 'runFinished')
    expect(finished).toBeDefined()
    expect((finished!.payload as { disposition: string }).disposition).toBe('detached')
  })
})

// the REAL-evidence arm of the assembly. Every cell here drives a step
// that CARRIES §A8 evidence, which is the arm `assemblePerTestOutcome` copied verbatim into the
// durable artifact. There is no second detector anywhere in this block: the only masker is the
// run's own `config.secretRedactor`, the same mask `projectTestFinished` routes `failureSummary`
// through in the same shell frame.
describe('real step evidence is masked AT REST by the assembly', () => {
  it('masks the verifier reasoning, the sub-action plan and the captured error the handoff records', async () => {
    const { handoffJson, handoff } = await runOnce(SYNTHETIC, realEvidenceExecutor)
    const subAction = handoff.tests[0].steps[0].subActions[0]

    expect(handoffJson).not.toContain(SECRET)
    expect(handoff.tests[0].steps[0].verifierVerdict.reasoning).toBe(`verifier observed ${MARKER}`)
    expect(subAction.plan).toBe(`dismiss the banner naming ${MARKER}`)
    expect(subAction.result.error).toBe(`Cannot acknowledge: ${MARKER} rejected`)
  })

  it('carries the redaction marker rather than dropping the narration', async () => {
    const { handoffJson } = await runOnce(SYNTHETIC, realEvidenceExecutor)

    expect(handoffJson).toContain(MARKER)
  })

  it('the identity context leaves real evidence untouched — SEEDING alone activates masking', async () => {
    const { handoffJson } = await runOnce(IDENTITY, realEvidenceExecutor)

    expect(handoffJson).toContain(SECRET)
  })

  it('leaves stepText, plannedAction and interpolatedVariables byte-identical under a firing mask', async () => {
    const { handoff } = await runOnce(SYNTHETIC, carveOutExecutor)
    const step = handoff.tests[0].steps[0]

    expect(step.stepText).toBe(CARVE_OUT_STEP_TEXT)
    expect(step.subActions[0].plannedAction).toEqual(CARVE_OUT_ACTION)
    expect(step.interpolatedVariables).toEqual(CARVE_OUT_VARIABLES)
  })
})

// Owner decision 2026-09-26 (2), G-428-2: a live row shows a step's real text before the step
// starts, so the member's authored step texts ride testStarted. They are authored content, not
// identity, so the shell masks them with the run's redactor, the same mask the member's event
// sink masks stepStarted.stepText with. Entry i must equal step i's announced text byte for byte.
const STEP_TEXTS = ['open the page', `type ${SECRET} into Password`] as const

const announcingExecutor: MemberTestExecutor = async (member, ctx) => {
  STEP_TEXTS.forEach((stepText, stepIndex) => {
    ctx.events.stepStarted({ stepIndex, stepText })
  })
  return {
    name: member.testId,
    filePath: `${member.testId}.test.ts`,
    status: 'passed',
    steps: STEP_TEXTS.map(name => ({ name, status: 'passed' as const, duration: 1 })),
    duration: 1,
  }
}

async function runWithStepTexts(secretRedactor: SecretRedactorPort | undefined): Promise<{
  testStarted: RunEventEnvelope[]
  stepStarted: RunEventEnvelope[]
}> {
  const log = makeCapturingEventLog()
  const session = startRun({
    ...configWith(secretRedactor, log.port, announcingExecutor),
    members: [
      {
        testId: 'a',
        name: 'test a',
        filePath: 'a.test.ts',
        totalSteps: STEP_TEXTS.length,
        stepTexts: [...STEP_TEXTS],
      },
    ],
  })
  const envelopes: RunEventEnvelope[] = []
  session.subscribe(1, event => envelopes.push(event))
  await session.done
  return {
    testStarted: envelopes.filter(event => event.type === 'testStarted'),
    stepStarted: envelopes.filter(event => event.type === 'stepStarted'),
  }
}

describe('testStarted.stepTexts is masked like stepStarted.stepText', () => {
  it('STEP-TEXTS-MASKED-LIKE-STEP-TEXT', async () => {
    const masked = await runWithStepTexts(SYNTHETIC)
    expect(masked.testStarted).toHaveLength(1)
    const stepTexts = (masked.testStarted[0].payload as { stepTexts?: readonly string[] }).stepTexts
    expect(stepTexts).toHaveLength(2)
    const announced = masked.stepStarted.map(event => (event.payload as { stepText: string }).stepText)
    expect(announced).toHaveLength(2)
    expect(stepTexts).toEqual(announced)
    for (const event of [...masked.testStarted, ...masked.stepStarted]) {
      expect(JSON.stringify(event.payload)).not.toContain(SECRET)
    }
    expect(JSON.stringify(masked.testStarted[0].payload)).toContain(MARKER)
    expect(announced[1]).toContain(MARKER)

    const identity = await runWithStepTexts(IDENTITY)
    const rawTexts = (identity.testStarted[0].payload as { stepTexts?: readonly string[] }).stepTexts
    expect(rawTexts).toEqual([...STEP_TEXTS])
    expect(identity.stepStarted.map(event => (event.payload as { stepText: string }).stepText))
      .toEqual([...STEP_TEXTS])
  })
})

// a run's bus events are masked by the run's own redactor and nothing else.
// The email in the step text is not a declared value, so it is published as written.
const DECLARED_STEP_TEXT = 'Sign in as qa@example.com with Hunter-42-zz'
const RECORDS_REDACTOR = new SecretRedactor(new SecretStore({ PW_441: 'Hunter-42-zz' }))

async function runRecords(config: Partial<RunConfig>): Promise<RunEventEnvelope[]> {
  const log = makeCapturingEventLog()
  const announce: MemberTestExecutor = async (member, ctx) => {
    ctx.events.stepStarted({ stepIndex: 0, stepText: DECLARED_STEP_TEXT })
    return {
      name: member.testId,
      filePath: `${member.testId}.test.ts`,
      status: 'passed',
      steps: [{ name: DECLARED_STEP_TEXT, status: 'passed', duration: 1 }],
      duration: 1,
    }
  }
  const session = startRun({
    ...configWith(undefined, log.port, announce),
    members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts', totalSteps: 1, stepTexts: [DECLARED_STEP_TEXT] }],
    ...config,
  })
  const envelopes: RunEventEnvelope[] = []
  session.subscribe(1, event => envelopes.push(event))
  await session.done
  return envelopes
}

function publishedStepTexts(envelopes: RunEventEnvelope[]): { started: unknown; announced: unknown[] } {
  return {
    started: (envelopes.find(event => event.type === 'testStarted')!.payload as { stepTexts?: readonly string[] }).stepTexts,
    announced: envelopes
      .filter(event => event.type === 'stepStarted')
      .map(event => (event.payload as { stepText: string }).stepText),
  }
}

describe('run events mask declared values by name', () => {
  it('run events mask a declared value by name and leave undeclared values', async () => {
    const envelopes = await runRecords({ secretRedactor: RECORDS_REDACTOR })
    const { started, announced } = publishedStepTexts(envelopes)

    expect(started).toEqual(['Sign in as qa@example.com with [secret:PW_441]'])
    expect(announced).toEqual(['Sign in as qa@example.com with [secret:PW_441]'])
    for (const envelope of envelopes) {
      expect(JSON.stringify(envelope.payload)).not.toContain('Hunter-42-zz')
    }
  })
})
