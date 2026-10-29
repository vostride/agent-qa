// Run through the shipped `validateAnalysisAgainstHandoff`: a rejected answer looks armless.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  validateAnalysisAgainstHandoff,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  RunAnalysisArtifact,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ANALYSIS_PROMPT_MARKER,
  POPULATED_ANALYSIS_DISCRIMINATOR,
  POPULATED_ANALYSIS_NEXT_ACTION,
  POPULATED_ANALYSIS_RATIONALE,
  POPULATED_FAILURE_QUOTE,
  POPULATED_FAILURE_STEP_TEXT,
  startStubModelServer,
} from './populated-run-fixture.js'
import type { StubModelServer } from './populated-run-fixture.js'

/**
 * The author's request as the provider actually sends it: no `tools`, no `response_format`, and
 * the `agent_context` line in the SYSTEM message.
 *
 * `buildTieredPrompt` renders `agent_context` as `Agent context: <line>` into `system`
 * (`agent/src/prompt/tiered-prompt-builder.ts`), and `authorRunAnalysis` passes
 * `analyze-run: authoring root-cause verdicts and sentence parts for one completed run` — measured
 * against the real prompt this session. The stub collects text from every message, system
 * included, which is why matching on the line works at all; sending it anywhere else here would
 * make the cell agree with itself rather than with the product.
 */
const AUTHOR_SYSTEM =
  `Agent context: ${ANALYSIS_PROMPT_MARKER} and sentence parts for one completed run`

const AUTHOR_USER_TEXT = `## Run facts\n\nTest 0: ${POPULATED_FAILURE_STEP_TEXT}`

interface AuthoredEntry {
  readonly testIndex: number
  readonly class: string
  readonly confidence: number
  readonly memoryMisdirectionRuledOut: boolean
  readonly citedSteps: number[]
  readonly citedArtifacts: { id: string; sha: string }[]
  readonly rationale: string
  readonly groundingQuote: { stepIndex: number; quote: string }
  readonly discriminator: string
  readonly nextAction: string
  readonly links: string[]
}

const started: StubModelServer[] = []
const roots: string[] = []

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close()
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

async function stub(
  options: Parameters<typeof startStubModelServer>[0] = {},
): Promise<StubModelServer> {
  const server = await startStubModelServer(options)
  started.push(server)
  return server
}

function authorBody(system: string, userText: string): string {
  return JSON.stringify({
    model: 'stub',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: userText }] },
    ],
  })
}

async function post(server: StubModelServer, body: string): Promise<Response> {
  return await fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

async function ask(
  server: StubModelServer,
  system = AUTHOR_SYSTEM,
  userText = AUTHOR_USER_TEXT,
): Promise<string> {
  const payload = (await (await post(server, authorBody(system, userText))).json()) as {
    choices: { message: { content: string } }[]
  }
  return payload.choices[0]?.message.content ?? ''
}

function authoredEntry(answer: string): AuthoredEntry {
  return (JSON.parse(answer) as { tests: AuthoredEntry[] }).tests[0] as AuthoredEntry
}

/** A project root with one run directory holding one decision-screenshot blob. */
function rootWithBlob(sha: string): string {
  const root = mkdtempSync(join(tmpdir(), 'aq-406-07-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(join(agentQaRoot, 'runs', 'r-406-07', 'blobs'), { recursive: true })
  writeFileSync(join(agentQaRoot, 'runs', 'r-406-07', 'blobs', sha), 'png-bytes', 'utf8')
  const handoff = handoffCarryingTheFixtureStepText()
  const subAction = handoff.tests[0]?.steps[0]?.subActions[0]
  if (subAction !== undefined) {
    subAction.decisionScreenshotRef = { id: `decision-screenshot:${sha}`, sha }
  }
  writeFileSync(join(agentQaRoot, 'runs', 'r-406-07', 'handoff.json'), JSON.stringify(handoff))
  return agentQaRoot
}

/**
 * The minimal v6 handoff the arm's answer must validate against: one failed member, one captured
 * step, and the fixture's own `stepText` as the quote source.
 */
function handoffCarryingTheFixtureStepText(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: 'r_406_07_analysis_arm',
    scope: { tier: 'product', key: 'populated' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 'TST-406-07',
        testName: 'the notice acknowledges',
        filePath: 'tests/notice.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [
          {
            stepIndex: 0,
            stepText: POPULATED_FAILURE_STEP_TEXT,
            cacheStatus: 'miss',
            servedBrief: {
              scope: { tier: 'product', key: 'populated' },
              asOfBuild: 1,
              budget: 0,
              truncation: 'none',
              channel1: [],
              channel2: [],
              channel3: [],
              briefDigest: 'populated-brief-digest',
            },
            subActions: [
              {
                plan: 'click the acknowledge control',
                plannedAction: { type: 'click', ref: 'e1' },
                result: { success: false, error: 'Planner signaled step failure' },
              },
            ],
            verifierVerdict: { pass: false, reasoning: 'the notice never acknowledged' },
          },
        ],
      },
    ],
  } as unknown as CompletedRunHandoff
}

