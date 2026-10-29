import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  drainQueue,
  queuedCandidateDir,
  type DrainReport,
} from '@vostride/agent-qa-knowledge-local'
import { createModel, type ModelProfile, type ResolvedModelAuth } from '@vostride/agent-qa-model'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
} from '@vostride/agent-qa-runner-local'
import { parseProcedureBody } from '@vostride/agent-qa-schema'
import { afterAll, describe, expect, it } from 'vitest'

import {
  CURATION_TAIL_RECEIPT_FILE,
  CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
  runCurationTail,
} from '../curation-tail.js'
import { emptyCanaryCreditCounters } from '../canary-credit.js'
import { buildCuratorAuthor, CURATOR_RETRY_CAP } from '../curator-author.js'
import {
  emitCurationCandidates,
  parseProcedureTrajectorySeed,
  projectCurationCandidates,
} from '../emit-candidates.js'
import { removeTempRoots } from '../../__tests__/temp-roots.js'

// Consumes a recorded run's verbatim artifacts; each row pins one stage of the procedure candidate.

const RUN_ID = 'r_corner-river-elle-deep-prompt-reduce-masked-ilia-bob-cone'
const SCOPE_KEY = 'local-form'
/** sha-256 of the fixture's bytes. */
const LIVE_HANDOFF_SHA256 =
  'ee23ab56aac6354bfe528ae34d3d072a5a43f2ac324392639ce3db630e9af2ab'

const TAIL_TIMEOUT_MS = 180_000

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'f-381-48-1-run',
)

// The recorded `<EMAIL_0>` is literal and `PROBE_USER` undeclared, so this mask declares nothing.
function liveMask(): (text: string) => string {
  const redactor = new SecretRedactor(SecretStore.empty())
  return (text) => redactor.redactString(text)
}

interface StagedRoots {
  configDir: string
  agentQaRoot: string
  runDir: string
  knowledgeRoot: string
  knowledgeConfig: { dir: string }
}

const stagedConfigDirs: string[] = []
afterAll(() => { removeTempRoots(stagedConfigDirs.splice(0)) })

