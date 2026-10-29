// The deterministic stage-1 resolver table.
//
// One module, hand-authored, CLOSED. Each entry is a pattern and what the pattern resolves to —
// never a second capability vocabulary. The rule is 387 D-11's and it is absolute: EVERY function
// id below is IMPORTED from the module that declares it, never written as a literal. An op renamed
// at its declaration must break this file's compile rather than leave an alias pointing at a string
// nothing dispatches (`functions/entity-cards/actions.ts:10-14`).
//
// THE TABLE IS A CAP, WHICH IS WHY IT IS THIS SMALL. D-06's canon is the verbs the spec names plus
// the verbs 391 shipped, and then ONE generic `/fn <op> [args]` branch that reaches every registry
// op without the table growing by one row per op. A table that grew with the registry would be a
// second listing of the catalogue, drifting from the first; a table that stayed small by hiding
// ops would be a curated tool set, which the always-send-all law forbids. `/fn` is how both are
// avoided at once: one tested branch, total reach, zero per-op maintenance.
//
// RESOLUTION IS BINARY. `ChatResolution` has exactly two variants and NO CONFIDENCE MEMBER, and
// the absence is load-bearing. This path OVERRIDES a model's plan on both the action set and
// the bound arguments, so a false positive here does not degrade an answer — it executes a
// capability nobody asked for. A confidence number would be the first half of a threshold, and a
// threshold is exactly how an overriding path acquires a false-positive rate. A near-miss — a
// misspelling, a verb with its required argument missing — therefore resolves to NOTHING and flows
// on to the planner, which is allowed to be wrong because it is not allowed to override.
//
// NO `/tools`, NO `/compact`. The first fights the always-send-all law; the second is a
// manual lever over a mechanism 392 keeps automatic.

import { parseShortId } from '@vostride/agent-qa-schema'

import { ENTITIES_RESOLVE_FUNCTION_ID } from '../functions/ops/entities-ids.js'
import { RUNS_DIGEST_FUNCTION_ID } from '../functions/ops/runs-digest.js'
import { RUNS_LIST_FUNCTION_ID } from '../functions/ops/runs-list.js'
import { RUNS_START_FUNCTION_ID } from '../functions/ops/runs-start.js'

/**
 * The session-scoped directives: canon that maps to NO registry op.
 *
 * Closed and spelled once. `/model` changes how THIS SESSION behaves (D-04's model override and its
 * `model_change` event); `/help` and `/quit` are REPL chrome. None of them is a capability, which is
 * why none of them has a function id — and they are in the table anyway, because the table is the
 * vocabulary a person types and the meta-test demands a scenario for every row of it.
 *
 * `/pin` is gone. It was a session deny overlay over the op gate, and there is no op
 * gate; a clause spelled `/pin …` is now an ordinary clause nothing in the table resolves.
 */
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

