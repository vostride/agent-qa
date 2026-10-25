// The whole-run analyze-run author (Phase 389, plan 04 — D-01/D-02/D-03, ANLZ-02).
//
// ONE `model.generate` call authors every unknown-verdict failure together (D-01): the
// author sees the cross-test pattern ("40 reds, one cause") that clustering and the
// discriminator feed on, matches the once-per-run heartbeat unit, and never fans out
// per test or adds a second LLM stage inside the one-checkpoint schedule.
//
// The model's answer is UNTRUSTED. It is parsed with the curator's deterministic repair
// idiom (fence strip, trailing-comma removal — COPIED from `cli/src/curation/
// curator-author.ts`, never imported: agent→cli is a banned direction), shaped by zod, and
// then validated cross-document by schema's `validateAnalysisAgainstHandoff`. Rejects feed
// exactly ONE repair round-trip (D-03) whose feedback names each failing test and reason;
// whatever still fails degrades to the deterministic unknown floor member for THAT test
// only — valid siblings persist, and job-level retries stay reserved for transport
// failures, which propagate out of this function uncaught.
//
// The merge law lives here and nowhere else: a floor verdict is replaced iff its class is
// `unknown` AND a validated author verdict exists for its perTest; everything else passes
// through byte-identical. `producer: 'analyze-run'` is forced code-side — model output
// never chooses producer.
//
// D-02's screenshot channel rides the same single request: when the capability advertises
// `vision` and a blob reader is bound and the post-compaction packs still carry
// screenshotRefs, the failing steps' decision-screenshot bytes attach as the request's
// optional `images`; every other posture is the L9 text-only degradation — a request
// structurally identical to the pre-widening text request. The repair round-trip reuses
// the same image set, never a re-fetch.
//
// The model arrives ONLY as the `JobModelCapability` argument the `recordLlmAuthorship`
// callback hands its author — this module never imports a provider SDK.