/** One fixture run dir inside a fresh temp runs-root, plus a fresh cold knowledge root. */
function stageRoots(): StagedRoots {
  const configDir = mkdtempSync(join(tmpdir(), 'f-381-48-1-'))
  stagedConfigDirs.push(configDir)
  const agentQaRoot = join(configDir, '.agent-qa')
  const runDir = join(agentQaRoot, RUNS_SUBDIR, RUN_ID)
  mkdirSync(dirname(runDir), { recursive: true })
  cpSync(fixtureDir, runDir, { recursive: true })
  const knowledgeRoot = join(configDir, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  return {
    configDir,
    agentQaRoot,
    runDir,
    knowledgeRoot,
    knowledgeConfig: { dir: 'agent-qa-knowledge' },
  }
}

function warnCapture(): { warns: string[]; log: { warn(message: string): void } } {
  const warns: string[] = []
  return { warns, log: { warn: (message: string) => warns.push(message) } }
}

function bundleIds(knowledgeRoot: string): string[] {
  const bundlesDir = join(knowledgeRoot, 'memory', SCOPE_KEY, 'bundles')
  if (!existsSync(bundlesDir)) return []
  return readdirSync(bundlesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

function procedureBundleIds(knowledgeRoot: string): string[] {
  return bundleIds(knowledgeRoot).filter((id) => id.startsWith('procedure-'))
}

function factBundleIds(knowledgeRoot: string): string[] {
  return bundleIds(knowledgeRoot).filter((id) => id.startsWith('fact-'))
}

type CuratorModel = ReturnType<typeof createModel>
type GenerateResult = Awaited<ReturnType<CuratorModel['doGenerate']>>

const scriptedAuth: ResolvedModelAuth = { kind: 'none' }

function scriptedProfile(): ModelProfile {
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
  } as unknown as CuratorModel
}

// The builder pins the flow anchor and parameter, so invented pieces cannot mask a naming defect.
const sentinelShapedProposal = JSON.stringify({
  candidates: [
    {
      flowName: 'form::submit-username',
      stepSpan: [0, 2],
      parameters: [
        {
          name: 'username',
          type: 'string',
          required: true,
          appliesTo: [{ stepOrdinal: 0, field: 'text' }],
        },
      ],
      successAssertion: 'The form accepts the username and shows Received!',
    },
  ],
})

describe('the live-artifact staged reproduction', () => {
  it('fixture faithfulness: handoff bytes are the live run bytes and no receipt rode along', () => {
    const digest = createHash('sha256')
      .update(readFileSync(join(fixtureDir, HANDOFF_FILE)))
      .digest('hex')
    expect(digest).toBe(LIVE_HANDOFF_SHA256)
    // A matching receipt makes the tail sweep skip the run (curation-tail.ts
    // receiptMatches) and every row would pass vacuously.
    expect(existsSync(join(fixtureDir, CURATION_TAIL_RECEIPT_FILE))).toBe(false)
  })

  it('stage P: the real handoff projects exactly one procedure candidate whose old placeholder reads as literal text', () => {
    const handoff = loadCompletedRunHandoff(join(fixtureDir, HANDOFF_FILE))
    const projections = projectCurationCandidates(handoff)
    const procedures = projections.filter((candidate) => candidate.kind === 'procedure')
    expect(procedures).toHaveLength(1)

    const seed = parseProcedureTrajectorySeed(procedures[0]!.bodySeed)
    expect(seed).toBeDefined()
    expect(seed!.steps).toHaveLength(3)
    // The recorded placeholder is old data and reads as literal text.
    expect(seed!.steps[0]!.action?.values['text']).toEqual({
      observed: '<EMAIL_0>',
      source: 'literal',
    })
  })

  it('stage E: the procedure candidate enqueues (never silently coalesces) on a cold knowledge root', () => {
    const roots = stageRoots()
    const handoff = loadCompletedRunHandoff(join(roots.runDir, HANDOFF_FILE))
    const projections = projectCurationCandidates(handoff)
    const procedureIndex = projections.findIndex(
      (candidate) => candidate.kind === 'procedure',
    )
    expect(procedureIndex).toBeGreaterThanOrEqual(0)

    const report = emitCurationCandidates({
      handoff,
      runDir: roots.runDir,
      knowledgeRoot: roots.knowledgeRoot,
    })
    // Emit outcomes arrive in projection order; the detail at the procedure's index IS
    // the procedure candidate's outcome. 'coalesced' on this COLD root would itself be
    // the proven site — the failure diff then names the candidateId it claims to
    // coalesce with.
    const detail = report.details[procedureIndex]!
    expect(detail.outcome).toMatchObject({ kind: 'enqueued' })
    expect(detail.candidateId).toBeDefined()
    expect(
      existsSync(queuedCandidateDir(roots.knowledgeRoot, detail.candidateId!)),
    ).toBe(true)
  })

  it(
    'stage D-nomodel (site discriminator): with no model anywhere the drain records exactly one visible procedure-job noop (delta-noop: fallback-no-model)',
    async () => {
      const roots = stageRoots()
      const { warns, log } = warnCapture()
      // REAL defaultOperations: no operations override at all. Mask and audit
      // sink mirror run-session-composition.ts.
      await runCurationTail({
        runId: RUN_ID,
        agentQaRoot: roots.agentQaRoot,
        knowledgeConfig: roots.knowledgeConfig,
        configDir: roots.configDir,
        mask: liveMask(),
        log,
      })

      // The live silent signature's healthy half must hold: curation completed, receipt
      // written, both fact bundles committed.
      expect(warns.filter((line) => line.includes('incomplete'))).toEqual([])
      expect(existsSync(join(roots.runDir, CURATION_TAIL_RECEIPT_FILE))).toBe(true)
      expect(JSON.parse(readFileSync(join(roots.runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8'))).toMatchObject({
        schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION, canary: emptyCanaryCreditCounters(),
      })
      expect(factBundleIds(roots.knowledgeRoot)).toHaveLength(2)
      expect(procedureBundleIds(roots.knowledgeRoot)).toHaveLength(0)

      // With no model, a drained candidate leaves one noop line, so zero means it died upstream.
      const noopLines = warns.filter((line) => line.includes('commit noop'))
      expect(noopLines).toHaveLength(1)
      expect(noopLines[0]).toContain('produced 1 commit noop(s)')
      expect(noopLines[0]).toContain('(delta-noop: fallback-no-model)')
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    "stage D-scripted (desired end-to-end): the email-arm artifacts commit a procedure bundle with the proposal's parameter and every drain outcome is visible",
    async () => {
      const roots = stageRoots()
      const { warns, log } = warnCapture()
      const reports: DrainReport[] = []
      await runCurationTail({
        runId: RUN_ID,
        agentQaRoot: roots.agentQaRoot,
        knowledgeConfig: roots.knowledgeConfig,
        configDir: roots.configDir,
        mask: liveMask(),
        modelDeps: { profile: scriptedProfile(), auth: scriptedAuth },
        log,
        operations: {
          // The ONLY seams touched: the PROCEDURE author's model is scripted with the
          // live sentinel-arm proposal shape (curator-author-procedure idiom) while fact
          // jobs keep the deterministic no-model fallback (stage D-nomodel proved that
          // path commits both facts), and the real drain is wrapped read-only so the
          // report's outcome counts are observable.
          buildCuratorAuthor: (deps) => {
            const scripted = buildCuratorAuthor({
              ...deps,
              createModelImpl: () =>
                scriptedModel(
                  Array.from(
                    { length: CURATOR_RETRY_CAP + 1 },
                    () => sentinelShapedProposal,
                  ),
                ),
            })
            return async (job, neighbors) =>
              job.kind === 'procedure'
                ? scripted(job, neighbors)
                : { kind: 'fallback-required', reason: 'no-model' }
          },
          drainQueue: async (opts) => {
            const report = await drainQueue(opts)
            reports.push(report)
            return report
          },
        },
      })

      expect(warns.filter((line) => line.includes('incomplete'))).toEqual([])
      expect(factBundleIds(roots.knowledgeRoot)).toHaveLength(2)

      // Rung A's truth at unit level, plus the never-zero-trace law: three jobs
      // (2 facts + 1 procedure) all commit; nothing is withheld, nooped, failed, or
      // requeued invisibly. On the shipped build this row is RED and its diff NAMES the
      // silent outcome the live tail never surfaced.
      const drained = reports.at(-1)
      expect(drained).toBeDefined()
      expect({
        procedureBundles: procedureBundleIds(roots.knowledgeRoot).length,
        drain: {
          jobsProcessed: drained!.jobsProcessed,
          committed: drained!.committed,
          withheld: drained!.withheld,
          noops: drained!.noops,
          noopDetails: drained!.noopDetails,
          failures: drained!.failures,
          failureDetails: drained!.failureDetails,
          requeued: drained!.requeued,
        },
      }).toEqual({
        procedureBundles: 1,
        drain: {
          jobsProcessed: 3,
          committed: 3,
          withheld: 0,
          noops: 0,
          noopDetails: [],
          failures: 0,
          failureDetails: [],
          requeued: 0,
        },
      })

      // The literal slot is covered by the proposal's own parameter, not a placeholder's name.
      const procedureId = procedureBundleIds(roots.knowledgeRoot)[0]!
      const recordMd = readFileSync(
        join(roots.knowledgeRoot, 'memory', SCOPE_KEY, 'bundles', procedureId, 'record.md'),
        'utf8',
      )
      const body = parseProcedureBody(recordMd)
      expect(body).toBeDefined()
      expect(body!.parameters).toEqual([
        { name: 'username', type: 'string', required: true },
      ])
      const fillStep = body!.steps.find((step) => step.action.type === 'fill')
      expect(fillStep).toBeDefined()
      expect(fillStep!.action.values['text']).toEqual({ param: 'username' })
    },
    TAIL_TIMEOUT_MS,
  )
})
