import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  constructKnowledgeReader,
  type ComposeJobRecoveryInput,
  type ComposeLocalAgentInput,
  type CuratorAuthor,
  type JobRecoveryHost,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import * as knowledgeLocal from '@vostride/agent-qa-knowledge-local'
import {
  deriveBundleTrust,
  enqueueCurationCandidateProjection,
  enumerateBundleDirs,
  loadBundle,
  publishBundleForTest as publishBundle,
  rebuildIndex,
  type LoadedBundle,
} from '@vostride/agent-qa-knowledge-local'
import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  BundleOutcomeEventSchema,
  type Anchor,
  type CurationAuthorship,
  type Delta,
  type ExecutionContext,
  type RecordId,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runDaemonHost, type DaemonHostOperations } from '../host.js'

const PRODUCT = 'tracer-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const
const SEED_ORDINAL = 40
const RUN_ORDINAL = 42
const POLL_INTERVAL_MS = 30_000
const SESSION_ID = '00000000-0000-4000-8000-000000000432'

const MODEL: JobModelCapability = {
  modelId: 'test:432-local-learning',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/agent-qa.config.yaml',
    entries: [],
  }),
}

const PLACE_ORDER: Anchor[] = [
  { t: 'el', role: 'button', name: 'Place order', ordinal: 0 },
  { t: 'page', route: '/checkout' },
]
const APPLY_COUPON: Anchor[] = [
  { t: 'el', role: 'button', name: 'Apply coupon', ordinal: 0 },
  { t: 'page', route: '/checkout' },
]

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Project {
  agentQaRoot: string
  knowledgeRoot: string
}

function makeProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-432-local-learning-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  return { agentQaRoot, knowledgeRoot: join(root, 'agent-qa-knowledge') }
}

function seedActive(project: Project, anchors: Anchor[], seed: string): RecordId {
  const name = (anchors[0] as Extract<Anchor, { t: 'el' }>).name
  const published = publishBundle({
    knowledgeRoot: project.knowledgeRoot,
    productKey: PRODUCT,
    writerLeaseId: `432-seed-${seed}`,
  }, {
    draft: {
      kind: 'fact',
      subtype: 'selector',
      anchors,
      scope: SCOPE,
      summary: `Use the ${name} button on checkout.`,
      body: `The ${name} button was resolved and verified on checkout.`,
      distilledEvidenceRef: { id: `seed-${seed}`, sha: seed.padEnd(64, '0').slice(0, 64) },
      originStage: 'run-curation',
    },
    discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name } },
    originClass: 'agent-verified',
    createdAtOrdinal: SEED_ORDINAL,
    screenStates: [],
    initialEvents: [
      BundleOutcomeEventSchema.parse({
        type: 'confirmed',
        evidenceToken: asEvidenceToken(`seed-confirmed-${seed}`),
        curationJobId: `seed-${seed}`,
        buildOrdinal: SEED_ORDINAL,
        origin: 'agent-verified',
      }),
      BundleOutcomeEventSchema.parse({
        type: 'promoted',
        evidenceToken: asEvidenceToken(`seed-promoted-${seed}`),
        curationJobId: `seed-${seed}`,
        buildOrdinal: SEED_ORDINAL,
      }),
    ],
    relations: [],
    provenance: { mode: 'standalone', sourceDescription: '432 local learning tracer seed' },
    artifacts: [],
  })
  if (published.kind !== 'published') throw new Error(`expected seed publish, got ${published.kind}`)
  return published.id
}

function enqueueRunCandidate(project: Project, executionContext: ExecutionContext): string {
  const outcome = enqueueCurationCandidateProjection({
    knowledgeRoot: project.knowledgeRoot,
    projection: {
      sourceRunId: `run-432-${executionContext}`,
      scope: SCOPE,
      buildOrdinal: RUN_ORDINAL,
      executionContext,      kind: 'fact',
      subtype: 'selector',
      anchors: PLACE_ORDER,
      summarySeed: 'Place order button moved into the checkout footer',
      bodySeed: 'The Place order button now renders inside the checkout footer.',
      distilledObservations: [{
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'place-order-click', ordinal: 0 },
        platform: 'web',
        element: { naturalKey: 'button:place-order:0' },
        observedAtOrdinal: RUN_ORDINAL,
      }],
      evidenceToken: `evidence-432-${executionContext}`,
      attributingObservationId: `observation-432-${executionContext}`,
      artifactDescriptors: [],
      emittedAt: '2026-09-29T00:00:00.000Z',
    },
    artifactSources: [],
  })
  if (outcome.kind !== 'enqueued') throw new Error(`expected enqueued candidate, got ${outcome.kind}`)
  return outcome.candidateId
}

