import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION, canonicalJson, type Delta } from '@vostride/agent-qa-schema'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { ARTIFACT_STEP_CAP_BYTES } from '../artifact-copy.js'
import type { CuratorAuthor } from '../curator/author-contract.js'
import { drainQueue } from '../curator/drain.js'
import {
  enqueueCurationCandidate,
  enqueueCurationCandidateProjection,
  listQueuedCandidates,
  readCurationCandidatePayload,
} from '../queue/curation-queue.js'
import type {
  CurationProjectionArtifactSource,
  EnqueueCurationCandidateProjectionOptions,
  EnqueueCurationCandidateProjectionOutcome,
} from '../queue/curation-queue.js'
import {
  QUEUE_MAX_EMITS_PER_RUN,
  QUEUE_MAX_JOBS_PER_SCOPE,
  queueRoot,
  queuedCandidateDir,
} from '../queue/queue-layout.js'
import {
  CURATION_QUEUE_SCHEMA_VERSION,
  candidateContentAddress,
  type BuildCurationCandidateAddressFieldsInput,
  type CurationArtifactDescriptor,
  type CurationArtifactRole,
  type CurationCandidatePayload,
  type CurationCandidateProjection,
} from '../queue/queue-payload.js'
import {
  candidateAddressFixture,
  candidateProjectionFixture,
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from './fixtures/curation-candidate-fixture.js'

type CandidateFixtureOverrides = Partial<BuildCurationCandidateAddressFieldsInput>

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('curation queue atomic emit drop', () => {
  let root: string
  let knowledgeRoot: string
  let sourceRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-curation-queue-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    sourceRoot = join(root, 'sources')
    mkdirSync(sourceRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function addressFields(
    overrides: CandidateFixtureOverrides = {},
  ): BuildCurationCandidateAddressFieldsInput {
    return candidateAddressFixture({
      schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
      sourceRunId: 'run-1',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
      summarySeed: 'Checkout button selector',
      bodySeed: 'The checkout button was resolved and verified.',
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: 'checkout-click', ordinal: 0 },
          platform: 'web',
          element: { naturalKey: 'button:checkout' },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: 'evidence-1',
      attributingObservationId: 'run-1:test-0:step-0',
      artifactInventory: [],
      emittedAt: '2026-07-15T10:00:00.000Z',
      ...overrides,
    })
  }

  function payload(overrides: CandidateFixtureOverrides = {}): CurationCandidatePayload {
    const fields = addressFields(overrides)
    return { candidateId: candidateContentAddress(fields), ...fields }
  }

  function seedQueued(candidate: CurationCandidatePayload, rootOverride = knowledgeRoot): void {
    const candidateDir = queuedCandidateDir(rootOverride, candidate.candidateId)
    mkdirSync(candidateDir, { recursive: true })
    writeFileSync(join(candidateDir, 'payload.json'), JSON.stringify(candidate), 'utf8')
  }

  function projectionInput(
    overrides: Partial<ArtifactFreeCandidateProjectionInput> = {},
  ): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: 'projection-run',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
      summarySeed: 'Checkout button selector',
      bodySeed: 'The checkout button was resolved and verified.',
      distilledObservations: [],
      evidenceToken: 'projection-evidence',
      attributingObservationId: 'projection-run:test-0:step-0',
      emittedAt: '2026-07-15T10:00:00.000Z',
      ...overrides,
    }
  }

  function projection(
    overrides: Partial<CurationCandidateProjection> = {},
  ): CurationCandidateProjection {
    return candidateProjectionFixture({
      ...projectionInput(),
      artifactDescriptors: [],
      ...overrides,
    })
  }

  function projectionArtifact(
    name: string,
    bytes: Uint8Array,
    stepIndex: number,
    role: CurationArtifactRole,
  ): {
    descriptor: CurationArtifactDescriptor
    source: CurationProjectionArtifactSource
  } {
    const sourcePath = join(sourceRoot, name)
    writeFileSync(sourcePath, bytes)
    const artifactId = `artifact-${name}`
    return {
      descriptor: {
        ref: { id: artifactId, sha: sha(bytes) },
        stepIndex,
        role,
        originalName: name,
      },
      source: { artifactId, sourcePath },
    }
  }

  function queueFiles(dir = queueRoot(knowledgeRoot)): { path: string; bytes: Buffer }[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? queueFiles(path) : [{ path, bytes: readFileSync(path) }]
    })
  }

  function expectQueueTreeEmpty(): void {
    expect(queueFiles()).toEqual([])
    expect(existsSync(join(queueRoot(knowledgeRoot), '.staging'))).toBe(false)
  }

  function drainWithAddAuthor(): ReturnType<typeof drainQueue> {
    const author = vi.fn<CuratorAuthor>(async (job) => {
      const authorship = {
        path: 'llm' as const,
        model: { id: 'curator-test' },
        executionContext: job.executionContext,
      }
      const delta: Delta = {
        kind: 'Add',
        origin: 'agent',
        scope: job.scope,
        citedIds: [],
        authorship,
        bundle: {
          kind: job.kind,
          ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
          anchors: job.anchors,
          scope: job.scope,
          summary: job.summarySeed,
          body: job.bodySeed,
          distilledEvidenceRef: {
            id: `curation-candidate-${job.candidateId}`,
            sha: job.candidateId,
          },
          originStage: 'run-curation',
        },
      }
      return { kind: 'authored' as const, deltas: [delta], authorship }
    })
    return drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
      operations: {
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => ({
          indexAbsent: false,
          pendingEmbeddings: 0,
          renderingEpochStale: false,
          vectorReconciliationOutstanding: false,
        }),
        openKnowledgeReader: () => ({
          source: 'scan' as const,
          vec: 'none' as const,
          getById: vi.fn(),
          searchLexical: vi.fn(() => []),
          lookupAnchor: vi.fn(() => []),
          searchDense: vi.fn(() => []),
          recheck: vi.fn((hits) => [...hits]),
          close: vi.fn(),
        }),
        retrieve: async () => [],
      },
    })
  }

  it('hashes only deterministic fields regardless of object order or emittedAt', () => {
    const first = addressFields()
    const reordered = {
      emittedAt: '2099-01-01T00:00:00.000Z',
      artifactInventory: first.artifactInventory,
      attributingObservationId: first.attributingObservationId,
      evidenceToken: first.evidenceToken,
      distilledObservations: first.distilledObservations,
      bodySeed: first.bodySeed,
      summarySeed: first.summarySeed,
      anchors: first.anchors,
      subtype: first.subtype,
      kind: first.kind,
      executionContext: first.executionContext,
      buildOrdinal: first.buildOrdinal,
      scope: { key: first.scope.key, tier: first.scope.tier },
      sourceRunId: first.sourceRunId,
      schemaVersion: first.schemaVersion,
    } satisfies BuildCurationCandidateAddressFieldsInput

    expect(candidateContentAddress(reordered)).toBe(candidateContentAddress(first))
  })

  it('exposes both public enqueue names as one projection-only safety boundary', () => {
    expect(enqueueCurationCandidate).toBe(enqueueCurationCandidateProjection)
    expectTypeOf(enqueueCurationCandidate)
      .toEqualTypeOf<typeof enqueueCurationCandidateProjection>()
    expectTypeOf<Parameters<typeof enqueueCurationCandidate>[0]>()
      .toEqualTypeOf<EnqueueCurationCandidateProjectionOptions>()

    const projected = projection()
    const first = enqueueCurationCandidateProjection({
      knowledgeRoot,
      projection: projected,
      artifactSources: [],
    })
    expect(first.kind).toBe('enqueued')
    if (first.kind !== 'enqueued') throw new Error('expected enqueued projection')
    expect(
      (enqueueCurationCandidate as typeof enqueueCurationCandidateProjection)({
        knowledgeRoot,
        projection: { ...projected, emittedAt: '2099-01-01T00:00:00.000Z' },
        artifactSources: [],
      }),
    ).toEqual({ kind: 'coalesced', candidateId: first.candidateId })

    const malformedProjection = {
      ...projected,
      scope: undefined,
    } as unknown as CurationCandidateProjection
    expect(
      (enqueueCurationCandidate as typeof enqueueCurationCandidateProjection)({
        knowledgeRoot,
        projection: malformedProjection,
        artifactSources: [],
      }),
    ).toEqual({ kind: 'refused', reason: 'invalid-payload' })

    const finalizedPayloadOptions = {
      knowledgeRoot,
      payload: payload(),
      artifactSources: [],
    }
    type FinalizedPayloadOptions = typeof finalizedPayloadOptions
    type ProjectionRejectsFinalized = FinalizedPayloadOptions extends Parameters<
      typeof enqueueCurationCandidateProjection
    >[0] ? false : true
    type AliasRejectsFinalized = FinalizedPayloadOptions extends Parameters<
      typeof enqueueCurationCandidate
    >[0] ? false : true
    const projectionRejectsFinalized: ProjectionRejectsFinalized = true
    const aliasRejectsFinalized: AliasRejectsFinalized = true
    expect(projectionRejectsFinalized).toBe(true)
    expect(aliasRejectsFinalized).toBe(true)

    const source = readFileSync(
      new URL('../queue/curation-queue.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/export function enqueueCurationCandidate\s*\(/u)
    expect(source).toMatch(
      /export const enqueueCurationCandidate = enqueueCurationCandidateProjection/u,
    )
  })

  it('publishes payload and artifact bytes atomically then coalesces without rewriting', () => {
    const artifactBytes = Buffer.from('curation evidence')
    const artifact = projectionArtifact(
      'evidence.bin',
      artifactBytes,
      0,
      'opaque-evidence',
    )
    const projectionInput = projection({
      artifactDescriptors: [artifact.descriptor],
    })

    const first = enqueueCurationCandidateProjection({
      knowledgeRoot,
      projection: projectionInput,
      artifactSources: [artifact.source],
    })
    expect(first.kind).toBe('enqueued')
    if (first.kind !== 'enqueued') throw new Error('expected enqueued projection')

    const candidateDir = queuedCandidateDir(knowledgeRoot, first.candidateId)
    const payloadFile = join(candidateDir, 'payload.json')
    const firstPayloadBytes = readFileSync(payloadFile)
    expect(readFileSync(join(candidateDir, 'artifacts', artifact.descriptor.ref.sha))).toEqual(
      artifactBytes,
    )
    const parsed = readCurationCandidatePayload(candidateDir)
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('expected parsed projection payload')
    expect(parsed.payload.candidateId).toBe(first.candidateId)
    expect(parsed.payload.artifactInventory).toEqual([
      {
        relativePath: `artifacts/${artifact.descriptor.ref.sha}`,
        sha256: artifact.descriptor.ref.sha,
        bytes: artifactBytes.byteLength,
        stepIndex: 0,
        role: 'opaque-evidence',
        originalName: 'evidence.bin',
      },
    ])

    expect(
      enqueueCurationCandidateProjection({
        knowledgeRoot,
        projection: { ...projectionInput, emittedAt: '2099-01-01T00:00:00.000Z' },
        artifactSources: [artifact.source],
      }),
    ).toEqual({ kind: 'coalesced', candidateId: first.candidateId })
    expect(readFileSync(payloadFile)).toEqual(firstPayloadBytes)
    expect(readCurationCandidatePayload(candidateDir)).toEqual({
      kind: 'parsed',
      present: true,
      payload: parsed.payload,
    })
  })

  it('cleans staging and exposes no candidate for malformed, missing, mismatched, or inconsistent input', () => {
    const source = projectionArtifact(
      'source.txt',
      Buffer.from('safe source bytes'),
      0,
      'opaque-evidence',
    )
    const cases = [
      {
        projection: { ...projection(), scope: undefined } as unknown as CurationCandidateProjection,
        artifactSources: [] as CurationProjectionArtifactSource[],
        reason: 'invalid-payload',
      },
      {
        projection: projection({ artifactDescriptors: [source.descriptor] }),
        artifactSources: [{ ...source.source, sourcePath: join(sourceRoot, 'missing.txt') }],
        reason: 'artifact-missing',
      },
      {
        projection: projection({
          artifactDescriptors: [
            { ...source.descriptor, ref: { ...source.descriptor.ref, sha: '0'.repeat(64) } },
          ],
        }),
        artifactSources: [source.source],
        reason: 'artifact-sha-mismatch',
      },
    ] as const

    for (const scenario of cases) {
      expect(
        enqueueCurationCandidateProjection({
          knowledgeRoot,
          projection: scenario.projection,
          artifactSources: scenario.artifactSources,
        }),
      ).toEqual({ kind: 'refused', reason: scenario.reason })
      expectQueueTreeEmpty()
    }

    const duplicateBytes = Buffer.from('same redacted credential')
    const dom = projectionArtifact('same.dom.json', duplicateBytes, 4, 'dom-snapshot')
    const ax = projectionArtifact('same.ax.json', duplicateBytes, 4, 'ax-snapshot')
    expect(
      enqueueCurationCandidateProjection({
        knowledgeRoot,
        projection: projection({ artifactDescriptors: [dom.descriptor, ax.descriptor] }),
        artifactSources: [dom.source, ax.source],
      }),
    ).toEqual({ kind: 'refused', reason: 'artifact-inventory-mismatch' })
    expectQueueTreeEmpty()
  })

  it('returns finalized candidate ids for enqueued, coalesced, and cap-exceeded outcomes', () => {
    expectTypeOf<EnqueueCurationCandidateProjectionOutcome>().toMatchTypeOf<
      | { kind: 'enqueued'; candidateId: string }
      | { kind: 'coalesced'; candidateId: string }
      | { kind: 'cap-exceeded'; candidateId: string }
      | { kind: 'refused'; reason: string }
    >()

    const first = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projectionInput(),
    })
    expect(first.kind).toBe('enqueued')
    if (first.kind !== 'enqueued') throw new Error('expected enqueued projection')
    expect(
      enqueueArtifactFreeCandidateProjection({
        knowledgeRoot,
        projectionInput: projectionInput(),
      }),
    ).toEqual({ kind: 'coalesced', candidateId: first.candidateId })

    const capRoot = join(root, 'cap-root')
    for (let index = 0; index < QUEUE_MAX_JOBS_PER_SCOPE; index += 1) {
      seedQueued(
        payload({
          sourceRunId: `cap-run-${index}`,
          attributingObservationId: `cap-observation-${index}`,
          evidenceToken: `cap-evidence-${index}`,
        }),
        capRoot,
      )
    }
    const capped = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot: capRoot,
      projectionInput: projectionInput({
        sourceRunId: 'cap-overflow-run',
        attributingObservationId: 'cap-overflow-observation',
        evidenceToken: 'cap-overflow-evidence',
      }),
    })
    expect(capped.kind).toBe('cap-exceeded')
    if (capped.kind !== 'cap-exceeded') throw new Error('expected cap-exceeded projection')
    expect(existsSync(queuedCandidateDir(capRoot, capped.candidateId))).toBe(false)
    expect(existsSync(join(queueRoot(capRoot), '.staging'))).toBe(false)
  })

  it('uses the named helper for explicit artifact-free projection source truth', () => {
    const input = projectionInput()
    const explicit = candidateProjectionFixture({
      ...input,
      artifactDescriptors: [],
    })
    expect(explicit).toMatchObject({ artifactDescriptors: [] })

    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: input,
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
    const parsed = readCurationCandidatePayload(
      queuedCandidateDir(knowledgeRoot, outcome.candidateId),
    )
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('expected parsed projection payload')
    expect(parsed.payload.candidateId).toBe(outcome.candidateId)
    expect(parsed.payload.artifactInventory).toEqual([])
  })

  it('fails closed at the per-scope and per-run queue caps without visible bytes', () => {
    for (let index = 0; index < QUEUE_MAX_JOBS_PER_SCOPE; index += 1) {
      const candidate = payload({
        sourceRunId: `scope-run-${index}`,
        attributingObservationId: `scope-observation-${index}`,
        evidenceToken: `scope-evidence-${index}`,
      })
      seedQueued(candidate)
    }
    const scopeOverflow = projectionInput({
      sourceRunId: 'scope-overflow-run',
      attributingObservationId: 'scope-overflow-observation',
      evidenceToken: 'scope-overflow-evidence',
    })
    const scopeOutcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: scopeOverflow,
    })
    expect(scopeOutcome.kind).toBe('cap-exceeded')
    if (scopeOutcome.kind !== 'cap-exceeded') {
      throw new Error('expected scope cap-exceeded projection')
    }
    expect(existsSync(queuedCandidateDir(knowledgeRoot, scopeOutcome.candidateId))).toBe(false)

    const secondKnowledgeRoot = join(root, 'second-knowledge-root')
    for (let index = 0; index < QUEUE_MAX_EMITS_PER_RUN; index += 1) {
      const candidate = payload({
        sourceRunId: 'one-hot-run',
        scope: { tier: 'test', key: `test-${index}` },
        attributingObservationId: `run-observation-${index}`,
        evidenceToken: `run-evidence-${index}`,
      })
      seedQueued(candidate, secondKnowledgeRoot)
    }
    const runOverflow = projectionInput({
      sourceRunId: 'one-hot-run',
      scope: { tier: 'test', key: 'overflow-test' },
      attributingObservationId: 'run-overflow-observation',
      evidenceToken: 'run-overflow-evidence',
    })
    const runOutcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot: secondKnowledgeRoot,
      projectionInput: runOverflow,
    })
    expect(runOutcome.kind).toBe('cap-exceeded')
    if (runOutcome.kind !== 'cap-exceeded') {
      throw new Error('expected run cap-exceeded projection')
    }
    expect(existsSync(queuedCandidateDir(secondKnowledgeRoot, runOutcome.candidateId))).toBe(false)
  })

  it('returns a typed refusal when one artifact exceeds the imported step cap', () => {
    const artifactBytes = new Uint8Array(ARTIFACT_STEP_CAP_BYTES + 1).fill(97)
    const artifact = projectionArtifact(
      'oversized.bin',
      artifactBytes,
      0,
      'opaque-evidence',
    )
    const rawProjection = projection({
      artifactDescriptors: [artifact.descriptor],
    })

    expect(
      enqueueCurationCandidateProjection({
        knowledgeRoot,
        projection: rawProjection,
        artifactSources: [artifact.source],
      }),
    ).toEqual({ kind: 'refused', reason: 'artifact-step-cap' })
    expectQueueTreeEmpty()
  })

  it('reports corrupt payload bytes as malformed instead of throwing', () => {
    const candidateDir = queuedCandidateDir(knowledgeRoot, 'a'.repeat(64))
    mkdirSync(candidateDir, { recursive: true })
    writeFileSync(join(candidateDir, 'payload.json'), '{not-json', 'utf8')

    expect(readCurationCandidatePayload(candidateDir)).toEqual({
      kind: 'malformed',
      present: true,
    })
  })

  describe('artifacts captured on a password field', () => {
    const DECLARED = 'Hunter-42-zz'
    const TOKEN = 'tok-declared'
    const STEP = 4

    function declaredMask(): (text: string) => string {
      const redactor = new SecretRedactor(new SecretStore({ PW_KEY: DECLARED }))
      return (text) => redactor.redactString(text)
    }

    function passwordSnapshot(): ReturnType<typeof projectionArtifact> {
      return projectionArtifact(
        'password.dom.json',
        Buffer.from(JSON.stringify({
          elements: [
            { ref: 'password-field', role: 'textbox', inputType: 'password', name: 'Password', value: DECLARED },
            { ref: 'token-field', role: 'textbox', name: 'api token', value: TOKEN },
          ],
        })),
        STEP,
        'dom-snapshot',
      )
    }

    function passwordScreenshot(): ReturnType<typeof projectionArtifact> {
      return projectionArtifact(
        'password.png',
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from(`pixels ${DECLARED} ${TOKEN}`),
        ]),
        STEP,
        'screenshot',
      )
    }

    function enqueueCaptured(
      artifacts: readonly ReturnType<typeof projectionArtifact>[],
    ): { candidateId: string; candidateDir: string; payload: CurationCandidatePayload } {
      const outcome = enqueueCurationCandidateProjection({
        knowledgeRoot,
        projection: projection({
          artifactDescriptors: artifacts.map((artifact) => artifact.descriptor),
        }),
        artifactSources: artifacts.map((artifact) => artifact.source),
        mask: declaredMask(),
      })
      expect(outcome.kind).toBe('enqueued')
      if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
      const candidateDir = queuedCandidateDir(knowledgeRoot, outcome.candidateId)
      const parsed = readCurationCandidatePayload(candidateDir)
      if (parsed.kind !== 'parsed') throw new Error('expected parsed projection payload')
      return { candidateId: outcome.candidateId, candidateDir, payload: parsed.payload }
    }

    function filesNamed(dir: string, name: string): string[] {
      if (!existsSync(dir)) return []
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return filesNamed(path, name)
        return entry.name === name ? [path] : []
      })
    }

    it('a password-input snapshot is copied with only declared values masked', () => {
      const snapshot = passwordSnapshot()
      const { candidateDir, payload: queued } = enqueueCaptured([snapshot])

      expect(queued.artifactInventory).toHaveLength(1)
      const [inventory] = queued.artifactInventory
      const staged = readFileSync(join(candidateDir, inventory!.relativePath), 'utf8')
      expect(staged).toContain('[secret:PW_KEY]')
      expect(staged).toContain(TOKEN)
      expect(staged).not.toContain(DECLARED)
      expect(staged).not.toContain('<REDACTED')
      expect(inventory).toMatchObject({
        sha256: sha(Buffer.from(staged)),
        bytes: Buffer.byteLength(staged),
        stepIndex: STEP,
        role: 'dom-snapshot',
        originalName: 'password.dom.json',
      })
    })

    it('a screenshot is copied byte-for-byte', () => {
      const screenshot = passwordScreenshot()
      const sourceBytes = readFileSync(screenshot.source.sourcePath)
      const { candidateDir, payload: queued } = enqueueCaptured([screenshot])

      expect(queued.artifactInventory).toEqual([
        {
          relativePath: `artifacts/${screenshot.descriptor.ref.sha}`,
          sha256: screenshot.descriptor.ref.sha,
          bytes: sourceBytes.byteLength,
          stepIndex: STEP,
          role: 'screenshot',
          originalName: 'password.png',
        },
      ])
      expect(readFileSync(join(candidateDir, 'artifacts', screenshot.descriptor.ref.sha)))
        .toEqual(sourceBytes)
    })

    it('the candidate drains and commits with its artifacts', async () => {
      const snapshot = passwordSnapshot()
      const screenshot = passwordScreenshot()
      const { payload: queued } = enqueueCaptured([snapshot, screenshot])
      const maskedSnapshot = queued.artifactInventory.find((row) => row.role === 'dom-snapshot')!

      const report = await drainWithAddAuthor()

      expect(report).toMatchObject({ jobsProcessed: 1, committed: 1, failures: 0 })
      const committedSnapshot = filesNamed(knowledgeRoot, maskedSnapshot.sha256)
        .filter((path) => !path.startsWith(queueRoot(knowledgeRoot)))
      expect(committedSnapshot).toHaveLength(1)
      const committedText = readFileSync(committedSnapshot[0]!, 'utf8')
      expect(committedText).toContain('[secret:PW_KEY]')
      expect(committedText).toContain(TOKEN)
      expect(committedText).not.toContain(DECLARED)
      const committedScreenshot = filesNamed(knowledgeRoot, screenshot.descriptor.ref.sha)
        .filter((path) => !path.startsWith(queueRoot(knowledgeRoot)))
      expect(committedScreenshot).toHaveLength(1)
      expect(readFileSync(committedScreenshot[0]!))
        .toEqual(readFileSync(screenshot.source.sourcePath))
    })
  })

  describe('queue rows written with retired capture fields', () => {
    const RETIRED_RECEIPT_KEY = ['capture', 'Receipt'].join('')

    function seedRowWithRetiredReceipt(): string {
      const fields = {
        schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
        sourceRunId: 'run-before-receipt',
        scope: { tier: 'product', key: 'storefront' },
        buildOrdinal: 42,
        executionContext: 'local-interactive',
        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'button', name: 'Old checkout' }],
        summarySeed: 'Old checkout button selector',
        bodySeed: 'The old checkout button was resolved and verified.',
        distilledObservations: [],
        evidenceToken: 'evidence-before-receipt',
        attributingObservationId: 'run-before-receipt:test-0:step-0',
        artifactInventory: [],
        [RETIRED_RECEIPT_KEY]: { regions: [], interactions: [], omissions: [], redactions: [] },
      }
      const candidateId = sha(Buffer.from(canonicalJson(fields)))
      const candidateDir = queuedCandidateDir(knowledgeRoot, candidateId)
      mkdirSync(candidateDir, { recursive: true })
      writeFileSync(
        join(candidateDir, 'payload.json'),
        `${canonicalJson({ candidateId, ...fields, emittedAt: '2026-10-01T00:00:00.000Z' })}\n`,
        'utf8',
      )
      return candidateId
    }

    it('a queue row with a capture receipt is skipped as malformed', async () => {
      const oldId = seedRowWithRetiredReceipt()
      const fresh = enqueueArtifactFreeCandidateProjection({
        knowledgeRoot,
        projectionInput: projectionInput(),
      })
      expect(fresh.kind).toBe('enqueued')
      if (fresh.kind !== 'enqueued') throw new Error('expected enqueued projection')

      expect(readCurationCandidatePayload(queuedCandidateDir(knowledgeRoot, oldId)))
        .toEqual({ kind: 'malformed', present: true })
      expect(readCurationCandidatePayload(queuedCandidateDir(knowledgeRoot, fresh.candidateId)))
        .toMatchObject({ kind: 'parsed' })

      const report = await drainWithAddAuthor()

      expect(report).toMatchObject({ committed: 1, quarantined: 1 })
      expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    })

    it('a queue row with the retired flags is skipped as malformed', async () => {
      const fields = {
        schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
        sourceRunId: 'run-before-flags',
        scope: { tier: 'product', key: 'storefront' },
        buildOrdinal: 42,
        executionContext: 'local-interactive',
        secretFlagged: true,
        injectionFlagged: true,
        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'button', name: 'Old checkout' }],
        summarySeed: 'Old checkout button selector',
        bodySeed: 'The old checkout button was resolved and verified.',
        distilledObservations: [],
        evidenceToken: 'evidence-before-flags',
        attributingObservationId: 'run-before-flags:test-0:step-0',
        artifactInventory: [],
      }
      const oldId = sha(Buffer.from(canonicalJson(fields)))
      const oldDir = queuedCandidateDir(knowledgeRoot, oldId)
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(
        join(oldDir, 'payload.json'),
        `${canonicalJson({ candidateId: oldId, ...fields, emittedAt: '2026-10-01T00:00:00.000Z' })}\n`,
        'utf8',
      )
      const fresh = enqueueArtifactFreeCandidateProjection({
        knowledgeRoot,
        projectionInput: projectionInput(),
      })
      expect(fresh.kind).toBe('enqueued')
      if (fresh.kind !== 'enqueued') throw new Error('expected enqueued projection')

      expect(readCurationCandidatePayload(oldDir)).toEqual({ kind: 'malformed', present: true })
      expect(readCurationCandidatePayload(queuedCandidateDir(knowledgeRoot, fresh.candidateId)))
        .toMatchObject({ kind: 'parsed' })

      const report = await drainWithAddAuthor()

      expect(report).toMatchObject({ committed: 1, quarantined: 1 })
      expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    })
  })
})
