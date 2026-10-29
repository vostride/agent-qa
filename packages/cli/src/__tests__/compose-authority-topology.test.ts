// Every production composition that HOLDS the writer lease must hand that authority to the apply
// path — asserted over the complete set of production compositions, not over the one member that
// failed (387-10, CR-01 missing item 2).
//
// 387-08 built the seam and 387-09 did not pick it up, so the daemon shipped composing without it
// and no accept/reject/forget could be committed on any project with a daemon running. A
// regression case pinned to `daemon/host.ts` would close that instance. This closes the CLASS: it
// walks the tree, discovers the compositions itself, and fails on any lease-holding one that
// omits the authority — including one that does not exist yet.
//
// The scan's own defences, and why each is here rather than a nicety (all four measured against
// the real tree on 2026-08-02):
//
//   comment-strip      `agent/src/functions/registry.ts`, `arch/src/lint/reader-carveout.ts` and
//                      `knowledge-local/src/index.ts` name `composeLocalAgent` only in prose. Two
//                      of the three write it WITH PARENS, so requiring an invocation shape does
//                      not save a scan that reads comments.
//   string-strip       `arch/src/lint/surface-firewall-ledger.ts` carries ten occurrences inside
//                      single-quoted ledger reasons — `'…superseded by composeLocalAgent()'` —
//                      which survive comment-stripping AND carry the parens verbatim. Neither of
//                      the two obvious defences rejects this file on its own.
//   import edge        the structural discriminator: a file that CALLS the function has an import
//                      naming it. Prose, ledger strings and barrel re-exports do not. Measured:
//                      the string-strip and the import edge each reject
//                      `surface-firewall-ledger.ts` on their own, so they are independent rather
//                      than layered — the import edge is kept because it is the one that
//                      generalises to a shape nobody has written yet.
//   invocation shape   `agent-local/src/index.ts` re-EXPORTS the name from the barrel. That is an
//                      export edge, not an import edge, and it carries no parens — rejected twice
//                      over.
//
// OBSERVED RED against the pre-fix tree, 2026-08-02: with the one `resolveWriterAuthority` entry
// removed from `daemon/host.ts`, the scan fails naming it —
//   "packages/cli/src/daemon/host.ts acquires the writer lease and composes without
//    resolveWriterAuthority"
// — so this is a check over the real tree that rejected the real defect, not a fixture exercise.
//
// A note on this file's own text: fixture sources are ASSEMBLED from keyword fragments rather
// than written out. The workspace's dependency-pin lint scans line-leading module statements
// wherever they appear, and a file whose subject is module statements is the one file most likely
// to hand it a statement nobody wrote.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const KEYWORD_IMPORT = ['im', 'port'].join('')
const KEYWORD_EXPORT = ['ex', 'port'].join('')
const KEYWORD_FROM = ['fr', 'om'].join('')
const AGENT_LOCAL_SPECIFIER = '@vostride/agent-qa-agent-local'
const KNOWLEDGE_LOCAL_SPECIFIER = '@vostride/agent-qa-knowledge-local'

function moduleStatement(keyword: string, names: string, specifier: string): string {
  return `${keyword} { ${names} } ${KEYWORD_FROM} '${specifier}'`
}

// ---- the classifier, a pure function so its controls can be fixture strings -----------------

type LexState = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'

/**
 * Remove comments and the CONTENTS of string/template literals, keeping every other character in
 * place. One state machine rather than two regex passes, because the two failure modes are each
 * other's inverse: a regex comment-strip truncates a line at a `//` inside a URL string, and a
 * regex string-strip mangles an apostrophe inside a comment.
 */
function stripCommentsAndStringContents(source: string): string {
  const out: string[] = []
  let state: LexState = 'code'
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment'
        index += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block-comment'
        index += 2
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template'
        out.push(char)
        index += 1
        continue
      }
      out.push(char)
      index += 1
      continue
    }
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
        out.push(char)
      }
      index += 1
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 2
        continue
      }
      if (char === '\n') out.push(char)
      index += 1
      continue
    }
    // Inside a literal: emit nothing until the closing quote, so a token in a string is gone.
    if (char === '\\') {
      index += 2
      continue
    }
    const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (char === closer) {
      state = 'code'
      out.push(char)
      index += 1
      continue
    }
    if (char === '\n') out.push(char)
    index += 1
  }
  return out.join('')
}

/** Does this module have an IMPORT edge naming the symbol? The re-export edge is not one. */
function importsSymbol(stripped: string, symbol: string): boolean {
  const statement = new RegExp(
    `\\b${KEYWORD_IMPORT}\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*\\b${KEYWORD_FROM}\\b`,
    'g',
  )
  let matched = statement.exec(stripped)
  while (matched !== null) {
    const clause = matched[1] ?? ''
    if (new RegExp(`(?:^|[,{\\s])${symbol}(?:\\s|,|$)`).test(clause)) return true
    matched = statement.exec(stripped)
  }
  return false
}

