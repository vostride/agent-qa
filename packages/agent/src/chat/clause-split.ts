// The deterministic conjunction grammar (Phase 392, D-09 / RESEARCH Pitfall 5).
//
// One utterance in, the clauses a person meant out. This is stage 1's other half: the closed
// resolver table decides what a clause MEANS, and this file decides what a clause IS. Both are
// deterministic and both are capped, because the mapper they feed OVERRIDES a model's plan
// and an overriding path with a false-positive rate is worse than no overriding path at all.
//
// IT IS A CHARACTER SCAN, NOT A REGEX SPLIT, and that is the whole reason the module exists rather
// than one line at the call site. `utterance.split(/ and |;|,/)` passes every simple case and then
// tears `write a test for "add and remove items"` into two clauses, the second of which no
// capability handles — so the turn fails closed, loudly, on a request that was never compound.
// That is not a cosmetic bug: CHAT-03 measures the `mark_unhandled` rate over the frozen corpus,
// and a splitter that manufactures phantom clauses inflates the very number the ceiling exists to
// hold down (RESEARCH Pitfall 5). Quote state is therefore explicit and the scan is character-wise.
//
// RECONCILIATION RUNS UNIFORMLY ON SINGLE-CLAUSE TURNS. A one-clause utterance is a compound of
// one, and it takes the identical path through stages 2-4. There is no fast lane, because a fast
// lane is a second implementation of the turn contract that nothing keeps in step with the first.
//
// A STYLE MODIFIER IS NOT A REQUEST, AND SPLITTING ONE OFF MANUFACTURES A PHANTOM CLAUSE (392-16,
// G-392-1). `in one sentence, what does it mean to call a test flaky?` is one question with an
// instruction about the FORM of the answer, and the separator between them is a real one. Split
// into two clauses, `in one sentence` is a clause no capability handles and the model has to claim
// back byte-for-byte through `answer_only`; miss that claim and, with zero action calls, the
// deficit arm refuses the WHOLE turn with a sentence asserting nothing handles a clause the model
// in fact addressed. It is the same failure Pitfall 5 above names, arriving through the separator
// set instead of through a regex: a phantom clause inflates the very CHAT-03 `mark_unhandled`
// number the ceiling exists to hold down (measured: 2 of 5 live runs at 1/3 against a 1/5 ceiling).
// So a piece that is EXACTLY one of the pinned {@link STYLE_MODIFIER_PHRASES} is elided, on the
// same terms as an empty piece — and never to zero clauses.

import type { ChatClause } from './ports.js'

/**
 * The closed separator set.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: these four are the separators a
 * person actually types between two requests in one breath. Widening the set is a real decision
 * with a real cost — every token added is a token that can now split a clause that meant one
 * thing, and the failure is silent in the direction that matters (a phantom clause reads as a
 * refusal of something the person never asked for). Add a token only with a scenario that shows
 * the utterance it rescues, and re-run the ceiling measurement afterwards.
 *
 * The word tokens carry their own whitespace, which IS the word-boundary rule: ` and ` cannot
 * match inside `sandbox` or `android` because neither has a space where the token needs one. A
 * separate boundary check would be a second answer to a question the token spelling already
 * answers, free to disagree with it.
 *
 * Order is the order the scanner tries them. It is not load-bearing today — no token is a prefix
 * of another — and it is written longest-first anyway so that it stays not load-bearing.
 */
export const CONJUNCTION_TOKENS = [' and ', ' then ', ';', ','] as const

/**
 * The closed style-modifier set.
 *
 * THE INCLUSION CRITERION: a phrase that, STANDING ALONE AS A WHOLE PIECE, instructs the FORM of
 * the answer and names no capability, no entity and no action this build has or could ever have.
 * `in one sentence` qualifies; `summarise the last failure` does not, and neither does anything
 * that could one day become an op.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: every phrase added here is a phrase
 * that can now be DROPPED from a request, and a dropped request is the silent failure this file's
 * header decides against everywhere else. So add one only with a case that shows the utterance it
 * rescues, re-run the ceiling measurement afterwards, and never write a pattern or a regex in place
 * of a member — a pattern would reach into `briefly explain the flake`, which is a real request
 * that merely begins with a member.
 *
 * Order is alphabetical and is NOT load-bearing: the set is read by exact membership, never
 * scanned in sequence.
 */
export const STYLE_MODIFIER_PHRASES = [
  'briefly',
  'concisely',
  'in a sentence',
  'in brief',
  'in one sentence',
  'in short',
  'in two sentences',
] as const

/**
 * Whether a surviving piece is a style modifier and nothing else.
 *
 * EXACT on the whole trimmed piece, case-insensitively — the same case discipline `separatorAt`
 * applies, for the same reason. Not a prefix test and not a substring test: `briefly explain the
 * flake` begins with a member and is a request. Quote characters are part of a piece's text, so a
 * quoted `"briefly"` is not a member either, which is the behaviour the quote-protection rule
 * above already promises.
 */
function isStyleModifier(text: string): boolean {
  return (STYLE_MODIFIER_PHRASES as readonly string[]).includes(text.toLowerCase())
}

/** The quote characters that protect a span. Both, because people type both. */
const QUOTE_CHARACTERS = ['"', "'"] as const

type QuoteCharacter = (typeof QUOTE_CHARACTERS)[number]

function isQuoteCharacter(character: string): character is QuoteCharacter {
  return (QUOTE_CHARACTERS as readonly string[]).includes(character)
}