import type {
  ArtifactRef,
  CompletedRunHandoff,
  PerTestOutcome,
  StepEvidence,
  Verdict,
  VerdictGroundingQuote,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'
import {
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  deriveMemoryOnPath,
  deriveMemoryOnPathSites,
  failingStepOf,
  QUOTE_SEARCHED_STEP_FIELDS,
  validateAnalysisAgainstHandoff,
} from '@vostride/agent-qa-schema'
import { z } from 'zod'

import { buildTieredPrompt } from '../prompt/tiered-prompt-builder.js'
import type { PromptTierBlock } from '../prompt/tiered-prompt-builder.js'
import { compactEvidencePacks } from './evidence-diet.js'
import type {
  CompactedEvidence,
  EvidenceHistoryLookup,
  EvidencePack,
} from './evidence-diet.js'
import type { JobModelCapability, JobModelRequest } from './record-llm-authorship.js'

/**
 * The single in-attempt repair round-trip (D-03).
 *
 * Pinned, not config (386 D-15); retune from operational evidence: raise only if real
 * transcripts show a second repair regularly rescuing tests the first one could not —
 * every extra round-trip is a model call inside a job attempt whose transport failures
 * already carry their own 3-attempt bound.
 */
export const AUTHOR_REPAIR_CAP = 1

/**
 * The cap on decision-screenshot image parts attached to the one request (D-02).
 *
 * Pinned, not config (386 D-15); retune from operational evidence: raise if real
 * multi-failure transcripts show discriminating screenshots being cut at this cap, lower
 * if image payloads dominate request cost without moving verdict quality.
 */
export const MAX_AUTHOR_IMAGES = 6

export interface MemoryOnPathStampInput {
  readonly verdict: Verdict
  /** The verdict's sentence parts, when they exist — the grounding quote joins the path. */
  readonly parts: VerdictSentenceParts | undefined
  readonly test: PerTestOutcome | undefined
}

/**
 * The steps a verdict's evidence touches — cited steps, the grounding quote's step, and the
 * run's ACTUAL failing step.
 *
 * The twin of `pathStepsOf` inside `schema/src/verdict/validate-analysis.ts`, which is module
 * private there. The two must agree: the stamp writes a `memoryOnPath` declaration and the
 * validator recomputes membership over its own path, so a rule that drifted here would make
 * every stamped verdict disagree with its own recomputation.
 */
export function misdirectionPathSteps(
  verdict: Verdict,
  parts: VerdictSentenceParts | undefined,
  test: PerTestOutcome,
): StepEvidence[] {
  const indexes = new Set<number>(verdict.evidence.citedSteps)
  if (parts !== undefined && 'stepIndex' in parts.groundingQuote) {
    indexes.add(parts.groundingQuote.stepIndex)
  }
  const failing = failingStepOf(test)
  if (failing !== undefined) indexes.add(failing.stepIndex)
  return test.steps.filter((step) => indexes.has(step.stepIndex))
}

/**
 * Stamps `memoryOnPath` with the low-trust records the run's own served briefs put on the
 * verdict's path, replacing whatever the verdict declared.
 * Removes `memoryOnPath` when the path carries none.
 */
export function stampVerdictMemoryOnPath(input: MemoryOnPathStampInput): Verdict {
  const { verdict, parts, test } = input
  if (test === undefined) return verdict

  const steps = misdirectionPathSteps(verdict, parts, test)
  if (deriveMemoryOnPathSites(steps).length === 0) {
    if (verdict.memoryOnPath === undefined) return verdict
    const bare: Verdict = { ...verdict }
    delete bare.memoryOnPath
    return bare
  }
  return { ...verdict, memoryOnPath: deriveMemoryOnPath(steps) }
}

export interface AuthorTokenBudget {
  readonly estimate: (text: string) => number
  readonly inputBudget: number
}

export interface AuthorRunAnalysisInput {
  readonly handoff: CompletedRunHandoff
  /** The deterministic floor exactly as the handler projects it — the merge base. */
  readonly floor: readonly Verdict[]
  /** One evidence pack per unknown member (plan 03's diet), pre-compaction. */
  readonly packs: readonly EvidencePack[]
  /** Per-test failure history for the context tier (D-08's input-for-reasoning). */
  readonly history: EvidenceHistoryLookup
  /**
   * D-01's TokenAccounting substrate entering as data. Absent → no compaction ladder
   * (rung 0, packs whole) — a host without accounting still authors, it just cannot
   * pre-shrink.
   */
  readonly tokenBudget?: AuthorTokenBudget
  /**
   * D-02's capability-gated screenshot bytes, sha-addressed. Absent ⇒ text-only per L9.
   */
  readonly readEvidenceBlob?: (sha: string) => Uint8Array | undefined
  /** The §1.4 `agent_context` parameter; defaults to the analyze-run provenance line. */
  readonly agentContext?: string
}

export interface AuthorRunAnalysisResult {
  /** The merged array: floor order, unknown members upgraded, all else byte-identical. */
  readonly verdicts: Verdict[]
  /** LLM sentence parts for the UPGRADED members only, joined by perTest (D-06). */
  readonly authoredParts: VerdictSentenceParts[]
  /** The D-01 ladder outcome, surfaced — `overBudget` is never swallowed. */
  readonly compaction: {
    readonly rung: CompactedEvidence['rung']
    readonly overBudget: boolean
    readonly estimatedTokens: number
  }
  /** Analyzed tests that failed validation after the single repair and kept their floor. */
  readonly degradedTests: number[]
  /**
   * What this authorship spent. `recordLlmAuthorship` memoizes, so a resumed job reads the
   * recorded value and never reaches this function; the loop makes at most
   * `1 + AUTHOR_REPAIR_CAP` model calls.
   */
  readonly usage: {
    readonly modelCalls: number
    readonly repairCalls: number
    /** The compaction ladder's estimate; `0` when no accounting substrate was injected. */
    readonly estimatedTokens: number
  }
}

// ---------------------------------------------------------------------------------------
// The wire contract: what the model is asked to return, and the zod shape that reads it.
// `class` and `confidence` are deliberately loose here — the closed union and the exact
// [0,1] bound are enforced per-test by `validateAnalysisAgainstHandoff`, so a wrong value
// becomes a NAMED per-test reject feeding the repair message instead of an opaque
// whole-output parse failure.
// ---------------------------------------------------------------------------------------

const GroundingQuoteWire = z.union([
  z.object({ stepIndex: z.number(), quote: z.string() }),
  z.object({ source: z.literal('test-outcome'), quote: z.string() }),
])

const AuthoredTestWire = z.object({
  testIndex: z.number(),
  class: z.string(),
  confidence: z.number(),
  memoryMisdirectionRuledOut: z.boolean(),
  citedSteps: z.array(z.number()),
  citedArtifacts: z.array(z.object({ id: z.string(), sha: z.string() })).default([]),
  rationale: z.string(),
  groundingQuote: GroundingQuoteWire,
  discriminator: z.string(),
  nextAction: z.string(),
  links: z.array(z.string()).default([]),
})

const AuthorOutputWire = z.object({
  tests: z.array(AuthoredTestWire),
  patternNote: z.string().optional(),
})

type AuthoredTestEntry = z.infer<typeof AuthoredTestWire>

/** One restatement of the output contract — the stable tier and the repair message share it. */
const OUTPUT_CONTRACT =
  'Return exactly ONE JSON object, no markdown fences, shaped {"tests": [...]} with one ' +
  'entry per analyzed test. Each entry carries: testIndex (number, copied from the ' +
  'evidence), class (one of test_bug, app_bug, environment, flake, config_error, ' +
  'llm_error, unknown, timeout — unknown is an honest abstention), confidence (a number ' +
  'inside [0, 1]), memoryMisdirectionRuledOut (boolean), citedSteps (array of stepIndex ' +
  'numbers you actually relied on), citedArtifacts (array of {id, sha} artifact refs, [] ' +
  'when none), rationale (your reasoning trace — advisory, never shown as the sentence), ' +
  'groundingQuote ({"stepIndex": n, "quote": s} quoting captured evidence VERBATIM, or ' +
  '{"source": "test-outcome", "quote": s} for a test with zero captured steps), ' +
  'discriminator (what distinguishes THIS failure), nextAction (the one concrete next ' +
  'step), and links (agentqa:// entity URIs, [] when none). An optional top-level ' +
  '"patternNote" string may describe a cross-test pattern.'

// ---------------------------------------------------------------------------------------
// Deterministic JSON repair — the curator-author idiom, copied (agent may not import cli).
// Fence strip, first-object extraction, trailing-comma removal; anything still unreadable
// throws and becomes a whole-output reject for every pending test.
// ---------------------------------------------------------------------------------------

function removeTrailingCommas(json: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index]!
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (/\s/.test(json[lookahead] ?? '')) lookahead += 1
      if (json[lookahead] === '}' || json[lookahead] === ']') continue
    }
    output += char
  }
  return output
}

