import { describe, expect, it } from 'vitest'

import { canonicalJson, jobEnqueueRequestSchema } from '@vostride/agent-qa-schema'
import type { Job, JobId, JobKind } from '@vostride/agent-qa-schema'

import {
  createJobKindRegistry,
  DuplicateJobKindError,
  IncompleteJobKindDeclarationError,
  InconsistentJobKindDeclarationError,
  UnknownJobKindError,
} from '../kind-registry.js'
import type { JobHandlerContext, JobKindDeclaration } from '../kind-registry.js'
import { REAL_JOB_KIND_DECLARATIONS, createRealJobKindRegistry } from '../kinds.js'

/**
 * The kind set, read from the SHIPPED contract rather than retyped here.
 *
 * The kind value array is module-private in the schema package on purpose, so the enum inside
 * the enqueue contract is the one published enumeration of the kind vocabulary. Reading it
 * here is what makes the conformance test below structurally incapable of missing a kind: a
 * sixth kind added to the contract reddens it without anyone remembering to edit a list.
 */
const CONTRACT_JOB_KINDS: readonly JobKind[] = jobEnqueueRequestSchema.shape.kind.options

const REQUIRED_DECLARATION_FIELDS = [
  'kind',
  'checkpointed',
  'checkpointSchedule',
  'allowedSuccessors',
  'maxAttempts',
  'backoff',
  'onPermanentFailure',
  'handler',
] as const

function completeDeclaration(overrides: Partial<JobKindDeclaration> = {}): JobKindDeclaration {
  return {
    kind: 'consolidate',
    checkpointed: true,
    checkpointSchedule: ['fixture-checkpoint'],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'none' },
    onPermanentFailure: 'halt-chain',
    handler: async () => ({ status: 'complete', next: [] }),
    ...overrides,
  }
}

