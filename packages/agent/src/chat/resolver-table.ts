// Every function id is imported from its declaring module, so a rename breaks this file's compile.

import { parseShortId } from '@vostride/agent-qa-schema'

import { ENTITIES_RESOLVE_FUNCTION_ID } from '../functions/ops/entities-ids.js'
import { RUNS_DIGEST_FUNCTION_ID } from '../functions/ops/runs-digest.js'
import { RUNS_LIST_FUNCTION_ID } from '../functions/ops/runs-list.js'
import { RUNS_START_FUNCTION_ID } from '../functions/ops/runs-start.js'

// Session directives map to no registry op, but sit in the table because it is what a person types.
export const CHAT_DIRECTIVES = ['model', 'help', 'quit'] as const

export type ChatDirectiveName = (typeof CHAT_DIRECTIVES)[number]

/**
 * What one alias resolves TO.
 *
 * A discriminated union rather than an op shape with optional members, because "which registry op,
 * with what input" and "which session directive, with what argument" are different questions and a
 * shape that could answer half of each is a shape a caller has to defend against.
 */
export type ChatResolverEntry =
  | { readonly kind: 'op'; readonly functionId: string; readonly input: unknown }
  | { readonly kind: 'directive'; readonly directive: ChatDirectiveName; readonly argument?: string }

/**
 * One row: the alias's name, and the single function that decides both whether the clause matches
 * and what it binds.
 *
 * MATCHING AND ARGUMENT BINDING ARE ONE STEP on purpose. Split in two, a clause could pass the
 * pattern and then fail the parse — and there is no honest answer to what that is. It is not a
 * resolution (nothing was bound) and it must not be a partial one (see the header). Folding them
 * means `run` with no test named simply does not match, which is the same answer the table gives
 * `propsals`: nothing, flowed onward.
 */
export interface ChatResolverRule {
  /** Human-readable name of the alias — the log's word for it, and the meta-test's scenario key. */
  readonly alias: string
  readonly resolve: (clause: string) => ChatResolverEntry | undefined
}

export type ChatResolverTable = readonly ChatResolverRule[]

/**
 * Stage 1's answer for one clause. Two variants, no third, no number.
 *
 * `alias` rides along on the resolved arm because the session log records WHICH canonical form a
 * person used, and reconstructing that from the entry afterwards would mean a second matcher.
 */
export type ChatResolution =
  | { readonly kind: 'resolved'; readonly alias: string; readonly entry: ChatResolverEntry }
  | { readonly kind: 'unresolved' }

/**
 * One frozen row, contextually typed.
 *
 * A named helper rather than a bare `Object.freeze({...})` per row: `Object.freeze` is generic and
 * infers from its argument, so a row written inside it loses the contextual type and every `kind`
 * widens to `string`. Going through a parameter of the row type is what makes a misspelled
 * discriminant or a directive name outside the closed set a compile error at the row that has it,
 * which is the whole reason the union is discriminated.
 */
function rule(declaration: ChatResolverRule): ChatResolverRule {
  return Object.freeze(declaration)
}

/** Case-insensitive, whitespace-trimmed equality — the comparison every bare verb wants. */
function isExactly(word: string): (clause: string) => boolean {
  return (clause) => clause.trim().toLowerCase() === word
}

/**
 * The remainder after a leading verb, or nothing when the verb stands alone.
 *
 * Returns `undefined` for a bare verb rather than an empty string, so a caller that requires an
 * argument gets its refusal from the same place a caller that forbids one gets its permission.
 */
function argumentAfter(verb: string, clause: string): string | undefined {
  const trimmed = clause.trim()
  const lowered = trimmed.toLowerCase()
  if (!lowered.startsWith(`${verb} `) && !lowered.startsWith(`${verb}\t`)) return undefined
  const rest = trimmed.slice(verb.length).trim()
  return rest === '' ? undefined : rest
}

