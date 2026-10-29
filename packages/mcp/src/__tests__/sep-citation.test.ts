// The citation gate (Phase 396 plan 08 · MCPS-07).
//
// MCPS-07 says requirements and code cite SEP numbers, not a spec tag. A sweep is the natural way to
// enforce that and also the natural way to enforce NOTHING: this phase has already recorded three
// checks that answered the same on both sides of the mutation they forbade (plan 03's acceptance
// grep answered `8` under the implementation it banned; plan 04's two import counts still answered
// `2` and `1` with the wired call sites deleted; plan 07 found that a conformance baseline entry
// naming a check id that does not exist is silently ignored, exit 0). So every assertion in this
// file is paired with something that makes it possible for it to fail.
//
// IT IS TWO-SIDED, AND THE TWO SIDES ARE NOT THE SAME STRENGTH.
//
//   POSITIVE  every non-test module under `src/` cites at least one SEP, and every SEP it cites is
//             a member of the 2026-07-28 index. Anchored on the SHAPE OF A CORRECT CITATION, so a
//             module carrying a tag spelling nobody enumerated still reds — it reds for having no
//             SEP, which is the thing MCPS-07 actually asks for.
//   NEGATIVE  no module carries a retired spec-tag spelling from a pinned constant.
//
// THE NEGATIVE SIDE'S BOUND IS STATED RATHER THAN HIDDEN. It is a blocklist, and a rule that can
// only refuse what it can NAME cannot be driven to zero by naming more things — a spelling nobody
// enumerated survives it. That is exactly why it is the WEAKER half and why the positive half is
// per-file and mandatory: an uncited module reds by its own file name regardless of which tag
// spelling it was carrying instead. The blocklist is a convenience for the one spelling this
// phase's own reconciliation was stale about; the presence rule is the requirement.
//
// THE SELF-EXCLUSION IS ASSERTED, NOT ASSUMED. This file must name the retired spellings in order
// to sweep for them, so it excludes itself from the negative sweep by PATH. An exclusion nobody
// checks is a hole, so two cells stand behind it: one asserts this file is absent from the swept
// set, and one asserts that this file WOULD be caught if it were present — i.e. the exclusion is
// load-bearing rather than decorative. A comment discipline follows from the same fact: prose in
// this repository must cite MCPS-07 or a SEP number rather than restate a retired spelling, or the
// sweep would red on the explanation of the sweep.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THIS_FILE = fileURLToPath(import.meta.url)
const TESTS_DIR = dirname(THIS_FILE)
const SRC_DIR = resolve(TESTS_DIR, '..')

/** Any SEP reference, in the one spelling this repository uses. */
const SEP_CITATION = /SEP-(\d{3,4})/gu

/**
 * The 2026-07-28 SEP index, transcribed from `396-RESEARCH.md`'s citation table, which was itself
 * enumerated from the spec repository's `docs/specification/2026-07-28/changelog.mdx`.
 *
 * This is the "shape of a correct citation" anchor: a typo or an invented number reds even though
 * it matches the SEP pattern perfectly. Without it the positive rule would accept `SEP-0000`, and a
 * citation nobody can look up is the same as no citation with extra confidence attached.
 */
const KNOWN_SEP_NUMBERS: ReadonlySet<string> = new Set([
  '414', // OTel trace-context `_meta` conventions
  '835', // resolved scope to DCR
  '837', // `application_type` in DCR
  '991', // Client ID Metadata Documents
  '1613', // the SDK-side JSON Schema 2020-12 posture
  '1730', // conformance tiers; extensions required for no tier
  '2106', // input/output schemas loosened to full JSON Schema 2020-12
  '2207', // TLS token endpoint + DCR defaults
  '2243', // standard `Mcp-Method` / `Mcp-Name` headers
  '2322', // Multi Round-Trip Requests (`input_required`)
  '2350', // scope step-up on 403
  '2352', // credential<->issuer binding
  '2468', // `iss` callback validation
  '2549', // `ttlMs` + `cacheScope` on cacheable list results
  '2567', // list endpoints no longer vary per connection; server-minted handles
  '2575', // stateless protocol: no handshake, no session id, no SSE resumability
  '2577', // Roots, Sampling, Logging deprecated
  '2596', // feature lifecycle / deprecation policy
  '2663', // tasks moved to the `io.modelcontextprotocol/tasks` extension
])

