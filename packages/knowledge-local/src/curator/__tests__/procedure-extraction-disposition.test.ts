// PROC-01 write-side validation suite: the procedure disposition wall.
// "LLM proposes, code disposes" — every reject is a deterministic
// structural verdict against verified queue evidence, never LLM text.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION, serializeProcedureBody } from '@vostride/agent-qa-schema'
import type { Anchor, Delta, DistilledObservation } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ARTIFACT_STEP_CAP_BYTES,
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  acquireWriterLease,
  candidateContentAddress,
  commitCurationDelta,
  disposeDelta,
  loadBundle,
  parseAuthoredCheckpoint,
  sliceAuthoredCheckpoint,
  type AuthoredDeltaCheckpoint,
  type CommitCurationDependencies,
  type CommitCurationJob,
} from '../../index.js'
import type { ProcedureDispositionEvidence } from '../disposition.js'
import { candidateAddressFixture } from '../../__tests__/fixtures/curation-candidate-fixture.js'
import {
  makeProcedureBodyPayloadFixture,
  makeProcedureBundleDraftFixture,
  makeProcedureScreenStateSequenceFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'

const OBSERVATION_STEP_KEYS = ['enter-email', 'enter-password', 'submit'] as const
const OBSERVATION_ELEMENT_KEYS = [
  'textbox:email',
  'textbox:password',
  'button:sign in',
] as const
const REPEATED_INSTRUCTIONS = [
  'Click Next',
  'Enter shipping address',
  'Click Next',
] as const

let root: string
let knowledgeRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-procedure-disposition-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeObservations(): DistilledObservation[] {
  return OBSERVATION_STEP_KEYS.map((naturalKey, index) => ({
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey, ordinal: index },
    platform: 'web' as const,
    test: { id: 'sign-in-test' },
    flow: {
      name: 'Sign in flow',
      ...(index === 0 ? {} : { precedes: OBSERVATION_STEP_KEYS[index - 1]! }),
    },
    surface: { kind: 'page' as const, naturalKey: '/login' },
    element: { naturalKey: OBSERVATION_ELEMENT_KEYS[index]! },
    observedAtOrdinal: 81 + index,
  }))
}

function repeatedInstructionPayload() {
  const payload = makeProcedureBodyPayloadFixture()
  return {
    ...payload,
    steps: payload.steps.map((step, index) => ({
      ...step,
      instruction: REPEATED_INSTRUCTIONS[index]!,
    })),
  }
}

function instructionWindow(
  instructions: readonly string[],
  startOrdinal: number,
  route = '/login',
): DistilledObservation[] {
  return instructions.map((naturalKey, index) => {
    const base = makeObservations()[index]!
    return {
      ...base,
      step: { naturalKey, ordinal: startOrdinal + index },
      surface: { kind: 'page' as const, naturalKey: route },
    }
  })
}

function makeEvidence(
  overrides: Partial<ProcedureDispositionEvidence> = {},
): ProcedureDispositionEvidence {
  return {
    distilledObservations: makeObservations(),
    ...overrides,
  }
}

function addDelta(
  overrides: Partial<Parameters<typeof makeProcedureBundleDraftFixture>[0]> = {},
): Extract<Delta, { kind: 'Add' }> {
  const draft = makeProcedureBundleDraftFixture(overrides)
  return {
    kind: 'Add',
    origin: 'agent',
    scope: draft.scope,
    citedIds: [],
    authorship: {
      path: 'llm',
      model: { id: 'procedure-fixture' },
      executionContext: 'local-interactive',
    },
    bundle: draft,
  }
}

function checkpointFor(delta: Delta): AuthoredDeltaCheckpoint {
  const parsed = parseAuthoredCheckpoint({
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    deltas: [delta],
    neighborIds: [],
    preconditions: [],
    authorship: {
      path: 'llm',
      model: { id: 'procedure-fixture' },
      executionContext: 'local-interactive',
    },
  })
  return sliceAuthoredCheckpoint(parsed)[0]!
}

