// THE POPULATED-RUN PRODUCER (Phase 405 plan 09 · DETL-01 / DETL-02, CONTEXT D-04 and D-11).
//
// WHAT THIS FILE IS FOR. Every 405 cell that measures the run-detail PAGE needs a run whose wire
// actually carries the three things the page renders: a decision-screenshot `artifactRefs[0].sha`,
// a `stepFinalized.tokenUsage`, and masked placeholders in a sub-action's `plan` text. The
// fixtures this repository already had cannot produce any of them. `drainableSuiteFixtureProject`
// says so in its own words — "THE RUN IS EXPECTED TO FAIL, and that is fine" — because its whole
// subject is wire SHAPE; its member never opens a page, never takes a screenshot and never calls a
// model, so nothing downstream of "the run reached a verdict" exists to look at. RESEARCH Pitfall 6
// names exactly this gap and 405-01's coverage item D6 records the consequence: every leg of the
// shipped binding is proven separately and NO cell drives the shipped `agent-qa dashboard` binary
// against a populated run. This module is that producer.
//
// WHY A WIRE STUB AND NOT A CASSETTE. RESEARCH A2 offered the eval package's replay as a
// model-free producer. Measured this session, the replay emits no bus events at all — it
// reconstitutes a recorded run's artifacts without ever starting a `RunSession` — so a cell built
// on it would be asserting against a shape the shipped subscriber never sees. The honest
// model-free producer is therefore one level lower: a local HTTP server that speaks the
// OpenAI chat-completions wire the `openai-compatible` provider consumes, so the request leaves
// the shipped runner, crosses a real socket and comes back as a real provider response. Everything
// between the planner call and the bus is the product's own code.
//
// NO CREDENTIAL, NO NETWORK, NO PROVIDER. The declared model is `openai-compatible` pointed at
// this fixture's own loopback server; that provider is credential-optional, so auth resolves
// `unauthenticated` and the run proceeds with `{ kind: 'none' }`. The target is this fixture's own
// loopback page. A machine with no keys and no internet runs this exactly as CI does.
//
// RED, NEVER SKIP. This module asserts nothing and skips nothing — the instrument law
// `spawned-chat.ts` states for itself, unchanged. It returns data; the cell that imports it
// decides what a missing browser, a stale build or an unfinished run means, in its own words.
//
// THE STOP RULE, STATED HERE SO NOBODY QUIETLY WEAKENS IT. If the shipped planner cannot be
// satisfied by the canned responses below — a refused request shape, an ungroundable action, a
// turn that never terminates — the honest move is to STOP and report the exact request shape that
// was refused. It is NOT to downgrade the cell to "provider-gated, skipped in CI". That downgrade
// is RESEARCH A2's fallback and it is a decision for a human, because it costs CI the only
// end-to-end proof of the run-detail page that exists.
//
// WHY TWO SECRET CHANNELS, AND WHY THAT IS NOT BELT-AND-BRACES. The two are different mechanisms
// producing different observable outcomes, and the fixture needs BOTH:
//
//   (1) A DECLARED secret in the project's secrets file, referenced from the step text with the
//       runner's own `{{secret:NAME}}` syntax. The runner builds a `SecretRedactor` from that
//       store and rewrites the value to its named `[secret:NAME]` marker BEFORE anything is
//       recorded. So a declared secret proves the at-rest claim (it is never in clear) and can
//       never produce a `<SECRET_n>` placeholder — the redactor consumes it first. Measured, not
//       assumed: the redaction happens in the loop, the masking happens at bus projection, and
//       the loop runs first.
//
//   (2) An ambient CREDENTIAL-SHAPED environment variable handed to the spawned dashboard. Its
//       name ends in `_SECRET`, but it is not declared in the fixture's secrets file, and only a
//       value declared there is masked. It survives into the planner's reasoning
//       text and is recorded and shown as written.
//
// The email is undeclared too, so an address in the planner's reasoning is recorded and shown as
// written.
//
// AND ONE RUN THAT FAILS, ADDED BY 405-14. The run-detail page has a render site
// that only exists on a FAILED run — the failure banner — and it was the last site on the rebuilt
// page painting a producer string raw. Nothing could measure it, because the run above PASSES. So
// this module gained ONE additive knob, `startStubModelServer({ plannerOutcome: 'stepFailed' })`,
// which sets the shipped `stepFailed` plan field on the planner's tool call. The runner is
// untouched: that field is the product's own path to a step the planner declares impossible, and
// the run reaches `runFinished` with a member `testFinished.outcome === 'failed'` carrying a
// `failureSummary` that has masked placeholders in it.
//
// AND A MODEL THAT CAN AUTHOR, ADDED BY 406-07. The stub's fourth arm answers the
// analyze-run AUTHOR — the plain-text `generate` the post-run tail makes, carrying neither `tools`
// nor `response_format`. Its default (`analysisOutcome: 'floor'`) is the prose sentence every 405
// caller already gets, which `parseJsonWithRepair` rejects, so the author degrades to the
// deterministic floor and no verdict on the page ever says `analyze-run`.
// `startStubModelServer({ analysisOutcome: 'authored' })` answers that ONE request shape with a
// valid `OUTPUT_CONTRACT` object instead, recognised by the author's own `agent_context` line and
// grounded in a verbatim substring of `POPULATED_FAILURE_STEP_TEXT`; `citeEvidenceFrom` points it
// at the project root so the answer cites the run's REAL decision-screenshot sha. The arm sits
// between the structured arm and the text fallback, so every other request shape is answered
// exactly as before.
//
// THE FAILING RUN'S TWO SENTENCES ARE FIXTURE-OWNED — `plannerFailureReasoning()` and
// `POPULATED_FAILURE_STEP_TEXT` — and both are written to a WORD BUDGET the banner publishes
// (`FAILURE_BANNER_PREVIEW_WORDS`). `POPULATED_FAILURE_STEP_TEXT` carries the arithmetic in full.
// The rule that goes with it: a drift that moves the email marker past the preview budget is fixed
// in these two sentences, never by widening the banner.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { chromium } from 'playwright-core'
import {
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, RunEventEnvelope } from '@vostride/agent-qa-schema'

import { RUN_SERVICE_ANCHORED_BUILDS, trackTempRoot } from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

// ---- The declared vocabulary --------------------------------------------------------------------

/**
 * The ambient credential-shaped value. It is not declared in the fixture's secrets file, so it is
 * recorded as written.
 *
 * A THROWAWAY THIS REPOSITORY OWNS: it names nothing,
 * opens nothing, and exists only inside a temp project's child environment. It is deliberately
 * distinctive so a scan of `events.jsonl` or the SQLite bytes for it cannot match by accident.
 */
export const POPULATED_SECRET_VALUE = 'zz-405-populated-secret-7f3a91c2'

/**
 * The environment variable name the spawned dashboard carries it under. The `_SECRET` suffix makes
 * it credential-shaped by name; only a value declared in the fixture's secrets file is masked, so
 * the suffix alone masks nothing.
 */
export const POPULATED_SECRET_ENV_VAR = 'AGENT_QA_405_09_POPULATED_SECRET'

/** The name the project's secrets file declares — the handle the step text addresses. */
export const POPULATED_SECRET_NAME = 'POPULATED_STEP_SECRET'

/**
 * The DECLARED secret's value: the runner's own redaction lane, distinct from the masking lane.
 *
 * A SECOND VALUE RATHER THAN THE SAME ONE: a value declared in the secrets file is rewritten to
 * `[secret:<name>]` before it is recorded, so sharing one value between the two channels would
 * erase the contrast between a declared value and an undeclared one.
 */
export const POPULATED_DECLARED_SECRET_VALUE = 'zz-405-declared-secret-3c8e1f60'

/** The address planted in the page and in the planner's reasoning; masked to `<EMAIL_n>`. */
export const POPULATED_EMAIL = 'qa-person@example.com'

/**
 * The accessible name of the page's one button.
 *
 * ONE WORD, NO PUNCTUATION, DELIBERATELY. The stub resolves this label against the rendered
 * screen tree to emit a real `ref`, and a label carrying quotes or trailing punctuation would make
 * that resolution a string-normalisation puzzle rather than a lookup.
 */
export const POPULATED_BUTTON_LABEL = 'Acknowledge'

/** The named LLM entry the project declares and `use.llm` selects. */
export const POPULATED_MODEL_NAME = 'populated-stub'

