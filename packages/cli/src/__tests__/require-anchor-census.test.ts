// THE COMPLETE SET OF MODULE-RESOLVER ANCHORS IN THIS REPOSITORY, AND ONE PROPERTY OF EVERY MEMBER.
//
// WHY A CENSUS AND NOT TWO ASSERTIONS. The defect this file exists for was reported at one site: a
// global install's `agent-qa daemon` died with `Cannot find module '@vostride/agent-qa-agent-local'`
// / `Require stack: - /usr/local/bin/agent-qa`, because a `createRequire` base was taken from the
// process argument vector and `argv[1]` on a global install is the bin SYMLINK, a path with no
// `node_modules` on any ancestor. Two assertions pinned to the reported line would have closed the
// report and left the class open — and the class had a second member on the same boot path, which is
// how a one-sided fix turns into the next rehearsal's delta. So the subject here is the SET: every
// `createRequire` call site under `packages/*/src`, enumerated mechanically, each asked the same
// question.
//
// THE DISCOVERY PREDICATE IS THE PART MOST LIKELY TO BE VACUOUS, so it is asserted rather than
// trusted. A scan that silently walked zero directories, or matched zero call sites, would report
// zero offenders and read as a clean bill of health forever. Both counts are therefore assertions
// with floors derived from an independent reading of the tree (ten call sites at the time of
// writing), and there is no branch anywhere in this file that can turn an unreadable file or an
// empty directory into a skip.
//
// THE PROPERTY NAMES THE DEFECT, NOT AN APPROVED LIST OF SHAPES. The resolved anchor expression must
// not read the process argument vector. That leaves `import.meta.url`, `__filename`, a package entry
// this same code just resolved (`install-browsers.ts`) and a deliberate project-directory root
// (`plugin-loader-util.ts`) all legitimate without enumerating them, and an allow-list of blessed
// shapes would rot the first time somebody wrote a correct fifth one.
//
// THE EXTRACTOR IS PROVEN ABLE TO SEE AN OFFENDER (and able to stay quiet about a correct anchor) by
// running the SAME exported functions over synthetic sources. Without those two cells the census
// could be an extractor that never matches anything, which is indistinguishable from a clean tree.
//
// THE `process.argv` REGISTER IS DELIBERATELY WIDER THAN THE ASSERTING PROPERTY. The property above
// is scoped to `createRequire(` call sites, so it is structurally blind to a `process.argv`-derived
// path used for anything else — and this plan's scope boundary routes "anything the census surfaces"
// to a deferred-items record, which is worth nothing over a set the census cannot surface. The
// register below is therefore every read of `process.argv` in the scanned tree, annotated with the
// value flow detected on its line but NOT filtered by it: a flow filter is exactly the place a
// member vanishes quietly, and a register that can drop members cannot make a boundary measured.
// The register does not fail the suite. It is printed, asserted non-empty, asserted to contain the
// three known non-`createRequire` sites, and adjudicated line by line in the plan's SUMMARY.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
/** `packages/cli`. */
const CLI_PACKAGE_ROOT = resolve(TESTS_DIR, '..', '..')
/** `packages`. */
const PACKAGES_ROOT = resolve(CLI_PACKAGE_ROOT, '..')

// ---- Source scanning ---------------------------------------------------------------------------

/** A `.ts` product source under `packages/<pkg>/src`, with the package it belongs to. */
export interface ScannedSource {
  readonly pkg: string
  /** Relative to `packages/`, so a failure message is the same on every machine. */
  readonly relPath: string
  readonly source: string
}

/**
 * Every product `.ts` file under `packages/*​/src`.
 *
 * Test sources are excluded because a fixture is allowed to write the defective shape on purpose —
 * this very file does, twice, in its discrimination cells.
 */
