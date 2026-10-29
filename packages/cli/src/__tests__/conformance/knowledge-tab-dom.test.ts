/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` callbacks are compiled as
// TypeScript and EXECUTED in a browser — `run-detail-dom.test.ts`'s reasoning, unchanged.

// THE KNOWLEDGE TAB AND THE RUNG BANNER, IN THE MEDIUM A PERSON LOOKS AT (Phase 407 plan 11 ·
// LERN-01 / LERN-02 / TRST-01, D-01 / D-02 / D-03 / D-04 / D-13 / D-14 / D-15).
//
// WHAT THIS FILE IS FOR. 407-02 through 407-10 each proved one leg with jsdom and unit cells: the
// op projects, the route serves, the view module folds the copy, the component paints the
// attribute. This file is the phase's acceptance on the artifact a person installs — it drives the
// BUILT dashboard bundle served by the SHIPPED `agent-qa dashboard`, over a real socket, in a real
// headless Chromium, against runs the binary really executed, and asserts on what the browser drew
// and on what the browser's own `/api/runs/:id/knowledge` response said.
//
// PAGE ↔ OP PARITY RATHER THAN A HOST ASSUMPTION. Every claim about the rung banner is stated
// against the projection THIS PAGE FETCHED, not against a rung this file believes a CI host would
// reach. A machine's embedder ladder is not a fixed point: the same commit answers `memidex` on a
// laptop with a downloaded model and `lexical-only` on a runner without one, and a cell pinning
// either word would be measuring the machine. The ONE deterministic rung here is fixture (A)'s,
// and it is deterministic for a structural reason rather than a hopeful one — the populated
// fixture ships an EMPTY `agent-qa-knowledge` directory with no index, the fold reads the index
// axis FIRST, and an absent index folds to `bundle-scan` / `index-not-built` whatever the embedder did.
// If a future fixture change adds an index, (a1)/(a2) must switch to the parity form (b3) uses.
//
// A BROWSER THAT CANNOT LAUNCH IS A RED, NEVER A SKIP — `run-detail-dom.test.ts`'s law. The one
// conditional in this file is `describePosix`, and it exists because the dashboard child is
// stopped with SIGTERM and the runs write POSIX runtime roots.
//
// THE DRIVING HAPPENS ONCE PER FIXTURE, IN `beforeAll`, AND THE CELLS ASSERT ON WHAT IT RECORDED.
// Two fixtures, because the two halves of LERN-01 need two different worlds:
//
//   (A) `knowledge-tab-dom-scan` — the populated fixture UNCHANGED. Empty knowledge root, no
//       index, so retrieval serves nothing and the rung is the deterministic `bundle-scan`. This
//       is where the silent header and the tab's fresh-index statement, the empty Used half, the
//       `m` shortcut, the deleted memory tab and the `curation` chip click-through are measured.
//
//   (B) `knowledge-tab-dom-served` — the same fixture with ONE published bundle at the run's own
//       product scope and a rebuilt index, seeded BEFORE the binary is spawned. This is the only
//       world in which a served channel-1 line and its serve-time why-trace exist to be looked at,
//       and a served line is the LERN-01 claim.
//
// EVERY SENTENCE IS READ OUT OF THE MODULE THAT PUBLISHES IT. `packages/cli` cannot import a React
// package's lib (dashboard-ui ships built app assets, not a library entry), so the copy tables are
// EXTRACTED from `dashboard-ui/src/lib/knowledge-view.ts` as source text — `run-detail-dom.test.ts`
// and `post-processing-dom.test.ts`'s `publishedConstant` idiom, widened to a `Record` literal.
// A hardcoded copy would go on passing against a page that says something else.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import { DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import {
  appendOutcomeEvent,
  publishBundleForTest,
  rebuildIndex,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
// 407-25: the JOIN KEY, taken from the READ barrel that publishes it rather than re-derived here.
// The reader recomputes this id to find the event; a harness that PLANTS the event must compute
// the same one, and a second spelling would produce a plant no read ever finds — a green
// agreement over an empty set, which is the failure the non-vacuity block below exists to catch.
import { canaryOutcomeObservationId } from '@vostride/agent-qa-knowledge-local/reader'
import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  CURATION_BREAKDOWN_BUCKETS,
  CURATION_BUCKET_PRECEDENCE,
  RunKnowledgeProjectionSchema,
  asEvidenceToken,
  asRecordId,
  type BundleDiscriminant,
  type BundleDraft,
  type DistilledObservation,
  type RunKnowledgeCanaryAttribution,
  type RunKnowledgeProjection,
  type RunKnowledgeStep,
} from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_RUN_ANCHORED_BUILDS,
  POPULATED_TARGET_NAME,
  RUN_BUDGET_MS,
  drivePopulatedRun,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
} from './populated-run-fixture.js'
import type { FixtureServer, PopulatedRunDrive, StubModelServer } from './populated-run-fixture.js'
import {
  PACKAGES_ROOT,
  buildFreshness,
  cleanupTempRoots,
  reserveEphemeralPort,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT dashboard UI served by the BUILT `agent-qa dashboard` and the built '
  + 'packages it resolves as external workspace dependencies: run `pnpm turbo run build --force` '
  + 'from the agent-qa root first. `--force` is required — a mutation script that restores its '
  + 'subject byte-identically is a turbo cache hit, so a plain build reports FULL TURBO and '
  + 'refreshes no dist mtime.'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium, against runs the shipped binary '
  + 'really executed: run `pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE '
  + 'SKIPPED WHEN THE BROWSER IS ABSENT — they are the only cells in this repository that measure '
  + "the Knowledge tab and the retrieval-rung banner on the artifact a person installs."

/** How long the page has to mount, paint the tree and settle the tab. */
const PAGE_BUDGET_MS = 60_000

// ── The published copy, read out of the module that publishes it ─────────────────────────────────

const KNOWLEDGE_VIEW_REL = join('lib', 'knowledge-view.ts')

function knowledgeViewSource(): string {
  return readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', KNOWLEDGE_VIEW_REL), 'utf8')
}

/** A top-level single-quoted `export const` — `run-detail-dom.test.ts`'s `publishedConstant`. */
function publishedConstant(name: string): string {
  const entry = new RegExp(`export const ${name}(?::\\s*string)?\\s*=\\s*'([^']*)'`, 'u')
    .exec(knowledgeViewSource())
  if (entry === null) {
    throw new Error(`${name} is no longer a single-quoted top-level constant in ${KNOWLEDGE_VIEW_REL}`)
  }
  return entry[1] as string
}

/**
 * An exported `Record` literal of single-quoted key/value pairs, as a map.
 *
 * The same extraction `post-processing-dom.test.ts` uses for one member, taken whole: these two
 * tables are the banner's entire vocabulary and the cells below compose the sentence from them
 * rather than retyping it.
 */
function publishedLabelTable(name: string): Record<string, string> {
  const block = new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`, 'u')
    .exec(knowledgeViewSource())
  if (block === null) {
    throw new Error(`${name} is no longer an exported object literal in ${KNOWLEDGE_VIEW_REL}`)
  }
  const table: Record<string, string> = {}
  for (const line of (block[1] as string).split('\n')) {
    const entry = /^\s*'([^']+)':\s*'([^']*)',?\s*$/u.exec(line)
    if (entry !== null) table[entry[1] as string] = entry[2] as string
  }
  if (Object.keys(table).length === 0) {
    throw new Error(`${name} carries no single-quoted members in ${KNOWLEDGE_VIEW_REL}`)
  }
  return table
}

/**
 * An exported array literal of single-quoted members, as a list.
 *
 * The `publishedConstant` idiom applied to a CLOSED VOCABULARY. `LEARNED_CHANGE_KINDS` is the one
 * this file needs and it is the table R-407-15-01 widened to five, so hand-typing the members here
 * would leave (c4) re-deriving the door's answer from a vocabulary the view no longer holds — a
 * cell that goes on passing against a page filtering by a different set. A source read that finds
 * nothing THROWS, so the cell reds with the reason rather than falling back to a literal.
 *
 * IT USED TO THROW ONLY ON ZERO, WHICH IS THE ONE FAILURE THAT CANNOT HAPPEN QUIETLY (G-407-19 ·
 * REVIEW IN-01). The two that CAN are a capture that stopped early and a member the recovery regex
 * cannot see, and each yields a SHORTER list in silence — leaving (c4) narrowing the door's answer
 * by a subset of the vocabulary the view actually holds. Both are now rejected directly:
 *
 *   1. A CAPTURED SLICE CONTAINING A FURTHER `[`. `[^\]]*` stops at the first `]`, so a nested
 *      array — or a member holding one — truncates the literal mid-way.
 *   2. A QUOTE CENSUS THE RECOVERED MEMBERS DO NOT ACCOUNT FOR. Members are recovered with
 *      `/'([^']+)'/gu`, so the census MUST count apostrophes, double quotes AND backticks: a
 *      member respelled `"promoted"` contributes ZERO apostrophes, drops silently out of the list,
 *      and leaves an apostrophe-only tally reading exactly `2 * members.length` — the check would
 *      pass on IN-01's own named failure mode and be a check-shaped thing rather than a check.
 *      Counting all three and requiring `2 * members.length` is what actually rejects it.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED IS THE MEMBER COUNT. `LEARNED_CHANGE_KINDS.length === 5` would
 * read as a rejection of a narrowing and act as a freeze on the vocabulary — and whether the table
 * holds four kinds or five is UAT item 9, still open and still the owner's. These two checks reject
 * a SILENT narrowing without ruling on what the right size is.
 */
function publishedStringArray(
  name: string,
  // THE SOURCE IS A PARAMETER SO THE TWO REJECTIONS CAN BE DRIVEN. `(c7)` hands it a hand-built
  // slice carrying IN-01's own named failure mode; every real caller takes the default and reads
  // the module that publishes the vocabulary.
  source: string = knowledgeViewSource(),
): readonly string[] {
  const block = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`, 'u')
    .exec(source)
  if (block === null) {
    throw new Error(`${name} is no longer an exported array literal in ${KNOWLEDGE_VIEW_REL}`)
  }
  const slice = block[1] as string
  if (slice.includes('[')) {
    throw new Error(
      `${name}'s captured literal in ${KNOWLEDGE_VIEW_REL} contains a further \`[\`, so the `
      + `capture stopped at an inner \`]\` and the member list below would be a TRUNCATION of the `
      + `vocabulary rather than the vocabulary. Slice: ${JSON.stringify(slice)}`,
    )
  }
  const members = Array.from(slice.matchAll(/'([^']+)'/gu)).map(hit => hit[1] as string)
  if (members.length === 0) {
    throw new Error(`${name} carries no single-quoted members in ${KNOWLEDGE_VIEW_REL}`)
  }
  const quoteCensus = (slice.match(/['"`]/gu) ?? []).length
  if (quoteCensus !== 2 * members.length) {
    throw new Error(
      `${name}'s captured literal in ${KNOWLEDGE_VIEW_REL} holds ${String(quoteCensus)} quote `
      + `character(s) — apostrophes, double quotes and backticks together — but the `
      + `${String(members.length)} member(s) recovered account for only `
      + `${String(2 * members.length)}. A member written in any delimiter other than an apostrophe `
      + `is invisible to the recovery regex and would drop out of the list SILENTLY, leaving every `
      + `caller narrowing by a subset of the real vocabulary. Recovered: `
      + `${JSON.stringify(members)}; slice: ${JSON.stringify(slice)}`,
    )
  }
  return members
}

/**
 * A module-private `const NAME = { key: 'value', … }` table with bare keys, as a map (427 D-15).
 *
 * `CHANGE_BUCKETS` is how `learnedView` maps a change kind onto 425's five words when a run has no
 * snapshot. It is read here rather than retyped so (c4)'s door projection maps the way the page
 * does; a table this cannot read THROWS.
 */
function sourceKeyTable(name: string): Record<string, string> {
  const block = new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`, 'u').exec(knowledgeViewSource())
  if (block === null) throw new Error(`${name} is no longer an object literal in ${KNOWLEDGE_VIEW_REL}`)
  const table: Record<string, string> = {}
  for (const line of (block[1] as string).split('\n')) {
    const entry = /^\s*([a-z]+):\s*'([a-z]+)',?\s*$/u.exec(line)
    if (entry !== null) table[entry[1] as string] = entry[2] as string
  }
  if (Object.keys(table).length === 0) throw new Error(`${name} carries no members in ${KNOWLEDGE_VIEW_REL}`)
  return table
}

/** A single-quoted export of `post-processing-view.ts` — `post-processing-dom.test.ts`'s idiom. */
function postProcessingConstant(name: string): string {
  const relativePath = join('lib', 'post-processing-view.ts')
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const match = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is no longer an exported single-quoted string in ${relativePath}`)
  return match[1] as string
}

/** Each recorded reason's retrieval class and each class's tone (427 D-20, D-21), read from source. */
const RETRIEVAL_CLASS_BY_REASON = publishedLabelTable('RETRIEVAL_CLASS_BY_REASON')
const RETRIEVAL_CLASS_TONES = publishedLabelTable('RETRIEVAL_CLASS_TONES')
for (const retrievalClass of Object.values(RETRIEVAL_CLASS_BY_REASON)) {
  if (RETRIEVAL_CLASS_TONES[retrievalClass] === undefined) {
    throw new Error(`RETRIEVAL_CLASS_TONES in ${KNOWLEDGE_VIEW_REL} gives no tone for the class \`${retrievalClass}\``)
  }
}
const NO_BRIEF_LINES_TEXT = publishedConstant('NO_BRIEF_LINES_TEXT')
const NO_BRIEF_SERVED_TEXT = publishedConstant('NO_BRIEF_SERVED_TEXT')
const STEP_NO_BRIEF_TEXT = publishedConstant('STEP_NO_BRIEF_TEXT')
const CHANGES_UNREADABLE_TEXT = publishedConstant('CHANGES_UNREADABLE_TEXT')
const STORE_READ_INCOMPLETE_TEXT = publishedConstant('STORE_READ_INCOMPLETE_TEXT')
/**
 * The note a failed chain prints BESIDE the records it had already committed (407-26/27).
 *
 * READ FROM SOURCE, never retyped: the wording is explicitly unsettled (it joins UAT item 10's
 * open copy decision), so a cell holding a literal copy would red on a rewording that is not a
 * defect, and — worse — would go on passing if the view stopped publishing the note at all.
 */
const CURATION_FAILED_PARTIAL_TEXT = publishedConstant('CURATION_FAILED_PARTIAL_TEXT')
/** The five Learned kinds `learnedView` narrows to, READ FROM SOURCE and never retyped here. */
const LEARNED_CHANGE_KINDS = publishedStringArray('LEARNED_CHANGE_KINDS')
/** Each Learned kind's bucket word when a run has no snapshot (427 D-15), read from source. */
const CHANGE_BUCKETS = sourceKeyTable('CHANGE_BUCKETS')
for (const kind of LEARNED_CHANGE_KINDS) {
  if (CHANGE_BUCKETS[kind] === undefined) {
    throw new Error(`CHANGE_BUCKETS in ${KNOWLEDGE_VIEW_REL} maps no bucket for the Learned kind \`${kind}\``)
  }
}
/** What the effect section says when the run used no stored knowledge (427 D-02, SC1). */
const EFFECT_NOTHING_USED_TEXT = publishedConstant('EFFECT_NOTHING_USED_TEXT')
/** What the changes section says when post-run processing changed nothing (427, SC1). */
const NO_MEMORY_CHANGES_SENTENCE = publishedConstant('NO_MEMORY_CHANGES_SENTENCE')
/** The breakdown line of an all-zero snapshot, read from the module that composes it (425 D-16). */
const NO_MEMORY_CHANGES_TEXT = postProcessingConstant('NO_MEMORY_CHANGES_TEXT')

/**
 * The retrieval class a recorded rung below memidex reads as, from the published class map.
 *
 * The sentences themselves are pinned in jsdom, which imports the constants; many carry an
 * apostrophe and are not single-quoted literals this file can read. A reason the map does not
 * name THROWS rather than falling back to a class.
 */
function retrievalClassOf(reason: string | undefined): string {
  if (reason === undefined) return 'cause-not-recorded'
  const retrievalClass = RETRIEVAL_CLASS_BY_REASON[reason]
  if (retrievalClass === undefined) throw new Error(`RETRIEVAL_CLASS_BY_REASON names no ${reason}`)
  return retrievalClass
}

/**
 * The why-trace line, composed from the projection's own trace entry.
 *
 * `traceLineText`'s shape (`knowledge-view.ts:193`) with the three numbers taken from the trace
 * the RUN recorded — never typed, which is the whole of D-04's honesty claim: the page must say
 * what the serve-time trace said, not what an index would say if asked again today.
 */
function traceLineText(leg: string, rank: number, score: number): string {
  return `leg ${leg} · rank ${String(rank)} · score ${score.toFixed(3)}`
}

// ── The seeded bundle for fixture (B) ────────────────────────────────────────────────────────────

/**
 * The build ordinal the seeded record is created under.
 *
 * ONE, because a fresh project's first run is ordinal one: `nextBuildOrdinal` reads a missing
 * counter as zero and advances it, and `populatedRunFixtureProject` mints a brand-new temp root
 * per call. The reader admits a record whose `createdAtOrdinal` is not GREATER than the run's
 * `asOfBuild`, so equal is visible — and the lineage window opens at `max(1, asOf - w + 1)`, which
 * is one here, so the confirming event at ordinal one is inside it.
 */
const SEED_ORDINAL = 1

/** The summary the seeded record carries — long enough to be unmistakable in a page's text. */
const SEED_SUMMARY = 'The Acknowledge button dismisses the notice banner on the fixture page.'

/**
 * The bundle seeded at the run's own product scope.
 *
 * COPIED FROM `knowledge-composition.acceptance.test.ts`'s `committedFixtureInput` and adjusted on
 * exactly two axes: the SCOPE key is this fixture's product (`resolveTarget` answers
 * `target.product ?? targetName`, and the populated fixture declares no `product`, so the run's
 * scope key is the target NAME) and the ordinals are the first-run ordinals above. Everything else
 * is the recipe that is already known to publish and to be served.
 */
function seededBundleInput(): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [
      { t: 'el', role: 'button', name: 'Acknowledge', ordinal: 0 },
      { t: 'page', route: '/' },
      { t: 'selector', literal: '[data-testid="acknowledge"]' },
    ],
    scope: { tier: 'product', key: POPULATED_TARGET_NAME },
    summary: SEED_SUMMARY,
    body: 'The Acknowledge button was resolved and verified on the notice page.',
    distilledEvidenceRef: {
      id: 'knowledge-tab-dom-evidence',
      sha: 'b'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name: 'Acknowledge' },
  }
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'acknowledge-click', ordinal: 0 },
    platform: 'web',
    element: { naturalKey: 'button:acknowledge:0' },
    locator: { selector: '[data-testid="acknowledge"]' },
    observedAtOrdinal: SEED_ORDINAL,
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal: SEED_ORDINAL,
    screenStates: [],
    initialEvents: [BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: asEvidenceToken('knowledge-tab-dom-confirmation'),
      curationJobId: 'knowledge-tab-dom-confirmation',
      buildOrdinal: SEED_ORDINAL,
      origin: 'agent-verified',
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: 'run-knowledge-tab-dom-seed',
      testId: 'test-knowledge-tab-dom-seed',
      stepIndex: 0,
      curationJobId: 'knowledge-tab-dom-seed',
      sourceBuildOrdinal: SEED_ORDINAL,
    },
    artifacts: [],
    evidenceMarkdown: 'Deterministically observed while acknowledging the notice.\n',
    distilledObservations: [observation],
  }
}

/** Seed one published record into a fixture's knowledge root and rebuild its index. */
async function seedServedRecord(project: {
  readonly root: string
  readonly agentQaRoot: string
}): Promise<{ readonly id: string; readonly outcome: string }> {
  // ONE SPELLING OF THE STORE HANDLE (REVIEW IN-04). `bundleStoreFor` was extracted for exactly
  // this config — its docstring already says "the store handle both writers below take, differing
  // only in the lease they hold" — and a second literal here is the drift the helper exists to
  // prevent. The lease is the only member that ever differed.
  const storeConfig = bundleStoreFor(project, 'knowledge-tab-dom-seed')
  const published = publishBundleForTest(storeConfig, seededBundleInput())
  if (published.kind !== 'published') return { id: '', outcome: published.kind }
  await rebuildIndex({ knowledgeRoot: storeConfig.knowledgeRoot })
  return { id: String(published.id), outcome: 'published' }
}

