// A second engine over the same store gets the recorded bytes with the callback unreachable.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { JobId } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../../ports/clock.js'
import type { JobCheckpointRecord } from '../../ports/job-store.js'
import { createAgentJobQueue, UndeclaredJobCheckpointError } from '../engine.js'
import type { JobIdSource } from '../engine.js'
import { createJobKindRegistry } from '../kind-registry.js'
import type { JobHandler, JobHandlerContext, JobKindDeclaration } from '../kind-registry.js'
import { recordLlmAuthorship } from '../record-llm-authorship.js'
import type {
  JobAuthorCallback,
  JobCheckpointContext,
  JobModelCapability,
} from '../record-llm-authorship.js'
import { createFakeJobStore } from './fake-job-store.js'
import type { FakeJobStore } from './fake-job-store.js'

const AUTHORSHIP_CHECKPOINT = 'verdicts-authored'

/**
 * A model capability that counts what it was asked to do and answers distinguishably.
 *
 * Distinguishable on purpose: a primitive that returned a frozen constant would satisfy every
 * "it memoizes" assertion ever written, and the only thing that separates it from a real one
 * is that a real one's recorded bytes change when the author's answer changes.
 */
interface CountingModel {
  readonly capability: JobModelCapability
  invocations(): number
  prompts(): readonly string[]
}

function countingModel(modelId: string): CountingModel {
  let calls = 0
  const prompts: string[] = []
  return {
    capability: {
      modelId,
      async generate(request) {
        calls += 1
        prompts.push(request.prompt)
        return { text: `${modelId}#${calls}:${request.prompt}` }
      },
    },
    invocations: () => calls,
    prompts: () => [...prompts],
  }
}

/**
 * A checkpoint context that records the ORDER of what the primitive did to it.
 *
 * `publishCheckpoint` deliberately yields to the macrotask queue before it records anything.
 * A publish the primitive fired without awaiting would then log AFTER the caller resumed, so
 * the ordered log below discriminates publish-before-return from publish-and-hope rather than
 * merely observing that both happened.
 */
interface RecordingContext {
  readonly context: JobCheckpointContext
  readonly log: string[]
  recorded(): Map<string, unknown>
}

function recordingContext(options: {
  readonly model: JobModelCapability
  readonly seeded?: ReadonlyMap<string, unknown>
  readonly publishFails?: boolean
}): RecordingContext {
  const log: string[] = []
  const recorded = new Map<string, unknown>(options.seeded ?? new Map())
  return {
    log,
    recorded: () => new Map(recorded),
    context: {
      jobId: 'job_direct' as JobId,
      model: options.model,
      async readRecordedValue(checkpointId) {
        log.push(`read:${checkpointId}`)
        return recorded.has(checkpointId)
          ? { recorded: true, value: recorded.get(checkpointId) }
          : { recorded: false }
      },
      async publishCheckpoint(checkpointId, value) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (options.publishFails === true) {
          log.push(`publish-failed:${checkpointId}`)
          throw new Error('the device rejected the checkpoint')
        }
        log.push(`publish:${checkpointId}`)
        recorded.set(checkpointId, value)
      },
    },
  }
}

