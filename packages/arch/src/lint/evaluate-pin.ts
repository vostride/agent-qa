// Detects module statements, never call tokens: `page.evaluate(...)` is everywhere.

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

// One alternation, so a block opener inside a line comment never hides the code after it.
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

// Exported so `startrun-pin.ts` shares this scanner: two detectors could disagree on acquisition.
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