/**
 * The model id the declared entry carries.
 *
 * IT CONTAINS `vision` FOR A REASON THE CAPABILITY TABLE OWNS. `resolveCapabilities` matches a
 * model id against family tokens at word boundaries and falls back to an UNKNOWN floor whose
 * `vision` is false. The run's vision gate is resolved from the CONFIG (`vision` defaults true),
 * so the image is attached either way — but the accounting ceilings come from the family, and the
 * unknown floor's 8192-token window would put the clamp into a degrade pass on every turn for no
 * reason anybody reading this file could have guessed. `stub-vision` resolves to the vision family
 * (128k window) and says out loud what it is.
 */
export const POPULATED_MODEL_ID = 'stub-vision'

/** The registry target name the test and suite address. */
export const POPULATED_TARGET_NAME = 'populated'

/** The suite file a populated run is triggered against, relative to the project root. */
export const POPULATED_SUITE_PATH = 'suites/populated.suite.yaml'

/** The test file the suite addresses, relative to the project root. */
export const POPULATED_TEST_PATH = 'tests/populated.test.yaml'

/**
 * The single step a FAILING populated run declares.
 *
 * THIS SENTENCE IS FIVE WORDS, AND THE COUNT IS LOAD-BEARING.
 * `generateFailureSummary` prints the step NAME first — `Step 1/1 "<name>" failed: ...` — and the
 * banner's collapsed state shows `FAILURE_BANNER_PREVIEW_WORDS` (20) words. The step text the
 * PASSING recipe ships (`populatedRunFixtureProject`'s default) is SIXTEEN words, which would spend
 * the budget before the planner's sentence began and leave the truncated banner with no marker to
 * paint. Five leaves room for the failure sentence's email marker to land inside the preview.
 *
 * THE ARITHMETIC, WRITTEN OUT SO THE DOM CELL'S CLAIM IS AUDITABLE BY READING. Measured rather than
 * counted by eye: `generateFailureSummary`'s format was executed over this module's own strings
 * with the two masking placeholders in the positions the seam puts them, and the result split the
 * way `truncateText` spends its budget (one word per whitespace-free token).
 * Three numbers in the block that stood here were wrong — the shipped step text's length, the
 * credential's distance from the marker, and a five-word claim positioned as if it justified the
 * first.
 *
 * On a `stepFailed` turn the loop returns `Step failed: <reasoning>` as the step error and records
 * `Planner signaled step failure: <reasoning>` on the sub-action, so the summary reads:
 *
 *   `Step`(1) `1/1`(2) `"Acknowledge`(3) `the`(4) `notice`(5) `using`(6) `{{secret:…}}."`(7)
 *   `failed:`(8) `Step`(9) `failed:`(10) `Cannot`(11) `acknowledge:`(12) `the`(13) `notice`(14)
 *   `names`(15) `<EMAIL_n>`(16) `as`(17) `contact,`(18) `the`(19) `operator`(20) `credential`(21)
 *   `is`(22) `<SECRET_n>,`(23)
 *
 * — the email marker at word 16, inside the budget; the masking-seeded credential at word 23, SEVEN
 * words past the marker and THREE past the preview budget, so it is visible only once a person
 * expands the banner. THOSE THREE WORDS OF MARGIN ARE THE WHOLE OF WHAT PROTECTS CELL (3e)'s
 * NEGATIVE ASSERTION — that the credential is NOT in the truncated banner — so an edit to
 * `generateFailureSummary`'s header format that spends three more words moves the credential into
 * the preview and reds it. A DRIFT THAT MOVES EITHER MARKER ACROSS WORD 20 IS FIXED HERE, in the
 * fixture's own sentences, and NEVER by widening the banner's budget: the budget is what a person
 * was shown, and editing it to make a cell green would be the cell changing the product to fit
 * itself.
 */
export const POPULATED_FAILURE_STEP_TEXT =
  `Acknowledge the notice using {{secret:${POPULATED_SECRET_NAME}}}.`

/**
 * The part of {@link POPULATED_FAILURE_STEP_TEXT} that survives SECRET REDACTION.
 *
 * WHY A PREFIX AND NOT THE WHOLE SENTENCE. The runner resolves `{{secret:NAME}}` and its
 * `SecretRedactor` rewrites the resolved value before anything is recorded or prompted, so the step
 * a planner is shown reads `Acknowledge the notice using [secret:POPULATED_STEP_SECRET].` — a
 * different string from the one this module declares. A stub arm keyed on the declared sentence
 * would never match. This prefix is the largest leading run that both spellings share.
 *
 * IT IS ALSO THE ONE THING THE FIXTURE'S TWO STEPS DO NOT SHARE. The passing recipe's default step
 * opens `Click the ${POPULATED_BUTTON_LABEL} button on the notice page.`; nothing in it contains
 * these four words, which is what lets one stub answer a two-member run with one failing member and
 * one passing one. See {@link StubModelServerOptions.failOnlyStepText}.
 */
export const POPULATED_FAILURE_STEP_MARKER = 'Acknowledge the notice using'

/**
 * The second, PASSING step a two-member populated run declares.
 *
 * A SECOND MEMBER EXISTS FOR ONE REASON, AND IT IS A RENDER SITE. `showMemberChrome` is
 * `members.length > 1`, so a single-member run paints NO `data-member` wrapper and NO
 * `data-member-outcome` badge at all — the per-member outcome the milestone's second success
 * criterion is about is simply not on the page. A cell that asserted "every member wears its
 * outcome" against one member would be asserting over an empty set and passing for nothing.
 *
 * IT DELIBERATELY DOES NOT CARRY {@link POPULATED_FAILURE_STEP_MARKER}, so the stub's
 * `failOnlyStepText` arm answers this turn `stepComplete` while the failing member's turn is
 * declared impossible. One run, two outcomes, one stub — which is also the contrast the failure
 * view is for: a red member with a sentence beside a green member with nothing to explain.
 */
export const POPULATED_PASSING_STEP_TEXT =
  `Click the ${POPULATED_BUTTON_LABEL} button and confirm the notice state changed.`

/**
 * How long ONE populated run has to reach `runFinished` on the local run-stream door.
 *
 * Longer than the drainable fixture's 90s because this run actually launches Chromium, loads a
 * page, screenshots it and crosses two loopback sockets per planning turn. A timeout is a RED
 * naming the last envelope seen, never a skip.
 */
export const RUN_BUDGET_MS = 120_000

/**
 * The built artifacts a populated-run cell executes.
 *
 * WIDER THAN `RUN_SERVICE_ANCHORED_BUILDS`, and the addition is the whole reason this run differs
 * from that one: a populated run drives a real browser through the `web` adapter's dist and writes
 * its evidence blobs through `runner-local`'s, both resolved as external workspace dependencies by
 * the spawned binary. `model` and `safety` are listed for the same reason one level down — the
 * provider handle and the masking context this fixture's two claims rest on are built there, and a
 * cell run against a stale dist of either would certify the previous revision of the exact code it
 * is measuring.
 */
export const POPULATED_RUN_ANCHORED_BUILDS: readonly {
  readonly pkg: string
  readonly artifact: string
}[] = Object.freeze([
  ...RUN_SERVICE_ANCHORED_BUILDS,
  Object.freeze({ pkg: 'web', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'runner-local', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'model', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'safety', artifact: join('dist', 'index.js') }),
])

/**
 * Where the browser binaries this machine actually has are rooted.
 *
 * WHY THIS IS NEEDED AT ALL, MEASURED RATHER THAN GUESSED. `hermeticEnv` points the child's `HOME`
 * INTO the fixture project so nothing it writes escapes the directory the cleanup deletes — which
 * is exactly right, and it also relocates the default Playwright browser cache (`$HOME/Library/
 * Caches/ms-playwright` on macOS, `$HOME/.cache/ms-playwright` on Linux) to an empty directory
 * inside the temp root. The first draft of this fixture therefore reached a verdict in 233ms with
 * `member-executor-error: agent-qa browser support is not installed for Chromium` on a machine
 * where Chromium is plainly installed. The child inherits the ROOT this process resolves so its
 * `HOME` can stay hermetic without lying to it about the browsers.
 *
 * DERIVED FROM THE RESOLVER RATHER THAN REBUILT. `chromium.executablePath()` is Playwright's own
 * answer, and the browsers root is the parent of the revision directory inside it; walking up to
 * the first `chromium`-prefixed segment finds it without this file owning a second copy of the
 * platform-by-platform cache layout. An explicit `PLAYWRIGHT_BROWSERS_PATH` in this process wins,
 * because a caller who set one meant it.
 */
