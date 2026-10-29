// Fixture builders for the Phase 368 requirement-proof suites.
//
// Every builder produces a production-shaped CompletedRunHandoff whose live decision extracts into a
// leaf cassette through the REAL extract path (extractRunCassettes → FsCassetteStore → loadCassetteBundle),
// so the proofs drive the ONE sanctioned helper (runCassetteReplay) over on-disk bundles — never a
// hand-rolled cassette. The knobs cover the modality/platform/masking axes the two suites need:
//
//   - vision:   captureMode 'full' + a decisionScreenshotRef whose blob round-trips to disk (the
//               vision leg); vision:false emits captureMode 'textOnly' with NO screenshot ref (the
//               text-only leg — prompts.ts then emits zero image content parts).
//   - platform: 'web' grounds a web_click; 'android' grounds a mobile_tap and drives the android
//               action-tool slice at the provider boundary (RPLY-04 mobile-with-no-device).
//   - stepText: seeds a distinctive sentinel into the recorded observation (RPLY-02 masking/guardrail).
//   - exchanges: recorded non-action exchanges served through the real plan() tool-loop.
//
// The stub + profile + artifacts helpers live here too so both proof suites import the ONE fixture
// module (no test-file cross-imports).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { extractRunCassettes } from '@vostride/agent-qa-eval'
import type { ArtifactSource, Cassette } from '@vostride/agent-qa-eval'
import { createModel } from '@vostride/agent-qa-model'
import type { ModelProfile, ResolvedModelAuth } from '@vostride/agent-qa-model'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  computeBriefDigest,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  ScreenState,
  ServedBrief,
  StepEvidence,
} from '@vostride/agent-qa-schema'

import { FsCassetteStore } from '../../cassette-store.js'
import { loadCassetteBundle } from '../../cassette-loader.js'

// ─── Shared literals ──────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run / eval-local replay proofs'
const TEST_ID = 'eval-local::replay-proofs'

// The vision leg's blob: reused across the suites so byte-exact reproduction has a known sha.
export const REPLAY_FIXTURE_BLOB_SHA =
  'd9113d37fe29084657c462ac5628ddd56519aeafad8883092a2596075878cbee'
export const REPLAY_FIXTURE_BLOB_BYTES = Uint8Array.from([
  97, 103, 101, 110, 116, 45, 113, 97, 32, 101, 118, 97, 108, 45, 108, 111, 99, 97, 108,
  32, 102, 105, 120, 116, 117, 114, 101, 32, 98, 108, 111, 98, 10,
])

const scope = { tier: 'suite', key: 'eval-local' } as const
const buttonRef = asRef('e-continue')

const SCREENSHOT_REF: ArtifactRef = {
  id: 'replay-fixture-screenshot',
  sha: REPLAY_FIXTURE_BLOB_SHA,
}

export type FixturePlatform = 'web' | 'android'

export interface ReplayHandoffOptions {
  /** 'web' grounds a web_click; 'android' grounds a mobile_tap with the android tool slice. */
  platform?: FixturePlatform
  /** true → captureMode 'full' + a decision screenshot ref (vision leg); false → 'textOnly'. */
  vision?: boolean
  /** Override the recorded live-step observation text (sentinel seeding for the masking proof). */
  stepText?: string
  /** Recorded non-action exchanges served through the real plan() tool-loop. */
  exchanges?: { tool: string; args: Record<string, unknown>; result: unknown }[]
}

// ─── Builders ─────────────────────────────────────────────────────────────────────────────────

function emptyBrief(): ServedBrief {
  const unstamped: ServedBrief = {
    scope,
    asOfBuild: 11,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...unstamped, briefDigest: computeBriefDigest(unstamped) }
}