function dispose(
  delta: Extract<Delta, { kind: 'Add' }>,
  evidence: ProcedureDispositionEvidence | null = makeEvidence(),
) {
  return disposeDelta({
    delta,
    checkpoint: checkpointFor(delta),
    profile: { mode: 'drain-to-active' },
    knowledgeRoot,
    candidate: {
      anchors: [...delta.bundle.anchors],
      scope: delta.bundle.scope,
      buildOrdinal: 81,
      curationJobId: 'procedure-disposition-job',
      ...(evidence === null ? {} : { procedureEvidence: evidence }),
    },
    drainState: { supersedesSeenByAnchorKey: new Map() },
  })
}

describe('procedure extraction disposition — structural candidacy', () => {
  it('rejects a procedure Add whose body parseProcedureBody cannot decode', () => {
    const outcome = dispose(
      addDelta({ body: 'Enter email, enter password, and submit the form.' }),
    )
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-body-unparseable' })
  })

  it('rejects a candidate covering a step with no verified-PASS observation evidence', () => {
    const observations = makeObservations().filter(
      (observation) => observation.step.naturalKey !== 'enter-password',
    )
    const outcome = dispose(
      addDelta(),
      makeEvidence({ distilledObservations: observations }),
    )
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-step-coverage' })
  })

  it('rejects a candidate whose covered step lacks resolved-element evidence', () => {
    const observations = makeObservations().map((observation) =>
      observation.step.naturalKey === 'enter-password'
        ? { ...observation, element: undefined }
        : observation,
    ) as DistilledObservation[]
    const outcome = dispose(
      addDelta(),
      makeEvidence({ distilledObservations: observations }),
    )
    expect(outcome).toEqual({
      kind: 'noop',
      reason: 'procedure-step-unresolved-element',
    })
  })

  it('rejects a candidate whose covered observation ordinals are non-contiguous', () => {
    const observations = makeObservations().map((observation) =>
      observation.step.naturalKey === 'submit'
        ? { ...observation, step: { ...observation.step, ordinal: 3 } }
        : observation,
    )
    const outcome = dispose(
      addDelta(),
      makeEvidence({ distilledObservations: observations }),
    )
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-span-non-contiguous' })
  })

  it('accepts a contiguous verified trajectory whose first and third instructions repeat', () => {
    const payload = repeatedInstructionPayload()
    const delta = addDelta({ body: serializeProcedureBody(payload) })
    const outcome = dispose(
      delta,
      makeEvidence({
        distilledObservations: instructionWindow(REPEATED_INSTRUCTIONS, 0),
      }),
    )

    expect(outcome).toMatchObject({ kind: 'apply', delta })
  })

  it('rejects repeated instructions when no contiguous ordinal window matches every step', () => {
    const payload = repeatedInstructionPayload()
    const outcome = dispose(
      addDelta({ body: serializeProcedureBody(payload) }),
      makeEvidence({
        distilledObservations: instructionWindow(
          ['Click Next', 'Enter billing address', 'Click Next'],
          0,
        ),
      }),
    )

    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-step-coverage' })
  })

  it('selects the lowest matching ordinal window independent of observation order', () => {
    const payload = repeatedInstructionPayload()
    const delta = addDelta({ body: serializeProcedureBody(payload) })
    const outcome = dispose(
      delta,
      makeEvidence({
        distilledObservations: [
          ...instructionWindow(REPEATED_INSTRUCTIONS, 3, '/settings'),
          ...instructionWindow(REPEATED_INSTRUCTIONS, 0),
        ],
      }),
    )

    expect(outcome).toMatchObject({ kind: 'apply', delta })
  })

  it('rejects a candidate with no flow anchor', () => {
    const outcome = dispose(addDelta({ anchors: [{ t: 'page', route: '/login' }] }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-flow-anchor' })
  })

  it('rejects a candidate whose page anchors are disjoint from covered surfaces', () => {
    const anchors: Anchor[] = [
      { t: 'flow', name: 'Sign in flow' },
      { t: 'page', route: '/settings' },
    ]
    const outcome = dispose(addDelta({ anchors }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-page-anchor-disjoint' })
  })

  it('rejects a step sequence containing a tapCoordinate completing action (shared schema list)', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.steps[2] = {
      ...payload.steps[2]!,
      action: { ...payload.steps[2]!.action, type: 'tapCoordinate' },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({
      kind: 'noop',
      reason: 'procedure-non-replayable-action',
    })
  })

  it('rejects a step sequence containing an assertAI completing action', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.steps[2] = {
      ...payload.steps[2]!,
      action: { ...payload.steps[2]!.action, type: 'assertAI' },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({
      kind: 'noop',
      reason: 'procedure-non-replayable-action',
    })
  })

  it('rejects a step whose action shape carries a raw-coordinate key', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.steps[2] = {
      ...payload.steps[2]!,
      action: {
        ...payload.steps[2]!.action,
        values: { x: '100' },
      },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({
      kind: 'noop',
      reason: 'procedure-non-replayable-action',
    })
  })

  it('fails closed when a procedure delta arrives without extraction evidence', () => {
    const outcome = dispose(addDelta(), null)
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-evidence-missing' })
  })

  it('disposes a well-formed whole-flow candidate into the normal commit flow', () => {
    const delta = addDelta()
    const outcome = dispose(delta)
    expect(outcome).toMatchObject({ kind: 'apply', delta })
  })
})

describe('procedure extraction disposition — binding integrity & secrets', () => {
  it('ignores boolean scalar slots when checking parameter-reference integrity', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.steps[0]!.action.values.submit = true
    const delta = addDelta({ body: serializeProcedureBody(payload) })

    expect(dispose(delta)).toMatchObject({ kind: 'apply', delta })
  })

  it('rejects a declared parameter referenced by zero steps', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = [
      ...payload.parameters,
      { name: 'otp', type: 'string', required: false },
    ]
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-param-unreferenced' })
  })

  it('rejects a {param} reference with no declared parameter', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = payload.parameters.filter(({ name }) => name !== 'email')
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-param-undeclared' })
  })

  it('rejects a masked placeholder value surviving as a literal on any step', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = payload.parameters.filter(({ name }) => name !== 'email')
    payload.steps[0] = {
      ...payload.steps[0]!,
      action: { ...payload.steps[0]!.action, values: { text: '[secret:PW]' } },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-masked-secret-literal' })
  })

  it('rejects a test-variable-sourced value surviving as a literal', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = payload.parameters.filter(({ name }) => name !== 'email')
    payload.steps[0] = {
      ...payload.steps[0]!,
      action: { ...payload.steps[0]!.action, values: { text: '{{env:USER_EMAIL}}' } },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-test-variable-literal' })
  })

  it('makes non-closed param types unreachable through the decode wall', () => {
    const body = serializeProcedureBody(makeProcedureBodyPayloadFixture()).replace(
      '"type":"string"',
      '"type":"date"',
    )
    const outcome = dispose(addDelta({ body }))
    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-body-unparseable' })
  })
})

describe('values typed into credential-type fields', () => {
  it('a value typed into a credential-type field is not secret by its field type', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = payload.parameters.filter(({ name }) => name !== 'password')
    payload.steps[1] = {
      ...payload.steps[1]!,
      action: {
        ...payload.steps[1]!.action,
        type: 'fill',
        values: { text: 'hunter2', clearMode: 'replace', submit: true },
      },
    }
    const delta = addDelta({ body: serializeProcedureBody(payload) })

    expect(dispose(delta)).toMatchObject({ kind: 'apply', delta })
  })
})

