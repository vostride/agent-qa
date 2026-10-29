// The host half of `explain`.
//
// FOUR CAPABILITIES `packages/agent` NAMED AND COULD NOT IMPLEMENT, implemented here and nowhere
// else: the catalog read, the model's citation over it, the local coverage append, and the two
// counter hooks. `explain/port.ts` states why each one is a port; this file is the answer.
//
// THE ONE LOADER, NOT A SECOND READ (398-01 SC-1). `loadCatalog` calls `loadCapabilityCatalog` and
// parses nothing itself. A `JSON.parse` spelled here would be the second read path that artifact's
// whole discipline exists to prevent, and it would be invisible: both readers would be right on the
// day they were written.
//
// THE ROWS ARE THE GROUNDING DATA, AND THAT IS AN OBLIGATION (398-04's note 1). `citeCapabilities`
// puts EVERY loaded row in the prompt. A binding that prompted without them would degrade every
// answer to a ghost citation — which abstains, so it is safe, and which is also useless, and which
// nothing downstream could tell apart from `the catalog genuinely had nothing close`.
//
// WHAT IS DELIBERATELY *NOT* IN THE PROMPT: the invocation forms and the params documents. The
// model may only answer with row ids, and every character a person reads is quoted out of a row by
// the renderer — so sending the model the exact slash forms would be sending it the very
// text it must never be the source of. It cannot reproduce what it was never shown.
//
// THE COVERAGE LOG IS LOCAL AND IT IS THE POINT. `query` is the one free-text
// value in this feature. It is appended to `.agent-qa/explain-coverage.jsonl` under this project's
// own runtime root and travels nowhere else: the counter hooks below carry COUNTS and have no
// string field a query could occupy, which is D-14's no-free-text law expressed as a type rather
// than as a rule somebody remembers at the send seam.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { generateText } from 'ai'
import type { CapabilityCatalogPort, ExplainAbstentionRecord } from '@vostride/agent-qa-agent'
import type { ChatLanguageModel } from '@vostride/agent-qa-agent'
import { ExplainCitationSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow, ExplainCitation } from '@vostride/agent-qa-schema'

import { loadCapabilityCatalog } from './loader.js'

/**
 * The coverage log's file name, spelled ONCE.
 *
 * It sits directly in the project's runtime root — the directory the host resolved from
 * `DEFAULT_AGENT_QA_RUNTIME_DIR` and handed in as `agentQaRoot` — rather than at a path this module
 * assembles from a literal. A second spelling of `.agent-qa` here would be a second answer to
 * "where does this project keep its runtime state", and the first project configured with a
 * non-default root would have two.
 */
export const EXPLAIN_COVERAGE_LOG_FILE_NAME = 'explain-coverage.jsonl'

/**
 * One line of the coverage log.
 *
 * APPEND-ONLY, ONE JSON DOCUMENT PER LINE, NO ROTATION IN v2.0 — the run-artifact idiom this
 * runtime root already uses. SURF-FUT-02 reads this file later to decide whether docs-RAG has real
 * demand, so its shape is a contract with a consumer that does not exist yet, and readers must skip
 * a malformed trailing line rather than refuse the file (see {@link readExplainCoverageLog}).
 *
 * `catalogDigest` is the `rowsDigest` of the catalog THIS abstention was computed over, so a later
 * reader can tell `the catalog did not carry this capability` apart from `the catalog has changed
 * since`.
 */
export interface ExplainCoverageRecord {
  /** ISO-8601, from the host clock. */
  readonly at: string
  /** Verbatim. The one free-text value in the feature, and it stays on this machine. */
  readonly query: string
  readonly closestRowIds: readonly string[]
  readonly catalogDigest: string
}

/**
 * What an abstention reports to a counter.
 *
 * NO QUERY FIELD, AND THERE MUST NEVER BE ONE. The analytics union's `explain.abstained` member
 * declares counts and one boolean; a hook shaped wider than the event it feeds is an invitation,
 * and the one value it would be widened to carry is the exact value D-11 keeps on this machine.
 *
 * `catalogEmpty` is READ OFF THE LOAD, not inferred from an empty suggestion set. Those are two
 * different facts — a query with no lexical overlap against fifty rows also suggests nothing — and
 * a counter that conflated them would report "this install has no catalog" about a healthy one.
 */
export interface ExplainAbstainedCounts {
  readonly suggestedRowCount: number
  readonly catalogEmpty: boolean
}

