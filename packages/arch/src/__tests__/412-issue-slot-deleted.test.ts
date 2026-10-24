/**
 * THE ISSUE-SLOT DELETION CENSUS (CLSR-01, D-01/D-02/D-03) — the whole milestone inventory in one
 * cell: the retired job-kind and type vocabulary of 409, the retired entity kind of 410, and the
 * retired proposal arm of 411 are grep-clean across every workspace package's `src`, tests and
 * comments included.
 *
 * WHAT THIS PROVES, AND WHY A GREEN SUITE DOES NOT PROVE IT. Phases 409, 410 and 411 each narrowed
 * closed sets: the shipped job kinds (six to five), the analyze-run successor constants (two to
 * one), the derived post-run chain ids (three to two), the delta vocabularies (two to one), the
 * record-id brands (three to two), the entity kinds (six to five), the resolution reasons (three to
 * two) and the proposal kinds (four to three). Every one of those is a set that got SMALLER, and a
 * set that got smaller has a failure mode a passing suite cannot see: the removed member coming
 * back. Nothing in a green run fails when a retired kind, id, brand, prefix, scheme, reason, schema
 * or digest string is re-added — an assertion that a shape CONTAINS what it should contain is
 * satisfied by a shape that contains more. So each narrowing is pinned by a cell that REDs on its
 * return, and every one of those cells was measured by hand-mutation in the three phase ledgers:
 * `.planning/phases/409-the-job-kind-layer-the-type-vocabulary/409-MUTATION-LEDGER.md`,
 * `.planning/phases/410-the-bug-entity-kind/410-MUTATION-LEDGER.md` and
 * `.planning/phases/411-write-test-s-app-broken-branch-report-the-verdict-and-stop/411-MUTATION-LEDGER.md`,
 * each of which reads the process exit code rather than arguing from a green suite. This file is
 * the merged successor of the three sibling censuses those phases shipped; their bytes moved here.
 * One inventory, one place to widen.
 *
 * THE THREE UNIVERSES, BY PATH RULE. Thirty-five needles have ZERO occurrences across
 * `packages/<pkg>/src` for every workspace package — `.ts`/`.tsx`, with only `dist`,
 * `node_modules`, `.turbo` and `coverage` pruned. A thirty-sixth, the quoted status literal of the
 * roadmap's criterion 2, is scoped to the PRODUCTION subset of that same universe, built by a PATH
 * RULE — no `__tests__` path segment and no `.test.ts` / `.test.tsx` / `.test-d.ts` suffix — and
 * never by naming a file (D-03 widens 410's rule to the type-test suffix). The last two, the
 * funnel's retired side counter and its object key, are scoped to the FUNNEL subset by a second
 * path rule, because those two words are ordinary English everywhere else in the tree and a global
 * needle would accuse twenty homonyms this milestone does not own. All three universes scan TESTS
 * AS WELL AS SOURCE: this milestone owns every occurrence of its needle set in the package trees,
 * not only the production ones. COMMENTS COUNT. A retirement note that spells a retired token is a
 * hit exactly like a live reference is, because the promise is "this string is not in the tree",
 * not "no code reads it" — which is why the surviving prose states the surviving rule and names the
 * CONCEPT rather than the token.
 *
 * WHY THE KIND NEEDLE IS A REGEX AND NOT A SUBSTRING. The retired entity kind is a three-letter
 * upper-case word that is also ordinary English. A bare word-bounded match is case-sensitive so the
 * lower-case English word never matches, and the upper-case debugging token has no word boundary
 * before its last three letters — which is exactly what a plain substring match cannot express, and
 * why the kind needle is a `RegExp` (the short-ID prefix is one for the same reason). One residue
 * survives that: three English upper-case spellings measured in files outside this milestone, two
 * after `CALLER ` and one after `A `. A negative lookbehind for those two prefixes excludes them,
 * carried verbatim from 410, and the negative-control cell below pins that behaviour so the
 * lookbehind can neither silently widen nor silently swallow a real occurrence.
 *
 * THE BY-NAME CONTROL IS POSITIVE, NEVER A FILTER. CLSR-01 excludes two sites from the quoted
 * status literal, and the exclusion is MEASURED rather than documented: production scope stays a
 * path rule that names no file, and a separate cell asserts BY NAME that exactly the one refusal
 * fixture still spells the quoted literal outside production and that the conformance domain-list
 * spells only the bare marker key. A third speller REDs that control instead of hiding behind an
 * exclusion list. The reasons are the assertion messages: the older three-stage row the refusal
 * cell plants is load-bearing input rather than debris, and a dated reservation marker on a
 * domain-list member is a different concept that happens to share a word.
 *
 * THE SWEEP'S IDENTIFIER-SHAPED SPELLINGS ARE IN THE INVENTORY TOO. This phase's prose sweep
 * removed the last citations of the retired curation spec, of the extension a growth rule once
 * anticipated, of the scaffolded shelf and of the milestone attribution. Those spellings join the
 * inventory here so a later re-citation REDs BY NAME instead of passing unnoticed — a one-time
 * grep closes nothing, because nothing notices a return. The shelf is pinned in THREE forms
 * because the scaffold spelled it inside a template literal, where the delimiter is escaped: a
 * plain-delimiter needle cannot see the escaped form, and the spoken phrase is neither. Two of the
 * seven labels carry an apostrophe and are therefore built from two pieces, so every table entry
 * stays single-quoted on one line; in full those two read
 * `the deleted curation spec's citation`
 * and `the scaffolded README's filed-issues promise`.
 *
 * THIS FILE CANNOT MATCH ITSELF. Every needle is assembled at run time from two halves, so no whole
 * token is ever spelled in this source — the header prose included, which is why it names concepts
 * and never spellings. Because the census scans tests, this file sits inside its own universe: a
 * needle spelled literally here would RED the very cell that spells it, and the two-half
 * construction is load-bearing rather than decorative. The last cell below asserts that property
 * over this file's own bytes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
/** `packages/arch/src/__tests__` -> `packages`. */
const PACKAGES_DIR = join(HERE, '..', '..', '..')

