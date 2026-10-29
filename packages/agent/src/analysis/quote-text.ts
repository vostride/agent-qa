// No `node:` import is allowed in this storage-neutral package, so the strip is pure regexes.

/**
 * A CSI sequence: `ESC [`, parameter bytes, intermediate bytes, one final byte in `@`–`~`.
 *
 * This is the arm that carries SGR (`ESC[2m`, `ESC[22m`) and every cursor-movement form.
 */
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g

// Stripped before the two-byte escapes, which would eat the `]` and leave the payload as text.
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