export interface CreateCliCapabilityCatalogPortOptions {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  /**
   * The model the citation call runs on — THE SAME OBJECT the chat host composed.
   *
   * Passed in already built, never resolved here, for the reason `chatModel` is passed into
   * `composeLocalAgent` already built: `createModel` owns the masking middleware and the profile
   * resolution, and a second construction site would be a model call that skipped both.
   *
   * ABSENT IS A REAL POSTURE. A project with no usable LLM configuration composes a host whose
   * explain cannot cite — so it answers an EMPTY citation, which the renderer turns into the
   * abstention arm, and the person is told plainly that nothing was grounded. That is the honest
   * behaviour; the alternative (an answer assembled without a model) is the invention this whole
   * feature exists to make impossible.
   */
  readonly model?: ChatLanguageModel
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date
  /**
   * Plan 10 binds these to the analytics port. Absent ⇒ no-ops, which is the correct composed
   * behaviour for a host with no analytics: a counter nobody collects is not an error.
   *
   * `onAnswered` TAKES NOTHING, and the emptiness is a measurement rather than an oversight.
   * `CapabilityCatalogPort.recordAnswered()` has no parameters — deliberately, because D-14 permits
   * a count and nothing more — so this host is not TOLD how many rows were cited and cannot report
   * it. A `citedRowCount: 0` passed along here would have been a number nobody counted, which is
   * worse than an absence; the analytics member's own `cited_row_count` is OPTIONAL precisely so an
   * omission is representable. Widening this is a port change, which is where it belongs.
   */
  readonly onAnswered?: () => void
  readonly onAbstained?: (counts: ExplainAbstainedCounts) => void
  /** PRODUCED FIXTURES ONLY — the differentials load a zero-row catalog written through the
   * producer's own recipe. No shipped caller passes it (the loader's own rule). */
  readonly catalogPath?: string
}

/**
 * Whether the log's last byte is a newline — i.e. whether the previous append completed.
 *
 * ONE BYTE, read at the end. The whole file is deliberately not read: this runs on every abstention
 * and the log grows without bound in v2.0 (no rotation), so a read-the-file check would make the
 * cheapest possible append cost more the longer a project has been used.
 *
 * A file that is missing or empty answers `true`, because there is no unterminated line to fix.
 */
function endsWithNewline(path: string): boolean {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return true
  }
  if (size === 0) return true

  const handle = openSync(path, 'r')
  try {
    const last = Buffer.alloc(1)
    readSync(handle, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(handle)
  }
}

/** Where this project's coverage log lives. Found from the runtime root, never guessed. */
export function resolveExplainCoverageLogPath(agentQaRoot: string): string {
  return join(agentQaRoot, EXPLAIN_COVERAGE_LOG_FILE_NAME)
}

/** What a read of the coverage log found, including what it could not read. */
export interface ExplainCoverageLog {
  readonly records: readonly ExplainCoverageRecord[]
  /**
   * Lines that did not parse. Counted rather than thrown on, and REPORTED rather than swallowed.
   *
   * A reader that REFUSED the file would let one process killed mid-write poison the coverage
   * signal permanently — the demand signal SURF-FUT-02 reads would be unavailable forever because
   * of a laptop that slept once. A reader that skipped SILENTLY would be a coverage number quietly
   * missing records nobody was told about. Counting is the answer to both.
   */
  readonly skippedLines: number
}

/**
 * Every complete record in the log, with unparseable lines skipped and counted (edge
 * XPLN-02/concurrency).
 *
 * THERE IS EXACTLY ONE WAY A LINE HERE CAN BE MALFORMED, which is what makes skipping safe rather
 * than lax: a record is written by ONE `appendFileSync` of one whole line, so nothing in this
 * design can produce a half-written line except a process dying mid-write. That line is the tail at
 * the moment it is torn — and it stops being the tail as soon as the next abstention appends, which
 * is why the rule is stated over ANY line rather than over the last one. (Measured 2026-08-17,
 * a first draft that skipped only the tail was correct for a file nobody wrote to again,
 * and the cell that appended after a torn line caught it.)
 *
 * A missing file reads as an empty log. That is not an error: a project where nothing has ever
 * abstained has no coverage to report, which is exactly what zero records says.
 */
export function readExplainCoverageLog(path: string): ExplainCoverageLog {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { records: [], skippedLines: 0 }
  }

  const records: ExplainCoverageRecord[] = []
  let skippedLines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line) as ExplainCoverageRecord)
    } catch {
      skippedLines += 1
    }
  }
  return { records, skippedLines }
}

/**
 * The prompt's grounding block: EVERY row, as data.
 *
 * One line per row, carrying the canonical row id and the row's own description — the two fields a
 * choice between capabilities turns on. The id is composed here from `kind` and the row's key
 * exactly as `renderer.ts` documents the scheme, because the renderer's `catalogRowId` is not on
 * the agent package's public barrel and the alternative — a shortened id the renderer would then
 * have to guess back — is the second identity vocabulary the scheme exists to prevent.
 */
function groundingLinesOf(rows: readonly CatalogRow[]): string {
  return rows
    .map((row) => {
      const key = row.kind === 'op' ? row.id : row.kind === 'alias' ? row.alias : row.name
      return `${row.kind}:${key} — ${row.description}`
    })
    .join('\n')
}

