// A claude-sonnet-5-5 planner turn through the real Anthropic adapter, with a stubbed fetch.

import { createModel } from '@vostride/agent-qa-model'
import { LLMPlanner, makeScreenState } from '@vostride/agent-qa-runner'
import type { PlanResult, TokenAccounting } from '@vostride/agent-qa-runner'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createAgentQaProgram } from '../program.js'

const click = {
  ref: 'e2',
  reasoning: 'Click the requested Log in button',
  confidence: 0.95,
  stepComplete: true,
  doesActionAdvanceUsTowardsGoal: true,
}

function claudeSonnet55() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'web_click', input: click }],
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
  }), { headers: { 'content-type': 'application/json' } }))
  const profile: ModelProfile = {
    provider: 'anthropic-subscription', model: 'claude-sonnet-5-5', auth: { mode: 'none' },
  }
  return createModel(
    profile, { kind: 'auth-fetch', fetch, modelAdapter: 'anthropic-messages' }, (text) => text)
}

function accounting(): TokenAccounting {
  return {
    estimate: () => 100,
    recordUsage() {},
    getCeilings: () => ({ contextWindow: 200_000, maxOutput: 768 }),
    degrade: (messages) => ({ ok: true, messages }),
  }
}

// The planner's forced tool choice, with a declared temperature the model does not take.
async function plannerTurn(): Promise<PlanResult> {
  const model = claudeSonnet55()
  const planner = new LLMPlanner(model, 'web', undefined, undefined, accounting(), {
    provider: 'anthropic-subscription',
    modelId: 'claude-sonnet-5-5',
    vision: true,
    sampling: { temperature: 0 },
  })
  return planner.plan('Click the Log in button', makeScreenState(), {
    stepInstruction: 'Click the Log in button',
    testName: 'provider adaptation warnings',
    previousSteps: [],
    plannerModel: model,
    verifierModel: model,
  })
}

async function startCommand(): Promise<void> {
  const priorExit = process.exitCode
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await createAgentQaProgram().exitOverride().parseAsync(['node', 'agent-qa', 'skills'])
  } finally {
    process.exitCode = priorExit
    stdout.mockRestore()
  }
}

let printed: string[] = []
let stderr: string[] = []

function captureOutput(): void {
  vi.spyOn(process, 'emitWarning').mockImplementation((warning) => {
    printed.push(String(warning))
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
}

beforeEach(() => {
  printed = []
  stderr = []
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const notices = (): string[] =>
  stderr.filter(line => line.startsWith('[agent-qa:llm] provider-warning'))

it('once a command has started, a claude-sonnet-5-5 planner turn prints no warning', async () => {
  vi.stubEnv('AGENT_QA_DEBUG_LLM', '')
  await startCommand()
  captureOutput()

  const result = await plannerTurn()

  expect(result.plan.action).toMatchObject({ type: 'click', ref: 'e2' })
  expect(result.callRecord?.unsupportedFeatures).toEqual(['temperature', 'toolChoice'])
  expect(printed).toEqual([])
  expect(notices()).toEqual([])
})

it('the LLM debug log names each setting the provider adapted', async () => {
  vi.stubEnv('AGENT_QA_DEBUG_LLM', '1')
  await startCommand()
  captureOutput()

  await plannerTurn()

  expect(printed).toEqual([])
  const scope = 'provider=anthropic.messages model=claude-sonnet-5-5'
  expect(notices()).toEqual([
    expect.stringContaining(`${scope} {"type":"unsupported","feature":"temperature"`),
    expect.stringContaining(`${scope} {"type":"unsupported","feature":"toolChoice"`),
  ])
})
