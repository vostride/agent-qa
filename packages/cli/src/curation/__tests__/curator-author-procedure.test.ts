import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  canonicalJson,
  parseProcedureBody,
  type CompletedRunHandoff,
  type Delta,
  type ElementInfo,
  type PerTestOutcome,
  type ScreenState,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'
import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  curationCandidatePayloadSchema,
  parseAuthoredCheckpoint,
  queuedCandidateDir,
  type CurationCandidatePayload,
  type CurationJobView,
} from '@vostride/agent-qa-knowledge-local'
import { createModel } from '@vostride/agent-qa-model'
import type { ModelProfile, ResolvedModelAuth } from '@vostride/agent-qa-model'
import {
  buildScreenState,
  executeStep,
  SecretRedactor,
  SecretStore,
  type Action as RunnerAction,
  type ActionPlan,
  type ActionResult,
  type InterimNode,
  type PlatformAdapter,
  type StepContext,
} from '@vostride/agent-qa-runner'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { describe, expect, it } from 'vitest'

import { runCurationTail } from '../curation-tail.js'
import { buildCuratorAuthor, CURATOR_RETRY_CAP } from '../curator-author.js'
import {
  emitCurationCandidates,
  parseProcedureTrajectorySeed,
  projectCurationCandidates,
  type EmitReport,
  type ProcedureTrajectorySeed,
} from '../emit-candidates.js'

type CuratorModel = ReturnType<typeof createModel>
type GenerateResult = Awaited<ReturnType<CuratorModel['doGenerate']>>

const noAuth: ResolvedModelAuth = { kind: 'none' }

function profile(): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: 'curator-scripted-model',
    baseURL: 'http://localhost:11434/v1',
    auth: { mode: 'none' },
    capabilities: {
      text: true,
      vision: false,
      visionToolMessages: false,
      toolCalling: true,
      structuredOutput: false,
      streaming: false,
      contextWindow: 16_384,
      maxOutput: 1_024,
    },
  }
}

function generateResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

function scriptedModel(outputs: string[]): CuratorModel {
  let index = 0
  return {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate() {
      const output = outputs[index++]
      if (output === undefined) throw new Error('scripted model exhausted')
      return generateResult(output)
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
}

interface CapturedPrompt {
  system: string
  user: string
}

/**
 * Scripted model that also records what the author actually sent. Prompt-contract and
 * trajectory-render assertions read these — the extraction prompt is module-internal.
 */
function capturingModel(outputs: string[]): {
  model: CuratorModel
  prompts: CapturedPrompt[]
} {
  const prompts: CapturedPrompt[] = []
  let index = 0
  const model = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      prompts.push(readPrompt(options.prompt))
      const output = outputs[index++]
      if (output === undefined) throw new Error('scripted model exhausted')
      return generateResult(output)
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  } as unknown as CuratorModel
  return { model, prompts }
}

function readPrompt(prompt: unknown): CapturedPrompt {
  const messages = prompt as {
    role: string
    content: string | { type: string; text?: string }[]
  }[]
  const flatten = (content: string | { type: string; text?: string }[]): string =>
    typeof content === 'string'
      ? content
      : content.map((part) => part.text ?? '').join('\n')
  return {
    system: messages
      .filter((message) => message.role === 'system')
      .map((message) => flatten(message.content))
      .join('\n'),
    user: messages
      .filter((message) => message.role === 'user')
      .map((message) => flatten(message.content))
      .join('\n'),
  }
}

/** The presented trajectory JSON the author wrapped in DATA delimiters. */
function renderedTrajectory(prompt: CapturedPrompt): {
  flowName: string
  steps: { ordinal: number; replayable?: boolean }[]
} {
  const start = prompt.user.indexOf('{')
  const end = prompt.user.lastIndexOf('}')
  return JSON.parse(prompt.user.slice(start, end + 1))
}

function trajectorySeed(): ProcedureTrajectorySeed {
  return {
    version: 2,
    flowName: 'auth::sign-in-then-checkout',
    steps: [
      {
        ordinal: 0,
        instruction: 'Open the sign-in page',
        action: {
          type: 'click',
          targets: {
            ref: { ref: 'open', role: 'button', nameNormalized: 'sign in', name: 'Sign in' },
          },
          values: {},
        },
        pageRoute: '/login',
      },
      {
        ordinal: 1,
        instruction: 'Enter the account email',
        action: {
          type: 'fill',
          targets: {
            ref: { ref: 'email', role: 'textbox', nameNormalized: 'email', name: 'Email' },
          },
          values: {
            text: { observed: 'user@example.com', source: 'literal' },
            clearMode: { observed: 'replace', source: 'literal' },
          },
        },
        pageRoute: '/login',
      },
      {
        ordinal: 2,
        instruction: 'Enter the account password',
        action: {
          type: 'fill',
          targets: {
            ref: {
              ref: 'password',
              role: 'textbox',
              nameNormalized: 'password',
              name: 'Password',
            },
          },
          values: {
            text: { observed: '<SECRET_0>', source: 'masked-secret' },
            clearMode: { observed: 'replace', source: 'literal' },
            submit: { observed: true, source: 'literal' },
          },
        },
        pageRoute: '/login',
      },
      {
        ordinal: 3,
        instruction: 'Submit and open checkout',
        action: {
          type: 'click',
          targets: {
            ref: { ref: 'submit', role: 'button', nameNormalized: 'submit', name: 'Submit' },
          },
          values: {},
        },
        pageRoute: '/checkout',
      },
    ],
  }
}

function compositeTrajectorySeed(): ProcedureTrajectorySeed {
  const seed = trajectorySeed()
  seed.steps[1]!.action = {
    type: 'fileUpload',
    targets: {
      ref: {
        ref: 'upload',
        role: 'button',
        nameNormalized: 'upload files',
        name: 'Upload files',
      },
    },
    values: {
      files: {
        observed: ['a.png', 'b.pdf'],
        source: 'literal',
      },
    },
  } as unknown as NonNullable<ProcedureTrajectorySeed['steps'][number]['action']>
  return seed
}

// A real flow ends in a target-less verify step, so a whole-flow span hits the per-step wall.
function liveShapedSeed(): ProcedureTrajectorySeed {
  const seed = trajectorySeed()
  seed.steps.push({
    ordinal: 4,
    instruction: 'Verify the checkout page shows the order summary',
    action: {
      type: 'assertAI',
      targets: {},
      values: {},
    },
    pageRoute: '/checkout',
  } as unknown as ProcedureTrajectorySeed['steps'][number])
  return seed
}

/** Same LIVE shape but the non-replayable step sits INTERIOR — contiguity must still reject. */
function interiorNonReplayableSeed(): ProcedureTrajectorySeed {
  const seed = liveShapedSeed()
  seed.steps[2] = {
    ordinal: 2,
    instruction: 'Read the one-time code from the banner',
    action: {
      type: 'extractAI',
      targets: {},
      values: {},
    },
    pageRoute: '/login',
  } as unknown as ProcedureTrajectorySeed['steps'][number]
  return seed
}

// Both slots reach the builder with a `sourceName`, which must survive into the parameter names.
function sourcedSeed(): ProcedureTrajectorySeed {
  const seed = trajectorySeed()
  seed.steps[1]!.action!.values['text'] = {
    observed: 'qa.user@example.com',
    source: 'test-variable',
    sourceName: 'PROBE_USER',
  } as never
  seed.steps[2]!.action!.values['text'] = {
    observed: '[secret:PROBE_TOKEN]',
    source: 'masked-secret',
    sourceName: 'PROBE_TOKEN',
  } as never
  return seed
}

function sourcedJob(bodySeed = canonicalJson(sourcedSeed())): CurationJobView {
  return procedureJob({ bodySeed })
}

function sourcedProposal(emailName: string, passwordName: string): string {
  return JSON.stringify({
    candidates: [
      {
        flowName: 'auth::sign-in-then-checkout',
        stepSpan: [0, 3],
        parameters: [
          {
            name: emailName,
            type: 'string',
            required: true,
            appliesTo: [{ stepOrdinal: 1, field: 'text' }],
          },
          {
            name: passwordName,
            type: 'secret',
            required: true,
            appliesTo: [{ stepOrdinal: 2, field: 'text' }],
          },
        ],
        successAssertion: 'The checkout page is shown',
      },
    ],
  })
}

function liveShapedJob(overrides: Partial<CurationJobView> = {}): CurationJobView {
  return procedureJob({ bodySeed: canonicalJson(liveShapedSeed()), ...overrides })
}

/** The naive proposal the live model actually emits: whole flow [0, last] + an invented name. */
const naiveWholeFlowProposal = JSON.stringify({
  candidates: [
    {
      flowName: 'submit-username-form',
      stepSpan: [0, 4],
      parameters: [
        {
          name: 'accountEmail',
          type: 'string',
          required: true,
          appliesTo: [{ stepOrdinal: 1, field: 'text' }],
        },
      ],
      successAssertion: 'The checkout page is shown',
    },
  ],
})

function procedureJob(overrides: Partial<CurationJobView> = {}): CurationJobView {
  return {
    candidateId: 'a'.repeat(64),
    kind: 'procedure',
    anchors: [
      { t: 'flow', name: 'auth::sign-in-then-checkout' },
      { t: 'page', route: '/login' },
    ],
    summarySeed: 'Procedure auth::sign-in-then-checkout',
    bodySeed: canonicalJson(trajectorySeed()),
    distilledObservations: [],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 42,
    attributingObservationId: 'run-1:test-0:step-0',
    executionContext: 'local-interactive',
    ...overrides,
  }
}

function factJob(): CurationJobView {
  return procedureJob({
    kind: 'fact',
    subtype: 'selector',
    anchors: [
      { t: 'page', route: '/checkout' },
      { t: 'el', role: 'button', name: 'Place order', ordinal: 0 },
    ],
    summarySeed: 'The checkout button submits the order',
    bodySeed: 'Use the resolved checkout button after the cart is complete.',
  })
}

const wholeFlowPlusSubFlow = JSON.stringify({
  candidates: [
    {
      flowName: 'auth::sign-in-then-checkout',
      stepSpan: [0, 3],
      parameters: [
        {
          name: 'accountEmail',
          type: 'string',
          required: true,
          appliesTo: [{ stepOrdinal: 1, field: 'text' }],
        },
      ],
      successAssertion: 'The checkout page is shown',
    },
    {
      flowName: 'auth::sign-in',
      stepSpan: [0, 2],
      parameters: [
        {
          name: 'accountEmail',
          type: 'string',
          required: true,
          appliesTo: [{ stepOrdinal: 1, field: 'text' }],
        },
      ],
      successAssertion: 'The account is signed in',
    },
  ],
})

const F381451_PAGE = 'http://127.0.0.1:8931/form.html'

function guardrailElement(ref: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: { ariaLabel: name },
    attributes: {},
  }
}

