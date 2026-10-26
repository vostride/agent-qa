/**
 * The schema version census.
 *
 * Every format agent-qa stamps into a document, record, envelope, token, file or database reads
 * one stamp, 2, and refuses, rebuilds or misses on any other. A writer that stamps another value,
 * or a reader that admits a second one, is a regression the compiler cannot see once a literal is
 * typed loosely, so this file holds the source to the register in ../version-register.ts:
 *
 *   - every production version constant is registered at its value or excluded with a reason;
 *   - every inline stamp, literal and exact check matches the register by file, literal and count;
 *   - no reader admits a second version: no migration step, alias, dual-stamp helper, union of two
 *     stamp literals, union keyed on the stamp, or stamp typed as a union;
 *   - every hand-written copy of a value spells the value of its source;
 *   - both skills contracts read 2, and the two copies are identical;
 *   - every schemaVersion stamp in the repository's fixtures is 2, apart from the spelled exclusions.
 *
 * Excluded, each with its reason in the register: external specifications, package and product
 * versions, content and algorithm versions, hash and RNG domain tags, the bundled floor model asset,
 * one-shot scripts kept as history, and a rebuild-reason label.
 *
 * Comments are blanked before any production file is matched, every needle is assembled from two
 * halves at run time so this file spells none of them, and the planted cells prove each scanner
 * fires on code and not on a comment. Everything read lies inside this repository.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  FIXTURE_STAMP_EXCLUSIONS,
  INLINE_STAMPS,
  JSON_STAMPS,
  VERSION_EXCLUSIONS,
  VERSION_REGISTER,
  type RegisteredVersion,
} from '../version-register.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
const posix = (path: string): string => path.split(sep).join('/')
const OWN = posix(relative(REPO_ROOT, THIS_FILE))
const REGISTER_FILE = posix(relative(REPO_ROOT, fileURLToPath(new URL('../version-register.ts', import.meta.url))))
const ARCH_SOURCE = `${posix(relative(REPO_ROOT, fileURLToPath(new URL('../', import.meta.url))))}/`

// ---------------------------------------------------------------------------------------------
// The lexer: comments out, code and strings in
// ---------------------------------------------------------------------------------------------

function regexAllowed(out: string): boolean {
  let k = out.length - 1
  while (k >= 0 && /\s/.test(out[k]!)) k--
  if (k < 0) return true
  if ('(,=:[!&|?{};+-*%<>~^'.includes(out[k]!)) return true
  const word = /([A-Za-z_$][\w$]*)$/.exec(out.slice(0, k + 1))
  return word !== null
    && ['return', 'typeof', 'case', 'yield', 'await', 'in', 'of', 'void', 'delete'].includes(word[1]!)
}

function codeOf(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  const templateDepths: number[] = []
  let depth = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < n) {
    const c = text[i]!
    const d = text[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '/' && regexAllowed(out)) {
        let j = i + 1
        let inClass = false
        while (j < n && text[j] !== '\n') {
          const ch = text[j]
          if (ch === '\\') { j += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) break
          j++
        }
        if (j < n && text[j] === '/') {
          j++
          while (j < n && /[a-z]/i.test(text[j]!)) j++
          out += text.slice(i, j)
          i = j
          continue
        }
      }
      if (c === "'") { state = 'single'; out += c; i++; continue }
      if (c === '"') { state = 'double'; out += c; i++; continue }
      if (c === '`') { state = 'template'; out += c; i++; continue }
      if (c === '{') { depth++; out += c; i++; continue }
      if (c === '}') {
        if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
          templateDepths.pop()
          depth--
          state = 'template'
          out += c
          i++
          continue
        }
        depth--
        out += c
        i++
        continue
      }
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"'
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === quote || c === '\n') state = 'code'
      out += c
      i++
      continue
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === '`') { state = 'code'; out += c; i++; continue }
    if (c === '$' && d === '{') { depth++; templateDepths.push(depth); state = 'code'; out += '${'; i += 2; continue }
    out += c
    i++
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The universe: production source of every package but this one
// ---------------------------------------------------------------------------------------------

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist'])

function listTree(root: string, keep: (file: string) => boolean): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(REPO_ROOT, dir))) return
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(`${child}/`)
      } else if (keep(child)) files.push(child)
    }
  }
  walk(root)
  return files.sort()
}

const isProduction = (file: string): boolean =>
  /\.tsx?$/.test(file) && !file.includes('/__tests__/') && !/\.test(-d)?\.tsx?$/.test(file)

const packageSources = (): string[] =>
  readdirSync(join(REPO_ROOT, 'packages'))
    .filter((name) => existsSync(join(REPO_ROOT, 'packages', name, 'src')))
    .map((name) => `packages/${name}/src/`)
    .sort()

function productionFiles(): string[] {
  return [
    ...packageSources().filter((root) => root !== ARCH_SOURCE).flatMap((root) => listTree(root, isProduction)),
  ]
}

const bytesOf = (file: string): string => readFileSync(join(REPO_ROOT, file)).toString('utf8')

const codeCache = new Map<string, string>()
function code(file: string): string {
  let cached = codeCache.get(file)
  if (cached === undefined) {
    cached = existsSync(join(REPO_ROOT, file)) ? codeOf(bytesOf(file)) : ''
    codeCache.set(file, cached)
  }
  return cached
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

// ---------------------------------------------------------------------------------------------
// The needles, every one assembled from two halves
// ---------------------------------------------------------------------------------------------

type Halves = readonly [string, string]
const joined = (halves: Halves): string => halves[0] + halves[1]
const cat = (...parts: string[]): string => parts.join('')
const rx = (halves: Halves, flags = ''): RegExp => new RegExp(joined(halves), flags)

/** `const NAME = <number or string literal>`, with an optional type and `as const`. */
const CONSTANT_DECLARATION: Halves = [
  '\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*(\\d+|\'[^\'\\n]*\'|"[^"\\n]*")',
  '(?:\\s+as\\s+const)?\\s*(?=;|$)',
]
const VERSION_NAME = /(^|_)VERSION$/

