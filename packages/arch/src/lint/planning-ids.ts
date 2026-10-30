// Pure matchers for the planning-ID lint. No typescript import: the whole-tree walk that parses
// TS and JS lives in src/__tests__, so arch's dependency reconciliation stays exact.

export type PlanningIdKind = 'comment' | 'title' | 'string' | 'file name'

export interface PlanningIdHit {
  readonly file: string
  readonly line: number
  readonly kind: PlanningIdKind
  readonly text: string
}

export interface TextHit {
  readonly index: number
  readonly end: number
  readonly text: string
}

export interface CommentParagraph {
  readonly line: number
  readonly text: string
}

export interface LineHit {
  readonly line: number
  readonly text: string
}

export interface PathHit {
  readonly path: string
  readonly segment: string
  readonly text: string
}

const EXCLUDED = '(?!(?:UTF|SHA|ISO|E2E|TST|RUN|MEM|POL|TGT)-)'

export const PLANNING_ID_PATTERNS: readonly RegExp[] = [
  /(?<![\w.:/-])\d{3}(?:\.\d+)?-\d{1,2}(?:\/\d{1,2})*(?![\w-])/g,
  /\b[Pp]hase\s+\d{3}(?:\.\d+)?\b/g,
  /\bD-\d{1,3}(?!\d)/g,
  /\b(?:WR|CR|IN|BL|HR|MR|LR|IR)-\d{2,3}(?!\d)/g,
  /\b[TGF]-\d{3}(?:\.\d+)?-[A-Z0-9]/g,
  /\bC(?:\d{3}(?:\.\d+)?-[A-Z]|\d{6}-[A-Z0-9]{3})/g,
  /\bWINDOWS\s*#?\s*\d+/g,
  /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[a-z0-9]{3}\b/g,
  new RegExp(`\\b${EXCLUDED}[A-Z][A-Z0-9]+(?:-[A-Z][A-Z0-9]*)*-\\d{2}(?![\\w])`, 'g'),
  /\bRETUNE\b/g,
]

export const ISO_DATE = /(?<![\w-])\d{4}-\d{2}-\d{2}(?!\d)/g

const B = '(?:^|[-_.])'
const E = '(?=[-_.]|$)'

export const PATH_PATTERNS: readonly RegExp[] = [
  new RegExp(`${B}\\d{3}(?:\\.\\d+)?-\\d{1,2}${E}`, 'i'),
  /phase[-_]?\d{3}/i,
  new RegExp(`${B}d-\\d{1,3}${E}`, 'i'),
  new RegExp(`${B}(?:wr|cr|in|bl|hr|mr|lr|ir)-\\d{2,3}${E}`, 'i'),
  new RegExp(`${B}[tgf]-\\d{3}(?:\\.\\d+)?-[a-z0-9]`, 'i'),
  new RegExp(`${B}c\\d{3}(?:\\.\\d+)?-[a-z]`, 'i'),
  /windows[-_]?#?\d+/i,
  new RegExp(`${B}\\d{6}-[a-z0-9]{3}${E}`, 'i'),
  new RegExp(`${B}(?!(?:utf|sha|iso|e2e|tst|run|mem|pol|tgt)-)[a-z][a-z0-9]+-\\d{2}${E}`, 'i'),
  /retune/i,
  /^\d{3}(?:\.\d+)?[-_.]/,
]

function matchesOf(re: RegExp, text: string): TextHit[] {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return [...text.matchAll(global)].map((m) => ({
    index: m.index,
    end: m.index + m[0].length,
    text: m[0],
  }))
}

export function planningIdsIn(text: string): TextHit[] {
  const seen = new Map<string, TextHit>()
  for (const re of PLANNING_ID_PATTERNS) {
    for (const hit of matchesOf(re, text)) {
      const key = `${hit.index}:${hit.end}`
      if (!seen.has(key)) seen.set(key, hit)
    }
  }
  return [...seen.values()].sort((a, b) => a.index - b.index || a.end - b.end)
}