function guardrailScreen(elements: ElementInfo[]): ScreenState {
  return {
    platform: 'web',
    tree: elements.map((entry) => `${entry.role} ${entry.name}`).join('\n'),
    elements,
    refMap: Object.fromEntries(
      elements.map((entry) => [
        entry.ref,
        { bounds: entry.bounds!, center: entry.center! },
      ]),
    ),
    url: F381451_PAGE,
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 1_440 },
    },
  }
}

function guardrailStep(input: {
  stepIndex: number
  stepText: string
  ref: string
  name: string
  fillText?: string
  interpolatedVariables?: { name: string; value: string }[]
}): StepEvidence {
  const el = guardrailElement(input.ref, input.name)
  const state = guardrailScreen([el])
  const evidence: SubActionEvidence = {
    plan: `Use ${input.ref}`,
    plannedAction:
      input.fillText === undefined
        ? { type: 'click', ref: asRef(input.ref) }
        : {
            type: 'fill',
            ref: asRef(input.ref),
            text: input.fillText,
            clearMode: 'replace',
            submit: false,
          },
    stateBefore: state,
    stateAfter: state,
    result: { success: true },
    decisionScreenshotRef: {
      id: `decision-screenshot:${'a'.repeat(64)}`,
      sha: 'a'.repeat(64),
    },
  }
  return {
    stepIndex: input.stepIndex,
    stepText: input.stepText,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'storefront' },
      asOfBuild: 42,
      budget: 1_000,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest',
    },
    subActions: [evidence],
    verifierVerdict: { pass: true, reasoning: 'step verified' },
    ...(input.interpolatedVariables === undefined
      ? {}
      : { interpolatedVariables: input.interpolatedVariables }),
  }
}

function author(outputs: string[]) {
  return buildCuratorAuthor({
    profile: profile(),
    auth: noAuth,
    mask: (text) => text,
    createModelImpl: () => scriptedModel(outputs),
  })
}

function capturingAuthor(outputs: string[]) {
  const captured = capturingModel(outputs)
  return {
    prompts: captured.prompts,
    author: buildCuratorAuthor({
      profile: profile(),
      auth: noAuth,
      mask: (text) => text,
      createModelImpl: () => captured.model,
    }),
  }
}

function addBundles(deltas: Delta[]) {
  return deltas.map((delta) => {
    if (delta.kind !== 'Add') throw new Error(`expected Add delta, got ${delta.kind}`)
    return delta.bundle
  })
}