/**
 * `/fn`'s body, following the `fn --input <json>` precedent exactly (`cli/commands/fn.ts`).
 *
 * No body means `{}` — the same default the CLI verb has, because `/fn runs.list` and
 * `agent-qa fn runs.list` are the same request typed at two prompts and a second default would be
 * a second grammar. For `runs.list` that default is the op's own: the 20 newest completed runs.
 * A body that is not a JSON OBJECT (malformed, an array, a bare word) does not resolve: ops take
 * objects, and guessing an object around whatever was typed is exactly the partial match this
 * table does not do.
 */
function parseFnBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

// Ordered: `resolveClause` takes the first rule that binds.
export const CHAT_RESOLVER_TABLE: ChatResolverTable = Object.freeze([
  rule({
    alias: 'run',
    // The reference is handed to `runs.start` as a PATTERN, verbatim. The op's contract is
    // "test file paths or glob patterns", and it resolves the configured default set when the
    // field is absent — so `run` with nothing named is a near-miss here rather than a silent
    // "run everything", which is not a request anybody made by typing three letters.
    resolve: (clause) => {
      const reference = argumentAfter('run', clause)
      if (reference === undefined) return undefined
      return { kind: 'op', functionId: RUNS_START_FUNCTION_ID, input: { patterns: [reference] } }
    },
  }),
  rule({
    alias: 'status',
    // `runs.list` takes `{}` and answers recent runs; `runs.get` refuses without the run id.
    resolve: (clause) =>
      isExactly('status')(clause)
        ? { kind: 'op', functionId: RUNS_LIST_FUNCTION_ID, input: {} }
        : undefined,
  }),
  rule({
    alias: 'test-ref',
    // The ref passes verbatim to `entities.resolve`, which owns the only resolution grammar.
    resolve: (clause) => {
      const trimmed = clause.trim()
      const named = argumentAfter('test', clause)
      const isShortId = parseShortId(trimmed) !== undefined
      if (named === undefined && !isShortId) return undefined
      return { kind: 'op', functionId: ENTITIES_RESOLVE_FUNCTION_ID, input: { ref: trimmed } }
    },
  }),
  rule({
    alias: 'digest',
    // The run reference passes through verbatim for the same reason the acknowledgment in
    // `runs.start` is read off the record rather than echoed: a reference that names no run comes
    // back as `RunNotFoundError`, named, instead of as a plausible-looking digest of nothing.
    // Bare `digest` is a near-miss, not "the latest": which run a person meant is a question this
    // table must not answer by guessing.
    resolve: (clause) => {
      const reference = argumentAfter('digest', clause)
      if (reference === undefined) return undefined
      return { kind: 'op', functionId: RUNS_DIGEST_FUNCTION_ID, input: { runId: reference } }
    },
  }),
  rule({
    alias: 'model',
    resolve: (clause) => {
      const name = argumentAfter('/model', clause)
      return name === undefined ? undefined : { kind: 'directive', directive: 'model', argument: name }
    },
  }),
  rule({
    alias: 'fn',
    // The op id is unchecked here: `invokeFunction` names an unknown id before touching anything.
    resolve: (clause) => {
      const rest = argumentAfter('/fn', clause)
      if (rest === undefined) return undefined
      const separator = rest.search(/\s/u)
      const functionId = separator === -1 ? rest : rest.slice(0, separator)
      const body = separator === -1 ? undefined : rest.slice(separator).trim()
      const input = parseFnBody(body === '' ? undefined : body)
      if (input === undefined) return undefined
      return { kind: 'op', functionId, input }
    },
  }),
  rule({
    alias: 'help',
    resolve: (clause) =>
      isExactly('/help')(clause) ? { kind: 'directive', directive: 'help' } : undefined,
  }),
  rule({
    alias: 'quit',
    resolve: (clause) =>
      isExactly('/quit')(clause) ? { kind: 'directive', directive: 'quit' } : undefined,
  }),
] satisfies ChatResolverTable)

