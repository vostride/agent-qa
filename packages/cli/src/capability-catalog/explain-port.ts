// `query` stays in the local coverage log; the counter hooks carry counts with no string field.

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

// Append-only JSON lines; `catalogDigest` tells a missing capability from a changed catalog.
export interface ExplainCoverageRecord {
  /** ISO-8601, from the host clock. */
  readonly at: string
  /** Verbatim. The one free-text value in the feature, and it stays on this machine. */
  readonly query: string
  readonly closestRowIds: readonly string[]
  readonly catalogDigest: string
}

// No query field; `catalogEmpty` is read off the load, not inferred from no suggestions.
export interface ExplainAbstainedCounts {
  readonly suggestedRowCount: number
  readonly catalogEmpty: boolean
}

export interface CreateCliCapabilityCatalogPortOptions {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  // Built by the chat host so `createModel` masks it; absent, explain answers an empty citation.
  readonly model?: ChatLanguageModel
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date
  // Absent, the hooks are no-ops; `onAnswered` takes nothing because the port reports no count.
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
  // Counted and reported, so a torn write neither poisons the log nor goes unmentioned.
  readonly skippedLines: number
}

// Each line is one whole `appendFileSync`, so any malformed line is a torn write and is skipped.
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

// One tolerant step, first `{` to last `}`; anything else is the empty citation, never a retry.
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
          instructions: CITATION_SYSTEM_PROMPT,
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
      // One write per record, led by a newline, so a torn tail never swallows the next record.
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