function screenState(platform: FixturePlatform, vision: boolean, timestamp: number): ScreenState {
  const bounds = { x: 24, y: 32, width: 160, height: 44 }
  const center = { x: 104, y: 54 }
  const base = {
    coordSpace: 'viewport' as const,
    viewportWidth: 1_280,
    viewportHeight: 720,
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 720 },
  }
  const metadata: ScreenState['metadata'] = vision
    ? { captureMode: 'full', imageWidth: 1_280, imageHeight: 720, ...base }
    : { captureMode: 'textOnly', ...base }
  return {
    platform,
    tree: 'button Continue',
    elements: [
      {
        ref: buttonRef,
        role: 'button',
        name: 'Continue',
        nameNormalized: 'continue',
        bounds,
        center,
        state: { enabled: true, focused: false, visible: true, clickable: true },
        labels: { ariaLabel: 'Continue' },
        attributes: { 'data-fixture': 'continue' },
      },
    ],
    refMap: {
      [buttonRef]: {
        bounds,
        center,
        scrollContext: { offsetX: 0, offsetY: 0 },
      },
    } as ScreenState['refMap'],
    url: 'https://example.test/checkout',
    timestamp,
    metadata,
  }
}

function liveStep(opts: Required<Pick<ReplayHandoffOptions, 'platform' | 'vision'>> & {
  stepText: string
  exchanges: { tool: string; args: Record<string, unknown>; result: unknown }[]
}): StepEvidence {
  const actionType = opts.platform === 'android' ? 'tap' : 'click'
  return {
    stepIndex: 0,
    stepText: opts.stepText,
    cacheStatus: 'miss',
    servedBrief: emptyBrief(),
    modelProfile: {
      provider: 'openai-compatible',
      modelId: 'eval-local-fixture-planner',
      vision: opts.vision,
      maxOutputTokens: 512,
      sampling: { temperature: 0 },
    },
    toolSchemaDigest: 'c'.repeat(64),
    subActions: [
      {
        plan: 'Use the recorded Continue button',
        plannedAction: { type: actionType, ref: buttonRef },
        stateBefore: screenState(opts.platform, opts.vision, 1_725_000_000_100),
        result: {
          success: true,
          annotation: {
            kind: 'point',
            viewport: { width: 1_280, height: 720 },
            point: { x: 104, y: 54, boundingBox: { x: 24, y: 32, width: 160, height: 44 } },
          },
        },
        exchanges: opts.exchanges,
        ...(opts.vision ? { decisionScreenshotRef: SCREENSHOT_REF } : {}),
        callRecord: {
          resolvedModelId: 'eval-local-fixture-planner-2026-07-10',
          fingerprint: 'fp_eval_local_fixture',
          effectiveMaxOutputTokens: 512,
          effectiveSampling: { temperature: 0 },
        },
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'The recorded state advanced' },
    verifierIdentity: { provider: 'openai-compatible', modelId: 'eval-local-fixture-verifier' },
  }
}

/**
 * A production-shaped handoff whose single live decision projects into a leaf cassette. The knobs
 * span the modality/platform/masking axes the two proof suites drive through runCassetteReplay.
 */
export function makeReplayHandoff(options: ReplayHandoffOptions = {}): CompletedRunHandoff {
  const platform = options.platform ?? 'web'
  const vision = options.vision ?? true
  const stepText = options.stepText ?? 'Click Continue'
  const exchanges = options.exchanges ?? []
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(RUN_ID),
    scope,
    buildOrdinal: 11,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'd'.repeat(64),
      testConfigDigest: 'e'.repeat(64),
    },
    startedAt: 1_725_000_000_000,
    endedAt: 1_725_000_001_000,
    tests: [
      {
        testId: TEST_ID,
        testName: 'Replay fixture test',
        filePath: 'tests/replay-fixture.test.ts',
        testIndex: 0,
        outcome: 'passed',
        steps: [liveStep({ platform, vision, stepText, exchanges })],
      },
    ],
  }
}

// ─── Artifact sources ─────────────────────────────────────────────────────────────────────────

/** Serves the vision-leg blob in memory (the extraction blob source). */
export function memArtifacts(): ArtifactSource {
  return {
    getBlob: (sha) => (sha === REPLAY_FIXTURE_BLOB_SHA ? REPLAY_FIXTURE_BLOB_BYTES : undefined),
  }
}