function playwrightBrowsersRoot(): string | undefined {
  const declared = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (declared !== undefined && declared.trim() !== '') return declared
  let executable: string
  try {
    executable = chromium.executablePath()
  } catch {
    // No installed browser to point at. The child is handed nothing and reds with the install
    // instruction the run itself prints — which is the honest answer, not a fabricated path.
    return undefined
  }
  let current = dirname(executable)
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return undefined
    if (basename(current).startsWith('chromium')) return parent
    current = parent
  }
}

/**
 * The extra environment the spawned dashboard is handed.
 *
 * A FUNCTION RATHER THAN A CONSTANT so a caller cannot mutate the map every cell shares, and so
 * the one place that decides which variables the child inherits stays here rather than being
 * spelled out in each cell that spawns one. Two variables, for two unrelated reasons: the
 * credential-shaped one is the fixture's masking seed (see this file's header), and the browsers
 * root undoes the one side effect of the hermetic `HOME` that this run cannot live with.
 */
export function populatedRunSpawnEnv(): Record<string, string> {
  const browsersRoot = playwrightBrowsersRoot()
  return {
    [POPULATED_SECRET_ENV_VAR]: POPULATED_SECRET_VALUE,
    ...(browsersRoot === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: browsersRoot }),
  }
}

// ---- The target page ----------------------------------------------------------------------------

const TARGET_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Populated run target</title></head>',
  '<body>',
  '<h1>Populated run target</h1>',
  `<p id="notice">Support contact: ${POPULATED_EMAIL}</p>`,
  `<button type="button" id="ack">${POPULATED_BUTTON_LABEL}</button>`,
  '<p id="ack-state">Notice pending</p>',
  '<script>',
  "document.getElementById('ack').addEventListener('click', function () {",
  "  document.getElementById('ack-state').textContent = 'Notice acknowledged'",
  '})',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n')

/** A started loopback server, as the cells that drive it consume it. */
export interface FixtureServer {
  /** The origin a client is pointed at, with no trailing slash. */
  readonly url: string
  readonly port: number
  /** Idempotent: safe to call from a cell body and from an `afterAll`. */
  close(): Promise<void>
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise<number>((settle, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        fail(new TypeError('the fixture server bound no port'))
        return
      }
      settle(address.port)
    })
  })
}

function closer(server: Server): () => Promise<void> {
  let closed: Promise<void> | undefined
  return async (): Promise<void> => {
    closed ??= new Promise<void>((settle) => {
      server.closeAllConnections?.()
      server.close(() => { settle() })
    })
    await closed
  }
}

/**
 * Serve ONE static page a browser can load, click and screenshot.
 *
 * EVERY PATH ANSWERS THE SAME DOCUMENT, deliberately: a favicon request or a stray navigation is
 * not a failure of anything this fixture is about, and a 404 in the browser's console is noise a
 * later reader would spend time on.
 */
export async function startTargetPageServer(): Promise<FixtureServer> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(TARGET_PAGE_HTML)
  })
  const port = await listenOnLoopback(server)
  return { url: `http://127.0.0.1:${String(port)}`, port, close: closer(server) }
}

// ---- The stub model server ----------------------------------------------------------------------

/** What one request to the stub was, as the cell that reports a refusal consumes it. */
export interface RecordedStubRequest {
  readonly at: number
  readonly method: string
  readonly path: string
  /** Which arm answered it — the dispatch decision, recorded rather than re-derived. */
  readonly kind:
    | 'planner'
    | 'held'
    | 'held-analysis'
    | 'structured'
    | 'analysis'
    | 'curator'
    | 'text'
    | 'unknown'
  readonly status: number
  /** Whether the planner arm resolved a live `ref` out of the observation, or fell back. */
  readonly grounding?: 'ref' | 'descriptor'
  /**
   * The request body, bounded.
   *
   * BOUNDED BECAUSE A PLANNING TURN CARRIES A BASE64 SCREENSHOT, and an unbounded echo of one into
   * a failure message is megabytes of noise around the sentence that matters.
   */
  readonly body: string
  // the whole body, recorded only under `fullBodies`.
  readonly fullBody?: string
}

const MAX_RECORDED_BODY_CHARS = 4_000

/** A started stub model server plus the trail it recorded. */
export interface StubModelServer extends FixtureServer {
  /** The `baseURL` the declared model entry points at — includes the `/v1` prefix. */
  readonly baseUrl: string
  /** Every request this server answered, in arrival order. */
  readonly requests: readonly RecordedStubRequest[]
  /**
   * Point the `authored` arm at a project's `.agent-qa` root so its answer can cite the run's own
   * decision screenshot.
   *
   * A SETTER RATHER THAN AN OPTION because the ordering forces it: the stub must be listening
   * before the project is minted (the project's config names the stub's port), so the root does
   * not exist at `startStubModelServer` time. Unset — or set to a root with no
   * recorded decision screenshot with bytes in `runs/<slug>/blobs/` — the answer cites nothing,
   * which is the honest empty `citedArtifacts` the validator also accepts.
   */
  citeEvidenceFrom(agentQaRoot: string): void
  // the planning turns `holdOnlyStepText` parked.
  readonly held: StubHeldTurns
}

export interface StubHeldTurns {
  arrived(): Promise<void>
  count(): number
  aborted(): number
  release(): void
  // answer every turn still parked with a 400 and keep the hold armed;
  // returns how many turns it refused.
  refuse(): number
}

interface ChatCompletionsBody {
  readonly model?: unknown
  readonly messages?: unknown
  readonly tools?: unknown
  readonly tool_choice?: unknown
  readonly response_format?: unknown
}

/** Collect every text part of every message, in order, as one string. */
/** The first line of the verifier turn's final screen, or the step record's action outcome. */
function finalScreenCitation(prompt: string): { source: string; quote: string } {
  const header = 'Screen now (settled, after the last action):'
  const at = prompt.indexOf(header)
  const line = at < 0
    ? undefined
    : prompt.slice(at + header.length).split('\n')
      .map((text) => text.trim().replace(/^- /, ''))
      .find((text) => text.replace(/\s/g, '').length >= 3)
  return line === undefined
    ? { source: 'action', quote: '→ success' }
    : { source: 'final-screen', quote: line.slice(0, 200) }
}

function promptTextOf(body: ChatCompletionsBody): string {
  if (!Array.isArray(body.messages)) return ''
  const parts: string[] = []
  for (const message of body.messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const text = (part as { type?: unknown; text?: unknown } | null)
      if (text?.type === 'text' && typeof text.text === 'string') parts.push(text.text)
    }
  }
  return parts.join('\n')
}

/**
 * Find the live `ref` the shipped screen renderer minted for a labelled element.
 *
 * WHY THE STUB READS THE OBSERVATION AT ALL. A canned `target` descriptor would make every run
 * depend on the grounding matcher resolving a role/name pair, and a matcher miss returns a
 * structured `ungroundable_action` failure that records NO sub-action — which is precisely the
 * fact this whole fixture exists to produce. Reading the ref out of the tree the planner was just
 * shown is what a model does, so the stub does it too. The descriptor remains the fallback, so a
 * renderer change that moves the ref out of the prompt degrades to the matcher rather than to a
 * dead run.
 *
 * The line shape is `renderScreenTree`'s own: `- <role> "<name>" [ref=<ref>] @(...)`.
 */
function refForLabel(prompt: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`- \\w+ "${escaped}"[^\\n]*?\\[ref=([A-Za-z0-9_-]+)\\]`, 'u')
  return pattern.exec(prompt)?.[1]
}

/** The action tool the planner arm calls, as the provider named it on this request. */
function clickToolName(body: ChatCompletionsBody): string | undefined {
  if (!Array.isArray(body.tools)) return undefined
  for (const entry of body.tools) {
    const name = (entry as { function?: { name?: unknown } } | null)?.function?.name
    if (typeof name === 'string' && name === 'web_click') return name
  }
  return undefined
}

/**
 * The planner's reasoning text — the ONE string this fixture plants both categories in.
 *
 * IT IS THE PLANNER'S, NOT THE PAGE'S, AND THAT IS THE POINT. `plan` on a `subActionRecorded`
 * payload is the planner's reasoning, redacted by the runner and then masked at projection. Text
 * that only ever lived on the page would reach the wire as a screen-state HASH and prove nothing
 * about either masking category.
 */