describe('procedure-extraction author path', () => {
  it('yields whole-flow and sub-flow Add deltas whose bodies round-trip the codec', async () => {
    const outcome = await author([wholeFlowPlusSubFlow])(procedureJob(), [])

    expect(outcome.kind).toBe('authored')
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    expect(outcome.deltas).toHaveLength(2)
    const bundles = addBundles(outcome.deltas)
    expect(bundles.every((bundle) => bundle.kind === 'procedure')).toBe(true)
    // Both anchor on seed.flowName (the queue candidate's primary anchor); the sub-flow is
    // distinguished by its span, and its proposed name survives only in the summary.
    expect(bundles.map((bundle) => bundle.anchors[0])).toEqual([
      { t: 'flow', name: 'auth::sign-in-then-checkout' },
      { t: 'flow', name: 'auth::sign-in-then-checkout' },
    ])
    expect(bundles[0]?.summary).toBe('Procedure auth::sign-in-then-checkout (4 steps)')
    expect(bundles[1]?.summary).toBe(
      'Procedure auth::sign-in-then-checkout segment auth::sign-in (3 steps)',
    )
    const payloads = bundles.map((bundle) => parseProcedureBody(bundle.body))
    expect(payloads[0]?.steps).toHaveLength(4)
    expect(payloads[1]?.steps).toHaveLength(3)
    expect(payloads[0]?.steps.map((step) => step.instruction)).toEqual([
      'Open the sign-in page',
      'Enter the account email',
      'Enter the account password',
      'Submit and open checkout',
    ])
    expect(payloads[1]?.successAssertion).toBe('The account is signed in')
  })

  it('derives guard descriptors from job evidence — a bogus proposal descriptor cannot alter them', async () => {
    const bogus = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'Signed in',
          steps: [
            {
              guard: {
                target: { role: 'link', nameNormalized: 'hacked', ordinal: 9 },
                pageAnchor: { t: 'page', route: '/evil' },
              },
            },
          ],
          guards: [{ role: 'link', nameNormalized: 'hacked', ordinal: 9 }],
        },
      ],
    })

    const outcome = await author([bogus])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(bundle!.body)

    expect(payload?.steps.map((step) => step.guard)).toEqual([
      {
        target: { role: 'button', nameNormalized: 'sign in', name: 'Sign in' },
        pageAnchor: { t: 'page', route: '/login' },
      },
      {
        target: { role: 'textbox', nameNormalized: 'email', name: 'Email' },
        pageAnchor: { t: 'page', route: '/login' },
      },
      {
        target: { role: 'textbox', nameNormalized: 'password', name: 'Password' },
        pageAnchor: { t: 'page', route: '/login' },
      },
    ])
    expect(bundle!.body).not.toContain('hacked')
    expect(bundle!.body).not.toContain('/evil')
  })

  it('force-parameterizes a masked-secret value the proposal missed', async () => {
    const outcome = await author([wholeFlowPlusSubFlow])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [wholeFlow] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(wholeFlow!.body)
    if (payload === undefined) throw new Error('expected parseable procedure body')

    const passwordStep = payload.steps[2]!
    const slot = passwordStep.action.values['text']
    expect(typeof slot).toBe('object')
    if (typeof slot !== 'object' || !('param' in slot)) {
      throw new Error('expected param ref slot')
    }
    const forced = payload.parameters.find((parameter) => parameter.name === slot.param)
    expect(forced).toMatchObject({ type: 'secret', required: true })
    expect(wholeFlow!.body).not.toContain('<SECRET_0>')

    const emailSlot = payload.steps[1]!.action.values['text']
    expect(emailSlot).toEqual({ param: 'accountEmail' })
    expect(wholeFlow!.body).not.toContain('user@example.com')

    expect(passwordStep.action.values['clearMode']).toBe('replace')
    expect(passwordStep.action.values['submit']).toBe(true)
    expect(payload.parameters).toEqual(
      expect.arrayContaining([
        { name: 'accountEmail', type: 'string', required: true },
        { name: slot.param, type: 'secret', required: true },
      ]),
    )
    expect(payload.parameters).toHaveLength(2)
  })

  it('commits a boolean literal slot without stringifying it', async () => {
    const seed = trajectorySeed()
    seed.steps[1]!.action!.values['submit'] = {
      observed: true,
      source: 'literal',
    }
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::typed-submit',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The account is signed in',
        },
      ],
    })

    const outcome = await author([proposal])(
      procedureJob({ bodySeed: canonicalJson(seed) }),
      [],
    )
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(bundle!.body)

    expect(payload?.steps[1]?.action.values['submit']).toBe(true)
  })

  it('commits a composite literal slot through the tagged json representation', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::upload-files',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The files are accepted',
        },
      ],
    })

    const outcome = await author([proposal])(
      procedureJob({ bodySeed: canonicalJson(compositeTrajectorySeed()) }),
      [],
    )
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(bundle!.body)

    expect(payload?.steps[1]?.action.values['files']).toEqual({
      json: ['a.png', 'b.pdf'],
    })
  })

  it('rejects a proposal that parameterizes a composite slot while building valid siblings', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::parameterized-files',
          stepSpan: [0, 2],
          parameters: [
            {
              name: 'files',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'files' }],
            },
          ],
          successAssertion: 'This candidate must be rejected',
        },
        {
          flowName: 'auth::literal-files',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The files are accepted',
        },
      ],
    })

    const outcome = await author([proposal])(
      procedureJob({ bodySeed: canonicalJson(compositeTrajectorySeed()) }),
      [],
    )
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const bundles = addBundles(outcome.deltas)

    expect(bundles).toHaveLength(1)
    expect(bundles[0]?.summary).toContain('segment auth::literal-files')
    expect(bundles[0]?.anchors[0]).toEqual({
      t: 'flow',
      name: 'auth::sign-in-then-checkout',
    })
  })

  it('rejects duplicate parameter names per candidate while building valid siblings', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::ambiguous-names',
          stepSpan: [0, 2],
          parameters: [
            {
              name: 'email',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'text' }],
            },
            {
              name: 'email',
              type: 'boolean',
              required: false,
              appliesTo: [{ stepOrdinal: 1, field: 'clearMode' }],
            },
          ],
          successAssertion: 'Ambiguous candidate must be rejected',
        },
        {
          flowName: 'auth::valid-sibling',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The account is signed in',
        },
      ],
    })

    const outcome = await author([proposal])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const bundles = addBundles(outcome.deltas)

    expect(bundles).toHaveLength(1)
    expect(bundles[0]?.summary).toContain('segment auth::valid-sibling')
    expect(bundles[0]?.anchors[0]).toEqual({
      t: 'flow',
      name: 'auth::sign-in-then-checkout',
    })
  })

  it('rejects duplicate parameter slot ownership per candidate while building valid siblings', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::ambiguous-ownership',
          stepSpan: [0, 2],
          parameters: [
            {
              name: 'email',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'text' }],
            },
            {
              name: 'otherEmail',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'text' }],
            },
          ],
          successAssertion: 'Ambiguous candidate must be rejected',
        },
        {
          flowName: 'auth::valid-sibling',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The account is signed in',
        },
      ],
    })

    const outcome = await author([proposal])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const bundles = addBundles(outcome.deltas)

    expect(bundles).toHaveLength(1)
    expect(bundles[0]?.summary).toContain('segment auth::valid-sibling')
    expect(bundles[0]?.anchors[0]).toEqual({
      t: 'flow',
      name: 'auth::sign-in-then-checkout',
    })
  })

  it('mints forced parameter names against every proposed name with the smallest suffix', async () => {
    const collisionProposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::forced-name-collision',
          stepSpan: [0, 2],
          parameters: [
            {
              name: 'step2_text',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'text' }],
            },
          ],
          successAssertion: 'The account is signed in',
        },
      ],
    })

    const outcome = await author([collisionProposal])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(bundle!.body)
    if (payload === undefined) throw new Error('expected parseable procedure body')

    expect(payload.steps[1]?.action.values['text']).toEqual({ param: 'step2_text' })
    expect(payload.steps[2]?.action.values['text']).toEqual({ param: 'step2_text_2' })
    expect(payload.parameters.map(({ name }) => name).sort()).toEqual([
      'step2_text',
      'step2_text_2',
    ])
    expect(new Set(payload.parameters.map(({ name }) => name)).size).toBe(
      payload.parameters.length,
    )
  })

  it('states the span-replayability and flowName-echo contract rules in the prompt', async () => {
    const { author: run, prompts } = capturingAuthor([wholeFlowPlusSubFlow])
    await run(procedureJob(), [])

    const system = prompts[0]!.system
    // The span-replayability rule: only replayable-marked steps may be covered, and the
    // trailing verify/assert step informs successAssertion rather than joining the span.
    expect(system).toContain('"replayable": true')
    expect(system).toMatch(/successAssertion/)
    expect(system).toMatch(/exclude|excluded/i)
    // The flowName-echo rule: echo the presented flowName verbatim; sub-flows differ by span.
    expect(system).toMatch(/echo/i)
    expect(system).toContain('stepSpan')
    expect(system).toMatch(/never by (a )?new|never invent|verbatim/i)
  })

  it('marks each presented trajectory step replayable by the builder predicate', async () => {
    const { author: run, prompts } = capturingAuthor([naiveWholeFlowProposal])
    await run(liveShapedJob(), [])

    const rendered = renderedTrajectory(prompts[0]!)
    expect(rendered.flowName).toBe('auth::sign-in-then-checkout')
    expect(rendered.steps.map((step) => step.replayable)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
  })

  it('marks an interior non-replayable step false alongside a non-replayable tail', async () => {
    const { author: run, prompts } = capturingAuthor([naiveWholeFlowProposal])
    await run(procedureJob({ bodySeed: canonicalJson(interiorNonReplayableSeed()) }), [])

    const rendered = renderedTrajectory(prompts[0]!)
    expect(rendered.steps.map((step) => step.replayable)).toEqual([
      true,
      true,
      false,
      true,
      false,
    ])
  })

  it('clamps a naive whole-flow span off its non-replayable tail and builds', async () => {
    const outcome = await author([naiveWholeFlowProposal])(liveShapedJob(), [])

    expect(outcome.kind).toBe('authored')
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    expect(outcome.deltas).toHaveLength(1)
    const [bundle] = addBundles(outcome.deltas)
    const payload = parseProcedureBody(bundle!.body)
    // Ordinals 0..3 survive; the trailing assertAI verify step (4) is clamped off.
    expect(payload?.steps).toHaveLength(4)
    expect(payload?.steps.at(-1)?.instruction).toBe('Submit and open checkout')
    expect(payload?.successAssertion).toBe('The checkout page is shown')
  })

  it('pins the delta flow anchor to seed.flowName against an invented proposal name', async () => {
    const outcome = await author([naiveWholeFlowProposal])(liveShapedJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)

    // checkAnchorConsistency compares against the queue candidate's primary flow anchor,
    // which emit-candidates pins to flow:<testId> === seed.flowName.
    expect(bundle!.anchors[0]).toEqual({
      t: 'flow',
      name: 'auth::sign-in-then-checkout',
    })
    expect(bundle!.anchors.some((anchor) => anchor.t === 'flow' && anchor.name === 'submit-username-form')).toBe(false)
  })

  it('pins a BUILDABLE sub-span proposal to seed.flowName too (anchor-downgrade precondition)', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'submit-username-form',
          stepSpan: [0, 2],
          parameters: [],
          successAssertion: 'The account is signed in',
        },
      ],
    })

    const outcome = await author([proposal])(procedureJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const [bundle] = addBundles(outcome.deltas)

    expect(bundle!.anchors[0]).toEqual({
      t: 'flow',
      name: 'auth::sign-in-then-checkout',
    })
  })

  it('still rejects a span whose INTERIOR step is non-replayable (contiguity)', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 4],
          parameters: [],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )(procedureJob({ bodySeed: canonicalJson(interiorNonReplayableSeed()) }), [])

    expect(outcome).toEqual({ kind: 'fallback-required', reason: 'malformed' })
  })

  it('rejects a span that clamps below two replayable steps', async () => {
    const seed = liveShapedSeed()
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: seed.flowName,
          stepSpan: [3, 4],
          parameters: [],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )(liveShapedJob(), [])

    expect(outcome).toEqual({ kind: 'fallback-required', reason: 'malformed' })
  })

  it('names the ACTUAL per-candidate constraint in procedure retry feedback', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'submit-username-form',
          stepSpan: [0, 4],
          parameters: [],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })
    const { author: run, prompts } = capturingAuthor(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )

    await run(procedureJob({ bodySeed: canonicalJson(interiorNonReplayableSeed()) }), [])

    expect(prompts).toHaveLength(CURATOR_RETRY_CAP + 1)
    const retry = prompts[1]!.user
    // The constraint, not the delta-authoring boilerplate that never applied to extraction.
    expect(retry).not.toMatch(/documented delta kinds/i)
    expect(retry).toMatch(/ordinal 2/)
    expect(retry).toMatch(/replayable/i)
    expect(retry).toMatch(/flowName/)
  })

  it('shows sourceName on rendered value slots and demands it in the prompt', async () => {
    const { author: run, prompts } = capturingAuthor([sourcedProposal('PROBE_USER', 'PROBE_TOKEN')])

    await run(sourcedJob(), [])

    const rendered = JSON.parse(
      prompts[0]!.user.slice(
        prompts[0]!.user.indexOf('{'),
        prompts[0]!.user.lastIndexOf('}') + 1,
      ),
    ) as { steps: { valueSlots?: Record<string, { sourceName?: string }> }[] }
    expect(rendered.steps[1]?.valueSlots?.['text']?.sourceName).toBe('PROBE_USER')
    expect(rendered.steps[2]?.valueSlots?.['text']?.sourceName).toBe('PROBE_TOKEN')
    expect(prompts[0]!.system).toMatch(/sourceName/)
  })

  it('commits the binding names against a proposal that invented its own', async () => {
    const outcome = await author([sourcedProposal('username', 'probe_token')])(sourcedJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const payload = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)

    expect(payload?.steps[1]?.action.values['text']).toEqual({ param: 'PROBE_USER' })
    expect(payload?.steps[2]?.action.values['text']).toEqual({ param: 'PROBE_TOKEN' })
    expect(payload?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'PROBE_USER', type: 'string', required: true },
        { name: 'PROBE_TOKEN', type: 'secret', required: true },
      ]),
    )
    expect(payload?.parameters).toHaveLength(2)
  })

  it('forces a MISSED sourced slot to its binding name, not a synthetic ordinal name', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 3],
          parameters: [],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author([proposal])(sourcedJob(), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const payload = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)

    expect(payload?.parameters.map((parameter) => parameter.name).sort()).toEqual([
      'PROBE_TOKEN',
      'PROBE_USER',
    ])
    expect(payload?.parameters.map((p) => p.name).join()).not.toMatch(/step\d+_/)
  })

  it('collapses two slots sharing one sourceName onto ONE parameter, secret type winning', async () => {
    const seed = sourcedSeed()
    // Ordinal 1 and ordinal 2 both bind PROBE_TOKEN; ordinal 2's is the masked slot.
    seed.steps[1]!.action!.values['text'] = {
      observed: 'tok-live-9f3a2b',
      source: 'test-variable',
      sourceName: 'PROBE_TOKEN',
    } as never
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 3],
          parameters: [],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author([proposal])(sourcedJob(canonicalJson(seed)), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const payload = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)

    expect(payload?.parameters).toEqual([
      { name: 'PROBE_TOKEN', type: 'secret', required: true },
    ])
    expect(payload?.steps[1]?.action.values['text']).toEqual({ param: 'PROBE_TOKEN' })
    expect(payload?.steps[2]?.action.values['text']).toEqual({ param: 'PROBE_TOKEN' })
  })

  it('rejects a proposal whose one parameter spans two DIFFERENT sourceNames', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 3],
          parameters: [
            {
              name: 'credential',
              type: 'string',
              required: true,
              appliesTo: [
                { stepOrdinal: 1, field: 'text' },
                { stepOrdinal: 2, field: 'text' },
              ],
            },
          ],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )(sourcedJob(), [])

    expect(outcome).toEqual({ kind: 'fallback-required', reason: 'malformed' })
  })

  it('rejects when a proposal name collides with an unrelated slot’s forced binding name', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 3],
          parameters: [
            {
              // Claims the UNSOURCED clearMode slot under a name the sourced text slot owns.
              name: 'PROBE_USER',
              type: 'string',
              required: true,
              appliesTo: [{ stepOrdinal: 1, field: 'clearMode' }],
            },
          ],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })

    const outcome = await author(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )(sourcedJob(), [])

    expect(outcome).toEqual({ kind: 'fallback-required', reason: 'malformed' })
  })

  it('names the naming conflict in procedure retry feedback', async () => {
    const proposal = JSON.stringify({
      candidates: [
        {
          flowName: 'auth::sign-in-then-checkout',
          stepSpan: [0, 3],
          parameters: [
            {
              name: 'credential',
              type: 'string',
              required: true,
              appliesTo: [
                { stepOrdinal: 1, field: 'text' },
                { stepOrdinal: 2, field: 'text' },
              ],
            },
          ],
          successAssertion: 'The checkout page is shown',
        },
      ],
    })
    const { author: run, prompts } = capturingAuthor(
      Array.from({ length: CURATOR_RETRY_CAP + 1 }, () => proposal),
    )

    await run(sourcedJob(), [])

    expect(prompts[1]!.user).toMatch(/PROBE_USER/)
    expect(prompts[1]!.user).toMatch(/PROBE_TOKEN/)
  })

  it('widened multi-delta checkpoint round-trips and single-delta fact authoring still works', async () => {
    const factOutcome = await author([
      JSON.stringify({
        kind: 'Add',
        citedAliases: [],
        bundle: {
          kind: 'fact',
          subtype: 'selector',
          anchors: [{ t: 'page', route: '/checkout' }],
          summary: 'Model-authored atomic summary',
          body: 'Model-authored standalone body',
        },
      }),
    ])(factJob(), [])

    expect(factOutcome.kind).toBe('authored')
    if (factOutcome.kind !== 'authored') throw new Error('expected authored fact outcome')
    expect(factOutcome.deltas).toHaveLength(1)
    expect(factOutcome.deltas[0]?.kind).toBe('Add')

    const procedureOutcome = await author([wholeFlowPlusSubFlow])(procedureJob(), [])
    if (procedureOutcome.kind !== 'authored') throw new Error('expected authored outcome')
    const checkpoint = parseAuthoredCheckpoint({
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      deltas: procedureOutcome.deltas,
      neighborIds: [],
      preconditions: [],
      authorship: procedureOutcome.authorship,
    })
    expect(checkpoint.deltas).toHaveLength(2)
  })
})