function parseJsonWithRepair(text: string): unknown {
  const fenced = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(text)
  const source = (fenced?.[1] ?? text).trim()
  const objectStart = source.indexOf('{')
  if (objectStart < 0) throw new Error('no JSON object found in the output')

  const expectedClosers: Array<'}' | ']'> = []
  let inString = false
  let escaped = false
  let objectEnd = -1
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') expectedClosers.push('}')
    else if (char === '[') expectedClosers.push(']')
    else if (char === '}' || char === ']') {
      const expected = expectedClosers.pop()
      if (expected !== char) throw new Error(`mismatched JSON delimiter ${char}`)
      if (expectedClosers.length === 0) {
        objectEnd = index
        break
      }
    }
  }
  if (inString) throw new Error('unterminated JSON string in the output')

  const candidate =
    objectEnd >= 0
      ? source.slice(objectStart, objectEnd + 1)
      : `${source.slice(objectStart)}${[...expectedClosers].reverse().join('')}`

  try {
    return JSON.parse(removeTrailingCommas(candidate))
  } catch {
    throw new Error('JSON parse failed after deterministic repair')
  }
}

// ---------------------------------------------------------------------------------------
// Prompt composition: plan 03's stages, composed — never reimplemented.
// ---------------------------------------------------------------------------------------