// ── The two worlds 407-17 adds: a fact curated AFTER the run, and one unreadable bundle ──────────

/**
 * The summary the after-run record carries — a DIFFERENT control from the seed's.
 *
 * A second bundle at the same discriminant would be `already-exists`, and a second bundle whose
 * anchors the fixture page resolves would change what the RUN served — which is (b1)/(b2)'s
 * subject. `Dismiss` is neither: a record the store holds, attributable to this run, that nothing
 * in the already-finished run ever asked for.
 */
const AFTER_RUN_SUMMARY = 'The Dismiss control closes the notice after acknowledgement.'

/** The lease the after-run publish takes, and the curation job it names. */
const AFTER_RUN_LEASE = 'knowledge-tab-dom-after-run'

/**
 * The unreadable bundle directory, named to sort FIRST inside `bundles/`.
 *
 * `enumerateMaintenanceBundleDirs` sorts by name, so an `aaa-` prefix puts the throw at the very
 * front of the maintenance walk — the harshest ordering for the per-bundle skip 407-14 added, and
 * the one that would have failed loudest before it.
 */
const MALFORMED_BUNDLE_DIR = 'aaa-malformed-0000000000000000'

/** The store handle both writers below take, differing only in the lease they hold. */
function bundleStoreFor(
  project: { readonly root: string; readonly agentQaRoot: string },
  writerLeaseId: string,
): BundleStoreConfig {
  return {
    knowledgeRoot: join(project.root, 'agent-qa-knowledge'),
    productKey: POPULATED_TARGET_NAME,
    writerLeaseId,
  }
}

/**
 * A bundle born at the run's OWN build ordinal, linked to the run, carrying no outcome events.
 *
 * THIS IS THE COMMONEST CURATION OUTCOME, and every value here is chosen to make it one. `diffSince`
 * synthesises an `added` change when a bundle's earliest ordinal is GREATER than the since-ordinal
 * it was asked about; the op asks `max(0, buildOrdinal - 1)`, so a record created at the run's own
 * ordinal is inside the window by exactly one. `initialEvents: []` is what makes the earliest
 * ordinal the manifest's `createdAtOrdinal` rather than a confirming event's — a record that was
 * merely BORN, which is the shape 407-04 stamps `sourceRunId` onto and 407-15 finally paints.
 */
function afterRunBundleInput(
  runId: string,
  testId: string,
  buildOrdinal: number,
): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [
      { t: 'el', role: 'button', name: 'Dismiss', ordinal: 0 },
      { t: 'page', route: '/' },
      { t: 'selector', literal: '[data-testid="dismiss"]' },
    ],
    scope: { tier: 'product', key: POPULATED_TARGET_NAME },
    summary: AFTER_RUN_SUMMARY,
    body: 'The Dismiss control was resolved and verified on the notice page.',
    distilledEvidenceRef: {
      id: 'knowledge-tab-dom-after-run-evidence',
      sha: 'c'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name: 'Dismiss' },
  }
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'dismiss-click', ordinal: 0 },
    platform: 'web',
    element: { naturalKey: 'button:dismiss:0' },
    locator: { selector: '[data-testid="dismiss"]' },
    observedAtOrdinal: buildOrdinal,
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal: buildOrdinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId,
      testId,
      stepIndex: 0,
      curationJobId: AFTER_RUN_LEASE,
      sourceBuildOrdinal: buildOrdinal,
    },
    artifacts: [],
    evidenceMarkdown: 'Deterministically observed while dismissing the notice.\n',
    distilledObservations: [observation],
  }
}

/**
 * Publish the after-run record into a store a dashboard is already serving.
 *
 * NO INDEX REBUILD, deliberately. The Learned half is fed by the change walk, which reads bundle
 * DIRECTORIES; refreshing the index would additionally change what RETRIEVAL would answer, and
 * this record must be invisible to the run's already-recorded serve while being visible to the
 * change walk. The seeded fixture's single rebuild call is therefore the only one in this file.
 */
function publishAfterRun(
  project: { readonly root: string; readonly agentQaRoot: string },
  runId: string,
  testId: string,
  buildOrdinal: number,
): { readonly id: string; readonly outcome: string } {
  const published = publishBundleForTest(
    bundleStoreFor(project, AFTER_RUN_LEASE),
    afterRunBundleInput(runId, testId, buildOrdinal),
  )
  if (published.kind !== 'published') return { id: '', outcome: published.kind }
  return { id: String(published.id), outcome: 'published' }
}

/**
 * Plant ONE bundle directory the maintenance walk cannot load, beside the healthy ones.
 *
 * A directory whose `manifest.json` is not JSON is a `bundle-load` throw out of
 * `loadMaintenanceBundle` — the exact shape 407-14's per-bundle skip and by-name fold were built
 * for. It is planted LAST in the drive, because from this point every read of this store is a
 * degraded one.
 */
function plantMalformedBundle(project: { readonly root: string }): string {
  const dir = join(
    project.root,
    'agent-qa-knowledge',
    'memory',
    POPULATED_TARGET_NAME,
    'bundles',
    MALFORMED_BUNDLE_DIR,
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), '{ not json', 'utf8')
  return dir
}

// ── The FIFTH world 407-25 adds: a chain that failed over a row the store really served ─────────

/** The lease the attribution plant takes, and the curation job its event names. */
const ATTRIBUTED_FAILED_LEASE = 'knowledge-tab-dom-attributed-failed'

/** One served canary line, addressed the way the projection recorded it. */
interface ServedCanaryTuple {
  readonly candidateId: string
  readonly testId: string
  readonly testIndex: number
  readonly stepIndex: number
}

/** What the two plants of the `attributed-failed` world did, reported rather than asserted on. */
interface AttributedFailure {
  readonly tuple?: ServedCanaryTuple
  readonly plantedObservationId: string
  /** `appendOutcomeEvent`'s own verdict — `appended`, `duplicate`, `not-found`. */
  readonly appendOutcome: string
  /** How many `jobs` rows the curation plant's UPDATE actually changed. Exactly 1 is the claim. */
  readonly jobRowsUpdated: number
  readonly projection?: RunKnowledgeProjection
  readonly projectionStatus?: number
  readonly projectionBody?: string
  readonly visit?: PageObservation
}

/**
 * The served canary tuple THIS RUN recorded, read off a projection rather than guessed.
 *
 * The op builds its tuples from channel-1 lines with `servedAsCanary` set, taking the line's own
 * id as the candidate id and `testId` / `testIndex` / `stepIndex` off the handoff document
 * (`runs-knowledge.ts`). Every one of those fields also rides on the projection, so the plant can
 * be ADDRESSED off the recorded reading instead of reconstructed from fixture knowledge — which is
 * what makes the planted observation id the one the reader will recompute rather than a lookalike.
 *
 * The reading is taken from the FIRST recorded `ready` projection that carries such a line. The
 * served tuple is a fact about the finished RUN, identical in every world here, and the earliest
 * reading is the one taken before any plant touched the store.
 */
function servedCanaryTupleOf(
  ...projections: readonly (RunKnowledgeProjection | undefined)[]
): ServedCanaryTuple | undefined {
  for (const projection of projections) {
    if (projection?.kind !== 'ready') continue
    for (const step of projection.steps) {
      const line = step.served.channel1.find((candidate) => candidate.servedAsCanary)
      if (line === undefined) continue
      return {
        candidateId: String(line.id),
        testId: step.testId,
        testIndex: step.testIndex,
        stepIndex: step.stepIndex,
      }
    }
  }
  return undefined
}

/**
 * Append ONE real attributing outcome event onto the bundle the run served as a canary.
 *
 * THROUGH `appendOutcomeEvent`, NEVER A RAW FILE APPEND (T-407-25-01). That writer rewrites the
 * manifest hash for the outcomes log, so the bundle stays integrity-clean and the maintenance walk
 * still LOADS it. A line appended straight to `outcomes.jsonl` would fail the integrity arm, the
 * walk would SKIP the bundle, and the plant would produce no row at all while the agreement below
 * passed over an empty set.
 *
 * The event's `observationId` is recomputed with the reader's own derivation, so the walk finds it.
 */
function plantCanaryAttribution(
  project: { readonly root: string; readonly agentQaRoot: string },
  runId: string,
  buildOrdinal: number,
  tuple: ServedCanaryTuple,
): { readonly observationId: string; readonly outcome: string } {
  const observationId = canaryOutcomeObservationId({
    candidateId: asRecordId(tuple.candidateId),
    runId,
    testId: tuple.testId,
    testIndex: tuple.testIndex,
    stepIndex: tuple.stepIndex,
  })
  const appended = appendOutcomeEvent(
    bundleStoreFor(project, ATTRIBUTED_FAILED_LEASE),
    asRecordId(tuple.candidateId),
    BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: asEvidenceToken(ATTRIBUTED_FAILED_LEASE),
      curationJobId: ATTRIBUTED_FAILED_LEASE,
      buildOrdinal,
      observationId,
      origin: 'agent-verified',
    }),
  )
  return { observationId, outcome: appended.kind }
}

/**
 * Force this run's `curate-memory` row terminal-failed in the project's OWN queue database.
 *
 * ADDRESSED BY THE DERIVATION THE READER USES (T-407-25-02). `chainJobIdsForRun(runId,
 * DIGEST_JOB_ID_SOURCE).curateMemory` is the same expression `runs.postprocessing` evaluates to
 * find the row it projects, so the plant cannot address a row the read does not. Matching on
 * `kind = 'curate-memory'` would work today and hit a neighbouring run's row the moment a fixture
 * drives two.
 *
 * The row is opened WRITABLE with a busy timeout while the dashboard child is still serving; the
 * chip read (`post-processing-reader.ts`) opens the file read-only per request with no caching, so
 * the next page load and the next projection read both see this write.
 *
 * Returns the number of rows the UPDATE actually changed. Nought is the plant that addressed
 * nothing, and the cell asserts against it rather than letting the world read `done` and the
 * agreement pass for the wrong reason.
 */
function plantFailedCuration(
  project: { readonly agentQaRoot: string },
  runId: string,
): number {
  const path = join(project.agentQaRoot, 'agent-jobs.db')
  if (!existsSync(path)) return 0
  const db = new DatabaseSync(path, { timeout: 10_000 })
  try {
    const ids = chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE)
    const changed = db
      .prepare(
        "UPDATE jobs SET status = 'failed', claimed_at = NULL, updated_at = ?, "
        + "last_failure_kind = 'permanent', last_failure_reason = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), ATTRIBUTED_FAILED_LEASE, String(ids.curateMemory))
    return Number(changed.changes)
  } finally {
    db.close()
  }
}

// ── The SIXTH world 407-31 adds: a failed chain over records the door still serves ───────────────

/**
 * Read the five columns `plantFailedCuration` writes, for the row it addresses.
 *
 * THE SAME ADDRESS AND THE SAME DATABASE AS THE PLANT — `chainJobIdsForRun(runId,
 * DIGEST_JOB_ID_SOURCE).curateMemory` in the project's own `agent-jobs.db`, opened with the same
 * busy timeout and closed in a `finally`, because the dashboard child is still serving. Reading a
 * different row, or reading it a different way, would make the comparison below a comparison of
 * two readers rather than of two values.
 *
 * Answers nothing when the database or the row is absent, so the guard reds on a missing snapshot
 * rather than on a comparison against a fabricated default.
 */
function snapshotCurationJobRow(
  project: { readonly agentQaRoot: string },
  runId: string,
): CurationJobRow | undefined {
  const path = join(project.agentQaRoot, 'agent-jobs.db')
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { timeout: 10_000 })
  try {
    const ids = chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE)
    const row = db
      .prepare(
        'SELECT status, claimed_at, updated_at, last_failure_kind, last_failure_reason '
        + 'FROM jobs WHERE id = ?',
      )
      .get(String(ids.curateMemory)) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const text = (value: unknown): string | null => (value === null || value === undefined
      ? null
      : String(value))
    return {
      status: String(row['status']),
      claimedAt: text(row['claimed_at']),
      updatedAt: text(row['updated_at']),
      lastFailureKind: text(row['last_failure_kind']),
      lastFailureReason: text(row['last_failure_reason']),
    }
  } finally {
    db.close()
  }
}

/**
 * Put the five columns back exactly as {@link snapshotCurationJobRow} found them.
 *
 * WHY A REVERT AT ALL. The sixth world has to be planted BEFORE `plantMalformedBundle` — see
 * `driveLaterWorlds`' docstring — and the two worlds driven after it were recorded against a
 * `curate-memory` row reading `done`. Leaving this plant standing would silently rewrite both of
 * their readings and make round 4's census incomparable with round 3's.
 *
 * Returns the number of rows the UPDATE changed. Exactly one is the claim, and the guard asserts
 * it TOGETHER with a re-read of the five columns: a matched row is not a restored row.
 */
function restoreCurationJobRow(
  project: { readonly agentQaRoot: string },
  runId: string,
  snapshot: CurationJobRow,
): number {
  const path = join(project.agentQaRoot, 'agent-jobs.db')
  if (!existsSync(path)) return 0
  const db = new DatabaseSync(path, { timeout: 10_000 })
  try {
    const ids = chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE)
    const changed = db
      .prepare(
        'UPDATE jobs SET status = ?, claimed_at = ?, updated_at = ?, last_failure_kind = ?, '
        + 'last_failure_reason = ? WHERE id = ?',
      )
      .run(
        snapshot.status,
        snapshot.claimedAt,
        snapshot.updatedAt,
        snapshot.lastFailureKind,
        snapshot.lastFailureReason,
        String(ids.curateMemory),
      )
    return Number(changed.changes)
  } finally {
    db.close()
  }
}

/**
 * The five `jobs` columns `plantFailedCuration` writes, as they stood before it wrote them.
 *
 * FIVE, NOT ONE. The restore's honesty is a claim about every column the plant touched, and a
 * `changes === 1` from the UPDATE proves only that a row was MATCHED. `status` is the single
 * column any downstream reading discriminates, so a restore that put `status` back over a stale
 * `last_failure_reason` or a rewritten `updated_at` would satisfy every witness except a
 * comparison of the values themselves. That comparison is what this record exists for.
 */
interface CurationJobRow {
  readonly status: string
  readonly claimedAt: string | null
  readonly updatedAt: string | null
  readonly lastFailureKind: string | null
  readonly lastFailureReason: string | null
}

/** What the sixth world's snapshot-plant-restore did, reported rather than asserted on. */
interface FailedWithChanges {
  /** The five columns as found, before the plant. Absent when the row or the database was not there. */
  readonly snapshot?: CurationJobRow
  /** How many `jobs` rows the plant's UPDATE changed. Exactly 1 is the claim. */
  readonly jobRowsUpdated: number
  /** How many `jobs` rows the restore's UPDATE changed. Exactly 1 is the claim. */
  readonly jobRowsRestored: number
  /**
   * The same five columns re-read AFTER the restore, with the SAME reader that took the snapshot.
   *
   * The same reader, deliberately: a second reader could disagree with the first about what a
   * column IS — a `NULL` read as `''`, an integer read as a string — and the comparison would then
   * be green because two readings were wrong in the same direction.
   */
  readonly afterRestore?: CurationJobRow
  readonly projection?: RunKnowledgeProjection
  readonly projectionStatus?: number
  readonly projectionBody?: string
  readonly visit?: PageObservation
}

// ── What one page visit records ──────────────────────────────────────────────────────────────────

/** One served channel-1 line, as the expanded row painted it. */
interface ServedLineObservation {
  readonly recordId: string
  readonly traceState: string
  readonly servedAsCanary: string
  /**
   * `data-canary-outcome`, as the line stamped it — ABSENT when the attribute is absent (407-18).
   *
   * The component omits the attribute entirely on a line that was not served as a canary, and an
   * empty string here would be indistinguishable from an outcome it forgot to stamp. That
   * distinction is the whole subject of (c4)'s third agreement.
   */
  readonly canaryOutcome?: string
  /** The line's inline trace (`leg … · rank … · score …`, 427 D-19). Absent when there was none. */
  readonly whyText?: string
}

/** One default-view section's markup, read before Retrieval details was opened (427 SC2). */
interface DefaultSectionMarkup {
  readonly section: string
  readonly html: string
}

/** One Memory changes row as (c1)/(c4)/(c5) compare it: its bucket and its subject record id. */
interface LearnedRow {
  readonly bucket: string
  readonly id: string
}

/** Everything one run-detail visit recorded. */
interface PageObservation {
  readonly finalUrl: string
  readonly waitFailure?: string
  /** The response this browser visit actually rendered, independent of the preflight read. */
  readonly projection?: RunKnowledgeProjection
  readonly projectionStatus?: number
  readonly projectionBody?: string
  readonly projectionFailure?: string
  /** How many `[data-step-id]` rows the durable tree drew. */
  readonly treeStepCount: number
  /** `data-rung` on the header banner, or nothing when the header painted no banner. */
  readonly bannerRung?: string
  readonly bannerReason?: string
  readonly bannerText?: string
  /** `data-retrieval-class` on the header banner (427 D-20). */
  readonly bannerClass?: string
  /** The Knowledge used section's `[data-retrieval-statement]` class and tone (427 D-20). */
  readonly statementClass?: string
  readonly statementTone?: string
  /** How many `[data-doctor-pointer]` elements the page drew (427 D-23). */
  readonly doctorPointerCount: number
  /** `data-knowledge-state` after `7`. */
  readonly stateAfter7?: string
  /** Every `data-knowledge-section` in document order, read before Retrieval details was opened (427 SC1). */
  readonly sectionOrder: readonly string[]
  /** The Knowledge used section's `[data-section-absence]` sentence, when it printed one (427 D-02). */
  readonly usedAbsence?: string
  /** The Retrieval details root's `data-state` after the drive opened it (427 D-19). */
  readonly retrievalDetailsState?: string
  /** The used, effect and changes sections' outerHTML on the resting tab (427 SC2). */
  readonly defaultSections: readonly DefaultSectionMarkup[]
  /** Every `[data-row-primary]` text on the resting tab (427 SC2). */
  readonly rowPrimaries: readonly string[]
  /** Retrieval details' outerHTML with the served step row expanded (427 SC2). */
  readonly retrievalDetailsHtml?: string
  /** The `[data-used-summary]` sentence, as painted inside the opened Retrieval details. */
  readonly usedSummary?: string
  /** How many `[data-step-index]` rows the Used half drew. */
  readonly knowledgeStepCount: number
  /** Every `data-brief-lines` the Used half stamped, in document order. */
  readonly briefLineCounts: readonly string[]
  /** The muted no-brief sentence, when the first row painted one. */
  readonly firstRowNoBriefText?: string
  /** `data-learned-state` on the Learned half's root, when the half rendered. */
  readonly learnedState?: string
  /**
   * Every Memory changes row, in document order: the row's bucket (`data-record-change`, 427 D-15)
   * and the subject id Retrieval details lists for it at the same index (`dl[data-ledger-changes]`
   * → `[data-ledger-row="record"]`, 427 D-19). A row no longer carries its id; `?` is a side the
   * page did not paint.
   */
  readonly learnedRows: readonly LearnedRow[]
  /** `[data-learned-count-line]`, when the heading printed one. */
  readonly learnedCountLine?: string
  /** Every `[data-knowledge-section]` with the `[data-section-absence]` sentences inside it (427 SC1). */
  readonly sectionAbsences: readonly { readonly section: string; readonly absences: readonly string[] }[]
  /** `data-learned-read` on the Learned root. Absent IS the clean read — never an empty string. */
  readonly learnedRead?: string
  /** The `[data-learned-sentence]` prose, when the half printed one. */
  readonly learnedSentence?: string
  /**
   * The `[data-learned-chain-note]` prose, when the half printed one (407-27 · G-407-12).
   *
   * A NOTE BESIDE ROWS, never instead of them — absent is the half printing none, never an empty
   * string, exactly as `learnedSentence` is carried.
   */
  readonly learnedChainNote?: string
  /** The `[data-learned-read-note]` prose beside rows served over a partial read (407-18). */
  readonly learnedReadNote?: string
  /** The channel-1 lines of the first row the drive expanded. */
  readonly servedLines: readonly ServedLineObservation[]
  /** `data-knowledge-state` after `1` — absent is the tab having been left. */
  readonly stateAfterOverview?: string
  /** `data-knowledge-state` after `m` (D-02's re-pointed shortcut). */
  readonly stateAfterM?: string
  /** Every tab trigger label inside the artifact drawer, in document order (D-02's deletion). */
  readonly drawerTabLabels: readonly string[]
  /** The `curation` chip's own tag name, lower-cased. `button` is the D-01 click-through. */
  readonly curationChipTag?: string
  /** `data-knowledge-state` after the `curation` chip was pressed. */
  readonly stateAfterChip?: string
  readonly bodyText: string
}