/** Authors exactly one supersession of the retrieved Place order record. */
function supersedingAuthor(victimId: RecordId): CuratorAuthor {
  return async (job, neighbors) => {
    const victim = neighbors.find(({ recordId }) => recordId === victimId)
    if (victim === undefined) throw new Error('the seeded victim was not retrieved as a neighbor')
    const authorship: CurationAuthorship = {
      path: 'llm',
      model: { id: '432-local-learning-fixture' },
      executionContext: job.executionContext,
    }
    const delta: Delta = {
      kind: 'Supersede',
      origin: 'agent',
      scope: job.scope,
      citedIds: [victimId],
      precondition: [{
        recordId: victimId,
        observedStatus: victim.observedStatus,
        observedOrdinal: victim.observedOrdinal,
      }],
      authorship,
      victimId,
      newBundle: {
        kind: 'fact',
        subtype: 'selector',
        anchors: job.anchors,
        scope: job.scope,
        summary: job.summarySeed,
        body: job.bodySeed,
        distilledEvidenceRef: { id: `curation-candidate-${job.candidateId}`, sha: job.candidateId },
        originStage: 'run-curation',
      },
      evidenceToken: asEvidenceToken(`supersede-${job.candidateId}`),
    }
    return { kind: 'authored', deltas: [delta], authorship }
  }
}

interface DrainCall {
  options: Parameters<DaemonHostOperations['drainQueue']>[0]
  report: Awaited<ReturnType<DaemonHostOperations['drainQueue']>>
}

/**
 * The real daemon host and the real curator drain. Only the scheduler, signals, socket server and
 * embedder child are substituted, so the drain runs in this process against the temporary root.
 */
