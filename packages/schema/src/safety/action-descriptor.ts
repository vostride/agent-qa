import type { Surface } from '../action'

/**
 * Neutral, browser-safe risk descriptor an op declares. The MCP projection reads `readOnly` and
 * `destructive` to set each tool's hints.
 */
export interface RiskActionDescriptor {
  /** Action verb/id, e.g. 'web_navigate', 'git_push', or 'trigger_cloud_run'. */
  name: string
  /** True when the action is a known or registered action. */
  recognized: boolean
  /** Optional originating surface, when known. */
  surface?: Surface
  /** Advisory "has a side effect" hint. */
  destructive?: boolean
  /** Advisory read-only hint. */
  readOnly?: boolean
}


// ---- the scrub, beside the descriptor it used to serve (401-15, WR-01 / T-401-G5 / T-401-G6) ----
//
// The scrub was written for the deleted per-invocation disclosure. It survives because the
// production refusal (`config/production.ts`) interpolates target names out of a config document
// into its one sentence, and those names are text this module does not own: control bytes are
// replaced, length is capped and the cut is visible, on every channel the sentence reaches.
//
// PURE, SYNCHRONOUS, DEPENDENCY-FREE. `packages/schema` is browser-safe with zero internal
// dependencies and may take none; everything below is string work.

/**
 * What a scrubbed control character leaves behind.
 *
 * REPLACED, NEVER DROPPED. A deleted control byte turns a hostile name into one that reads like an
 * ordinary name — the attack succeeds at looking innocent. A visible replacement leaves a name that
 * reads as odd, which is the outcome a person can act on.
 */
export const DISCLOSURE_REPLACEMENT_CHARACTER = '\uFFFD'

/** The mark a truncated fragment ends with, so shortening is visible rather than silent. */
export const DISCLOSURE_TRUNCATION_MARK = '…'

/** How much of one untrusted fragment survives into the sentence. */
export const DISCLOSURE_FRAGMENT_MAX_LENGTH = 48

/**
 * Everything a terminal or a browser ACTS on rather than draws.
 *
 * C0 (\u0000-\u001F) and C1 (\u007F-\u009F) cover the newline that adds a line, the carriage return
 * that redraws one, and the ESC that introduces every CSI sequence — including the erase-line and
 * cursor-up pair that overwrites the line above without adding anything.
 *
 * The four beyond the control ranges are line/paragraph separators and the bidi overrides: \u2028
 * and \u2029 break lines in a browser exactly as \u000A does in a terminal, and \u202A-\u202E /
 * \u2066-\u2069 reorder what a reader sees without changing a byte of what they are reading.
 */
const DISCLOSURE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/**
 * Make one untrusted fragment safe to interpolate into a single line a person reads.
 *
 * THREE THINGS, AND EACH ONE IS A SEPARATE ATTACK CLOSED:
 * - control bytes replaced, so no fragment can add, erase or reorder a line;
 * - a length cap with a visible mark, so no fragment can consume the sentence it sits in;
 * - quoting, so where the fragment ENDS is legible — an odd name reads as odd rather than as prose
 *   the product wrote.
 *
 * IT IS NOT AN ESCAPER AND MUST NOT BECOME ONE. The output is for a person to read, not for a shell
 * or a parser to consume. Nothing here promises round-tripping; a scrubbed name is a rendering.
 */
export function scrubDisclosureFragment(fragment: string): string {
  const flattened = fragment.replace(DISCLOSURE_UNSAFE, DISCLOSURE_REPLACEMENT_CHARACTER)
  const capped = flattened.length > DISCLOSURE_FRAGMENT_MAX_LENGTH
    ? `${flattened.slice(0, DISCLOSURE_FRAGMENT_MAX_LENGTH)}${DISCLOSURE_TRUNCATION_MARK}`
    : flattened
  return `"${capped}"`
}

/** How much of a whole composed disclosure line survives. */
export const DISCLOSURE_TEXT_MAX_LENGTH = 512

/**
 * The same hygiene for a WHOLE composed disclosure, where the composition owns the prose.
 *
 * SEPARATE FROM THE FRAGMENT FORM BECAUSE THE INPUT IS A DIFFERENT SHAPE. A fragment is a noun the
 * sentence interpolates and quoting it is exactly right; a whole composed sentence (since 432-42
 * only the production refusal's, `buildProductionRefusal`; the per-op `FunctionSpec.disclose` is
 * deleted) would render as a quotation if wrapped. What
 * both share is the rule that actually matters — no byte on this channel may act on the channel.
 *
 * THE CAP IS GENEROUS AND STILL A CAP. An op composes its own prose, so the realistic risk is an
 * unbounded caller-derived substring rather than a long sentence; a bound that no honest disclosure
 * reaches still removes "unbounded" from what a caller controls.
 */
export function scrubDisclosureText(text: string): string {
  const flattened = text.replace(DISCLOSURE_UNSAFE, DISCLOSURE_REPLACEMENT_CHARACTER)
  return flattened.length > DISCLOSURE_TEXT_MAX_LENGTH
    ? `${flattened.slice(0, DISCLOSURE_TEXT_MAX_LENGTH)}${DISCLOSURE_TRUNCATION_MARK}`
    : flattened
}