function plannerReasoning(): string {
  return (
    `Clicking the "${POPULATED_BUTTON_LABEL}" button on the notice page. `
    + `The operator credential for this environment is ${POPULATED_SECRET_VALUE} and the `
    + `notice names ${POPULATED_EMAIL} as the contact; the declared step credential resolves to `
    + `${POPULATED_DECLARED_SECRET_VALUE}. None of the three may ever be recorded in clear.`
  )
}

/**
 * The measured ANLZ-01 leaf — a MEMORY-RETRIEVAL RELEVANCE SCORE, carried into this fixture's
 * analyze-run prompt on purpose.
 *
 * WHY A FIXTURE CARRIES A FLOAT AT ALL. The 399 defect was not "the analyze-run job throws"; it was
 * "the egress guardrail reads a printed float as a credit card". 406-07 measured the three literals
 * that blocked three permanently-failed `analyze-run` jobs — `1.1428571428571428` (8/7),
 * `1.4869565217391303` and this one — every one of them a `retrievalTrace.servedLines[].score` in
 * the failing step's memory channel, whose Luhn-valid 16-digit fraction is all
 * `CREDIT_CARD_CANDIDATE_RE` can see across the dot. Without such a literal in the prompt, a
 * shipped-binary cell that watches the job row complete measures the AUTHORING PATH and not the
 * guardrail: 406-11 reverted 406-07's fix, rebuilt, and the whole ten-cell suite stayed GREEN.
 * That is the measurement this constant answers.
 *
 * WHY IT RIDES THE PLANNER'S RECORDED REASONING RATHER THAN A RETRIEVAL TRACE. This fixture mints
 * an EMPTY `agent-qa-knowledge` directory, so no memory is served and `pack.memory` carries no
 * trace to plant a score in. The nearest carrier that reaches the same place is the planner's own
 * recorded reasoning: `subActions[].plan` is quoted verbatim into every evidence pack
 * (`evidence-diet.ts` `quoteStep`) and the packs ARE the author's volatile tier
 * (`analyze-run-author.ts` `volatileTier`). It is the failing arm's sentence, so only the RED
 * drive's prompt carries it and the green control's planning turns are byte-identical to what they
 * have always been.
 *
 * IT MUST STAY DELIMITED ON BOTH SIDES, and a trailing full stop would break that. `isFractionalTail`
 * requires the fraction's right-hand neighbour to be a delimiter and treats `.` as NOT one (a dotted
 * chain is a version string, not a float), so `relevance 1.0285714285714285.` BLOCKS AT HEAD and
 * would red this fixture's own preflight. The sentence below therefore continues after the number.
 * Measured through the real `scan()` under the default policy: `pass` at HEAD, `block` /
 * `creditCard` with 406-07's fix reverted.
 */
export const POPULATED_RETRIEVAL_SCORE = '1.0285714285714285'

/**
 * The planner's reasoning on the arm that DECLARES THE STEP IMPOSSIBLE.
 *
 * THE SAME THREE PLANTED VALUES, RE-ORDERED — and the order is the only difference that matters.
 * `plannerReasoning` opens with the button sentence and reaches the email TWENTY-ONE words in,
 * which on a failure summary — whose first eight words are the step header and whose next two are
 * the loop's own `Step failed:` — would put the marker at word 31, well outside the banner's
 * 20-word preview (measured the same way as the block in {@link POPULATED_FAILURE_STEP_TEXT}). This sentence leads with the email so the TRUNCATED banner has a chip
 * to paint, and leaves the masking-seeded credential far enough back that it is visible only in the
 * expanded state — which is what makes cells (3c) and (3e) two different claims rather than one.
 *
 * See {@link POPULATED_FAILURE_STEP_TEXT} for the word-by-word arithmetic this ordering satisfies.
 */
function plannerFailureReasoning(): string {
  return (
    `Cannot acknowledge: the notice names ${POPULATED_EMAIL} as contact, the operator `
    + `credential is ${POPULATED_SECRET_VALUE}, and the declared step credential resolves to `
    + `${POPULATED_DECLARED_SECRET_VALUE}. None of the three may ever be recorded in clear. `
    // APPENDED, NEVER INTERLEAVED. Every word position the block above measures — the
    // email at 21, the masking-seeded credential at 23, both relative to the banner's published
    // preview budget — is a position from the FRONT, so the leaf rides at the back where it moves
    // none of them. See {@link POPULATED_RETRIEVAL_SCORE} for why the sentence continues after the
    // number rather than ending on it.
    + `Memory retrieval served this step with relevance ${POPULATED_RETRIEVAL_SCORE} for the `
    + `notice brief.`
  )
}

/**
 * The marker the `authored` arm recognises the analyze-run author's request by.
 *
 * IT IS THE AUTHOR'S OWN `agent_context` LINE, copied verbatim from
 * `agent/src/jobs/analyze-run-author.ts` (`authorRunAnalysis`'s default `agent_context`), and
 * spelled as a named constant so a rename there is found by one grep rather than by a red run
 * three plans later. Matching on the line rather than on "no tools and no response_format" keeps
 * the arm precise: any OTHER plain-text call the product makes still falls through to the prose
 * fallback below, exactly as it did before this arm existed.
 */
export const ANALYSIS_PROMPT_MARKER = 'analyze-run: authoring root-cause verdicts'

// the curator author's own first instruction line
// (`cli/src/curation/curator-author.ts`, `authoringInstructions`).
export const CURATOR_PROMPT_MARKER = 'You are the agent-qa Curator.'

// The first neighbor a curator prompt presents, read from `renderNeighbor`'s lines.
function firstPresentedNeighbor(
  prompt: string,
): { alias: number; kind: string; subtype?: string; anchors: unknown } | undefined {
  const match = /^Alias (\d+)\nkind: ([a-z]+)(?:\/([a-z]+))?\nsummary: .*\nanchors: (.+)$/mu.exec(prompt)
  if (match === null) return undefined
  return {
    alias: Number(match[1]),
    kind: match[2]!,
    ...(match[3] === undefined ? {} : { subtype: match[3] }),
    anchors: JSON.parse(match[4]!) as unknown,
  }
}

/**
 * The grounding quote the scripted verdict cites.
 *
 * A VERBATIM CONTIGUOUS SUBSTRING of {@link POPULATED_FAILURE_STEP_TEXT}, which is what
 * `validateAnalysisAgainstHandoff` demands of a `stepText`-sourced quote. A quote the validator
 * rejects degrades that member to the deterministic floor, and the run-detail cell can then never
 * see `producer: 'analyze-run'` — so the substring relation is pinned by a static cell rather than
 * trusted.
 */
export const POPULATED_FAILURE_QUOTE = 'Acknowledge the notice'

/** The scripted verdict's rationale — advisory, never rendered as the sentence. */
export const POPULATED_ANALYSIS_RATIONALE =
  'The planner declared the step impossible on a page that rendered normally.'

/** The scripted verdict's discriminator — the run-detail cell asserts the sentence carries it. */
export const POPULATED_ANALYSIS_DISCRIMINATOR =
  'the same step completed on the previous build of this notice page'

/** The scripted verdict's one concrete next action. */
export const POPULATED_ANALYSIS_NEXT_ACTION =
  'open the notice page and confirm the acknowledge control is reachable'

/** A 64-hex sha, the only name shape `FsEvidenceArtifactStore` addresses a blob by. */
const BLOB_SHA_RE = /^[0-9a-f]{64}$/u

/**
 * Every recorded decision-screenshot ref this project's ONE run wrote, read at answer time.
 *
 * READ LATE, NEVER CACHED. The blobs are written by the run the cell is currently driving, so a
 * value captured when the root was registered would always be empty. Absent directories answer
 * `[]` rather than throwing: a stub that threw here would hang the run instead of failing it, and
 * an empty `citedArtifacts` is a shape the validator accepts. The blob directory also contains
 * JSON evidence, so the handoff's typed screenshot refs own selection, never directory order.
 */
