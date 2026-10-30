// Every proposal here is an older record the digest reads none of; a second run is the control.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction, RUNS_DIGEST_FUNCTION_ID } from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig } from '@vostride/agent-qa-knowledge-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardRunNotification,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  CompletedRunHandoff,
  RunDigest,
  Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLI_FUNCTION_CALLER } from '../composition/local-agent-host.js'
import {
  digestFetchCommand,
  runPostRunTail,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../curation/post-run-tail.js'
import { fileLeftoverKnowledgeProposal } from '../composition/__tests__/leftover-knowledge-proposal.js'
import { enqueueThroughTheStep } from './post-run-step-harness.js'

const MINT_IDENTITY = (filePath: string): string => filePath


/** The heartbeat run whose chain drains in-process — the digest's subject. */
const RUN_ID = 'run-391-06-batching'
/** The cross-instance attribution control: a DIFFERENT run, minting into the same store. */
const OTHER_RUN = 'run-391-06-batching-other'
/** A third run nothing is attributed to — the zero-proposal arm. */
const EMPTY_RUN = 'run-391-06-batching-empty'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:run-digest-batching',
  // Unparseable text degrades the author to the deterministic floor, so no provider is needed.
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/run-digest-batching.config.yaml',
    entries: [],
  }),
}

function rootCause(perTest: number): Verdict {
  return {
    class: 'app_bug',
    producer: 'deterministic-classifier',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the submit control is gone from the checkout DOM',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  } as Verdict
}

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'batching-storefront' },
    buildOrdinal: 4,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 'TST-801',
        testName: 'checks out',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [],
        rootCause: rootCause(0),
      },
      {
        testId: 'TST-802',
        testName: 'checks out with a coupon',
        filePath: 'tests/coupon.yaml',
        testIndex: 1,
        outcome: 'failed',
        steps: [],
        rootCause: rootCause(1),
      },
    ],
  } as unknown as CompletedRunHandoff
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  agentQaRoot: string
  knowledgeRoot: string
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  /** How many times THIS tail asked the function layer for a digest. */
  digestReads: { count: number }
  options(runId: string): RunPostRunTailOptions
}