/** Everything one fixture's drive measured, or the reason it could not. */
interface Recorded {
  drive?: PopulatedRunDrive
  projection?: RunKnowledgeProjection
  projectionStatus?: number
  projectionBody?: string
  visit?: PageObservation
  seed?: { readonly id: string; readonly outcome: string }
  /** What the store looked like after ONE more fact was curated against the finished run. */
  afterRun?: {
    readonly publishedId: string
    readonly publishOutcome: string
    readonly projection?: RunKnowledgeProjection
    readonly projectionBody?: string
    readonly visit?: PageObservation
  }
  /** What the same run reads like once one unreadable bundle sits beside the healthy ones. */
  malformed?: {
    readonly projection?: RunKnowledgeProjection
    readonly projectionStatus?: number
    readonly projectionBody?: string
    readonly visit?: PageObservation
  }
  /**
   * The world the 2026-08-30 owner ruling is ABOUT: a curation chain that fell over while the
   * store holds an outcome it really served (407-25, G-407-11).
   */
  attributedFailed?: AttributedFailure
  /**
   * The SIXTH world (407-31, G-407-12): a chain that fell over while the door still serves the
   * change records it had already committed — planted BEFORE the malformed bundle and reverted
   * behind itself. See `driveLaterWorlds`' docstring for why it cannot be driven anywhere else.
   */
  failedWithChanges?: FailedWithChanges
  /** The unbroken-token layout differential, measured in the browser both ways (407-25, G-407-2). */
  wrapProbe?: WrapProbe
  dashboardStderr?: string
  failure?: string
}

const scan: Recorded = {}
const served: Recorded = {}
/**
 * (a9)'s learned-nothing world, driven only when fixture A's own curation committed something
 * (assumption A4 false). Its one step is declared impossible by the planner, so the run resolves
 * no element and files no curation candidate: the chain settles having changed nothing, and D-24
 * records that as the all-zero snapshot (427-04).
 */
const quiet: Recorded = {}

/** A served all-zero curation snapshot — the recorded "learned nothing" fact (427 D-24). */
function allZeroSnapshot(projection: RunKnowledgeProjection | undefined): boolean {
  const snapshot = projection?.kind === 'ready' ? projection.learned.curationSnapshot : undefined
  return snapshot !== undefined
    && snapshot.rows.length === 0
    && CURATION_BREAKDOWN_BUCKETS.every((bucket) => snapshot.breakdown[bucket] === 0)
}

let browser: Browser | undefined
let browserPresent = false
const contexts: BrowserContext[] = []
const servers: FixtureServer[] = []
const dashboards: SpawnedDashboard[] = []
let stubServer: StubModelServer | undefined
let quietStubServer: StubModelServer | undefined

/** The context every failure message carries, for one fixture. */
function context(label: string, recorded: Recorded): string {
  const projection = recorded.projection
  return [
    '',
    `fixture: ${label}`,
    `chromium present: ${String(browserPresent)}`,
    `seed: ${recorded.seed === undefined ? '(not seeded)' : `${recorded.seed.outcome} ${recorded.seed.id}`}`,
    `run finished: ${String(recorded.drive?.finished ?? false)}; last type: ${recorded.drive?.lastType ?? '(none)'}`,
    `projection status: ${String(recorded.projectionStatus ?? 0)}; kind: ${projection?.kind ?? '(none)'}`,
    `projection: ${(recorded.projectionBody ?? '').slice(0, 1_400)}`,
    `visit url: ${recorded.visit?.finalUrl ?? '(never opened)'}`,
    `visit wait failure: ${recorded.visit?.waitFailure?.split('\n')[0] ?? '(none)'}`,
    `browser projection status: ${String(recorded.visit?.projectionStatus ?? 0)}; `
    + `kind: ${recorded.visit?.projection?.kind ?? '(none)'}`,
    `browser projection: ${(recorded.visit?.projectionBody ?? '').slice(0, 1_400)}`,
    `browser projection failure: ${recorded.visit?.projectionFailure ?? '(none)'}`,
    `banner: rung=${recorded.visit?.bannerRung ?? '(absent)'} `
    + `reason=${recorded.visit?.bannerReason ?? '(absent)'} `
    + `text=${JSON.stringify(recorded.visit?.bannerText ?? null)}`,
    `knowledge state: 7=${recorded.visit?.stateAfter7 ?? '(none)'} `
    + `overview=${recorded.visit?.stateAfterOverview ?? '(unmounted)'} `
    + `m=${recorded.visit?.stateAfterM ?? '(none)'} `
    + `chip=${recorded.visit?.stateAfterChip ?? '(none)'}`,
    `sections: ${(recorded.visit?.sectionOrder ?? []).join(', ') || '(none)'}; `
    + `used absence: ${JSON.stringify(recorded.visit?.usedAbsence ?? null)}; `
    + `retrieval details: ${recorded.visit?.retrievalDetailsState ?? '(absent)'}`,
    `used summary: ${JSON.stringify(recorded.visit?.usedSummary ?? null)}`,
    `knowledge step rows: ${String(recorded.visit?.knowledgeStepCount ?? 0)}; `
    + `brief-line counts: ${(recorded.visit?.briefLineCounts ?? []).join(', ') || '(none)'}`,
    `learned state: ${recorded.visit?.learnedState ?? '(absent)'}; `
    + `read=${recorded.visit?.learnedRead ?? '(clean)'}; `
    + `rows=${JSON.stringify(recorded.visit?.learnedRows ?? [])}; `
    + `sentence=${JSON.stringify(recorded.visit?.learnedSentence ?? null)}`,
    `after-run: ${recorded.afterRun === undefined
      ? '(not published)'
      : `${recorded.afterRun.publishOutcome} ${recorded.afterRun.publishedId}`}; `
    + `kind=${recorded.afterRun?.projection?.kind ?? '(none)'}; `
    + `state=${recorded.afterRun?.visit?.learnedState ?? '(absent)'}; `
    + `rows=${JSON.stringify(recorded.afterRun?.visit?.learnedRows ?? [])}; `
    + `sentence=${JSON.stringify(recorded.afterRun?.visit?.learnedSentence ?? null)}`,
    `after-run projection: ${(recorded.afterRun?.projectionBody ?? '').slice(0, 1_400)}`,
    `malformed: status=${String(recorded.malformed?.projectionStatus ?? 0)}; `
    + `kind=${recorded.malformed?.projection?.kind ?? '(none)'}; `
    + `state7=${recorded.malformed?.visit?.stateAfter7 ?? '(none)'}; `
    + `steps=${String(recorded.malformed?.visit?.knowledgeStepCount ?? 0)}; `
    + `read=${recorded.malformed?.visit?.learnedRead ?? '(clean)'}; `
    + `rows=${JSON.stringify(recorded.malformed?.visit?.learnedRows ?? [])}; `
    + `sentence=${JSON.stringify(recorded.malformed?.visit?.learnedSentence ?? null)}`,
    `malformed projection: ${(recorded.malformed?.projectionBody ?? '').slice(0, 1_400)}`,
    // THE PLANTS REPORT THEMSELVES IN THE FIRST FAILURE MESSAGE A READER SEES. A plant that
    // quietly did nothing — an append the integrity arm refused, an UPDATE that addressed no row —
    // must be visible here rather than diagnosed afterwards from a green-looking empty set.
    `attributed-failed: planted=${recorded.attributedFailed?.plantedObservationId ?? '(not planted)'}; `
    + `append=${recorded.attributedFailed?.appendOutcome ?? '(none)'}; `
    + `job rows updated=${String(recorded.attributedFailed?.jobRowsUpdated ?? 0)}; `
    + `tuple=${JSON.stringify(recorded.attributedFailed?.tuple ?? null)}; `
    + `status=${String(recorded.attributedFailed?.projectionStatus ?? 0)}; `
    + `kind=${recorded.attributedFailed?.projection?.kind ?? '(none)'}; `
    + `state=${recorded.attributedFailed?.visit?.learnedState ?? '(absent)'}; `
    + `rows=${JSON.stringify(recorded.attributedFailed?.visit?.learnedRows ?? [])}; `
    + `lines=${JSON.stringify(recorded.attributedFailed?.visit?.servedLines ?? [])}`,
    `attributed-failed projection: ${(recorded.attributedFailed?.projectionBody ?? '').slice(0, 1_400)}`,
    // THE SIXTH WORLD REPORTS ITS PLANT *AND* ITS REVERT. Both row counts and both column
    // readings are here, so a plant that addressed nothing and a restore that put back four
    // columns of five are each visible in the first failure message rather than diagnosed
    // afterwards from a world that looks green.
    `failed-with-changes: job rows updated=${String(recorded.failedWithChanges?.jobRowsUpdated ?? 0)}; `
    + `restored=${String(recorded.failedWithChanges?.jobRowsRestored ?? 0)}; `
    + `snapshot=${JSON.stringify(recorded.failedWithChanges?.snapshot ?? null)}; `
    + `after restore=${JSON.stringify(recorded.failedWithChanges?.afterRestore ?? null)}; `
    + `status=${String(recorded.failedWithChanges?.projectionStatus ?? 0)}; `
    + `kind=${recorded.failedWithChanges?.projection?.kind ?? '(none)'}; `
    + `state=${recorded.failedWithChanges?.visit?.learnedState ?? '(absent)'}; `
    + `read=${recorded.failedWithChanges?.visit?.learnedRead ?? '(clean)'}; `
    + `rows=${JSON.stringify(recorded.failedWithChanges?.visit?.learnedRows ?? [])}; `
    + `chain note=${JSON.stringify(recorded.failedWithChanges?.visit?.learnedChainNote ?? null)}`,
    `failed-with-changes projection: ${(recorded.failedWithChanges?.projectionBody ?? '').slice(0, 1_400)}`,
    `wrap probe: ${JSON.stringify(recorded.wrapProbe ?? null)}`,
    `served lines: ${JSON.stringify(recorded.visit?.servedLines ?? [])}`,
    `drawer tabs: ${(recorded.visit?.drawerTabLabels ?? []).join(', ') || '(none)'}`,
    `curation chip tag: ${recorded.visit?.curationChipTag ?? '(absent)'}`,
    `page text: ${JSON.stringify((recorded.visit?.bodyText ?? '').slice(0, 700))}`,
    recorded.failure === undefined ? '' : `drive failure: ${recorded.failure}`,
    `dashboard stderr: ${(recorded.dashboardStderr ?? '').slice(-1_200)}`,
  ].join('\n')
}

/** The recorded visit, asserted present so every cell below reads a real page. */
function visitOf(label: string, recorded: Recorded): PageObservation {
  expect(
    recorded.failure,
    `the ${label} measurement drive stopped early. ${BROWSER_INSTALL_INSTRUCTION}`
    + context(label, recorded),
  ).toBeUndefined()
  const observed = recorded.visit
  expect(
    observed,
    `the ${label} run-detail page was never observed. ${BROWSER_INSTALL_INSTRUCTION}`
    + context(label, recorded),
  ).toBeDefined()
  return observed as PageObservation
}

/** The browser's own response, narrowed to the `ready` arm the parity cells ask about. */
function readyProjection(
  label: string,
  recorded: Recorded,
): Extract<RunKnowledgeProjection, { kind: 'ready' }> {
  const visit = recorded.visit
  expect(
    visit?.projectionStatus,
    `the ${label} browser received no successful knowledge response.${context(label, recorded)}`,
  ).toBe(200)
  const projection = visit?.projection
  expect(
    projection?.kind,
    `the ${label} browser's knowledge read did not answer \`ready\`.${context(label, recorded)}`,
  ).toBe('ready')
  return projection as Extract<RunKnowledgeProjection, { kind: 'ready' }>
}

// ── The two view rules (c4) re-derives from the door's answer ────────────────────────────────────
//
// SPELLED ONCE EACH, NAMING THE FUNCTION THEY MIRROR. `packages/cli` cannot import dashboard-ui's
// lib, so an agreement cell has to restate the rule — and a restatement that drifts is worse than
// no cell at all. Both mirrors read their vocabulary out of `knowledge-view.ts` (the kinds) or
// spell its documented arm ORDER (the canary word), and both carry the source location so the two
// move together.

/**
 * How many brief lines a step was served, across ALL THREE channels.
 *
 * MIRRORS `servedLineCount` (`packages/dashboard-ui/src/lib/knowledge-view.ts:882`) and shares its
 * name deliberately: that function is what `stepRow` stamps `data-brief-lines` from, and
 * `data-brief-lines` is the attribute this file's own harvest picks the expanded row BY — the
 * first row whose value is greater than zero (`observeKnowledge`). Any mirror that derives the
 * expanded row differently can select a DIFFERENT step from the one the page actually expanded,
 * and then compare two unrelated things and call the result an agreement.
 *
 * THAT IS WHAT WAS WRONG (G-407-15 · REVIEW WR-03, round-2 WR-04 part 1). Two sites derived the
 * row as `channel1.length > 0` while the attribute sums three channels. A step serving only a
 * channel-2 read trace has `data-brief-lines="1"` and is what the harvest expands, while a
 * channel-1-only predicate skips past it to some later step.
 */
function servedLineCount(step: RunKnowledgeStep): number {
  return step.served.channel1.length + step.served.channel2.length + step.served.channel3.length
}

/**
 * Which arm the channel-1 mirrors take for this world — reported as a census column, not inferred.
 *
 * `non-empty` is the agreement as it has always been; `empty` is the arm where the selected step
 * served no channel-1 line and the mirror asserts an ABSENCE instead of a match. `(none)` is a
 * world whose read never answered `ready`.
 */
function channel1BranchOf(projection: RunKnowledgeProjection | undefined): string {
  if (projection?.kind !== 'ready') return '(none)'
  // THE HARVEST'S OWN RULE, spelled the way both mirrors spell it: the first step whose
  // `data-brief-lines` is greater than zero, else the first step.
  const expanded = projection.steps.find((step) => servedLineCount(step) > 0)
    ?? projection.steps[0]
  return (expanded?.served.channel1.length ?? 0) > 0 ? 'non-empty' : 'empty'
}

/**
 * The Memory changes rows the door's answer implies, as bucket and subject id (427 D-15).
 *
 * MIRRORS `changeDrafts` (`packages/dashboard-ui/src/lib/knowledge-view.ts`). With a snapshot the
 * rows ARE its rows in its order, a supersession led by its replacement, then one row per
 * since-then change of a published kind. Without one, `learned.changes` narrowed to
 * `LEARNED_CHANGE_KINDS` group per record in first-appearance order, a replacement's Add folds into
 * the supersession it completes, and the group takes the first `CURATION_BUCKET_PRECEDENCE` bucket.
 * It does NOT re-filter by run: `runs.knowledge` already did that join. This is the DOOR side of
 * the agreement; `PageObservation.learnedRows` is the PAGE side.
 */
function learnedRowsOf(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): readonly LearnedRow[] {
  const { curationSnapshot, sinceThen, changes } = projection.learned
  const kept = (list: readonly (typeof changes)[number][]) =>
    list.filter((change) => LEARNED_CHANGE_KINDS.includes(change.change))
  const subjectOf = (bucket: string, recordId: string, byRecordId: string | undefined) =>
    bucket === 'superseded' && byRecordId !== undefined ? byRecordId : recordId

  if (curationSnapshot !== undefined) {
    return [
      ...curationSnapshot.rows.map((row) => ({
        bucket: row.bucket,
        id: subjectOf(row.bucket, row.recordId, row.byRecordId),
      })),
      ...kept(sinceThen?.changes ?? []).map((change) => ({
        bucket: CHANGE_BUCKETS[change.change] ?? '?',
        id: subjectOf(change.change, change.recordId, change.byRecordId),
      })),
    ]
  }

  const victimOf = new Map<string, string>()
  for (const change of kept(changes)) {
    if (change.change === 'superseded' && change.byRecordId !== undefined) {
      victimOf.set(change.byRecordId, change.recordId)
    }
  }
  const groups = new Map<string, (typeof changes)[number][]>()
  for (const change of kept(changes)) {
    const id = change.change === 'added' ? victimOf.get(change.recordId) ?? change.recordId : change.recordId
    groups.set(id, [...(groups.get(id) ?? []), change])
  }
  return [...groups].map(([id, group]) => {
    const buckets = group.map((change) => CHANGE_BUCKETS[change.change] ?? '?')
    const bucket = CURATION_BUCKET_PRECEDENCE.find((word) => buckets.includes(word)) ?? buckets[0] ?? '?'
    const replacement = bucket === 'superseded'
      ? [...group].reverse().find((change) => change.change === 'superseded' && change.byRecordId !== undefined)?.byRecordId
      : undefined
    return { bucket, id: replacement ?? id }
  })
}

/**
 * The word a canary line must wear, re-derived from the projection.
 *
 * MIRRORS `canaryOutcomeWord` (`packages/dashboard-ui/src/lib/knowledge-view.ts`), rule for rule
 * and IN ITS ORDER, which is load-bearing. Three arms since 407-22 (owner ruling 2026-08-30, UAT
 * item 11) — the chain's word is consulted on the FIRST line and nowhere else:
 *   1. an unsettled chain reads `pending` — a partial read does not change that;
 *   2. a row that WAS read wins on EITHER settled arm, whatever else the scan could not reach: a
 *      chain that fell over cannot un-commit an outcome it already appended, and the chip beside
 *      the line is where the chain's fate is reported;
 *   3. with no row, the READ decides: `unknown` when partial, `not-attributed` when clean.
 */
function expectedCanaryWord(
  curationStatus: string,
  attribution: RunKnowledgeCanaryAttribution | undefined,
  scanIncomplete: boolean,
): string {
  if (curationStatus === 'pending' || curationStatus === 'running') return 'pending'
  if (attribution !== undefined) return attribution.outcome
  return scanIncomplete ? 'unknown' : 'not-attributed'
}

async function textOf(page: Page, selector: string): Promise<string | undefined> {
  const node = page.locator(selector).first()
  if ((await node.count()) === 0) return undefined
  return ((await node.textContent()) ?? '').trim()
}

async function attributeOf(page: Page, selector: string, name: string): Promise<string | undefined> {
  const node = page.locator(selector).first()
  if ((await node.count()) === 0) return undefined
  return (await node.getAttribute(name)) ?? undefined
}

/**
 * Open the collapsed Retrieval details section, where 427 D-19 moved the per-step ledger, and wait
 * for its root to read open. Records rather than throws, like every other wait in this file.
 */
async function openRetrievalDetails(page: Page): Promise<string | undefined> {
  const details = page.locator('[data-knowledge-section="retrieval-details"]').first()
  if ((await details.count()) === 0) return undefined
  await details.locator('[data-slot="collapsible-trigger"]').first().click().catch(() => undefined)
  await page
    .waitForFunction(
      () => document
        .querySelector('[data-knowledge-section="retrieval-details"] [data-slot="collapsible"]')
        ?.getAttribute('data-state') === 'open',
      undefined,
      { timeout: PAGE_BUDGET_MS },
    )
    .catch(() => undefined)
  return attributeOf(
    page,
    '[data-knowledge-section="retrieval-details"] [data-slot="collapsible"]',
    'data-state',
  )
}

/** Retrieval details' outerHTML as it stands, or nothing when the tab painted no such section. */
async function detailsMarkup(page: Page): Promise<string | undefined> {
  const details = page.locator('[data-knowledge-section="retrieval-details"]').first()
  if ((await details.count()) === 0) return undefined
  return details.evaluate((node) => node.outerHTML).catch(() => undefined)
}

/**
 * Open one run's detail page and harvest the whole Knowledge story a person can reach.
 *
 * THE TAB IS REACHED BY THE KEY A PERSON PRESSES rather than by a `?tab=` deep link: `7` is the
 * shortcut D-01 put on the seventh tab and a deep link would reach the same panel while skipping
 * the binding this file exists to measure.
 *
 * EVERY WAIT RECORDS RATHER THAN THROWS, and the harvest runs whatever happened — a drive that
 * threw would leave every cell reporting "the drive stopped early" and nothing about the page a
 * person would have been looking at.
 */
