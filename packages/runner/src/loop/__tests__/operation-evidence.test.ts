import { describe, expect, it } from 'vitest'
import { APP_OBSERVED_DATA_CLOSE, APP_OBSERVED_DATA_OPEN } from '@vostride/agent-qa-safety'
import type {
  DownloadEvidence,
  OperationEvidence,
  StepEvidence,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import {
  CLIPBOARD_TEXT_LIMIT,
  CLIPBOARD_TRUNCATION_MARKER,
  readClipboardMeta,
  readDownloadMeta,
} from '../../compound/metadata.js'
import { executeStep } from '../index.js'
import type { LoopEventEmitPort, LoopPorts } from '../ports.js'
import { buildVerificationPrompt, composeTurnMessages, renderOperationEvidence } from '../prompts.js'
import { renderStepRecord, type VerifierStepRecord } from '../step-record.js'
import type { ActionPlan, Planner, StepContext, Verifier } from '../types.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeActionPlan, makeAdapter, makeStepContext } from './loop-harness.js'

const REPORT: DownloadEvidence = {
  suggestedFilename: 'report-secret.csv',
  extension: '.csv',
  size: 18,
  sha256: 'a'.repeat(64),
  state: 'completed',
}

const secretRedactor = new SecretRedactor(new SecretStore({ MASKED_WORD: 'secret' }))

function scriptedPlanner(plans: ActionPlan[], contexts: StepContext[]): Planner {
  let call = 0
  return {
    async plan(_step, _screen, context) {
      contexts.push({ ...context, subActionHistory: [...(context.subActionHistory ?? [])] })
      const plan = plans[Math.min(call, plans.length - 1)]!
      call++
      return { plan }
    },
  }
}

const passingVerifier: Verifier = {
  async verify(step, _before, after, action) {
    return {
      verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'Requested outcome observed' }),
    }
  },
}

function recordingEvents(recorded: SubActionEvidence[]): LoopEventEmitPort {
  return {
    stepFinalized() {},
    subActionRecorded(evidence) { recorded.push(structuredClone(evidence)) },
  }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return { plannerConfig: { maxActions: 20, maxPlanningTurns: 20, previousStepCount: 0 }, secretRedactor, ...overrides }
}

function twoClicks(): ActionPlan[] {
  return [
    makeActionPlan({ reasoning: 'Export the report', action: { type: 'click', ref: 'e1' }, stepComplete: false }),
    makeActionPlan({ reasoning: 'Confirm the export', action: { type: 'click', ref: 'e1' }, stepComplete: true }),
  ]
}

async function runDownloadStep(first: ActionResult, verifier: Verifier = passingVerifier): Promise<{
  evidence: StepEvidence
  emitted: SubActionEvidence[]
  contexts: StepContext[]
  status: string
}> {
  const contexts: StepContext[] = []
  const emitted: SubActionEvidence[] = []
  const result = await executeStep(
    'Export the report',
    ports({
      adapter: makeAdapter({ executeResults: [first, { success: true }] }),
      planner: scriptedPlanner(twoClicks(), contexts),
      verifier,
      events: recordingEvents(emitted),
    }),
    makeStepContext({ stepInstruction: 'Export the report' }),
  )
  return { evidence: result.evidence!, emitted, contexts, status: result.status }
}

