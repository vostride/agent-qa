// The shared module-statement scanner (Phase 384, FUNC-02; kept 2026-10-01, 432-19).
//
// THE evaluate() PIN IS DELETED. Its last two acquisitions — safety's
// in-run gate hook and the safety barrel's re-export — left with the gate itself, so the permitted
// set reached zero entries and there is no gate module, symbol or export left to acquire.
// `EVALUATE_PIN`, its acquisition finder and its offender check left in the same change.
//
// WHAT STAYS IS THE SCANNER, because the other pins read with it: the startRun() pin
// (`startrun-pin.ts`, the one run-starter pin this phase keeps), the agent barrel export-set pin
// (`agent-barrel.ts`) and the chat-model roll call. Two detectors for two pins would be free to
// disagree about what an acquisition is, which is the dual-mechanism class this phase exists to
// remove, so the helpers stay in one file under their original name.
//
// Detection keys on module STATEMENTS, never on call tokens. `page.evaluate(...)` and
// `asserter.evaluate(...)` are all over this codebase; a token scan would drown any pin built on
// it in noise and teach everyone to ignore it.

export interface ModuleStatement {
  keyword: 'import' | 'export'
  /** Everything between the keyword and the specifier — the binding clause. */
  clause: string
  specifier: string
  /** 1-based line of the statement's first line. */
  line: number
}

const STATEMENT_START_RE = /^\s*(?:import|export)\b/
const COMPLETE_STATEMENT_RE = /^\s*(import|export)\s+([\s\S]*?)\s*\bfrom\s*(['"])([^'"]+)\3/

/** Longest run a binding clause may span before we stop looking for its specifier. */
const MAX_CLAUSE_LINES = 24

/**
 * Drop block and line comments so a commented-out statement is never read as real code.
 *
 * ONE PASS, WITH AN ALTERNATION, and the reason is a measured defect rather than style
 * This function used to remove block comments first and
 * line comments second. A LINE comment containing `/*` — this repo has several, e.g.
 * `daemon/host.ts:642`'s "could not touch `daemon/**` that wave" — then opened a phantom
 * block on the first pass, and everything up to the next `*` + `/` disappeared before the
 * second pass ever ran. Measured across the workspace: 15 files where the two orders
 * disagree, including 10,575 characters of `android/src/adapter.ts` and 1,816 of
 * `daemon/host.ts` that the two-pass version made INVISIBLE to every scan built on it —
 * this pin's included. A guard cannot refuse what its stripper deleted.
 *
 * With one alternation neither form can begin inside the other: at the position of a `//`
 * the block alternative fails, the line alternative matches, and the rest of that line is
 * consumed whatever it contains.
 *
 * The `[^:]` guard keeps a protocol-relative URL from being mistaken for a line comment,
 * which is the classic way this kind of stripper eats half a file.
 *
 * THE RESIDUAL LIMITATION, stated rather than left to be found. A comment opener inside a
 * STRING literal is still mistaken for a comment — `packages/android/src/adapter.ts:1189`
 * holds the XPath `'//*[@focused="true"]'`. What changes is the BLAST RADIUS: the two-pass
 * version read that `/*` as a block opener and deleted 10,575 characters up to the next
 * `*` + `/`; this one reads the `//` as a line comment and loses the rest of that one line.
 * A scanner that tokenised TypeScript to do better would be a parser rather than a lint, and
 * a one-line blind spot on a string is a bound this pin can state.
 */
export function stripCodeComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm,
    (_match, kept?: string) => kept ?? '',
  )
}

/**
 * Every module statement that names a specifier, multi-line clauses included.
 *
 * A statement is grown line by line until its specifier appears, stopping at a blank line
 * or at the next statement start. The clause character set is deliberately narrow, so an
 * ordinary `export const` or `export interface` cannot swallow a later statement's
 * specifier and be reported as one binding.
 */
export function parseModuleStatements(source: string): ModuleStatement[] {
  const lines = stripCodeComments(source).split('\n')
  const statements: ModuleStatement[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index]
    if (first === undefined || !STATEMENT_START_RE.test(first)) continue

    let buffer = first
    let consumed = 0
    let matched: RegExpExecArray | null = COMPLETE_STATEMENT_RE.exec(buffer)

    while (matched === null && consumed < MAX_CLAUSE_LINES) {
      const next = lines[index + consumed + 1]
      if (next === undefined || next.trim() === '' || STATEMENT_START_RE.test(next)) break
      buffer = `${buffer}\n${next}`
      consumed += 1
      matched = COMPLETE_STATEMENT_RE.exec(buffer)
    }

    if (matched === null) continue

    const keyword = matched[1] === 'export' ? 'export' : 'import'
    statements.push({
      keyword,
      clause: (matched[2] ?? '').trim(),
      specifier: matched[4] ?? '',
      line: index + 1,
    })
    index += consumed
  }

  return statements
}

/**
 * Repo-relative, forward-slash. Exported so the SECOND pin (`startrun-pin.ts`) shares this
 * file's scanner rather than growing a parallel one — two detectors for two pins would be
 * free to disagree about what an acquisition is, which is the dual-mechanism class this
 * phase exists to remove.
 */
export function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/')
}

/** Resolve a relative specifier against the importing file, extensionless. Shared. */
export function resolveRelative(file: string, specifier: string): string {
  const segments = normalizeRepoPath(file).split('/').slice(0, -1)

  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(part)
  }

  return segments.join('/').replace(/\.(?:ts|tsx|js|mjs|cjs)$/, '')
}

export interface ClauseShape {
  typeOnly: boolean
  wholeModule: boolean
  /** Imported (left-hand) names bound in VALUE position; an alias is discarded. */
  valueNames: string[]
}

export function readClause(clause: string): ClauseShape {
  if (/^type\b/.test(clause)) {
    return { typeOnly: true, wholeModule: false, valueNames: [] }
  }

  const braced = /\{([\s\S]*)\}/.exec(clause)
  if (braced === null) {
    // `* as ns`, `* `, or a bare default binding. Each one is a whole-module value
    // acquisition for our purposes — a default binding is the CJS namespace under
    // interop, and a pin that guessed otherwise would guess in the unsafe direction.
    return { typeOnly: false, wholeModule: true, valueNames: [] }
  }

  const valueNames = (braced[1] ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .filter(entry => !/^type\b/.test(entry))
    .map(entry => (entry.split(/\s+as\s+/)[0] ?? entry).trim())
    .filter(entry => entry !== '')

  return { typeOnly: false, wholeModule: false, valueNames }
}