/** The arm's wire answer, shaped into the artifact the author's merge law would persist. */
function artifactFrom(entry: AuthoredEntry, runId: string): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [
      {
        class: entry.class,
        producer: 'analyze-run',
        confidence: entry.confidence,
        evidence: {
          citedSteps: [...entry.citedSteps],
          citedAnchors: [],
          citedArtifacts: entry.citedArtifacts.map((ref) => ({ id: ref.id, sha: ref.sha })),
          rationale: entry.rationale,
        },
        memoryMisdirectionRuledOut: entry.memoryMisdirectionRuledOut,
        perTest: entry.testIndex,
      },
    ],
    parts: [
      {
        perTest: entry.testIndex,
        groundingQuote: entry.groundingQuote,
        discriminator: entry.discriminator,
        nextAction: entry.nextAction,
        links: [...entry.links],
      },
    ],
  } as unknown as RunAnalysisArtifact
}

describe("the stub's analysisOutcome knob is additive", () => {
  it('answers the author with prose by default, recorded as a text request', async () => {
    const server = await stub()

    const answer = await ask(server)

    expect(() => JSON.parse(answer)).toThrow()
    expect(server.requests.map((request) => request.kind)).toEqual(['text'])
  })

  it("answers the same way when the caller asks for 'floor' explicitly", async () => {
    const server = await stub({ analysisOutcome: 'floor' })

    await ask(server)

    expect(server.requests.map((request) => request.kind)).toEqual(['text'])
  })

  it('leaves every other plain-text call on the prose fallback even when authored', async () => {
    const server = await stub({ analysisOutcome: 'authored' })

    await ask(server, 'Agent context: curate-memory', 'summarise this run for a human')

    expect(server.requests.map((request) => request.kind)).toEqual(['text'])
  })
})

describe("the 'authored' arm answers the author with a valid OUTPUT_CONTRACT object", () => {
  it('recognises the author by its agent_context line and records an analysis request', async () => {
    const server = await stub({ analysisOutcome: 'authored' })

    const entry = authoredEntry(await ask(server))

    expect(server.requests.map((request) => request.kind)).toEqual(['analysis'])
    expect(server.requests[0]?.status).toBe(200)
    expect(entry.testIndex).toBe(0)
    expect(entry.class).toBe('app_bug')
    expect(entry.confidence).toBe(0.86)
    expect(entry.memoryMisdirectionRuledOut).toBe(true)
    expect(entry.citedSteps).toEqual([0])
    expect(entry.groundingQuote).toEqual({ stepIndex: 0, quote: POPULATED_FAILURE_QUOTE })
    expect(entry.rationale).toBe(POPULATED_ANALYSIS_RATIONALE)
    expect(entry.discriminator).toBe(POPULATED_ANALYSIS_DISCRIMINATOR)
    expect(entry.nextAction).toBe(POPULATED_ANALYSIS_NEXT_ACTION)
    expect(entry.links).toEqual([])
  })

  it('reports a non-zero usage triple, like every other arm', async () => {
    const server = await stub({ analysisOutcome: 'authored' })

    const response = await post(server, authorBody(AUTHOR_SYSTEM, AUTHOR_USER_TEXT))
    const payload = (await response.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }

    expect(payload.usage.prompt_tokens).toBeGreaterThan(0)
    expect(payload.usage.completion_tokens).toBeGreaterThan(0)
    expect(payload.usage.total_tokens).toBe(
      payload.usage.prompt_tokens + payload.usage.completion_tokens,
    )
  })
})