describe('download evidence on the sub-action and in the history', () => {
  it('the sub-action carries masked download evidence and the recorded result no longer carries the metadata key', async () => {
    const { evidence, emitted, status } = await runDownloadStep({
      success: true,
      metadata: { download: [REPORT], keep: 'me' },
    })

    expect(status).toBe('passed')
    const [first, second] = evidence.subActions
    expect(first!.operationEvidence).toEqual({
      downloads: [{ ...REPORT, suggestedFilename: 'report-[secret:MASKED_WORD].csv' }],
    })
    expect(first!.result.metadata).toEqual({ keep: 'me' })
    expect(second).not.toHaveProperty('operationEvidence')
    expect(emitted[0]!.operationEvidence?.downloads?.[0]?.suggestedFilename).toBe('report-[secret:MASKED_WORD].csv')
    expect(emitted[0]!.result.metadata).not.toHaveProperty('download')
    expect(JSON.stringify(evidence)).not.toContain('report-secret')
  })

  it('a download-only metadata block leaves no metadata on the recorded result', async () => {
    const { evidence } = await runDownloadStep({ success: true, metadata: { download: [REPORT] } })
    expect(evidence.subActions[0]!.result).not.toHaveProperty('metadata')
  })

  it('the history renders one wrapped Operation evidence line', async () => {
    const { contexts } = await runDownloadStep({ success: true, metadata: { download: [REPORT] } })

    const history = contexts[1]!.subActionHistory!
    expect(history).toHaveLength(1)
    expect(history[0]!.evidence).toBe([
      APP_OBSERVED_DATA_OPEN,
      `Download "report-[secret:MASKED_WORD].csv" (.csv): completed, 18 bytes, sha256 ${'a'.repeat(64)}`,
      APP_OBSERVED_DATA_CLOSE,
    ].join('\n'))

    const turn = composeTurnMessages(contexts[1]!, makeScreenState())
      .map((message) => String(message.content))
      .join('\n')
    const lines = turn.split('\n').filter((line) => line.startsWith('    Operation evidence: '))
    expect(lines).toEqual([`    Operation evidence: ${APP_OBSERVED_DATA_OPEN}`])
  })

  it('no evidence means no line and no key', async () => {
    const { evidence, contexts } = await runDownloadStep({ success: true })

    expect(evidence.subActions.every((sub) => !('operationEvidence' in sub))).toBe(true)
    expect(contexts[1]!.subActionHistory![0]).not.toHaveProperty('evidence')
    const turn = composeTurnMessages(contexts[1]!, makeScreenState())
      .map((message) => String(message.content))
      .join('\n')
    expect(turn).not.toContain('Operation evidence')
  })

  it('a failed, canceled or unfinished download is rendered as such, never as completed', async () => {
    const failed: OperationEvidence = {
      downloads: [
        { suggestedFilename: 'a.zip', extension: '.zip', state: 'failed', failure: 'Network error' },
        { suggestedFilename: 'b', extension: '', state: 'canceled', failure: 'canceled' },
        { suggestedFilename: 'c.iso', extension: '.iso', state: 'unfinished' },
      ],
    }
    const { evidence, contexts } = await runDownloadStep({ success: true, metadata: { download: failed.downloads } })

    expect(evidence.subActions[0]!.operationEvidence).toEqual(failed)
    const rendered = contexts[1]!.subActionHistory![0]!.evidence!
    expect(rendered).toContain('Download "a.zip" (.zip): failed: Network error')
    expect(rendered).toContain('Download "b" (no extension): canceled: canceled')
    expect(rendered).toContain('Download "c.iso" (.iso): unfinished, not finished within the time limit')
    expect(rendered).not.toContain('completed')
  })

  it('readDownloadMeta keeps well-formed entries in order and drops the rest', () => {
    expect(readDownloadMeta({ metadata: { download: 'report.csv' } })).toBeUndefined()
    expect(readDownloadMeta({ metadata: {} })).toBeUndefined()
    expect(readDownloadMeta({
      metadata: {
        download: [
          REPORT,
          { suggestedFilename: 'x.csv', extension: '.csv', state: 'completed' },
          { suggestedFilename: 'y.csv', extension: '.csv', state: 'downloaded' },
          { suggestedFilename: 'z.csv', extension: '.csv', state: 'unfinished', path: '/tmp/z' },
        ],
      },
    })).toEqual([REPORT, { suggestedFilename: 'z.csv', extension: '.csv', state: 'unfinished' }])
  })
})

const SECOND: DownloadEvidence = {
  suggestedFilename: 'invoice.pdf',
  extension: '.pdf',
  size: 2048,
  sha256: 'b'.repeat(64),
  state: 'completed',
}

function recordingVerifier(calls: unknown[][], pass: boolean): Verifier {
  return {
    async verify(...args: Parameters<Verifier['verify']>) {
      calls.push(args)
      const [step, , after, action] = args
      const reasoning = pass ? 'Requested outcome observed' : 'The requested download is not evidenced'
      return { verification: scriptedVerification({ step, after, action, pass, reasoning }) }
    },
  }
}

function withSupport(adapter: PlatformAdapter, support: PlatformAdapter['operationCaptureSupport']): PlatformAdapter {
  return Object.assign(adapter, { operationCaptureSupport: support })
}

async function runWith(adapter: PlatformAdapter, verifier: Verifier, maxActions = 20) {
  return executeStep(
    'Export the report',
    ports({
      adapter,
      planner: scriptedPlanner(twoClicks(), []),
      verifier,
      plannerConfig: { maxActions, maxPlanningTurns: 20, previousStepCount: 0 },
    }),
    makeStepContext({ stepInstruction: 'Export the report' }),
  )
}