/** Every invocation of `symbol`, bare or member-prefixed, as its balanced argument text. */
function invocationArguments(stripped: string, symbol: string): string[] {
  const call = new RegExp(`(?:^|[^\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?${symbol}\\s*\\(`, 'g')
  const regions: string[] = []
  let matched = call.exec(stripped)
  while (matched !== null) {
    const open = matched.index + matched[0].length - 1
    let depth = 0
    let cursor = open
    while (cursor < stripped.length) {
      const char = stripped[cursor]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    regions.push(stripped.slice(open + 1, cursor))
    call.lastIndex = open + 1
    matched = call.exec(stripped)
  }
  return regions
}

interface CallSite {
  readonly path: string
  /** True iff this module also invokes `acquireWriterLease` — it owns a lease while composing. */
  readonly leaseHolding: boolean
  readonly suppliesAuthority: boolean
  readonly suppliesDelegate: boolean
}

/**
 * Classify a module as a `composeLocalAgent` call site, or not one at all.
 *
 * A call site is a module that both IMPORTS the symbol and INVOKES it. Requiring the import edge
 * is the load-bearing half: prose and ledger strings can carry the invocation shape verbatim, and
 * two files in this workspace do.
 */
function classify(path: string, source: string): CallSite | undefined {
  const stripped = stripCommentsAndStringContents(source)
  if (!importsSymbol(stripped, 'composeLocalAgent')) return undefined
  const regions = invocationArguments(stripped, 'composeLocalAgent')
  if (regions.length === 0) return undefined
  return {
    path,
    // Deliberately loose in the strict direction: a module that merely DECLARES an
    // `acquireWriterLease(root: string): Outcome` member is read as lease-holding. `daemon/host.ts`
    // has both that declaration and the real member call, so tightening this would not change any
    // real answer, and the looseness errs toward requiring the authority rather than excusing a
    // module from it. A wrong classification here is a loud build failure, never a silent pass.
    leaseHolding: new RegExp('(?:^|[^\\w$.])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?acquireWriterLease\\b')
      .test(stripped),
    suppliesAuthority: regions.some((region) => /\bresolveWriterAuthority\b/.test(region)),
    suppliesDelegate: regions.some((region) => /\bapplyDelegate\b/.test(region)),
  }
}

/** The contract compose-local-agent.ts documents, applied to one discovered site. */
function violation(site: CallSite): string | undefined {
  if (site.leaseHolding && !site.suppliesAuthority) {
    return `${site.path} acquires the writer lease and composes without resolveWriterAuthority`
  }
  if (site.suppliesAuthority && site.suppliesDelegate) {
    return `${site.path} supplies both resolveWriterAuthority and applyDelegate`
  }
  return undefined
}

// ---- the real tree ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/cli/src/__tests__ → src → cli → packages → repository root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const PACKAGES_ROOT = join(REPO_ROOT, 'packages')
/** The module that DECLARES the option; it names both tokens and composes nothing. */
const DECLARING_MODULE = 'compose-local-agent.ts'

function productionSources(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.test.ts') || entry.endsWith('.test-d.ts')) continue
      if (entry === DECLARING_MODULE) continue
      found.push(full)
    }
  }
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const src = join(PACKAGES_ROOT, pkg, 'src')
    let stats
    try {
      stats = statSync(src)
    } catch {
      continue
    }
    if (stats.isDirectory()) walk(src)
  }
  return found
}

function discoverCallSites(): CallSite[] {
  const sites: CallSite[] = []
  for (const file of productionSources()) {
    const site = classify(
      relative(REPO_ROOT, file).split(sep).join('/'),
      readFileSync(file, 'utf8'),
    )
    if (site !== undefined) sites.push(site)
  }
  return sites.sort((left, right) => left.path.localeCompare(right.path))
}

// ---- fixtures: the four shapes the real tree actually contains --------------------------------

const PLANTED_VIOLATION = [
  moduleStatement(KEYWORD_IMPORT, 'composeLocalAgent', AGENT_LOCAL_SPECIFIER),
  moduleStatement(KEYWORD_IMPORT, 'acquireWriterLease', KNOWLEDGE_LOCAL_SPECIFIER),
  '',
  'export function runFutureHost(knowledgeRoot: string) {',
  '  const acquired = acquireWriterLease(knowledgeRoot)',
  '  return composeLocalAgent({',
  '    knowledgeRoot: () => knowledgeRoot,',
  '  })',
  '}',
].join('\n')

const COMPLIANT_HOLDER = PLANTED_VIOLATION.replace(
  '    knowledgeRoot: () => knowledgeRoot,',
  '    knowledgeRoot: () => knowledgeRoot,\n'
  + '    resolveWriterAuthority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),',
)