function decisionScreenshotRefs(agentQaRoot: string | undefined): { id: string; sha: string }[] {
  if (agentQaRoot === undefined) return []
  try {
    const runsRoot = join(agentQaRoot, 'runs')
    const runDir = readdirSync(runsRoot, { withFileTypes: true }).find((entry) =>
      entry.isDirectory(),
    )
    if (runDir === undefined) return []
    const dir = join(runsRoot, runDir.name)
    const blobShas = new Set(readdirSync(join(dir, 'blobs'))
      .filter((name) => BLOB_SHA_RE.test(name)))
    const handoff = JSON.parse(readFileSync(join(dir, 'handoff.json'), 'utf8')) as CompletedRunHandoff
    const refs = new Map<string, { id: string; sha: string }>()
    for (const test of handoff.tests) {
      for (const step of test.steps) {
        for (const subAction of step.subActions) {
          const ref = subAction.decisionScreenshotRef
          if (ref !== undefined && BLOB_SHA_RE.test(ref.sha)
            && ref.id === `decision-screenshot:${ref.sha}` && blobShas.has(ref.sha)) {
            refs.set(ref.sha, { id: ref.id, sha: ref.sha })
          }
        }
      }
    }
    return [...refs.values()]
  } catch {
    return []
  }
}

/** The `OUTPUT_CONTRACT` object the `authored` arm answers with. */
function authoredVerdictAnswer(citedArtifacts: readonly { id: string; sha: string }[]): string {
  return JSON.stringify({
    tests: [
      {
        testIndex: 0,
        class: 'app_bug',
        confidence: 0.86,
        memoryMisdirectionRuledOut: true,
        citedSteps: [0],
        citedArtifacts,
        rationale: POPULATED_ANALYSIS_RATIONALE,
        groundingQuote: { stepIndex: 0, quote: POPULATED_FAILURE_QUOTE },
        discriminator: POPULATED_ANALYSIS_DISCRIMINATOR,
        nextAction: POPULATED_ANALYSIS_NEXT_ACTION,
        links: [],
      },
    ],
  })
}