describe('operation evidence in verifier input, and capture availability', () => {
  it("the verifier receives the step's accumulated operation evidence", async () => {
    const calls: unknown[][] = []
    const adapter = makeAdapter({
      executeResults: [
        { success: true, metadata: { download: [REPORT] } },
        { success: true, metadata: { download: [SECOND] } },
      ],
    })
    const result = await runWith(adapter, recordingVerifier(calls, true))

    expect(result.status).toBe('passed')
    expect(calls).toHaveLength(1)
    expect(calls[0]![9]).toEqual({
      downloads: [{ ...REPORT, suggestedFilename: 'report-[secret:MASKED_WORD].csv' }, SECOND],
    })
    const record = calls[0]![10] as VerifierStepRecord
    expect(renderStepRecord(record).operationEvidence.split('\n')).toEqual([
      `action 1: ${renderOperationEvidence({ downloads: [{ ...REPORT, suggestedFilename: 'report-[secret:MASKED_WORD].csv' }] })}`,
      `action 2: ${renderOperationEvidence({ downloads: [SECOND] })}`,
    ])
  })

  it('a step with no operation evidence passes no operation evidence to the verifier', async () => {
    const calls: unknown[][] = []
    await runWith(makeAdapter(), recordingVerifier(calls, true))
    expect(calls[0]).toHaveLength(11)
    expect(calls[0]![9]).toBeUndefined()
    expect((calls[0]![10] as VerifierStepRecord).actions).toHaveLength(2)
  })

  it('buildVerificationPrompt renders an Operation evidence section only when evidence exists', () => {
    const screen = makeScreenState()
    const action: Action = { type: 'click', ref: 'e1' } as Action
    const evidence: OperationEvidence = { downloads: [SECOND] }
    const without = buildVerificationPrompt('Export the report', screen, screen, action)
    const withNone = buildVerificationPrompt('Export the report', screen, screen, action, false, undefined, undefined, undefined, undefined)
    const withEvidence = buildVerificationPrompt('Export the report', screen, screen, action, false, undefined, undefined, undefined, evidence)

    expect(withNone).toBe(without)
    expect(without).not.toContain('Operation evidence')
    expect(withEvidence.startsWith(without)).toBe(true)
    expect(withEvidence.slice(without.length)).toBe(['',
      '',
      'Operation evidence from the actions taken in this step:',
      APP_OBSERVED_DATA_OPEN,
      renderOperationEvidence(evidence),
      APP_OBSERVED_DATA_CLOSE,
    ].join('\n'))
  })

  it('an adapter without capture support records operationCapture unavailable with its reason', async () => {
    const plain = await runWith(makeAdapter(), recordingVerifier([], true))
    expect(plain.evidence!.operationCapture).toEqual({
      download: 'unavailable',
      clipboard: 'unavailable',
      reason: 'platform',
    })

    for (const browser of ['firefox', 'webkit']) {
      const unsupported = withSupport(makeAdapter(), { download: false, clipboard: false, reason: browser })
      const result = await runWith(unsupported, recordingVerifier([], true))
      expect(result.evidence!.operationCapture).toEqual({
        download: 'unavailable',
        clipboard: 'unavailable',
        reason: browser,
      })
    }
  })

  it('a Chromium web adapter records both captures available', async () => {
    const chromium = withSupport(makeAdapter(), { download: true, clipboard: true })
    const result = await runWith(chromium, recordingVerifier([], true))
    expect(result.evidence!.operationCapture).toEqual({ download: 'available', clipboard: 'available' })
  })

  it('unavailable evidence never makes a step pass', async () => {
    const calls: unknown[][] = []
    const result = await runWith(makeAdapter(), recordingVerifier(calls, false), 4)

    expect(result.status).not.toBe('passed')
    expect(result.evidence!.operationCapture?.download).toBe('unavailable')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((args) => args[9] === undefined)).toBe(true)
    expect(result.evidence!.verifierVerdict.pass).toBe(false)
  })
})