async function observeKnowledge(
  browserContext: BrowserContext,
  origin: string,
  runId: string,
): Promise<PageObservation> {
  const page: Page = await browserContext.newPage()
  let waitFailure: string | undefined
  const knowledgeUrl = `${origin}/api/runs/${encodeURIComponent(runId)}/knowledge`
  const knowledgeResponse: Promise<Pick<PageObservation,
    'projection' | 'projectionStatus' | 'projectionBody' | 'projectionFailure'>> = page
    .waitForResponse(
      (response) => response.url() === knowledgeUrl && response.request().method() === 'GET',
      { timeout: PAGE_BUDGET_MS },
    )
    .then(async (response) => {
      const body = await response.text()
      const parsed = RunKnowledgeProjectionSchema.safeParse(JSON.parse(body))
      return {
        projectionStatus: response.status(),
        projectionBody: body,
        ...(parsed.success ? { projection: parsed.data }
          : { projectionFailure: parsed.error.message }),
      }
    })
    .catch((error: unknown) => ({
      projectionFailure: error instanceof Error ? error.message : String(error),
    }))
  try {
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    await page.locator('[data-step-id]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch((error: unknown) => {
        waitFailure = error instanceof Error ? error.message : String(error)
      })

    const treeStepCount = await page.locator('[data-step-id]').count()

    // ── The tab, reached by its own key.
    //
    // AND THE HEADER IS READ AFTERWARDS, WHICH IS A MEASURED ORDERING RATHER THAN A PREFERENCE.
    // The banner and the tab are two renderings of ONE `runs.knowledge` read, and that read lands
    // strictly after the run-detail read the step tree waits on. Harvesting the header the moment
    // `[data-step-id]` attaches therefore reads it before the read that feeds it has answered —
    // which reds the banner cells under load and passes them on an idle machine. Waiting for the
    // tab to leave its `loading` state is waiting for that one read; the banner is painted in the
    // same commit, so both are then real.
    await page.keyboard.press('7')
    await page.locator('[data-knowledge-state]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-knowledge-state]')
          return node !== null && node.getAttribute('data-knowledge-state') !== 'loading'
        },
        undefined,
        { timeout: PAGE_BUDGET_MS },
      )
      .catch(() => undefined)

    const receivedKnowledge = await knowledgeResponse
    // The durable header banner: a run-detail header fact, not a Knowledge-tab one — a reader sees
    // it without pressing anything, and it stays painted on every tab.
    const bannerRung = await attributeOf(page, '[data-rung-banner]', 'data-rung')
    const bannerReason = await attributeOf(page, '[data-rung-banner]', 'data-rung-reason')
    const bannerText = await textOf(page, '[data-rung-banner]')
    const bannerClass = await attributeOf(page, '[data-rung-banner]', 'data-retrieval-class')
    const statementClass = await attributeOf(
      page,
      '[data-knowledge-section="used"] [data-retrieval-statement]',
      'data-retrieval-class',
    )
    const statementTone = await attributeOf(
      page,
      '[data-knowledge-section="used"] [data-retrieval-statement]',
      'data-retrieval-tone',
    )
    const doctorPointerCount = await page.locator('[data-doctor-pointer]').count()

    const stateAfter7 = await attributeOf(page, '[data-knowledge-state]', 'data-knowledge-state')
    // THE ORDER IS READ ON THE RESTING TAB, then the ledger is opened: 427 D-19 put the per-step
    // rows behind a collapsed Retrieval details, and every harvest below reads them from there.
    const sectionOrder = await page.locator('[data-knowledge-section]').evaluateAll(
      (sections) => sections.map((section) => section.getAttribute('data-knowledge-section') ?? '?'),
    )
    const usedAbsence = await textOf(page, '[data-knowledge-section="used"] [data-section-absence]')
    const sectionAbsences = await page.locator('[data-knowledge-section]').evaluateAll(
      (sections) => sections.map((section) => ({
        section: section.getAttribute('data-knowledge-section') ?? '?',
        absences: Array.from(section.querySelectorAll('[data-section-absence]'))
          .map((node) => (node.textContent ?? '').trim()),
      })),
    )
    const learnedCountLine = await textOf(page, '[data-learned-count-line]')
    // SC2 is read on the RESTING tab: what the three default sections carry before anything opens.
    const defaultSections: DefaultSectionMarkup[] = await page.locator('[data-knowledge-section]').evaluateAll(
      (sections) => sections
        .filter((section) => ['used', 'effect', 'changes'].includes(section.getAttribute('data-knowledge-section') ?? ''))
        .map((section) => ({ section: section.getAttribute('data-knowledge-section') ?? '?', html: section.outerHTML })),
    )
    const rowPrimaries = await page.locator('[data-row-primary]').evaluateAll(
      (nodes) => nodes.map((node) => (node.textContent ?? '').trim()),
    )
    const retrievalDetailsState = await openRetrievalDetails(page)
    const usedSummary = await textOf(page, '[data-used-summary]')
    const knowledgeStepCount = await page.locator('[data-step-index]').count()
    const briefLineCounts = await page.locator('[data-step-index]').evaluateAll(
      (rows) => rows.map((row) => row.getAttribute('data-brief-lines') ?? '?'),
    )
    const firstRowNoBriefText = await textOf(
      page,
      `[data-step-index] >> text=${STEP_NO_BRIEF_TEXT}`,
    ).catch(() => undefined)
    const learnedState = await attributeOf(page, '[data-learned-state]', 'data-learned-state')
    const learnedRead = await attributeOf(page, '[data-learned-state]', 'data-learned-read')
    const learnedSentence = await textOf(page, '[data-learned-sentence]')
    const learnedChainNote = await textOf(page, '[data-learned-chain-note]')
    const learnedReadNote = await textOf(page, '[data-learned-read-note]')
    // ATTRIBUTE-ADDRESSED, NOT TEXT-ADDRESSED (427 D-15/D-19). A row's bucket is its
    // `data-record-change`; its id is no longer on the row but in the opened Retrieval details, one
    // `dl[data-ledger-changes]` per row in the same order, subject id first.
    const learnedBuckets = await page
      .locator('[data-learned-state] li[data-record-change]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-record-change') ?? '?'))
    const ledgerIds = await page
      .locator('[data-knowledge-section="retrieval-details"] dl[data-ledger-changes]')
      .evaluateAll((blocks) => blocks.map((block) =>
        (block.querySelector('[data-ledger-row="record"] > *')?.textContent ?? '?').trim()))
    const learnedRows: LearnedRow[] = Array.from(
      { length: Math.max(learnedBuckets.length, ledgerIds.length) },
      (_, index) => ({ bucket: learnedBuckets[index] ?? '?', id: ledgerIds[index] ?? '?' }),
    )

    // ── One expanded row, and the inline why-trace inside it. The row that served something is chosen by
    // the attribute the panel stamped, so a fixture that served nothing expands its first row and
    // records an empty channel rather than hunting for one that does not exist.
    const servedLines: ServedLineObservation[] = []
    let retrievalDetailsHtml: string | undefined
    const rows = page.locator('[data-step-index]')
    const rowCount = await rows.count()
    let target = -1
    for (let index = 0; index < rowCount; index += 1) {
      const count = await rows.nth(index).getAttribute('data-brief-lines')
      if (count !== null && Number(count) > 0) { target = index; break }
    }
    if (target === -1 && rowCount > 0) target = 0
    if (target >= 0) {
      const row = rows.nth(target)
      await row.locator('button').first().click().catch(() => undefined)
      await row.locator('[data-step-detail]').first()
        .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
        .catch(() => undefined)
      const lines = row.locator('li[data-served-channel="1"]')
      const lineCount = await lines.count()
      for (let index = 0; index < lineCount; index += 1) {
        const line = lines.nth(index)
        const harvested = await line.evaluate((element) => ({
          traceState: element.getAttribute('data-trace-state') ?? '?',
          servedAsCanary: element.getAttribute('data-served-as-canary') ?? '?',
          // `null` here is the attribute being ABSENT, which is the clean answer for a
          // non-canary line; it is carried through as an absent key, never as an empty string.
          canaryOutcome: element.getAttribute('data-canary-outcome'),
          // The mono paragraphs inside the line: the first is the record id, and the trace answer
          // is the one that starts `leg ` — inline since 427 D-19, with no disclosure to open.
          monoText: Array.from(element.querySelectorAll('p.font-mono'))
            .map((node) => (node.textContent ?? '').trim())
            .filter((text) => text !== ''),
        }))
        const whyText = harvested.monoText.find((text) => text.startsWith('leg '))
        servedLines.push({
          recordId: harvested.monoText[0] ?? '',
          traceState: harvested.traceState,
          servedAsCanary: harvested.servedAsCanary,
          ...(harvested.canaryOutcome === null
            ? {}
            : { canaryOutcome: harvested.canaryOutcome }),
          ...(whyText === undefined ? {} : { whyText }),
        })
      }
      retrievalDetailsHtml = await detailsMarkup(page)
      // The row is collapsed again so the later shortcut legs read a page in its resting shape.
      await row.locator('button').first().click().catch(() => undefined)
    }
    if (retrievalDetailsHtml === undefined) retrievalDetailsHtml = await detailsMarkup(page)

    // ── D-02's re-pointed `m`. The tab is left first, so "still on knowledge" cannot pass for
    // "the key brought us back".
    await page.keyboard.press('1')
    await page.waitForTimeout(200)
    const stateAfterOverview = await attributeOf(
      page,
      '[data-knowledge-state]',
      'data-knowledge-state',
    )
    await page.keyboard.press('m')
    await page.locator('[data-knowledge-state]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    const stateAfterM = await attributeOf(page, '[data-knowledge-state]', 'data-knowledge-state')

    // ── D-01's click-through: the chip is a control, and pressing it lands on the tab.
    //
    // MEASURED BEFORE THE DRAWER LEG, and the order is load-bearing rather than tidy. Closing the
    // drawer with `Escape` runs the page's own escape shortcut, whose second arm CLEARS THE STEP
    // SELECTION — and with no step selected the detail pane renders its "select a step" placeholder
    // instead of any tab, so a chip click measured after the drawer would land on a page with no
    // tab panel at all and report an absence that has nothing to do with the chip.
    await page.keyboard.press('1')
    await page.waitForTimeout(200)
    const chip = page.locator('[data-chip="curation"]').first()
    const curationChipTag = (await chip.count()) === 0
      ? undefined
      : await chip.evaluate((element) => element.tagName.toLowerCase())
    if ((await chip.count()) > 0) await chip.click().catch(() => undefined)
    await page.locator('[data-knowledge-state]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    const stateAfterChip = await attributeOf(page, '[data-knowledge-state]', 'data-knowledge-state')

    // ── The artifact drawer, and what it no longer offers. Last, for the reason above.
    await page.keyboard.press('i')
    await page.locator('[data-slot="sheet-content"]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    const drawerTabLabels = await page
      .locator('[data-slot="sheet-content"] [data-slot="tabs-trigger"]')
      .evaluateAll((triggers) => triggers.map((trigger) => (trigger.textContent ?? '').trim()))
    await page.keyboard.press('Escape')
    await page.locator('[data-slot="sheet-content"]').first()
      .waitFor({ state: 'detached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)

    const bodyText = await page.evaluate(() => document.body.innerText)

    return {
      finalUrl: page.url(),
      ...receivedKnowledge,
      ...(waitFailure === undefined ? {} : { waitFailure }),
      treeStepCount,
      ...(bannerRung === undefined ? {} : { bannerRung }),
      ...(bannerReason === undefined ? {} : { bannerReason }),
      ...(bannerText === undefined ? {} : { bannerText }),
      ...(bannerClass === undefined ? {} : { bannerClass }),
      ...(statementClass === undefined ? {} : { statementClass }),
      ...(statementTone === undefined ? {} : { statementTone }),
      doctorPointerCount,
      ...(stateAfter7 === undefined ? {} : { stateAfter7 }),
      sectionOrder,
      ...(usedAbsence === undefined ? {} : { usedAbsence }),
      ...(retrievalDetailsState === undefined ? {} : { retrievalDetailsState }),
      defaultSections,
      rowPrimaries,
      ...(retrievalDetailsHtml === undefined ? {} : { retrievalDetailsHtml }),
      ...(usedSummary === undefined ? {} : { usedSummary }),
      knowledgeStepCount,
      briefLineCounts,
      ...(firstRowNoBriefText === undefined ? {} : { firstRowNoBriefText }),
      ...(learnedState === undefined ? {} : { learnedState }),
      learnedRows,
      ...(learnedCountLine === undefined ? {} : { learnedCountLine }),
      sectionAbsences,
      ...(learnedRead === undefined ? {} : { learnedRead }),
      ...(learnedSentence === undefined ? {} : { learnedSentence }),
      ...(learnedChainNote === undefined ? {} : { learnedChainNote }),
      ...(learnedReadNote === undefined ? {} : { learnedReadNote }),
      servedLines,
      ...(stateAfterOverview === undefined ? {} : { stateAfterOverview }),
      ...(stateAfterM === undefined ? {} : { stateAfterM }),
      drawerTabLabels,
      ...(curationChipTag === undefined ? {} : { curationChipTag }),
      ...(stateAfterChip === undefined ? {} : { stateAfterChip }),
      bodyText,
    }
  } finally {
    await page.close()
  }
}

/** How long the post-run chain has to reach a terminal curation word before the page is read. */
const CHAIN_BUDGET_MS = 90_000

/**
 * Wait for the curation stage through the same spawned door before visiting the page.
 *
 * WHY IT WAITS RATHER THAN SNAPSHOTTING. `runFinished` arrives before the post-run chain drains,
 * so a projection read at that instant says `curation: pending` while the page — rendered seconds
 * later — paints `done`. This read is only a preflight: even `curation: done` can precede the
 * terminal notification and its counts. Page parity therefore uses the response captured from
 * that browser visit, while this earlier response remains available for fixture diagnostics.
 *
 * A budget that runs out keeps the last preflight reading for diagnostics. The page assertions
 * independently check the response that visit received and the DOM it rendered.
 */
async function readSettledProjection(
  origin: string,
  runId: string,
  recorded: Recorded,
): Promise<void> {
  const deadline = Date.now() + CHAIN_BUDGET_MS
  for (;;) {
    const response = await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/knowledge`)
    const body = await response.text()
    recorded.projectionStatus = response.status
    recorded.projectionBody = body
    if (response.status === 200) {
      const parsed = RunKnowledgeProjectionSchema.safeParse(JSON.parse(body))
      if (parsed.success) {
        recorded.projection = parsed.data
        const status = parsed.data.kind === 'ready' ? parsed.data.curation.status : 'complete'
        if (status === 'complete' || status === 'failed') return
      }
    }
    if (Date.now() >= deadline) return
    await new Promise<void>((tick) => { setTimeout(tick, 500) })
  }
}

/** Open a FRESH context and harvest the run-detail page again, tracked for teardown. */
async function freshVisit(origin: string, runId: string): Promise<PageObservation> {
  const browserContext = await (browser as Browser).newContext()
  contexts.push(browserContext)
  return observeKnowledge(browserContext, origin, runId)
}

// ── (c6): does an unbroken token FIT, measured in the browser, both ways (407-25, G-407-2) ───────

/** One pair of geometry readings, taken after a forced layout. */
interface WrapGeometry {
  readonly rowScrollWidth: number
  readonly rowClientWidth: number
  readonly summaryScrollWidth: number
  readonly summaryClientWidth: number
}

/** Everything the unbroken-token probe measured, or the reason it measured nothing. */
interface WrapProbe {
  readonly failure?: string
  /** The summary text the probe addressed the node BY, read off the projection. */
  readonly addressedBy: string
  /** The node's class list as found, before the utility was removed. */
  readonly classListBefore: string
  /** The class list after the probe put everything back. Must equal `classListBefore`. */
  readonly classListAfter: string
  readonly withUtility?: WrapGeometry
  readonly withoutUtility?: WrapGeometry
}

/** The break utility 407-23 shipped onto the brief-line summary span. */
const WRAP_UTILITY_CLASS = 'wrap-anywhere'

/** The pathological input the UAT measured: 120 identical characters, no break opportunity. */
const UNBROKEN_TOKEN = 'x'.repeat(120)

/**
 * Substitute an unbroken 120-character token into the served line's summary and measure the row,
 * with the break utility and then without it.
 *
 * WHAT THE SUBSTITUTION IS. A real layout measurement of a real element, with its real classes, in
 * its real container, in the same built bundle a person installs.
 *
 * WHAT IT IS NOT. A claim that this fixture naturally produces such a token. It cannot: the seeded
 * summary is prose by design, and changing the fixture would move (b1)/(b2)'s subject. The question
 * this cell answers is content-INDEPENDENT — given this node, in this row, does an unbroken token
 * fit — so substituting the content is the honest way to ask it rather than a way to dodge it.
 *
 * BOTH HALVES ARE MEASURED BECAUSE ONLY THE PAIR IS EVIDENCE. A single reading showing no overrun
 * is equally consistent with "the fix works" and "this viewport happened to be wide enough". The
 * differential — same node, same viewport, same token, one class removed — is what pins the fix as
 * the cause of its own effect.
 *
 * THE NODE IS ADDRESSED BY ITS TEXT, never by position, following 407-23's `deepestWithText` idiom:
 * the deepest element inside the served line whose text is exactly the projection's own summary. A
 * positional selector would silently measure a neighbouring element if the row were rearranged.
 *
 * The probe restores the original text and class list before returning, and reports the class list
 * it read back so a failed restore is visible rather than inferred.
 */
async function probeUnbrokenTokenWrap(
  origin: string,
  runId: string,
  summaryText: string,
): Promise<WrapProbe> {
  const browserContext = await (browser as Browser).newContext()
  contexts.push(browserContext)
  const page: Page = await browserContext.newPage()
  try {
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    await page.locator('[data-step-id]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    // The same navigation (b1)/(b2) use — the key a person presses, not a `?tab=` deep link.
    await page.keyboard.press('7')
    await page.locator('[data-knowledge-state]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-knowledge-state]')
          return node !== null && node.getAttribute('data-knowledge-state') !== 'loading'
        },
        undefined,
        { timeout: PAGE_BUDGET_MS },
      )
      .catch(() => undefined)
    await openRetrievalDetails(page)

    const rows = page.locator('[data-step-index]')
    const rowCount = await rows.count()
    let target = -1
    for (let index = 0; index < rowCount; index += 1) {
      const count = await rows.nth(index).getAttribute('data-brief-lines')
      if (count !== null && Number(count) > 0) { target = index; break }
    }
    if (target === -1) {
      return {
        failure: 'no expanded row served a channel-1 line to measure',
        addressedBy: summaryText,
        classListBefore: '',
        classListAfter: '',
      }
    }
    const row = rows.nth(target)
    await row.locator('button').first().click().catch(() => undefined)
    await row.locator('[data-step-detail]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)
    await page.locator('li[data-served-channel="1"]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch(() => undefined)

    // ONE `page.evaluate`: four numbers, two forced layouts, and the restore, so nothing between
    // the two readings can move the box for any reason other than the class that was removed.
    return await page.evaluate(
      ({ summary, token, utility }) => {
        const line = document.querySelector('li[data-served-channel="1"]')
        if (line === null) {
          return {
            failure: 'the expanded row painted no `li[data-served-channel="1"]`',
            addressedBy: summary,
            classListBefore: '',
            classListAfter: '',
          }
        }
        // ADDRESSED BY TEXT, AND THE RULE IS CONTAINMENT (G-407-23 · REVIEW IN-05). The match that
        // contains no other match — DELIBERATELY the same rule 407-28 gave `deepestWithText` in
        // `knowledge-step-detail.test.tsx`, so the Chromium probe and the jsdom cell address "the
        // painted node" by one law. The old rule took the LAST match in document order, which
        // coincides with the deepest only while the subtree holds ONE match chain; a later SIBLING
        // subtree painting the same exact string is also "last", and the probe would then measure
        // an unrelated box and report it as the summary's geometry.
        const candidates = Array.from(line.querySelectorAll('*')).filter(
          (node) => (node.textContent ?? '').trim() === summary,
        )
        const node = candidates.find(
          (candidate) => !candidates.some(
            (other) => other !== candidate && candidate.contains(other),
          ),
        )
        if (node === undefined || !(node instanceof HTMLElement)) {
          return {
            failure: `no element inside the served line has text exactly \`${summary}\``,
            addressedBy: summary,
            classListBefore: '',
            classListAfter: '',
          }
        }
        const classListBefore = node.className
        const originalHtml = node.innerHTML

        const geometry = (): {
          rowScrollWidth: number
          rowClientWidth: number
          summaryScrollWidth: number
          summaryClientWidth: number
        } => ({
          rowScrollWidth: line.scrollWidth,
          rowClientWidth: line.clientWidth,
          summaryScrollWidth: node.scrollWidth,
          summaryClientWidth: node.clientWidth,
        })

        node.textContent = token
        // Forced synchronous layout before the reading, so the number is this token's, not the
        // previous frame's.
        void node.offsetWidth
        const withUtility = geometry()

        node.classList.remove(utility)
        void node.offsetWidth
        const withoutUtility = geometry()

        node.classList.add(utility)
        node.innerHTML = originalHtml
        void node.offsetWidth
        const classListAfter = node.className

        return { addressedBy: summary, classListBefore, classListAfter, withUtility, withoutUtility }
      },
      { summary: summaryText, token: UNBROKEN_TOKEN, utility: WRAP_UTILITY_CLASS },
    )
  } finally {
    await page.close()
  }
}

