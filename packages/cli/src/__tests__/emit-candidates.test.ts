import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  candidateContentAddress,
  curationCandidatePayloadSchema,
  curationCandidateProjectionSchema,
  openKnowledgeReader,
  rebuildIndex,
  queuedCandidateDir,
  type CurationCandidatePayload,
  type EnqueueCurationCandidateProjectionOptions,
  type EnqueueCurationCandidateProjectionOutcome,
} from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asEvidenceToken,
  asRef,
  asRunId,
  canonicalJson,
  elementOrdinal,
  normalizeAnchor,
  type CompletedRunHandoff,
  type ElementInfo,
  type PerTestOutcome,
  type ScreenState,
  type StepEvidence,
  type SubActionEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const queueSpy = vi.hoisted(() => ({
  aliasCalls: [] as EnqueueCurationCandidateProjectionOptions[],
  projectionCalls: [] as EnqueueCurationCandidateProjectionOptions[],
  nextProjectionOutcome: undefined as
    | EnqueueCurationCandidateProjectionOutcome
    | undefined,
}))

vi.mock('@vostride/agent-qa-knowledge-local', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@vostride/agent-qa-knowledge-local')
  >()
  return {
    ...actual,
    enqueueCurationCandidate: vi.fn(
      (options: EnqueueCurationCandidateProjectionOptions) => {
        queueSpy.aliasCalls.push(options)
        throw new Error('projection alias must not replace the explicit emitter entry')
      },
    ),
    enqueueCurationCandidateProjection: vi.fn(
      (options: EnqueueCurationCandidateProjectionOptions) => {
        queueSpy.projectionCalls.push(options)
        if (queueSpy.nextProjectionOutcome !== undefined) {
          const outcome = queueSpy.nextProjectionOutcome
          queueSpy.nextProjectionOutcome = undefined
          return outcome
        }
        return actual.enqueueCurationCandidateProjection(options)
      },
    ),
  }
})

import {
  emitCurationCandidates,
  LEARNABLE_CAUTION_ROOT_CAUSES,
  parseProcedureTrajectorySeed,
  projectCurationCandidates,
} from '../curation/emit-candidates.js'

const ARTIFACT_SHA = 'a'.repeat(64)

function element(ref: string, name: string, attributes: Record<string, string> = {}): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: { ariaLabel: name },
    attributes,
  }
}

function screen(elements: ElementInfo[], url = 'https://shop.example/cart'): ScreenState {
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
    url,
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: {
        offsetX: 0,
        offsetY: 0,
        contentWidth: 1_280,
        contentHeight: 1_440,
      },
    },
  }
}

function subAction(
  elements: ElementInfo[],
  ref?: string,
  afterUrl = 'https://shop.example/cart',
  artifactSha = ARTIFACT_SHA,
): SubActionEvidence {
  const stateBefore = screen(elements)
  return {
    plan: ref === undefined ? 'Inspect the current page' : `Use ${ref}`,
    plannedAction:
      ref === undefined
        ? { type: 'navigate', to: 'reload' }
        : { type: 'click', ref: asRef(ref) },
    stateBefore,
    stateAfter: screen(elements, afterUrl),
    result: { success: true },
    decisionScreenshotRef: { id: `decision-screenshot:${artifactSha}`, sha: artifactSha },
  }
}

function step(
  overrides: Partial<StepEvidence> = {},
  subActions: SubActionEvidence[] = [
    subAction([element('checkout', 'Checkout', { 'data-testid': 'checkout' })], 'checkout'),
  ],
): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'Open checkout',
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
    subActions,
    verifierVerdict: { pass: true, reasoning: 'Checkout opened' },
    ...overrides,
  }
}

function rootCause(kind: Verdict['class'], testIndex: number): Verdict {
  return {
    class: kind,
    producer: 'deterministic-classifier',
    confidence: 1,
    evidence: {
      citedSteps: [0],
      citedAnchors: [{ t: 'flow', name: `failure-${kind}` }],
      citedArtifacts: [],
      rationale: `${kind} failure`,
    },
    memoryMisdirectionRuledOut: true,
    perTest: testIndex,
  }
}

function testOutcome(
  overrides: Partial<PerTestOutcome> = {},
  steps: StepEvidence[] = [step()],
): PerTestOutcome {
  return {
    testId: 'checkout::happy-path',
    testName: 'Checkout happy path',
    testIndex: 0,
    outcome: 'passed',
    steps,
    ...overrides,
    filePath: overrides.filePath ?? 'checkout.spec.yaml',
  }
}

function handoff(
  tests: PerTestOutcome[] = [testOutcome()],
  overrides: Partial<CompletedRunHandoff> = {},
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-emit-1'),
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests,
    ...overrides,
  }
}