// Code spans pair a run of backticks with the next run of the same length, across line breaks;
// their bodies are blanked and newlines kept, so offsets and line numbers stay right.
export const maskCodeSpans = (paragraph: string): string =>
  paragraph.replace(
    /(`+)([\s\S]*?)\1/g,
    (_match, ticks: string, body: string) => ticks + body.replace(/[^\n]/g, ' ') + ticks,
  )

export function datesOutsideCode(paragraph: string): TextHit[] {
  return matchesOf(ISO_DATE, maskCodeSpans(paragraph)).map((hit) => ({
    ...hit,
    text: paragraph.slice(hit.index, hit.end),
  }))
}

const linesBefore = (text: string, index: number) =>
  text.slice(0, index).split('\n').length - 1

// Planning IDs and dates outside code spans in one comment paragraph or test title.
export function proseHits(paragraph: CommentParagraph): LineHit[] {
  return [...planningIdsIn(paragraph.text), ...datesOutsideCode(paragraph.text)]
    .sort((a, b) => a.index - b.index)
    .map((hit) => ({
      line: paragraph.line + linesBefore(paragraph.text, hit.index),
      text: hit.text,
    }))
}

// Planning IDs only, for a string literal: dates in strings are values.
export function stringHits(literal: CommentParagraph): LineHit[] {
  return planningIdsIn(literal.text).map((hit) => ({
    line: literal.line + linesBefore(literal.text, hit.index),
    text: hit.text,
  }))
}

// Every path segment and its parent directories, checked case-insensitively against the
// separator-aware shapes and the phase-number prefix.
export function pathPlanningIds(path: string): PathHit[] {
  const parts = path.split('/')
  const out: PathHit[] = []
  parts.forEach((segment, i) => {
    const found = new Set<string>()
    for (const re of PATH_PATTERNS) {
      const match = re.exec(segment)
      if (match) found.add(match[0].replace(/^[-_.]/, ''))
    }
    for (const text of found) out.push({ path: parts.slice(0, i + 1).join('/'), segment, text })
  })
  return out
}

export const isTestPath = (path: string): boolean => {
  const name = path.split('/').pop() ?? ''
  return (
    path.split('/').includes('__tests__') || name.includes('.test.') || name.includes('.test-d.')
  )
}

export const isCodePath = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)

export const readsStrings = (path: string): boolean =>
  /^(?:packages\/[^/]+|scripts)\//.test(path) && isCodePath(path) && !isTestPath(path)

export const isCssPath = (path: string): boolean => path.endsWith('.css')

type HashSyntax = 'shell' | 'docker' | 'ignore' | 'yaml'

const IGNORE_FILES = new Set(['.gitignore', '.dockerignore', '.gitattributes', '.npmignore'])

export function hashSyntax(path: string): HashSyntax | null {
  const name = path.split('/').pop() ?? ''
  if (name.endsWith('.sh')) return 'shell'
  if (name.startsWith('Dockerfile')) return 'docker'
  if (IGNORE_FILES.has(name)) return 'ignore'
  if (/\.ya?ml$/.test(name)) return 'yaml'
  return null
}

interface SourceLine {
  readonly text: string
  readonly offset: number
  readonly line: number
}

interface HashRange {
  readonly pos: number
  readonly end: number
  readonly line: number
  readonly whole: boolean
}

function splitLines(text: string): SourceLine[] {
  const out: SourceLine[] = []
  let offset = 0
  text.split('\n').forEach((raw, i) => {
    out.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset, line: i + 1 })
    offset += raw.length + 1
  })
  return out
}

const HEREDOC = /^<<([-~]?)[ \t]*\\?(["']?)([A-Za-z_][\w.-]*)\2/

interface Heredoc {
  readonly word: string
  readonly mode: string
}

// Quotes and heredoc bodies carry from line to line; a `#` starts a comment only at a word start.
function shellScan(lines: readonly SourceLine[], shebang: boolean): HashRange[] {
  const ranges: HashRange[] = []
  const queue: Heredoc[] = []
  let quote: string | null = null
  let heredoc: Heredoc | null = null
  lines.forEach(({ text, offset, line }, li) => {
    if (heredoc) {
      const cmp =
        heredoc.mode === '-'
          ? text.replace(/^\t+/, '')
          : heredoc.mode === '~'
            ? text.trimStart()
            : text
      if (cmp === heredoc.word) heredoc = queue.shift() ?? null
      return
    }
    if (li === 0 && shebang && text.startsWith('#!')) return
    let i = 0
    while (i < text.length) {
      const c = text[i]
      if (quote === "'") {
        if (c === "'") quote = null
        i++
        continue
      }
      if (quote !== null) {
        if (c === '\\') i += 2
        else {
          if (c === (quote === '"' ? '"' : "'")) quote = null
          i++
        }
        continue
      }
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === "'") quote = "'"
      else if (c === '$' && text[i + 1] === "'") {
        quote = "$'"
        i++
      } else if (c === '"') quote = '"'
      else if (c === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1] ?? ''))) {
        ranges.push({
          pos: offset + i,
          end: offset + text.length,
          line,
          whole: text.slice(0, i).trim() === '',
        })
        break
      } else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
        const m = HEREDOC.exec(text.slice(i))
        if (m) {
          queue.push({ word: m[3] ?? '', mode: m[1] ?? '' })
          i += m[0].length
          continue
        }
      }
      i++
    }
    if (quote === null && heredoc === null && queue.length > 0) heredoc = queue.shift() ?? null
  })
  return ranges
}