function chatCompletion(
  model: string,
  message: Record<string, unknown>,
  finishReason: string,
  usage: { prompt: number; completion: number },
): Record<string, unknown> {
  return {
    id: 'chatcmpl-405-09-populated',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    // NON-ZERO INTEGERS ON EVERY ARM. `tokenUsage` on `stepFinalized` is summed from the usage the
    // provider reports, and a zero triple is indistinguishable from an unmeasured step under the
    // absent-is-not-zero rule 405-01 established — so a stub that reported zeros would make the
    // token cell vacuous while looking like it passed.
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answer the three request shapes the shipped run makes, from canned responses.
 *
 * THE DISPATCH IS ON THE REQUEST BODY, never on a call counter. A counter would encode the order
 * this fixture happened to observe once and would answer the wrong thing the day the loop replans
 * or the tail authors a summary. The three shapes are the product's three model call sites:
 *
 *   - `tools` present  ⇒ the PLANNER turn (`toolChoice: 'required'` over the action slice). One
 *     `tool_calls[]` entry naming `web_click`, with the plan-field envelope every action tool
 *     carries and `stepComplete: true` so one turn finishes the step.
 *   - `response_format` present ⇒ a STRUCTURED-OUTPUT call (the verifier's `Output.object`). The
 *     assistant content is the JSON the verification schema parses.
 *   - neither ⇒ a plain TEXT completion (the post-run analysis author's `generate`). Answered
 *     with a short sentence, because a 400 here would turn a perfectly ordinary tail call into a
 *     fixture failure that reads like a product defect.
 *
 * ANYTHING ELSE IS A 400 CARRYING THE BODY, never a silent 200: a shape this stub does not
 * understand is a fact the cell must be able to read, and a fabricated success would be the stub
 * inventing product behaviour.
 */
/**
 * What the stub is asked to be, on the ONE axis a caller may move.
 *
 * ADDITIVE, WITH THE PASSING BEHAVIOUR AS THE DEFAULT. Every 405-09 and 405-12 caller passes
 * nothing and gets byte-for-byte the run it had: the same canned responses, the same usage triples,
 * the same grounding. The knob exists because the run-detail page has a render site — the failure
 * banner — that only exists on a FAILED run, and a second whole fixture would be a second answer to
 * "what did the door open" for a difference of one boolean in one tool-call argument.
 */
export interface StubModelServerOptions {
  /**
   * Which plan field the planner arm sets: finish the step, or declare it impossible.
   *
   * `'stepFailed'` sets `stepFailed: true` with `stepComplete: false`, which the runner loop reads
   * at `loop/index.ts` — it records ONE sub-action carrying `Planner signaled step failure: …` and
   * fails the step WITHOUT executing the action. Nothing in the runner changes to produce this: it
   * is the shipped `stepFailed` path, driven from the wire the way a model would drive it.
   *
   * DELIBERATELY NOT `failureKind: 'infeasible'`. That fork records a typed termination block and
   * returns a different verdict sentence; this fixture wants the ORDINARY failure, because the
   * ordinary failure is the one every failing run in the field produces.
   */
  readonly plannerOutcome?: 'stepComplete' | 'stepFailed'
  /**
   * Narrow `plannerOutcome: 'stepFailed'` to the planning turns of ONE step.
   *
   * ADDITIVE, WITH TODAY'S BEHAVIOUR AS THE DEFAULT. Unset — every 405-14 caller — the failing arm
   * answers every planning turn exactly as it did, so a one-member failing run is byte-identical.
   * Set, a turn whose collected prompt does NOT carry this text is answered `stepComplete`, which
   * is how a TWO-member run gets one failed member and one passed one out of a single stub.
   *
   * THE DISPATCH IS STILL ON THE REQUEST BODY, never on a call counter — this module's own law. The
   * text a caller passes must be one that survives the runner's secret redaction, which is what
   * {@link POPULATED_FAILURE_STEP_MARKER} is for.
   */
  readonly failOnlyStepText?: string
  /**
   * What the analyze-run AUTHOR is answered with.
   *
   * ADDITIVE, WITH TODAY'S BEHAVIOUR AS THE DEFAULT. `'floor'` — the default, and what every
   * 405-09 / 405-12 / 405-14 caller that passes nothing gets — answers the author's plain-text
   * `generate` with the same canned prose as before, which the author cannot parse, so its member
   * keeps the deterministic floor. `'authored'` answers that ONE request shape with a valid
   * `OUTPUT_CONTRACT` object instead, so the persisted verdict carries `producer: 'analyze-run'`
   * and the failure view has an authored sentence to render.
   */
  // `'error'` refuses that one request shape with a 400.
  readonly analysisOutcome?: 'floor' | 'authored' | 'error'
  // record each request's whole body beside the bounded one.
  readonly fullBodies?: boolean
  // a planning turn whose prompt carries this text is not answered until
  // `held.release()`; like `failOnlyStepText`, it must survive the runner's secret redaction.
  readonly holdOnlyStepText?: string
  // the analyze-run author's request (the `ANALYSIS_PROMPT_MARKER` arm)
  // is parked with the held turns; `held.release()` answers it through the analysis arms below.
  readonly holdAnalysis?: boolean
  // a curator request (the `CURATOR_PROMPT_MARKER` arm) that presents a
  // neighbor is answered with a Supersede of the first one; one presenting none gets the prose.
  readonly curatorOutcome?: 'supersede-first'
}

export async function startStubModelServer(
  options: StubModelServerOptions = {},
): Promise<StubModelServer> {
  const plannerOutcome = options.plannerOutcome ?? 'stepComplete'
  const analysisOutcome = options.analysisOutcome ?? 'floor'
  const { failOnlyStepText, holdOnlyStepText } = options
  const requests: RecordedStubRequest[] = []
  let citedRoot: string | undefined
  const parked: Array<{
    readonly res: ServerResponse
    readonly answer: () => void
    readonly refuse: () => void
  }> = []
  let heldCount = 0
  let abortedCount = 0
  let released = false
  let markArrived: () => void = () => undefined
  const firstArrival = new Promise<void>((settle) => { markArrived = settle })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req)
      const path = req.url ?? ''
      const method = req.method ?? 'GET'
      const record = (
        kind: RecordedStubRequest['kind'],
        status: number,
        grounding?: 'ref' | 'descriptor',
      ): void => {
        requests.push({
          at: Date.now(),
          method,
          path,
          kind,
          status,
          ...(grounding === undefined ? {} : { grounding }),
          body: raw.slice(0, MAX_RECORDED_BODY_CHARS),
          ...(options.fullBodies === true ? { fullBody: raw } : {}),
        })
      }
      const refuse = (why: string): void => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: why, type: 'invalid_request_error' } }))
      }

      if (method !== 'POST' || !path.startsWith('/v1/chat/completions')) {
        record('unknown', 400)
        refuse(`the populated-run stub serves POST /v1/chat/completions only; got ${method} ${path}`)
        return
      }

      let body: ChatCompletionsBody
      try {
        body = JSON.parse(raw) as ChatCompletionsBody
      } catch {
        record('unknown', 400)
        refuse('the populated-run stub could not parse the request body as JSON')
        return
      }

      const model = typeof body.model === 'string' ? body.model : POPULATED_MODEL_ID
      const prompt = promptTextOf(body)
      const respond = (payload: Record<string, unknown>): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const toolName = clickToolName(body)
        if (toolName === undefined) {
          record('unknown', 400)
          refuse(
            'the populated-run stub found no `web_click` entry in the bound tool surface; the '
            + 'action slice this fixture drives has moved and the fixture must be re-measured '
            + 'rather than downgraded to a provider-gated cell',
          )
          return
        }
        const ref = refForLabel(prompt, POPULATED_BUTTON_LABEL)
        const targeting = ref === undefined
          ? { target: { role: 'button', name: POPULATED_BUTTON_LABEL } }
          : { ref }
        const answerPlanner = (failing: boolean): void => {
          const args = {
            ...targeting,
            elementDescription: POPULATED_BUTTON_LABEL,
            reasoning: failing ? plannerFailureReasoning() : plannerReasoning(),
            confidence: 0.95,
            stepComplete: !failing,
            ...(failing ? { stepFailed: true } : {}),
            doesActionAdvanceUsTowardsGoal: !failing,
          }
          record('planner', 200, ref === undefined ? 'descriptor' : 'ref')
          respond(chatCompletion(
            model,
            {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_405_09_click',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              }],
            },
            'tool_calls',
            { prompt: 1_311, completion: 87 },
          ))
        }
        if (holdOnlyStepText !== undefined && !released && prompt.includes(holdOnlyStepText)) {
          record('held', 0, ref === undefined ? 'descriptor' : 'ref')
          heldCount += 1
          res.once('close', () => {
            if (!res.writableEnded) abortedCount += 1
          })
          parked.push({
            res,
            answer: () => { answerPlanner(false) },
            refuse: () => {
              record('planner', 400)
              refuse('the populated-run stub refuses a held planning turn on purpose')
            },
          })
          markArrived()
          return
        }
        // The step-scoped narrowing, spelled where the outcome is decided rather than at
        // the option, so a turn the caller did not name is answered by the ORDINARY arm.
        answerPlanner(plannerOutcome === 'stepFailed'
          && (failOnlyStepText === undefined || prompt.includes(failOnlyStepText)))
        return
      }

      if (body.response_format !== undefined && body.response_format !== null) {
        record('structured', 200)
        respond(chatCompletion(
          model,
          {
            role: 'assistant',
            content: JSON.stringify({
              // the verification lane answers per condition.
              // the quote is the whole step, so every step word is covered.
              conditions: [{
                quote: /^Step goal: "(.*)"$/m.exec(prompt)?.[1] ?? POPULATED_BUTTON_LABEL,
                verdict: 'met',
                needs: 'none',
                controlRef: '',
                file: { name: '', match: 'none', text: '' },
                // a line of the final screen, which every verification turn
                // carries; a give-up the verifier now judges records no action to cite.
                citations: [finalScreenCitation(prompt)],
                reasoning: 'The notice state changed.',
              }],
              dialogs: [],
              reasoning: `The "${POPULATED_BUTTON_LABEL}" button was clicked and the notice state changed.`,
              isAppError: false,
              // The judge/extractor lanes share this arm; their schemas are supersets of the
              // verification one and ignore members they do not declare, so one canned object
              // answers all three without the stub having to know which lane called it.
              verdict: true,
              rationale: 'The notice acknowledges on the observed screen.',
            }),
          },
          'stop',
          { prompt: 742, completion: 41 },
        ))
        return
      }

      const answerText = (): void => {
        // The FOURTH arm, between `structured` and the prose fallback. It is
        // reached only when the caller asked for it AND the prompt carries the author's own
        // `agent_context` line, so every other plain-text call still lands on the fallback below.
        if (analysisOutcome === 'authored' && prompt.includes(ANALYSIS_PROMPT_MARKER)) {
          record('analysis', 200)
          respond(chatCompletion(
            model,
            {
              role: 'assistant',
              content: authoredVerdictAnswer(decisionScreenshotRefs(citedRoot)),
            },
            'stop',
            { prompt: 3_402, completion: 196 },
          ))
          return
        }

        if (analysisOutcome === 'error' && prompt.includes(ANALYSIS_PROMPT_MARKER)) {
          record('analysis', 400)
          refuse('the populated-run stub refuses the analyze-run author on purpose')
          return
        }
        const victim = options.curatorOutcome === 'supersede-first'
          && prompt.includes(CURATOR_PROMPT_MARKER)
          ? firstPresentedNeighbor(prompt)
          : undefined
        if (victim !== undefined) {
          record('curator', 200)
          respond(chatCompletion(
            model,
            {
              role: 'assistant',
              content: JSON.stringify({
                kind: 'Supersede',
                citedAliases: [victim.alias],
                victimAlias: victim.alias,
                newBundle: {
                  kind: victim.kind,
                  ...(victim.subtype === undefined ? {} : { subtype: victim.subtype }),
                  anchors: victim.anchors,
                  summary: `The "${POPULATED_BUTTON_LABEL}" button acknowledges the notice on this page.`,
                  body: `Clicking "${POPULATED_BUTTON_LABEL}" changes the notice state.`,
                },
              }),
            },
            'stop',
            { prompt: 1_024, completion: 96 },
          ))
          return
        }
        record('text', 200)
        respond(chatCompletion(
          model,
          { role: 'assistant', content: 'The populated conformance run acknowledged one notice.' },
          'stop',
          { prompt: 208, completion: 12 },
        ))
      }

      if (options.holdAnalysis === true && !released && prompt.includes(ANALYSIS_PROMPT_MARKER)) {
        record('held-analysis', 0)
        heldCount += 1
        res.once('close', () => {
          if (!res.writableEnded) abortedCount += 1
        })
        parked.push({
          res,
          answer: answerText,
          refuse: () => {
            record('analysis', 400)
            refuse('the populated-run stub refuses the held analyze-run author on purpose')
          },
        })
        markArrived()
        return
      }
      answerText()
    })().catch(() => {
      // A stub that threw mid-response would hang the run rather than fail it. The refusal is the
      // honest answer and the recorded trail carries the shape that produced it.
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { message: 'the populated-run stub failed mid-response' } }))
    })
  })

  const port = await listenOnLoopback(server)
  const origin = `http://127.0.0.1:${String(port)}`
  return {
    url: origin,
    baseUrl: `${origin}/v1`,
    port,
    requests,
    citeEvidenceFrom: (agentQaRoot: string) => {
      citedRoot = agentQaRoot
    },
    held: {
      arrived: () => firstArrival,
      count: () => heldCount,
      aborted: () => abortedCount,
      release: () => {
        released = true
        for (const turn of parked.splice(0)) {
          if (!turn.res.destroyed && !turn.res.writableEnded) turn.answer()
        }
      },
      refuse: () => {
        let refused = 0
        for (const turn of parked.splice(0)) {
          if (turn.res.destroyed || turn.res.writableEnded || turn.res.socket?.destroyed === true) continue
          turn.refuse()
          refused += 1
        }
        return refused
      },
    },
    close: closer(server),
  }
}

// ---- The project recipe -------------------------------------------------------------------------

/** The paths a populated-run cell reads back off the project it built. */
export interface PopulatedRunProject {
  readonly root: string
  readonly configPath: string
  /** `<root>/.agent-qa` — the runtime root the run directory and the SQLite file live under. */
  readonly agentQaRoot: string
  readonly suitePath: string
  readonly testPath: string
  readonly testId: string
  /** The second member's id — present exactly when `secondStepText` was asked for. */
  readonly secondTestId?: string
}

/** The second test file a two-member populated run declares, relative to the project root. */
export const POPULATED_SECOND_TEST_PATH = 'tests/populated-second.test.yaml'