// The adapter hands over raw clipboard text; the loop masks it, then bounds it.
describe('clipboard capture recorded by the loop', () => {
  const LONG = 'secret ' + 'x'.repeat(2993)
  const STRADDLING = 'a'.repeat(CLIPBOARD_TEXT_LIMIT - 3) + 'secret' + 'b'.repeat(997)

  it('the loop masks and bounds clipboard text before recording', async () => {
    const calls: unknown[][] = []
    const contexts: StepContext[] = []
    const emitted: SubActionEvidence[] = []
    const result = await executeStep(
      'Copy the order number',
      ports({
        adapter: makeAdapter({
          executeResults: [
            {
              success: true,
              metadata: {
                clipboard: [
                  { source: 'writeText', text: LONG, readBack: 'matched' },
                  { source: 'copy-event', text: STRADDLING, readBack: 'mismatched' },
                ],
              },
            },
            { success: true },
          ],
        }),
        planner: scriptedPlanner(twoClicks(), contexts),
        verifier: recordingVerifier(calls, true),
        events: recordingEvents(emitted),
      }),
      makeStepContext({ stepInstruction: 'Copy the order number' }),
    )

    const masked = LONG.replaceAll('secret', '[secret:MASKED_WORD]')
    const expected = [
      {
        source: 'writeText',
        text: masked.slice(0, CLIPBOARD_TEXT_LIMIT) + CLIPBOARD_TRUNCATION_MARKER,
        truncated: true,
        readBack: 'matched',
      },
      {
        source: 'copy-event',
        text: 'a'.repeat(CLIPBOARD_TEXT_LIMIT - 3) + '[se' + CLIPBOARD_TRUNCATION_MARKER,
        truncated: true,
        readBack: 'mismatched',
      },
    ]
    const [first] = result.evidence!.subActions
    expect(first!.operationEvidence).toEqual({ clipboard: expected })
    expect(first!.operationEvidence!.clipboard![0]!.text).toHaveLength(CLIPBOARD_TEXT_LIMIT + CLIPBOARD_TRUNCATION_MARKER.length)
    expect(first!.result).not.toHaveProperty('metadata')
    expect(emitted[0]!.operationEvidence).toEqual({ clipboard: expected })
    expect(emitted[0]!.result).not.toHaveProperty('metadata')
    expect(calls[0]![9]).toEqual({ clipboard: expected })

    const history = contexts[1]!.subActionHistory![0]!.evidence!
    expect(history).toContain(`Clipboard write (writeText): "${expected[0]!.text}" (truncated), read back matched`)
    for (const recorded of [result.evidence, emitted, history]) {
      const outsideMarkers = JSON.stringify(recorded).replaceAll('[secret:MASKED_WORD]', '')
      expect(outsideMarkers).not.toContain('secret')
      expect(outsideMarkers).not.toContain('sec')
    }
  })

  it('short clipboard text is masked and kept whole', async () => {
    const { evidence } = await runDownloadStep({
      success: true,
      metadata: { clipboard: [{ source: 'write', text: 'ORDER-4471 secret', readBack: 'matched' }], keep: 'me' },
    })
    expect(evidence.subActions[0]!.operationEvidence).toEqual({
      clipboard: [{ source: 'write', text: 'ORDER-4471 [secret:MASKED_WORD]', truncated: false, readBack: 'matched' }],
    })
    expect(evidence.subActions[0]!.result.metadata).toEqual({ keep: 'me' })
  })

  it('a click with a download and a clipboard write records both on one sub-action', async () => {
    const { evidence, contexts } = await runDownloadStep({
      success: true,
      metadata: {
        download: [REPORT],
        clipboard: [{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }],
      },
    })

    const [first, second] = evidence.subActions
    expect(first!.operationEvidence).toEqual({
      downloads: [{ ...REPORT, suggestedFilename: 'report-[secret:MASKED_WORD].csv' }],
      clipboard: [{ source: 'writeText', text: 'ORDER-4471', truncated: false, readBack: 'matched' }],
    })
    expect(first!.result).not.toHaveProperty('metadata')
    expect(second).not.toHaveProperty('operationEvidence')
    expect(contexts[1]!.subActionHistory![0]!.evidence).toBe([
      APP_OBSERVED_DATA_OPEN,
      `Download "report-[secret:MASKED_WORD].csv" (.csv): completed, 18 bytes, sha256 ${'a'.repeat(64)}`,
      'Clipboard write (writeText): "ORDER-4471", read back matched',
      APP_OBSERVED_DATA_CLOSE,
    ].join('\n'))
  })

  it('readClipboardMeta keeps well-formed writes in order and drops the rest', () => {
    expect(readClipboardMeta({ metadata: { clipboard: 'ORDER-4471' } })).toBeUndefined()
    expect(readClipboardMeta({ metadata: { clipboard: [{ source: 'paste', text: 'x', readBack: 'matched' }] } })).toBeUndefined()
    expect(readClipboardMeta({
      metadata: {
        clipboard: [
          { source: 'writeText', text: 'one', readBack: 'matched', frame: 'f1' },
          { source: 'write', text: 2, readBack: 'matched' },
          { source: 'copy-event', text: 'two', readBack: 'maybe' },
          { source: 'copy-event', text: 'three', readBack: 'unavailable' },
        ],
      },
    })).toEqual([
      { source: 'writeText', text: 'one', readBack: 'matched' },
      { source: 'copy-event', text: 'three', readBack: 'unavailable' },
    ])
  })
})