describe('recordLlmAuthorship: the checkpoint MISS', () => {
  it('authors exactly once and publishes the result BEFORE it returns', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({ model: model.capability })

    const result = await recordLlmAuthorship(
      probe.context,
      AUTHORSHIP_CHECKPOINT,
      async (bound) => {
        probe.log.push('author')
        return (await bound.generate({ prompt: 'author the verdicts' })).text
      },
    )
    probe.log.push('returned')

    expect(probe.log).toEqual([
      `read:${AUTHORSHIP_CHECKPOINT}`,
      'author',
      `publish:${AUTHORSHIP_CHECKPOINT}`,
      'returned',
    ])
    expect(model.invocations()).toBe(1)
    expect(result).toBe('model-a#1:author the verdicts')
    expect(probe.recorded().get(AUTHORSHIP_CHECKPOINT)).toBe(result)
  })

  it('hands the author the capability the context carries, and nothing else', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({ model: model.capability })
    let seen: JobModelCapability | undefined

    await recordLlmAuthorship(probe.context, AUTHORSHIP_CHECKPOINT, async (bound) => {
      seen = bound
      return 'ok'
    })

    expect(seen).toBe(model.capability)
    expect(seen?.modelId).toBe('model-a')
  })

  // The ordering claim's decisive half. A primitive that published without awaiting would
  // resolve happily here and leave the caller holding bytes no store ever accepted.
  it('propagates a publish failure rather than returning bytes nothing recorded', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({ model: model.capability, publishFails: true })

    await expect(
      recordLlmAuthorship(
        probe.context,
        AUTHORSHIP_CHECKPOINT,
        async (bound) => (await bound.generate({ prompt: 'p' })).text,
      ),
    ).rejects.toThrow('the device rejected the checkpoint')

    expect(model.invocations()).toBe(1)
    expect(probe.recorded().size).toBe(0)
  })

  // A memoizing primitive returning a frozen constant passes every memoization assertion.
  it('records bytes that VARY with what the author produced', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({ model: model.capability })

    const first = await recordLlmAuthorship(probe.context, 'a', async () => ({
      verdicts: ['x'],
    }))
    const second = await recordLlmAuthorship(probe.context, 'b', async () => ({
      verdicts: ['y', 'z'],
    }))

    expect(first).toEqual({ verdicts: ['x'] })
    expect(second).toEqual({ verdicts: ['y', 'z'] })
    expect(first).not.toEqual(second)
    expect(probe.recorded().get('a')).toEqual({ verdicts: ['x'] })
    expect(probe.recorded().get('b')).toEqual({ verdicts: ['y', 'z'] })
  })
})