describe('projectCurationCandidates', () => {
  it('projects one PASS-verified resolved element into a selector fact and observation', () => {
    const [candidate] = projectCurationCandidates(handoff())

    expect(candidate).toMatchObject({
      kind: 'fact',
      subtype: 'selector',
      executionContext: 'local-interactive',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      attributingObservationId: 'run-emit-1:test-0:step-0',
    })
    expect(candidate).not.toHaveProperty('candidateId')
    expect(candidate).not.toHaveProperty('artifactInventory')
    expect(candidate?.distilledObservations).toEqual([
      expect.objectContaining({
        step: { naturalKey: 'run-emit-1:test-0:step-0', ordinal: 0 },
        platform: 'web',
        test: { id: 'checkout::happy-path' },
        element: { naturalKey: 'button:checkout:0' },
        locator: { selector: '[data-testid="checkout"]' },
        observedAtOrdinal: 42,
      }),
    ])
  })

  it('carries closed artifact descriptors and no captured field values', () => {
    const password = {
      ...element('password', 'Account password', { type: 'password' }),
      role: 'textbox',
      value: 'correct horse battery staple',
    }
    const evidence = subAction([password], 'password')
    evidence.artifactRefs = [
      { id: `dom-snapshot:${'b'.repeat(64)}`, sha: 'b'.repeat(64) },
      { id: `ax-snapshot:${'c'.repeat(64)}`, sha: 'c'.repeat(64) },
      { id: `trace:${'d'.repeat(64)}`, sha: 'd'.repeat(64) },
    ]

    const [candidate] = projectCurationCandidates(
      handoff([testOutcome({}, [step({}, [evidence])])]),
    )

    // the projection no longer copies element values or interactions.
    expect(JSON.stringify(candidate)).not.toContain('correct horse battery staple')
    expect(candidate?.artifactDescriptors).toEqual([
      {
        ref: evidence.decisionScreenshotRef,
        stepIndex: 0,
        role: 'screenshot',
        originalName: 'decision-screenshot.png',
      },
      {
        ref: evidence.artifactRefs[0],
        stepIndex: 0,
        role: 'dom-snapshot',
        originalName: 'dom-snapshot.json',
      },
      {
        ref: evidence.artifactRefs[1],
        stepIndex: 0,
        role: 'ax-snapshot',
        originalName: 'ax-snapshot.json',
      },
      {
        ref: evidence.artifactRefs[2],
        stepIndex: 0,
        role: 'opaque-evidence',
        originalName: 'opaque-evidence.bin',
      },
    ])
    expect(candidate?.artifactDescriptors.every((descriptor) => !('bytes' in descriptor)))
      .toBe(true)
  })

  it('enforces PASS plus exactly one resolved element for leaf facts', () => {
    const first = element('first', 'First')
    const second = element('second', 'Second')
    const zeroResolved = step({}, [subAction([first])])
    const multipleResolved = step({}, [
      subAction([first, second], 'first'),
      subAction([first, second], 'second'),
    ])
    const failed = step({ verifierVerdict: { pass: false, reasoning: 'Did not open' } })

    for (const candidateHandoff of [
      handoff([testOutcome({}, [zeroResolved])]),
      handoff([testOutcome({}, [multipleResolved])]),
      handoff([testOutcome({ outcome: 'failed' }, [failed])]),
    ]) {
      expect(projectCurationCandidates(candidateHandoff).filter((row) => row.kind === 'fact'))
        .toEqual([])
    }
  })

  it('projects verified reported and asserted values as measurement facts', () => {
    const reported = step(
      { reportedValue: { value: '187 ms' } },
      [subAction([], undefined)],
    )
    const asserted = step(
      {
        stepIndex: 1,
        stepText: 'Check the cart count',
        assertOutcome: {
          source: 'storage',
          op: 'equals',
          expected: '3',
          actual: '3',
          passed: true,
        },
      },
      [subAction([], undefined)],
    )

    const candidates = projectCurationCandidates(
      handoff([testOutcome({}, [reported, asserted])]),
    ).filter((row) => row.subtype === 'measurement')

    expect(candidates).toHaveLength(2)
    expect(candidates.map((row) => row.bodySeed)).toEqual([
      expect.stringContaining('187 ms'),
      expect.stringContaining('3'),
    ])
  })

  it('mints cautions only for the bounded deterministic root-cause classes', () => {
    expect(LEARNABLE_CAUTION_ROOT_CAUSES).toEqual(['environment', 'timeout', 'flake'])
    const learnable = LEARNABLE_CAUTION_ROOT_CAUSES.map((kind, index) =>
      testOutcome(
        {
          testId: `failure-${kind}`,
          testIndex: index,
          outcome: kind === 'flake' ? 'passed' : kind === 'timeout' ? 'timeout' : 'failed',
          rootCause: rootCause(kind, index),
        },
        [],
      ),
    )
    const cautionCandidates = projectCurationCandidates(handoff(learnable))
    expect(cautionCandidates).toHaveLength(3)
    expect(cautionCandidates.every((candidate) => candidate.kind === 'caution')).toBe(true)
    expect(cautionCandidates.map((candidate) => candidate.rootCauseClass)).toEqual([
      'environment',
      'timeout',
      'flake',
    ])
    expect(cautionCandidates.map((candidate) => candidate.bodySeed)).toEqual([
      'environment: environment failure',
      'timeout: timeout failure',
      'flake: flake failure',
    ])
    expect(cautionCandidates.map(
      (candidate) => candidate.distilledObservations[0]?.error?.rootCauseClass,
    )).toEqual(['environment', 'timeout', 'flake'])

    const unknownOnly = handoff([
      testOutcome(
        {
          outcome: 'failed',
          rootCause: rootCause('unknown', 0),
        },
        [],
      ),
    ])
    expect(projectCurationCandidates(unknownOnly)).toEqual([])
  })

  it('stamps handoff posture and bypass secrecy while remaining deeply deterministic', () => {
    const input = handoff(
      [testOutcome({}, [step({ cacheStatus: 'bypass' })])],
      { executionContext: 'ci' },
    )

    const first = projectCurationCandidates(input)
    const second = projectCurationCandidates(input)

    expect(second).toEqual(first)
    expect(first).not.toHaveLength(0)
    expect(first.every((candidate) => candidate.executionContext === 'ci')).toBe(true)
    // a cache-bypassed step no longer marks the candidate.
    expect(first.flatMap((candidate) => Object.keys(candidate))
      .filter((key) => key.endsWith('Flagged'))).toEqual([])
    for (const candidate of first) {
      expect(curationCandidateProjectionSchema.safeParse(candidate).success).toBe(true)
    }
    expect(first.every((candidate) => !('candidateId' in candidate))).toBe(true)
    expect(first.every((candidate) => !('artifactInventory' in candidate))).toBe(true)
  })

})

