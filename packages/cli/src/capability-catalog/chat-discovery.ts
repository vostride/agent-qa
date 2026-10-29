// Completion keys on what is typed: a leading `/` completes slash forms, a first word bare verbs.

import { CHAT_RESOLVER_TABLE, resolveClause } from '@vostride/agent-qa-agent'
import type { ChatHelpEntry, ChatResolverTable } from '@vostride/agent-qa-agent'
import type { CatalogRow } from '@vostride/agent-qa-schema'

/** How many suggestions a session opens with. Three: enough to show a shape, short enough to read. */
export const STARTER_PROMPT_COUNT = 3

/** The column a starter prompt's description begins in — the `/help` listing's own alignment. */
const STARTER_SYNTAX_COLUMN = 20

/** The first token of a typed form: the word, with its leading `/` if it has one. */
function verbOf(syntax: string): string {
  return syntax.trim().split(/\s+/u)[0] ?? ''
}

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Every form a person can type as the FIRST word, split by whether it wears a slash.
 *
 * The split is read off the forms themselves rather than declared, so a directive that arrives
 * without a slash — or an alias that acquires one — lands in the right half without this module
 * being edited.
 */
export function typedVerbs(helpEntries: readonly ChatHelpEntry[]): {
  readonly slashForms: readonly string[]
  readonly bareVerbs: readonly string[]
} {
  const slashForms: string[] = []
  const bareVerbs: string[] = []
  for (const entry of helpEntries) {
    const verb = verbOf(entry.syntax)
    if (verb === '') continue
    ;(verb.startsWith('/') ? slashForms : bareVerbs).push(verb)
  }
  return {
    slashForms: [...new Set(slashForms)].sort(byText),
    bareVerbs: [...new Set(bareVerbs)].sort(byText),
  }
}

/**
 * Two op ids nothing registers, distinguishable from each other — the passthrough probe.
 *
 * They are ids in SHAPE only. Nothing is invoked with them: they are handed to the shipped resolver
 * to see what it binds, and a rule that binds whatever it was handed is the generic branch.
 */
const PASSTHROUGH_PROBE_A = 'probe.one'
const PASSTHROUGH_PROBE_B = 'probe.two'

// Recognised by behaviour, not by name, so renaming `/fn` cannot strand op completions behind it.
export function passthroughFormOf(
  helpEntries: readonly ChatHelpEntry[],
  table: ChatResolverTable = CHAT_RESOLVER_TABLE,
): string | undefined {
  for (const entry of helpEntries) {
    const form = verbOf(entry.syntax)
    if (form === '') continue
    const first = resolveClause(table, `${form} ${PASSTHROUGH_PROBE_A}`)
    const second = resolveClause(table, `${form} ${PASSTHROUGH_PROBE_B}`)
    if (first.kind !== 'resolved' || second.kind !== 'resolved') continue
    if (first.entry.kind !== 'op' || second.entry.kind !== 'op') continue
    if (first.entry.functionId !== PASSTHROUGH_PROBE_A) continue
    if (second.entry.functionId !== PASSTHROUGH_PROBE_B) continue
    return form
  }
  return undefined
}

/**
 * The passthrough's completions: one per catalogued op, in the form that invokes it.
 *
 * THIS IS THE CATALOG DOING THE WORK THE ALIAS TABLE DELIBERATELY DOES NOT. The resolver table is a
 * cap — five aliases and one generic branch — so the way a person reaches the other thirty-seven
 * capabilities is `/fn <op>`, and until now there was nowhere to find out what `<op>` could be
 * short of reading source. Every id here comes off a row; none is spelled.
 */
export function passthroughCompletions(
  rows: readonly CatalogRow[],
  passthroughForm: string,
): readonly string[] {
  return rows
    .filter((row): row is Extract<CatalogRow, { kind: 'op' }> => row.kind === 'op')
    .map((row) => `${passthroughForm} ${row.id}`)
    .sort(byText)
}