function stableTier(): PromptTierBlock[] {
  return [
    {
      title: 'Role',
      body:
        'You are the analyze-run verdict author. A test run has finished with failed ' +
        'member tests whose deterministic classifier found no signal; you classify each ' +
        'one from its captured evidence and author the typed parts of one honest sentence ' +
        'a QA engineer can act on. Never invent an observation: every groundingQuote must ' +
        'be a verbatim contiguous substring of the captured evidence you cite ' +
        `(searched fields: ${QUOTE_SEARCHED_STEP_FIELDS.join(', ')}).`,
    },
    { title: 'Output contract', body: OUTPUT_CONTRACT },
    {
      title: 'The four obligations',
      body:
        'For every analyzed test: (a) ground the sentence in a QUOTED observation from ' +
        'captured evidence; (b) state a discriminator — what distinguishes this failure ' +
        'from its neighbours, e.g. whether the same step passed on the previous build; ' +
        '(c) recurrence context is rendered LIVE by the product from recorded history — ' +
        'never bake counts into your prose; (d) recommend the one concrete next action.',
    },
    {
      title: 'Memory misdirection',
      body:
        'Each failing step shows the memory brief that was served to it. Before answering ' +
        'a class that moves no trust (app_bug, flake, environment, config_error) while ' +
        'candidate or low-trust memory was on the failing path, you must have explicitly ' +
        'ruled out that the served memory misdirected the run — set ' +
        'memoryMisdirectionRuledOut true only when the evidence supports it; otherwise ' +
        'answer unknown or a trust-moving class.',
    },
    {
      title: 'Cross-test patterns',
      body:
        'You see the WHOLE run at once on purpose. Look for one cause behind many reds — ' +
        'a shared failing element, route or infrastructure signal across tests — and let ' +
        'it inform each verdict and discriminator; note it in patternNote when present.',
    },
  ]
}

function historyLine(pack: EvidencePack, history: EvidenceHistoryLookup): string {
  const record = history({ filePath: pack.filePath, testName: pack.testName })
  if (record === undefined) {
    return `- test ${pack.testIndex} (${pack.testName}): no recorded history`
  }
  const window = record.lastOutcomes
    .map((entry) => `build ${entry.buildOrdinal}: ${entry.passed ? 'passed' : 'failed'}`)
    .join(', ')
  return (
    `- test ${pack.testIndex} (${pack.testName}): ${record.passes} passes, ` +
    `${record.failures} failures, ${record.heals} heals, flakeCount ${record.flakeCount}` +
    (window === '' ? '' : `; recent: ${window}`)
  )
}

function contextTier(
  handoff: CompletedRunHandoff,
  packs: readonly EvidencePack[],
  history: EvidenceHistoryLookup,
): PromptTierBlock[] {
  return [
    {
      title: 'Run facts',
      body:
        `Run ${String(handoff.runId)} on product scope ${handoff.scope.key} ` +
        `(build ${handoff.buildOrdinal}, ${handoff.executionContext}); aggregate verdict ` +
        `${handoff.aggregateVerdict}; ${handoff.tests.length} member tests, ` +
        `${packs.length} analyzed here (the unknown-verdict failures).`,
    },
    {
      title: 'Failure history (reasoning input)',
      body:
        'Recorded outcome history per analyzed test — evidence for flake-vs-app_bug ' +
        'reasoning, not prose to restate:\n' +
        packs.map((pack) => historyLine(pack, history)).join('\n'),
    },
  ]
}

function volatileTier(packs: readonly EvidencePack[]): PromptTierBlock[] {
  return packs.map((pack) => ({
    title: `Test ${pack.testIndex}: ${pack.testName}`,
    body: canonicalJson(pack),
  }))
}

// ---------------------------------------------------------------------------------------
// The D-02 request gate: images attach iff vision + reader + surviving refs.
// ---------------------------------------------------------------------------------------

function collectImages(
  packs: readonly EvidencePack[],
  readEvidenceBlob: ((sha: string) => Uint8Array | undefined) | undefined,
  vision: boolean,
): Uint8Array[] {
  if (!vision || readEvidenceBlob === undefined) return []
  const seen = new Set<string>()
  const images: Uint8Array[] = []
  for (const pack of packs) {
    for (const ref of pack.screenshotRefs) {
      if (images.length >= MAX_AUTHOR_IMAGES) return images
      if (seen.has(ref.sha)) continue
      seen.add(ref.sha)
      const bytes = readEvidenceBlob(ref.sha)
      if (bytes === undefined) continue
      images.push(bytes)
    }
  }
  return images
}

