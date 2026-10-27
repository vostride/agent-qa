import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asRecordId,
  BundleOutcomeEventSchema,
  canonicalJson,
  normalizeAnchor,
  procedureParameterFillability,
  procedureSourceBinding,
  serializeProcedureBody,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleProvenance,
  type CurationAuthorship,
  type ProcedureSourceBinding,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  makeProcedureBodyPayloadFixture,
  makeProcedureBundleDraftFixture,
  makeScreenStateFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import { rebuildIndex } from '../../index-rebuild.js'
import {
  admitsProcedure,
  matchProcedure,
  type MatchProcedureInput,
  type ProcedureMatchCandidate,
} from '../get-procedure.js'
import { openKnowledgeReader } from '../reader.js'

const SIGN_IN_ANCHORS: Anchor[] = [
  { t: 'flow', name: 'Sign in flow' },
  { t: 'page', route: '/login' },
]

const CHECKOUT_ANCHORS: Anchor[] = [
  { t: 'flow', name: 'Checkout flow' },
  { t: 'page', route: '/checkout' },
]

const FULL_AUTHORSHIP: CurationAuthorship = {
  path: 'llm',
  model: { id: 'claude-sonnet-4' },
  executionContext: 'local-interactive',
}

const DEGRADED_AUTHORSHIP: CurationAuthorship = {
  path: 'llm-repaired',
  model: { id: 'claude-sonnet-4' },
  executionContext: 'local-interactive',
}

const FLOOR_AUTHORSHIP: CurationAuthorship = {
  path: 'deterministic-fallback',
  executionContext: 'local-interactive',
}

function confirmedEvents(count: number, key: string): BundleOutcomeEvent[] {
  return Array.from({ length: count }, (_, index) =>
    BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: `confirm-${key}-${index}`,
      curationJobId: `job-${key}-${index}`,
      buildOrdinal: 10 + index,
    }))
}

function creationJobId(key: string): string {
  return `job-${key}-creation`
}

function creationEvent(key: string): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type: 'confirmed',
    evidenceToken: `confirm-${key}-creation`,
    curationJobId: creationJobId(key),
    buildOrdinal: 9,
  })
}

function procedureEvents(organicConfirmations: number, key: string): BundleOutcomeEvent[] {
  return [creationEvent(key), ...confirmedEvents(organicConfirmations, key)]
}

function deprecatedEvent(key: string): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type: 'deprecated',
    evidenceToken: `deprecate-${key}`,
    curationJobId: `job-deprecate-${key}`,
    buildOrdinal: 12,
    reason: 'matcher fixture',
  })
}

function runLinkedProvenance(options: {
  authorship?: CurationAuthorship
  curationJobId?: string
  withheld?: boolean
} = {}): BundleProvenance {
  return {
    schemaVersion: 1,
    mode: 'run-linked',
    originClass: 'agent-verified',
    runId: 'run-matcher',
    testId: 'test-matcher',
    stepIndex: 0,
    ...(options.curationJobId === undefined
      ? {}
      : { curationJobId: options.curationJobId }),
    ...(options.authorship === undefined ? {} : { authorship: options.authorship }),
    ...(options.withheld === true ? { withheld: true } : {}),
  }
}

interface CandidateOptions {
  id: string
  kind?: string
  status?: string
  validity?: string
  anchors?: Anchor[]
  summary?: string
  body?: string
  events?: BundleOutcomeEvent[]
  authorship?: CurationAuthorship
  curationJobId?: string
  withheld?: boolean
}