const CITATION_SYSTEM_PROMPT = [
  'You help a person understand what an automated QA product can do.',
  '',
  'You are given the product\'s complete capability catalog, one capability per line, as',
  '`<row id> — <description>`. You may ONLY answer by selecting row ids from that list.',
  '',
  'Answer with a single JSON object and nothing else, in exactly this shape:',
  '  {"citedRowIds": ["op:runs.start", "alias:run"]}',
  '',
  'Rules:',
  '- Every id you return must appear VERBATIM in the catalog above. Do not invent, abbreviate,',
  '  reformat or guess an id.',
  '- Return the ids most relevant to the question, most relevant first, at most five.',
  '- If nothing in the catalog answers the question, return {"citedRowIds": []}. That is a correct',
  '  and useful answer. Do not pad it with something loosely related.',
  '- Never write a command, a flag, a code sample or any other prose. Ids only.',
].join('\n')

/** The empty citation — what every failure of the model half degrades to. */
const EMPTY_CITATION: ExplainCitation = Object.freeze({ citedRowIds: [] })

/**
 * Parse a model's answer into the closed citation contract, or into nothing.
 *
 * ONE tolerant step and no more: the first `{` through the last `}`, because a model that wrapped
 * its JSON in a fence or a sentence produced the right answer in the wrong envelope. Everything
 * past that is a PARSE FAILURE and answers the empty citation — never a retry loop (which spends a
 * person's money to argue with a model about syntax) and never a free-form passthrough (which is
 * the command-capable channel D-10 closes at the DTO).
 */
function parseCitation(text: string): ExplainCitation {
  const candidates: string[] = [text.trim()]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const result = ExplainCitationSchema.safeParse(parsed)
    if (result.success) return result.data
  }
  return EMPTY_CITATION
}

/**
 * The host implementation of {@link CapabilityCatalogPort}, bound at `composeLocalAgent()`.
 *
 * Nothing here is opened at construction: the catalog is read when a question is asked and the log
 * directory is created when there is a record to write, so composing a host that never explains
 * anything costs one closure.
 */
export function createCliCapabilityCatalogPort(
  options: CreateCliCapabilityCatalogPortOptions,
): CapabilityCatalogPort {
  const logPath = resolveExplainCoverageLogPath(options.agentQaRoot)
  const now = options.now ?? (() => new Date())

  // What the CURRENT question is being answered over. Set by `loadCatalog` and read by
  // `recordAbstained`, which the op calls within the same invocation — so the record names the
  // bytes the abstention was actually computed against rather than whatever is on disk when the
  // append happens. The row count is kept beside the digest because "was the catalog empty" is a
  // fact about the load and cannot be recovered from anything `recordAbstained` is handed.
  let lastDigest = ''
  let lastRowCount = -1

  return {
    async loadCatalog(): Promise<readonly CatalogRow[]> {
      const catalog = loadCapabilityCatalog(options.catalogPath)
      lastDigest = catalog.rowsDigest
      lastRowCount = catalog.rows.length
      return catalog.rows
    },

    async citeCapabilities(query: string, rows: readonly CatalogRow[]): Promise<ExplainCitation> {
      const model = options.model
      if (model === undefined) return EMPTY_CITATION

      let text: string
      try {
        const result = await generateText({
          model,
          system: CITATION_SYSTEM_PROMPT,
          prompt: `Capability catalog:\n${groundingLinesOf(rows)}\n\nQuestion: ${query}`,
        })
        text = result.text
      } catch {
        // A transport failure — auth, rate limit, outage — is a fact about this turn and not a
        // crash. It degrades to the abstention arm, which says plainly that nothing was grounded.
        return EMPTY_CITATION
      }

      return parseCitation(text)
    },

    recordAnswered(): void {
      options.onAnswered?.()
    },

    recordAbstained(record: ExplainAbstentionRecord): void {
      const line: ExplainCoverageRecord = {
        at: now().toISOString(),
        query: record.query,
        closestRowIds: [...record.closestRowIds],
        catalogDigest: lastDigest,
      }
      // ONE WRITE, ONE LINE. The record is serialized whole and appended in a single call, so a
      // process killed mid-append can leave at most an incomplete FINAL line — never an interleaved
      // or half-overwritten earlier record. That is the whole of the concurrency posture, and
      // `readExplainCoverageLog` is the other half of it.
      //
      // THE LEADING NEWLINE IS A REAL FIX, NOT A BELT-AND-BRACES ONE (measured 2026-08-17, 398-07).
      // A torn tail has no terminator, so a plain append CONCATENATED the new record onto it and
      // produced ONE corrupt line where there should have been a bad line and a good one — the new
      // record was silently lost, which is worse than the torn write that caused it. Terminating
      // the tail costs nothing, stays inside the SAME single write, and is what makes "a torn write
      // never corrupts another record" true in both directions rather than only backwards.
      mkdirSync(dirname(logPath), { recursive: true })
      const separator = endsWithNewline(logPath) ? '' : '\n'
      appendFileSync(logPath, `${separator}${JSON.stringify(line)}\n`, 'utf8')

      options.onAbstained?.({
        suggestedRowCount: record.closestRowIds.length,
        catalogEmpty: lastRowCount === 0,
      })
    },
  }
}