/**
 * The bracket pairs that protect a span, the way a quote pair does.
 *
 * WHY A SECOND KIND OF PROTECTED SPAN EXISTS. `/help` advertises `/fn <op> [json]` as "invoke any
 * registered function by id — every capability, one branch", and D-06 rests the thin table's whole
 * argument on that claim. A JSON object with more than one member carries a STRUCTURAL comma, and
 * that comma is outside every quoted span by construction — it sits between one value's closing
 * quote and the next key's opening one. `,` is a pinned separator, so
 * `/fn config.target.create {"name":"shop","platform":"web","url":"…"}` was torn into three pieces,
 * none of which parses as `/fn`'s body, and a person who typed exactly what the help text told them
 * to type was answered "No capability in this build handles …". Measured over Phase 397's scenario
 * table: 14 of the 41 registered capabilities have an input whose smallest valid JSON encoding
 * carries a structural comma, so for a third of the catalogue the reach lever did not reach.
 *
 * IT ADDS NO TOKEN AND REMOVES NONE. {@link CONJUNCTION_TOKENS} is untouched; what changes is where
 * a token is looked for, which is the same change quote protection already makes. The asymmetry is
 * the file head's: an unquoted bracket in English prose is rare and costs at most a clause that
 * could have been split, while the alternative manufactures a phantom clause and a spurious refusal
 * on a documented, deterministic route. Pitfall 5 says which way to be wrong.
 *
 * QUOTE STATE WINS. A bracket INSIDE a quoted span is a character in a sentence, not the start of a
 * document, so it never opens a depth — otherwise `write a test for "the { key" and status` would
 * swallow its own conjunction.
 */
const BRACKET_PAIRS: Readonly<Record<string, string>> = Object.freeze({ '{': '}', '[': ']' })

const CLOSING_BRACKETS: readonly string[] = Object.freeze(Object.values(BRACKET_PAIRS))

/**
 * The separator starting at `at`, or nothing.
 *
 * Case-insensitive on the word tokens, because `run X AND status` is the same request as its
 * lowercase twin and a person typing at a prompt is not thinking about case.
 */
function separatorAt(utterance: string, at: number): string | undefined {
  const lowered = utterance.toLowerCase()
  for (const token of CONJUNCTION_TOKENS) {
    if (lowered.startsWith(token, at)) return token
  }
  return undefined
}

/**
 * Split one utterance into the clauses stage 1 routes.
 *
 * Pure, total and host-free: no clock, no config, no I/O, and no input throws. An unterminated
 * quote is not an error a person should have to hear about — it protects to end-of-utterance,
 * which over-protects (one clause where two were meant) rather than under-protects (a phantom
 * clause and a spurious refusal). Pitfall 5 says which way to be wrong. An unterminated BRACKET
 * gets the identical answer for the identical reason (see {@link BRACKET_PAIRS}).
 *
 * Empty pieces are elided rather than preserved, so `status,,proposals` and `status, proposals`
 * are the same request. A clause whose text is empty could name nothing in a refusal, and D-08
 * requires that a fail-closed turn name what it could not do.
 */
export function splitClauses(utterance: string): readonly ChatClause[] {
  const pieces: string[] = []
  let current = ''
  let openQuote: QuoteCharacter | undefined
  let bracketDepth = 0
  let at = 0

  while (at < utterance.length) {
    const character = utterance[at]!

    if (openQuote !== undefined) {
      // Inside a quoted span nothing separates. The closing quote is kept in the clause text
      // because the text is what a refusal quotes back and what an arg parser reads.
      current += character
      if (character === openQuote) openQuote = undefined
      at += 1
      continue
    }

    if (isQuoteCharacter(character)) {
      openQuote = character
      current += character
      at += 1
      continue
    }

    // The bracket depth is maintained HERE — after the quote arm above has already `continue`d —
    // which is what makes "quote state wins" a property of the control flow rather than a rule.
    if (BRACKET_PAIRS[character] !== undefined) {
      bracketDepth += 1
      current += character
      at += 1
      continue
    }

    if (CLOSING_BRACKETS.includes(character)) {
      // FLOORED AT ZERO. A stray `}` must not drive the counter negative, or a later `{` would
      // leave it at zero and the protection would silently stop working for the rest of the scan —
      // a guard defeated by a character a person typed by accident is not a guard.
      bracketDepth = Math.max(0, bracketDepth - 1)
      current += character
      at += 1
      continue
    }

    if (bracketDepth > 0) {
      // Inside a bracketed span nothing separates, exactly as inside a quoted one.
      current += character
      at += 1
      continue
    }

    const separator = separatorAt(utterance, at)
    if (separator !== undefined) {
      pieces.push(current)
      current = ''
      at += separator.length
      continue
    }

    current += character
    at += 1
  }
  pieces.push(current)

  const survivors: string[] = []
  for (const piece of pieces) {
    const text = piece.trim()
    if (text === '') continue
    survivors.push(text)
  }

  // THE STYLE-MODIFIER ELISION, and the reason it is its own pass rather than another `continue`
  // above: "is there a real request beside this one" is not a question a piece can answer about
  // itself. The whole survivor set has to exist first. Modifiers go only when a non-member
  // survives; an utterance made ONLY of modifiers keeps them all, because refusing something a
  // person typed is recoverable and dropping it silently is not — the same asymmetry Pitfall 5
  // already decides in this file, and the reason zero clauses is not an outcome this can produce.
  const kept = survivors.some((text) => !isStyleModifier(text))
    ? survivors.filter((text) => !isStyleModifier(text))
    : survivors

  const clauses: ChatClause[] = []
  for (const text of kept) {
    // The index is the clause's position among the clauses that SURVIVED elision, which is what
    // the engine and the reconciler key on. It is a clause's identity within one turn, not an
    // offset into the utterance, and D-12's override depends on exactly that: a planner entry for
    // a clause the table already resolved cannot displace it, whatever the model called it.
    clauses.push({ text, index: clauses.length })
  }
  return clauses
}
