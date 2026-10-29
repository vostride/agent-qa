// A character scan with explicit quote state, because a regex split tears quoted conjunctions.

import type { ChatClause } from './ports.js'

// Word tokens carry their own spaces, so ` and ` cannot match inside `sandbox` or `android`.
export const CONJUNCTION_TOKENS = [' and ', ' then ', ';', ','] as const

// Read by exact membership, never as a pattern, which would reach `briefly explain the flake`.
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

// Brackets protect a span as quotes do, so `/fn` JSON bodies do not split; quote state wins.
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

// An unterminated quote or bracket protects to the end: one clause too few beats a phantom one.
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

  // A separate pass: a modifier goes only if a non-modifier survives, so never zero clauses.
  const kept = survivors.some((text) => !isStyleModifier(text))
    ? survivors.filter((text) => !isStyleModifier(text))
    : survivors

  const clauses: ChatClause[] = []
  for (const text of kept) {
    // The index counts surviving clauses, so a planner entry cannot displace a table one.
    clauses.push({ text, index: clauses.length })
  }
  return clauses
}