/** Serves no blobs — turns a full-capture (vision) leaf into an evidence-incomplete cassette. */
export const emptyArtifacts: ArtifactSource = { getBlob: () => undefined }

// ─── Extraction helpers ───────────────────────────────────────────────────────────────────────

/** Extract the leaf cassette in memory (fast path for boundary/modality assertions). */
export function extractLeaf(
  handoff: CompletedRunHandoff,
  artifacts: ArtifactSource = memArtifacts(),
): { cassette: Cassette; artifacts: ArtifactSource } {
  const { cassettes } = extractRunCassettes({ handoff, artifacts })
  const leaf = cassettes.find((entry) => entry.cassette.granularity === 'leaf')
  if (leaf === undefined) throw new Error('expected a leaf cassette from the replay fixture')
  return { cassette: leaf.cassette, artifacts }
}

export interface LoadedBundle {
  cassette: Cassette
  artifacts: ArtifactSource
  /** The on-disk bundle directory (blobs/<sha> live under here). */
  dir: string
}

/**
 * The full production extract → FsCassetteStore.write → loadCassetteBundle round trip into a temp
 * dir. The proofs drive runCassetteReplay over the reloaded bundle — the sanctioned helper under
 * test end-to-end, blobs served from disk.
 */
export function extractStoreLoad(
  handoff: CompletedRunHandoff,
  artifacts: ArtifactSource,
  bundleRoot: string,
): LoadedBundle {
  const { cassettes } = extractRunCassettes({ handoff, artifacts })
  const extracted = cassettes.find((entry) => entry.cassette.granularity === 'leaf')
  if (extracted === undefined) throw new Error('expected a leaf cassette from the replay fixture')
  const written = new FsCassetteStore({ root: bundleRoot }).write(extracted)
  const load = loadCassetteBundle(written.dir)
  if (load.kind !== 'loaded') {
    throw new Error(`expected a loaded bundle, got a refusal: ${JSON.stringify(load)}`)
  }
  return { cassette: load.cassette, artifacts: load.artifacts, dir: written.dir }
}

/** Read the on-disk blob bytes for byte-exact vision-leg comparison. */
export function readBundleBlob(dir: string, sha: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, 'blobs', sha)))
}

// ─── Capturing provider-boundary stub ───────────────────────────────────────────────────────────

type StubLanguageModel = ReturnType<typeof createModel>
export type CapturedCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
export type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

export const STUB_MODEL_ID = 'replay-proof-stub'
export const noneAuth: ResolvedModelAuth = { kind: 'none' }

/**
 * The caller model profile — an unreachable baseURL by default, so the OFFLINE proof holds: the
 * injected stub serves every call and the harness has no network path besides the model handle.
 */
export function stubProfile(baseURL = 'http://localhost:1/v1'): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: STUB_MODEL_ID,
    baseURL,
    auth: { mode: 'none' },
  }
}

/**
 * A stub profile whose model id is CALLER-SUPPLIED and family-resolvable: the default
 * STUB_MODEL_ID resolves to NO judge family, which would make every judge ineligible under the
 * D-12 two-sided disjointness check (RESEARCH Pitfall 6). Pair it with the same id as the
 * languageModels override key on capturingStub/throwingStub so createModel serves the stub.
 */
export function familyStubProfile(modelId: string, baseURL = 'http://localhost:1/v1'): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: modelId,
    baseURL,
    auth: { mode: 'none' },
  }
}

