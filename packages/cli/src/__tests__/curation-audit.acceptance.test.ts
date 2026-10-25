import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enqueueCurationCandidateProjection,
  enumerateBundleDirs,
  loadBundle,
  type CurationCandidateProjection,
} from '@vostride/agent-qa-knowledge-local'
import {
  createModel,
  type ModelProfile,
  type ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCuratorAuthor,
  CURATION_TAIL_RECEIPT_FILE,
  CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
  runCurationTail,
  runVerdictFirstCurationTail,
  type RunCurationTailOptions,
} from '../index.js'

const noneAuth: ResolvedModelAuth = { kind: 'none' }

type CuratorModel = ReturnType<typeof createModel>
type CallOptions = Parameters<CuratorModel['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<CuratorModel['doGenerate']>>

function generated(text: string): GenerateResult {
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

function scriptedModel(onCall: (options: CallOptions) => void): CuratorModel {
  return {
    specificationVersion: 'v3',
    provider: 'curation-audit-scripted',
    modelId: 'curation-audit-scripted',
    supportedUrls: {},
    async doGenerate(options) {
      onCall(options)
      return generated(JSON.stringify({
        kind: 'Add',
        citedAliases: [],
        bundle: {
          kind: 'fact',
          subtype: 'selector',
          anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
          summary: 'Verified checkout submission control',
          body: 'The Place order button submits the completed checkout form.',
        },
      }))
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
}

function profile(): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: 'curation-audit-scripted',
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

function completeAuditHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: 'run-curation-audit' as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'suite-digest',
      testConfigDigest: 'test-digest',
    },
    startedAt: 100,
    endedAt: 200,
    tests: [{
      testId: 'checkout-happy-1',
      testName: 'checkout happy path',
      filePath: 'suite/checkout.test.ts',
      testIndex: 0,
      outcome: 'passed',
      steps: [{
        stepIndex: 0,
        stepText: 'Click checkout',
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'storefront' },
          asOfBuild: 42,
          budget: 128,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
          briefDigest: 'brief-digest',
        },
        subActions: [],
        verifierVerdict: { pass: true, reasoning: 'Observed checkout' },
      }],
    }],
  }
}

describe('tail-scoped Curator egress audit coverage (CUR-05)', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string
  let candidate: CurationCandidateProjection
  let finalizedCandidateId: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cli-curation-audit-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(
      join(agentQaRoot, RUNS_SUBDIR, slugBranch('run-curation-audit')),
      { recursive: true },
    )
    finalizedCandidateId = undefined
    candidate = {
      sourceRunId: 'run-curation-audit',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
      summarySeed: 'Use Bearer abcdefghijklmno12345 to describe the checkout control',
      bodySeed: 'The Place order button was resolved and verified.',
      distilledObservations: [],
      evidenceToken: 'evidence-curation-audit',
      attributingObservationId: 'run-curation-audit:test-0:step-0',
      artifactDescriptors: [],
      emittedAt: '2026-07-15T10:00:00.000Z',
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function tailOptions(
    modelCalls: ReturnType<typeof vi.fn<(options: CallOptions) => void>>,
  ): RunCurationTailOptions {
    const resolvedProfile = profile()
    return {
      runId: 'run-curation-audit',
      agentQaRoot,
      knowledgeConfig: { dir: knowledgeRoot },
      configDir: root,
      modelDeps: { profile: resolvedProfile, auth: noneAuth },
      log: { warn: vi.fn() },
      operations: {
        loadCompletedRunHandoff: () => completeAuditHandoff(),
        resolveKnowledgeRoot: () => knowledgeRoot,
        emitCurationCandidates: () => {
          const outcome = enqueueCurationCandidateProjection({
            knowledgeRoot,
            projection: candidate,
            artifactSources: [],
          })
          expect(outcome.kind).toBe('enqueued')
          if (outcome.kind !== 'enqueued') {
            throw new Error(`expected enqueued projection, received ${outcome.kind}`)
          }
          finalizedCandidateId = outcome.candidateId
          return {
            enqueued: 1,
            coalesced: 0,
            capExceeded: 0,
            refused: 0,
            details: [],
          }
        },
        emitCanaryOutcomes: async () => ({
          emitted: 0,
          refused: 0,
          unresolved: 0,
          canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
          procedure: { emitted: 0, refused: 0, unresolved: 0 },
          details: [],
        }),
        buildCuratorAuthor: (deps) => buildCuratorAuthor({
          ...deps,
          createModelImpl: (seenProfile, auth, mask) => createModel(seenProfile, auth, mask, {
            languageModels: {
              [seenProfile.model]: scriptedModel(modelCalls),
            },
          }),
        }),
      },
    }
  }

  it('curates through the tail\'s createModel call once and writes its receipt', async () => {
    const modelCalls = vi.fn<(options: CallOptions) => void>()

    await runCurationTail(tailOptions(modelCalls))

    expect(modelCalls).toHaveBeenCalledOnce()
    const bundles = enumerateBundleDirs(knowledgeRoot)
    expect(bundles).toHaveLength(1)
    const loaded = loadBundle(bundles[0]!.dir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected one curated audit bundle')
    expect(loaded.bundle.events).toContainEqual(
      expect.objectContaining({ curationJobId: finalizedCandidateId }),
    )
    const receipt = JSON.parse(readFileSync(join(
      agentQaRoot,
      RUNS_SUBDIR,
      slugBranch('run-curation-audit'),
      CURATION_TAIL_RECEIPT_FILE,
    ), 'utf8')) as Record<string, unknown>
    expect(receipt).toMatchObject({
      schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
      runId: 'run-curation-audit',
      handoffDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      drainKind: 'drained',
      handoffHolderPid: null,
      candidateIds: [],
    })

    await runCurationTail(tailOptions(modelCalls))
    expect(modelCalls).toHaveBeenCalledOnce()
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(1)
  })

  it('records no curation egress when --detach skips the tail', async () => {
    const modelCalls = vi.fn<(options: CallOptions) => void>()
    const runTail = vi.fn(() => runCurationTail(tailOptions(modelCalls)))

    await expect(
      runVerdictFirstCurationTail({ exitCode: 0, detach: true, runTail }),
    ).resolves.toBe(0)

    expect(runTail).not.toHaveBeenCalled()
    expect(modelCalls).not.toHaveBeenCalled()
    expect(existsSync(join(agentQaRoot, ['guardrail', 'audit.jsonl'].join('_')))).toBe(false)
  })
})