/**
 * The candidate set for one line, or nothing when the line is free text.
 *
 * A CHAT LINE IS A SENTENCE, NOT A COMMAND LINE, and the completer has to stay out of the way of
 * that. Completion is offered while the first word is being typed and after the passthrough's verb
 * — which are the two moments a person is naming a capability. Mid-sentence, the answer is no
 * candidates: the alternative is a REPL that interrupts prose with suggestions.
 */
export function completionCandidatesFor(
  line: string,
  rows: readonly CatalogRow[],
  helpEntries: readonly ChatHelpEntry[],
  table: ChatResolverTable = CHAT_RESOLVER_TABLE,
): readonly string[] {
  const { slashForms, bareVerbs } = typedVerbs(helpEntries)
  const trimmedStart = line.replace(/^\s+/u, '')

  // The passthrough, once its own verb is on the line: from here the person is naming an op, and
  // the catalog is the only thing that knows which ones exist.
  const passthrough = passthroughFormOf(helpEntries, table)
  if (
    passthrough !== undefined
    && (trimmedStart === passthrough || trimmedStart.startsWith(`${passthrough} `))
  ) {
    return passthroughCompletions(rows, passthrough)
      .filter((candidate) => candidate.startsWith(trimmedStart))
  }

  if (trimmedStart.startsWith('/')) {
    return slashForms.filter((form) => form.startsWith(trimmedStart))
  }

  // Still on the first word: a bare verb is a real form, so complete it. Once whitespace has been
  // typed the line is an utterance and nothing here has an opinion about it.
  if (/\s/u.test(trimmedStart)) return []
  return bareVerbs.filter((verb) => verb.startsWith(trimmedStart))
}

/** What `node:readline`'s `completer` option wants back: the hits, and the text they extend. */
export type ChatCompleter = (line: string) => [string[], string]

/** The completer, bound to one session's loaded rows. */
export function createChatCompleter(
  rows: readonly CatalogRow[],
  helpEntries: readonly ChatHelpEntry[],
  table: ChatResolverTable = CHAT_RESOLVER_TABLE,
): ChatCompleter {
  return (line: string) => [[...completionCandidatesFor(line, rows, helpEntries, table)], line]
}

/**
 * The lines a session opens with, DERIVED from the catalog's alias rows.
 *
 * DETERMINISTIC BY CONSTRUCTION — sorted alias order, a fixed count, no sampling and no clock. Two
 * sessions opened against the same catalog show the same three lines, which is what makes them
 * assertable and what keeps them from reading as noise.
 *
 * ALIAS ROWS RATHER THAN OP ROWS, because a starter prompt is a thing to TYPE and the aliases are
 * the forms a person can type without knowing an op id. The text is the row's own description —
 * which is the op's declared summary, so improving a summary at its zod source improves this
 * surface too, and no sentence about any capability is authored here.
 */
export function buildStarterPrompts(
  rows: readonly CatalogRow[],
  helpEntries: readonly ChatHelpEntry[],
  limit: number = STARTER_PROMPT_COUNT,
): readonly string[] {
  const syntaxByAlias = new Map(helpEntries.map((entry) => [entry.alias, entry.syntax]))
  return rows
    .filter((row): row is Extract<CatalogRow, { kind: 'alias' }> => row.kind === 'alias')
    .sort((left, right) => byText(left.alias, right.alias))
    .slice(0, Math.max(0, limit))
    .map((row) => {
      // The typed form when the census-tied help entry has one; the row's own name otherwise. The
      // fallback is unreachable while the census passes and is here so a drift degrades to a
      // slightly worse suggestion rather than to a session that will not open.
      const syntax = syntaxByAlias.get(row.alias) ?? row.alias
      return `  ${syntax.padEnd(STARTER_SYNTAX_COLUMN)}${row.description}`
    })
}