/** A stamp written, typed, validated or checked as a number literal. */
const INLINE_NEEDLES: readonly Halves[] = [
  ['\\bschemaVer', 'sion[\'"]?\\??\\s*:\\s*(\\d+)\\b'],
  ['\\bschemaVer', 'sion[\'"]?\\??\\s*:\\s*z\\.literal\\(\\s*(\\d+)\\s*\\)'],
  ['\\bver', 'sion[\'"]?\\??\\s*:\\s*z\\.literal\\(\\s*(\\d+)\\s*\\)'],
  ['\\bschemaVer', 'sion\\s*[!=]==?\\s*(\\d+)\\b'],
  ['\\.ver', 'sion\\s*[!=]==?\\s*(\\d+)\\b'],
]

/** A reader that admits a second version, each with what it is. */
const SECOND_VERSION_NEEDLES: readonly (readonly [string, Halves])[] = [
  // Lazy up to the first `=` that is neither `=>` nor a comparison, so a function type in the
  // annotation does not hide the initializer.
  ['a migration step', [
    '\\b(?:MigrationRegis',
    'try|\\w*_MIGRATIONS)\\b[^;\\n]*?(?<![=!<>])=(?![=>])\\s*\\{\\s*[^}\\s]',
  ]],
  ['a step assigned into a registry', ['\\b\\w*_MIGRA', 'TIONS\\s*\\[[^\\]\\n]+\\]\\s*=(?![=>])']],
  ['a migrations object with a step', ['\\bmigra', 'tions\\s*:\\s*\\{\\s*[^}\\s]']],
  ['a stamp read as current', ['(?:readAsCur', 'rent|_READ_AS_' + 'CURRENT)\\b']],
  ['a dual-stamp helper', ['(?:[rR]eadableSt', 'amp|PRE_V2_' + 'STAMP)\\b']],
  ['a union of two stamp literals', [
    '\\b(?:schemaVer',
    'sion|version)[\'"]?\\??\\s*:\\s*z\\.union\\(\\s*\\[\\s*z\\.literal\\([^)]*\\)\\s*,\\s*z\\.literal\\(',
  ]],
  ['a stamp literal joined to another', ['\\b(?:schemaVer', 'sion|version)[\'"]?\\??\\s*:\\s*z\\.literal\\([^)]*\\)\\s*\\.or\\(']],
  ['a union keyed on the stamp', ['discriminatedUn', 'ion\\(\\s*[\'"](?:schemaVersion|version)[\'"]']],
  ['a stamp typed as a union', ['\\b(?:schemaVer', 'sion|version)\\??\\s*:\\s*(?:\\d+|typeof\\s+[\\w$]+)\\s*\\|']],
]
const EMPTY_MIGRATIONS: Halves = ['\\bmigra', 'tions\\s*:\\s*\\{\\s*\\}']