/**
 * Retired spec-tag spellings. Populated from the negative literal in this plan's verify gate plus
 * its two siblings of the same class: a dated release-candidate tag and the pre-release draft
 * directory a citation used to point at. See MCPS-07 for why these are refused rather than merely
 * discouraged, and read this constant's bound in the file header before extending it — adding a
 * member makes this list longer, never complete.
 */
const RETIRED_SPEC_TAG_SPELLINGS: readonly string[] = [
  '2026-07-28-RC',
  '2025-11-25-RC',
  'docs/specification/draft',
]

interface SweptFile {
  readonly path: string
  readonly rel: string
  readonly text: string
}

/** Every `.ts` file under `src/`, minus the tests directory. Produced by walking, never typed out. */
function sweptFiles(): readonly SweptFile[] {
  const out: SweptFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (full === TESTS_DIR) continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      out.push({ path: full, rel: relative(SRC_DIR, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(SRC_DIR)
  return [...out].sort((a: SweptFile, b: SweptFile) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function citedSeps(text: string): readonly string[] {
  return [...text.matchAll(SEP_CITATION)].map((m) => m[1] as string)
}

function retiredSpellingsIn(text: string): readonly string[] {
  return RETIRED_SPEC_TAG_SPELLINGS.filter((spelling) => text.includes(spelling))
}

describe('the SEP citation gate', () => {
  it('sweeps a non-empty, filesystem-produced set of modules', () => {
    const files = sweptFiles()
    // A sweep over zero files passes every assertion below it. This is the denominator.
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.every((f) => f.rel.endsWith('.ts'))).toBe(true)
  })

  it('POSITIVE: every non-test module cites at least one SEP', () => {
    const uncited = sweptFiles()
      .filter((f) => citedSeps(f.text).length === 0)
      .map((f) => f.rel)
    expect(uncited).toEqual([])
  })

  it('POSITIVE: the presence rule can answer "uncited"', () => {
    // The permanent non-vacuity control for the cell above. A predicate that cannot say no is not a
    // check, and this phase has shipped three that could not.
    expect(citedSeps('// a module header that cites nothing at all\nexport const x = 1\n')).toEqual([])
    expect(citedSeps('// grounded in SEP-2567\n').length).toBe(1)
  })

  it('POSITIVE: every cited SEP is a member of the 2026-07-28 index', () => {
    const unknown = sweptFiles().flatMap((f) =>
      citedSeps(f.text)
        .filter((n) => !KNOWN_SEP_NUMBERS.has(n))
        .map((n) => `${f.rel}: SEP-${n}`),
    )
    expect(unknown).toEqual([])
  })

  it('NEGATIVE: no module carries a retired spec-tag spelling', () => {
    const offenders = sweptFiles()
      .filter((f) => retiredSpellingsIn(f.text).length > 0)
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('the self-exclusion is real: this file is not in the swept set', () => {
    expect(sweptFiles().some((f) => f.path === THIS_FILE)).toBe(false)
  })

  it('the self-exclusion is LOAD-BEARING: this file would be caught if it were swept', () => {
    // Without this cell the exclusion could quietly become unnecessary — the constant emptied, the
    // spellings paraphrased — and the negative sweep would then be excluding a file it had no
    // reason to exclude, which reads as coverage and is not.
    const own = readFileSync(THIS_FILE, 'utf8')
    expect(retiredSpellingsIn(own).length).toBeGreaterThan(0)
    expect(RETIRED_SPEC_TAG_SPELLINGS.length).toBeGreaterThan(0)
  })
})