function candidate(options: CandidateOptions): ProcedureMatchCandidate {
  const anchors = options.anchors ?? SIGN_IN_ANCHORS
  const summary = options.summary ?? 'Sign in with recorded credentials'
  return {
    entry: {
      id: asRecordId(options.id),
      kind: options.kind ?? 'procedure',
      title: summary,
      summary,
      trust: 0.6,
      anchors: anchors.map(normalizeAnchor),
      status: options.status ?? 'candidate',
      servedAsCanary: false,
      scope: { tier: 'product', key: 'matcher-store' },
      validity: options.validity ?? 'current',
    },
    bundle: {
      summary,
      body: options.body ?? serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      events: options.events ?? procedureEvents(2, options.id),
      provenance: runLinkedProvenance({
        authorship: options.authorship ?? FULL_AUTHORSHIP,
        curationJobId: options.curationJobId ?? creationJobId(options.id),
        ...(options.withheld === true ? { withheld: true } : {}),
      }),
    },
  }
}

/**
 * Builds capability entries through the real sanitizer (raw values in, name + capability
 * bits out) so fixtures exercise procedureSourceBinding exactly as the loop assembler does.
 */
function sourceEntries(values: Record<string, unknown>): ProcedureSourceBinding[] {
  return Object.entries(values)
    .map(([name, raw]) => procedureSourceBinding(name, raw))
    .filter((entry): entry is ProcedureSourceBinding => entry !== undefined)
}

function matchInput(
  entries: readonly ProcedureMatchCandidate[],
  overrides: Partial<Omit<MatchProcedureInput, 'entries'>> = {},
): MatchProcedureInput {
  return {
    entries,
    intent: 'sign in',
    anchors: SIGN_IN_ANCHORS,
    availability: {
      variables: sourceEntries({ email: 'user@example.test' }),
      memory: [],
      secrets: ['password'],
    },
    ...overrides,
  }
}

describe('matchProcedure kind-aware admission', () => {
  it('matches a candidate-status procedure with open validity', () => {
    const match = matchProcedure(matchInput([candidate({ id: 'proc-open' })]))

    expect(match?.id).toBe('proc-open')
  })

  /**
   * G-381-4: the same predicate is the read face's admission wall (reader.ts
   * findReadableBundle). Pinning it directly keeps the two faces from diverging again — every
   * row below is exactly a row of the matcher's own admission table above.
   */
  it('exports one admission predicate whose walls the read face inherits verbatim', () => {
    expect(admitsProcedure(candidate({ id: 'proc-admitted' }))).toBe(true)
    expect(admitsProcedure(candidate({ id: 'proc-admitted-active', status: 'active' }))).toBe(true)
    expect(admitsProcedure(candidate({ id: 'proc-wall-withheld', withheld: true }))).toBe(false)
    expect(admitsProcedure(candidate({ id: 'proc-wall-closed', validity: '10:12' }))).toBe(false)
    expect(admitsProcedure(candidate({
      id: 'proc-wall-deprecated',
      events: [...confirmedEvents(2, 'proc-wall-deprecated'), deprecatedEvent('proc-wall-deprecated')],
    }))).toBe(false)
    expect(admitsProcedure(candidate({ id: 'fact-wall', kind: 'fact' }))).toBe(false)
    expect(admitsProcedure(candidate({ id: 'caution-wall', kind: 'caution' }))).toBe(false)
    expect(admitsProcedure(candidate({ id: 'proc-wall-superseded', status: 'superseded' }))).toBe(false)
  })

  it('never matches a withheld candidate procedure', () => {
    expect(
      matchProcedure(matchInput([candidate({ id: 'proc-withheld', withheld: true })])),
    ).toBeUndefined()
  })

  it('never matches a user-deprecated candidate procedure', () => {
    const deprecated = candidate({
      id: 'proc-deprecated',
      events: [...confirmedEvents(2, 'proc-deprecated'), deprecatedEvent('proc-deprecated')],
    })

    expect(matchProcedure(matchInput([deprecated]))).toBeUndefined()
  })

  it('never matches a closed-validity candidate procedure', () => {
    expect(
      matchProcedure(matchInput([candidate({ id: 'proc-closed', validity: '10:12' })])),
    ).toBeUndefined()
  })

  it('never surfaces fact or caution candidates through the procedure channel', () => {
    expect(
      matchProcedure(matchInput([
        candidate({ id: 'fact-candidate', kind: 'fact' }),
        candidate({ id: 'caution-candidate', kind: 'caution' }),
      ])),
    ).toBeUndefined()
  })

  it('admits an active-status procedure (impossible in M2 but total)', () => {
    const match = matchProcedure(matchInput([candidate({ id: 'proc-active', status: 'active' })]))

    expect(match?.id).toBe('proc-active')
  })
})