function startDaemon(project: Project, author: CuratorAuthor) {
  const signals = new Map<NodeJS.Signals, () => void>()
  const intervals = new Map<number, { callback: () => void; intervalMs: number }>()
  const drainCalls: DrainCall[] = []
  let nextTimerId = 1
  const operations = {
    composeJobRecovery: (_input: ComposeJobRecoveryInput) => ({
      store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
      recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
      resumePending: () => Promise.resolve([]),
      close: vi.fn(),
    }) as unknown as JobRecoveryHost,
    composeLocalAgent: (_input: ComposeLocalAgentInput) => ({
      registry: {} as FunctionRegistry,
      jobs: () => Promise.resolve({
        queue: { runNextJob: () => Promise.resolve({ ran: false, reason: 'no-job' }) },
      }),
      close: vi.fn(),
    }) as unknown as LocalAgentHost,
    drainQueue: vi.fn<DaemonHostOperations['drainQueue']>(async (options) => {
      const report = await knowledgeLocal.drainQueue(options)
      drainCalls.push({ options, report })
      return report
    }),
    setInterval: (callback: () => void, intervalMs: number) => {
      const timerId = nextTimerId++
      intervals.set(timerId, { callback, intervalMs })
      return timerId as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer as unknown as number)
    },
    setTimeout: () => 99 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: vi.fn(),
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: vi.fn(),
    startInvokeServer: async ({ socketPath }: { socketPath: string }) => ({
      socketPath,
      close: () => Promise.resolve(),
    }),
    randomUUID: () => SESSION_ID,
  } as unknown as Partial<DaemonHostOperations>
  const running = runDaemonHost({
    agentQaRoot: project.agentQaRoot,
    knowledgeRoot: project.knowledgeRoot,
    config: CONFIG,
    model: () => MODEL,
    author: () => author,
    operations,
    logger: { info: vi.fn(), error: vi.fn() },
  })
  return {
    drainCalls,
    async drainOnce(): Promise<DrainCall> {
      const deadline = Date.now() + 10_000
      while (![...intervals.values()].some(({ intervalMs }) => intervalMs === POLL_INTERVAL_MS)) {
        if (Date.now() >= deadline) throw new Error('daemon never scheduled its drain poll')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const before = drainCalls.length
      for (const { callback, intervalMs } of [...intervals.values()]) {
        if (intervalMs === POLL_INTERVAL_MS) callback()
      }
      while (drainCalls.length === before) {
        if (Date.now() >= deadline) throw new Error('daemon poll did not reach the curator drain')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return drainCalls.at(-1)!
    },
    async stop(): Promise<void> {
      const listener = signals.get('SIGTERM')
      if (listener === undefined) throw new Error('SIGTERM listener was not installed')
      listener()
      await expect(running).resolves.toBe(0)
    },
  }
}

function bundles(project: Project): LoadedBundle[] {
  return enumerateBundleDirs(project.knowledgeRoot).map(({ dir }) => {
    const loaded = loadBundle(dir)
    if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle at ${dir}`)
    return loaded.bundle
  })
}

function byId(project: Project, id: RecordId): LoadedBundle {
  const found = bundles(project).find(({ manifest }) => manifest.id === id)
  if (found === undefined) throw new Error(`missing bundle ${id}`)
  return found
}

function replacementOf(project: Project, victimId: RecordId, siblingId: RecordId): LoadedBundle {
  const others = bundles(project).filter(({ manifest }) =>
    manifest.id !== victimId && manifest.id !== siblingId)
  expect(others).toHaveLength(1)
  return others[0]!
}

function nextBriefIds(project: Project): RecordId[] {
  const reader = constructKnowledgeReader({
    knowledgeRoot: project.knowledgeRoot,
    product: PRODUCT,
    asOfBuild: RUN_ORDINAL + 1,
    recordCap: 24,
  })
  const { brief } = reader.getRunBrief(SCOPE, 1_000)
  return brief.lines.map(({ id }) => id)
}

async function seededProject() {
  const project = makeProject()
  const victimId = seedActive(project, PLACE_ORDER, 'place-order')
  const siblingId = seedActive(project, APPLY_COUPON, 'apply-coupon')
  await rebuildIndex({ knowledgeRoot: project.knowledgeRoot })
  expect(nextBriefIds(project)).toEqual(expect.arrayContaining([victimId, siblingId]))
  return { project, victimId, siblingId }
}

describe('local headless learning through the existing worker path', () => {
  it('a local-headless daemon drain publishes a real supersession', async () => {
    const { project, victimId, siblingId } = await seededProject()
    const candidateId = enqueueRunCandidate(project, 'local-headless')
    const author = vi.fn(supersedingAuthor(victimId))
    const daemon = startDaemon(project, author)
    try {
      const drained = await daemon.drainOnce()
      expect(drained.options.executionContext).toBe('local-headless')
      expect(drained.report).toMatchObject({ kind: 'drained', committed: 1, failures: 0, remaining: 0 })
      expect(drained.report).toMatchObject({ downgraded: 0 })
    } finally {
      await daemon.stop()
    }
    expect(author.mock.calls[0]![0].executionContext).toBe('local-headless')
    expect(knowledgeLocal.listQueuedCandidates(project.knowledgeRoot)).not.toContain(candidateId)

    const victim = byId(project, victimId)
    expect(deriveBundleTrust(victim).status).toBe('superseded')
    const replacement = replacementOf(project, victimId, siblingId)
    expect(replacement.relations.relations).toContainEqual(
      expect.objectContaining({ type: 'supersedes', targetId: victimId }),
    )
    expect(replacement.relations.relations).not.toContainEqual(
      expect.objectContaining({ type: 'proposed-supersession-of' }),
    )
    expect(replacement.provenance).toMatchObject({
      mode: 'run-linked',
      authorship: { executionContext: 'local-headless' },
    })
    expect(deriveBundleTrust(byId(project, siblingId)).status).toBe('active')
  }, 30_000)

  it('the next brief serves the replacement instead of the superseded record', async () => {
    const { project, victimId, siblingId } = await seededProject()
    enqueueRunCandidate(project, 'local-headless')
    const daemon = startDaemon(project, supersedingAuthor(victimId))
    try {
      await daemon.drainOnce()
    } finally {
      await daemon.stop()
    }
    const replacement = replacementOf(project, victimId, siblingId)

    const served = nextBriefIds(project)
    expect(served).toContain(replacement.manifest.id)
    expect(served).toContain(siblingId)
    expect(served).not.toContain(victimId)
  }, 30_000)

  it('keeps the same daemon drain proposed when the queued run came from ci', async () => {
    const { project, victimId, siblingId } = await seededProject()
    enqueueRunCandidate(project, 'ci')
    const author = vi.fn(supersedingAuthor(victimId))
    const daemon = startDaemon(project, author)
    try {
      const drained = await daemon.drainOnce()
      expect(drained.options.executionContext).toBe('local-headless')
      expect(drained.report).toMatchObject({
        kind: 'drained',
        committed: 1,
        downgraded: 1,
        failures: 0,
      })
    } finally {
      await daemon.stop()
    }
    expect(author.mock.calls[0]![0].executionContext, 'the queued run context wins').toBe('ci')

    const victim = byId(project, victimId)
    expect(deriveBundleTrust(victim).status).toBe('active')
    expect(victim.events.some(({ type }) => type === 'superseded')).toBe(false)
    const relations = bundles(project).flatMap((bundle) => bundle.relations.relations)
    expect(relations).toContainEqual(
      expect.objectContaining({ type: 'proposed-supersession-of', targetId: victimId }),
    )
    expect(relations).not.toContainEqual(expect.objectContaining({ type: 'supersedes' }))
    // 2026-10-18 (444-20, D-58): the proposed correction is its own candidate. It never lands on
    // the victim's id, so the victim carries no relation to itself.
    const proposals = bundles(project)
      .filter(({ manifest }) => manifest.id !== victimId && manifest.id !== siblingId)
    expect(proposals.map((bundle) => ({
      status: deriveBundleTrust(bundle).status,
      proposedOf: bundle.relations.relations
        .filter(({ type }) => type === 'proposed-supersession-of')
        .map(({ targetId }) => targetId),
    }))).toEqual([{ status: 'candidate', proposedOf: [victimId] }])
    expect(victim.relations.relations)
      .not.toContainEqual(expect.objectContaining({ type: 'proposed-supersession-of' }))

    const served = nextBriefIds(project)
    expect(served).toContain(victimId)
    expect(served).toContain(siblingId)
  }, 30_000)
})