function fixture(): Fixture {
  const agentQaRoot = mkdtempSync(join(tmpdir(), 'agent-qa-391-06-batching-'))
  roots.push(agentQaRoot)
  const knowledgeRoot = join(agentQaRoot, 'knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })

  for (const runId of [RUN_ID, OTHER_RUN, EMPTY_RUN]) {
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(fixtureHandoff(runId))}\n`, 'utf8')
  }

  const info = vi.fn<(message: string) => void>()
  const warn = vi.fn<(message: string) => void>()
  const clock = { value: 1_000_000 }
  const digestReads = { count: 0 }
  const defaults = defaultOperationsCapture()

  return {
    agentQaRoot,
    knowledgeRoot,
    info,
    warn,
    digestReads,
    options(runId: string): RunPostRunTailOptions {
      return {
        runId,
        agentQaRoot,
        configPath: join(agentQaRoot, 'agent-qa.config.yaml'),
        knowledgeConfig: { dir: 'knowledge' },
        configDir: agentQaRoot,
        log: {
          warn: (message: string) => warn(message),
          info: (message: string) => info(message),
        },
        operations: {
          resolveKnowledgeRoot: () => knowledgeRoot,
          runCurationTail: async () => undefined,
          now: () => clock.value,
          composeHost: () => {
            const host = composeLocalAgent({
              mask: (text) => text,
              mintQuarantineIdentityPath: MINT_IDENTITY,
              agentQaRoot,
              config: TEST_CONFIG,
              knowledgeRoot: () => knowledgeRoot,
              model: () => TEST_MODEL,
              idSource: DIGEST_JOB_ID_SOURCE,
              postRun: {
                // Two curated, one deprecated: the candidates this run staged, which the digest
                // must report as COUNTS while they stay candidate-status truth in bundles.
                curateRun: async () => ({ curated: 2, deprecated: 1, complete: true }),
                candidateProse: 'masker-active',
              },
            })
            hosts.push(host)
            return host
          },
          // The SHIPPED read, counted. Wrapping rather than replacing is the point: what is
          // measured is how many times the real op is asked, not how many times a stub was.
          readRunDigest: async (host, id) => {
            digestReads.count += 1
            return defaults.readRunDigest(host, id)
          },
        },
      }
    },
  }
}

/**
 * The real operations table, captured once for its `readRunDigest`.
 *
 * Imported through the module's own default rather than re-implemented, so the counting wrapper
 * above delegates to exactly the invocation production performs — id, caller mint and all.
 */
function defaultOperationsCapture(): Pick<PostRunTailOperations, 'readRunDigest'> {
  return {
    readRunDigest: async (host, runId) => await invokeFunction(
      host.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as RunDigest,
  }
}

function storeConfig(f: Fixture): BundleStoreConfig {
  return {
    knowledgeRoot: f.knowledgeRoot,
    productKey: 'Batching Product',
  }
}

let ordinal = 40

/**
 * A COLD composition over the fixture's roots — nothing in memory carries between two of these.
 *
 * One helper rather than three copies, because the file now composes for three different reasons
 * (minting through the op, reading the notify rows, reading the digest) and three drifting
 * spellings of one composition is how two of them end up reading different roots.
 */
function composeCold(f: Fixture): LocalAgentHost {
  return composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot: f.agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => f.knowledgeRoot,
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
  })
}

// Queues this run's `analyze-run` row through the shipped step, as the product does.
async function stepEnqueue(f: Fixture, runId: string): Promise<void> {
  await enqueueThroughTheStep({
    runId,
    agentQaRoot: f.agentQaRoot,
    configPath: join(f.agentQaRoot, 'agent-qa.config.yaml'),
    composeHost: () => {
      const host = composeCold(f)
      hosts.push(host)
      return host
    },
  })
}

/** One real published record for a proposal below to be about. */
function publishRecord(f: Fixture, summary: string): string {
  ordinal += 1
  const published = publishBundleForTest(storeConfig(f), {
    draft: {
      kind: 'fact',
      subtype: 'selector',
      anchors: [ANCHOR],
      scope: { tier: 'product', key: 'batching' },
      summary,
      body: `Selecting ${summary} advances to the payment page.`,
      distilledEvidenceRef: { id: `batching-${summary}`, sha: 'a'.repeat(64) },
      originStage: 'run-curation',
    },
    discriminant: {
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'Button', name: summary },
    },
    originClass: 'agent-verified',
    createdAtOrdinal: ordinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: { mode: 'run-linked', runId: 'batching', testId: 't', stepIndex: 0 },
    artifacts: [],
  })
  if (published.kind !== 'published') throw new Error(`fixture publish failed: ${published.kind}`)
  return published.id
}

// One real record, then one older proposal about it, attributed to the run.
async function mint(f: Fixture, runId: string, summary: string): Promise<string> {
  const recordId = publishRecord(f, summary)
  return await fileLeftoverKnowledgeProposal({
    agentQaRoot: f.agentQaRoot,
    knowledgeRoot: f.knowledgeRoot,
    verb: 'forget',
    target: { grain: 'record', recordId },
    runId,
  })
}

/** Read the notify rows through a SECOND cold composition, so nothing in memory can agree. */
async function notificationsFor(f: Fixture, runId: string): Promise<readonly {
  runId: string
  payload: unknown
}[]> {
  const host = composeCold(f)
  try {
    const jobs = await host.jobs()
    const rows = await jobs.store.listNotifications()
    return rows.filter((row) => row.runId === runId)
  } finally {
    await host.close()
  }
}

/** The digest through a SECOND cold composition — the same non-circularity discipline. */
async function digestThroughTheOp(f: Fixture, runId: string): Promise<RunDigest> {
  const host = composeCold(f)
  try {
    return await invokeFunction(
      host.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as RunDigest
  } finally {
    await host.close()
  }
}

const DIGEST_BLOCK_PREFIX = 'digest — '

describe('one heartbeat, N proposals, ONE digest, ONE notify row', () => {
  it('renders exactly one digest for the run, and lists no proposal of any run', async () => {
    const f = fixture()
    // Three proposals mint into ONE store while one run's chain is about to drain: two belong
    // to this run, one to another. Forty events would have produced forty notifications under
    // a per-event design; here the count of renders is what is measured.
    const first = await mint(f, RUN_ID, 'checkout button')
    const second = await mint(f, RUN_ID, 'payment button')
    const foreign = await mint(f, OTHER_RUN, 'coupon field')

    const tail = runPostRunTail(f.options(RUN_ID))
    await stepEnqueue(f, RUN_ID)
    await tail.drain()
    await tail.finish()
    expect(tail.report().drain).toBe('drained')

    // (a) EXACTLY ONE RENDER. Two independent counts, because they can fail differently: the
    // tail asked the function layer once, and it printed one block.
    expect(f.digestReads.count).toBe(1)
    const printed = f.info.mock.calls
      .map(([message]) => String(message))
      .filter((line) => line.startsWith(DIGEST_BLOCK_PREFIX))
    expect(printed).toHaveLength(1)

    const block = printed[0] as string
    expect(block.startsWith(`${DIGEST_BLOCK_PREFIX}${RUN_ID}`)).toBe(true)
    // …and it names none of the three minted proposals: nothing is listed, counted or owed a
    // decision. This host binds no mark-ledger read, and the marks section says so.
    expect(block).toContain('marks — ledger not read here')
    for (const id of [first, second, foreign]) {
      expect(block).not.toContain(id.slice(0, 12))
      expect(block).not.toContain(id)
    }
    expect(block).not.toMatch(/proposal|pending overall/)

    // The other run's digest, from the same store, names none of them either.
    const otherDigest = await digestThroughTheOp(f, OTHER_RUN)
    expect(JSON.stringify(otherDigest)).not.toMatch(/prop_/)
    expect(otherDigest).not.toHaveProperty('pendingProposalCount')
  })

  it('leaves the durable notify row a single, unwidened, guard-passing record', async () => {
    const f = fixture()
    await mint(f, RUN_ID, 'checkout button')
    await mint(f, RUN_ID, 'payment button')
    await mint(f, OTHER_RUN, 'coupon field')

    const tail = runPostRunTail(f.options(RUN_ID))
    await stepEnqueue(f, RUN_ID)
    await tail.drain()
    await tail.finish()

    // (b) Pinned SEPARATELY from (a), against the durable store rather than against anything
    // the tail held: exactly one row, whatever the digest did.
    const rows = await notificationsFor(f, RUN_ID)
    expect(rows).toHaveLength(1)

    // `guardRunNotification` compares the sorted key set exactly, so a widened row throws here.
    const guarded = guardRunNotification(rows[0]?.payload)
    expect(guarded.runId).toBe(RUN_ID)
    expect(guarded.outcome).toBe('done')
    expect(Object.keys(guarded).sort())
      .toEqual(['outcome', 'runId', 'schemaVersion', 'stages', 'verdictSummary'])
    // Nothing about a proposal reached the row, by content as well as by key set.
    expect(JSON.stringify(guarded)).not.toContain('prop_')
  })

  it('reports candidates staged this run as COUNTS, never as proposals to decide',
    async () => {
      const f = fixture()
      await mint(f, RUN_ID, 'checkout button')

      const tail = runPostRunTail(f.options(RUN_ID))
      await stepEnqueue(f, RUN_ID)
      await tail.drain()
      await tail.finish()

      const digest = await digestThroughTheOp(f, RUN_ID)
      const rows = await notificationsFor(f, RUN_ID)
      const guarded = guardRunNotification(rows[0]?.payload)

      // (c) The counts are the ROW's counts, read from the durable record rather than from the
      // fold that produced them — one truth, two renderings, no third derivation.
      expect(digest.candidates).toEqual({
        curated: guarded.stages.curation.curated,
        deprecated: guarded.stages.curation.deprecated,
      })
      expect(digest.candidates).toEqual({ curated: 2, deprecated: 1 })
      expect(digest.lines.some((line) => line === 'candidates — 2 curated · 1 deprecated'))
        .toBe(true)

      // No proposal section remains, so the minted envelope is listed and counted nowhere.
      expect(digest).not.toHaveProperty('proposalsMintedThisRun')
      expect(digest).not.toHaveProperty('pendingProposalCount')
    })

  it('renders the zero arm as zeros, and its exit line carries no proposal count', async () => {
    const f = fixture()
    // The store is NOT empty: two proposals exist, both belonging to the OTHER run. That makes
    // this the zero-ATTRIBUTION arm rather than the zero-store arm, and the two fail
    // differently — a filter that returned everything would pass on an empty store.
    await mint(f, OTHER_RUN, 'checkout button')
    await mint(f, OTHER_RUN, 'payment button')

    // Handed off rather than drained, so no digest block, and the exit-line pointer instead.
    const tail = runPostRunTail({
      ...f.options(EMPTY_RUN),
      operations: {
        ...f.options(EMPTY_RUN).operations,
        acquireWriterLease: () => ({ kind: 'held', holder: { pid: 4242 } }),
        nudgeDaemon: async () => undefined,
      } as unknown as Partial<PostRunTailOperations>,
    })
    await stepEnqueue(f, EMPTY_RUN)
    await tail.drain()
    await tail.finish()
    expect(tail.report().drain).toBe('handed-off')

    const lines = f.info.mock.calls.map(([message]) => String(message))
    // No block on this arm — the either/or, measured.
    expect(lines.filter((line) => line.startsWith(DIGEST_BLOCK_PREFIX))).toHaveLength(0)
    const exitLine = lines.find((line) => line.startsWith('post-processing —'))
    expect(exitLine).toBeDefined()
    // No proposal is waiting on anyone, so the line carries only the exact command a person pastes.
    expect(exitLine).toContain(` · digest: ${digestFetchCommand(EMPTY_RUN)}`)
    expect(exitLine).not.toContain('proposals:')

    // …and the digest this run WOULD render is all zeros for its own sections, without error.
    const digest = await digestThroughTheOp(f, EMPTY_RUN)
    expect(digest).not.toHaveProperty('proposalsMintedThisRun')
    expect(digest.candidates).toEqual({ curated: 0, deprecated: 0 })
    expect(digest.quarantine).toEqual({ quarantined: 0, expired: 0, refs: [] })
    expect(digest.lines).toContain('marks — ledger not read here')
  })
})