function fakeJob(kind: JobKind, overrides: Partial<Job> = {}): Job {
  return {
    id: `job_${kind}` as JobId,
    kind,
    status: 'queued',
    summary: `fixture ${kind}`,
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface RecordedPublish {
  readonly checkpointId: string
  readonly value: unknown
}

function recordingContext(
  job: Job,
  payload: unknown = {},
): { context: JobHandlerContext; published: RecordedPublish[] } {
  const published: RecordedPublish[] = []
  return {
    published,
    context: {
      job,
      payload,
      publishCheckpoint: async (checkpointId, value) => {
        published.push({ checkpointId, value })
      },
      // the stand-ins never author, and this file drives them without an engine.
      // A refusal rather than a stub answer, so a handler that quietly started authoring would
      // fail here loudly instead of being handed a plausible-looking value.
      recordLlmAuthorship: async () => {
        throw new Error('the stand-in handlers do not author; see record-llm-authorship.test.ts')
      },
    },
  }
}

describe('createJobKindRegistry declaration validation', () => {
  it('refuses a second declaration of the same kind, naming the kind', () => {
    try {
      createJobKindRegistry([
        completeDeclaration({ kind: 'consolidate' }),
        completeDeclaration({ kind: 'consolidate' }),
      ])
      expect.unreachable('a duplicate kind must not register')
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateJobKindError)
      expect((error as DuplicateJobKindError).jobKind).toBe('consolidate')
      expect(String(error)).toContain('consolidate')
    }
  })

  // No defaults, on the same discipline the function layer uses for its required sink: a
  // declaration that omits a field the engine READS must fail to construct, because the
  // alternative is a kind whose recovery behaviour was decided by whoever wrote the default
  // rather than by whoever wrote the kind.
  it.each(REQUIRED_DECLARATION_FIELDS)(
    'refuses a declaration missing %s, naming the field',
    (field) => {
      const declaration = { ...completeDeclaration() } as Record<string, unknown>
      delete declaration[field]

      try {
        createJobKindRegistry([declaration as unknown as JobKindDeclaration])
        expect.unreachable(`a declaration missing ${field} must not register`)
      } catch (error) {
        expect(error).toBeInstanceOf(IncompleteJobKindDeclarationError)
        expect((error as IncompleteJobKindDeclarationError).field).toBe(field)
        expect(String(error)).toContain(field)
      }
    },
  )

  // The negative control for the it.each above: the same declaration WITH every field
  // registers cleanly. Without it, a validator that refused everything would pass all eight.
  it('registers the same declaration when no field is missing', () => {
    const registry = createJobKindRegistry([completeDeclaration()])
    expect(registry.list().map((entry) => entry.kind)).toEqual(['consolidate'])
  })

  // The declared-but-empty hole. A kind registered `checkpointed: true` with an empty
  // schedule contributes ZERO crash points to a registry-driven matrix, so the matrix passes
  // for it vacuously while the coverage table says it is covered. Making that pair
  // unregisterable is what turns "we remembered to fill the schedule in" into a structure.
  it('refuses a checkpointed kind that declares no checkpoints', () => {
    expect(() =>
      createJobKindRegistry([completeDeclaration({ checkpointed: true, checkpointSchedule: [] })]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it('refuses an uncheckpointed kind that declares checkpoints anyway', () => {
    expect(() =>
      createJobKindRegistry([
        completeDeclaration({ checkpointed: false, checkpointSchedule: ['ghost'] }),
      ]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it('registers an uncheckpointed kind whose schedule is empty', () => {
    const registry = createJobKindRegistry([
      completeDeclaration({ checkpointed: false, checkpointSchedule: [] }),
    ])
    expect(registry.require('consolidate').checkpointSchedule).toEqual([])
  })

  it('refuses a schedule that repeats a checkpoint id', () => {
    expect(() =>
      createJobKindRegistry([completeDeclaration({ checkpointSchedule: ['one', 'one'] })]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it('refuses a schedule entry that is not a usable id', () => {
    expect(() =>
      createJobKindRegistry([completeDeclaration({ checkpointSchedule: ['  '] })]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses maxAttempts %p', (maxAttempts) => {
    expect(() => createJobKindRegistry([completeDeclaration({ maxAttempts })])).toThrowError(
      InconsistentJobKindDeclarationError,
    )
  })

  it('registers maxAttempts 1 — a single-attempt kind is legal', () => {
    const registry = createJobKindRegistry([completeDeclaration({ maxAttempts: 1 })])
    expect(registry.require('consolidate').maxAttempts).toBe(1)
  })

  it('refuses a repeated successor declaration', () => {
    expect(() =>
      createJobKindRegistry([
        completeDeclaration({ allowedSuccessors: ['curate-memory', 'curate-memory'] }),
      ]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it.each([
    { kind: 'fixed', delayMs: -1 },
    { kind: 'exponential', initialDelayMs: 10, factor: 0.5, maxDelayMs: 100 },
    { kind: 'exponential', initialDelayMs: 100, factor: 2, maxDelayMs: 10 },
    { kind: 'sometimes' },
  ])('refuses the backoff policy %p', (backoff) => {
    expect(() =>
      createJobKindRegistry([
        completeDeclaration({ backoff: backoff as JobKindDeclaration['backoff'] }),
      ]),
    ).toThrowError(InconsistentJobKindDeclarationError)
  })

  it('keeps the declared values rather than substituting its own', () => {
    const declaration = completeDeclaration({
      maxAttempts: 7,
      checkpointSchedule: ['a', 'b'],
      allowedSuccessors: ['curate-memory'],
      backoff: { kind: 'fixed', delayMs: 250 },
    })
    const registered = createJobKindRegistry([declaration]).require('consolidate')

    expect(registered.maxAttempts).toBe(7)
    expect(registered.checkpointSchedule).toEqual(['a', 'b'])
    expect(registered.allowedSuccessors).toEqual(['curate-memory'])
    expect(registered.backoff).toEqual({ kind: 'fixed', delayMs: 250 })
  })

  it('refuses to hand back a kind nobody declared', () => {
    const registry = createJobKindRegistry([completeDeclaration()])
    expect(registry.get('chat')).toBeUndefined()
    expect(() => registry.require('chat')).toThrowError(UnknownJobKindError)
  })

  it('lists declarations in kind order regardless of declaration order', () => {
    const registry = createJobKindRegistry([
      completeDeclaration({ kind: 'curate-memory' }),
      completeDeclaration({ kind: 'chat', checkpointed: false, checkpointSchedule: [] }),
      completeDeclaration({ kind: 'consolidate' }),
    ])
    expect(registry.list().map((entry) => entry.kind)).toEqual([
      'chat',
      'consolidate',
      'curate-memory',
    ])
  })
})

describe('the real job kinds', () => {
  // Positive control for the enumeration itself. An accessor that returned an empty array
  // would make every conformance assertion below pass without examining a single kind.
  it('reads exactly the shipped kinds out of the enqueue contract, by sorted list', () => {
    expect([...CONTRACT_JOB_KINDS].sort()).toEqual([
      'analyze-run',
      'chat',
      'consolidate',
      'curate-memory',
    ])
  })

  it.each(CONTRACT_JOB_KINDS)('declares %s', (kind) => {
    const declaration = REAL_JOB_KIND_DECLARATIONS.find((entry) => entry.kind === kind)
    expect(declaration, `no declaration for ${kind}`).toBeDefined()
  })

  it('registers every contract kind and nothing else', () => {
    expect(createRealJobKindRegistry().list().map((entry) => entry.kind)).toEqual(
      [...CONTRACT_JOB_KINDS].sort(),
    )
  })

  // JOBQ-04 / C9, on the REAL kind rather than a stand-in, so a later "unification" refactor
  // that starts checkpointing chat turns trips this by name.
  it('registers chat as an uncheckpointed kind with no checkpoints at all', () => {
    const chat = createRealJobKindRegistry().require('chat')
    expect(chat.checkpointed).toBe(false)
    expect(chat.checkpointSchedule).toEqual([])
  })

  it('gives every checkpointed kind a non-empty schedule', () => {
    for (const declaration of REAL_JOB_KIND_DECLARATIONS) {
      if (declaration.checkpointed) {
        expect(
          declaration.checkpointSchedule.length,
          `${declaration.kind} declares no checkpoints`,
        ).toBeGreaterThan(0)
      } else {
        expect(declaration.checkpointSchedule).toEqual([])
      }
    }
  })

  // A declared successor nobody declares is a chain that can be enqueued and never run.
  it('declares only successors that are themselves registered', () => {
    const registry = createRealJobKindRegistry()
    for (const declaration of REAL_JOB_KIND_DECLARATIONS) {
      for (const successor of declaration.allowedSuccessors) {
        expect(registry.get(successor), `${declaration.kind} -> ${successor}`).toBeDefined()
      }
    }
  })

  it('declares the ratified analyze-run -> curate-memory topology', () => {
    expect(createRealJobKindRegistry().require('analyze-run').allowedSuccessors).toContain(
      'curate-memory',
    )
  })
})

describe('the stand-in handlers', () => {
  // Indistinguishable no-ops would satisfy "every kind is registered" perfectly, and the kill
  // matrix would then compare identical histories and prove nothing about any of them. Each handler must publish its OWN declared schedule with its OWN bytes.
  it.each(REAL_JOB_KIND_DECLARATIONS)(
    'publishes exactly the declared schedule of $kind, in order',
    async (declaration) => {
      const { context, published } = recordingContext(fakeJob(declaration.kind))
      const outcome = await declaration.handler(context)

      expect(published.map((entry) => entry.checkpointId)).toEqual(declaration.checkpointSchedule)
      expect(outcome.status).toBe('complete')
    },
  )

  it('produces bytes no two kinds share', async () => {
    const seen = new Map<string, JobKind>()
    for (const declaration of REAL_JOB_KIND_DECLARATIONS) {
      const { context, published } = recordingContext(fakeJob(declaration.kind))
      await declaration.handler(context)
      for (const entry of published) {
        const bytes = canonicalJson(entry.value as Record<string, unknown>)
        const previous = seen.get(bytes)
        expect(
          previous,
          `${declaration.kind} publishes the same bytes as ${String(previous)}`,
        ).toBeUndefined()
        seen.set(bytes, declaration.kind)
      }
    }
    // Every declared checkpoint contributed one distinct payload.
    expect(seen.size).toBe(
      REAL_JOB_KIND_DECLARATIONS.reduce(
        (total, entry) => total + entry.checkpointSchedule.length,
        0,
      ),
    )
  })

  // Plan 06 compares an interrupted history against an uninterrupted one, so a handler whose
  // bytes depend on WHICH attempt published them would make every crash leg differ for a
  // reason that has nothing to do with recovery.
  it('publishes the same bytes on a later attempt as on the first', async () => {
    for (const declaration of REAL_JOB_KIND_DECLARATIONS) {
      const first = recordingContext(fakeJob(declaration.kind, { attempts: 1 }))
      const second = recordingContext(
        fakeJob(declaration.kind, { attempts: 4, updatedAt: '2026-02-02T00:00:00.000Z' }),
      )
      await declaration.handler(first.context)
      await declaration.handler(second.context)
      expect(canonicalJson({ p: first.published })).toEqual(canonicalJson({ p: second.published }))
    }
  })

  it('chains its declared successors when the payload scripts a chain', async () => {
    const declaration = createRealJobKindRegistry().require('analyze-run')
    const { context } = recordingContext(fakeJob('analyze-run'), { chain: true })
    const outcome = await declaration.handler(context)

    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') return
    expect(outcome.next.map((entry) => entry.kind).sort()).toEqual(
      [...declaration.allowedSuccessors].sort(),
    )
    for (const request of outcome.next) {
      expect(request.idempotencyKey.trim()).not.toBe('')
    }
  })

  it('chains nothing when the payload scripts no chain', async () => {
    const declaration = createRealJobKindRegistry().require('analyze-run')
    const { context } = recordingContext(fakeJob('analyze-run'), {})
    const outcome = await declaration.handler(context)

    expect(outcome).toEqual({ status: 'complete', next: [] })
  })

  it.each(['retryable', 'permanent'] as const)(
    'reports the %s failure the payload scripts',
    async (status) => {
      const declaration = createRealJobKindRegistry().require('analyze-run')
      const { context } = recordingContext(fakeJob('analyze-run'), {
        fail: status,
        reason: 'scripted',
      })
      const outcome = await declaration.handler(context)

      expect(outcome).toEqual({ status, reason: 'scripted' })
    },
  )
})

describe('the permanent-failure disposition', () => {
  it('halts the chain for every kind that declares no continuation', () => {
    for (const declaration of REAL_JOB_KIND_DECLARATIONS) {
      if (declaration.kind === 'analyze-run') continue
      expect(declaration.onPermanentFailure, declaration.kind).toBe('halt-chain')
    }
  })

  // The one ratified continuation: analyze-run's chain proceeds with unknown verdicts so a
  // dead head never leaves the downstream jobs waiting (spec §1.2).
  it('produces analyze-run continuation instances inside its declared topology', () => {
    const declaration = createRealJobKindRegistry().require('analyze-run')
    expect(typeof declaration.onPermanentFailure).toBe('function')
    if (typeof declaration.onPermanentFailure !== 'function') return

    const job = fakeJob('analyze-run')
    const produced = declaration.onPermanentFailure({ job, payload: {}, reason: 'no model' })

    expect(produced.length).toBeGreaterThan(0)
    for (const request of produced) {
      expect(declaration.allowedSuccessors).toContain(request.kind)
      expect(request.idempotencyKey.trim()).not.toBe('')
    }
  })

  it('produces byte-identical continuations for the same job twice', () => {
    const declaration = createRealJobKindRegistry().require('analyze-run')
    if (typeof declaration.onPermanentFailure !== 'function') {
      expect.unreachable('analyze-run declares a continuation producer')
      return
    }
    const job = fakeJob('analyze-run')
    const once = declaration.onPermanentFailure({ job, payload: {}, reason: 'boom' })
    const twice = declaration.onPermanentFailure({ job, payload: {}, reason: 'boom' })
    expect(canonicalJson({ next: [...once] })).toEqual(canonicalJson({ next: [...twice] }))
  })
})