// ---------------------------------------------------------------------------------------
// Candidate assembly and the merge law.
// ---------------------------------------------------------------------------------------

interface CandidatePair {
  readonly verdict: Verdict
  readonly parts: VerdictSentenceParts
}

/** Build the candidate pair for one wire entry — producer FORCED code-side (never the model). */
function candidateOf(entry: AuthoredTestEntry): CandidatePair {
  const citedArtifacts: ArtifactRef[] = entry.citedArtifacts.map((ref) => ({
    id: ref.id,
    sha: ref.sha,
  }))
  const verdict = {
    class: entry.class,
    producer: 'analyze-run',
    confidence: entry.confidence,
    evidence: {
      citedSteps: [...entry.citedSteps],
      citedAnchors: [],
      citedArtifacts,
      rationale: entry.rationale,
    },
    memoryMisdirectionRuledOut: entry.memoryMisdirectionRuledOut,
    perTest: entry.testIndex,
  } as Verdict
  const parts: VerdictSentenceParts = {
    perTest: entry.testIndex,
    groundingQuote: entry.groundingQuote as VerdictGroundingQuote,
    discriminator: entry.discriminator,
    nextAction: entry.nextAction,
    links: [...entry.links],
  }
  return { verdict, parts }
}

interface AttemptOutcome {
  readonly accepted: Map<number, CandidatePair>
  readonly rejects: { perTest: number; reason: string }[]
}

/**
 * Parse one model answer and validate the candidates for the still-pending tests.
 * A whole-output parse failure rejects every pending test with one named reason; a
 * per-test validation failure rejects that test alone.
 */
function evaluateAttempt(
  text: string,
  pending: ReadonlySet<number>,
  input: AuthorRunAnalysisInput,
): AttemptOutcome {
  const handoff = input.handoff
  let entries: AuthoredTestEntry[]
  try {
    const wire = AuthorOutputWire.parse(parseJsonWithRepair(text))
    entries = wire.tests
  } catch (error) {
    const reason =
      'the output was not one parseable JSON object matching the contract: ' +
      (error instanceof Error ? error.message : String(error))
    return {
      accepted: new Map(),
      rejects: [...pending].map((perTest) => ({ perTest, reason })),
    }
  }

  // First entry per testIndex wins; entries for tests outside the pending analyzed set are
  // discarded — the author upgrades unknown floor members ONLY, so a re-classing of a
  // deterministic member is not even a candidate.
  const byTest = new Map<number, AuthoredTestEntry>()
  for (const entry of entries) {
    if (!pending.has(entry.testIndex) || byTest.has(entry.testIndex)) continue
    byTest.set(entry.testIndex, entry)
  }

  const rejects: { perTest: number; reason: string }[] = []
  const candidates = new Map<number, CandidatePair>()
  const testsByIndex = new Map(handoff.tests.map((test) => [test.testIndex, test]))
  for (const perTest of pending) {
    const entry = byTest.get(perTest)
    if (entry === undefined) {
      rejects.push({ perTest, reason: `the output carries no entry for testIndex ${perTest}` })
      continue
    }
    const pair = candidateOf(entry)
    // Stamped before validation, so the validator checks the membership that is persisted.
    candidates.set(perTest, {
      ...pair,
      verdict: stampVerdictMemoryOnPath({
        verdict: pair.verdict,
        parts: pair.parts,
        test: testsByIndex.get(perTest),
      }),
    })
  }

  if (candidates.size > 0) {
    const ordered = [...candidates.values()]
    const validation = validateAnalysisAgainstHandoff(
      {
        schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
        runId: String(handoff.runId),
        verdicts: ordered.map((pair) => pair.verdict),
        parts: ordered.map((pair) => pair.parts),
      },
      handoff,
    )
    if (!validation.ok) {
      const rejectedTests = new Set(validation.rejects.map((reject) => reject.perTest))
      rejects.push(...validation.rejects)
      for (const perTest of rejectedTests) candidates.delete(perTest)
    }
  }

  return { accepted: candidates, rejects }
}