describe('procedure names and row words as written', () => {
  const WRITE_PAGE = 'https://shop.example/invoices'

  function writeElement(
    ref: string,
    role: string,
    name: string,
    nameNormalized: string,
    parentRef?: string,
  ): ElementInfo {
    return {
      ref: asRef(ref),
      role,
      name,
      nameNormalized,
      bounds: { x: 10, y: 20, width: 100, height: 40 },
      center: { x: 60, y: 40 },
      state: { enabled: true, focused: false, visible: true, clickable: true },
      labels: {},
      attributes: {},
      ...(parentRef === undefined ? {} : { hierarchy: { parentRef: asRef(parentRef) } }),
    }
  }

  function writeStep(input: {
    stepIndex: number
    stepText: string
    elements: ElementInfo[]
    ref: string
    stated?: { role?: string; name: string; row?: string }
  }): StepEvidence {
    const state = { ...guardrailScreen(input.elements), url: WRITE_PAGE }
    const evidence: SubActionEvidence = {
      plan: `Use ${input.ref}`,
      plannedAction: { type: 'click', ref: asRef(input.ref) },
      stateBefore: state,
      stateAfter: state,
      result: { success: true },
      ...(input.stated === undefined
        ? {}
        : { grounding: { descriptor: {}, attempts: [], stated: input.stated } }),
    }
    return {
      ...guardrailStep({
        stepIndex: input.stepIndex,
        stepText: input.stepText,
        ref: input.ref,
        name: input.ref,
      }),
      subActions: [evidence],
    }
  }

  function invoiceRun(): CompletedRunHandoff {
    const steps = [
      writeStep({
        stepIndex: 0,
        stepText: 'Open invoice 947',
        elements: [
          writeElement('e1', 'link', 'Invoice 946', 'invoice'),
          writeElement('e2', 'link', 'Invoice 947', 'invoice'),
        ],
        ref: 'e2',
        stated: { role: 'link', name: 'Invoice 947' },
      }),
      writeStep({
        stepIndex: 1,
        stepText: 'Edit the Elm Street label',
        elements: [
          writeElement('r1', 'listitem', '9 Oak Road', '9 oak road'),
          writeElement('b1', 'button', 'Edit label', 'edit label', 'r1'),
          writeElement('r2', 'listitem', '7 Elm Street', '7 elm street'),
          writeElement('b2', 'button', 'Edit label', 'edit label', 'r2'),
        ],
        ref: 'b2',
        stated: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      }),
      writeStep({
        stepIndex: 2,
        stepText: 'Save the label',
        elements: [writeElement('s1', 'button', 'Save', 'save')],
        ref: 's1',
      }),
    ]
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId('r-procedure-write'),
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: [{
        testId: 'invoices::edit-label',
        testName: 'Edit an invoice label',
        testIndex: 0,
        outcome: 'passed',
        steps,
        filePath: 'invoices.spec.yaml',
      }],
    }
  }

  function writeSeed(mask?: (text: string) => string): ProcedureTrajectorySeed {
    const [target] = projectCurationCandidates(invoiceRun(), mask).filter(
      (row) => row.kind === 'procedure',
    )
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    if (seed === undefined) throw new Error('expected a parseable invoice seed')
    return seed
  }

  function writeJob(seed: ProcedureTrajectorySeed): CurationJobView {
    return procedureJob({
      bodySeed: canonicalJson(seed),
      anchors: [
        { t: 'flow', name: seed.flowName },
        { t: 'page', route: WRITE_PAGE },
      ],
    })
  }

  const writeProposal = JSON.stringify({
    candidates: [{
      flowName: 'invoices::edit-label',
      stepSpan: [0, 2],
      parameters: [],
      successAssertion: 'The label is saved',
    }],
  })

  it('writes the exact name and no ordinal into the trajectory and the body', async () => {
    const seed = writeSeed()
    expect(seed.version).toBe(2)
    expect(seed.steps[0]?.action?.targets).toEqual({
      ref: { ref: 'e2', role: 'link', nameNormalized: 'invoice', name: 'Invoice 947' },
    })

    const outcome = await author([writeProposal])(writeJob(seed), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const payload = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)
    const invoice = { role: 'link', nameNormalized: 'invoice', name: 'Invoice 947' }
    expect(payload?.steps[0]?.action.targets).toEqual({ ref: invoice })
    expect(payload?.steps[0]?.guard.target).toEqual(invoice)
    expect(addBundles(outcome.deltas)[0]!.body).not.toContain('ordinal')
  })

  it('writes the stated row words into the trajectory and the body', async () => {
    const seed = writeSeed()
    const editLabel = {
      role: 'button',
      nameNormalized: 'edit label',
      name: 'Edit label',
      row: '7 Elm Street',
    }
    expect(seed.steps[1]?.action?.targets).toEqual({ ref: { ref: 'b2', ...editLabel } })
    expect(seed.steps[2]?.action?.targets['ref']).not.toHaveProperty('row')

    const outcome = await author([writeProposal])(writeJob(seed), [])
    if (outcome.kind !== 'authored') throw new Error('expected authored outcome')
    const payload = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)
    expect(payload?.steps[1]?.action.targets).toEqual({ ref: editLabel })
    expect(payload?.steps[1]?.guard.target).toEqual(editLabel)
  })

  it("passes the written name and row through the tail's mask", () => {
    const seed = writeSeed((text) =>
      text.replaceAll('Elm', '[secret:STREET]').replaceAll('947', '[secret:INVOICE]'))
    expect(seed.steps[0]?.action?.targets['ref']?.name).toBe('Invoice [secret:INVOICE]')
    expect(seed.steps[1]?.action?.targets['ref']?.row).toBe('7 [secret:STREET] Street')
  })

  it('rejects a version-1 seed as a candidate', async () => {
    const legacy = { ...trajectorySeed(), version: 1 }
    expect(parseProcedureTrajectorySeed(canonicalJson(legacy))).toBeUndefined()

    const outcome = await author([writeProposal])(
      procedureJob({ bodySeed: canonicalJson(legacy) }),
      [],
    )

    expect(outcome).toEqual({ kind: 'fallback-required', reason: 'malformed' })
  })
})