describe('projectProcedureTargets', () => {
  function flowStep(input: {
    stepIndex: number
    stepText: string
    ref: string
    name: string
    afterUrl?: string
    fillText?: string
    pass?: boolean
  }): StepEvidence {
    const el = element(input.ref, input.name)
    const evidence = subAction([el], input.ref, input.afterUrl)
    if (input.fillText !== undefined) {
      evidence.plannedAction = {
        type: 'fill',
        ref: asRef(input.ref),
        text: input.fillText,
        clearMode: 'replace',
        submit: false,
      }
    }
    return step(
      {
        stepIndex: input.stepIndex,
        stepText: input.stepText,
        ...(input.pass === false
          ? { verifierVerdict: { pass: false, reasoning: 'step failed' } }
          : {}),
      },
      [evidence],
    )
  }

  function signInSteps(): StepEvidence[] {
    return [
      flowStep({ stepIndex: 0, stepText: 'Open the sign-in page', ref: 'open-sign-in', name: 'Sign in' }),
      flowStep({
        stepIndex: 1,
        stepText: 'Enter the account email',
        ref: 'email',
        name: 'Email',
        fillText: 'user@example.com',
      }),
      flowStep({ stepIndex: 2, stepText: 'Submit the credentials', ref: 'submit', name: 'Submit' }),
    ]
  }

  it('targets exactly the verified-PASS multi-step trajectory with an ordered flow chain', () => {
    const failing = [
      flowStep({ stepIndex: 0, stepText: 'Open the cart', ref: 'cart', name: 'Cart' }),
      flowStep({ stepIndex: 1, stepText: 'Pay', ref: 'pay', name: 'Pay', pass: false }),
    ]
    const candidates = projectCurationCandidates(
      handoff([
        testOutcome({ testId: 'auth::sign-in', testIndex: 0 }, signInSteps()),
        testOutcome({ testId: 'cart::pay', testIndex: 1, outcome: 'failed' }, failing),
      ]),
    )
    const targets = candidates.filter((row) => row.kind === 'procedure')

    expect(targets).toHaveLength(1)
    const target = targets[0]!
    expect(target.anchors[0]).toEqual({ t: 'flow', name: 'auth::sign-in' })
    expect(target.distilledObservations.map((observation) => observation.step)).toEqual([
      { naturalKey: 'Open the sign-in page', ordinal: 0 },
      { naturalKey: 'Enter the account email', ordinal: 1 },
      { naturalKey: 'Submit the credentials', ordinal: 2 },
    ])
    expect(target.distilledObservations.map((observation) => observation.flow)).toEqual([
      { name: 'auth::sign-in' },
      { name: 'auth::sign-in', precedes: 'Open the sign-in page' },
      { name: 'auth::sign-in', precedes: 'Enter the account email' },
    ])
  })

  it('never targets single-step, zero-step, or skipped trajectories', () => {
    const candidates = projectCurationCandidates(
      handoff([
        testOutcome({ testId: 'edge::single', testIndex: 0 }, [
          flowStep({ stepIndex: 0, stepText: 'Only step', ref: 'only', name: 'Only' }),
        ]),
        testOutcome({ testId: 'edge::empty', testIndex: 1 }, []),
        testOutcome({ testId: 'edge::skipped', testIndex: 2, outcome: 'skipped' }, [
          flowStep({ stepIndex: 0, stepText: 'A', ref: 'a', name: 'A' }),
          flowStep({ stepIndex: 1, stepText: 'B', ref: 'b', name: 'B' }),
        ]),
      ]),
    )
    expect(candidates.filter((row) => row.kind === 'procedure')).toEqual([])
  })

  it('re-targets on every projection run with no repetition threshold', () => {
    const input = handoff([testOutcome({ testId: 'auth::sign-in' }, signInSteps())])
    const first = projectCurationCandidates(input)
      .filter((row) => row.kind === 'procedure')
    const second = projectCurationCandidates(input)
      .filter((row) => row.kind === 'procedure')
    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('carries a code-built trajectory seed whose slots label masked-secret sources', () => {
    const steps = signInSteps()
    steps[1] = flowStep({
      stepIndex: 1,
      stepText: 'Enter the account password',
      ref: 'password',
      name: 'Password',
      fillText: '[secret:ACCOUNT_PASSWORD]',
    })
    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::sign-in' }, steps)]),
    ).filter((row) => row.kind === 'procedure')

    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    expect(seed).toBeDefined()
    expect(seed?.flowName).toBe('auth::sign-in')
    expect(seed?.steps.map((entry) => entry.ordinal)).toEqual([0, 1, 2])
    const filled = seed?.steps[1]
    expect(filled?.action?.type).toBe('fill')
    expect(filled?.action?.targets['ref']).toMatchObject({
      role: 'button',
      nameNormalized: 'password',
    })
    expect(filled?.action?.values['text']).toEqual({
      observed: '[secret:ACCOUNT_PASSWORD]',
      source: 'masked-secret',
      sourceName: 'ACCOUNT_PASSWORD',
    })
    expect(filled?.action?.values['clearMode']).toEqual({
      observed: 'replace',
      source: 'literal',
    })
    expect(filled?.action?.values['submit']).toEqual({
      observed: false,
      source: 'literal',
    })
    expect(filled?.pageRoute).toBe('https://shop.example/cart')
  })

  it('preserves boolean and numeric action semantics as typed literal trajectory slots', () => {
    const steps = signInSteps()
    steps[1]!.subActions[0]!.plannedAction = {
      type: 'fill',
      ref: asRef('email'),
      text: 'user@example.com',
      clearMode: 'replace',
      submit: true,
    }
    steps[2]!.subActions[0]!.plannedAction = {
      type: 'scroll',
      mode: 'untilVisible',
      text: 'Order summary',
      ref: asRef('submit'),
      direction: 'down',
      maxSwipes: 4,
      retryOpposite: false,
    }
    const rawScroll = steps[2]!.subActions[0]!.plannedAction as unknown as Record<
      string,
      unknown
    >
    rawScroll['metadata'] = { source: 'fixture' }
    rawScroll['tags'] = ['fixture']
    rawScroll['nullable'] = null

    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'checkout::typed-scalars' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)

    expect(seed?.steps[1]?.action?.values['submit']).toEqual({
      observed: true,
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['maxSwipes']).toEqual({
      observed: 4,
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['retryOpposite']).toEqual({
      observed: false,
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['metadata']).toEqual({
      observed: { source: 'fixture' },
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['tags']).toEqual({
      observed: ['fixture'],
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['nullable']).toEqual({
      observed: null,
      source: 'literal',
    })
  })

  it('captures file lists and relative positions as literal composite trajectory slots', () => {
    const steps = signInSteps()
    steps[1]!.subActions[0]!.plannedAction = {
      type: 'fileUpload',
      ref: asRef('email'),
      files: ['a.png', 'b.pdf'],
    }
    steps[2]!.subActions[0]!.plannedAction = {
      type: 'doubleClick',
      ref: asRef('submit'),
      relativePosition: { x: 5, y: 7 },
    }

    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'checkout::composite-values' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)

    expect(seed?.steps[1]?.action?.values['files']).toEqual({
      observed: ['a.png', 'b.pdf'],
      source: 'literal',
    })
    expect(seed?.steps[2]?.action?.values['relativePosition']).toEqual({
      observed: { x: 5, y: 7 },
      source: 'literal',
    })
  })

  it.each([
    ['a non-finite number', Number.NaN],
    ['a nested undefined', { nested: undefined }],
  ])('omits the whole action when one field contains %s', (_label, unsafeValue) => {
    const steps = signInSteps()
    const rawAction = steps[1]!.subActions[0]!.plannedAction as unknown as Record<
      string,
      unknown
    >
    rawAction['unsafe'] = unsafeValue

    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::unrepresentable' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    const seed = JSON.parse(target!.bodySeed) as {
      steps: Array<{ action?: unknown }>
    }

    expect(seed.steps[1]?.action).toBeUndefined()
  })

  it.each([
    ['a masked secret', ['[secret:UPLOAD_NAME].pdf']],
    ['an environment template', ['{{env:UPLOAD_PATH}}']],
  ])('omits the whole action when a composite contains %s', (_label, files) => {
    const steps = signInSteps()
    steps[1]!.subActions[0]!.plannedAction = {
      type: 'fileUpload',
      ref: asRef('email'),
      files,
    }

    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::masked-composite' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    const seed = JSON.parse(target!.bodySeed) as {
      steps: Array<{ action?: unknown }>
    }

    expect(seed.steps[1]?.action).toBeUndefined()
  })

  function sourcedSeed(input: {
    testId: string
    fillText: string
    interpolatedVariables?: { name: string; value: string }[]
  }) {
    const steps = signInSteps()
    steps[1] = flowStep({
      stepIndex: 1,
      stepText: 'Enter the account identifier',
      ref: 'email',
      name: 'Email',
      fillText: input.fillText,
    })
    if (input.interpolatedVariables !== undefined) {
      steps[1]!.interpolatedVariables = input.interpolatedVariables
    }
    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: input.testId }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    return parseProcedureTrajectorySeed(target!.bodySeed)
  }

  it('names the source binding of an interpolated value slot by exact match', () => {
    const seed = sourcedSeed({
      testId: 'auth::interpolated',
      fillText: 'probe-user-7',
      interpolatedVariables: [{ name: 'PROBE_USER', value: 'probe-user-7' }],
    })

    expect(seed?.steps[1]?.action?.values['text']).toEqual({
      observed: 'probe-user-7',
      source: 'test-variable',
      sourceName: 'PROBE_USER',
    })
  })

  it('breaks a value tie to the lexicographically smallest binding name', () => {
    const seed = sourcedSeed({
      testId: 'auth::tie',
      fillText: 'shared-value',
      interpolatedVariables: [
        { name: 'ZED_USER', value: 'shared-value' },
        { name: 'ALPHA_USER', value: 'shared-value' },
      ],
    })

    expect(seed?.steps[1]?.action?.values['text']).toMatchObject({
      source: 'test-variable',
      sourceName: 'ALPHA_USER',
    })
  })

  it('leaves a containing-but-unequal observed value literal-source (wrong-value guard)', () => {
    const seed = sourcedSeed({
      testId: 'auth::containment',
      fillText: 'prefix-probe-user-7-suffix',
      interpolatedVariables: [{ name: 'PROBE_USER', value: 'probe-user-7' }],
    })

    expect(seed?.steps[1]?.action?.values['text']).toEqual({
      observed: 'prefix-probe-user-7-suffix',
      source: 'literal',
    })
  })

  it.each([
    ['an EMAIL-valued binding (mask() transforms this shape unconditionally)', 'PROBE_USER', 'qa.user@example.com'],
    ['a credential-NAMED binding (the deleted env-name seed registered this name)', 'PROBE_API_TOKEN', 'tok-live-9f3a2b'],
  ])(
    'classifies %s by its binding name — the matcher is shape-INSENSITIVE',
    (_label, name, value) => {
      const seed = sourcedSeed({
        testId: `auth::mask-shaped-${name}`,
        fillText: value,
        interpolatedVariables: [{ name, value }],
      })

      expect(seed?.steps[1]?.action?.values['text']).toMatchObject({
        observed: value,
        source: 'test-variable',
        sourceName: name,
      })
    },
  )

  it.each([
    ['the recorded template form', '{{secret:Probe_Token}}'],
    ['the redacted marker form', '[secret:Probe_Token]'],
  ])('recovers a secret name case-preserved from %s', (_label, observed) => {
    const seed = sourcedSeed({ testId: 'auth::secret-name', fillText: observed })

    expect(seed?.steps[1]?.action?.values['text']).toMatchObject({
      observed,
      source: 'masked-secret',
      sourceName: 'Probe_Token',
    })
  })

  it('rejects the whole action when a composite embeds a redacted secret marker', () => {
    const steps = signInSteps()
    steps[1]!.subActions[0]!.plannedAction = {
      type: 'fileUpload',
      ref: asRef('email'),
      files: ['[secret:PROBE_TOKEN].pdf'],
    }

    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::marker-composite' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    const seed = JSON.parse(target!.bodySeed) as { steps: Array<{ action?: unknown }> }

    expect(seed.steps[1]?.action).toBeUndefined()
  })

  it('leaves an unprovenanced literal untouched and parses seeds carrying no sourceName', () => {
    const seed = sourcedSeed({ testId: 'auth::plain', fillText: 'user@example.com' })

    expect(seed).toBeDefined()
    expect(seed?.steps[1]?.action?.values['text']).toEqual({
      observed: 'user@example.com',
      source: 'literal',
    })
  })

  it('records navigating guard routes from the pre-action page while retaining destination anchors', () => {
    const steps = signInSteps()
    steps[2] = flowStep({
      stepIndex: 2,
      stepText: 'Submit the credentials',
      ref: 'submit',
      name: 'Submit',
      afterUrl: 'https://shop.example/checkout',
    })
    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::sign-in' }, steps)]),
    ).filter((row) => row.kind === 'procedure')

    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    expect(seed?.steps[2]?.pageRoute).toBe('https://shop.example/cart')
    expect(target?.distilledObservations[2]?.surface?.naturalKey).toBe(
      'https://shop.example/cart',
    )
    expect(target?.anchors).toContainEqual({
      t: 'page',
      route: 'https://shop.example/checkout',
    })
  })
})

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function treeBytes(root: string): number {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(root, entry.name)
    return total + (entry.isDirectory() ? treeBytes(path) : statSync(path).size)
  }, 0)
}