export function scanProductSources(packagesRoot: string = PACKAGES_ROOT): ScannedSource[] {
  const found: ScannedSource[] = []
  for (const pkgEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkgEntry.isDirectory() || pkgEntry.name === 'node_modules') continue
    const srcRoot = join(packagesRoot, pkgEntry.name, 'src')
    let srcStat
    try {
      srcStat = statSync(srcRoot)
    } catch {
      continue
    }
    if (!srcStat.isDirectory()) continue
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue
        }
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (!/\.[cm]?ts$/u.test(entry.name)) continue
        if (/\.test(?:-d)?\.[cm]?ts$/u.test(entry.name)) continue
        found.push({
          pkg: pkgEntry.name,
          relPath: relative(packagesRoot, full),
          source: readFileSync(full, 'utf8'),
        })
      }
    }
    walk(srcRoot)
  }
  return found
}

// ---- Expression extraction ---------------------------------------------------------------------

/**
 * Advance past a string, template or comment starting at `index`; otherwise return `index`.
 *
 * Enough lexing that a `)` inside `'a)b'` does not close a call. Template substitutions are treated
 * as opaque, which is safe here: an anchor written inside a `${}` still lands in the captured text.
 */
function skipInert(source: string, index: number): number {
  const ch = source[index]
  if (ch === '/' && source[index + 1] === '/') {
    const end = source.indexOf('\n', index)
    return end === -1 ? source.length : end
  }
  if (ch === '/' && source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2)
    return end === -1 ? source.length : end + 2
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let cursor = index + 1
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (source[cursor] === ch) return cursor + 1
      cursor += 1
    }
    return source.length
  }
  return index
}

/** The index of the `)` closing the `(` at `openIndex`, or the end of the source. */
function findCallEnd(source: string, openIndex: number): number {
  let depth = 0
  let cursor = openIndex
  while (cursor < source.length) {
    const skipped = skipInert(source, cursor)
    if (skipped !== cursor) {
      cursor = skipped
      continue
    }
    const ch = source[cursor]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return cursor
    }
    cursor += 1
  }
  return source.length
}

/** The first top-level argument of the call whose `(` is at `openIndex`. */
function firstArgumentText(source: string, openIndex: number): string {
  const end = findCallEnd(source, openIndex)
  let depth = 0
  let cursor = openIndex + 1
  while (cursor < end) {
    const skipped = skipInert(source, cursor)
    if (skipped !== cursor) {
      cursor = skipped
      continue
    }
    const ch = source[cursor]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) break
    cursor += 1
  }
  return source.slice(openIndex + 1, Math.min(cursor, end)).trim()
}

const ENDS_WITH_CONTINUATION = /(?:&&|\|\||\?\?|=>|[?:=+\-*/%,([{.&|!<>])\s*$/u
const STARTS_WITH_CONTINUATION = /^(?:&&|\|\||\?\?|=>|[?:.)\]},]|\+|\*)/u

/**
 * The initialiser text of a binding, read from `startIndex` (just past its `=`) to the end of the
 * statement.
 *
 * Multi-line by necessity: both defective anchors in this tree are written as a three-line
 * conditional, and a reader that stopped at the first newline would capture `typeof __filename ===
 * 'string'` and report the site clean — the exact false negative this census exists to prevent.
 */
function readInitializer(source: string, startIndex: number): string {
  let depth = 0
  let cursor = startIndex
  while (cursor < source.length) {
    const skipped = skipInert(source, cursor)
    if (skipped !== cursor) {
      cursor = skipped
      continue
    }
    const ch = source[cursor]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ';' && depth === 0) break
    else if (ch === '\n' && depth <= 0) {
      const soFar = source.slice(startIndex, cursor)
      if (!ENDS_WITH_CONTINUATION.test(soFar)) {
        const rest = source.slice(cursor + 1)
        const nextLine = rest.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
        if (!STARTS_WITH_CONTINUATION.test(nextLine)) break
      }
    }
    cursor += 1
  }
  return source.slice(startIndex, cursor).trim()
}

/** The nearest `const`/`let`/`var` initialiser for `identifier` before `beforeIndex`. */
function resolveBinding(
  source: string,
  identifier: string,
  beforeIndex: number,
): string | undefined {
  const pattern = new RegExp(
    String.raw`(?:const|let|var)\s+${identifier}\b[^=\n]*?=(?!=)`,
    'gu',
  )
  let resolved: string | undefined
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (match.index >= beforeIndex) break
    resolved = readInitializer(source, match.index + match[0].length)
  }
  return resolved
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1
  }
  return line
}