const TWO_PLACES_AT_ONCE = COMPLIANT_HOLDER.replace(
  '    resolveWriterAuthority:',
  '    applyDelegate: async (id: string) => id,\n    resolveWriterAuthority:',
)

/** The `agent/src/functions/registry.ts` and `arch/src/lint/reader-carveout.ts` shape. */
const PROSE_ONLY = [
  '// `composeLocalAgent()` is where the registry a host would otherwise wire by hand comes from,',
  '// and a host that also calls acquireWriterLease(root) is the daemon.',
  '/* The block-comment form of the same sentence: composeLocalAgent() and acquireWriterLease(). */',
  'export const NOTE = 1',
].join('\n')

/** The `arch/src/lint/surface-firewall-ledger.ts` shape — parens inside a ledger reason. */
const LEDGER_STRING_ONLY = [
  'export const LEDGER = [',
  "  { reason: 'the eval session composition root; superseded by composeLocalAgent()' },",
  "  { reason: 'lease taken elsewhere; see acquireWriterLease() in the daemon' },",
  ']',
].join('\n')

/** The `agent-local/src/index.ts` shape — a bare barrel re-export, not an import. */
const BARREL_REEXPORT = [
  moduleStatement(KEYWORD_EXPORT, 'composeLocalAgent, createKnowledgeReview', './composition/x.js'),
].join('\n')

describe('the classifier is shown to classify before it is trusted', () => {
  it('rejects a lease-holding composition that omits the authority', () => {
    const site = classify('fixtures/future-host.ts', PLANTED_VIOLATION)
    expect(site).toBeDefined()
    expect(site?.leaseHolding).toBe(true)
    expect(site?.suppliesAuthority).toBe(false)
    expect(violation(site!)).toContain('composes without resolveWriterAuthority')
  })

  it('accepts the same composition once it hands in the authority it holds', () => {
    const site = classify('fixtures/future-host.ts', COMPLIANT_HOLDER)
    expect(site?.leaseHolding).toBe(true)
    expect(site?.suppliesAuthority).toBe(true)
    expect(violation(site!)).toBeUndefined()
  })

  it('rejects a host claiming to be both the holder and a delegator', () => {
    const site = classify('fixtures/two-places.ts', TWO_PLACES_AT_ONCE)
    expect(site?.suppliesAuthority).toBe(true)
    expect(site?.suppliesDelegate).toBe(true)
    expect(violation(site!)).toContain('supplies both')
  })

  it('does not read prose as a call site, even prose written with parens', () => {
    expect(classify('fixtures/prose.ts', PROSE_ONLY)).toBeUndefined()
  })

  it('does not read a ledger STRING as a call site', () => {
    // The defence the comment-strip does not provide: these occurrences are not comments, and
    // they carry the invocation shape verbatim. `arch/src/lint/surface-firewall-ledger.ts` has
    // ten of them today.
    expect(classify('fixtures/ledger.ts', LEDGER_STRING_ONLY)).toBeUndefined()
  })

  it('does not read a barrel re-export as a call site', () => {
    expect(classify('fixtures/barrel.ts', BARREL_REEXPORT)).toBeUndefined()
  })
})

describe('every production composeLocalAgent call site', () => {
  it('is exactly the two known compositions, classified as their posture says', () => {
    const discovered = discoverCallSites()
    // EXACT equality, never `contains`. A new composition — the very thing that could repeat the
    // 387-09 omission — must be seen here and classified deliberately, not absorbed silently.
    expect(
      discovered.map((site) => `${site.path} [${site.leaseHolding ? 'holder' : 'non-holder'}]`),
    ).toEqual([
      'packages/cli/src/composition/local-agent-host.ts [non-holder]',
      'packages/cli/src/daemon/host.ts [holder]',
    ])
  })

  it('supplies the writer authority wherever it holds the lease', () => {
    const discovered = discoverCallSites()
    // Non-vacuity, the other side of it: a scan that discovered nothing would pass an
    // every()-shaped assertion trivially, so the holder set is asserted non-empty by name.
    expect(discovered.filter((site) => site.leaseHolding).map((site) => site.path))
      .toEqual(['packages/cli/src/daemon/host.ts'])
    expect(discovered.map((site) => violation(site)).filter((row) => row !== undefined))
      .toEqual([])
  })

  it('never has a delegating site also claim to hold the lease', () => {
    const discovered = discoverCallSites()
    // 2026-10-01 (432-17 D-05): the CLI host was the one site supplying `applyDelegate`, the
    // daemon-forwarded proposal apply. That apply is deleted with the inbox, so no production site
    // delegates any more; the both-at-once rule stays pinned by the synthetic `two-places` cell.
    expect(discovered.filter((site) => site.suppliesDelegate).map((site) => site.path))
      .toEqual([])
    for (const site of discovered) {
      expect(site.suppliesDelegate && site.suppliesAuthority).toBe(false)
    }
  })
})