function queuedPayload(knowledgeRoot: string, candidateId: string): CurationCandidatePayload {
  return curationCandidatePayloadSchema.parse(
    JSON.parse(
      readFileSync(join(queuedCandidateDir(knowledgeRoot, candidateId), 'payload.json'), 'utf8'),
    ),
  )
}

describe('secret slots and placeholders in curation candidates', () => {
  function slotValue(fillText: string, interpolatedVariables: { name: string; value: string }[]) {
    const fill = subAction([element('login', 'Login')], 'login')
    fill.plannedAction = {
      type: 'fill',
      ref: asRef('login'),
      text: fillText,
      clearMode: 'replace',
      submit: false,
    }
    const steps = [
      step({ stepIndex: 0, stepText: 'Open the sign-in page' }),
      step({ stepIndex: 1, stepText: 'Enter the sign-in value', interpolatedVariables }, [fill]),
    ]
    const [target] = projectCurationCandidates(
      handoff([testOutcome({ testId: 'auth::c441-slot' }, steps)]),
    ).filter((row) => row.kind === 'procedure')
    return parseProcedureTrajectorySeed(target!.bodySeed)?.steps[1]?.action?.values['text']
  }

  it('a secret slot still names its source', () => {
    expect(slotValue('[secret:LOGIN_PW]', [{ name: 'LOGIN_PW', value: 'Hunter-42-zz' }])).toEqual({
      observed: '[secret:LOGIN_PW]',
      source: 'masked-secret',
      sourceName: 'LOGIN_PW',
    })
  })

  it('a numbered email placeholder from an old run is literal text', () => {
    expect(
      slotValue('<EMAIL_0>', [{ name: 'PROBE_USER', value: 'qa.user+381@example.com' }]),
    ).toEqual({ observed: '<EMAIL_0>', source: 'literal' })
  })
})

