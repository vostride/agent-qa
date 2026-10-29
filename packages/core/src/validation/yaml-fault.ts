/**
 * A yaml parse failure as a POSITION, and as nothing else (395-10 · GAP 1 / CR-01 · 395-14 · F-01).
 *
 * THE ERROR IS NOT A MESSAGE SOURCE HERE. `yaml`'s `YAMLParseError` carries `linePos` — where the
 * parser gave up — beside a `message` that is pretty-printed with a verbatim excerpt of the
 * offending source line and a caret beneath the column. Every other property (`message`, `code`,
 * the object's own stringification) is derived from the person's file content and is therefore not
 * this product's to publish: the strings built from this one are persisted in blocked records,
 * printed by `proposals show`, thrown out of every config op, printed by `agent-qa validate`, and —
 * through `refusalMessage` — carried into a chat turn's answer and its session jsonl. So this
 * function reads two NUMBERS and composes a sentence of its own.
 *
 * THE FALLBACK IS VALUE-FREE TOO, and that is the point of having one. A throw with no `linePos` is
 * not a yaml parse error this product recognises, and the tempting repair — fall back to the error's
 * message when the position is missing — would reopen the whole channel for exactly the inputs
 * nobody anticipated.
 *
 * IT LIVES IN CORE AND HAS THREE CALLERS. It was a private copy in the cli composition
 * root; the loader guard and core's own `validateConfig` arm need the SAME sentence, and two
 * spellings of one sentence are two things that can drift apart. One primitive, three callers:
 * `cli/src/config.ts`, `core/src/validation/validate.ts`, and the cli validate port.
 *
 * THE ARGUMENT IS GUARDED BEFORE IT IS READ (395-14 · WR-08 / F-09). A `throw null` or a
 * `throw 'boom'` is a legal throw; the 395-10 copy reached for `.linePos` unguarded and answered a
 * TypeError for `null` — a crash inside the code whose whole job is to turn a fault into a sentence.
 */
export function yamlParseFailureMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'not readable as YAML (position unavailable)'
  }
  const linePos = (error as { linePos?: readonly { line?: unknown; col?: unknown }[] }).linePos
  const first = Array.isArray(linePos) ? linePos[0] : undefined
  if (typeof first?.line === 'number' && typeof first.col === 'number') {
    return `not readable as YAML at line ${first.line}, column ${first.col}`
  }
  return 'not readable as YAML (position unavailable)'
}
