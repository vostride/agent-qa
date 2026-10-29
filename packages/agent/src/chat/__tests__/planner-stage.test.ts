// Stage 2 produces a PLAN and nothing else.
//
// WHAT THE STUB MODEL IN THIS FILE IS, AND WHAT IT IS NOT. It is a TYPE-LEVEL fake of the
// TRANSPORT seam: an object implementing the SDK's language-model interface that answers with
// scripted content parts, so the read-back shaping can be asserted without a network. It is NOT an
// LLM mock in the sense D-13 rules out — that rule is about scenario lanes, where a mocked model
// would mean the corpus measures the mock's behaviour instead of a model's, and those lanes stay
// mock-free (deterministic scenarios never reach the model at all; planner and compound scenarios
// run live). Nothing here asserts what a model WOULD say. Every case asserts what this stage does
// with what it is given, which is a property of this code and of no model.
//
// The load-bearing case is the negative one: after a turn in which the model proposed several
// actions, NOTHING happened. That is D-10 measured rather than described — and it is measurable
// here precisely because `projectPlannerTools` omits every execute callback, so there is no
// function for the SDK to have called.

import { describe, expect, it } from 'vitest'

import { createPlannerStage, readBackPlan } from '../planner-stage.js'
import type { ChatLanguageModel } from '../planner-stage.js'
import { ANSWER_ONLY_TOOL_NAME, MARK_UNHANDLED_TOOL_NAME } from '../tool-names.js'
import { projectPlannerTools } from '../planner-tools.js'
import type { PlannerToolSource } from '../planner-tools.js'
import type { ChatClause } from '../ports.js'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import type { FunctionDeclaration, FunctionSchemaProjection } from '../../functions/spec.js'

/**
 * The V3 half of the model type the stage accepts, and the call options it is handed.
 *
 * Both are DERIVED rather than imported: the shapes live in the provider-contract package, which
 * this package may not name (`providerNeutral` forbids the vendor-adapter namespace, and the chat
 * rollcall pins that). Deriving them off `ChatLanguageModel` also ties this stub to the exact type
 * the stage declares, so a widening there fails here rather than passing against a stale copy.
 */
type StubLanguageModel = Extract<ChatLanguageModel, { specificationVersion: 'v3' }>
type StubCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

// the retired `grantedScopes` and `safeMode` fields are dropped; nothing
// read them.
const CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'agent',
}

/** Every request now names its session (392 plan 13): the context a stage builds is per-session. */
const SESSION = 'session-planner-stage'

const CLAUSES: readonly ChatClause[] = [
  { text: 'run test 42', index: 0 },
  { text: 'write a test for 2FA', index: 1 },
]

type ScriptedPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }

/**
 * A language model that answers with exactly what it was handed.
 *
 * `doGenerate` is the whole surface `generateText` needs of a V3 model for a non-streaming call.
 * The recorded call options are kept so the prompt-delivery assertions below read what the SDK
 * actually sent rather than what this file assumed it would.
 */
function stubModel(
  parts: readonly ScriptedPart[],
  recorder?: { calls: StubCallOptions[] },
): ChatLanguageModel {
  const model: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'stub',
    modelId: 'stub-planner',
    supportedUrls: {},
    async doGenerate(options: StubCallOptions): Promise<StubGenerateResult> {
      recorder?.calls.push(options)
      return {
        content: parts.map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'tool-call' as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              },
        ),
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error('the planner stage never streams')
    },
  }
  return model
}

/** A model that refuses the call the way a transport failure does. */
function failingModel(error: Error): ChatLanguageModel {
  const model: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'stub',
    modelId: 'stub-planner',
    supportedUrls: {},
    doGenerate() {
      return Promise.reject(error)
    },
    doStream() {
      return Promise.reject(error)
    },
  }
  return model
}

const OBJECT_SCHEMA: FunctionSchemaProjection = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: true,
})