/**
 * The `.wrap-anywhere` rules the BUILT stylesheet carries, whole-rule, selector list included.
 *
 * KEYED ON SELECTOR PRESENCE IN THE DIST CSS, never on a bare declaration and never on one exact
 * minified rule body. `overflow-wrap:anywhere` ALREADY ships in that file today for the
 * arbitrary-value class `[overflow-wrap:anywhere]`, emitted at 13 sites across 7 files — so a
 * declaration grep is green before the fix and green after it and distinguishes nothing. And a
 * byte-exact grep for `.wrap-anywhere{overflow-wrap:anywhere}` would fail the day an emitter
 * grouped identical bodies into a selector list (`.foo,.wrap-anywhere{…}`) while the utility
 * worked perfectly — pushing a CORRECT implementation onto 407-23's contingency branch.
 */
function distCssRulesMatching(pattern: RegExp): readonly string[] {
  const assets = join(PACKAGES_ROOT, 'dashboard-ui', 'dist', 'assets')
  if (!existsSync(assets)) return []
  const rules: string[] = []
  for (const name of readdirSync(assets)) {
    if (!name.endsWith('.css')) continue
    const text = readFileSync(join(assets, name), 'utf8')
    for (const match of text.matchAll(/[^{}]*\{[^{}]*\}/g)) {
      if (pattern.test(match[0])) rules.push(match[0])
    }
  }
  return rules
}

/**
 * The two worlds that can only exist AFTER the first reading, in the only order they can be read.
 *
 * BOTH ARE MUTATIONS OF A STORE A DASHBOARD IS ALREADY SERVING, which is the point: the question
 * is not whether the op can project a store built this way, but whether the SHIPPED door answers
 * correctly when the store changes under it. The order is forced — the malformed plant makes every
 * subsequent read of this root a degraded one, so the after-run world has to be measured first or
 * not at all.
 *
 * THREE WORLDS SINCE 407-25, AND THE THIRD GOES LAST FOR THE SAME REASON THE SECOND DID.
 * `attributed-failed` plants a real attributing outcome event and forces this run's `curate-memory`
 * row terminal-failed, producing the shape the 2026-08-30 owner ruling is about: a chain that fell
 * over while the store holds a row it really served. Both of its plants run AFTER the malformed
 * visit BECAUSE the malformed world is the only world that currently paints the partial-read word,
 * and an attribution row planted before it would replace the `unknown` crossing round 2 fought for
 * on the built bundle. Reordering is forbidden.
 *
 * WHAT THE ORDERING DOES NOT BUY, SAID HERE SO NOBODY "FIXES" THE CENSUS BY MOVING THE PLANTS
 * EARLIER: the fifth world INHERITS `scanIncomplete: true`, and that is correct rather than a
 * contradiction. A SKIPPED BUNDLE IS PERMANENT FOR THIS ROOT. `attributingOutcomesByObservationId`
 * (`canary-attribution.ts`) counts a skip for the malformed directory on EVERY later walk of the
 * root — its own docstring says why, "a bundle that will not load has no readable manifest id, so
 * there is no honest way to decide it was irrelevant" — and `runs-knowledge.ts` raises the flag off
 * any non-zero skip count. So TWO census rows carry the flag from here on. Ordering preserves the
 * malformed world's RECORDED reading; it was never going to preserve the flag's exclusivity.
 *
 * AND THAT COSTS THE MEASUREMENT NOTHING, which is precisely why `(c5)` measures the ROW-WINS law
 * rather than the flag arm. In the fifth world the attribution row is PRESENT, so `canaryOutcomeWord`
 * decides on its second arm and never reaches the flag at all. The flag arm keeps its own untouched
 * witness in the malformed world, recorded before either plant ran.
 *
 * THE FIRST FIXTURE'S DRIVE IS UNTOUCHED. `knowledge-tab-dom-scan` never reaches here, so (a1)-(a7)
 * measure exactly the page they measured before.
 */
async function driveLaterWorlds(
  project: { readonly root: string; readonly agentQaRoot: string },
  origin: string,
  recorded: Recorded,
): Promise<void> {
  const settled = recorded.projection
  const ready = settled?.kind === 'ready' ? settled : undefined
  const runId = (recorded.drive as PopulatedRunDrive).runId
  // THE RUN'S OWN ORDINAL, read off the projection rather than assumed: the op asks `diffSince`
  // about `max(0, buildOrdinal - 1)`, so a record born at this number is inside the window by
  // exactly one whatever the fixture's counter reached.
  const buildOrdinal = ready?.buildOrdinal ?? SEED_ORDINAL
  const testId = ready?.steps[0]?.testId ?? 'test-knowledge-tab-dom-after-run'

  let published = publishAfterRun(project, runId, testId, buildOrdinal)
  if (published.outcome !== 'published') {
    // A lease the post-run curation chain still holds is the one refusal worth waiting out, and
    // waiting it out means letting the chain SETTLE rather than sleeping. Exactly ONE retry; the
    // outcome is reported verbatim by (c1) either way, and there is no skip arm.
    const settleAgain: Recorded = {}
    await readSettledProjection(origin, runId, settleAgain)
    published = publishAfterRun(project, runId, testId, buildOrdinal)
  }
  const afterRead: Recorded = {}
  await readSettledProjection(origin, runId, afterRead)
  const afterVisit = await freshVisit(origin, runId)
  recorded.afterRun = {
    publishedId: published.id,
    publishOutcome: published.outcome,
    ...(afterRead.projection === undefined ? {} : { projection: afterRead.projection }),
    ...(afterRead.projectionBody === undefined
      ? {}
      : { projectionBody: afterRead.projectionBody }),
    visit: afterVisit,
  }

  // ── THE SIXTH WORLD (407-31, G-407-12), HERE AND NOWHERE ELSE, AND UNDONE BEFORE THE NEXT LINE.
  //
  // IT CANNOT BE DRIVEN LATER. `plantMalformedBundle` below writes a bundle the maintenance walk
  // cannot load; `knowledgeRecordsDiffSpec` throws, `runs-knowledge.ts` catches `isScanIncomplete`
  // and publishes `changes: []`, and THE SKIP IS PERMANENT FOR THIS ROOT. Every world after that
  // line reads `changes: 0` — round 3's census records exactly that for `malformed` and for
  // `attributed-failed` — so a world that must hold a served change row beside a failed chain has
  // to be driven while the change-records read is still intact, which is here.
  //
  // THE EXISTING PLANTS MUST SEE THE STORE AS THEY SEE IT TODAY, which is why the jobs-table
  // change is undone rather than left standing. Nothing below this block is reordered and nothing
  // below it is given a different store: the plant is one UPDATE to one `jobs` row, and the row is
  // put back before `plantMalformedBundle` runs.
  //
  // AND THE REVERT IS PROVEN RATHER THAN TRUSTED. Two independent witnesses, in the guard and not
  // here: a re-read of the same five columns with the same reader, deep-equalled against the
  // snapshot; and the malformed world's own chain word, which still reads `done`. Nothing in this
  // block asserts — both row counts and both column readings are REPORTED, exactly as the fifth
  // world reports its append verdict, so a plant that did nothing or a restore that put back four
  // columns of five is named by the guard rather than swallowed by a passing agreement.
  const curationSnapshot = snapshotCurationJobRow(project, runId)
  const failedRowsUpdated = plantFailedCuration(project, runId)
  const failedRead: Recorded = {}
  await readSettledProjection(origin, runId, failedRead)
  const failedVisit = await freshVisit(origin, runId)
  const rowsRestored = curationSnapshot === undefined
    ? 0
    : restoreCurationJobRow(project, runId, curationSnapshot)
  const afterRestore = snapshotCurationJobRow(project, runId)
  recorded.failedWithChanges = {
    ...(curationSnapshot === undefined ? {} : { snapshot: curationSnapshot }),
    jobRowsUpdated: failedRowsUpdated,
    jobRowsRestored: rowsRestored,
    ...(afterRestore === undefined ? {} : { afterRestore }),
    ...(failedRead.projection === undefined ? {} : { projection: failedRead.projection }),
    ...(failedRead.projectionStatus === undefined
      ? {}
      : { projectionStatus: failedRead.projectionStatus }),
    ...(failedRead.projectionBody === undefined
      ? {}
      : { projectionBody: failedRead.projectionBody }),
    visit: failedVisit,
  }

  plantMalformedBundle(project)
  const malformedRead: Recorded = {}
  await readSettledProjection(origin, runId, malformedRead)
  const malformedVisit = await freshVisit(origin, runId)
  recorded.malformed = {
    ...(malformedRead.projection === undefined ? {} : { projection: malformedRead.projection }),
    ...(malformedRead.projectionStatus === undefined
      ? {}
      : { projectionStatus: malformedRead.projectionStatus }),
    ...(malformedRead.projectionBody === undefined
      ? {}
      : { projectionBody: malformedRead.projectionBody }),
    visit: malformedVisit,
  }

  // ── THE FIFTH WORLD, LAST. See this function's docstring for why the ordering is not negotiable
  // and why the flag it inherits is expected.
  await plantAttributedFailure(project, origin, runId, buildOrdinal, recorded)

  // ── AND THE LAYOUT DIFFERENTIAL AFTER EVERYTHING, on a page of its own. It mutates the DOM of a
  // page it then closes, so it can disturb no recorded reading — but it runs last anyway, because
  // "measured after every world was recorded" is a cheaper fact to check than "harmless".
  const summaryText = servedSummaryOf(
    recorded.projection,
    recorded.afterRun?.projection,
    recorded.malformed?.projection,
  )
  recorded.wrapProbe = summaryText === undefined
    ? {
        failure: 'no recorded projection carried a channel-1 summary to address the node by',
        addressedBy: '',
        classListBefore: '',
        classListAfter: '',
      }
    : await probeUnbrokenTokenWrap(origin, runId, summaryText)
}

/** The first channel-1 summary any recorded projection carried — the probe's addressing text. */
function servedSummaryOf(
  ...projections: readonly (RunKnowledgeProjection | undefined)[]
): string | undefined {
  for (const projection of projections) {
    if (projection?.kind !== 'ready') continue
    for (const step of projection.steps) {
      const line = step.served.channel1[0]
      if (line !== undefined) return line.summary
    }
  }
  return undefined
}

/**
 * Plant the world the ruling is about, and record what the shipped door then says about it.
 *
 * Nothing here asserts. Both plants report their own outcome — the append verdict verbatim, the
 * UPDATE's row count — and `(c4)`'s non-vacuity block is where a plant that did nothing reds.
 */
async function plantAttributedFailure(
  project: { readonly root: string; readonly agentQaRoot: string },
  origin: string,
  runId: string,
  buildOrdinal: number,
  recorded: Recorded,
): Promise<void> {
  const tuple = servedCanaryTupleOf(
    recorded.projection,
    recorded.afterRun?.projection,
    recorded.malformed?.projection,
  )
  const planted = tuple === undefined
    ? { observationId: '', outcome: '(no served canary tuple in any recorded projection)' }
    : plantCanaryAttribution(project, runId, buildOrdinal, tuple)
  const jobRowsUpdated = plantFailedCuration(project, runId)

  const read: Recorded = {}
  await readSettledProjection(origin, runId, read)
  const visit = await freshVisit(origin, runId)
  recorded.attributedFailed = {
    ...(tuple === undefined ? {} : { tuple }),
    plantedObservationId: planted.observationId,
    appendOutcome: planted.outcome,
    jobRowsUpdated,
    ...(read.projection === undefined ? {} : { projection: read.projection }),
    ...(read.projectionStatus === undefined ? {} : { projectionStatus: read.projectionStatus }),
    ...(read.projectionBody === undefined ? {} : { projectionBody: read.projectionBody }),
    visit,
  }
}

/** Drive ONE fixture end to end and record everything it produced. */
async function driveFixture(
  label: string,
  recorded: Recorded,
  seed: boolean,
  addresses: { readonly modelBaseUrl: string; readonly targetUrl: string },
): Promise<void> {
  const project = populatedRunFixtureProject(label, addresses)
  if (seed) {
    recorded.seed = await seedServedRecord(project)
  }

  const port = await reserveEphemeralPort()
  const dashboard = await spawnDashboard(
    project.root,
    project.configPath,
    port,
    60_000,
    populatedRunSpawnEnv(),
  )
  dashboards.push(dashboard)
  if (!dashboard.ready) {
    recorded.dashboardStderr = dashboard.stderr()
    recorded.failure = 'the spawned `agent-qa dashboard` never said it was listening'
    return
  }

  try {
    recorded.drive = await drivePopulatedRun(dashboard, project, RUN_BUDGET_MS)
    await readSettledProjection(dashboard.origin, recorded.drive.runId, recorded)
    const browserContext = await (browser as Browser).newContext()
    contexts.push(browserContext)
    recorded.visit = await observeKnowledge(
      browserContext,
      dashboard.origin,
      recorded.drive.runId,
    )
    if (seed) await driveLaterWorlds(project, dashboard.origin, recorded)
  } catch (error) {
    recorded.failure = error instanceof Error ? error.message : String(error)
  }
  recorded.dashboardStderr = dashboard.stderr()
  await dashboard.stop()
}