describe('matchProcedure anchor matching', () => {
  it('returns the procedure whose normalized flow/page anchors overlap the screen anchors', () => {
    const store = [
      candidate({ id: 'proc-sign-in' }),
      candidate({
        id: 'proc-checkout',
        anchors: CHECKOUT_ANCHORS,
        summary: 'Checkout with saved cart',
      }),
    ]

    const match = matchProcedure(matchInput(store, {
      anchors: [{ t: 'page', route: '/login' }],
    }))

    expect(match?.id).toBe('proc-sign-in')
  })

  it('judges anchor equality on normalizeAnchor output, never raw strings', () => {
    const match = matchProcedure(matchInput([candidate({ id: 'proc-normalized' })], {
      anchors: [{ t: 'page', route: '/Login/#fragment' }],
    }))

    expect(match?.id).toBe('proc-normalized')
  })

  it('returns undefined when no anchors overlap', () => {
    expect(
      matchProcedure(matchInput([candidate({ id: 'proc-elsewhere' })], {
        anchors: [{ t: 'page', route: '/settings' }],
      })),
    ).toBeUndefined()
  })

  it('F-381-67-1 fixture invariant: current-target intent retains the same replay match', () => {
    const ladderAnchors: Anchor[] = [
      { t: 'flow', name: 't_posing-clock-inject-pill-adds-ima-rename-video-emu-fault' },
      { t: 'page', route: 'http://127.0.0.1:8931/form.html' },
    ]
    const basePayload = makeProcedureBodyPayloadFixture()
    const firstStep = basePayload.steps[0]!
    const entries = [candidate({
      id: 'proc-current-target-invariant',
      anchors: ladderAnchors,
      summary: 'Submit the local form as a returning user',
      body: serializeProcedureBody({
        ...basePayload,
        parameters: [{ name: 'PROBE_USER', type: 'string', required: true }],
        steps: [{
          ...firstStep,
          action: {
            ...firstStep.action,
            values: { text: { param: 'PROBE_USER' } },
          },
        }],
      }),
    })]
    const availability = {
      variables: sourceEntries({ PROBE_USER: 'available' }),
      memory: [],
      secrets: [],
    }
    const canonicalIntent = 'Type "{{env:PROBE_USER}}" into the Username field'
    const currentTargetIntent = 'Type "{{env:PROBE_USER}}" into the Account name field'

    const canonicalMatch = matchProcedure({
      entries,
      intent: canonicalIntent,
      anchors: ladderAnchors,
      availability,
    })
    const currentTargetMatch = matchProcedure({
      entries,
      intent: currentTargetIntent,
      anchors: ladderAnchors,
      availability,
    })

    expect(canonicalIntent.replace('Username', 'Account name')).toBe(currentTargetIntent)
    expect(canonicalIntent.split('Username')).toEqual(currentTargetIntent.split('Account name'))
    expect(canonicalMatch).toEqual(currentTargetMatch)
    expect(canonicalMatch?.id).toBe('proc-current-target-invariant')
    expect(currentTargetMatch?.id).toBe('proc-current-target-invariant')
    expect(canonicalMatch?.replayRecommendation).toBe('replay')
    expect(currentTargetMatch?.replayRecommendation).toBe('replay')

    expect(matchProcedure({
      entries,
      intent: currentTargetIntent,
      anchors: [],
      availability,
    })).toBeUndefined()
  })
})

