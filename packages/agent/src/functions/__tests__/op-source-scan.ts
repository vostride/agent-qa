// Reads bytes with `node:fs` and strips comments first, so prose naming a forbidden term passes.

import { readFileSync } from 'node:fs'

/** Strip block and line comments and string literals, leaving executable text. */
export function executableSource(source: string): string {
  let out = ''
  let index = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'

  while (index < source.length) {
    const two = source.slice(index, index + 2)
    const one = source[index]!

    if (mode === 'code') {
      if (two === '//') { mode = 'line'; index += 2; continue }
      if (two === '/*') { mode = 'block'; index += 2; continue }
      if (one === "'") { mode = 'single'; out += ' '; index += 1; continue }
      if (one === '"') { mode = 'double'; out += ' '; index += 1; continue }
      if (one === '`') { mode = 'template'; out += ' '; index += 1; continue }
      out += one
      index += 1
      continue
    }
    if (mode === 'line') {
      if (one === '\n') { mode = 'code'; out += '\n' }
      index += 1
      continue
    }
    if (mode === 'block') {
      if (two === '*/') { mode = 'code'; index += 2; continue }
      if (one === '\n') out += '\n'
      index += 1
      continue
    }
    // Inside a string literal. Escapes are skipped whole so `\'` does not close it.
    if (one === '\\') { index += 2; continue }
    if (
      (mode === 'single' && one === "'")
      || (mode === 'double' && one === '"')
      || (mode === 'template' && one === '`')
    ) { mode = 'code' }
    index += 1
  }

  return out
}

export interface SourceScan {
  /** Executable statements, comment- and literal-free, blank lines dropped. */
  readonly statements: readonly string[]
  /** Which forbidden terms appear in executable text, with the statement that carries each. */
  readonly hits: readonly string[]
}

/**
 * Scan text for a forbidden vocabulary.
 *
 * String LITERALS are stripped along with comments, deliberately. An op declares its id and its
 * risk name as literals, and a term appearing inside one is a name, not a call — the claim
 * these scans make is about what the code reaches for, and `'knowledge.records.inspect'` reaches
 * for nothing.
 */
export function scanText(text: string, forbidden: readonly string[]): SourceScan {
  const statements = executableSource(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const hits: string[] = []
  for (const term of forbidden) {
    for (const statement of statements) {
      if (statement.includes(term)) hits.push(`${term} :: ${statement}`)
    }
  }
  return { statements, hits }
}

export function scanFile(path: string, forbidden: readonly string[]): SourceScan {
  return scanText(readFileSync(path, 'utf8'), forbidden)
}

// Scans only `classify` bodies: a whole-file scan flags helpers such as a file-extension check.
export function classifyBodies(source: string): readonly string[] {
  const code = executableSource(source)
  const bodies: string[] = []
  let cursor = 0

  for (;;) {
    const at = code.indexOf('classify(', cursor)
    if (at < 0) return bodies
    const open = code.indexOf('{', at)
    if (open < 0) return bodies

    let depth = 0
    let index = open
    for (; index < code.length; index += 1) {
      if (code[index] === '{') depth += 1
      else if (code[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    bodies.push(code.slice(open, index + 1))
    cursor = index + 1
  }
}