// The evidence comes from real `executeStep` runs, so curation reads what the loop recorded.
describe("a healed action's procedure body", () => {
  const HEALED_PAGE = 'https://shop.example/editor'

  function healedScreen(nodes: InterimNode[]): ScreenState {
    return buildScreenState({
      platform: 'android',
      url: HEALED_PAGE,
      nodes: nodes.map((node, i) => ({
        bounds: { x: 0, y: i * 60, width: 400, height: 50 },
        ...node,
      })),
      viewport: { width: 400, height: 800 },
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 400, contentHeight: 800 },
      coordSpace: 'viewport',
      timestamp: 0,
    }).state
  }

  function shiftingAdapter(
    prior: ScreenState,
    fresh: ScreenState,
    results: ActionResult[],
  ): PlatformAdapter & { executed: RunnerAction[] } {
    const executed: RunnerAction[] = []
    return {
      executed,
      platform: 'android',
      async setup() {},
      async cleanup() {},
      async observe() {
        return executed.length === 0 ? prior : fresh
      },
      async execute(action: RunnerAction) {
        const result = results[Math.min(executed.length, results.length - 1)]!
        executed.push(action)
        return result
      },
    }
  }

  function bindingLost(ref: string): ActionResult {
    return {
      success: false,
      error: `binding-lost: ref ${ref} — the observed element is no longer on the page; nothing was sent`,
      metadata: { binding: { outcome: 'binding-lost', ref, inputSent: false } },
    }
  }

  function scripted(action: ActionPlan['action']) {
    const turns: ActionPlan[] = [
      { reasoning: 'scripted', action, confidence: 0.9, stepComplete: true, stepFailed: false },
      {
        reasoning: 'giving up',
        action: { type: 'delay', ms: 0 },
        confidence: 0.9,
        stepComplete: false,
        stepFailed: true,
      },
    ]
    let calls = 0
    return {
      async plan() {
        return { plan: turns[Math.min(calls++, turns.length - 1)]! }
      },
    }
  }

  const stepContext = (stepInstruction: string): StepContext => ({
    stepInstruction,
    testName: 'editor::healed-step',
    previousSteps: [],
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  })

  const loopLimits = { maxActions: 10, maxPlanningTurns: 10, previousStepCount: 0 }

  async function healedRun(input: {
    prior: InterimNode[]
    fresh: InterimNode[]
    action: ActionPlan['action']
    lostRef: string
  }) {
    const prior = healedScreen(input.prior)
    const fresh = healedScreen(input.fresh)
    const healed = shiftingAdapter(prior, fresh, [bindingLost(input.lostRef), { success: true }])
    const step0 = await executeStep(
      'Use the healed control',
      { adapter: healed, planner: scripted(input.action), plannerConfig: loopLimits },
      stepContext('Use the healed control'),
    )
    const done = healedScreen([{ role: 'button', name: 'Done' }])
    const plain = shiftingAdapter(done, done, [{ success: true }])
    const step1 = await executeStep(
      'Click Done',
      {
        adapter: plain,
        planner: scripted({ type: 'click', ref: 'e1', target: { role: 'button', name: 'Done' } }),
        plannerConfig: loopLimits,
      },
      stepContext('Click Done'),
    )
    expect(step0.status).toBe('passed')
    expect(step1.status).toBe('passed')
    const run: CompletedRunHandoff = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId('r-healed-body'),
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: [{
        testId: 'editor::healed-step',
        testName: 'Use a healed control then finish',
        testIndex: 0,
        outcome: 'passed',
        steps: [
          { ...step0.evidence!, stepIndex: 0 },
          { ...step1.evidence!, stepIndex: 1 },
        ],
        filePath: 'editor.spec.yaml',
      }],
    }
    const [target] = projectCurationCandidates(run).filter(
      (row) => row.kind === 'procedure',
    )
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    if (seed === undefined) throw new Error('expected a parseable healed seed')
    return { healed, fresh, seed }
  }

  async function authoredBody(seed: ProcedureTrajectorySeed) {
    const proposal = JSON.stringify({
      candidates: [{
        flowName: seed.flowName,
        stepSpan: [0, 1],
        parameters: [],
        successAssertion: 'The editor is finished',
      }],
    })
    const job = procedureJob({
      bodySeed: canonicalJson(seed),
      anchors: [
        { t: 'flow', name: seed.flowName },
        { t: 'page', route: HEALED_PAGE },
      ],
    })
    const outcome = await author([proposal])(job, [])
    if (outcome.kind !== 'authored') throw new Error(`expected authored outcome, got ${outcome.kind}`)
    return parseProcedureBody(addBundles(outcome.deltas)[0]!.body)
  }

  it('a healed click\'s procedure body names the clicked element', async () => {
    const { healed, fresh, seed } = await healedRun({
      prior: [
        { role: 'button', name: 'Delete' },
        { role: 'button', name: 'Save' },
        { role: 'button', name: 'Cancel' },
      ],
      fresh: [
        { role: 'button', name: 'Banner' },
        { role: 'button', name: 'Delete' },
        { role: 'button', name: 'Save' },
        { role: 'button', name: 'Cancel' },
      ],
      action: { type: 'click', ref: 'e2', target: { role: 'button', name: 'Save' } },
      lostRef: 'e2',
    })

    expect(healed.executed).toEqual([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e3' },
    ])
    const freshSave = fresh.elements.find((element) => element.name === 'Save')!
    const save = { role: 'button', nameNormalized: freshSave.nameNormalized, name: 'Save' }
    expect(seed.steps[0]?.action?.targets).toEqual({ ref: { ref: 'e3', ...save } })

    const payload = await authoredBody(seed)
    expect(payload?.steps[0]?.action.targets).toEqual({ ref: save })
    expect(payload?.steps[0]?.guard.target).toEqual(save)
  })

  it('a healed drag\'s procedure body names the dragged element and the drop target', async () => {
    const { seed } = await healedRun({
      prior: [
        { role: 'button', name: 'Card' },
        { role: 'button', name: 'Drop A' },
      ],
      fresh: [
        { role: 'button', name: 'Banner' },
        { role: 'button', name: 'Card' },
        { role: 'button', name: 'Promo' },
        { role: 'button', name: 'Drop A' },
      ],
      action: {
        type: 'drag',
        fromRef: 'e1',
        fromTarget: { role: 'button', name: 'Card' },
        toRef: 'e2',
        toTarget: { role: 'button', name: 'Drop A' },
      },
      lostRef: 'e2',
    })

    const seedTargets = seed.steps[0]?.action?.targets ?? {}
    expect(Object.keys(seedTargets).sort()).toEqual(['fromRef', 'toRef'])
    expect(seedTargets['fromRef']?.name).toBe('Card')
    expect(seedTargets['toRef']?.name).toBe('Drop A')

    const payload = await authoredBody(seed)
    const targets = payload?.steps[0]?.action.targets ?? {}
    expect(Object.keys(targets).sort()).toEqual(['fromRef', 'toRef'])
    expect(targets['fromRef']).toMatchObject({ role: 'button', name: 'Card' })
    expect(targets['toRef']).toMatchObject({ role: 'button', name: 'Drop A' })
  })
})