/**
 * THE CANON. Ordered, and the order is the first-match walk (see `resolveClause`).
 *
 * No two rules overlap today, so the order is documentation rather than semantics — and it is
 * written in D-06's own listing order so it stays readable as one.
 */
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
    // ADJUDICATION (the plan asks for it recorded here): the candidates were `runs.list` and
    // `runs.get`. `runs.get` addresses exactly one run BY ID and refuses without one, so it
    // cannot answer a person who typed a bare word — the id is the very thing they did not
    // supply. `runs.list` takes `{}`, answers the 20 most recently finished runs newest first
    // and is the only read in the registry whose contract answers "what has happened
    // here lately" without being told what to look at. `status <run>` is not minted:
    // `digest <run>` already owns "tell me about that one run", and two verbs for it would be
    // two answers.
    resolve: (clause) =>
      isExactly('status')(clause)
        ? { kind: 'op', functionId: RUNS_LIST_FUNCTION_ID, input: {} }
        : undefined,
  }),
  rule({
    alias: 'test-ref',
    // 387 D-05's never-guess ladder does the resolving, and the ref it receives is WHAT THE
    // PERSON TYPED, verbatim. `entities.resolve` accepts "any reference at all — short-ID, URI,
    // or free text", so pre-chewing `test 42` into `42` here would be this file inventing a
    // second resolution grammar in front of the one that exists to be the only one. Two forms
    // match: the `test <n>` phrase and a bare well-formed short-ID, the latter recognised through
    // the schema's own parser rather than a regex spelled here.
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
  // the `proposals` inbox alias is gone. Changes apply in the call, so there is
  // no pending-decision inbox to route a bare word to. 432-17 deleted the inbox and its ops too.
  rule({
    alias: 'model',
    resolve: (clause) => {
      const name = argumentAfter('/model', clause)
      return name === undefined ? undefined : { kind: 'directive', directive: 'model', argument: name }
    },
  }),
  rule({
    alias: 'fn',
    // THE PASSTHROUGH. The op id is NOT validated here — deliberately. `invokeFunction`'s
    // step 1 raises `UnknownFunctionError` naming the id before any dependency is touched, so a
    // typo and a capability that has not shipped yet both come back named, for free, from the one
    // place that knows what is registered. A check here would be a second catalogue.
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

/**
 * Stage 1 for one clause: the FIRST rule that binds, or `unresolved`.
 *
 * First-match rather than unique-match, and the table is ordered rather than a map, because D-06's
 * canon has forms that could legitimately overlap as it grows, and "the earlier, more specific rule
 * wins" is a rule a reader of the table can see. Precision is 1.0 by construction — every rule is
 * an exact predicate over the clause, so a miss is a miss and never a guess.
 */
export function resolveClause(table: ChatResolverTable, clause: string): ChatResolution {
  for (const rule of table) {
    const entry = rule.resolve(clause)
    if (entry !== undefined) return { kind: 'resolved', alias: rule.alias, entry }
  }
  return { kind: 'unresolved' }
}

/**
 * One line of `/help`, in a shape a census can read.
 *
 * WHY THE ENTRIES ARE STRUCTURED AND THE STRING IS DERIVED. `CHAT_HELP_TEXT` used to be ten
 * hand-aligned sentences, and a sentence is not something a test can join to anything: the only
 * assertion available over it was a substring match somebody remembered to write. The fields below
 * are the join keys — `alias` names the row of `CHAT_RESOLVER_TABLE` the line documents, and
 * `syntax` is the FORM A PERSON TYPES, first token and all — so "the help text agrees with what
 * chat understands" became a set comparison and "this line claims an argument is optional" became a
 * probe of the shipped rule.
 *
 * THE CENSUS-TIE DECISION (398 plan 09, planned 2026-08-16, executed 2026-08-17 · D-01/SC-1).
 * The discretion call was whether help re-derives from the committed capability catalog or stays
 * here with a mechanical tie. It stays HERE. `packages/agent` is storage-neutral — it cannot read a
 * committed artifact off disk without acquiring a filesystem dependency the whole package is built
 * to not have — so re-deriving at runtime would move help out of the package that owns the
 * vocabulary and into the one that ships bytes. The tie gives the same guarantee without the move:
 * `packages/cli/src/__tests__/conformance/help-census.test.ts` set-equals these aliases against the
 * catalog's alias rows plus the shipped directives plus the passthrough, in BOTH directions, so a
 * help line with no capability behind it and a capability with no help line are each a named RED.
 * The header's one-list law is unchanged; what changed is that it is now enforced rather than
 * asked for.
 */
export interface ChatHelpEntry {
  /** The `CHAT_RESOLVER_TABLE` row this line documents. The census's join key. */
  readonly alias: string
  /**
   * What a person types, verbatim, including the leading `/` where there is one.
   *
   * `<angle>` marks a REQUIRED argument and `[square]` an optional one, and the distinction is
   * load-bearing rather than typographic: a conformance cell reads it and drives the shipped rule
   * with the bare verb, so a line promising that a verb works alone when the rule refuses it — the
   * exact drift this plan found on `digest` — is a failure rather than a reading.
   */
  readonly syntax: string
  /** What the line says the verb does. */
  readonly summary: string
}

/**
 * What `/help` prints, one entry per row of the table above.
 *
 * IT LIVES BESIDE THE TABLE, and that is the point rather than the filing: the canon a person can
 * type is `CHAT_RESOLVER_TABLE`, and help text kept anywhere else would be a second list of what
 * chat understands, free to drift from the one that actually routes. `/fn` is named explicitly
 * because it is the reach lever — every registry op is one deterministic branch away, which is why
 * the alias set stays thin.
 */
export const CHAT_HELP_ENTRIES: readonly ChatHelpEntry[] = Object.freeze([
  Object.freeze({ alias: 'run', syntax: 'run <test>', summary: 'start a run for a test' }),
  Object.freeze({ alias: 'status', syntax: 'status', summary: 'the recent runs' }),
  Object.freeze({ alias: 'test-ref', syntax: 'test <n>', summary: 'show a test by reference' }),
  // 2026-08-17 (398 plan 09): this line used to read `digest` / "the latest run digest", and both
  // halves were false. The rule fifteen lines up requires a reference and treats a bare `digest` as
  // a near-miss precisely so the table never guesses which run somebody meant — so the help text
  // was advertising a guess the resolver refuses to make. The argument-contract cell in
  // `help-census.test.ts` is what now holds the two together.
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