describePosix('the shipped dashboard renders the Knowledge tab and the rung banner', () => {
  beforeAll(async () => {
    try {
      browserPresent = existsSync(chromium.executablePath())
    } catch {
      browserPresent = false
    }

    // FIRST, AND BEFORE ANYTHING IS SPAWNED: a stale build measures the previous commit, and the
    // bundle these cells read is `dashboard-ui/dist`.
    const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
    if (freshness.missing.length > 0 || freshness.stale.length > 0) {
      const why = `${REBUILD_INSTRUCTION} missing: ${freshness.missing.join(', ') || '(none)'}; `
        + `stale: ${freshness.stale.join(', ') || '(none)'}`
      scan.failure = why
      served.failure = why
      return
    }

    try {
      browser = await chromium.launch({ headless: true })
    } catch (error) {
      const why = `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
        + `${error instanceof Error ? error.message : String(error)}`
      scan.failure = why
      served.failure = why
      return
    }

    const targetServer = await startTargetPageServer()
    servers.push(targetServer)
    stubServer = await startStubModelServer()
    const addresses = { modelBaseUrl: stubServer.baseUrl, targetUrl: targetServer.url }

    // SEQUENTIAL, NOT CONCURRENT. Each fixture drives a real Chromium inside a real run through a
    // real dashboard; two at once on one machine is the resource contention WINDOWS #309 recorded.
    await driveFixture('knowledge-tab-dom-scan', scan, false, addresses)
    await driveFixture('knowledge-tab-dom-served', served, true, addresses)
    if (!allZeroSnapshot(scan.visit?.projection)) {
      quietStubServer = await startStubModelServer({ plannerOutcome: 'stepFailed' })
      await driveFixture('knowledge-tab-dom-quiet', quiet, false, {
        modelBaseUrl: quietStubServer.baseUrl,
        targetUrl: targetServer.url,
      })
    }
  }, RUN_BUDGET_MS * 3 + 480_000)

  afterAll(async () => {
    for (const held of contexts) await held.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    for (const dashboard of dashboards) await dashboard.stop().catch(() => undefined)
    await stubServer?.close()
    await quietStubServer?.close()
    for (const server of servers) await server.close()
    cleanupTempRoots()
  })

  // ── (A) The empty knowledge root: the deterministic rung, and the Used half with nothing in it.

  it('(a1) the run\'s own `/api/runs/:id/knowledge` answers ready, bound, on the bundle-scan rung', () => {
    visitOf('scan', scan)
    const projection = readyProjection('scan', scan)
    expect(
      projection.knowledgeStore,
      'a project whose config names a knowledge dir that exists has a reader BOUND; `unbound` '
      + 'means the run served every step with no reader and recorded no rung, which would make '
      + `every claim below vacuous.${context('scan', scan)}`,
    ).toBe('bound')
    expect(
      projection.retrievalRung?.rung,
      'the populated fixture ships an EMPTY knowledge root with no index, and the fold reads the '
      + 'index axis first — so this run was served on `bundle-scan` whatever the host embedder '
      + `did. A different word here means the fixture gained an index or the fold moved.${context('scan', scan)}`,
    ).toBe('bundle-scan')
    expect(
      projection.retrievalRung?.reason,
      `the recorded cause for an index that was never built is \`index-not-built\`.${context('scan', scan)}`,
    ).toBe('index-not-built')
  })

  it('(a2) the run header paints no rung strip for a fresh index; the tab states it as information', () => {
    const observed = visitOf('scan', scan)
    const projection = readyProjection('scan', scan)
    const retrievalClass = retrievalClassOf(projection.retrievalRung?.reason)
    expect(
      retrievalClass,
      `an index that was never built reads as the fresh-index class.${context('scan', scan)}`,
    ).toBe('fresh-index')
    expect(RETRIEVAL_CLASS_TONES[retrievalClass]).toBe('info')
    expect(
      observed.bannerRung,
      'the run-detail header painted a `[data-rung-banner]` for a fresh store\'s bootstrap, which '
      + `is information and never a header warning (427 D-20).${context('scan', scan)}`,
    ).toBeUndefined()
    expect(
      observed.statementClass,
      'the Knowledge used section states no fresh-index retrieval level for a run served on '
      + `bundle-scan / index-not-built.${context('scan', scan)}`,
    ).toBe('fresh-index')
    expect(observed.statementTone, `the fresh-index statement is not info-toned.${context('scan', scan)}`)
      .toBe('info')
    expect(
      observed.doctorPointerCount,
      `an info-class statement carries a doctor pointer (427 D-23).${context('scan', scan)}`,
    ).toBe(0)
  })

  it('(a3) pressing `7` opens a ready Knowledge tab with one row per recorded step', () => {
    const observed = visitOf('scan', scan)
    const projection = readyProjection('scan', scan)
    expect(
      observed.stateAfter7,
      'pressing `7` did not land on a READY Knowledge tab. The tab is the seventh trigger and its '
      + `state attribute is the cell contract, never the visible text.${context('scan', scan)}`,
    ).toBe('ready')
    expect(
      observed.knowledgeStepCount,
      'the Used half drew a different number of `[data-step-index]` rows than the projection '
      + `carries steps — the row exists even when the step served nothing.${context('scan', scan)}`,
    ).toBe(projection.steps.length)
    expect(
      observed.briefLineCounts,
      'a run served out of an empty knowledge root served no brief line on any step, so every '
      + `row's \`data-brief-lines\` must read zero.${context('scan', scan)}`,
    ).toEqual(projection.steps.map(() => '0'))
  })

  it('(a4) the Knowledge used section states the published absence sentence for a run that served nothing', () => {
    const observed = visitOf('scan', scan)
    const projection = readyProjection('scan', scan)
    const servedTotal = projection.steps.reduce(
      (total, step) => total + step.served.channel1.length,
      0,
    )
    expect(
      servedTotal,
      `the empty-root fixture served a brief line, which makes this cell's subject wrong rather `
      + `than the page.${context('scan', scan)}`,
    ).toBe(0)
    // TWO DIFFERENT ABSENCES, AND THE PAGE MUST PICK THE RIGHT ONE. `NO_BRIEF_SERVED_TEXT` is for
    // a run with NO steps at all; a run whose steps all served nothing says the other sentence.
    // Both are read out of the module, so a rename reds here rather than silently passing.
    const expected = projection.steps.length === 0 ? NO_BRIEF_SERVED_TEXT : NO_BRIEF_LINES_TEXT
    expect(
      observed.usedAbsence,
      'the Knowledge used section\'s `[data-section-absence]` is not the published sentence for '
      + `this run (427 D-02).${context('scan', scan)}`,
    ).toBe(expected)
  })

  it('(a5) pressing `1` then `m` brings the Knowledge tab back', () => {
    const observed = visitOf('scan', scan)
    expect(
      observed.stateAfterOverview,
      'pressing `1` left the Knowledge content mounted, so "still on knowledge" cannot be told '
      + `apart from "the key brought us back".${context('scan', scan)}`,
    ).toBeUndefined()
    expect(
      observed.stateAfterM,
      'pressing `m` did not activate the Knowledge tab. The key is re-pointed, not retired: the '
      + `v1 memory drawer tab it used to open is deleted.${context('scan', scan)}`,
    ).toBe('ready')
  })

  it('(a6) the artifact drawer offers no memory tab', () => {
    const observed = visitOf('scan', scan)
    expect(
      observed.drawerTabLabels.length,
      `pressing \`i\` opened no artifact drawer with tabs in it.${context('scan', scan)}`,
    ).toBeGreaterThan(0)
    expect(
      observed.drawerTabLabels.map((label) => label.toLowerCase()),
      'the artifact drawer still offers a memory tab. 407-05 deleted the v1 drawer tab; a run\'s '
      + `memory story lives in the Knowledge tab now.${context('scan', scan)}`,
    ).not.toContain('memory')
  })

  it('(a7) the `curation` chip is a button and pressing it activates the Knowledge tab', () => {
    const observed = visitOf('scan', scan)
    expect(
      observed.curationChipTag,
      'the `curation` chip is not a `button`. D-01 makes it the one click-through into the '
      + `Knowledge tab, and a span is not a control.${context('scan', scan)}`,
    ).toBe('button')
    expect(
      observed.stateAfterChip,
      'pressing the `curation` chip did not activate the Knowledge tab. The click-through does '
      + `not depend on the chip's status.${context('scan', scan)}`,
    ).toBe('ready')
  })

  it('(a8) the tab paints its sections in the order the view publishes', () => {
    const observed = visitOf('scan', scan)
    expect(
      observed.sectionOrder,
      'the ready Knowledge tab did not paint its `[data-knowledge-section]` elements in the order '
      + `KNOWLEDGE_SECTIONS publishes (427 D-02).${context('scan', scan)}`,
    ).toEqual(publishedStringArray('KNOWLEDGE_SECTIONS'))
  })

  it('(a9) a run that used nothing and learned nothing states each absence', () => {
    // SC1 ON THE SHIPPED BINARY, OVER D-24's RECORDED FACT. A zero-effect curation publishes an
    // all-zero snapshot (427-04), so "learned nothing" is a recorded breakdown the page reads, not
    // a missing one it infers. Fixture A is the world expected to carry it (assumption A4); when its
    // chain committed something, the cell asserts on the quiet world, whose curation committed
    // nothing, and names which world it read. It never skips.
    visitOf('scan', scan)
    const scanSnapshot = scan.visit?.projection?.kind === 'ready'
      ? scan.visit.projection.learned.curationSnapshot ?? '(absent)'
      : '(no ready read)'
    const a4 = allZeroSnapshot(scan.visit?.projection)
    const label = a4 ? 'scan' : 'quiet'
    const recorded = a4 ? scan : quiet
    const seen = `\n(a9) assumption A4 ${a4 ? 'holds' : 'is false'}; fixture A's snapshot: `
      + `${JSON.stringify(scanSnapshot)}; asserted on: ${label}${context(label, recorded)}`

    const observed = visitOf(label, recorded)
    const ready = readyProjection(label, recorded)
    expect(
      allZeroSnapshot(ready),
      `the ${label} world's curation served no all-zero snapshot, so its learned-nothing state is `
      + `not the recorded fact D-24 publishes (427-04).${seen}`,
    ).toBe(true)
    expect(
      ready.steps.reduce((total, step) => total + servedLineCount(step), 0),
      `the ${label} world served a brief line, so it is not a run that used nothing.${seen}`,
    ).toBe(0)

    const absencesOf = (section: string): readonly string[] | undefined =>
      observed.sectionAbsences.find((entry) => entry.section === section)?.absences
    expect(absencesOf('used'), `Knowledge used did not state exactly its one absence.${seen}`)
      .toEqual([ready.steps.length === 0 ? NO_BRIEF_SERVED_TEXT : NO_BRIEF_LINES_TEXT])
    expect(absencesOf('effect'), `Effect on this run did not state exactly its one absence.${seen}`)
      .toEqual([EFFECT_NOTHING_USED_TEXT])
    expect(
      absencesOf('changes'),
      `Memory changes did not state exactly one absence, NO_MEMORY_CHANGES_SENTENCE.${seen}`,
    ).toEqual([NO_MEMORY_CHANGES_SENTENCE])
    expect(observed.learnedState, `the learned-nothing chain is not settled \`complete\`.${seen}`).toBe('complete')
    expect(
      observed.learnedCountLine,
      `the Memory changes count line does not read the all-zero breakdown's words.${seen}`,
    ).toBe(NO_MEMORY_CHANGES_TEXT)
    expect(observed.learnedRows, `a run that learned nothing painted Memory changes rows.${seen}`).toEqual([])
  })

  // ── (B) The seeded knowledge root: a served line, and the why-trace behind it.

  it('(b1) the seeded record is published and the run really served it on channel 1', () => {
    visitOf('served', served)
    expect(
      served.seed?.outcome,
      'the fixture bundle did not publish, so there was nothing for the run to be served. This is '
      + `a fixture fault, not a page fault.${context('served', served)}`,
    ).toBe('published')
    const projection = readyProjection('served', served)
    // DELIBERATELY NOT `servedLineCount` — and this is the one channel-1 predicate in the file
    // that must stay one. This cell's claim is that the run served a CHANNEL-1 line out of a root
    // holding one published record; summing the other two channels in would let a step whose only
    // brief line was a channel-2 read trace satisfy it, and the claim would stop being made.
    const servedSteps = projection.steps.filter((step) => step.served.channel1.length > 0)
    expect(
      servedSteps.length,
      'the run served NO channel-1 line out of a knowledge root holding one published record at '
      + 'the run\'s own product scope with a rebuilt index. Either the scope ladder did not reach '
      + 'the record (a fixture-scope fault) or the reader gate refused it (a product fault) — '
      + `read the projection below to tell which.${context('served', served)}`,
    ).toBeGreaterThan(0)
    expect(
      servedSteps.every((step) => step.trace.kind === 'answered'),
      'a step that served a channel-1 line recorded no serve-time trace, so the page has nothing '
      + `honest to answer "why this line?" with.${context('served', served)}`,
    ).toBe(true)
  })

  it('(b2) the expanded row paints the served line as answered, with the trace\'s own numbers', () => {
    const observed = visitOf('served', served)
    const projection = readyProjection('served', served)
    expect(
      observed.servedLines.length,
      'the expanded step row painted no `li[data-served-channel="1"]` for a step whose projection '
      + `carries served lines.${context('served', served)}`,
    ).toBeGreaterThan(0)

    const painted = observed.servedLines[0] as ServedLineObservation
    expect(
      painted.traceState,
      'the served line\'s `data-trace-state` is not `answered`, so the page is reporting an '
      + `absence for a line the run recorded a trace for.${context('served', served)}`,
    ).toBe('answered')

    // The expectation is COMPUTED from the trace the run recorded, never typed: the page must say
    // what serve time said, not what an index would say if asked again today (D-04).
    const step = projection.steps.find((candidate) =>
      candidate.served.channel1.some((line) => line.id === painted.recordId))
    expect(
      step,
      'the record id the page painted is in no step of the projection it read — the page and the '
      + `op disagree about what this run served.${context('served', served)}`,
    ).toBeDefined()
    const trace = (step as NonNullable<typeof step>).trace
    expect(
      trace.kind,
      `the step carrying the painted line recorded no trace.${context('served', served)}`,
    ).toBe('answered')
    const entry = trace.kind === 'answered'
      ? trace.trace.servedLines.find((line) => line.recordId === painted.recordId)
      : undefined
    expect(
      entry,
      'the recorded trace has no `servedLines` entry for the line the page painted as answered.'
      + context('served', served),
    ).toBeDefined()
    const answer = entry as NonNullable<typeof entry>
    expect(
      painted.whyText,
      'the served line did not print, inline, the leg, rank and score the serve-time trace '
      + `recorded for this record.${context('served', served)}`,
    ).toBe(traceLineText(answer.leg, answer.rank, answer.score))
  })

  it('(b7) the served record\'s id appears only inside Retrieval details', () => {
    const observed = visitOf('served', served)
    const projection = readyProjection('served', served)
    const servedId = projection.steps.flatMap((step) => step.served.channel1.map((line) => line.id))[0]
    expect(
      servedId,
      `the served run carried no channel-1 line, so there is no id to look for.${context('served', served)}`,
    ).toBeDefined()
    const id = servedId as string

    expect(
      observed.defaultSections.map((section) => section.section).sort(),
      `the resting tab did not paint the three default sections.${context('served', served)}`,
    ).toEqual(['changes', 'effect', 'used'])
    for (const section of observed.defaultSections) {
      expect(
        section.html.includes(id),
        `the ${section.section} section carries the served record id ${id} before Retrieval details `
        + `was opened — as text, a title or a data attribute.${context('served', served)}`,
      ).toBe(false)
    }
    expect(
      observed.rowPrimaries.length,
      `the resting tab painted no row primary text at all.${context('served', served)}`,
    ).toBeGreaterThan(0)
    expect(
      observed.rowPrimaries,
      `a default-view row leads with the served record id ${id}.${context('served', served)}`,
    ).not.toContain(id)
    expect(
      observed.retrievalDetailsHtml?.includes(id),
      `the opened Retrieval details does not carry the served record id ${id}.${context('served', served)}`,
    ).toBe(true)
  })

  it('(b3) the header banner is present exactly when the recorded rung\'s class tone is warning', () => {
    const observed = visitOf('served', served)
    const projection = readyProjection('served', served)
    const rung = projection.retrievalRung?.rung
    expect(
      rung,
      'the seeded run recorded no rung at all, so there is nothing for the header to agree or '
      + `disagree with.${context('served', served)}`,
    ).toBeDefined()
    if (rung === 'memidex') {
      // NO HOST ASSUMPTION IN EITHER DIRECTION. A machine with a native embedder and a rebuilt
      // index reaches the top rung, and the top rung is not a degradation — so the honest claim
      // is silence in the header and in the tab.
      expect(
        observed.bannerRung,
        'the run reached the top rung and the header still painted a rung strip.'
        + context('served', served),
      ).toBeUndefined()
      expect(
        observed.statementClass,
        `the run reached the top rung and the tab still stated a retrieval level.${context('served', served)}`,
      ).toBeUndefined()
      return
    }
    const retrievalClass = retrievalClassOf(projection.retrievalRung?.reason)
    const tone = RETRIEVAL_CLASS_TONES[retrievalClass]
    expect(
      observed.statementClass,
      `the tab's retrieval statement disagrees with the recorded rung's class.${context('served', served)}`,
    ).toBe(retrievalClass)
    if (tone !== 'warning') {
      expect(
        observed.bannerRung,
        `the header painted a rung strip for the ${retrievalClass} class, which is information `
        + `the tab states, not a warning (427 D-20).${context('served', served)}`,
      ).toBeUndefined()
      return
    }
    expect(
      observed.bannerRung,
      `the recorded ${retrievalClass} class is a warning and the header painted no strip for it.`
      + context('served', served),
    ).toBe(rung)
    expect(
      observed.bannerClass,
      `the strip's \`data-retrieval-class\` disagrees with the recorded reason's class.${context('served', served)}`,
    ).toBe(retrievalClass)
  })

  it('(b4) the Learned half\'s root carries the curation word the projection served', () => {
    const observed = visitOf('served', served)
    const projection = readyProjection('served', served)
    expect(
      observed.learnedState,
      'the Knowledge tab painted no `[data-learned-state]` root. The Learned half renders '
      + `whenever the projection carried one, which a ready projection always does.${context('served', served)}`,
    ).toBeDefined()
    // `counts-absent` is the fifth word the chip cannot say: a settled chain whose frozen row
    // recorded neither count. Every other word mirrors the chip exactly.
    const expected = projection.curation.status === 'complete' && projection.curation.counts === undefined
      ? 'counts-absent'
      : projection.curation.status
    expect(
      observed.learnedState,
      'the Learned half and the curation chip give two different accounts of one chain.'
      + context('served', served),
    ).toBe(expected)
  })

  it('(b5) the Used summary counts the steps that really were briefed', () => {
    const observed = visitOf('served', served)
    const projection = readyProjection('served', served)
    // The three-channel sum this file already spelled correctly here, now spelled ONCE.
    const briefed = projection.steps.filter((step) => servedLineCount(step) > 0)
    expect(
      observed.usedSummary,
      `the Used half painted no summary line at all.${context('served', served)}`,
    ).toBeDefined()
    expect(
      (observed.usedSummary ?? '').startsWith(
        `${String(briefed.length)} ${briefed.length === 1 ? 'step' : 'steps'} briefed`,
      ),
      'the derived Used summary does not open with the number of steps the projection says were '
      + `briefed.${context('served', served)}`,
    ).toBe(true)
  })

  it('(b6) the Knowledge tab is reachable by `7` on the seeded run too', () => {
    const observed = visitOf('served', served)
    expect(
      observed.stateAfter7,
      `pressing \`7\` did not land on a READY Knowledge tab.${context('served', served)}`,
    ).toBe('ready')
    expect(
      observed.knowledgeStepCount,
      `the Used half drew no step rows for a run the tree drew ${String(observed.treeStepCount)} `
      + `steps for.${context('served', served)}`,
    ).toBeGreaterThan(0)
  })

  // ── (C) The two worlds the gap round was written for, measured on the same built bundle.
  //
  // WHY THEY ARE HERE AND NOT IN A UNIT CELL. 407-14 proved the op folds a named scan error and
  // 407-15 proved the view paints an `added` row — each against a fixture the plan itself
  // constructed. Neither proved that the SHIPPED binary, serving a real store that a real run
  // really wrote, reaches those arms: the seam between the two is a store on disk, an HTTP door
  // and a bundle in a browser, and a seam is exactly what a green unit suite cannot see. These
  // three cells drive the same run these fixtures already drove, with the store mutated underneath
  // it, and read the answer off the page.

  it('(c1) a fact curated AFTER the run, linked to it, is served as an added change and painted as an added row', () => {
    visitOf('served', served)
    const afterRun = served.afterRun
    expect(
      afterRun?.publishOutcome,
      'the after-run bundle did not publish, so there is no `added` change for the op to attribute '
      + `or the page to paint. This is a fixture fault, not a page fault.${context('served', served)}`,
    ).toBe('published')

    const projection = afterRun?.projection
    expect(
      projection?.kind,
      'the `/api/runs/:id/knowledge` read taken after one more fact was curated did not answer '
      + `\`ready\`.${context('served', served)}`,
    ).toBe('ready')
    const ready = projection as Extract<RunKnowledgeProjection, { kind: 'ready' }>
    const publishedId = afterRun?.publishedId as string
    const added = ready.learned.changes.find((change) =>
      change.change === 'added' && change.recordId === publishedId)
    expect(
      added,
      'the op served no `added` change for the record published against this run AFTER it '
      + 'finished. Either the change walk never synthesised the birth (the since-ordinal window) '
      + "or the op's attribution filter dropped it (407-04's `sourceRunId` stamp)."
      + context('served', served),
    ).toBeDefined()
    expect(
      (added as NonNullable<typeof added>).sourceRunId,
      "the `added` change is not stamped with this run's id, so nothing links the record's birth "
      + `to the run that caused it.${context('served', served)}`,
    ).toBe(served.drive?.runId)

    const observed = afterRun?.visit
    expect(
      observed,
      `the after-run run-detail page was never observed.${context('served', served)}`,
    ).toBeDefined()
    const painted = observed as PageObservation
    expect(
      painted.learnedRows.some((row) => row.bucket === 'added' && row.id === publishedId),
      'the Memory changes section painted no `li[data-record-change="added"]` whose Retrieval '
      + 'details ledger entry names the record the op served as this run\'s own addition '
      + `(427 D-15/D-19).${context('served', served)}`,
    ).toBe(true)
    expect(
      painted.learnedSentence,
      'the Learned half printed a state sentence beside rows it had been handed. Rows are consulted '
      + `BEFORE the sentence ladder (407-15) — a served record is never denied.${context('served', served)}`,
    ).toBeUndefined()
    expect(
      ['complete', 'counts-absent'].includes(painted.learnedState ?? ''),
      'the Learned half is not in a settled state on a run whose chain already reached a terminal '
      + `curation word.${context('served', served)}`,
    ).toBe(true)
  })

  it('(c2) one malformed bundle beside the healthy ones does not take the tab down', () => {
    const healthy = visitOf('served', served)
    const servedReady = readyProjection('served', served)
    const malformed = served.malformed
    expect(
      malformed?.projectionStatus,
      'the spawned door answered a non-200 for a run whose store gained ONE unreadable bundle the '
      + `run never served a line from.${context('served', served)}`,
    ).toBe(200)
    const projection = malformed?.projection
    expect(
      projection?.kind,
      'the read taken with one malformed bundle in the store did not answer `ready` — the whole '
      + `trust surface went down with a file none of it depended on.${context('served', served)}`,
    ).toBe('ready')
    const ready = projection as Extract<RunKnowledgeProjection, { kind: 'ready' }>
    expect(
      ready.learned.scanIncomplete,
      'the op folded the store scan error without SAYING so. An empty `changes` list carrying no '
      + `marker reads as "nothing was learned", which is a different fact.${context('served', served)}`,
    ).toBe(true)
    expect(
      ready.steps.length,
      'one unreadable bundle changed how many steps the Used half is given, so the degradation did '
      + `not stay inside the Learned enrichment.${context('served', served)}`,
    ).toBe(servedReady.steps.length)
    expect(
      ready.retrievalRung,
      'one unreadable bundle changed the rung this run RECORDED at serve time — a fact frozen '
      + `before the bundle existed.${context('served', served)}`,
    ).toEqual(servedReady.retrievalRung)

    const observed = malformed?.visit
    expect(
      observed,
      `the malformed-store run-detail page was never observed.${context('served', served)}`,
    ).toBeDefined()
    const painted = observed as PageObservation
    expect(
      painted.stateAfter7,
      `pressing \`7\` did not land on a READY Knowledge tab.${context('served', served)}`,
    ).toBe('ready')
    expect(
      painted.knowledgeStepCount,
      `the Used half drew a different number of step rows than it drew on the same run before the `
      + `malformed bundle existed.${context('served', served)}`,
    ).toBe(healthy.knowledgeStepCount)
    expect(
      painted.learnedRead,
      'the Learned half did not stamp `data-learned-read="incomplete"`, so a reader is shown an '
      + `absence with no way to tell it from an unreadable store.${context('served', served)}`,
    ).toBe('incomplete')
    // RE-SPELLED 427-09 (D-15). Memory changes rows come from curation's fixed snapshot, which is
    // not a store scan, so a partial scan no longer empties the list: the page paints exactly the
    // door's rows and names the partial read BESIDE them. With no row to list it still prints the
    // unreadable-store sentence.
    const doorRows = learnedRowsOf(ready)
    expect(
      painted.learnedRows,
      'the Memory changes section painted rows other than the door\'s snapshot rows over a scan '
      + `that did not complete.${context('served', served)}`,
    ).toEqual(doorRows)
    if (doorRows.length > 0) {
      expect(
        [painted.learnedSentence, painted.learnedReadNote],
        'the Memory changes section did not name the partial read beside the rows it painted, or '
        + `printed a sentence over them.${context('served', served)}`,
      ).toEqual([undefined, STORE_READ_INCOMPLETE_TEXT])
    } else {
      expect(
        painted.learnedSentence,
        'the Learned half did not print the published unreadable-store sentence, so a reader is told '
        + `to wait for a page that will never fill on its own.${context('served', served)}`,
      ).toBe(CHANGES_UNREADABLE_TEXT)
    }
  })

  it('(c3) every projection this file read parses against the wire contract', () => {
    // THE CR-01 CLASS, ON THE SHIPPED DOOR. `readSettledProjection` only STORES a parsed body, so a
    // projection that failed its own contract would leave `recorded.projection` undefined and every
    // other cell reporting a missing read. This cell reads the RAW body instead, so the failure is
    // named as what it is — the op serving a shape its own schema refuses.
    const reads = [
      { label: 'scan', recorded: scan, body: scan.projectionBody },
      { label: 'served', recorded: served, body: served.projectionBody },
      { label: 'after-run', recorded: served, body: served.afterRun?.projectionBody },
      { label: 'malformed', recorded: served, body: served.malformed?.projectionBody },
    ] as const
    for (const read of reads) {
      const where = read.recorded === scan ? 'scan' : 'served'
      expect(
        read.body,
        `the ${read.label} read recorded no response body at all.${context(where, read.recorded)}`,
      ).toBeDefined()
      const parsed = RunKnowledgeProjectionSchema.safeParse(JSON.parse(read.body as string))
      expect(
        parsed.success ? '' : JSON.stringify(parsed.error.issues),
        `the ${read.label} projection does not satisfy \`RunKnowledgeProjectionSchema\` — a `
        + `projection failing its OWN contract, which is the CR-01 class this round closed at the `
        + `wire. The refusing issues are the value above.${context(where, read.recorded)}`,
      ).toBe('')
    }
  })

  it('(c4) the page and the door agree, world by world — Learned rows, the read stamp, and every served line\'s outcome word', () => {
    // THE CR-01 LAW ON THE SHIPPED ARTIFACT, OVER EVERY WORLD THIS FILE BUILDS (REVIEW CR-01).
    //
    // 407-18 restored the agreement at the view, 407-19 made the op raise the flag by contract and
    // 407-20 closed the loader↔wire seam — each proven green at its own layer. What no unit cell
    // can see is whether the two halves of the tab and the door still tell ONE story after three
    // packages moved underneath them. This cell asks the same page these fixtures already drove,
    // in every world they reach, three questions:
    //
    //   (1) are the Learned rows painted exactly the door's `learned.changes` narrowed to the five
    //       published kinds, in order, whenever the curation chain has SETTLED — and nothing at
    //       all when it has not (D-12: an unsettled chain has not finished deciding)?
    //   (2) is `data-learned-read="incomplete"` present exactly when `learned.scanIncomplete` is
    //       `true` — absent, never empty, on a clean read?
    //   (3) does every painted served line wear the word the projection implies, by
    //       `canaryOutcomeWord`'s own three-arm order — unsettled chain, then a served row, then
    //       the read — and no attribute at all on a line that was not served as a canary?
    //
    // THE CENSUS IS THE MEASUREMENT OF REACHABILITY BOUND (a). One row per world, recording
    // `(scanIncomplete, changes.length, canary lines painted)`, carried verbatim in every failure
    // message below. The cell does NOT assert the bound — it is a cardinality of the worlds that
    // exist, not a law, and asserting it would red the day someone builds the world the op already
    // sanctions.

    const worlds = [
      { world: 'scan', label: 'scan' as const, recorded: scan, projection: scan.projection, visit: scan.visit },
      { world: 'served', label: 'served' as const, recorded: served, projection: served.projection, visit: served.visit },
      {
        world: 'after-run',
        label: 'served' as const,
        recorded: served,
        projection: served.afterRun?.projection,
        visit: served.afterRun?.visit,
      },
      // THE SIXTH WORLD (407-31, G-407-12), AT ITS DRIVE POSITION — after `after-run`, before
      // `malformed`. It is listed where it is DRIVEN rather than where it was added, because the
      // census is a record of the store's history and a row out of order would make the two
      // `changes` readings on either side of the malformed plant read as unrelated facts.
      {
        world: 'failed-with-changes',
        label: 'served' as const,
        recorded: served,
        projection: served.failedWithChanges?.projection,
        visit: served.failedWithChanges?.visit,
      },
      {
        world: 'malformed',
        label: 'served' as const,
        recorded: served,
        projection: served.malformed?.projection,
        visit: served.malformed?.visit,
      },
      // THE FIFTH WORLD (407-25, G-407-11): a chain that failed over a row the store really
      // served. Last in the array as it is last in the drive — see `driveLaterWorlds`' docstring.
      {
        world: 'attributed-failed',
        label: 'served' as const,
        recorded: served,
        projection: served.attributedFailed?.projection,
        visit: served.attributedFailed?.visit,
      },
    ]

    // FOLDED WITHOUT ASSERTING, so the census exists even for the run that is about to red.
    // `changes: -1` is the sentinel for a world whose read never answered `ready`; the assertion
    // below names it, and no passing run can carry it.
    const census = worlds.map((entry) => ({
      world: entry.world,
      scanIncomplete: (entry.projection?.kind === 'ready' ? entry.projection : undefined)
        ?.learned.scanIncomplete === true,
      changes: entry.projection?.kind === 'ready' ? entry.projection.learned.changes.length : -1,
      canaryLines: (entry.visit?.servedLines ?? [])
        .filter((line) => line.servedAsCanary === 'true').length,
      // TWO COLUMNS ADDED BY 407-25, and every column that was here keeps its name so the round-2
      // four-row table and this five-row one can be read side by side. `curation` is the chain word
      // the projection carried; `attributions` is how many rows the store served for it.
      curation: entry.projection?.kind === 'ready' ? entry.projection.curation.status : '(none)',
      attributions: entry.projection?.kind === 'ready'
        ? entry.projection.learned.canaryAttributions.length
        : -1,
      // ONE COLUMN ADDED BY 407-31, and it exists because widening the expanded-row predicate to
      // `servedLineCount` opened a way for AGREEMENT 3 and (c5) to pass over an EMPTY intersection
      // (G-407-15). Both mirrors still compare CHANNEL-1 lines — that is the right comparison —
      // but a step selected for its channel-2 brief line has an empty `channel1`, and the
      // agreement would then be `[]` against `[]`. Both sites BRANCH on that, and this column is
      // where the run REPORTS which arm it took, so a fixture change that moves the selection onto
      // an all-channel-2 step is a visible column change rather than a silently emptied agreement.
      channel1Branch: channel1BranchOf(entry.projection),
    }))

    const censusOf = (world: string): string =>
      `\n(c4) world: ${world}; entry: ${JSON.stringify(census.find((row) => row.world === world))}`
      + `\n(c4) census: ${JSON.stringify(census)}`

    for (const entry of worlds) {
      const seen = censusOf(entry.world) + context(entry.label, entry.recorded)
      expect(
        entry.projection?.kind,
        `the ${entry.world} world recorded no \`ready\` projection, so there is no door answer to `
        + `agree with.${seen}`,
      ).toBe('ready')
      const ready = entry.projection as Extract<RunKnowledgeProjection, { kind: 'ready' }>
      expect(
        entry.visit,
        `the ${entry.world} world's run-detail page was never observed.${seen}`,
      ).toBeDefined()
      const painted = entry.visit as PageObservation

      // ── AGREEMENT 1: rows painted ⇔ rows served, narrowed to the published kinds.
      //
      // THREE ARMS, AND SINCE 407-31 TWO OF THEM LIST ROWS. `attributed-failed` was the first
      // SETTLED-BUT-FAILED world this file drove, and the old two-valued `settled = status ===
      // 'done'` classified it as UNSETTLED — reporting a settled chain under a law it is not
      // breaking. 407-25 split the arm and left its expectation where it was, because the shipped
      // `failed` arm returned `rows: []` and no world could show otherwise. Both halves of that
      // have now moved: the owner ruled (2026-08-31, REVIEW CR-01, G-407-12), 407-26 hoisted the
      // fold above the whole status ladder, and the sixth world holds a served change row over a
      // failed chain so the expectation below is NON-EMPTY on this arm rather than `[]` against
      // `[]`.
      const chainWord = ready.curation.status
      const arm = chainWord === 'pending' || chainWord === 'running'
        ? 'unsettled'
        : chainWord === 'failed' ? 'settled-and-failed' : 'settled-and-complete'
      const armNote = arm === 'unsettled'
        ? ' (UNSETTLED chain — it has not finished deciding, so it lists NOTHING: D-12)'
        : arm === 'settled-and-failed'
          ? ' (SETTLED-AND-FAILED chain — IT LISTS EXACTLY WHAT A SETTLED-AND-COMPLETE ONE WOULD. A '
            + 'chain that fell over cannot un-commit records it had already written, so the rows '
            + 'stand and the failure is reported BESIDE them — by the Learned root\'s state word '
            + 'and by `[data-learned-chain-note]`, never by the absence of rows. Authority: owner '
            + 'ruling 2026-08-31, REVIEW CR-01, G-407-12.)'
          : ' (SETTLED-AND-COMPLETE chain — the other arm that lists rows)'
      expect(
        painted.learnedRows,
        `AGREEMENT 1 BROKE in the ${entry.world} world: the Memory changes rows the page painted `
        + `(bucket from the row, id from Retrieval details) are not the door's answer projected `
        + `as \`changeDrafts\` does — the snapshot's rows then since-then changes, or \`learned.changes\` `
        + `narrowed to ${JSON.stringify(LEARNED_CHANGE_KINDS)} and grouped per record`
        + `${armNote}. This is the CR-01 class: `
        + `a half that paints a different set from the one it was served.${seen}`,
      ).toEqual(arm === 'unsettled' ? [] : learnedRowsOf(ready))

      // ── AGREEMENT 2: the read stamp ⇔ the wire flag, absent rather than empty on a clean read.
      expect(
        painted.learnedRead,
        `AGREEMENT 2 BROKE in the ${entry.world} world: \`data-learned-read\` and `
        + `\`learned.scanIncomplete\` disagree. The stamp is a fact about the READ and must survive `
        + `every arm (REVIEW WR-05).${seen}`,
      ).toBe(ready.learned.scanIncomplete === true ? 'incomplete' : undefined)

      // ── AGREEMENT 3: every painted served line wears the word the projection implies.
      //
      // THE EXPANDED ROW IS DERIVED THE WAY THE HARVEST DERIVES IT — `servedLineCount`, the same
      // three-channel sum `data-brief-lines` is stamped from, because that attribute is what
      // `observeKnowledge` picks the row BY. The old predicate here read `channel1.length > 0`
      // and the comment beneath it claimed `data-brief-lines` IS `channel1.length`; both were
      // wrong, and a step briefed only on channel 2 would have been expanded by the page and
      // skipped by this mirror (G-407-15 · REVIEW WR-03). Matching by index rather than by id is
      // what makes a MISSING line a red instead of a silently skipped one.
      const expanded = ready.steps.find((step) => servedLineCount(step) > 0) ?? ready.steps[0]
      const doorLines = expanded?.served.channel1 ?? []
      // THE WIDENING'S OWN HOLE, STATED RATHER THAN FALLEN INTO. `doorLines` stays on channel 1 —
      // that is the right comparison and it is unchanged — but the widened predicate can now
      // select a step whose `channel1` is EMPTY, and `[]` against `[]` is the passing-over-an-
      // empty-intersection shape this round closes everywhere else. So the empty case gets its
      // own assertion and its own words, and the census column above says which arm ran.
      if (doorLines.length > 0) {
        expect(
          painted.servedLines.map((line) => line.recordId),
          `AGREEMENT 3 BROKE in the ${entry.world} world: the channel-1 lines the expanded row `
          + `painted are not the lines the door served for that step.${seen}`,
        ).toEqual(doorLines.map((line) => line.id))
      } else {
        expect(
          painted.servedLines.length,
          `AGREEMENT 3 BROKE in the ${entry.world} world ON ITS EMPTY ARM: the expanded step `
          + `served NO channel-1 line — it was selected for its channel-2 or channel-3 brief `
          + `lines — so this world proves an ABSENCE, and the page painted `
          + `${String(painted.servedLines.length)} \`li[data-served-channel="1"]\` anyway. The `
          + `census column \`channel1Branch\` records that this world took the empty arm.${seen}`,
        ).toBe(0)
      }

      painted.servedLines.forEach((line, index) => {
        const doorLine = doorLines[index] as NonNullable<(typeof doorLines)[number]>
        const attribution = ready.learned.canaryAttributions.find(
          (row) =>
            row.testIndex === (expanded as NonNullable<typeof expanded>).testIndex &&
            row.stepIndex === (expanded as NonNullable<typeof expanded>).stepIndex &&
            row.recordId === doorLine.id,
        )
        expect(
          line.servedAsCanary,
          `AGREEMENT 3 BROKE in the ${entry.world} world: line ${String(index)} `
          + `(${doorLine.id}) was stamped \`data-served-as-canary="${line.servedAsCanary}"\` over a `
          + `door line the reader marked \`${String(doorLine.servedAsCanary)}\`.${seen}`,
        ).toBe(doorLine.servedAsCanary ? 'true' : 'false')
        expect(
          line.canaryOutcome,
          `AGREEMENT 3 BROKE in the ${entry.world} world: line ${String(index)} `
          + `(${doorLine.id}) wears \`${line.canaryOutcome ?? '(absent)'}\` where the projection — `
          + `curation \`${ready.curation.status}\`, attribution `
          + `${attribution === undefined ? '(none)' : attribution.outcome}, scanIncomplete `
          + `${String(ready.learned.scanIncomplete === true)} — implies otherwise. A canary word is `
          + `never blank and never a positive claim nobody was able to make (REVIEW WR-02).${seen}`,
        ).toBe(
          doorLine.servedAsCanary
            ? expectedCanaryWord(
                ready.curation.status,
                attribution,
                ready.learned.scanIncomplete === true,
              )
            : undefined,
        )
      })
    }

    // ── NON-VACUITY, on the Learned side. Three of the four worlds legitimately carry no rows, so
    // a cell asserting only "page equals door" would pass on four empty agreements. The after-run
    // world is the one that MUST be non-empty: (c1) publishes a record against the finished run
    // precisely so the door serves an `added` change and the page paints it.
    const afterRun = census.find((row) => row.world === 'after-run')
    expect(
      afterRun?.changes ?? 0,
      `the after-run world served NO changes, so (c4)'s Learned agreement passed by emptiness `
      + `alone.${censusOf('after-run')}${context('served', served)}`,
    ).toBeGreaterThanOrEqual(1)
    expect(
      served.afterRun?.visit?.learnedRows.length ?? 0,
      `the after-run world painted NO Learned rows, so (c4)'s Learned agreement passed by emptiness `
      + `alone.${censusOf('after-run')}${context('served', served)}`,
    ).toBeGreaterThanOrEqual(1)

    // ── NON-VACUITY, on the SIXTH WORLD — nine assertions, nine messages, nine reasons.
    //
    // THIS IS THE ONLY WORLD IN WHICH G-407-12 IS MEASURABLE ON THE ARTIFACT A PERSON INSTALLS,
    // and it costs nine assertions because it has nine independent ways to be a world that proves
    // nothing. The law under test — a settled-and-failed chain lists exactly what a settled-and-done
    // one would — is a claim about a chain that is `failed` AND holds rows. Either half missing and
    // AGREEMENT 1's settled-and-failed arm compares `[]` with `[]` and passes having measured
    // nothing, which is WR-04's failure mode landing on the very arm this round exists to rule.
    //
    // THE READ MUST ALSO BE CLEAN. `learnedView` has a partial-read arm as well as a failed-chain
    // arm; a world carrying `scanIncomplete` would leave a reader unable to say which arm the
    // agreement exercised. That is why the sixth world is planted BEFORE the malformed bundle
    // rather than beside the fifth.
    const failedWithChangesReady = served.failedWithChanges?.projection?.kind === 'ready'
      ? served.failedWithChanges.projection
      : undefined
    const seenFWC = censusOf('failed-with-changes') + context('served', served)

    expect(
      failedWithChangesReady?.curation.status,
      `the failed-with-changes world's chain is NOT \`failed\`, so AGREEMENT 1's `
      + `settled-and-failed arm was never exercised by a world that holds rows. The plant updated `
      + `${String(served.failedWithChanges?.jobRowsUpdated ?? 0)} \`jobs\` row(s).${seenFWC}`,
    ).toBe('failed')

    expect(
      served.failedWithChanges?.jobRowsUpdated ?? 0,
      `the sixth world's curation plant changed a number of \`jobs\` rows other than exactly one. `
      + `Nought means it addressed no row at all and the world would read \`complete\`; more than one `
      + `means \`chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE).curateMemory\` matched a `
      + `neighbouring run's row.${seenFWC}`,
    ).toBe(1)

    expect(
      failedWithChangesReady?.learned.changes.length ?? 0,
      `the failed-with-changes world's door served NO \`learned.changes\` row, so the `
      + `settled-and-failed arm's expectation is EMPTY and the agreement compares \`[]\` with `
      + `\`[]\` — the exact vacuity this world was built to remove. This world is planted BEFORE `
      + `\`plantMalformedBundle\` precisely so the change-records read is still intact here.`
      + `${seenFWC}`,
    ).toBeGreaterThanOrEqual(1)

    expect(
      failedWithChangesReady?.learned.scanIncomplete,
      `the failed-with-changes world's read is NOT clean — \`learned.scanIncomplete\` is present, `
      + `so this world would be measuring \`learnedView\`'s PARTIAL-READ arm rather than its `
      + `FAILED-CHAIN arm, and the two cannot be told apart from the outside. A degraded read here `
      + `means the plant ordering slipped and something ran after \`plantMalformedBundle\`.`
      + `${seenFWC}`,
    ).toBeUndefined()

    expect(
      served.failedWithChanges?.visit?.learnedRows.length ?? 0,
      `the failed-with-changes world's PAGE painted no \`li[data-record-change]\` at all, over a `
      + `door that served `
      + `${String(failedWithChangesReady?.learned.changes.length ?? 0)} change record(s). This is `
      + `G-407-12 itself, measured on the shipped bundle: the failed arm denying rows the same `
      + `projection holds.${seenFWC}`,
    ).toBeGreaterThanOrEqual(1)

    expect(
      served.failedWithChanges?.visit?.learnedState,
      `the failed-with-changes world's Learned root does not read \`failed\`, so the page has `
      + `stopped saying the two facts side by side — the chain fell over AND these records were `
      + `committed before it did.${seenFWC}`,
    ).toBe('failed')

    expect(
      served.failedWithChanges?.visit?.learnedChainNote,
      `the failed-with-changes world's page printed no \`[data-learned-chain-note]\` carrying `
      + `\`CURATION_FAILED_PARTIAL_TEXT\` (read from \`knowledge-view.ts\`, never retyped here). `
      + `Rows without the note is a page that has silently dropped the chain's fate; the note `
      + `without rows is the sentence arm and a different world.${seenFWC}`,
    ).toBe(CURATION_FAILED_PARTIAL_TEXT)

    // ── THE EIGHTH: THE REVERT, PROVEN ON EVERY COLUMN THE PLANT WROTE.
    //
    // ONE OBJECT COMPARISON, so a red prints the snapshot beside the post-restore re-read rather
    // than naming one field and hiding the other four. And the row count rides INSIDE it because
    // the two facts are one claim: `changes === 1` proves a row was MATCHED, never that the values
    // put into it were the values taken out of it. A restore that matched the row and wrote four
    // of five columns satisfies the count and fails the comparison, which is the whole reason the
    // comparison is here.
    expect(
      {
        rowsRestored: served.failedWithChanges?.jobRowsRestored ?? 0,
        columns: served.failedWithChanges?.afterRestore,
      },
      `THE SIXTH WORLD'S JOBS ROW WAS NOT PUT BACK. The restore must change exactly ONE row and `
      + `leave all five columns \`plantFailedCuration\` writes — \`status\`, \`claimed_at\`, `
      + `\`updated_at\`, \`last_failure_kind\`, \`last_failure_reason\` — reading exactly what the `
      + `snapshot read before the plant. The re-read above is taken with the SAME `
      + `\`snapshotCurationJobRow\` that took the snapshot, so a disagreement is a disagreement `
      + `about VALUES and not about two readers. If this reds, every world driven after this one — `
      + `\`malformed\` and \`attributed-failed\` — has had its recorded reading altered by THIS `
      + `plan and the round's census is not comparable to round 3's.${seenFWC}`,
    ).toEqual({
      rowsRestored: 1,
      columns: served.failedWithChanges?.snapshot,
    })

    // ── THE NINTH: the downstream witness, and deliberately the SECOND one rather than the only.
    //
    // It discriminates the `status` column ALONE. A restore that put `status` back while leaving
    // `last_failure_reason` at the plant's lease string, or `updated_at` at the plant's clock,
    // greens this assertion and reds the eighth — which is exactly why both are here, and why the
    // eighth is the one that carries the word PROVEN.
    expect(
      (served.malformed?.projection?.kind === 'ready'
        ? served.malformed.projection
        : undefined)?.curation.status,
      `the malformed world's chain no longer reads \`complete\`. The sixth world's plant was not `
      + `reverted before \`plantMalformedBundle\` ran, so an EXISTING world's recorded reading has `
      + `been overwritten by this plan — the census can no longer be compared with round 3's, and `
      + `the four original rows are no longer byte-identical.${seenFWC}`,
    ).toBe('complete')

    // ── NON-VACUITY, on the FIFTH WORLD — three assertions, three messages, three reasons.
    //
    // WR-04 named this failure mode on this very cell in round 2: an agreement over an empty
    // intersection passes. `attributed-failed` has THREE preconditions and they fail
    // independently — the curation plant can address no row, the attribution plant's append can be
    // refused, and the page can paint no canary line — so a single combined assertion would report
    // whichever happened to be checked first and hide the other two.
    const attributedFailedReady = served.attributedFailed?.projection?.kind === 'ready'
      ? served.attributedFailed.projection
      : undefined
    const seenAF = censusOf('attributed-failed') + context('served', served)

    expect(
      attributedFailedReady?.curation.status,
      `the attributed-failed world's chain is NOT \`failed\`, so (c5) would be measuring a world `
      + `the ruling is not about. The curation plant updated `
      + `${String(served.attributedFailed?.jobRowsUpdated ?? 0)} \`jobs\` row(s) — it must update `
      + `exactly ONE, the row \`chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE).curateMemory\` `
      + `addresses.${seenAF}`,
    ).toBe('failed')

    expect(
      served.attributedFailed?.jobRowsUpdated ?? 0,
      `the curation plant changed a number of \`jobs\` rows other than exactly one. Nought means it `
      + `addressed no row at all and the world would read \`complete\`; more than one means the `
      + `derivation matched a neighbouring run's row.${seenAF}`,
    ).toBe(1)

    expect(
      attributedFailedReady?.learned.canaryAttributions.length ?? 0,
      `the attributed-failed world served NO \`canaryAttributions\` row, so (c5)'s agreement would `
      + `pass over an empty intersection (REVIEW WR-04). The attribution plant reported `
      + `\`${served.attributedFailed?.appendOutcome ?? '(none)'}\` for observation id `
      + `\`${served.attributedFailed?.plantedObservationId || '(none)'}\` — anything other than `
      + `\`appended\` is the plant, not the read.${seenAF}`,
    ).toBeGreaterThanOrEqual(1)

    expect(
      (served.attributedFailed?.visit?.servedLines ?? [])
        .filter((line) => line.servedAsCanary === 'true').length,
      `the attributed-failed world's page painted NO served canary line, so there is no line for `
      + `(c5) to read a word off.${seenAF}`,
    ).toBeGreaterThanOrEqual(1)
  })

  it('(c5) the ruling on the shipped page — a served row beats a failed chain, and the chip still says the chain fell over', () => {
    // THE OWNER RULING OF 2026-08-30 (UAT item 11, gap G-407-11), STATED DIRECTLY RATHER THAN
    // THROUGH THE GENERIC MIRROR.
    //
    // (c4)'s third agreement measures this world too — `expectedCanaryWord` carries 407-22's law,
    // so agreement 3 over `attributed-failed` IS the ruling re-derived. This cell says it once
    // more WITHOUT the mirror, because the mirror could drift and because the ruling has a SECOND
    // half the mirror does not reach: the chain's fate and the store's answer are two different
    // facts a reader must be able to see side by side. `not attributed` is a positive claim that
    // the store was consulted and answered no; the projection here disproves it while the Learned
    // half goes on reporting, correctly, that the chain failed.
    //
    // IT MEASURES THE ROW-WINS ARM, NOT THE FLAG ARM, and that is deliberate. This world inherits
    // `scanIncomplete: true` from the malformed bundle planted before it (permanent for this root
    // — see `driveLaterWorlds`). With a row present, `canaryOutcomeWord` decides on its SECOND arm
    // and never consults the flag, so the inherited flag changes nothing here. The flag arm keeps
    // its own witness in the malformed world.
    const recorded = served.attributedFailed
    const seen = context('served', served)

    expect(
      recorded?.projection?.kind,
      `the attributed-failed world recorded no \`ready\` projection.${seen}`,
    ).toBe('ready')
    const ready = recorded?.projection as Extract<RunKnowledgeProjection, { kind: 'ready' }>
    const painted = recorded?.visit
    expect(painted, `the attributed-failed world's page was never observed.${seen}`).toBeDefined()
    const visit = painted as PageObservation

    // ── The chain really fell over, and the door says so.
    expect(
      ready.curation.status,
      `the attributed-failed world's chain is not \`failed\`, so this is not the world the ruling `
      + `is about.${seen}`,
    ).toBe('failed')

    // ── HALF ONE OF THE RULING: the served line wears the row's own outcome.
    //
    // THE SAME `servedLineCount` DERIVATION AGREEMENT 3 USES (G-407-15 · REVIEW WR-03). This cell
    // copied the channel-1-only predicate a second time when it was written; it now shares the
    // harvest's own rule, and — because that rule can select a step whose `channel1` is empty —
    // states its empty case rather than comparing `[]` with `[]`.
    const expanded = ready.steps.find((step) => servedLineCount(step) > 0) ?? ready.steps[0]
    const doorLines = expanded?.served.channel1 ?? []
    const canaryLines = visit.servedLines
      .map((line, index) => ({ line, index }))
      .filter((held) => held.line.servedAsCanary === 'true')
    if (doorLines.length === 0) {
      expect(
        visit.servedLines.length,
        `the attributed-failed world's expanded step served NO channel-1 line — it was selected `
        + `for its channel-2 or channel-3 brief lines — so this cell can only prove an ABSENCE, `
        + `and the page painted ${String(visit.servedLines.length)} channel-1 line(s) anyway. The `
        + `(c4) census column \`channel1Branch\` records that this world took the empty arm, and `
        + `the ruling itself is then unmeasured here: reopen it against a fixture whose expanded `
        + `step serves channel 1.${seen}`,
      ).toBe(0)
      return
    }
    expect(
      canaryLines.length,
      `the attributed-failed world painted no served canary line.${seen}`,
    ).toBeGreaterThanOrEqual(1)

    let joined = 0
    for (const held of canaryLines) {
      const doorLine = doorLines[held.index]
      const attribution = ready.learned.canaryAttributions.find(
        (row) =>
          row.testIndex === (expanded as NonNullable<typeof expanded>).testIndex &&
          row.stepIndex === (expanded as NonNullable<typeof expanded>).stepIndex &&
          row.recordId === (doorLine === undefined ? '' : doorLine.id),
      )
      if (attribution === undefined) continue
      joined += 1
      expect(
        held.line.canaryOutcome,
        `THE RULING IS NOT ON THE PAGE: the served canary line `
        + `\`${doorLine === undefined ? '(no door line)' : doorLine.id}\` wears `
        + `\`${held.line.canaryOutcome ?? '(absent)'}\` while the SAME projection holds a `
        + `\`${attribution.outcome}\` row for it under observation id `
        + `\`${attribution.observationId}\` and a \`${ready.curation.status}\` chain. A row the `
        + `store actually served must beat a failed chain — \`not attributed\` is a positive claim `
        + `the projection beside it disproves (owner ruling 2026-08-30, UAT item 11).${seen}`,
      ).toBe(attribution.outcome)
    }
    expect(
      joined,
      `no painted canary line JOINED a \`canaryAttributions\` row, so the loop above asserted `
      + `nothing at all — the vacuity WR-04 named.${seen}`,
    ).toBeGreaterThanOrEqual(1)

    // ── HALF TWO: the chain's fate is still reported, beside the row rather than instead of it.
    expect(
      visit.learnedState,
      `the Learned half's root does not read \`failed\` in the attributed-failed world, so the `
      + `page is no longer saying the two facts side by side.${seen}`,
    ).toBe('failed')
    // ── AND THE ROWS HERE ARE THE DOOR'S SNAPSHOT ROWS, NOT A LAW ABOUT THE FAILED ARM.
    //
    // RE-SPELLED 427-09 (D-15). Since the owner ruling of 2026-08-31 (REVIEW CR-01 · G-407-12) a
    // settled-and-failed chain lists exactly what a settled-and-done one would, and AGREEMENT 1
    // enforces that on both settled arms. This world is driven AFTER `plantMalformedBundle`, so its
    // change-records read degrades permanently for this root and the door serves no change at all —
    // asserted FIRST. What the page lists is curation's fixed snapshot, which no store scan
    // produces, so the rows are the door's snapshot rows, bucket from the row and id from Retrieval
    // details.
    //
    // THE LAW IS MEASURED IN THE SIXTH WORLD, `failed-with-changes`, which is planted BEFORE the
    // malformed bundle precisely so it can hold both a failed chain and served change records.
    expect(
      ready.learned.changes.length,
      `the attributed-failed world's door served \`learned.changes\` after all, so this world no `
      + `longer measures a degraded change-records read. If the read stopped degrading for a root `
      + `holding a malformed bundle, this cell needs rewriting, not silencing.${seen}`,
    ).toBe(0)
    expect(
      visit.learnedRows,
      `the Memory changes section painted rows other than the door's: \`learned.changes\` is empty `
      + `in this world, so the only rows to list are curation's own snapshot rows. This is NOT the `
      + `failed arm suppressing rows — that behaviour was ruled against on 2026-08-31 and AGREEMENT `
      + `1 enforces the ruling; the law is measured in the \`failed-with-changes\` world.${seen}`,
    ).toEqual(learnedRowsOf(ready))
  })

  it('(c6) an unbroken 120-char summary fits the row with the break utility and overruns it without — measured, both ways', () => {
    // G-407-2, MEASURED WHERE THE UAT FOUND IT: real Chromium, the built bundle, the shipped
    // `agent-qa dashboard`, the same 1280px-wide default viewport the UAT drove.
    //
    // The UAT recorded `scrollW 895 vs clientW 639` — a 256px horizontal overrun — on a row whose
    // summary held 120 identical characters. 407-23 replaced `break-words` with `wrap-anywhere`
    // (`overflow-wrap: anywhere`), which is the spelling that participates in intrinsic sizing.
    // This cell asks the browser whether that is true HERE, and asks it twice.
    //
    // THE PAIR IS THE EVIDENCE, NOT EITHER READING. "No overrun" alone is equally consistent with a
    // wide viewport. The second reading removes ONE class from the SAME node in the SAME layout and
    // the overrun comes back — which is what makes the fix the cause of its own effect.
    const probe = served.wrapProbe
    const seen = `\n(c6) probe: ${JSON.stringify(probe ?? null)}${context('served', served)}`

    expect(
      probe?.failure,
      `the (c6) unbroken-token probe never measured anything.${seen}`,
    ).toBeUndefined()
    const withUtility = probe?.withUtility
    const withoutUtility = probe?.withoutUtility
    expect(withUtility, `(c6) recorded no WITH-utility geometry.${seen}`).toBeDefined()
    expect(withoutUtility, `(c6) recorded no WITHOUT-utility geometry.${seen}`).toBeDefined()
    const held = withUtility as WrapGeometry
    const bare = withoutUtility as WrapGeometry

    // ── THE NODE REALLY CARRIED THE UTILITY. Removing a class that was not there would produce a
    // "differential" of two identical readings, and the second assertion below would then be
    // measuring nothing at all.
    expect(
      probe?.classListBefore ?? '',
      `the summary node the probe addressed does not carry \`${WRAP_UTILITY_CLASS}\`, so the `
      + `second reading removed nothing and the differential is not a differential.${seen}`,
    ).toContain(WRAP_UTILITY_CLASS)
    // COMPARED AS SETS, NOT AS STRINGS (G-407-20 · REVIEW IN-02). `DOMTokenList.add` APPENDS, so
    // byte equality between the two class lists holds only while `wrap-anywhere` happens to be the
    // LAST token in the component's className — reorder the className and this assertion reds
    // while the probe behaved perfectly. What the probe actually promises is that the node was put
    // back the way it was found, and that is a claim about the SET of classes.
    const classSet = (list: string | undefined): readonly string[] =>
      (list ?? '').split(/\s+/u).filter((token) => token !== '').sort()
    expect(
      classSet(probe?.classListAfter),
      `the probe did not put the summary node's class list back: it was `
      + `\`${probe?.classListBefore ?? '(none)'}\` and it is now `
      + `\`${probe?.classListAfter ?? '(none)'}\`. Compared as SETS — a reordered className is not `
      + `a failed restore, a missing or extra utility is.${seen}`,
    ).toEqual(classSet(probe?.classListBefore))

    // ── HALF ONE: with the utility, the row does not overrun.
    expect(
      held.rowScrollWidth,
      `WITH \`${WRAP_UTILITY_CLASS}\` the served line still overruns its own box: scrollWidth `
      + `${String(held.rowScrollWidth)} vs clientWidth ${String(held.rowClientWidth)}. The UAT `
      + `measured 895 vs 639 before the fix (G-407-2).${seen}`,
    ).toBeLessThanOrEqual(held.rowClientWidth)

    // ── HALF TWO: without it, the overrun comes back. This is the half that pins the cause.
    expect(
      bare.rowScrollWidth,
      `WITHOUT \`${WRAP_UTILITY_CLASS}\` the served line does NOT overrun (scrollWidth `
      + `${String(bare.rowScrollWidth)} vs clientWidth ${String(bare.rowClientWidth)}), so the `
      + `first reading proved nothing about the class — this viewport is simply wide enough for a `
      + `120-character token, and the differential G-407-2 needs is not being measured.${seen}`,
    ).toBeGreaterThan(bare.rowClientWidth)
  })

  it('(c6b) the built stylesheet defines the utility the component ships — by SELECTOR, in the dist CSS', () => {
    // NEVER A BARE DECLARATION GREP. `overflow-wrap:anywhere` is in this file TODAY for the
    // arbitrary-value class `[overflow-wrap:anywhere]`, emitted at 13 sites across 7 files
    // (`reasoning-pipeline.tsx`, `live-mode-auth-state-control.tsx`, `live-session-pane.tsx`,
    // `reasoning-pipeline.wrap.test.tsx`, `auth-states-section.tsx`, `tab-overview.tsx`,
    // `editor-step-detail.tsx`). A declaration grep was green before 407-23 and is green after it,
    // and distinguishes nothing.
    //
    // NEVER ONE EXACT MINIFIED RULE BODY EITHER. `.wrap-anywhere{overflow-wrap:anywhere}` is only
    // ONE of the shapes a correct emitter produces; an emitter that grouped identical bodies into a
    // selector list would fail a byte-exact grep while the utility worked perfectly, and would push
    // a CORRECT implementation onto the contingency branch below.
    //
    // 407-23's CONTINGENCY HAS EXACTLY ONE TRIGGER: the `.wrap-anywhere` SELECTOR is ABSENT. It is
    // not the expected path — the pinned Tailwind 4.2.4 defines the utility (`dist/lib.js` carries
    // `t("wrap-anywhere",[["overflow-wrap","anywhere"]])`), so the named branch is the one that
    // should be taken, and 407-23 measured it being taken.
    const named = distCssRulesMatching(/\.wrap-anywhere[,{]/)
    const componentSource = readFileSync(
      join(
        PACKAGES_ROOT,
        'dashboard-ui',
        'src',
        'components',
        'run-detail',
        'knowledge-brief-line.tsx',
      ),
      'utf8',
    )

    if (named.length > 0) {
      expect(
        named.filter((rule) => rule.includes('overflow-wrap:anywhere')).length,
        `the built stylesheet carries ${String(named.length)} rule(s) whose selector list names `
        + `\`.wrap-anywhere\` — ${JSON.stringify(named)} — but none of them declares `
        + `\`overflow-wrap:anywhere\` in its own body, so the class the component ships is a no-op.`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        componentSource.includes(WRAP_UTILITY_CLASS),
        `the dist CSS defines \`.wrap-anywhere\` but \`knowledge-brief-line.tsx\` no longer ships `
        + `the class, so nothing on this page uses it.`,
      ).toBe(true)
      return
    }

    // ── THE FALLBACK, entered ONLY on absence of the named selector, and NOT vacuous. It needs
    // BOTH halves: the escaped rule already ships in the dist CSS today, and the source tsx is the
    // very file 407-23's contingency would have just written, so either half alone moves the
    // vacuity rather than removing it.
    const escaped = distCssRulesMatching(/\.\\\[overflow-wrap\\:anywhere\\\][,{]/)
    expect(
      escaped.filter((rule) => rule.includes('overflow-wrap:anywhere')).length,
      `no rule in the built stylesheet names \`.wrap-anywhere\` OR the escaped arbitrary-value `
      + `selector \`.\\[overflow-wrap\\:anywhere\\]\` with the declaration in its body, so the `
      + `Knowledge tab ships NO intrinsic break utility at all.`,
    ).toBeGreaterThanOrEqual(1)
    expect(
      componentSource.includes('[overflow-wrap:anywhere]'),
      `the named \`.wrap-anywhere\` selector is absent from the dist CSS, so 407-23's contingency `
      + `applies — but \`knowledge-brief-line.tsx\` does not ship the arbitrary-value spelling `
      + `either, so the escaped rule found above belongs to some OTHER component and proves nothing `
      + `about this line.`,
    ).toBe(true)
  })

  it('(c7) the vocabulary read refuses a slice it can only partly see — nested bracket, and a member in another delimiter', () => {
    // G-407-19 · REVIEW IN-01, DRIVEN RATHER THAN ASSERTED IN A DOCSTRING.
    //
    // `publishedStringArray` used to throw only on ZERO members, which is the one narrowing that
    // cannot happen quietly. The two that can each produce a SHORTER list in silence, leaving (c4)
    // re-deriving the door's answer from a subset of the vocabulary the view actually holds.
    //
    // THE SECOND SLICE IS THE ONE THAT MATTERS. Members are recovered with `/'([^']+)'/gu`, so a
    // member respelled `"promoted"` contributes ZERO apostrophes: it drops out of the recovered
    // list AND out of an apostrophe-only census at the same time, and the tally still reads
    // `2 * members.length`. Only a census counting apostrophes, double quotes and backticks
    // together rejects it — which is exactly what this cell proves is happening.
    const nested = "export const FAKE_KINDS = ['added', ['confirmed'], 'promoted'] as const"
    expect(
      () => publishedStringArray('FAKE_KINDS', nested),
      'a captured literal containing a further `[` was accepted, so a nested array truncates the '
      + 'vocabulary at the inner `]` and every caller narrows by a prefix of it.',
    ).toThrow(/contains a further/u)

    // FIVE MEMBERS, ONE RESPELLED IN DOUBLE QUOTES. Four are recovered; the apostrophe count is
    // 8 = 2 * 4, so an apostrophe-only census would wave this through.
    const respelled =
      'export const FAKE_KINDS = [\'added\', \'confirmed\', \'superseded\', \'deprecated\', '
      + '"promoted"] as const'
    expect(
      (respelled.match(/'/gu) ?? []).length,
      'the fixture slice no longer has the apostrophe count that makes this cell discriminating — '
      + 'an apostrophe-only census must read exactly `2 * members.length` over it, or the cell '
      + 'proves nothing about counting the other two delimiters.',
    ).toBe(8)
    expect(
      Array.from(respelled.matchAll(/'([^']+)'/gu)).length,
      'the fixture slice no longer recovers exactly four apostrophe-delimited members, so the '
      + 'apostrophe-only census would no longer have passed and the cell is measuring the wrong '
      + 'thing.',
    ).toBe(4)
    expect(
      () => publishedStringArray('FAKE_KINDS', respelled),
      'a member respelled in double quotes was accepted: it dropped silently out of the recovered '
      + 'list while an apostrophe-only census still balanced. This is IN-01\'s own named failure '
      + 'mode, and the three-delimiter quote census exists to reject it.',
    ).toThrow(/quote character/u)

    // AND THE REAL VOCABULARY STILL READS, so the hardening did not simply make the function
    // throw. NO SIZE IS ASSERTED — four kinds versus five is UAT item 9 and still the owner's.
    expect(
      LEARNED_CHANGE_KINDS.length,
      'the published Learned vocabulary recovered no members at all from `knowledge-view.ts`.',
    ).toBeGreaterThanOrEqual(1)
  })
})