describe('declared secrets in curated candidates', () => {
  const DECLARED = 'Hunter-42-zz'
  const EMAIL = 'qa@example.com'
  const PAGE = 'https://shop.example/account'

  function declaredMask(): (text: string) => string {
    const redactor = new SecretRedactor(new SecretStore({ ACCOUNT_PASSWORD: DECLARED }))
    return (text) => redactor.redactString(text)
  }

  function maskStep(input: {
    stepIndex: number
    stepText: string
    ref: string
    name: string
    assertOutcome?: StepEvidence['assertOutcome']
  }): StepEvidence {
    const state = { ...guardrailScreen([guardrailElement(input.ref, input.name)]), url: PAGE }
    return {
      ...guardrailStep({
        stepIndex: input.stepIndex,
        stepText: input.stepText,
        ref: input.ref,
        name: input.name,
      }),
      subActions: [{
        plan: `Use ${input.ref}`,
        plannedAction: { type: 'click', ref: asRef(input.ref) },
        stateBefore: state,
        stateAfter: state,
        result: { success: true },
      }],
      ...(input.assertOutcome === undefined ? {} : { assertOutcome: input.assertOutcome }),
    }
  }

  function maskRun(runId: string, steps: StepEvidence[]): CompletedRunHandoff {
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId(runId),
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: [{
        testId: 'account::sign-in',
        testName: 'Sign in',
        testIndex: 0,
        outcome: 'passed',
        steps,
        filePath: 'account.spec.yaml',
      }],
    }
  }

  function queuedPayloads(knowledgeRoot: string, reports: EmitReport[]): CurationCandidatePayload[] {
    return reports.flatMap((report) => report.details).map((detail) => {
      if (detail.candidateId === undefined) throw new Error(`candidate not queued: ${detail.outcome.kind}`)
      return curationCandidatePayloadSchema.parse(JSON.parse(readFileSync(
        join(queuedCandidateDir(knowledgeRoot, detail.candidateId), 'payload.json'),
        'utf8',
      )))
    })
  }

  it('the curation tail masks candidate prose with the mask it is handed', async () => {
    const handoff = maskRun('r-curation-tail', [
      maskStep({
        stepIndex: 0,
        stepText: `Sign in as ${EMAIL} with ${DECLARED}`,
        ref: 'account',
        name: `Account ${EMAIL} ${DECLARED}`,
      }),
      maskStep({ stepIndex: 1, stepText: 'Open the orders page', ref: 'orders', name: 'Orders' }),
    ])
    const root = mkdtempSync(join(tmpdir(), 'curation-'))
    try {
      const agentQaRoot = join(root, '.agent-qa')
      const knowledgeRoot = join(root, 'agent-qa-knowledge')
      const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(String(handoff.runId)))
      mkdirSync(runDir, { recursive: true })
      const reports: EmitReport[] = []
      await runCurationTail({
        runId: String(handoff.runId),
        agentQaRoot,
        knowledgeConfig: { dir: 'agent-qa-knowledge' },
        configDir: root,
        mask: declaredMask(),
        log: { warn: () => undefined },
        authority: { leaseId: 'lease', epoch: 1 },
        operations: {
          loadCompletedRunHandoff: () => handoff,
          resolveKnowledgeRoot: () => knowledgeRoot,
          listCompletedRunDirs: () => [runDir],
          readCurationTailReceipt: () => undefined,
          writeCurationTailReceipt: () => undefined,
          emitCurationCandidates: (options) => {
            const report = emitCurationCandidates(options)
            reports.push(report)
            return report
          },
          openKnowledgeReader: () => ({ emitCanaryOutcome: () => undefined }) as never,
          emitCanaryOutcomes: async () => ({ emitted: 0, refused: 0, unresolved: 0 }) as never,
          foldRunOutcomes: () => { throw new Error('not under test') },
          reconcileRunOutcomesProjection: () => ({ kind: 'current' }) as never,
          drainQueue: async () => { throw new Error('not under test') },
        },
      })

      const procedure = queuedPayloads(knowledgeRoot, reports).find((row) => row.kind === 'procedure')
      if (procedure === undefined) throw new Error('expected a queued procedure candidate')
      const seed = parseProcedureTrajectorySeed(procedure.bodySeed)
      const maskedText = `Sign in as ${EMAIL} with [secret:ACCOUNT_PASSWORD]`
      expect(seed?.steps[0]?.instruction).toBe(maskedText)
      expect(procedure.distilledObservations[0]?.step.naturalKey).toBe(maskedText)
      expect(procedure.distilledObservations[1]?.flow?.precedes).toBe(maskedText)
      expect(procedure.summarySeed).toContain(maskedText)
      expect(seed?.steps[0]?.action?.targets['ref']?.name)
        .toBe(`Account ${EMAIL} [secret:ACCOUNT_PASSWORD]`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a passed assertValue's measurement seed carries the declared marker", () => {
    const handoff = maskRun('r-measurement', [
      maskStep({
        stepIndex: 0,
        stepText: 'Check the stored session note',
        ref: 'note',
        name: 'Session note',
        assertOutcome: {
          source: 'storage',
          op: 'contains',
          passed: true,
          expected: DECLARED,
          actual: `${DECLARED} for ${EMAIL}`,
        },
      }),
    ])
    const root = mkdtempSync(join(tmpdir(), 'measurement-'))
    try {
      const knowledgeRoot = join(root, 'agent-qa-knowledge')
      const runDir = join(root, 'runs', 'r-measurement')
      mkdirSync(runDir, { recursive: true })
      const report = emitCurationCandidates({
        handoff, runDir, knowledgeRoot, mask: declaredMask(),
      })
      const payloads = queuedPayloads(knowledgeRoot, [report])
      const measurement = payloads.find((row) =>
        row.anchors.some((anchor) => anchor.t === 'flow' && anchor.name === 'measurement:assert-value:storage'))
      if (measurement === undefined) throw new Error('expected an assert-value:storage measurement')
      expect(measurement.summarySeed)
        .toBe(`assert-value:storage measured as [secret:ACCOUNT_PASSWORD] for ${EMAIL}`)
      expect(measurement.bodySeed)
        .toBe(`Verified assert-value:storage value: [secret:ACCOUNT_PASSWORD] for ${EMAIL}.`)
      expect(payloads.length).toBeGreaterThan(1)
      expect(JSON.stringify(payloads)).not.toContain(DECLARED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a typed value that contains a declared value', () => {
  it('a typed value that only contains a declared value is never authored as the secret parameter', async () => {
    const redactor = new SecretRedactor(new SecretStore({ PW: 'hunter2' }))
    const handoff: CompletedRunHandoff = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId('r-gap2-author'),
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: [{
        testId: 'account::sign-in-extra',
        testName: 'Sign in with the extra suffix',
        testIndex: 0,
        outcome: 'passed',
        steps: [
          guardrailStep({
            stepIndex: 0,
            stepText: 'Open the sign-in form',
            ref: 'open',
            name: 'Sign in',
          }),
          guardrailStep({
            stepIndex: 1,
            stepText: 'Type the password',
            ref: 'password',
            name: 'Password',
            fillText: 'hunter2-extra',
          }),
        ],
        filePath: 'account.spec.yaml',
      }],
    }
    const [target] = projectCurationCandidates(handoff, (text) => redactor.redactString(text))
      .filter((row) => row.kind === 'procedure')
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    if (seed === undefined) throw new Error('expected a parseable trajectory seed')
    const proposal = JSON.stringify({
      candidates: [{
        flowName: seed.flowName,
        stepSpan: [0, 1],
        parameters: [],
        successAssertion: 'The password field holds the typed value',
      }],
    })

    const outcome = await author([proposal])(
      procedureJob({
        bodySeed: canonicalJson(seed),
        anchors: [
          { t: 'flow', name: seed.flowName },
          { t: 'page', route: F381451_PAGE },
        ],
      }),
      [],
    )
    if (outcome.kind !== 'authored') throw new Error(`expected authored outcome, got ${outcome.kind}`)
    const body = parseProcedureBody(addBundles(outcome.deltas)[0]!.body)

    expect(body?.steps[1]?.action.values['text']).not.toEqual({ param: 'PW' })
    expect(body?.steps[1]?.action.values['text']).toBe('[secret:PW]-extra')
    expect(body?.parameters.map((parameter) => parameter.name)).not.toContain('PW')
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })
})