const STAMP_KEY = joined(['schemaVer', 'sion'])
const FRONTMATTER_STAMP: Halves = ['^schemaVer', 'sion:\\s*(\\d+)\\s*$']
const INLINE_JSON_STAMP: Halves = ['"schemaVer', 'sion"\\s*:\\s*(\\d+)']

// ---------------------------------------------------------------------------------------------
// The scanners
// ---------------------------------------------------------------------------------------------

type Literal = number | string

interface ConstantHit {
  readonly file: string
  readonly line: number
  readonly name: string
  readonly value: Literal
}

const literalOf = (raw: string): Literal => (/^\d+$/.test(raw) ? Number(raw) : raw.slice(1, -1))

function versionConstants(file: string, text: string): ConstantHit[] {
  return [...text.matchAll(rx(CONSTANT_DECLARATION, 'gm'))]
    .filter((m) => VERSION_NAME.test(m[1]!))
    .map((m) => ({ file, line: lineAt(text, m.index), name: m[1]!, value: literalOf(m[2]!) }))
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

interface NamedSite {
  readonly site: string
  readonly name: string
  readonly row: RegisteredVersion
}

function registeredNames(): NamedSite[] {
  return VERSION_REGISTER.flatMap((row) => [
    ...(row.name === undefined ? [] : [{ site: row.site, name: row.name, row }]),
    ...(row.copies ?? [])
      .filter((copy) => IDENTIFIER.test(copy.spelling))
      .map((copy) => ({ site: copy.site, name: copy.spelling, row })),
  ])
}

function constantOffenders(hits: readonly ConstantHit[]): string[] {
  const named = registeredNames()
  return hits.flatMap((hit) => {
    const at = `${hit.file}:${hit.line}: ${hit.name} = ${JSON.stringify(hit.value)}`
    const registered = named.find((entry) => entry.site === hit.file && entry.name === hit.name)
    if (registered !== undefined) {
      return registered.row.value === hit.value ? [] : [`${at} is registered at ${JSON.stringify(registered.row.value)}`]
    }
    const excluded = VERSION_EXCLUSIONS.some((row) => row.site === hit.file && row.name === hit.name)
    return excluded ? [] : [`${at} is neither registered nor excluded`]
  })
}

function inlineCounts(text: string): Map<number, number> {
  const counts = new Map<number, number>()
  for (const needle of INLINE_NEEDLES) {
    for (const m of text.matchAll(rx(needle, 'g'))) {
      const literal = Number(m[1])
      counts.set(literal, (counts.get(literal) ?? 0) + 1)
    }
  }
  return counts
}

function registeredInline(): Map<string, Map<number, number>> {
  const bySite = new Map<string, Map<number, number>>()
  const add = (site: string, literal: number, count: number): void => {
    const counts = bySite.get(site) ?? new Map<number, number>()
    counts.set(literal, (counts.get(literal) ?? 0) + count)
    bySite.set(site, counts)
  }
  for (const row of INLINE_STAMPS) add(row.site, row.literal, row.count)
  for (const row of VERSION_EXCLUSIONS) if (row.inline !== undefined) add(row.site, row.inline.literal, row.inline.count)
  return bySite
}

interface Source {
  readonly file: string
  readonly text: string
}

function inlineOffenders(sources: readonly Source[]): string[] {
  const registered = registeredInline()
  return sources.flatMap(({ file, text }) => {
    const found = inlineCounts(text)
    const wanted = registered.get(file) ?? new Map<number, number>()
    return [...new Set([...found.keys(), ...wanted.keys()])]
      .sort((a, b) => a - b)
      .filter((literal) => (found.get(literal) ?? 0) !== (wanted.get(literal) ?? 0))
      .map((literal) => `${file}: literal ${literal} appears ${found.get(literal) ?? 0} times, the register says ${wanted.get(literal) ?? 0}`)
  })
}

function secondVersionOffenders(file: string, text: string): string[] {
  return SECOND_VERSION_NEEDLES.flatMap(([what, needle]) =>
    [...text.matchAll(rx(needle, 'g'))].map((m) => `${file}:${lineAt(text, m.index)}: ${what}: ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`))
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function spelledValues(text: string, spelling: string): Literal[] {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(spelling)}(\\d+|'[^'\\n]*'|"[^"\\n]*")`, 'g')
  return [...text.matchAll(pattern)].map((m) => literalOf(m[1]!))
}

function sourceValue(row: RegisteredVersion): unknown {
  if (row.name !== undefined) return versionConstants(row.site, code(row.site)).find((hit) => hit.name === row.name)?.value
  if (row.site.endsWith('.json')) return (JSON.parse(bytesOf(row.site)) as Record<string, unknown>)[row.field]
  return row.value
}

const FIXTURE_DIRECTORY = /\/(?:__fixtures__|fixtures)\//
const isFixtureData = (file: string): boolean => /\.(?:json|jsonl|md)$/.test(file)

function fixtureFiles(): string[] {
  return [
    ...listTree('test-fixtures/', isFixtureData),
    ...packageSources().flatMap((root) => listTree(root, (file) => isFixtureData(file) && FIXTURE_DIRECTORY.test(file))),
  ]
}

function stampsIn(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) stampsIn(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === STAMP_KEY) out.push(item)
      stampsIn(item, out)
    }
  }
}