describe('emitCurationCandidates atomic queue drop', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    queueSpy.aliasCalls.length = 0
    queueSpy.projectionCalls.length = 0
    queueSpy.nextProjectionOutcome = undefined
  })

  function emitFixture(): {
    root: string
    runDir: string
    knowledgeRoot: string
    handoff: CompletedRunHandoff
  } {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-emit-candidates-'))
    roots.push(root)
    const runDir = join(root, 'runs', 'run-emit-1')
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const bytes = Buffer.from('verified checkout evidence')
    const artifactSha = sha(bytes)
    mkdirSync(join(runDir, 'blobs'), { recursive: true })
    writeFileSync(join(runDir, 'blobs', artifactSha), bytes)
    const resolvedStep = step(
      {},
      [
        subAction(
          [element('checkout', 'Checkout', { 'data-testid': 'checkout' })],
          'checkout',
          'https://shop.example/cart',
          artifactSha,
        ),
      ],
    )
    return {
      root,
      runDir,
      knowledgeRoot,
      handoff: handoff([testOutcome({}, [resolvedStep])]),
    }
  }

  it('drops every projected candidate through the durable queue and reports outcomes', () => {
    const fixture = emitFixture()

    const report = emitCurationCandidates(fixture)

    expect(report).toMatchObject({
      enqueued: 1,
      coalesced: 0,
      capExceeded: 0,
      refused: 0,
    })
    expect(report.details).toHaveLength(1)
    expect(report.details[0]?.outcome).toEqual({
      kind: 'enqueued',
      candidateId: report.details[0]?.candidateId,
    })
    expect(queueSpy.aliasCalls).toEqual([])
    expect(queueSpy.projectionCalls).toHaveLength(1)
    const projectionCall = queueSpy.projectionCalls[0]!
    expect(projectionCall).not.toHaveProperty('payload')
    expect(projectionCall.projection).not.toHaveProperty('candidateId')
    expect(projectionCall.projection).not.toHaveProperty('artifactInventory')
    expect(projectionCall.projection.artifactDescriptors.every(
      (descriptor) => !('bytes' in descriptor),
    )).toBe(true)
    expect(projectionCall.artifactSources).toEqual([
      {
        artifactId: projectionCall.projection.artifactDescriptors[0]?.ref.id,
        sourcePath: join(
          fixture.runDir,
          'blobs',
          projectionCall.projection.artifactDescriptors[0]!.ref.sha,
        ),
      },
    ])
    expect(projectionCall.artifactSources.every((source) => isAbsolute(source.sourcePath)))
      .toBe(true)
    const candidate = report.details[0]!
    if (candidate.candidateId === undefined) {
      throw new Error('enqueued detail must carry the queue-finalized candidate id')
    }
    const queuedDir = queuedCandidateDir(fixture.knowledgeRoot, candidate.candidateId)
    const payload = curationCandidatePayloadSchema.parse(
      JSON.parse(readFileSync(join(queuedDir, 'payload.json'), 'utf8')),
    )
    expect(payload).toMatchObject({
      candidateId: candidate.candidateId,
      artifactInventory: [
        expect.objectContaining({ bytes: Buffer.byteLength('verified checkout evidence') }),
      ],
    })
    expect(payload).not.toHaveProperty('rootCauseClass')
  })

  it('addresses typed caution root causes and persists them into committed observations', () => {
    const fixture = emitFixture()
    const cautionHandoff = handoff([
      testOutcome(
        {
          outcome: 'failed',
          rootCause: rootCause('environment', 0),
        },
        [],
      ),
    ])

    const report = emitCurationCandidates({ ...fixture, handoff: cautionHandoff })
    const candidateId = report.details[0]?.candidateId
    if (candidateId === undefined) throw new Error('expected finalized caution candidate id')
    const payload = queuedPayload(fixture.knowledgeRoot, candidateId)
    expect(payload).toMatchObject({
      kind: 'caution',
      rootCauseClass: 'environment',
      bodySeed: 'environment: environment failure',
      distilledObservations: [
        expect.objectContaining({
          error: expect.objectContaining({ rootCauseClass: 'environment' }),
        }),
      ],
    })

    const { candidateId: _candidateId, rootCauseClass: _rootCauseClass, ...legacyFields } = payload
    const legacyCandidateId = candidateContentAddress(legacyFields)
    expect(curationCandidatePayloadSchema.parse({
      candidateId: legacyCandidateId,
      ...legacyFields,
    })).not.toHaveProperty('rootCauseClass')
    expect(candidateContentAddress({
      ...legacyFields,
      rootCauseClass: 'environment',
    })).not.toBe(candidateContentAddress({
      ...legacyFields,
      rootCauseClass: 'timeout',
    }))

    const published = publishBundle(
      {
        knowledgeRoot: join(fixture.root, 'committed-knowledge'),
        productKey: 'storefront',
      },
      {
        draft: {
          kind: 'caution',
          anchors: payload.anchors,
          scope: payload.scope,
          summary: payload.summarySeed,
          body: payload.bodySeed,
          distilledEvidenceRef: {
            id: `curation-candidate-${candidateId}`,
            sha: candidateId,
          },
          originStage: 'run-curation',
        },
        discriminant: {
          kind: 'caution',
          errorKey: canonicalJson(payload.anchors),
        },
        originClass: 'agent-verified',
        createdAtOrdinal: payload.buildOrdinal,
        screenStates: [],
        initialEvents: [{
          type: 'confirmed',
          evidenceToken: asEvidenceToken(payload.evidenceToken),
          curationJobId: candidateId,
          buildOrdinal: payload.buildOrdinal,
          observationId: payload.attributingObservationId,
          origin: 'agent-verified',
        }],
        relations: [],
        provenance: {
          mode: 'run-linked',
          runId: payload.sourceRunId,
          testId: payload.attributingObservationId,
          stepIndex: payload.distilledObservations[0]?.step.ordinal ?? 0,
          curationJobId: candidateId,
          sourceBuildOrdinal: payload.buildOrdinal,
        },
        artifacts: [],
        distilledObservations: payload.distilledObservations,
      },
    )
    if (published.kind !== 'published') throw new Error('expected caution bundle publication')
    const [observationLine] = readFileSync(
      join(published.dir, 'observations.jsonl'),
      'utf8',
    ).trimEnd().split('\n')
    expect(JSON.parse(observationLine!)).toMatchObject({
      error: {
        naturalKey: 'environment:environment failure',
        rootCauseClass: 'environment',
      },
    })
  })

  it('retrieves a curation-emitted ordinal caution ahead of a page fallback', async () => {
    const fixture = emitFixture()
    const pageCause = rootCause('timeout', 0)
    pageCause.evidence.citedAnchors = [{ t: 'page', route: '/checkout' }]
    const elementCause = rootCause('environment', 1)
    elementCause.evidence.citedAnchors = [{
      t: 'el',
      role: 'button',
      name: 'Retry',
      ordinal: 1,
    }]
    const emitted = emitCurationCandidates({
      ...fixture,
      handoff: handoff([
        testOutcome({
          testId: 'checkout::page-fallback',
          testIndex: 0,
          outcome: 'timeout',
          rootCause: pageCause,
        }, []),
        testOutcome({
          testId: 'checkout::second-retry',
          testIndex: 1,
          outcome: 'failed',
          rootCause: elementCause,
        }, []),
      ], { aggregateVerdict: 'failed' }),
    })
    expect(emitted).toMatchObject({ enqueued: 2, refused: 0, capExceeded: 0 })

    const servingRoot = join(fixture.root, 'ordinal-caution-knowledge')
    let elementBundleId: string | undefined
    for (const detail of emitted.details) {
      if (detail.candidateId === undefined) throw new Error('expected emitted caution id')
      const payload = queuedPayload(fixture.knowledgeRoot, detail.candidateId)
      const published = publishBundle(
        {
          knowledgeRoot: servingRoot,
          productKey: 'storefront',
        },
        {
          draft: {
            kind: 'caution',
            anchors: payload.anchors,
            scope: payload.scope,
            summary: payload.summarySeed,
            body: payload.bodySeed,
            distilledEvidenceRef: {
              id: `curation-candidate-${detail.candidateId}`,
              sha: detail.candidateId,
            },
            originStage: 'run-curation',
          },
          discriminant: { kind: 'caution', errorKey: canonicalJson(payload.anchors) },
          originClass: 'agent-verified',
          createdAtOrdinal: payload.buildOrdinal,
          screenStates: [],
          initialEvents: [{
            type: 'promoted',
            evidenceToken: asEvidenceToken(`promoted-${detail.candidateId}`),
            curationJobId: detail.candidateId,
            buildOrdinal: payload.buildOrdinal,
            observationId: payload.attributingObservationId,
          }],
          relations: [],
          provenance: {
            mode: 'run-linked',
            runId: payload.sourceRunId,
            testId: payload.attributingObservationId,
            stepIndex: payload.distilledObservations[0]?.step.ordinal ?? 0,
            curationJobId: detail.candidateId,
            sourceBuildOrdinal: payload.buildOrdinal,
          },
          artifacts: [],
          distilledObservations: payload.distilledObservations,
        },
      )
      if (published.kind !== 'published') throw new Error('expected caution publication')
      if (payload.anchors.some((anchor) => anchor.t === 'el')) {
        elementBundleId = published.id
      }
    }
    const rebuild = await rebuildIndex({ knowledgeRoot: servingRoot })

    const repeated = [element('retry-first', 'Retry'), element('retry-second', 'Retry')]
    const failed = repeated[1]!
    const anchors = [
      normalizeAnchor({
        t: 'el' as const,
        role: failed.role,
        name: failed.nameNormalized,
        ordinal: elementOrdinal(failed, repeated),
      }),
      normalizeAnchor({ t: 'page' as const, route: '/checkout' }),
    ]
    const reader = openKnowledgeReader({
      knowledgeRoot: servingRoot,
      product: 'storefront',
      budgets: { recordCap: 1 },
    })
    const { block } = reader.getCautions(anchors, 100)

    expect(elementOrdinal(failed, repeated)).toBe(1)
    expect(rebuild).toMatchObject({ projected: 2, scanIssues: [] })
    expect(block.cautions[0]?.id).toBe(elementBundleId)
  })

  it('coalesces every candidate on re-emit without writing new bytes', () => {
    const fixture = emitFixture()
    const first = emitCurationCandidates(fixture)
    const bytesAfterFirst = treeBytes(fixture.knowledgeRoot)

    const second = emitCurationCandidates(fixture)

    expect(first.enqueued).toBe(1)
    expect(second).toMatchObject({
      enqueued: 0,
      coalesced: 1,
      capExceeded: 0,
      refused: 0,
    })
    expect(second.details.every((detail) =>
      detail.outcome.kind === 'coalesced'
      && detail.candidateId === detail.outcome.candidateId,
    )).toBe(true)
    expect(treeBytes(fixture.knowledgeRoot)).toBe(bytesAfterFirst)
  })

  it('reports the finalized candidate id returned with a cap outcome', () => {
    const fixture = emitFixture()
    queueSpy.nextProjectionOutcome = {
      kind: 'cap-exceeded',
      candidateId: 'queue-finalized-cap-id',
    }

    const report = emitCurationCandidates(fixture)

    expect(report).toMatchObject({
      enqueued: 0,
      coalesced: 0,
      capExceeded: 1,
      refused: 0,
      details: [{
        candidateId: 'queue-finalized-cap-id',
        outcome: {
          kind: 'cap-exceeded',
          candidateId: 'queue-finalized-cap-id',
        },
      }],
    })
    expect(queueSpy.projectionCalls).toHaveLength(1)
    expect(queueSpy.aliasCalls).toEqual([])
  })

  it('enqueues procedure targets whose payloads round-trip the queue-payload zod schema', () => {
    const fixture = emitFixture()
    const artifactSha = fixture.handoff.tests[0]!.steps[0]!.subActions[0]!
      .decisionScreenshotRef!.sha
    const flowHandoff = handoff([
      testOutcome({ testId: 'checkout::flow' }, [
        step({ stepIndex: 0, stepText: 'Open checkout' }, [
          subAction(
            [element('checkout', 'Checkout', { 'data-testid': 'checkout' })],
            'checkout',
            undefined,
            artifactSha,
          ),
        ]),
        step({ stepIndex: 1, stepText: 'Confirm the order' }, [
          subAction([element('confirm', 'Confirm')], 'confirm', undefined, artifactSha),
        ]),
      ]),
    ])

    const report = emitCurationCandidates({ ...fixture, handoff: flowHandoff })

    expect(report.refused).toBe(0)
    const payloads = report.details
      .map((detail) => detail.candidateId)
      .filter((id): id is string => id !== undefined)
      .map((id) => queuedPayload(fixture.knowledgeRoot, id))
    const procedure = payloads.find((payload) => payload.kind === 'procedure')
    expect(procedure).toBeDefined()
    expect(procedure?.distilledObservations).toHaveLength(2)
    expect(procedure?.anchors[0]).toEqual({ t: 'flow', name: 'checkout::flow' })
    expect(parseProcedureTrajectorySeed(procedure?.bodySeed ?? '')).toBeDefined()
  })

  it('reports a missing artifact per candidate and continues the remaining batch', () => {
    const fixture = emitFixture()
    const existingBytes = Buffer.from('second candidate evidence')
    const existingSha = sha(existingBytes)
    writeFileSync(join(fixture.runDir, 'blobs', existingSha), existingBytes)
    const missingSha = 'f'.repeat(64)
    const first = step(
      { stepIndex: 0, stepText: 'Open checkout' },
      [subAction([element('checkout', 'Checkout')], 'checkout', undefined, missingSha)],
    )
    const second = step(
      { stepIndex: 1, stepText: 'Open payment' },
      [subAction([element('payment', 'Payment')], 'payment', undefined, existingSha)],
    )
    const input = {
      handoff: handoff([testOutcome({}, [first, second])]),
      runDir: fixture.runDir,
      knowledgeRoot: fixture.knowledgeRoot,
    }

    const report = emitCurationCandidates(input)

    // The failing fact AND the procedure target covering the missing-artifact step both refuse.
    expect(report).toMatchObject({
      enqueued: 1,
      coalesced: 0,
      capExceeded: 0,
      refused: 2,
    })
    expect(report.details.map((detail) => detail.outcome)).toContainEqual({
      kind: 'refused',
      reason: 'artifact-missing',
    })
    expect(report.details.map((detail) => detail.outcome)).toContainEqual(
      expect.objectContaining({ kind: 'enqueued' }),
    )
  })

  describe('per-kind outcome attribution', () => {
    function mixedKindHandoff(artifactSha: string): CompletedRunHandoff {
      return handoff([
        testOutcome({ testId: 'checkout::flow' }, [
          step({ stepIndex: 0, stepText: 'Open checkout' }, [
            subAction([element('checkout', 'Checkout')], 'checkout', undefined, artifactSha),
          ]),
          step({ stepIndex: 1, stepText: 'Confirm the order' }, [
            subAction([element('confirm', 'Confirm')], 'confirm', undefined, artifactSha),
          ]),
        ]),
      ])
    }

    it('carries the projecting candidate kind on every outcome detail', () => {
      const fixture = emitFixture()
      const artifactSha = fixture.handoff.tests[0]!.steps[0]!.subActions[0]!
        .decisionScreenshotRef!.sha

      const report = emitCurationCandidates({
        ...fixture,
        handoff: mixedKindHandoff(artifactSha),
      })

      expect(report.details.map((detail) => detail.kind)).toEqual([
        'fact',
        'fact',
        'procedure',
      ])
      expect(report.details.every((detail) => detail.candidateId !== undefined)).toBe(true)
    })

    it('derives per-kind projected and outcome counts from the report alone', () => {
      const fixture = emitFixture()
      const artifactSha = fixture.handoff.tests[0]!.steps[0]!.subActions[0]!
        .decisionScreenshotRef!.sha
      const input = mixedKindHandoff(artifactSha)
      queueSpy.nextProjectionOutcome = {
        kind: 'coalesced',
        candidateId: 'queue-finalized-coalesced-id',
      }

      const report = emitCurationCandidates({ ...fixture, handoff: input })
      const projected = projectCurationCandidates(input)

      // The one-outcome-per-candidate invariant, now observable per kind: projected
      // count per kind == details of that kind, and the outcome split sums to it.
      for (const kind of ['fact', 'measurement', 'caution', 'procedure'] as const) {
        const details = report.details.filter((detail) => detail.kind === kind)
        expect(details).toHaveLength(projected.filter((row) => row.kind === kind).length)
        const split = (['enqueued', 'coalesced', 'cap-exceeded', 'refused'] as const).map(
          (outcome) => details.filter((detail) => detail.outcome.kind === outcome).length,
        )
        expect(split.reduce((sum, count) => sum + count, 0)).toBe(details.length)
      }
      expect(
        report.details
          .filter((detail) => detail.kind === 'fact')
          .map((detail) => detail.outcome.kind)
          .sort(),
      ).toEqual(['coalesced', 'enqueued'])
      expect(report.enqueued + report.coalesced + report.capExceeded + report.refused)
        .toBe(report.details.length)
    })

    it('yields no procedure detail for a single-step handoff — projected count derivably zero', () => {
      const fixture = emitFixture()

      const report = emitCurationCandidates(fixture)

      expect(report.details).toHaveLength(1)
      expect(report.details[0]?.kind).toBe('fact')
      expect(report.details.filter((detail) => detail.kind === 'procedure')).toHaveLength(0)
    })
  })
})
