// The D-12 quote cleaner: rendering noise out, meaning in.
//
// The 399 seeded-red sentence embedded Playwright's raw error verbatim — SGR escapes, a
// "Call log" block, embedded newlines — inside `observed (step 1): "…"`, and it read as an
// escape stream on the CLI, in 392's chat and on the run page alike. D-12 puts the cleaning in
// the ONE renderer's quote leg (`groundingSegment`), so every surface inherits it through the
// single code path rather than each sanitizing at its own boundary — two surfaces reading two
// sentences for one verdict is the exact drift the decision rejects.
//
// WHY NOT `util.stripVTControlCharacters`. RESEARCH recommended Node's built-in stripper.
// `packages/agent` is classed `storageNeutral`, and `PACKAGE_CLASS_RULES.storageNeutral`
// forbids the WHOLE `node:` namespace (`packages/arch/src/contract-types.ts`), so
// `validate:arch` would reject the import. The architecture rule wins; the coverage below
// mirrors what the built-in strips — CSI (including SGR), OSC, the two-byte escape forms and
// the remaining C0/C1 control characters — as pure ECMAScript regexes with no import at all.
//
// WHAT THIS IS NOT. It is not a masker. A declared `[secret:<name>]` marker and an old
// `<SECRET_n>` placeholder are ordinary printable text here and cross byte-identical; masking
// happens before anything is recorded. Sanitization also happens at RENDER time only,
// never at authorship: `validateGroundingQuote` still checks the quote against the raw artifact bytes,
// so a display rule can never reject a verdict that honestly quoted what was captured.

/**
 * A CSI sequence: `ESC [`, parameter bytes, intermediate bytes, one final byte in `@`–`~`.
 *
 * This is the arm that carries SGR (`ESC[2m`, `ESC[22m`) and every cursor-movement form.
 */
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g

/**
 * An OSC sequence: `ESC ]` … terminated by BEL or by the `ESC \` string terminator.
 *
 * Matched NON-greedily and stripped BEFORE the two-byte escape forms, whose final-byte range
 * includes `]` and would otherwise eat the introducer and leave the payload as literal text —
 * an OSC title-set surviving into a terminal print is the T-406-13 injection this closes.
 */
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g

/** The two-byte `ESC <final>` forms (`ESC c`, `ESC (`, the C1 introducers), whatever remains. */
const ESCAPE_PAIR = /\u001b[ -~]/g

/**
 * Remaining C0 and C1 control characters — everything except `\t`–`\r`, which are WHITESPACE.
 *
 * The whitespace controls are deliberately spared here so the collapse below sees them: a
 * newline between two words must become the space that keeps them apart, not vanish and join
 * them into one token.
 */
const NON_WHITESPACE_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * One quoted piece of producer text, made legible without changing what it says.
 *
 * Control sequences are removed and every whitespace run collapses to a single space, trimmed.
 * Nothing is truncated and nothing is reordered: each non-control word of the input survives,
 * in order, which is what lets a reader still recognise the locator in a Playwright timeout.
 */
export function sanitizeQuoteText(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESCAPE_PAIR, '')
    .replace(NON_WHITESPACE_CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
}