function fixtureStamps(file: string, text: string): unknown[] {
  const stamps: unknown[] = []
  const inline = (part: string): void => {
    for (const m of part.matchAll(rx(INLINE_JSON_STAMP, 'g'))) stamps.push(Number(m[1]))
  }
  if (file.endsWith('.md')) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (front !== null) for (const m of front[1]!.matchAll(rx(FRONTMATTER_STAMP, 'gm'))) stamps.push(Number(m[1]))
    inline(text)
    return stamps
  }
  const documents = file.endsWith('.jsonl') ? text.split('\n').filter((line) => line.trim() !== '') : [text]
  for (const document of documents) {
    try {
      stampsIn(JSON.parse(document), stamps)
    } catch {
      inline(document)
    }
  }
  return stamps
}

const EXCLUSION_CATEGORIES = [
  'external-spec',
  'package-version',
  'content-version',
  'domain-tag',
  'floor-asset',
  'label',
] as const

// ---------------------------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------------------------

describe('schema version census', () => {
  it('every registered version is 2, every exclusion has a reason, and every register site exists', () => {
    expect(VERSION_REGISTER.length).toBeGreaterThan(60)
    const wrongValue = VERSION_REGISTER
      .filter((row) => row.value !== (row.field === 'token-prefix' ? 'v2' : 2))
      .map((row) => `${row.id}: ${JSON.stringify(row.value)}`)
    expect(wrongValue, 'a registered version is not 2').toEqual([])

    const ids = VERSION_REGISTER.map((row) => row.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), 'a register id repeats').toEqual([])
    const rules = new Set(['refuse', 'rebuild', 'miss', 'no-reader'])
    expect(VERSION_REGISTER.filter((row) => !rules.has(row.rule)).map((row) => row.id)).toEqual([])

    const sites = [
      ...VERSION_REGISTER.flatMap((row) => [row.site, ...(row.copies ?? []).map((copy) => copy.site)]),
      ...INLINE_STAMPS.map((row) => row.site),
      ...JSON_STAMPS.map((row) => row.file),
      ...FIXTURE_STAMP_EXCLUSIONS.map((row) => row.file),
      ...VERSION_EXCLUSIONS.map((row) => row.site),
    ]
    expect([...new Set(sites)].filter((site) => !existsSync(join(REPO_ROOT, site))), 'a register site is gone').toEqual([])

    const unexplained = VERSION_EXCLUSIONS
      .filter((row) => row.reason.trim() === '' || !bytesOf(row.site).includes(row.name))
      .map((row) => `${row.site}: ${row.name}`)
    expect(unexplained, 'an exclusion has no reason or no longer names its site').toEqual([])

    const strays = INLINE_STAMPS
      .filter((row) => !ids.includes(row.id) || row.literal !== 2 || row.count < 1)
      .map((row) => `${row.site}: ${row.id}`)
    expect(strays, 'an inline stamp names no format, or is not 2').toEqual([])
    expect(FIXTURE_STAMP_EXCLUSIONS.filter((row) => row.reason.trim() === '').map((row) => row.file)).toEqual([])
  })

  it('every production version constant is registered at its value or excluded, and every registered constant is found', () => {
    const files = productionFiles()
    expect(files.length).toBeGreaterThan(1200)
    const hits = files.flatMap((file) => versionConstants(file, code(file)))
    expect(hits.length).toBeGreaterThan(60)
    expect(constantOffenders(hits)).toEqual([])

    const missing = registeredNames()
      .filter((entry) => !hits.some((hit) => hit.file === entry.site && hit.name === entry.name && hit.value === entry.row.value))
      .map((entry) => `${entry.site}: ${entry.name} at ${JSON.stringify(entry.row.value)}`)
    expect(missing, 'a registered constant is not where the register says').toEqual([])
  })

  it('every inline stamp, literal and exact check matches the register by file, literal and count', () => {
    const files = productionFiles()
    const sources = files.map((file) => ({ file, text: code(file) }))
    expect(sources.reduce((total, { text }) => total + [...inlineCounts(text).values()].reduce((a, b) => a + b, 0), 0))
      .toBeGreaterThan(0)
    expect(inlineOffenders(sources)).toEqual([])
    const unscanned = [...registeredInline().keys()].filter((site) => !files.includes(site))
    expect(unscanned, 'a registered inline site is outside the scanned universe').toEqual([])
  })

  it('no format reads a second version: no migration step, alias, stamp union or stamp-keyed union', () => {
    const files = productionFiles()
    expect(files.flatMap((file) => secondVersionOffenders(file, code(file)))).toEqual([])
    const guarded = files.filter((file) => rx(EMPTY_MIGRATIONS).test(code(file)))
    expect(guarded.length, 'the empty migration seams were not seen').toBeGreaterThan(5)
  })

  it('every registered copy spells the value of its source', () => {
    const copies = VERSION_REGISTER.flatMap((row) => (row.copies ?? []).map((copy) => ({ row, copy })))
    expect(copies.map(({ copy }) => copy.site)).toEqual(
      expect.arrayContaining(['packages/dashboard-ui/src/lib/api.ts']),
    )
    const wrong = copies.flatMap(({ row, copy }) => {
      const value = sourceValue(row)
      if (value !== row.value) return [`${row.id}: its source ${row.site} reads ${JSON.stringify(value)}`]
      const spelled = IDENTIFIER.test(copy.spelling)
        ? versionConstants(copy.site, code(copy.site)).filter((hit) => hit.name === copy.spelling).map((hit) => hit.value)
        : spelledValues(copy.site.endsWith('.json') ? bytesOf(copy.site) : code(copy.site), copy.spelling)
      return spelled.length > 0 && spelled.every((literal) => literal === value)
        ? []
        : [`${copy.site}: ${copy.spelling} spells ${JSON.stringify(spelled)}, its source ${row.site} reads ${JSON.stringify(value)}`]
    })
    expect(wrong).toEqual([])
  })

  it('both skills contracts read 2, and the two copies are identical', () => {
    const contracts = JSON_STAMPS.filter((row) => row.key === 'version').map((row) => row.file)
    const copies = [...listTree('skills/', (file) => file.endsWith('/agent-qa-contracts.json')),
      ...listTree('packages/cli/skills/', (file) => file.endsWith('/agent-qa-contracts.json'))]
    expect(contracts.sort()).toEqual(copies.sort())
    expect(contracts).toHaveLength(2)
    const wrong = JSON_STAMPS
      .filter((row) => row.value !== 2 || (JSON.parse(bytesOf(row.file)) as Record<string, unknown>)[row.key] !== 2)
      .map((row) => `${row.file}: ${row.key}`)
    expect(wrong).toEqual([])
    const [first, second] = contracts as [string, string]
    expect(readFileSync(join(REPO_ROOT, first)).equals(readFileSync(join(REPO_ROOT, second))), 'the contracts copies differ').toBe(true)
  })

  it("every schemaVersion stamp in the repository's fixtures is 2, apart from the spelled exclusions", () => {
    const files = fixtureFiles()
    expect(files).not.toHaveLength(0)
    const stamps = new Map(files.map((file) => [file, fixtureStamps(file, bytesOf(file))]))
    expect([...stamps.values()].reduce((total, found) => total + found.length, 0)).toBeGreaterThan(0)
    const excluded = new Set(FIXTURE_STAMP_EXCLUSIONS.map((row) => row.file))
    const offenders = [...stamps]
      .filter(([file, found]) => !excluded.has(file) && found.some((stamp) => stamp !== 2))
      .map(([file, found]) => `${file}: ${JSON.stringify(found.filter((stamp) => stamp !== 2))}`)
    expect(offenders).toEqual([])
    const stale = FIXTURE_STAMP_EXCLUSIONS
      .filter((row) => !(stamps.get(row.file) ?? []).some((stamp) => stamp !== 2))
      .map((row) => row.file)
    expect(stale, 'a fixture exclusion no longer holds another stamp').toEqual([])
  })

  it('every excluded category is spelled with a reason, and nothing excluded is also registered', () => {
    const unspelled = EXCLUSION_CATEGORIES.filter((category) =>
      !VERSION_EXCLUSIONS.some((row) => row.category === category && /^\S.*\.$/.test(row.reason)))
    expect(unspelled).toEqual([])
    expect(VERSION_EXCLUSIONS.filter((row) => !(EXCLUSION_CATEGORIES as readonly string[]).includes(row.category))).toEqual([])
    const names = new Set(registeredNames().map((entry) => entry.name))
    const inlineSites = new Set(INLINE_STAMPS.map((row) => row.site))
    const both = VERSION_EXCLUSIONS
      .filter((row) => names.has(row.name) || (row.inline !== undefined && inlineSites.has(row.site)))
      .map((row) => `${row.site}: ${row.name}`)
    expect(both, 'an exclusion is also registered').toEqual([])
  })
})