// ---------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------

/**
 * One inventory entry: the concept the census names, the token it refuses, and whether that token
 * is one of the fifteen names CLSR-01 lists. The subset flag is deliberately optional and
 * deliberately `true`-only — an entry that carries it is in the milestone inventory, an entry that
 * omits it is measured coverage a prior phase paid for and this file keeps (D-02).
 */
interface NeedleEntry {
  readonly label: string
  readonly needle: string | RegExp
  readonly clsr01?: true
}

/**
 * The kind needle (see the header for why it is not a substring). No `g` flag, so `.test` is
 * stateless and one call per line cannot carry `lastIndex` into the next. Carried verbatim from
 * 410, lookbehind and all.
 */
const KIND_NEEDLE = new RegExp('(?<!CALLER |A )\\bB' + 'UG\\b')

// 2026-10-14 (441-36): word-bounded like the kind needle, so the debugging token's hyphenated
// test-area name is not a hit.
const SHORT_ID_NEEDLE = new RegExp('\\bB' + 'UG-')

/** Two needles too long to sit inside a one-line table entry at the repo's print width. */
const SUCCESSORS_NEEDLE = 'ANALYZE_RUN_PRODUCED_' + 'SUCCESSORS'
const CHAIN_KINDS_NEEDLE = 'POST_RUN_CHAIN_' + 'KINDS'

/**
 * The global needle set: 409's nine, then 410's six, then 411's thirteen, in the order the three
 * phases measured them, then the seven spellings Phase 412's own sweep retired.
 *
 * Every needle is built from two halves so this file cannot satisfy its own inventory, and each
 * split is chosen so NEITHER half is itself a needle: the dashboard fixture splits before its last
 * five characters rather than at the underscore, and the quoted literals cut INSIDE the word rather
 * than at a quote boundary.
 *
 * Two substring notes, both deliberate and both carried from 409: the one membership list this
 * milestone RETAINED does not contain the never-imported chain-kinds needle as a substring, so the
 * retained name is not a false positive; and Zod's `error.issues` property access matches none of
 * these by construction.
 */