function declaration(id: string): FunctionDeclaration {
  return {
    id,
    summary: `the ${id} capability`,
    resultKind: 'unary',
    risk: { name: `fn:${id}`, recognized: true, readOnly: true },
    bindingStatus: 'bound',
    input: OBJECT_SCHEMA,
    output: OBJECT_SCHEMA,
  }
}

const SOURCE: PlannerToolSource = {
  list: () => [declaration('runs.start'), declaration('runs.digest')],
}

function stage(model: ChatLanguageModel) {
  return createPlannerStage({
    model,
    tools: projectPlannerTools(SOURCE, CALLER),
    context: () => ({ activeModel: 'stub-planner' }),
  })
}

describe('readBackPlan: the shaping, in isolation', () => {
  it('keeps every call in the order the model made them, meta-tools included', () => {
    const outcome = readBackPlan([
      { toolName: 'runs_start', input: { testRef: 'TST-42' } },
      { toolName: MARK_UNHANDLED_TOOL_NAME, input: { clause: 'x', reason: 'y' } },
    ])
    expect(outcome.toolCalls.map((call) => call.toolName)).toEqual([
      'runs_start',
      MARK_UNHANDLED_TOOL_NAME,
    ])
  })

  it('carries answer_only through as a call, projecting NOTHING off it', () => {
    // The projection this replaced lifted the first call's `text` onto the outcome as a
    // convenience. Once the tool contract asked for one call per answered clause that convenience
    // carried strictly less than the calls it came from, and reconciliation trusted it — so the
    // shaping now hands the calls over whole and the reader that needs prose reads the claim.
    const outcome = readBackPlan([{ toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 'three' } }])
    expect(outcome.toolCalls).toEqual([{ toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 'three' } }])
    expect('answer' in outcome).toBe(false)
  })

  it('hands over a malformed answer_only input UNCHANGED, judging none of it', () => {
    // Untrusted output: the model can emit a call whose input does not match the contract it was
    // shown. Deciding what that means is reconciliation's job — this stage is the one place whose
    // input is the model's own bytes, and a shaping that started rejecting them would be a second
    // validator sitting in front of the real one.
    expect(readBackPlan([{ toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 7 } }]).toolCalls)
      .toEqual([{ toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 7 } }])
    expect(readBackPlan([{ toolName: ANSWER_ONLY_TOOL_NAME, input: null }]).toolCalls)
      .toEqual([{ toolName: ANSWER_ONLY_TOOL_NAME, input: null }])
  })

  it('keeps BOTH answer_only calls when a model emitted two', () => {
    // The case the removed projection lost. The prompt asks for one call per answered clause, and
    // every one of them has to survive to the merge or a clause is counted as answered while its
    // answer is thrown away (392-VERIFICATION round 2, path (4)).
    const outcome = readBackPlan([
      { toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 'first' } },
      { toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 'second' } },
    ])
    expect(outcome.toolCalls.map((call) => (call.input as { text: string }).text)).toEqual([
      'first',
      'second',
    ])
  })
})