describe('schema version census instruments', () => {
  it('a planted constant at 3 is found as code and not as a comment', () => {
    const planted = cat('export const PLANTED_SCHEMA_', 'VERSION = 3\n')
    expect(constantOffenders(versionConstants('planted.ts', codeOf(planted)))).toHaveLength(1)
    expect(constantOffenders(versionConstants('planted.ts', codeOf(`// ${planted}`)))).toEqual([])
    expect(constantOffenders(versionConstants('planted.ts', codeOf(`/* ${planted} */`)))).toEqual([])

    const handoff = VERSION_REGISTER.find((row) => row.id === 'completed-run-handoff')!
    const moved = `export const ${handoff.name} = 3\n`
    expect(constantOffenders(versionConstants(handoff.site, codeOf(moved)))).toEqual([
      `${handoff.site}:1: ${handoff.name} = 3 is registered at 2`,
    ])
    expect(constantOffenders(versionConstants(handoff.site, codeOf(`// ${moved}`)))).toEqual([])
  })

  it('a planted unregistered schemaVersion literal at 1 is found as code and not as a comment', () => {
    const planted = cat('const s = z.object({ schemaVer', 'sion: z.literal(1) })\n')
    const site = 'packages/planted/src/planted.ts'
    expect(inlineOffenders([{ file: site, text: codeOf(planted) }])).toEqual([
      `${site}: literal 1 appears 1 times, the register says 0`,
    ])
    expect(inlineOffenders([{ file: site, text: codeOf(`// ${planted}`) }])).toEqual([])
    expect(inlineOffenders([{ file: site, text: codeOf(`/* ${planted} */`) }])).toEqual([])

    const writer = 'packages/agent/src/functions/ops/knowledge-records-diff.ts'
    const extra = cat('const extra = { schemaVer', 'sion: 2 }\n')
    expect(inlineOffenders([{ file: writer, text: code(writer) }])).toEqual([])
    expect(inlineOffenders([{ file: writer, text: `${code(writer)}${codeOf(extra)}` }])).toHaveLength(1)
    expect(inlineOffenders([{ file: writer, text: `${code(writer)}${codeOf(`// ${extra}`)}` }])).toEqual([])
  })

  it('a planted migration step and a planted stamp union are found as code and not as a comment', () => {
    const step = cat('const HANDOFF_MIGRA', 'TIONS: MigrationRegis', 'try = { 1: (doc) => doc }\n')
    const union = cat('const s = z.object({ schemaVer', 'sion: z.union([z.literal(1), z.literal(2)]) })\n')
    expect(secondVersionOffenders('planted.ts', codeOf(`${step}${union}`))).toHaveLength(2)
    expect(secondVersionOffenders('planted.ts', codeOf(`// ${step}// ${union}`))).toEqual([])

    const others = [
      cat('createVersionGuard({ migra', 'tions: { 1: (doc) => doc } })\n'),
      cat('createVersionGuard({ readAsCur', 'rent: [3, 4] })\n'),
      cat('const ok = readableSt', 'amp(value)\n'),
      cat('const s = z.object({ schemaVer', 'sion: z.literal(1).or(z.literal(2)) })\n'),
      cat("const s = z.discriminatedUn", "ion('schemaVersion', [a, b])\n"),
      cat('interface Planted { schemaVer', 'sion: 1 | 2 }\n'),
    ]
    for (const planted of others) {
      expect(secondVersionOffenders('planted.ts', codeOf(planted)), planted).toHaveLength(1)
      expect(secondVersionOffenders('planted.ts', codeOf(`/* ${planted} */`)), planted).toEqual([])
    }
    expect(secondVersionOffenders('planted.ts', codeOf(cat('createVersionGuard({ migra', 'tions: {} })\n')))).toEqual([])

    const notification = 'packages/schema/src/notification/run-notification.ts'
    const declared = /(\bconst\s+\w+_MIGRA(?:TIONS)\s*:[^\n]*=\s*)\{\}/
    const source = code(notification)
    expect(source, 'the run notification registry is no longer declared empty').toMatch(declared)
    expect(secondVersionOffenders(notification, source)).toEqual([])
    const filled = source.replace(declared, '$1{ 1: (doc) => doc }')
    expect(secondVersionOffenders(notification, filled)).toHaveLength(1)
    const commented = source.replace(declared, '// $1{ 1: (doc) => doc }')
    expect(secondVersionOffenders(notification, codeOf(commented))).toEqual([])
    const assigned = cat('RUN_NOTIFICATION_MIGRA', 'TIONS[1] = (doc) => doc\n')
    expect(secondVersionOffenders('planted.ts', codeOf(assigned))).toHaveLength(1)
    expect(secondVersionOffenders('planted.ts', codeOf(`// ${assigned}`))).toEqual([])
  })

  it('this file spells none of its needles, and lies outside every region it scans', () => {
    const own = readFileSync(THIS_FILE).toString('utf8')
    expect(existsSync(join(REPO_ROOT, OWN)), 'the self path is wrong').toBe(true)
    expect(existsSync(join(REPO_ROOT, REGISTER_FILE)), 'the register path is wrong').toBe(true)

    const needles = [
      CONSTANT_DECLARATION,
      ...INLINE_NEEDLES,
      ...SECOND_VERSION_NEEDLES.map(([, needle]) => needle),
      EMPTY_MIGRATIONS,
      FRONTMATTER_STAMP,
      INLINE_JSON_STAMP,
    ].map(joined)
    const spelled = needles.filter((needle) => own.includes(needle))
    expect(spelled, `this file spells what it reads: ${spelled.join(', ')}`).toEqual([])

    const ownCode = codeOf(own)
    expect(versionConstants(OWN, ownCode), 'this file declares a version constant').toEqual([])
    expect([...inlineCounts(ownCode)], 'this file carries an inline stamp').toEqual([])
    expect(secondVersionOffenders(OWN, ownCode), 'this file carries a second-version shape').toEqual([])

    const files = productionFiles()
    expect(files, 'this census file is inside a region it scans').not.toContain(OWN)
    expect(files, 'the register is inside a region it scans').not.toContain(REGISTER_FILE)
    expect(files.filter((file) => file.startsWith(ARCH_SOURCE)), 'the arch sources were scanned').toEqual([])
    expect(files.filter((file) => file.includes('/__tests__/')), 'a test file was scanned').toEqual([])
  })
})