const FORBIDDEN: NeedleEntry[] = [
  { label: 'the reserved sixth job kind', needle: 'triage-' + 'issues', clsr01: true },
  { label: 'the third chain id key', needle: 'triage' + 'Issues', clsr01: true },
  { label: 'the reserved kind' + "'s checkpoint id", needle: 'issues-' + 'drafted', clsr01: true },
  { label: 'the produced-successors constant', needle: SUCCESSORS_NEEDLE, clsr01: true },
  { label: 'the never-imported chain-kinds list', needle: CHAIN_KINDS_NEEDLE, clsr01: true },
  { label: 'the second delta vocabulary', needle: 'Issue' + 'Delta', clsr01: true },
  { label: 'the third id brand', needle: 'Issue' + 'Id', clsr01: true },
  { label: 'the third id brand' + "'s cast helper", needle: 'asIssue' + 'Id', clsr01: true },
  { label: 'the second delta vocabulary' + "'s module", needle: 'issue-' + 'delta' },
  { label: 'the retired entity kind', needle: KIND_NEEDLE, clsr01: true },
  { label: 'the retired short-ID prefix', needle: SHORT_ID_NEEDLE, clsr01: true },
  { label: 'the retired URI scheme', needle: 'agentqa://' + 'bug', clsr01: true },
  { label: 'the retired resolution reason', needle: 'reserved-' + 'kind', clsr01: true },
  { label: 'the retired mint refusal', needle: 'BugAddressing' + 'NotAvailable', clsr01: true },
  { label: 'the retired dashboard fixture', needle: 'BU' + 'G_CARD' },
  { label: 'the retired proposal kind literal', needle: "'find" + "ing'" },
  { label: 'the retired proposal schema family', needle: 'FindingPro' + 'posal', clsr01: true },
  { label: 'the retired route interface', needle: 'Finding' + 'Route' },
  { label: 'the retired failure-point schema', needle: 'FindingFailure' + 'Point', clsr01: true },
  { label: 'the retired router signal-class type', needle: 'RouterFinding' + 'SignalClass' },
  { label: 'the retired route helper stem', needle: 'find' + 'ingRoute' },
  { label: 'the retired loop carrier', needle: 'find' + 'ingProposal' },
  { label: 'the retired evidence helper', needle: 'findingEvidence' + 'For' },
  { label: 'the retired corpus key', needle: 'findingDirection' + 'Rows' },
  { label: 'the retired router entry point', needle: 'routeRepairOr' + 'Finding' },
  { label: 'the retired accept route key', needle: 'ROUTE_FOR_KIND.f' + 'inding' },
  { label: 'the retired digest line', needle: 'find' + 'ing on ' },
  { label: 'the retired cell-title stem', needle: 'finding-' + 'branch' },
  // The sweep's spellings (D-15), added once Plan 02 removed their sites. None is a CLSR-01 name.
  { label: 'the deleted curation spec' + "'s citation", needle: 'issue-' + 'curation' },
  { label: 'the anticipated scope door', needle: 'issues-' + 'write' },
  { label: 'the scaffolded README' + "'s filed-issues promise", needle: 'filed ' + 'issues' },
  { label: 'the scaffolded issues shelf, backticked', needle: 'issues/' + '`' },
  { label: 'the scaffolded issues shelf, template-escaped', needle: 'issues/\\' + '`' },
  { label: 'the scaffolded issues shelf, spoken', needle: 'issues/ ' + 'shelf' },
  { label: 'the Issue-milestone attribution', needle: 'Issue ' + 'milestone' },
]

/**
 * The roadmap's criterion-2 needle, scoped to production sources only. The quote characters are
 * part of it: the bare word survives legitimately in English prose, in a dated retirement note and
 * as a domain-list marker key, and only the QUOTED literal was the retired status value. CLSR-01
 * states this as a separate clause from its fifteen names, so it carries no subset flag; the
 * by-name control below is the other half of the same claim.
 */
const PRODUCTION_ONLY_FORBIDDEN: NeedleEntry[] = [
  { label: 'the retired status literal', needle: "'reser" + "ved'" },
]

/**
 * The side-counter needles, scoped to the funnel subset by the path rule below. The two words are
 * ordinary English everywhere else in the tree — the CLI's config-scan report, the safety
 * guardrail, the conformance corpus, the runner's legacy-retirement cell — and only the funnel's
 * counter was retired, so a global scan here would accuse files this milestone does not own.
 */
const FUNNEL_SCOPED_FORBIDDEN: NeedleEntry[] = [
  { label: 'the retired side-counter access', needle: 'sideCounters.' + 'findings' },
  { label: 'the retired side-counter key', needle: 'findings' + ':' },
]