describe('citeEvidenceFrom lifts the run its own decision-screenshot sha', () => {
  it('cites the recorded decision screenshot whose blob the run wrote', async () => {
    const sha = 'b'.repeat(64)
    const server = await stub({ analysisOutcome: 'authored' })
    server.citeEvidenceFrom(rootWithBlob(sha))

    const entry = authoredEntry(await ask(server))

    expect(entry.citedArtifacts).toEqual([{ id: `decision-screenshot:${sha}`, sha }])
  })

  it('excludes network JSON and unreferenced blobs', async () => {
    const sha = 'b'.repeat(64)
    const root = rootWithBlob(sha)
    const blobs = join(root, 'runs', 'r-406-07', 'blobs')
    writeFileSync(join(blobs, 'a'.repeat(64)), JSON.stringify({
      schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      kind: 'network',
      records: [],
    }))
    writeFileSync(join(blobs, 'c'.repeat(64)), 'unreferenced-png-bytes')
    const server = await stub({ analysisOutcome: 'authored' })
    server.citeEvidenceFrom(root)

    expect(authoredEntry(await ask(server)).citedArtifacts).toEqual([
      { id: `decision-screenshot:${sha}`, sha },
    ])
  })

  it('does not substitute another blob for a missing screenshot', async () => {
    const sha = 'b'.repeat(64)
    const root = rootWithBlob(sha)
    const blobs = join(root, 'runs', 'r-406-07', 'blobs')
    rmSync(join(blobs, sha))
    writeFileSync(join(blobs, 'a'.repeat(64)), JSON.stringify({
      schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      kind: 'network',
      records: [],
    }))
    const server = await stub({ analysisOutcome: 'authored' })
    server.citeEvidenceFrom(root)

    expect(authoredEntry(await ask(server)).citedArtifacts).toEqual([])
  })

  it('cites nothing when no root was registered, and nothing when the root has no blobs', async () => {
    const unregistered = await stub({ analysisOutcome: 'authored' })
    expect(authoredEntry(await ask(unregistered)).citedArtifacts).toEqual([])

    const empty = await stub({ analysisOutcome: 'authored' })
    const root = mkdtempSync(join(tmpdir(), 'aq-406-07-empty-'))
    roots.push(root)
    empty.citeEvidenceFrom(join(root, '.agent-qa'))

    expect(authoredEntry(await ask(empty)).citedArtifacts).toEqual([])
  })
})

describe("the arm's answer survives the author's own cross-document validation", () => {
  it('is a verbatim contiguous substring of the fixture step text', () => {
    expect(POPULATED_FAILURE_STEP_TEXT).toContain(POPULATED_FAILURE_QUOTE)
  })

  it('validates for testIndex 0 with zero rejects', async () => {
    const server = await stub({ analysisOutcome: 'authored' })
    server.citeEvidenceFrom(rootWithBlob('c'.repeat(64)))
    const handoff = handoffCarryingTheFixtureStepText()

    const entry = authoredEntry(await ask(server))
    const result = validateAnalysisAgainstHandoff(
      artifactFrom(entry, String(handoff.runId)),
      handoff,
    )

    expect(result).toEqual({ ok: true })
  })
})