describe('matchProcedure tier x confirmations x fillability fold', () => {
  it('keeps full tier with one organic confirmation below the replay bar as hint', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-full-one-organic',
        events: procedureEvents(1, 'proc-full-one-organic'),
      }),
    ]))

    expect(match?.authoringModelTier).toBe('full')
    expect(match?.replayRecommendation).toBe('hint')
  })

  it('recommends replay for full tier at two organic confirmations', () => {
    const match = matchProcedure(matchInput([
      candidate({ id: 'proc-full', events: procedureEvents(2, 'proc-full') }),
    ]))

    expect(match?.authoringModelTier).toBe('full')
    expect(match?.replayRecommendation).toBe('replay')
  })

  it('keeps degraded tier at three organic confirmations below its replay bar as hint', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-degraded',
        authorship: DEGRADED_AUTHORSHIP,
        events: procedureEvents(3, 'proc-degraded'),
      }),
    ]))

    expect(match?.authoringModelTier).toBe('degraded')
    expect(match?.replayRecommendation).toBe('hint')
  })

  it('recommends replay for degraded tier at four organic confirmations', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-degraded-confirmed',
        authorship: DEGRADED_AUTHORSHIP,
        events: procedureEvents(4, 'proc-degraded-confirmed'),
      }),
    ]))

    expect(match?.replayRecommendation).toBe('replay')
  })

  it('counts every surviving confirmation when no event matches the current provenance job', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-superseded-lineage',
        events: procedureEvents(1, 'proc-prior-lineage'),
      }),
    ]))

    expect(match?.replayRecommendation).toBe('replay')
  })

  it('keeps floor tier hint-only regardless of confirmations', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-floor',
        authorship: FLOOR_AUTHORSHIP,
        events: procedureEvents(6, 'proc-floor'),
      }),
    ]))

    expect(match?.authoringModelTier).toBe('floor')
    expect(match?.replayRecommendation).toBe('hint')
  })

  it('downranks a qualified match to hint when one required parameter is unfillable', () => {
    const match = matchProcedure(matchInput([
      candidate({
        id: 'proc-unfillable',
        body: serializeProcedureBody(makeProcedureBodyPayloadFixture({
          parameters: [
            { name: 'email', type: 'string', required: true },
            { name: 'otp', type: 'string', required: true },
          ],
        })),
      }),
    ]))

    expect(match?.replayRecommendation).toBe('hint')
  })

  it('downranks a secret parameter advertised only by the variables source', () => {
    const store = [candidate({ id: 'proc-secret-source' })]
    const sourceCorrect = matchProcedure({
      ...matchInput(store),
      availability: {
        variables: sourceEntries({ email: 'user@example.test' }),
        memory: [],
        secrets: ['password'],
      },
    })
    const variableOnly = matchProcedure({
      ...matchInput(store),
      availability: {
        variables: sourceEntries({ email: 'user@example.test', password: 'hunter2' }),
        memory: [],
        secrets: [],
      },
    })

    expect(sourceCorrect?.replayRecommendation).toBe('replay')
    expect(variableOnly?.replayRecommendation).toBe('hint')
    expect(variableOnly?.confidence).toBeCloseTo((sourceCorrect?.confidence ?? 0) * 0.5)
  })

  it('downranks a referenced optional parameter when every source is missing it', () => {
    const payload = makeProcedureBodyPayloadFixture()
    const store = [candidate({
      id: 'proc-optional-referenced',
      body: serializeProcedureBody({
        ...payload,
        parameters: [{ name: 'email', type: 'string', required: false }],
        steps: [payload.steps[0]!],
      }),
    })]
    const sourceCorrect = matchProcedure({
      ...matchInput(store),
      availability: {
        variables: sourceEntries({ email: 'user@example.test' }),
        memory: [],
        secrets: [],
      },
    })
    const missing = matchProcedure({
      ...matchInput(store),
      availability: { variables: [], memory: [], secrets: [] },
    })

    expect(sourceCorrect?.replayRecommendation).toBe('replay')
    expect(missing?.replayRecommendation).toBe('hint')
    expect(missing?.confidence).toBeCloseTo((sourceCorrect?.confidence ?? 0) * 0.5)
  })

  it.each([
    { type: 'number' as const, name: 'clickDelay' },
    { type: 'boolean' as const, name: 'submitNow' },
  ])('downranks a secret-only $type parameter and re-admits it from variables', ({
    type,
    name,
  }) => {
    const base = makeProcedureBodyPayloadFixture()
    const firstStep = base.steps[0]!
    const payload = {
      ...base,
      parameters: [{ name, type, required: true }],
      steps: [{
        ...firstStep,
        action: {
          ...firstStep.action,
          values: { value: { param: name } },
        },
      }],
    }
    const store = [candidate({
      id: `proc-secret-only-${type}`,
      body: serializeProcedureBody(payload),
    })]
    const secretOnlyAvailability = {
      variables: [],
      memory: [],
      secrets: [name],
    }
    const variableAvailability = {
      variables: sourceEntries({ [name]: type === 'number' ? '42' : 'true' }),
      memory: [],
      secrets: [],
    }

    // WR-01 mirrored truth-table pin: the shared helper reports the typed slot unfillable,
    // and the matcher turns that exact verdict into a hint rather than a replay recommendation.
    expect(procedureParameterFillability(payload, secretOnlyAvailability)).toEqual({
      fillable: false,
      unfillable: [name],
    })
    const secretOnly = matchProcedure(matchInput(store, {
      availability: secretOnlyAvailability,
    }))
    const variableBacked = matchProcedure(matchInput(store, {
      availability: variableAvailability,
    }))

    expect(secretOnly?.replayRecommendation).toBe('hint')
    expect(variableBacked?.replayRecommendation).toBe('replay')
    expect(secretOnly?.confidence).toBeCloseTo((variableBacked?.confidence ?? 0) * 0.5)
  })

  // The verifier's PROC-01 counterexamples: a replay-earning procedure (full tier at the
  // replay bar) whose only source for a typed required parameter is value-incapable must be
  // downranked to hint — recommending a replay the binder deterministically aborts as
  // parameter-unbound is the falsified behavior these rows keep dead.
  it.each([
    {
      caseName: 'number: a number-incapable source downranks earned replay to hint',
      type: 'number' as const,
      name: 'delay',
      incapableRaw: 'not-a-number',
      capableRaw: '250',
    },
    {
      caseName: 'boolean: a non-canonical casing downranks earned replay to hint (exact lowercase canon)',
      type: 'boolean' as const,
      name: 'autoRenew',
      incapableRaw: 'True',
      capableRaw: 'false',
    },
  ])('$caseName', ({ type, name, incapableRaw, capableRaw }) => {
    const base = makeProcedureBodyPayloadFixture()
    const firstStep = base.steps[0]!
    const payload = {
      ...base,
      parameters: [{ name, type, required: true }],
      steps: [{
        ...firstStep,
        action: {
          ...firstStep.action,
          values: { value: { param: name } },
        },
      }],
    }
    const store = [candidate({
      id: `proc-typed-${type}`,
      body: serializeProcedureBody(payload),
    })]

    const incapable = matchProcedure(matchInput(store, {
      availability: {
        variables: sourceEntries({ [name]: incapableRaw }),
        memory: [],
        secrets: [],
      },
    }))
    const capable = matchProcedure(matchInput(store, {
      availability: {
        variables: sourceEntries({ [name]: capableRaw }),
        memory: [],
        secrets: [],
      },
    }))

    expect(incapable?.replayRecommendation).toBe('hint')
    expect(capable?.replayRecommendation).toBe('replay')
    expect(incapable?.confidence).toBeCloseTo((capable?.confidence ?? 0) * 0.5)
  })
})