/** Every entry, in table order — the union the planted-positive and self-match cells work over. */
const EVERY_NEEDLE: NeedleEntry[] = [
  ...FORBIDDEN,
  ...PRODUCTION_ONLY_FORBIDDEN,
  ...FUNNEL_SCOPED_FORBIDDEN,
]

/**
 * Only build output and dependency trees are pruned. There is no test exclusion here and there is
 * none by filename either — production and funnel scope are path rules (410 D-04, 411 (g)).
 */
const SCAN_EXCLUDED_DIRS = new Set(['dist', 'node_modules', '.turbo', 'coverage'])

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_DIRS.has(entry.name)) continue
      collectSourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
}

/** The packages that HAVE a `src` directory, discovered from disk — never a pinned list. */
function discoverSourceRoots(): Array<{ pkg: string; dir: string }> {
  const roots: Array<{ pkg: string; dir: string }> = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, pkg, 'src')
    try {
      if (statSync(dir).isDirectory()) roots.push({ pkg, dir })
    } catch {
      /* a package without src contributes nothing */
    }
  }
  return roots
}

function scanFileUniverse(): string[] {
  const files: string[] = []
  for (const root of discoverSourceRoots()) collectSourceFiles(root.dir, files)
  return files
}

interface Hit {
  file: string
  line: number
  text: string
}

/** The extractor. Reads raw text: a token in a comment is a hit, by design (see the header). */
function findNeedle(needle: string | RegExp, source: string, label: string): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((text, index) => {
    const matched = needle instanceof RegExp ? needle.test(text) : text.includes(needle)
    if (matched) hits.push({ file: label, line: index + 1, text: text.trim() })
  })
  return hits
}

/** Collects `<relative path>:<1-based line>: <text>` for one needle over one universe. */
function census(needle: string | RegExp, universe: readonly string[]): string[] {
  const hits: string[] = []
  for (const file of universe) {
    const rel = relative(PACKAGES_DIR, file).split(sep).join('/')
    for (const hit of findNeedle(needle, readFileSync(file, 'utf8'), rel)) {
      hits.push(`${hit.file}:${hit.line}: ${hit.text}`)
    }
  }
  return hits
}

const SOURCES = scanFileUniverse()

/**
 * The second universe, derived by PATH RULE and never by name (410 D-04, widened by D-03): a
 * production source is a scanned file outside any `__tests__` directory that carries neither a
 * `.test` nor a `.test-d` suffix. A file that is both under a `__tests__` segment and carries the
 * type-test suffix is outside this universe by either rule alone.
 */
const PRODUCTION_SOURCES = SOURCES.filter(
  (f) => !f.includes(`${sep}__tests__${sep}`) && !/\.test(-d)?\.tsx?$/.test(f),
)

/**
 * The third universe, also a rule (411 D-14): a file under `src/authoring/` (with or without a
 * `__tests__` segment) whose basename opens with the funnel stem, or a funnel op's cell under
 * `src/functions/__tests__/`. Carried verbatim.
 */
const FUNNEL_RULE =
  /\/src\/(authoring\/(__tests__\/)?funnel|functions\/__tests__\/authoring-funnel)[^/]*\.tsx?$/

const FUNNEL_SOURCES = SOURCES.filter((f) => FUNNEL_RULE.test(f.split(sep).join('/')))