function dockerScan(text: string): HashRange[] {
  const ranges: HashRange[] = []
  const queue: Heredoc[] = []
  let heredoc: Heredoc | null = null
  for (const { text: t, offset, line } of splitLines(text)) {
    if (heredoc) {
      const cmp = heredoc.mode === '-' ? t.replace(/^\t+/, '') : t
      if (cmp === heredoc.word) heredoc = queue.shift() ?? null
      continue
    }
    const hash = /^\s*#/.exec(t)
    if (hash) {
      ranges.push({ pos: offset + hash[0].length - 1, end: offset + t.length, line, whole: true })
      continue
    }
    for (const m of t.matchAll(/(?<!<)<<(?!<)(-?)(["']?)([A-Za-z_][\w.-]*)\2/g)) {
      queue.push({ word: m[3] ?? '', mode: m[1] ?? '' })
    }
    if (heredoc === null && queue.length > 0) heredoc = queue.shift() ?? null
  }
  return ranges
}

const ignoreScan = (text: string): HashRange[] =>
  splitLines(text)
    .filter((l) => l.text.startsWith('#'))
    .map((l) => ({ pos: l.offset, end: l.offset + l.text.length, line: l.line, whole: true }))

const BLOCK_SCALAR = /(?:^|\s)[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/
const indentOf = (text: string) => /^ */.exec(text)?.[0].length ?? 0

interface ScalarBlock {
  readonly keyCol: number
  readonly run: boolean
  readonly lines: SourceLine[]
}

// YAML comments, plus the shell comments inside a workflow's `run: |` blocks.
function yamlScan(path: string, text: string): HashRange[] {
  const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
  const ranges: HashRange[] = []
  let quote: string | null = null
  let block: ScalarBlock | null = null
  const finish = (done: ScalarBlock) => {
    if (done.run && done.lines.length > 0) {
      const indent = Math.min(
        ...done.lines.filter((l) => l.text.trim() !== '').map((l) => indentOf(l.text)),
      )
      const body = done.lines.map((l) => {
        const cut = Math.min(indent, indentOf(l.text))
        return { text: l.text.slice(cut), offset: l.offset + cut, line: l.line }
      })
      ranges.push(...shellScan(body, false))
    }
    block = null
  }
  for (const L of splitLines(text)) {
    const t = L.text
    if (block !== null) {
      const open: ScalarBlock = block
      if (t.trim() === '' || indentOf(t) > open.keyCol) {
        open.lines.push(L)
        continue
      }
      finish(open)
    }
    let i = 0
    let valueStart = quote === null
    let commentAt = -1
    while (i < t.length) {
      const c = t[i] ?? ''
      const next = t[i + 1]
      if (quote === "'") {
        if (c === "'") {
          if (next === "'") {
            i += 2
            continue
          }
          quote = null
        }
        i++
        continue
      }
      if (quote === '"') {
        if (c === '\\') i += 2
        else {
          if (c === '"') quote = null
          i++
        }
        continue
      }
      if (c === '#' && (i === 0 || /\s/.test(t[i - 1] ?? ''))) {
        commentAt = i
        break
      }
      const endsToken = next === undefined || /\s/.test(next)
      if ((c === "'" || c === '"') && valueStart) quote = c
      else if (/\s/.test(c)) {
        // whitespace leaves valueStart as it is
      } else if ((c === '-' || c === '?') && endsToken && valueStart) {
        // a sequence or mapping-key marker; a value may follow
      } else if (c === ':' && endsToken) valueStart = true
      else if ('[{,'.includes(c)) valueStart = true
      else valueStart = false
      i++
    }
    if (commentAt >= 0) {
      ranges.push({
        pos: L.offset + commentAt,
        end: L.offset + t.length,
        line: L.line,
        whole: t.slice(0, commentAt).trim() === '',
      })
    }
    if (quote !== null) continue
    const code = commentAt >= 0 ? t.slice(0, commentAt) : t
    if (BLOCK_SCALAR.test(code) && /(?:^|[:\s-])\s*[|>][^|>]*$/.test(code)) {
      const keyed = /^(\s*(?:-\s+)*)([^\s#][^:]*?)\s*:\s+[|>]/.exec(code)
      const dash = /^(\s*(?:-\s+)*)-\s+[|>]/.exec(code)
      const keyCol = keyed
        ? (keyed[1] ?? '').length
        : dash
          ? (dash[1] ?? '').length
          : indentOf(code)
      block = { keyCol, run: workflow && keyed?.[2] === 'run', lines: [] }
    }
  }
  if (block !== null) finish(block)
  return ranges
}

const BLANK_COMMENT_LINE = /^\s*(?:\/\/+|\*|#)\s*$/

// Whole-line `#` comments on consecutive lines form one paragraph, split at blank ones; a
// trailing comment stands alone.
function hashParagraphs(text: string, ranges: readonly HashRange[]): CommentParagraph[] {
  const out: { start: number; end: number; line: number; whole: boolean; lastLine: number }[] = []
  let current: (typeof out)[number] | null = null
  for (const r of ranges) {
    if (BLANK_COMMENT_LINE.test(text.slice(r.pos, r.end))) {
      current = null
      continue
    }
    if (current && r.whole && current.whole && r.line === current.lastLine + 1) {
      current.end = r.end
      current.lastLine = r.line
    } else {
      current = { start: r.pos, end: r.end, line: r.line, whole: r.whole, lastLine: r.line }
      out.push(current)
    }
  }
  return out.map((p) => ({ line: p.line, text: text.slice(p.start, p.end) }))
}

// The `#` comment paragraphs of a shell, Dockerfile, ignore or YAML file, each with its first
// line. A `#` inside quotes is not a comment, and a line-1 `#!` is skipped.
export function hashCommentLines(path: string, text: string): CommentParagraph[] {
  switch (hashSyntax(path)) {
    case 'shell':
      return hashParagraphs(text, shellScan(splitLines(text), true))
    case 'docker':
      return hashParagraphs(text, dockerScan(text))
    case 'ignore':
      return hashParagraphs(text, ignoreScan(text))
    case 'yaml':
      return hashParagraphs(text, yamlScan(path, text))
    default:
      return []
  }
}

export function cssComments(text: string): CommentParagraph[] {
  return [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({
    line: linesBefore(text, m.index) + 1,
    text: m[0],
  }))
}

// Splits one block comment, or a run of `//` lines joined as written, at blank comment lines.
export function commentParagraphs(text: string, firstLine: number): CommentParagraph[] {
  const out: CommentParagraph[] = []
  let start: number | null = null
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (BLANK_COMMENT_LINE.test(line)) {
      if (start !== null) {
        out.push({ line: firstLine + start, text: lines.slice(start, i).join('\n') })
      }
      start = null
    } else if (start === null) start = i
  })
  if (start !== null) out.push({ line: firstLine + start, text: lines.slice(start).join('\n') })
  return out
}

const oneLine = (text: string) => text.replace(/\r?\n/g, '\\n')

export const formatHit = (hit: PlanningIdHit): string =>
  `${hit.file}:${hit.line} ${hit.kind} ${oneLine(hit.text)}`