/**
 * A project whose dashboard-triggered SUITE run executes one live planning turn against a page.
 *
 * A FIFTH RECIPE RATHER THAN A FLAG ON THE FOURTH, on `drainableSuiteFixtureProject`'s own
 * argument for being a fourth. Both of that recipe's fixed points are wrong here: its target is
 * `https://conformance.invalid` and its model base URL is a port nothing serves, and BOTH of this
 * fixture's addresses are ephemeral ports learned at runtime. A recipe whose two defining values
 * are arguments is not the same recipe with an option; it is a different answer to "what did the
 * door open", and this module's law is that each such answer is written once.
 *
 * `environment: 'local'` ON THE TARGET IS LOAD-BEARING for the reason `runServiceFixtureProject`
 * records in full: the run gate folds the most restrictive declared target class, and only an
 * all-local invocation is decided `mutating-local` — the tier allowed in this door's fail-closed
 * `local-headless` context. An undeclared target classifies the run `mutating-shared`, which is a
 * DENIAL, and a denied run never starts.
 *
 * `hooks: []` AND NOT `hooks: {}`, measured by 404-08 rather than copied: a run VALIDATES the
 * hooks document and the mapping form fails that validation, which this door flattens into a
 * `500 run_start_failed` carrying no diagnosis at all.
 */