describe('recordLlmAuthorship: the RECORDED checkpoint', () => {
  it('returns the recorded bytes and never invokes the author at all', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({
      model: model.capability,
      seeded: new Map([[AUTHORSHIP_CHECKPOINT, { verdicts: ['recorded'] }]]),
    })
    let authorCalls = 0

    const result = await recordLlmAuthorship(probe.context, AUTHORSHIP_CHECKPOINT, async () => {
      authorCalls += 1
      return { verdicts: ['fresh'] }
    })

    expect(result).toEqual({ verdicts: ['recorded'] })
    expect(authorCalls).toBe(0)
    expect(model.invocations()).toBe(0)
    // Nothing was republished either: a resume that rewrote the checkpoint would change bytes
    // the crash matrix compares for equality.
    expect(probe.log).toEqual([`read:${AUTHORSHIP_CHECKPOINT}`])
  })

  it('answers the same bytes on every read of the same recorded state', async () => {
    const model = countingModel('model-a')
    const probe = recordingContext({
      model: model.capability,
      seeded: new Map([[AUTHORSHIP_CHECKPOINT, { verdicts: ['recorded'] }]]),
    })
    const author: JobAuthorCallback<{ verdicts: string[] }> = async () => ({
      verdicts: ['fresh'],
    })

    const first = await recordLlmAuthorship(probe.context, AUTHORSHIP_CHECKPOINT, author)
    const second = await recordLlmAuthorship(probe.context, AUTHORSHIP_CHECKPOINT, author)

    expect(first).toEqual(second)
    expect(model.invocations()).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------
// Through the engine: the primitive as a handler actually reaches it.
// ---------------------------------------------------------------------------------------

function steppingClock(): ClockPort {
  let tick = 0
  return {
    now: () => {
      tick += 1
      return `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`
    },
  }
}

const idSource: JobIdSource = {
  jobIdFor: (kind, idempotencyKey) => `job_${kind}_${idempotencyKey}` as JobId,
}

function authoringDeclaration(overrides: Partial<JobKindDeclaration> = {}): JobKindDeclaration {
  return {
    kind: 'analyze-run',
    checkpointed: true,
    checkpointSchedule: [AUTHORSHIP_CHECKPOINT],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'none' },
    onPermanentFailure: 'halt-chain',
    handler: async () => ({ status: 'complete', next: [] }),
    ...overrides,
  }
}

/** A handler that authors through the primitive and reports what came back. */
function authoringHandler(options: {
  readonly authored: unknown[]
  readonly checkpointId?: string
  readonly thenThrow?: string
}): JobHandler {
  return async (context) => {
    const text = await context.recordLlmAuthorship(
      options.checkpointId ?? AUTHORSHIP_CHECKPOINT,
      async (model) => (await model.generate({ prompt: 'author the verdicts' })).text,
    )
    options.authored.push(text)
    if (options.thenThrow !== undefined) throw new Error(options.thenThrow)
    return { status: 'complete', next: [] }
  }
}

function queueOver(
  store: FakeJobStore,
  clock: ClockPort,
  model: JobModelCapability,
  declaration: JobKindDeclaration,
): ReturnType<typeof createAgentJobQueue> {
  return createAgentJobQueue({
    store,
    registry: createJobKindRegistry([declaration]),
    clock,
    idSource,
    model,
  })
}

describe('recordLlmAuthorship through the engine (across a host boundary)', () => {
  it('resumes into a FRESH engine and a FRESH model without authoring again', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const authored: unknown[] = []

    // Host one: authors, then its handler throws before it can complete the job. The engine
    // lands that exception as a retry, releasing the claim while keeping the authored
    // checkpoint durable for a fresh host.
    const first = countingModel('model-a')
    const hostOne = queueOver(
      store,
      clock,
      first.capability,
      authoringDeclaration({
        handler: authoringHandler({ authored, thenThrow: 'the host died after the model answered' }),
      }),
    )
    await hostOne.enqueue('analyze-run', {}, 'run-1')
    await expect(hostOne.runNextJob({ fence })).resolves.toMatchObject({
      disposition: 'retry-scheduled',
      reason: 'handler-threw: the host died after the model answered',
    })
    expect(first.invocations()).toBe(1)
    expect(store.checkpoints()).toHaveLength(1)
    expect(store.rows()[0]).toMatchObject({ status: 'queued', claimed: false, attempts: 1 })

    // Host two shares only the store, with a model whose counter starts at zero and stays there.
    const second = countingModel('model-b')
    const hostTwo = queueOver(
      store,
      clock,
      second.capability,
      authoringDeclaration({ handler: authoringHandler({ authored }) }),
    )
    const outcome = await hostTwo.runNextJob({ fence })

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    expect(second.invocations()).toBe(0)
    expect(authored).toHaveLength(2)
    expect(authored[1]).toBe(authored[0])
    expect(String(authored[0])).toContain('model-a')
  })

  // The test that separates "the memo lives in the store" from "the memo lives in this
  // module". A process-local cache has no entry for a checkpoint it never wrote.
  it('honours a checkpoint left by a host it never shared memory with', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const authored: unknown[] = []
    const model = countingModel('model-c')
    const queue = queueOver(
      store,
      clock,
      model.capability,
      authoringDeclaration({ handler: authoringHandler({ authored }) }),
    )
    const enqueued = await queue.enqueue('analyze-run', {}, 'run-1')

    const recorded: JobCheckpointRecord = {
      checkpointId: AUTHORSHIP_CHECKPOINT,
      jobId: enqueued.job.id,
      attempt: 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      value: 'authored by a host that is gone',
    }
    await store.publishCheckpoint(enqueued.job.id, AUTHORSHIP_CHECKPOINT, recorded, fence)

    const outcome = await queue.runNextJob({ fence })

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    expect(model.invocations()).toBe(0)
    expect(authored).toEqual(['authored by a host that is gone'])
  })

  // The positive control for both of the above: with nothing recorded, the author DOES run.
  it('authors when the store holds no checkpoint for the job', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const authored: unknown[] = []
    const model = countingModel('model-d')
    const queue = queueOver(
      store,
      clock,
      model.capability,
      authoringDeclaration({ handler: authoringHandler({ authored }) }),
    )
    await queue.enqueue('analyze-run', {}, 'run-1')

    await queue.runNextJob({ fence })

    expect(model.invocations()).toBe(1)
    expect(authored).toEqual(['model-d#1:author the verdicts'])
    expect(store.checkpoints()).toHaveLength(1)
  })

  it('refuses an authorship checkpoint the kind never declared, authoring nothing', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const model = countingModel('model-e')
    const queue = queueOver(
      store,
      clock,
      model.capability,
      authoringDeclaration({
        handler: authoringHandler({ authored: [], checkpointId: 'not-on-the-schedule' }),
      }),
    )
    await queue.enqueue('analyze-run', {}, 'run-1')

    await expect(queue.runNextJob({ fence })).rejects.toBeInstanceOf(UndeclaredJobCheckpointError)
    expect(model.invocations()).toBe(0)
    expect(store.checkpoints()).toEqual([])
  })

  it('refuses authorship inside an uncheckpointed kind, which has nothing to resume', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const model = countingModel('model-f')
    const queue = queueOver(
      store,
      clock,
      model.capability,
      authoringDeclaration({
        kind: 'chat',
        checkpointed: false,
        checkpointSchedule: [],
        handler: authoringHandler({ authored: [], checkpointId: 'anything-at-all' }),
      }),
    )
    await queue.enqueue('chat', {}, 'turn-1')

    await expect(queue.runNextJob({ fence })).rejects.toBeInstanceOf(UndeclaredJobCheckpointError)
    expect(model.invocations()).toBe(0)
    expect(store.checkpoints()).toEqual([])
  })
})