describe('the issue-slot needle set is gone from every package src, tests included (CLSR-01)', () => {
  // The universe control. A resolution bug that silently narrowed any of the three scans would
  // report the same clean zero as a clean tree — 401-10's self-certifying guard, in inventory form.
  // Lower bounds only: the tree grows, and a pinned total would measure the tree rather than the
  // scan. Measured at 410: 23 roots, 2490 files, 1251 production files.
  it('scans every package that has a src directory, and a non-trivial number of files', () => {
    const roots = discoverSourceRoots()
    expect(roots.length).toBeGreaterThan(5)

    const packagesSeen = new Set(SOURCES.map((f) => relative(PACKAGES_DIR, f).split(sep)[0]))
    const missing = roots.map((r) => r.pkg).filter((pkg) => !packagesSeen.has(pkg))
    expect(
      missing,
      `packages with src/ that contributed no scanned file: ${missing.join(', ')}`,
    ).toEqual([])

    for (const root of roots) {
      const forThisPackage = SOURCES.filter(
        (f) => relative(PACKAGES_DIR, f).split(sep)[0] === root.pkg,
      )
      expect(forThisPackage.length, `${root.pkg} contributed no scanned file`).toBeGreaterThan(0)
    }

    expect(SOURCES.length).toBeGreaterThan(500)

    // The production universe is proven non-empty and a STRICT subset, so a path rule that matched
    // everything (or nothing) cannot pass the production-only cell for the wrong reason.
    expect(PRODUCTION_SOURCES.length).toBeGreaterThan(800)
    expect(PRODUCTION_SOURCES.length).toBeLessThan(SOURCES.length)

    // The funnel universe, likewise. Both producers must be in it by relative path — that and the
    // by-name control below are the only places a file is named in this census.
    const funnelRelative = FUNNEL_SOURCES.map((f) => relative(PACKAGES_DIR, f).split(sep).join('/'))
    expect(
      FUNNEL_SOURCES.length,
      `the funnel universe: ${funnelRelative.join(', ')}`,
    ).toBeGreaterThanOrEqual(5)
    expect(FUNNEL_SOURCES.length).toBeLessThan(SOURCES.length)
    expect(funnelRelative).toContain('schema/src/authoring/funnel.ts')
    expect(funnelRelative).toContain('agent/src/authoring/funnel.ts')
  })

  // The funnel scope is a RULE, asserted against synthetic paths so it holds whether or not the
  // tree currently contains any of them. Both directions: the producers and their cells are
  // admitted, and the three homonym families this milestone does not own are refused.
  it('the funnel scope is a path rule — it admits both producers and their tests and refuses the config-scan homonym', () => {
    const admitted = [
      'packages/schema/src/authoring/funnel.ts',
      'packages/agent/src/authoring/funnel.ts',
      'packages/schema/src/authoring/__tests__/funnel.test-d.ts',
      'packages/agent/src/authoring/__tests__/funnel-projection.test.ts',
      'packages/agent/src/functions/__tests__/authoring-funnel-get.test.ts',
    ]
    const refused = [
      'packages/cli/src/commands/proposals.ts',
      'packages/safety/src/guardrail/construction-scan.ts',
      'packages/runner/src/loop/__tests__/legacy-retirement.test.ts',
    ]
    expect(
      admitted.filter((p) => !FUNNEL_RULE.test(p)),
      'the path rule dropped a funnel file',
    ).toEqual([])
    expect(
      refused.filter((p) => FUNNEL_RULE.test(p)),
      'the path rule admitted a homonym file',
    ).toEqual([])
  })

  // The subset pin. CLSR-01 names fifteen tokens; this file measures more than fifteen because the
  // union keeps everything 409, 410 and 411 paid to measure (D-02). The count is taken across all
  // three tables, so a mark that wanders onto a scoped entry REDs here rather than quietly
  // inflating the milestone inventory.
  it('marks exactly fifteen needles as the CLSR-01 milestone inventory subset', () => {
    const marked = EVERY_NEEDLE.filter((entry) => entry.clsr01 === true).map((entry) => entry.label)
    expect(marked, `the marked subset: ${marked.join(', ')}`).toHaveLength(15)
  })

  // The known-positive control. Every needle is planted in a synthetic source and must be found —
  // otherwise a typo'd needle reports zero hits forever and the census measures nothing. The
  // RegExp entries and the quoted-literal entries are planted from halves too, so no whole token
  // exists anywhere but in memory. Line numbers are 1-based, so the planted line is line 2 of 3.
  it('finds every planted needle — the known-positive control for the extractor', () => {
    for (const { label, needle } of EVERY_NEEDLE) {
      const body =
        needle instanceof RegExp
          ? 'const planted = ' + "'" + 'B' + 'UG-1' + "'"
          : needle.startsWith("'")
            ? 'const planted = ' + needle
            : `const planted = '${needle}'`
      const planted = ['const untouched = 1', body, '// tail'].join('\n')
      const hits = findNeedle(needle, planted, 'synthetic/planted.ts')
      expect(hits.length, `the extractor could not find the planted ${label}`).toBe(1)
      expect(hits[0]?.line).toBe(2)
    }
  })

  // The negative control for the lookbehind. Without it the kind cell would RED on ordinary
  // English in packages this milestone does not own; with it too wide, a real occurrence after
  // those words would hide. Both directions are asserted by one planted trio.
  it('keeps the two English collocations out — the negative control for the kind needle', () => {
    const token = 'B' + 'UG'
    const planted = [`// CALLER ${token} that`, `// WAS A ${token} here`, `// the ${token} kind`]
    const hits = findNeedle(KIND_NEEDLE, planted.join('\n'), 'synthetic/collocations.ts')
    expect(
      hits.map((hit) => hit.line),
      `the lookbehind admitted an English collocation, or dropped a real hit: ${JSON.stringify(hits)}`,
    ).toEqual([3])
  })

  // The extractor reads COMMENTS too. Stated as its own cell because it is the property 404-02 was
  // sent back for, and a property nobody asserts is a property that drifts the first time somebody
  // "helpfully" strips comments before scanning.
  it('counts a needle inside a comment as a hit', () => {
    const { needle } = FORBIDDEN[1] as { needle: string }
    const commented = `// a retirement note naming ${needle} in prose`
    expect(findNeedle(needle, commented, 'synthetic/commented.ts')).toHaveLength(1)
  })

  for (const { label, needle } of FORBIDDEN) {
    it(`no source or test spells ${label}`, () => {
      const hits = census(needle, SOURCES)
      expect(
        hits,
        `a retired token reappeared in the shipped tree (CLSR-01):\n${hits.join('\n')}`,
      ).toEqual([])
    })
  }

  for (const { label, needle } of PRODUCTION_ONLY_FORBIDDEN) {
    it(`no production source spells ${label}`, () => {
      const hits = census(needle, PRODUCTION_SOURCES)
      expect(
        hits,
        `a retired status literal reappeared in production source (CLSR-01):\n${hits.join('\n')}`,
      ).toEqual([])
    })
  }

  for (const { label, needle } of FUNNEL_SCOPED_FORBIDDEN) {
    it(`no funnel file spells ${label}`, () => {
      const hits = census(needle, FUNNEL_SOURCES)
      expect(
        hits,
        `a retired side-counter token reappeared in a funnel file (CLSR-01):\n${hits.join('\n')}`,
      ).toEqual([])
    })
  }

  // The by-name control. CLSR-01's two exclusions live HERE, in a positive assertion, and
  // never in a scan filter: an exclusion list would pass while measuring nothing, and a third
  // file that started spelling the quoted literal outside production would slip past it. The list
  // is sorted before comparison so the assertion is independent of readdir order.
  it('names exactly the one refusal fixture that spells the retired status literal outside production, and the domain-list marker that spells only the bare key', () => {
    const quoted = "'reser" + "ved'"
    const spellers = SOURCES.filter((f) => !PRODUCTION_SOURCES.includes(f))
      .filter((f) => readFileSync(f, 'utf8').includes(quoted))
      .map((f) => relative(PACKAGES_DIR, f).split(sep).join('/'))
      .sort()
    expect(
      spellers,
      `only the refusal fixture may still spell it — it plants the older three-stage row whose refusal it proves, which is load-bearing input rather than debris:\n${spellers.join('\n')}`,
    ).toEqual([
      'agent-local/src/__tests__/post-processing-status.test.ts',
    ])

    const domainListPath = join(PACKAGES_DIR, 'cli/src/__tests__/conformance/domain-list.ts')
    const domainList = readFileSync(domainListPath, 'utf8')
    expect(
      domainList,
      'the domain-list marker is a dated reservation on a member — a different concept that happens to share a word, and it spells the bare key',
    ).toContain('reser' + 'ved:')
    expect(
      domainList,
      'the domain-list marker never spells the retired status value itself',
    ).not.toContain(quoted)
  })

  // A cell that cannot match itself. This file IS inside the scanned universe, so a needle spelled
  // here would already have reddened a cell above — this one names the cause instead of leaving
  // the reader to work out why the census is accusing its own source. The scoped needles are
  // included even though this file is outside both scopes: a whole spelling here would still be an
  // inventory satisfying itself the moment a later phase widens a rule.
  it('spells none of its own needles — the inventory cannot be satisfied by this file', () => {
    const own = readFileSync(THIS_FILE, 'utf8')
    const selfHits = EVERY_NEEDLE.filter(({ needle }) =>
      needle instanceof RegExp ? needle.test(own) : own.includes(needle),
    ).map((entry) => entry.label)
    expect(
      selfHits,
      `this cell spells a needle it forbids; build it from two halves: ${selfHits.join(', ')}`,
    ).toEqual([])
  })
})