export function populatedRunFixtureProject(
  label: string,
  addresses: { readonly modelBaseUrl: string; readonly targetUrl: string },
  /**
   * The single step line the test file declares.
   *
   * A THIRD PARAMETER RATHER THAN A SIXTH RECIPE, on this module's own law read the other way: the
   * recipe's defining values are its two ADDRESSES, and both callers pass the same kind of address.
   * The step sentence is a payload, not a fixed point, and a caller who needs a shorter one is
   * asking the same door to open on a different word — not a different door.
   */
  options: {
    readonly stepText?: string
    /**
     * A SECOND test's step line, which makes this run a two-member one.
     *
     * ADDITIVE AND ABSENT BY DEFAULT, so every 405 caller gets the one-member suite it had. It is
     * here rather than in a sixth recipe on this function's own law — the recipe's defining values
     * are its two ADDRESSES, and a second step sentence is a payload, not a fixed point.
     *
     * WHAT IT BUYS, AND IT IS NOT SYMMETRY. `showMemberChrome` is `members.length > 1`: below that
     * threshold the page paints no `data-member` wrapper and no `data-member-outcome` badge, so the
     * per-member outcome is not on the page to measure. See {@link POPULATED_PASSING_STEP_TEXT}.
     */
    readonly secondStepText?: string
  } = {},
): PopulatedRunProject {
  const stepText = options.stepText ?? (
    `Click the ${POPULATED_BUTTON_LABEL} button on the notice page. The operator credential `
    + `for this environment is {{secret:${POPULATED_SECRET_NAME}}}.`
  )
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-405-09-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        knowledge: { dir: 'agent-qa-knowledge' },
        use: { mobile: { appState: 'preserve' }, llm: POPULATED_MODEL_NAME },
        registry: {
          targets: {
            [POPULATED_TARGET_NAME]: {
              platform: 'web',
              url: addresses.targetUrl,
              environment: 'local',
            },
          },
          llms: [
            {
              name: POPULATED_MODEL_NAME,
              provider: 'openai-compatible',
              model: POPULATED_MODEL_ID,
              baseURL: addresses.modelBaseUrl,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // The three files `requireExistingFiles: true` refuses a project without.
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  // THE ONE FILE IN THIS FIXTURE THAT HOLDS A VALUE, and it is a throwaway this repository owns.
  // Every other fixture in `spawned-chat.ts` writes this file EMPTY on the argument that a value
  // which does not exist cannot be printed by a diagnostic nobody anticipated. That argument does
  // not reach here: the claim this fixture makes is that a DECLARED secret never lands in clear,
  // and nothing can measure that without one being declared.
  writeFileSync(
    join(root, '.env.secrets.local'),
    `${POPULATED_SECRET_NAME}=${POPULATED_DECLARED_SECRET_VALUE}\n`,
    'utf8',
  )
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  // Created rather than left to the first writer, on the drainable recipe's reasoning: a real
  // post-run daemon acquires its writer lease over this directory before it serves anything.
  mkdirSync(join(root, 'agent-qa-knowledge'), { recursive: true })

  const testId = generateTestId()
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, POPULATED_TEST_PATH),
    'name: The populated run conformance probe\n'
    // MINTED rather than hand-written: canonical ids come from the ID helpers by house rule.
    + `test-id: ${testId}\n`
    + `target: ${POPULATED_TARGET_NAME}\n`
    + 'steps:\n'
    + `  - ${stepText}\n`,
    'utf8',
  )

  // THE SECOND MEMBER, WHEN ONE WAS ASKED FOR. It is a second FILE rather than a second
  // step on the first test: members are tests, and two steps under one test would still be one
  // member — which is the exact thing this option exists to stop being true.
  const secondTestId = options.secondStepText === undefined ? undefined : generateTestId()
  if (options.secondStepText !== undefined && secondTestId !== undefined) {
    writeFileSync(
      join(root, POPULATED_SECOND_TEST_PATH),
      'name: The populated run conformance second probe\n'
      + `test-id: ${secondTestId}\n`
      + `target: ${POPULATED_TARGET_NAME}\n`
      + 'steps:\n'
      + `  - ${options.secondStepText}\n`,
      'utf8',
    )
  }

  mkdirSync(join(root, 'suites'), { recursive: true })
  writeFileSync(
    join(root, POPULATED_SUITE_PATH),
    'name: The populated run conformance suite\n'
    + `suite-id: ${generateSuiteId()}\n`
    + `target: ${POPULATED_TARGET_NAME}\n`
    + 'tests:\n'
    + `  - test: ${POPULATED_TEST_PATH}\n    id: ${testId}\n`
    + (secondTestId === undefined
      ? ''
      : `  - test: ${POPULATED_SECOND_TEST_PATH}\n    id: ${secondTestId}\n`),
    'utf8',
  )

  return {
    root,
    configPath,
    agentQaRoot: join(root, '.agent-qa'),
    suitePath: POPULATED_SUITE_PATH,
    testPath: POPULATED_TEST_PATH,
    testId,
    ...(secondTestId === undefined ? {} : { secondTestId }),
  }
}

// ---- Driving one populated run ------------------------------------------------------------------

/** Everything one populated run left behind, as data. */
export interface PopulatedRunDrive {
  readonly runId: string
  /** Every envelope the local run-stream door served, in seq order. */
  readonly envelopes: readonly RunEventEnvelope[]
  /** Whether a `runFinished` frame arrived inside the budget. */
  readonly finished: boolean
  /** The last envelope type seen — what a timeout names instead of "it did not finish". */
  readonly lastType?: string
  /** Wall time from the trigger ack to the last read, in milliseconds. */
  readonly elapsedMs: number
}

/** Trigger one populated suite run and hand back the id the door acked. */
async function triggerPopulatedRun(origin: string, suitePath: string): Promise<string> {
  const response = await fetch(`${origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: suitePath }),
  })
  const body = await response.text()
  if (response.status !== 202) throw new Error(`the trigger route refused: ${body}`)
  const runId = (JSON.parse(body) as { runId?: string }).runId
  if (typeof runId !== 'string') throw new Error(`the trigger ack named no run: ${body}`)
  return runId
}

/**
 * Peel every COMPLETE line off a stream buffer and hand back the partial remainder.
 *
 * WRITTEN AS AN INDEX WALK RATHER THAN THE OBVIOUS ONE-LINER, and the reason is a grep. This
 * module's contract is that it asserts nothing, and the census that holds that contract counts
 * occurrences of the test-declaration tokens by substring — a call to the string method that
 * divides on a separator contains one of those tokens inside its own name, so the obvious spelling
 * would report this instrument as a cell that asserts. The walk below is the same operation with a
 * name the census can tell apart.
 */
function peelLines(buffered: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let rest = buffered
  for (;;) {
    const at = rest.indexOf('\n')
    if (at === -1) break
    lines.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  return { lines, rest }
}

function parseEnvelope(line: string): RunEventEnvelope | undefined {
  if (!line.startsWith('data: ')) return undefined
  try {
    const parsed = JSON.parse(line.slice('data: '.length)) as RunEventEnvelope
    return typeof (parsed as { type?: unknown }).type === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Trigger one run and collect its whole envelope log off the LOCAL run-stream door.
 *
 * THE RE-ATTACH LOOP IS `post-processing-dom.test.ts`'s, for its reason: the trigger route acks
 * BEFORE the session is registered, and the registry keeps a finished run attachable for its
 * retention window — so an attach that arrives early is refused and an attach that arrives late
 * still replays the whole log. Each attach therefore collects from scratch and the longest
 * complete reading wins, rather than concatenating two partial replays into a log with duplicates.
 *
 * IT RETURNS DATA AND NEVER ASSERTS, on this module's own law. A run that never finished comes
 * back with `finished: false` and the last type it saw, and the cell decides what that means.
 */
export async function drivePopulatedRun(
  dashboard: Pick<SpawnedDashboard, 'origin'>,
  project: Pick<PopulatedRunProject, 'suitePath'>,
  budgetMs: number = RUN_BUDGET_MS,
): Promise<PopulatedRunDrive> {
  const startedAt = Date.now()
  const runId = await triggerPopulatedRun(dashboard.origin, project.suitePath)
  const url = `${dashboard.origin}/api/run-stream/${encodeURIComponent(runId)}`
  const deadline = startedAt + budgetMs

  let best: RunEventEnvelope[] = []
  let finished = false

  while (!finished && Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, Math.max(1_000, deadline - Date.now()))
    const attempt: RunEventEnvelope[] = []
    let sawFinish = false
    try {
      const response = await fetch(url, { signal: controller.signal })
      const contentType = response.headers.get('content-type') ?? ''
      if (response.body !== null && contentType.includes('text/event-stream')) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffered += decoder.decode(chunk.value, { stream: true })
          const peeled = peelLines(buffered)
          buffered = peeled.rest
          for (const line of peeled.lines) {
            const envelope = parseEnvelope(line)
            if (envelope === undefined) continue
            attempt.push(envelope)
            if (envelope.type === 'runFinished') sawFinish = true
          }
          if (sawFinish) break
        }
        await reader.cancel().catch(() => undefined)
      }
    } catch {
      // An aborted or refused attach is retried below, within the same budget.
    } finally {
      clearTimeout(timer)
    }
    if (sawFinish || attempt.length > best.length) best = attempt
    finished = sawFinish
    if (finished) break
    await new Promise<void>((tick) => { setTimeout(tick, 150) })
  }

  const lastType = best.at(-1)?.type
  return {
    runId,
    envelopes: best,
    finished,
    ...(lastType === undefined ? {} : { lastType }),
    elapsedMs: Date.now() - startedAt,
  }
}

// ---- The discovery run -----------------------------------------------------
//
// A COMPLETED RUN LEFT BEHIND BY THE SHIPPED WRITERS, NOT DRIVEN. The discovery reads read recorded
// state, so this writes exactly what a finished run leaves: the handoff, content-addressed blobs
// through `FsEvidenceArtifactStore`, and run-detail rows through `DashboardDatabase` at the path the
// CLI composition binds (`.agent-qa/runs.db`). Two members, a served record, a sub-action with a
// screenshot and ARIA, console and network documents and one recording. No address or secret-shaped
// text appears, so every door's mask is the identity over it.

const DISCOVERY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
export const DISCOVERY_FIRST_TEST_NAME = 'Café checkout — 日本語 ✓'
export const DISCOVERY_FIRST_STEP_TEXT = 'Öffne den Warenkorb «schnell»'

export interface DiscoveryRunFixture {
  readonly root: string
  readonly configPath: string
  readonly agentQaRoot: string
  readonly runId: string
  readonly recordId: string
  readonly firstTestId: string
  readonly secondTestId: string
  readonly screenshotSha: string
  readonly recordingSha: string
  close(): void
}

export async function discoveryRunFixtureProject(): Promise<DiscoveryRunFixture> {
  const { markFixture } = await import('../../gates/__tests__/feedback-fixture.js')
  const { DashboardDatabase } = await import('@vostride/agent-qa-dashboard')
  const { FsEvidenceArtifactStore } = await import('@vostride/agent-qa-runner-local')
  const f = markFixture()
  writeFileSync(join(f.root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(f.root, '.env'), '')
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  mkdirSync(join(f.root, 'tests'), { recursive: true })
  mkdirSync(join(f.root, 'suites'), { recursive: true })

  const runId = String(f.handoff.runId)
  const recordId = String(f.published.id)
  const first = f.handoff.tests[0]!
  first.testName = DISCOVERY_FIRST_TEST_NAME
  first.steps[0]!.stepText = DISCOVERY_FIRST_STEP_TEXT
  Object.assign(first.steps[0]!, { retrievalTrace: {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId, leg: 'lexical', rank: 1, score: 1.5 }], truncated: [],
  } })
  const second = structuredClone(first)
  second.testId = generateTestId() as typeof second.testId
  second.testIndex = 1
  second.testName = 'Second member'
  second.outcome = 'passed'
  Object.assign(second.steps[0]!, { retrievalTrace: {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId, leg: 'dense', rank: 2, score: 0.25 }], truncated: [],
  } })
  f.handoff.tests.push(second)
  f.save()

  const png = Uint8Array.from(atob(DISCOVERY_PNG_BASE64), (char) => char.charCodeAt(0))
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 96 }, (_, i) => i)])
  const blobs = new FsEvidenceArtifactStore({ root: f.agentQaRoot, runId: f.handoff.runId })
  const screenshot = blobs.persistDecisionScreenshot(png)
  const recording = blobs.persistDecisionScreenshot(webm)
  const consoleRef = blobs.persistEvidenceDocument({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [
    { level: 'error', text: 'TypeError: price is undefined — 価格', timestamp: 3 },
    { level: 'warning', text: 'slow response', timestamp: 4 },
  ] })
  const networkRef = blobs.persistEvidenceDocument({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{
    url: 'https://app.test/api/cart?q=ümlaut', method: 'GET', status: 500,
    requestHeaders: { accept: 'application/json' }, responseHeaders: { 'content-type': 'application/json' },
    body: 'cart unavailable ✗', startTime: 1, endTime: 2,
  }] })
  const ariaRef = blobs.persistEvidenceDocument({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: '- button "Payer ✓"' })

  const db = new DashboardDatabase({ dbPath: join(f.agentQaRoot, 'runs.db') })
  db.insertRun({ id: runId, name: 'Discovery fixture', status: 'failed', duration: 1,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString() })
  db.upsertRunMember({ runId, testIndex: 0, testId: first.testId, name: DISCOVERY_FIRST_TEST_NAME, totalSteps: 1,
    outcome: 'failed', recording: {
      state: 'present', ref: { id: `recording:${recording.sha}`, sha: recording.sha },
      contentType: 'video/webm', byteLength: webm.length,
    } })
  db.upsertRunMember({ runId, testIndex: 1, testId: second.testId, name: 'Second member', totalSteps: 1,
    outcome: 'passed', recording: { state: 'absent', reason: 'not-captured' } })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 0, stepText: DISCOVERY_FIRST_STEP_TEXT, cacheStatus: 'miss',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'failed',
    evidence: {
      console: { kind: 'console', state: 'present', ref: consoleRef as never, counts: { total: 2, errors: 1, warnings: 1 } },
      network: { kind: 'network', state: 'present', ref: networkRef as never, counts: { total: 1, failed: 1, errored: 0 } },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'empty' },
    },
  })
  db.insertRunStep({
    runId, testIndex: 1, stepIndex: 0, stepText: 'Second step', cacheStatus: 'hit',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'passed',
    evidence: {
      console: { kind: 'console', state: 'absent', reason: 'empty' },
      network: { kind: 'network', state: 'absent', reason: 'empty' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'empty' },
    },
  })
  db.insertRunSubAction({
    runId, testIndex: 0, stepIndex: 0, subActionIndex: 0, plan: 'click Pay', plannedAction: {},
    result: {}, screenStateHash: 'h0', artifactRefs: [screenshot, ariaRef],
    ariaEvidence: { kind: 'aria', state: 'present', ref: ariaRef as never },
  })
  db.close()

  return {
    root: f.root, configPath: f.configPath, agentQaRoot: f.agentQaRoot, runId, recordId,
    firstTestId: String(first.testId), secondTestId: String(second.testId),
    screenshotSha: screenshot.sha, recordingSha: recording.sha,
    close: () => rmSync(f.root, { recursive: true, force: true }),
  }
}