describe('createPlannerStage: generateText in, plan out', () => {
  it('returns the model plan and executes NOTHING — no tool carries a callback', async () => {
    const outcome = await stage(
      stubModel([
        { type: 'tool-call', toolCallId: 'c1', toolName: 'runs_start', input: '{"testRef":"TST-42"}' },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'runs_digest', input: '{"runId":"RUN-1"}' },
      ]),
    ).plan({ utterance: 'run test 42 and show me the digest', clauses: CLAUSES, sessionId: SESSION })

    expect(outcome.toolCalls.map((call) => call.toolName)).toEqual(['runs_start', 'runs_digest'])
    expect(outcome.toolCalls[0]?.input).toEqual({ testRef: 'TST-42' })
    expect(outcome.failure).toBeUndefined()
    // The plan came back; nothing ran. There is no spy to consult because there is no callback to
    // spy on — `projectPlannerTools` gave the SDK no function for either of these tools, which is
    // asserted directly in planner-tools.test.ts and is what this case rests on.
    const tools = projectPlannerTools(SOURCE, CALLER)
    for (const definition of Object.values(tools)) {
      expect('execute' in definition).toBe(false)
    }
  })

  it('surfaces answer_only as a tool call for reconciliation to read', async () => {
    const outcome = await stage(
      stubModel([
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: ANSWER_ONLY_TOOL_NAME,
          input: '{"text":"There are three proposals pending."}',
        },
      ]),
    ).plan({ utterance: 'how many proposals are pending?', clauses: [CLAUSES[0]!], sessionId: SESSION })

    expect(outcome.toolCalls).toHaveLength(1)
    expect(outcome.toolCalls[0]?.toolName).toBe(ANSWER_ONLY_TOOL_NAME)
    expect(outcome.toolCalls[0]?.input).toEqual({ text: 'There are three proposals pending.' })
  })

  it('carries mark_unhandled through untouched, for reconciliation to act on', async () => {
    const outcome = await stage(
      stubModel([
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: MARK_UNHANDLED_TOOL_NAME,
          input: '{"clause":"write a test for 2FA","reason":"test authoring has not shipped."}',
        },
      ]),
    ).plan({ utterance: 'write a test for 2FA', clauses: [CLAUSES[1]!], sessionId: SESSION })

    expect(outcome.toolCalls[0]?.toolName).toBe(MARK_UNHANDLED_TOOL_NAME)
    expect(outcome.toolCalls[0]?.input).toEqual({
      clause: 'write a test for 2FA',
      reason: 'test authoring has not shipped.',
    })
  })

  it('answers an EMPTY plan when the model proposed nothing, never undefined', async () => {
    const outcome = await stage(stubModel([{ type: 'text', text: 'hmm' }])).plan({
      utterance: 'hmm',
      clauses: [CLAUSES[0]!],
      sessionId: SESSION,
    })
    expect(outcome.toolCalls).toEqual([])
  })

  it('folds a transport failure into typed data — the turn fails, it never hangs or throws', async () => {
    const refusal = new Error('401 Unauthorized')
    refusal.name = 'AuthenticationError'
    const outcome = await stage(failingModel(refusal)).plan({
      utterance: 'run test 42',
      clauses: [CLAUSES[0]!],
      sessionId: SESSION,
    })
    expect(outcome.failure).toEqual({ name: 'AuthenticationError', message: '401 Unauthorized' })
    expect(outcome.toolCalls).toEqual([])
  })

  it('sends the ONE builder\'s prompt, with every projected tool offered', async () => {
    const recorder = { calls: [] as StubCallOptions[] }
    await stage(stubModel([], recorder)).plan({
      utterance: 'run test 42 and write a test for 2FA',
      clauses: CLAUSES,
      sessionId: SESSION,
    })

    const call = recorder.calls[0]
    expect(call).toBeDefined()
    const offered = (call?.tools ?? []).map((entry: { name: string }) => entry.name).sort()
    expect(offered).toEqual(
      ['runs_start', 'runs_digest', ANSWER_ONLY_TOOL_NAME, MARK_UNHANDLED_TOOL_NAME].sort(),
    )
    const sent = JSON.stringify(call?.prompt ?? [])
    expect(sent).toContain('agent-qa chat orchestrator')
    expect(sent).toContain('write a test for 2FA')
  })

  it('reads its prompt context per TURN, so a mid-session model change reaches the prompt', async () => {
    const recorder = { calls: [] as StubCallOptions[] }
    let activeModel = 'first-model'
    const planner = createPlannerStage({
      model: stubModel([], recorder),
      tools: projectPlannerTools(SOURCE, CALLER),
      context: () => ({ activeModel }),
    })

    await planner.plan({ utterance: 'one', clauses: [CLAUSES[0]!], sessionId: SESSION })
    activeModel = 'second-model'
    await planner.plan({ utterance: 'two', clauses: [CLAUSES[0]!], sessionId: SESSION })

    expect(JSON.stringify(recorder.calls[0]?.prompt)).toContain('first-model')
    expect(JSON.stringify(recorder.calls[1]?.prompt)).toContain('second-model')
  })
})