/** Anything that reads the process argument vector, however it is spaced. */
const READS_ARGV = /process\s*\.\s*argv\b/u

/** One `createRequire(...)` call site and the anchor expression it resolves against. */
export interface AnchorSite {
  readonly line: number
  /** The first argument exactly as written. */
  readonly anchorText: string
  /** `anchorText`, or the initialiser it resolves to when it is a bare identifier. */
  readonly resolvedAnchorText: string
  /** The identifier one level of resolution went through, when it did. */
  readonly viaBinding?: string
}

const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u
const CREATE_REQUIRE_CALL = /(?<![A-Za-z0-9_$])createRequire\s*\(/gu

/**
 * Every `createRequire(` call site in one source, with its anchor resolved one level.
 *
 * ONE LEVEL IS THE RIGHT DEPTH, not a compromise: both real offenders and every correct site in this
 * tree write the anchor either inline or in the immediately preceding binding. A resolver that
 * chased arbitrary depth would be a partial evaluator, and a resolver that chased none would miss
 * both offenders, which are `createRequire(requireBase)`.
 */
export function extractAnchors(source: string): AnchorSite[] {
  const sites: AnchorSite[] = []
  CREATE_REQUIRE_CALL.lastIndex = 0
  for (
    let match = CREATE_REQUIRE_CALL.exec(source);
    match !== null;
    match = CREATE_REQUIRE_CALL.exec(source)
  ) {
    const openIndex = match.index + match[0].length - 1
    const anchorText = firstArgumentText(source, openIndex)
    let resolvedAnchorText = anchorText
    let viaBinding: string | undefined
    if (BARE_IDENTIFIER.test(anchorText)) {
      const bound = resolveBinding(source, anchorText, match.index)
      if (bound !== undefined) {
        resolvedAnchorText = bound
        viaBinding = anchorText
      }
    }
    sites.push({
      line: lineOf(source, match.index),
      anchorText,
      resolvedAnchorText,
      ...(viaBinding === undefined ? {} : { viaBinding }),
    })
  }
  return sites
}

/** Whether a resolved anchor takes its base from the process argument vector. */
export function anchorReadsArgv(site: AnchorSite): boolean {
  return READS_ARGV.test(site.resolvedAnchorText)
}

// ---- The wider register --------------------------------------------------------------------

/** One read of `process.argv` anywhere in the scanned tree. */
export interface ArgvRead {
  readonly line: number
  /** The source line, trimmed — what a reader opens the file to. */
  readonly text: string
  /** Value flows detected on that line. Informational: nothing is filtered by it. */
  readonly flows: readonly string[]
}

/**
 * Every read of `process.argv`, with the flow kinds visible on its line.
 *
 * NOT FILTERED BY FLOW, on purpose — see this file's header. The flow annotation is what a reader
 * uses to adjudicate a member; it is never what decides whether the member is listed.
 */
export function extractArgvReads(source: string): ArgvRead[] {
  const reads: ArgvRead[] = []
  const lines = source.split('\n')
  lines.forEach((raw, index) => {
    if (!READS_ARGV.test(raw)) return
    const text = raw.trim()
    if (text.startsWith('//') || text.startsWith('*')) return
    const flows: string[] = []
    if (/(?<![=!<>])=(?!=)/u.test(text.split(/process\s*\.\s*argv/u)[0] ?? '')) {
      flows.push('assignment')
    }
    if (text.includes('`') && text.includes('${')) flows.push('template-literal')
    if (/\?\?|\|\|/u.test(text)) flows.push('nullish-or-or-chain')
    if (/[A-Za-z_$][\w$]*\s*\([^)]*process\s*\.\s*argv/u.test(text)) flows.push('call-argument')
    reads.push({ line: index + 1, text, flows })
  })
  return reads
}

// ---- The scan, taken once ----------------------------------------------------------------------

const SOURCES = scanProductSources()

interface CensusRow {
  readonly relPath: string
  readonly site: AnchorSite
}

const ALL_SITES: CensusRow[] = SOURCES.flatMap((file) =>
  extractAnchors(file.source).map((site) => ({ relPath: file.relPath, site })),
)

const OFFENDERS = ALL_SITES.filter((row) => anchorReadsArgv(row.site))

const ARGV_REGISTER = SOURCES.flatMap((file) =>
  extractArgvReads(file.source).map((read) => ({ relPath: file.relPath, read })),
)

function describeOffender(row: CensusRow): string {
  const via = row.site.viaBinding === undefined ? '' : ` (via \`${row.site.viaBinding}\`)`
  return `${row.relPath}:${row.site.line}${via} — ${row.site.resolvedAnchorText.replace(/\s+/gu, ' ')}`
}

// ---- Cells -------------------------------------------------------------------------------------

describe('createRequire anchor census', () => {
  it('scans a non-empty tree and finds a non-empty set of call sites', () => {
    expect(
      SOURCES.length,
      `the census walked ${PACKAGES_ROOT} and found no product sources; a scan that finds nothing `
        + 'reports no offenders and reads as a clean tree forever',
    ).toBeGreaterThan(0)
    expect(
      ALL_SITES.length,
      'the census found no createRequire call sites at all, which cannot be true of this tree; the '
        + 'extractor, not the tree, is what changed',
    ).toBeGreaterThan(0)
  })

  it('finds both sites the fix repairs, so the predicate covers the repaired roots', () => {
    const scanned = ALL_SITES.map((row) => row.relPath)
    expect(scanned).toContain(join('cli', 'src', 'daemon', 'heartbeat-supervisor.ts'))
    expect(scanned).toContain(join('agent-local', 'src', 'composition', 'compose-local-agent.ts'))
  })

  it('reports an offender in a synthetic source — the extractor can see the defect', () => {
    const synthetic = [
      "import { createRequire } from 'node:module'",
      '',
      'export function resolveSomething(): string {',
      "  const requireBase = typeof __filename === 'string'",
      '    ? __filename',
      "    : (process.argv[1] ?? join(process.cwd(), 'package.json'))",
      "  return createRequire(requireBase).resolve('@vostride/agent-qa-agent-local')",
      '}',
    ].join('\n')
    const sites = extractAnchors(synthetic)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.viaBinding).toBe('requireBase')
    expect(anchorReadsArgv(sites[0] as AnchorSite)).toBe(true)
  })

  it('stays quiet on a synthetic source using the shipped idiom — it is not an extractor that reports everything', () => {
    const synthetic = [
      "import { createRequire } from 'node:module'",
      '',
      "const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)",
      "const other = createRequire(import.meta.url)",
      "const entry = other.resolve('@vostride/agent-qa-web')",
      'const entryRequire = createRequire(entry)',
    ].join('\n')
    const sites = extractAnchors(synthetic)
    expect(sites).toHaveLength(3)
    expect(sites.filter((site) => anchorReadsArgv(site))).toEqual([])
  })

  it('does not report the anchors that are legitimately not import.meta.url or __filename', () => {
    const offending = OFFENDERS.map((row) => `${row.relPath}:${row.site.line}`)
    for (const clean of [
      join('cli', 'src', 'commands', 'install-browsers.ts'),
      join('cli', 'src', 'composition', 'analytics-host.ts'),
      join('cli', 'src', 'commands', 'dashboard.ts'),
      join('core', 'src', 'plugin-loader-util.ts'),
      join('core', 'src', 'version.ts'),
      join('core', 'src', 'version-check', 'index.ts'),
    ]) {
      expect(
        offending.filter((entry) => entry.startsWith(`${clean}:`)),
        `${clean} anchors on a value that is not the process argument vector and must not be reported`,
      ).toEqual([])
    }
  })

  it('prints the process.argv register and finds it non-empty', () => {
    const rendered = ARGV_REGISTER.map(
      (entry) =>
        `  ${entry.relPath}:${entry.read.line} [${
          entry.read.flows.length === 0 ? 'unclassified' : entry.read.flows.join(',')
        }] ${entry.read.text}`,
    ).join('\n')
    console.log(`process.argv register (${ARGV_REGISTER.length} reads):\n${rendered}`)
    expect(
      ARGV_REGISTER.length,
      'the wider extraction matched nothing, so the scope boundary would be assumed rather than '
        + 'measured — an empty register is a broken register, not a clean tree',
    ).toBeGreaterThan(0)
  })

  // 2026-08-23 (401-06, then 401-10): THIS WAS THREE, AND TWO RETIRED WITH THEIR SUBJECT.
  //
  // `cli/src/daemon/host.ts`'s read was `input.cliEntry ?? process.argv[1] ?? ''` — the entry path
  // the daemon handed the piped `agent-qa run` child it spawned. `cli/src/composition/
  // local-agent-host.ts`'s was the same expression inside `createCliRunExecution`, the terminal
  // host's own child. Both hosts now run the run in their own process, 401-10 deleted the machinery
  // outright, and neither read is in the tree. They are REMOVED rather than relaxed: this list is a
  // set of files that must be FOUND, so a member the tree no longer contains would be a permanently
  // red pin, and the survivor is asserted exactly as strictly as before. The counterpart of those
  // removals — that nothing on the run path launches a child any more — is asserted positively by
  // the complete-set censuses in `daemon/__tests__/daemon-run-execution.test.ts` and
  // `composition/__tests__/spawn-absence-census.test.ts`, so the fact did not stop being checked.
  //
  // THE SURVIVOR IS THE DESIGN-OF-RECORD ONE. `knowledge-local`'s embedder worker entry reads the
  // argument vector because it IS a child — the daemon-owned worker INVK-01's scoping sentence
  // keeps. That it is what remains here is the same fact the spawn-absence census allow-lists.
  it('registers the one known non-createRequire argv site the asserting property cannot see', () => {
    const registered = new Set(ARGV_REGISTER.map((entry) => entry.relPath))
    for (const known of [
      join('knowledge-local', 'src', 'embedder-worker', 'worker-entry.ts'),
    ]) {
      expect(
        registered.has(known),
        `${known} reads process.argv and must appear in the register; the asserting property below `
          + 'is scoped to createRequire call sites and is structurally blind to it',
      ).toBe(true)
    }
  })

  it('reads the whole conditional at both repaired sites — a truncating reader cannot fake a clean verdict', () => {
    // WHY THIS CELL EXISTS. Both repaired anchors are written as a three-line conditional whose
    // FIRST line is `typeof __filename === 'string'`. A reader that stopped at the first newline
    // would report that fragment, which reads clean of the process argument vector both before AND
    // after the fix — a green that never measured anything. Pinning the resolved text to the whole
    // expression makes the clean verdict below evidence rather than an artefact of truncation.
    for (const relPath of [
      join('cli', 'src', 'daemon', 'heartbeat-supervisor.ts'),
      join('agent-local', 'src', 'composition', 'compose-local-agent.ts'),
    ]) {
      const rows = ALL_SITES.filter((row) => row.relPath === relPath)
      expect(rows.length, `${relPath} has no createRequire call site`).toBeGreaterThan(0)
      const resolved = rows.map((row) => row.site.resolvedAnchorText).join('\n')
      expect(resolved, `${relPath}: the anchor must keep the __filename branch`).toContain(
        '__filename',
      )
      expect(
        resolved,
        `${relPath}: the anchor's non-CJS branch must be the module's own location, and the reader `
          + 'must have got far enough to see it',
      ).toContain('import.meta.url')
    }
  })

  it('has no module resolver anchored on the process argument vector', () => {
    expect(
      OFFENDERS.map(describeOffender),
      'a createRequire anchor derived from the process argument vector resolves against whatever '
        + 'directory the invoking path happens to sit in; on a global install that is the bin '
        + 'symlink, which has no node_modules on any ancestor',
    ).toEqual([])
  })
})