/**
 * The refusal a directive gets in a build that binds no handler for it.
 *
 * Stage 1 RESOLVED the clause — the table knows `/model` perfectly well — and this build has
 * nothing to carry it out with. That is a different fact than `no capability handles that`, and it
 * has to read differently in the log. The two are kept apart the same way the headless planner is
 * kept apart from a planner that answered and declined (see `ports.ts`): a person reading a
 * session must be able to tell `this build cannot yet` apart from `nothing can`.
 *
 * (The backticks are not stylistic. `packages/arch`'s dependency lint scans every line of every
 * source file for an import specifier, and its pattern is the word `f`+`rom` followed by a quoted
 * string — so ordinary prose using that word ahead of a quoted phrase reads to it as an import of
 * a package by that name, and the package census reds. Comments here are load-bearing enough to
 * be scanned; they are written to survive the scanner.)
 */
export function directiveNotBoundReason(directive: ChatDirectiveName, clause: string): string {
  return (
    `The /${directive} directive is recognised but no handler for it is bound in this build: `
    + `"${clause}". The turn was refused before anything ran, so nothing in the request was `
    + 'carried out.'
  )
}

// First match over an ordered table, so the earlier, more specific rule wins if rules overlap.
export function resolveClause(table: ChatResolverTable, clause: string): ChatResolution {
  for (const rule of table) {
    const entry = rule.resolve(clause)
    if (entry !== undefined) return { kind: 'resolved', alias: rule.alias, entry }
  }
  return { kind: 'unresolved' }
}

// Structured so `help-census.test.ts` in cli can join each line to a table row and its syntax.
export interface ChatHelpEntry {
  /** The `CHAT_RESOLVER_TABLE` row this line documents. The census's join key. */
  readonly alias: string
  // `<angle>` is required and `[square]` optional; a conformance cell drives the bare verb.
  readonly syntax: string
  /** What the line says the verb does. */
  readonly summary: string
}

// Beside the table, so help cannot drift into a second list of what chat understands.
export const CHAT_HELP_ENTRIES: readonly ChatHelpEntry[] = Object.freeze([
  Object.freeze({ alias: 'run', syntax: 'run <test>', summary: 'start a run for a test' }),
  Object.freeze({ alias: 'status', syntax: 'status', summary: 'the recent runs' }),
  Object.freeze({ alias: 'test-ref', syntax: 'test <n>', summary: 'show a test by reference' }),
  // `digest` needs a run reference: the resolver treats a bare `digest` as a near-miss.
  Object.freeze({ alias: 'digest', syntax: 'digest <run>', summary: "that run's digest" }),
  Object.freeze({
    alias: 'fn',
    syntax: '/fn <op> [json]',
    summary: 'invoke any registered function by id — every capability, one branch',
  }),
  Object.freeze({
    alias: 'model',
    syntax: '/model <name>',
    summary: 'switch the model for this session',
  }),
  Object.freeze({ alias: 'help', syntax: '/help', summary: 'this list' }),
  Object.freeze({ alias: 'quit', syntax: '/quit', summary: 'end the session' }),
] as const satisfies readonly ChatHelpEntry[])

/** The column the summaries start in — a reading convenience, pinned once. */
const HELP_SYNTAX_COLUMN = 20

/**
 * What `/help` prints, RENDERED from the entries rather than spelled a second time.
 *
 * The string is still the export `composeLocalAgent`'s directive handler returns, because a person
 * types `/help` and reads sentences. What is gone is the possibility of the sentences and the join
 * keys disagreeing: there is one list, and this is a projection of it.
 */
export const CHAT_HELP_TEXT = [
  'What I understand deterministically:',
  ...CHAT_HELP_ENTRIES.map(
    (entry) => `  ${entry.syntax.padEnd(HELP_SYNTAX_COLUMN)}${entry.summary}`,
  ),
  'Anything else is planned by the model and reconciled against the table before anything runs.',
].join('\n')