describe('matchProcedure empty edges', () => {
  it('returns undefined against an empty store', () => {
    expect(matchProcedure(matchInput([]))).toBeUndefined()
  })

  it('downranks required-parameter procedures to hint when availability is empty', () => {
    const match = matchProcedure(matchInput([candidate({ id: 'proc-no-bindings' })], {
      availability: { variables: [], memory: [], secrets: [] },
    }))

    expect(match?.replayRecommendation).toBe('hint')
  })

  it('still recommends replay when an unavailable optional declaration is unreferenced', () => {
    const payload = makeProcedureBodyPayloadFixture()
    const match = matchProcedure(matchInput([candidate({
      id: 'proc-optional-unreferenced',
      body: serializeProcedureBody({
        ...payload,
        parameters: [
          ...payload.parameters,
          { name: 'otp', type: 'string', required: false },
        ],
      }),
    })]))

    expect(match?.replayRecommendation).toBe('replay')
  })
})

describe('matchProcedure determinism', () => {
  it('produces identical ProcedureMatch bytes for identical stores and inputs', () => {
    const buildStore = (): ProcedureMatchCandidate[] => [
      candidate({ id: 'proc-a' }),
      candidate({
        id: 'proc-b',
        anchors: CHECKOUT_ANCHORS,
        summary: 'Checkout with saved cart',
      }),
    ]

    const first = matchProcedure(matchInput(buildStore()))
    const second = matchProcedure(matchInput(buildStore()))

    expect(first).toBeDefined()
    expect(canonicalJson(first)).toBe(canonicalJson(second))
  })

  it('breaks equal-score ties by record id', () => {
    const match = matchProcedure(matchInput([
      candidate({ id: 'proc-tie-b', events: confirmedEvents(2, 'tie') }),
      candidate({ id: 'proc-tie-a', events: confirmedEvents(2, 'tie') }),
    ]))

    expect(match?.id).toBe('proc-tie-a')
  })
})