/** A grounded action tool-call for the recorded ref: web_click on web, mobile_tap on android. */
export function actionGenerateResult(
  platform: FixturePlatform = 'web',
  ref = 'e-continue',
): StubGenerateResult {
  const toolName = platform === 'android' ? 'mobile_tap' : 'web_click'
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'replay-action',
        toolName,
        input: JSON.stringify({
          ref,
          reasoning: 'Act on the recorded Continue control',
          confidence: 0.95,
          stepComplete: true,
          doesActionAdvanceUsTowardsGoal: true,
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

/**
 * A structured tier-4 judge verdict as TEXT-JSON. Output.object consumes text
 * content parts, NOT tool-call parts — a tool-call-shaped stub (actionGenerateResult) would
 * silently exercise only the unparseable-output path. Reuses the actionGenerateResult
 * usage/finishReason/warnings skeleton (input total 10 / output total 2) so usage mapping
 * stays assertable at the port result.
 */
export function judgeGenerateResult(
  verdict: 'equivalent' | 'different' | 'unsure',
  confidence: 'high' | 'medium' | 'low',
  rationale = 'the framed items describe the same recorded control',
): StubGenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ verdict, confidence, rationale }) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  }
}

/** A non-action tool-call requesting a recorded exchange (first round of the tool-loop). */
export function nonActionGenerateResult(toolName: string): StubGenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: 'replay-lookup', toolName, input: JSON.stringify({}) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

export interface CapturingStub {
  captured: CapturedCallOptions[]
  languageModels: Record<string, StubLanguageModel>
}

/** Prompt-aware response at the same captured, post-middleware provider boundary. */
export function respondingStub(
  respond: (call: CapturedCallOptions, index: number) => StubGenerateResult,
  modelId = STUB_MODEL_ID,
): CapturingStub {
  const stub = capturingStub(index => respond(stub.captured[index]!, index), modelId)
  return stub
}

/**
 * A scripted capturing stub injected through createModel's `overrides.languageModels`: every
 * doGenerate params object is captured POST the pinned-last mask/guardrail middleware — the exact
 * provider boundary. `script(callIndex)` returns the response for that round.
 */
export function capturingStub(
  script: (call: number) => StubGenerateResult,
  modelId: string = STUB_MODEL_ID,
): CapturingStub {
  const captured: CapturedCallOptions[] = []
  const stub: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'replay-proof-stub',
    modelId,
    supportedUrls: {},
    async doGenerate(params) {
      const call = captured.length
      captured.push(params)
      return script(call)
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
  return { captured, languageModels: { [modelId]: stub } }
}

/** A stub whose doGenerate throws + counts calls — proves the planner is never reached. */
export function throwingStub(
  modelId: string = STUB_MODEL_ID,
): { languageModels: Record<string, StubLanguageModel>; calls: () => number } {
  let calls = 0
  const stub: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'replay-proof-stub',
    modelId,
    supportedUrls: {},
    async doGenerate() {
      calls++
      throw new Error('planner must not be invoked')
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
  return { languageModels: { [modelId]: stub }, calls: () => calls }
}

// ─── Boundary inspection helpers ────────────────────────────────────────────────────────────────

interface BoundaryContentPart {
  type: string
  [key: string]: unknown
}

/** Every content part across every message of a captured request (order-preserving). */
export function allContentParts(captured: CapturedCallOptions): BoundaryContentPart[] {
  const parts: BoundaryContentPart[] = []
  for (const message of captured.prompt) {
    const content = (message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const part of content) parts.push(part as BoundaryContentPart)
    }
  }
  return parts
}

/** The image/file content parts at the boundary (v3 lowers an image to a `file` part). */
export function imageParts(captured: CapturedCallOptions): BoundaryContentPart[] {
  return allContentParts(captured).filter((part) => part.type === 'image' || part.type === 'file')
}

/** Coerce a boundary image/file part's payload to raw bytes for byte-exact comparison. */
export function imagePartBytes(part: BoundaryContentPart): Uint8Array {
  const payload = part.type === 'image' ? part.image : part.data
  if (payload instanceof Uint8Array) return new Uint8Array(payload)
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (typeof payload === 'string') return new Uint8Array(Buffer.from(payload, 'base64'))
  throw new Error(`unsupported boundary image payload: ${typeof payload}`)
}

/** Find persisted replay.json records under a record-store root. */
export function findReplayRecords(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'replay.json')
    .map((entry) => join(entry.parentPath, entry.name))
}