function repairFeedback(rejects: readonly { perTest: number; reason: string }[]): string {
  return [
    '## Validation feedback',
    '',
    'Your previous output failed validation for the tests below. Return ONE corrected ' +
      'JSON object with an entry for EVERY analyzed test, correcting each named failure:',
    ...rejects.map((reject) => `- test ${reject.perTest}: ${reject.reason}`),
    '',
    OUTPUT_CONTRACT,
  ].join('\n')
}

/**
 * The author: compose plan 03's stages around ONE `model.generate` call, repair once,
 * degrade per test, merge upgrade-only-unknown. Transport failures propagate uncaught —
 * the job's declared bound adjudicates those, never this function.
 */
export async function authorRunAnalysis(
  model: JobModelCapability,
  input: AuthorRunAnalysisInput,
): Promise<AuthorRunAnalysisResult> {
  // The ladder runs iff the accounting substrate was injected; a host without it authors
  // over the packs whole (rung 0) — doc'd on `tokenBudget`.
  const compacted: CompactedEvidence =
    input.tokenBudget === undefined
      ? {
          packs: input.packs,
          rung: 0,
          overBudget: false,
          estimatedTokens: 0,
        }
      : compactEvidencePacks(input.packs, input.tokenBudget.estimate, input.tokenBudget.inputBudget)

  const unknownFloor = new Set(
    input.floor.filter((verdict) => verdict.class === 'unknown').map((verdict) => verdict.perTest),
  )
  // POST-compaction packs on purpose: rung 1 stripping the refs IS the ladder's text-only
  // degradation, so the vision gate must never re-read refs from the uncompacted packs.
  const analyzed = compacted.packs
    .map((pack) => pack.testIndex)
    .filter((testIndex) => unknownFloor.has(testIndex))

  const baseRequest = buildTieredPrompt({
    agent_context:
      input.agentContext ??
      'analyze-run: authoring root-cause verdicts and sentence parts for one completed run',
    stable: stableTier(),
    context: contextTier(input.handoff, compacted.packs, input.history),
    volatile: volatileTier(compacted.packs),
  })
  const images = collectImages(compacted.packs, input.readEvidenceBlob, model.vision === true)
  const request: JobModelRequest =
    images.length === 0 ? baseRequest : { ...baseRequest, images }

  const accepted = new Map<number, CandidatePair>()
  let pending = new Set(analyzed)
  let lastRejects: readonly { perTest: number; reason: string }[] = []
  let modelCalls = 0

  for (let attempt = 0; attempt <= AUTHOR_REPAIR_CAP && pending.size > 0; attempt += 1) {
    const attemptRequest: JobModelRequest =
      attempt === 0
        ? request
        : { ...request, prompt: `${request.prompt}\n\n${repairFeedback(lastRejects)}` }
    const output = await model.generate(attemptRequest)
    modelCalls += 1
    const outcome = evaluateAttempt(output.text, pending, input)
    for (const [perTest, pair] of outcome.accepted) accepted.set(perTest, pair)
    pending = new Set([...pending].filter((perTest) => !accepted.has(perTest)))
    lastRejects = outcome.rejects
  }

  // The merge law, in one place: replace iff the floor member is `unknown` AND a validated
  // candidate exists; every other member passes through byte-identical.
  const verdicts = input.floor.map((floorVerdict) => {
    if (floorVerdict.class !== 'unknown') return floorVerdict
    return accepted.get(floorVerdict.perTest)?.verdict ?? floorVerdict
  })
  const authoredParts = analyzed
    .filter((testIndex) => accepted.has(testIndex))
    .map((testIndex) => (accepted.get(testIndex) as CandidatePair).parts)

  return {
    verdicts,
    authoredParts,
    compaction: {
      rung: compacted.rung,
      overBudget: compacted.overBudget,
      estimatedTokens: compacted.estimatedTokens,
    },
    degradedTests: analyzed.filter((testIndex) => !accepted.has(testIndex)),
    usage: {
      modelCalls,
      repairCalls: Math.max(0, modelCalls - 1),
      estimatedTokens: compacted.estimatedTokens,
    },
  }
}
