// Two-sided: each module must cite a known SEP, and none may carry a retired spec-tag spelling.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THIS_FILE = fileURLToPath(import.meta.url)
const TESTS_DIR = dirname(THIS_FILE)
const SRC_DIR = resolve(TESTS_DIR, '..')

/** Any SEP reference, in the one spelling this repository uses. */
const SEP_CITATION = /SEP-(\d{3,4})/gu

// The `2026-07-28` SEP index, so an invented number fails even though it matches the pattern.
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

// A blocklist: adding a member makes it longer, never complete.
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
    // The non-vacuity control for the cell above: the predicate must be able to answer uncited.
    expect(citedSeps('// a module header that cites nothing at all\nexport const x = 1\n')).toEqual([])
    expect(citedSeps('// grounded in SEP-2567\n').length).toBe(1)
  })

  it('POSITIVE: every cited SEP is a member of the `2026-07-28` index', () => {
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