describe('servingReader getProcedure end-to-end', () => {
  const PRODUCT = 'fixture-storefront'
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = join(tmpdir(), `get-procedure-reader-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedProcedure(): RecordId {
    const outcome = publishBundle({
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'get-procedure-test',
    }, {
      draft: makeProcedureBundleDraftFixture(),
      discriminant: {
        kind: 'procedure',
        flowName: 'Sign in flow',
        stepSignature: 'email>password>submit',
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents: procedureEvents(2, 'served'),
      relations: [],
      provenance: runLinkedProvenance({
        authorship: FULL_AUTHORSHIP,
        curationJobId: creationJobId('served'),
      }),
      artifacts: [],
      evidenceMarkdown: 'Evidence for the sign-in procedure.\n',
    })
    if (outcome.kind !== 'published') {
      throw new Error(`expected published procedure bundle, got ${outcome.kind}`)
    }
    return outcome.id
  }

  it('serves a temp-store committed procedure bundle with the pinned shape', async () => {
    const id = seedProcedure()
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const match = reader.getProcedure(
      'sign in',
      makeScreenStateFixture(),
      {
        variables: sourceEntries({ email: 'user@example.test' }),
        memory: [],
        secrets: ['password'],
      },
    )

    expect(match).toMatchObject({
      id,
      flowAnchor: normalizeAnchor({ t: 'flow', name: 'Sign in flow' }),
      authoringModelTier: 'full',
      replayRecommendation: 'replay',
      parameterSchema: [
        { name: 'email', type: 'string', required: true },
        { name: 'password', type: 'secret', required: true },
      ],
    })
    expect(match?.confidence).toBeGreaterThanOrEqual(0.5)
  })

  it('returns the domain-neutral miss against a store without procedures', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(
      reader.getProcedure('sign in', makeScreenStateFixture(), {
        variables: sourceEntries({ email: 'user@example.test' }),
        memory: [],
        secrets: ['password'],
      }),
    ).toBeUndefined()
  })

  it('treats absent availability as empty: required-param procedures downrank to hint', async () => {
    seedProcedure()
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const match = reader.getProcedure('sign in', makeScreenStateFixture())

    expect(match?.replayRecommendation).toBe('hint')
  })
})