// Checked by `tsc --noEmit`, so a plain vitest run passes them vacuously.

describe('the model is reachable only as the author callback argument', () => {
  it('gives a handler no model member at all', () => {
    expectTypeOf<keyof JobHandlerContext>().toEqualTypeOf<
      'job' | 'payload' | 'publishCheckpoint' | 'recordLlmAuthorship'
    >()
  })

  it('hands the capability to the author callback as its one and only argument', () => {
    expectTypeOf<Parameters<JobAuthorCallback<string>>>().toEqualTypeOf<[JobModelCapability]>()
  })

  it('keeps the capability on the context the ENGINE builds, which no handler receives', () => {
    expectTypeOf<keyof JobCheckpointContext>().toEqualTypeOf<
      'jobId' | 'model' | 'readRecordedValue' | 'publishCheckpoint'
    >()
  })
})

// ---------------------------------------------------------------------------------------
// "Exactly one primitive exists" as a declaration-site fact rather than a count.
// A count cannot tell an implementation apart from an import of it, a mention in a comment or
// a fixture named after it, so this looks for DECLARATIONS and prints the ones it found.
// ---------------------------------------------------------------------------------------

const PRIMITIVE_NAME = 'recordLlmAuthorship'
const DECLARES_PRIMITIVE = /\bfunction\s+recordLlmAuthorship\b/
// Assembled rather than written out, because this file is inside the scan: a literal spelling
// of the declaration here would make the test find itself and report two primitives. That the
// scan is sharp enough to trip on its own prose is the point — it is looking for declarations,
// not for the name.
const DECLARATION_PREFIX = ['export', 'async', 'function', PRIMITIVE_NAME].join(' ')

interface ScannedFile {
  readonly repoRelative: string
  readonly text: string
}

function scanWorkspaceSources(): ScannedFile[] {
  const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const files: ScannedFile[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      files.push({
        repoRelative: join('packages', relative(packagesRoot, full)).split(sep).join('/'),
        text: readFileSync(full, 'utf8'),
      })
    }
  }

  for (const pkg of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, pkg, 'src')
    let isDirectory = false
    try {
      isDirectory = statSync(src).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) walk(src)
  }

  return files
}

describe('exactly one recordLlmAuthorship primitive exists', () => {
  const files = scanWorkspaceSources()

  // The scanner's own control. A walk that landed on the wrong directory would otherwise
  // report a clean single declaration by finding nothing at all.
  it('scanned the workspace it meant to scan', () => {
    expect(files.length).toBeGreaterThan(300)
    const mentioning = files.filter((file) => file.text.includes(PRIMITIVE_NAME))
    expect(mentioning.map((file) => file.repoRelative)).toContain(
      'packages/agent/src/jobs/record-llm-authorship.ts',
    )
    expect(mentioning.length).toBeGreaterThan(2)
  })

  it('is declared in exactly one module, and that module is the primitive', () => {
    const sites = files.flatMap((file) =>
      file.text
        .split('\n')
        .map((line, index) => ({ file: file.repoRelative, line: index + 1, text: line.trim() }))
        .filter((candidate) => DECLARES_PRIMITIVE.test(candidate.text)),
    )

    expect(sites).toHaveLength(1)
    expect(sites[0]?.file).toBe('packages/agent/src/jobs/record-llm-authorship.ts')
    expect(sites[0]?.text).toContain(DECLARATION_PREFIX)
  })
})