describe('the named secret marker as a typed value', () => {
  it('a step whose typed value is the named secret marker is refused as a masked literal', () => {
    const payload = makeProcedureBodyPayloadFixture()
    payload.parameters = payload.parameters.filter(({ name }) => name !== 'password')
    payload.steps[1] = {
      ...payload.steps[1]!,
      action: {
        ...payload.steps[1]!.action,
        type: 'fill',
        values: { text: '[secret:PW]', clearMode: 'replace', submit: true },
      },
    }
    const outcome = dispose(addDelta({ body: serializeProcedureBody(payload) }))

    expect({ kind: outcome.kind, reason: 'reason' in outcome ? outcome.reason : undefined })
      .toEqual({ kind: 'noop', reason: 'procedure-masked-secret-literal' })
  })
})

describe('procedure extraction commit path — artifact cap & egress backstop', () => {
  interface HarnessArtifact {
    bytes: Buffer
    stepIndex: number
    role: 'dom-snapshot' | 'opaque-evidence'
    originalName: string
  }

  function commitProcedureWithArtifacts(artifacts: HarnessArtifact[]) {
    const knowledgeDir = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeDir, { recursive: true })
    const lease = acquireWriterLease(knowledgeDir)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    const draft = makeProcedureBundleDraftFixture()
    const screenStates = makeProcedureScreenStateSequenceFixture()
    const rows = artifacts.map((artifact) => ({
      ...artifact,
      sha: createHash('sha256').update(artifact.bytes).digest('hex'),
    }))
    const fields = candidateAddressFixture({
      schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
      sourceRunId: 'run-procedure-disposition',
      scope: draft.scope,
      buildOrdinal: 81,
      executionContext: 'local-interactive',      kind: 'procedure',
      anchors: draft.anchors,
      summarySeed: draft.summary,
      bodySeed: draft.body,
      distilledObservations: makeObservations(),
      evidenceToken: 'procedure-disposition-evidence',
      attributingObservationId: 'run-procedure-disposition:test-sign-in:step-0',
      artifactInventory: rows.map(({ bytes, sha, stepIndex, role, originalName }) => ({
        relativePath: `artifacts/${sha}`,
        sha256: sha,
        bytes: bytes.byteLength,
        stepIndex,
        role,
        originalName,
      })),
      emittedAt: '2026-07-15T10:00:00.000Z',
    })
    const candidateId = candidateContentAddress(fields)
    const candidateDir = join(root, 'claimed', candidateId)
    const artifactsDir = join(candidateDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    for (const artifact of rows) {
      writeFileSync(join(artifactsDir, artifact.sha), artifact.bytes)
    }
    const job: CommitCurationJob = {
      kind: 'claimed',
      candidateId,
      leaseId: lease.leaseId,
      payload: { candidateId, ...fields },
      candidateDir,
      payloadPath: join(candidateDir, 'payload.json'),
      artifactsDir,
      screenStates,
    }
    const delta = addDelta()
    const dependencies: CommitCurationDependencies = {
      knowledgeRoot: knowledgeDir,
      epoch: lease.epoch,
      profile: { mode: 'drain-to-active' },
      drainState: { supersedesSeenByAnchorKey: new Map() },
    }
    return commitCurationDelta(dependencies, job, checkpointFor(delta))
  }

  it('refuses a per-step artifact above the ratified 2MB cap via the commit-path wall', () => {
    const oversized = Buffer.alloc(ARTIFACT_STEP_CAP_BYTES + 1, 'a')
    const oversizedSha = createHash('sha256').update(oversized).digest('hex')
    const outcome = commitProcedureWithArtifacts([
      { bytes: oversized, stepIndex: 0, role: 'opaque-evidence', originalName: 'huge-step-0.txt' },
      {
        bytes: Buffer.from('{"role":"textbox","name":"Password"}\n'),
        stepIndex: 1,
        role: 'dom-snapshot',
        originalName: 'procedure-step-1.dom.json',
      },
    ])
    expect(outcome.kind).toBe('applied')
    if (outcome.kind !== 'applied') throw new Error('expected applied procedure')
    const loaded = loadBundle(outcome.bundleDir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected loaded procedure')
    expect(
      loaded.bundle.artifactsIndex.artifacts.some(({ sha }) => sha === oversizedSha),
    ).toBe(false)
    expect(loaded.bundle.artifactsIndex.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha: oversizedSha, reason: 'step-cap' }),
      ]),
    )
    expect(loaded.bundle.manifest.evidenceIncomplete).toBe(true)
  })
})