// A download started after the previous capture window rides the next action, marked late.
const LATE_NOTE = "started after the previous action's capture ended; not attributed to this action"

const LATE: DownloadEvidence = {
  suggestedFilename: 'late-secret.csv',
  extension: '.csv',
  size: 7,
  sha256: 'c'.repeat(64),
  state: 'completed',
  late: true,
}

function threeClicks(): ActionPlan[] {
  return [
    makeActionPlan({ reasoning: 'Start the export', action: { type: 'click', ref: 'e1' }, stepComplete: false }),
    makeActionPlan({ reasoning: 'Open the menu', action: { type: 'click', ref: 'e1' }, stepComplete: false }),
    makeActionPlan({ reasoning: 'Confirm the export', action: { type: 'click', ref: 'e1' }, stepComplete: true }),
  ]
}

describe('a download that starts after its action', () => {
  it('a late download reaches history and the verifier marked late', async () => {
    const contexts: StepContext[] = []
    const calls: unknown[][] = []
    const result = await executeStep(
      'Export the report',
      ports({
        adapter: makeAdapter({
          executeResults: [{ success: true }, { success: true, metadata: { download: [LATE] } }, { success: true }],
        }),
        planner: scriptedPlanner(threeClicks(), contexts),
        verifier: recordingVerifier(calls, true),
      }),
      makeStepContext({ stepInstruction: 'Export the report' }),
    )

    const masked = { ...LATE, suggestedFilename: 'late-[secret:MASKED_WORD].csv' }
    expect(result.status).toBe('passed')
    expect(result.evidence!.subActions[1]!.operationEvidence).toEqual({ downloads: [masked] })
    expect(result.evidence!.subActions[0]).not.toHaveProperty('operationEvidence')

    const history = contexts[2]!.subActionHistory!
    expect(history[0]).not.toHaveProperty('evidence')
    expect(history[1]!.evidence).toBe([
      APP_OBSERVED_DATA_OPEN,
      `Download "late-[secret:MASKED_WORD].csv" (.csv): completed, 7 bytes, sha256 ${'c'.repeat(64)}, ${LATE_NOTE}`,
      APP_OBSERVED_DATA_CLOSE,
    ].join('\n'))

    expect(calls).toHaveLength(1)
    const verifierEvidence = calls[0]![9] as OperationEvidence
    expect(verifierEvidence).toEqual({ downloads: [masked] })
    const screen = makeScreenState()
    const prompt = buildVerificationPrompt('Export the report', screen, screen, { type: 'click', ref: 'e1' } as Action,
      false, undefined, undefined, undefined, verifierEvidence, calls[0]![10] as VerifierStepRecord)
    expect(prompt).toContain(`action 2: Download "late-[secret:MASKED_WORD].csv" (.csv): completed, 7 bytes, sha256 ${'c'.repeat(64)}, ${LATE_NOTE}`)
  })

  it('a late download keeps its marker through the reader', () => {
    const { late: _late, ...onTime } = LATE
    void _late
    expect(readDownloadMeta({
      metadata: {
        download: [
          LATE,
          { ...onTime, late: 'true' },
          { ...onTime, late: false },
          { suggestedFilename: 'u.bin', extension: '.bin', state: 'unfinished', late: true },
        ],
      },
    })).toEqual([
      LATE,
      onTime,
      onTime,
      { suggestedFilename: 'u.bin', extension: '.bin', state: 'unfinished', late: true },
    ])
  })

  it('a late download is rendered as not started by this action', () => {
    const { late: _late, ...onTime } = LATE
    void _late
    const rendered = renderOperationEvidence({ downloads: [LATE] })
    const completedLine = `Download "late-secret.csv" (.csv): completed, 7 bytes, sha256 ${'c'.repeat(64)}`
    expect(rendered).toBe(`${completedLine}, ${LATE_NOTE}`)
    expect(renderOperationEvidence({ downloads: [onTime] })).toBe(completedLine)
    expect(renderOperationEvidence({ downloads: [{ suggestedFilename: 'u.bin', extension: '.bin', state: 'unfinished', late: true }] }))
      .toBe(`Download "u.bin" (.bin): unfinished, not finished within the time limit, ${LATE_NOTE}`)
  })
})
