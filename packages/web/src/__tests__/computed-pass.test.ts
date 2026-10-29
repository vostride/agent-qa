// C439-COMPUTED-PASS (439 D-07, D-10, SC1): in real headless Chromium through the real loop, a
// completion claim passes only when the runner's own computation over the verifier's per-condition
// output says every condition is met. The verifier here is written inline and returns the
// per-condition shape directly; the page is an inline snippet.

import { afterEach, describe, expect, it } from 'vitest'
import type {
  ConditionJudgment,
  PlannerConfig,
  VerificationResult,
  Verifier,
  VerifyResult,
} from '@vostride/agent-qa-runner'
import type { CitationSource } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, refFor, runScriptedStep, scriptedPlanner } from './fixtures/scripted-loop.js'
import type { ScriptedTurn } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const STEP = 'Click Send'
const SEND_PAGE = `<!doctype html><html><body><main>
  <h2 id="status">Compose</h2>
  <button type="button" onclick="document.getElementById('status').textContent = 'Message sent'">Send</button>
</main></body></html>`

let adapter: WebPlatformAdapter | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
}, 60_000)

async function open(): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.setContent(SEND_PAGE)
  return created
}

function condition(
  verdict: ConditionJudgment['verdict'],
  citations: { source: CitationSource; quote: string }[],
  reasoning: string,
): ConditionJudgment {
  return {
    quote: STEP,
    verdict,
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations,
    reasoning,
  }
}

function verification(conditions: ConditionJudgment[], reasoning: string): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning }
}

interface CannedVerifier extends Verifier {
  readonly calls: number
}

function cannedVerifier(result: VerificationResult): CannedVerifier {
  let calls = 0
  return {
    get calls() { return calls },
    async verify(): Promise<VerifyResult> {
      calls++
      return { verification: result }
    },
  }
}

const clickSend: ScriptedTurn = (screen) =>
  act({ type: 'click', ref: refFor(screen, 'button', 'Send') }, true, 'Send the message')

/** Click Send claiming completion, then give up, keeping what the second turn was told. */
function clickThenGiveUp(seen: { failureContext?: string }): ScriptedTurn[] {
  return [
    clickSend,
    (_screen, context) => {
      seen.failureContext = context.failureContext
      return giveUp('The message was not proven sent')
    },
  ]
}

describe('a pass is computed from conditions that are met and cited', () => {
  it('a met condition cited from the final screen passes', async () => {
    const web = await open()
    const verifier = cannedVerifier(verification(
      [condition('met', [{ source: 'final-screen', quote: 'heading "Message sent"' }], 'The heading reads Message sent')],
      'The message was sent',
    ))

    const run = await runScriptedStep({
      adapter: web, instruction: STEP, planner: scriptedPlanner([clickSend]), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(verifier.calls).toBe(1)
    const block = run.result.evidence!.conditionVerdicts!
    expect(block.ending).toBe('completion')
    expect(block.conditions).toHaveLength(1)
    expect(block.conditions[0].verdict).toBe('met')
    expect(block.conditions[0].guard).toBeUndefined()
    expect(block.conditions[0].citations).toEqual([
      { source: 'final-screen', quote: 'heading "Message sent"', found: true },
    ])
    expect(run.result.evidence!.verifierVerdict.pass).toBe(true)
  }, 60_000)

  it('a met condition whose citation is in nothing the verifier was given is not a pass', async () => {
    const web = await open()
    const verifier = cannedVerifier(verification(
      [condition('met', [{ source: 'final-screen', quote: 'Order confirmed' }], 'The order is confirmed')],
      'The goal is accomplished',
    ))
    const seen: { failureContext?: string } = {}

    const run = await runScriptedStep({
      adapter: web, instruction: STEP, planner: scriptedPlanner(clickThenGiveUp(seen)), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(run.result.evidence!.verifierVerdict.pass).toBe(false)
    // The completion, then the give-up's own judgment, which records the last block.
    expect(verifier.calls).toBe(2)
    expect(run.result.evidence!.conditionVerdicts!.ending).toBe('give-up')
    const recorded = run.result.evidence!.conditionVerdicts!.conditions
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ verdict: 'unverified', judged: 'met', guard: 'citation-missing' })
    expect(recorded[0].citations[0].found).toBe(false)
    expect(seen.failureContext).toContain('Unverified:')
    expect(seen.failureContext).toContain('Click Send')
  }, 60_000)

  it('a verification with no conditions never passes', async () => {
    const web = await open()
    const verifier = cannedVerifier(verification([], 'The goal is likely accomplished'))
    const seen: { failureContext?: string } = {}

    const run = await runScriptedStep({
      adapter: web, instruction: STEP, planner: scriptedPlanner(clickThenGiveUp(seen)), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(verifier.calls).toBe(2)
    expect(run.result.evidence!.conditionVerdicts!.ending).toBe('give-up')
    const recorded = run.result.evidence!.conditionVerdicts!.conditions
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ quote: STEP, verdict: 'unverified', guard: 'not-covered' })
  }, 60_000)

  it('a not-met condition is an ordinary rejection', async () => {
    const web = await open()
    const verifier = cannedVerifier(verification(
      [condition('not-met', [{ source: 'final-screen', quote: 'button "Send"' }], 'Nothing shows the message was sent')],
      'The message was not sent',
    ))
    const seen: { failureContext?: string } = {}

    const run = await runScriptedStep({
      adapter: web, instruction: STEP, planner: scriptedPlanner(clickThenGiveUp(seen)), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(verifier.calls).toBe(2)
    expect(run.result.evidence!.conditionVerdicts!.ending).toBe('give-up')
    const recorded = run.result.evidence!.conditionVerdicts!.conditions
    expect(recorded[0].verdict).toBe('not-met')
    expect(recorded[0].guard).toBeUndefined()
    expect(seen.failureContext).toContain('Not met:')
  }, 60_000)

  it('a screenshot citation counts only when an image was attached', async () => {
    const result = verification(
      [condition('met', [{ source: 'screenshot', quote: 'green banner' }], 'A green banner confirms the send')],
      'The banner confirms it',
    )

    const web = await open()
    const withImage = await runScriptedStep({
      adapter: web,
      instruction: STEP,
      planner: scriptedPlanner([clickSend]),
      verifier: cannedVerifier(result),
      plannerConfig: LIMITS,
    })
    expect(withImage.result.status).toBe('passed')
    expect(withImage.result.evidence!.conditionVerdicts!.conditions[0].citations).toEqual([
      { source: 'screenshot', quote: 'green banner', found: 'unchecked' },
    ])

    await web.getPage()!.setContent(SEND_PAGE)
    const textOnly = await runScriptedStep({
      adapter: web,
      instruction: STEP,
      planner: scriptedPlanner(clickThenGiveUp({})),
      verifier: cannedVerifier(result),
      plannerConfig: LIMITS,
      visionGate: { attachImage: false, captureMode: 'textOnly', promptNote: 'text only' },
    })
    expect(textOnly.result.status).toBe('failed')
    expect(textOnly.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'citation-missing',
    })
  }, 60_000)
})
