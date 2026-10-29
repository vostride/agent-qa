import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// SAFE-03 release gate. This is the closing enforcement conformance gate. It
// carries one detection:
//   (a) STRUCTURAL — createModel's per-call middleware array ends with ...MIDDLEWARE and
//       then createMaskingMiddleware(mask), with createModel's own MaskFn (441 D-06, E7).
// (b), the registrar's fail-closed guardrail policy load, and (c), the
// audit-into-context import firewall, are deleted with the registrar and the audit port.
//
// House style mirrors the tools and arch validator tests: self-contained
// scan helpers (no cross-package import), offender lists, and held-out fixtures that
// prove each check rejects its violation. The model registry is read AS TEXT — never
// imported — so the safety package never depends on model (dependency inversion would
// trip the arch lint's direction/cycle firewalls — RESEARCH Pitfall 4). Test files are
// exempt from safety's ownership source-scan (arch's sourceFilesFor filters __tests__),
// so node:fs here is fine.

const testDir = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(testDir, '..', '..', '..')
const modelRegistrySource = readFileSync(
  join(packagesRoot, 'model', 'src', 'registry.ts'),
  'utf8',
)

// ---------------------------------------------------------------------------
// check (a): structural seam-pinning over a source string (pure, fixture-driven)
// ---------------------------------------------------------------------------

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

function matchBracket(source: string, openIndex: number): number {
  const open = source[openIndex]
  const close = open === '(' ? ')' : ']'
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevelEntries(inner: string): string[] {
  const entries: string[] = []
  let depth = 0
  let current = ''

  for (const char of inner) {
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1

    if (char === ',' && depth === 0) {
      entries.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) entries.push(current)

  return entries.map(entry => entry.trim()).filter(Boolean)
}

// Assert presence AND position; tolerate formatting-only edits; never merely check
// that the identifier appears somewhere (RESEARCH Pitfall 5).
function findSeamStructuralOffenders(rawSource: string, label: string): string[] {
  const source = stripComments(rawSource)
  const rule = (name: string, detail: string) => `${label} | ${name} | ${detail}`

  const signature = /export\s+function\s+createModel\s*\(/.exec(source)
  if (!signature) return [rule('create-model', 'export function createModel( not found')]
  const paramsOpen = signature.index + signature[0].length - 1
  const paramsClose = matchBracket(source, paramsOpen)
  const params = splitTopLevelEntries(source.slice(paramsOpen + 1, paramsClose))
  const maskParam = params
    .map(param => /^(\w+)\s*:\s*MaskFn$/.exec(param)?.[1])
    .find(name => name !== undefined)
  if (maskParam === undefined) {
    return [rule('mask-parameter', 'createModel must take a required MaskFn parameter')]
  }

  const declaration = /const\s+middleware\s*=\s*\[/.exec(source.slice(paramsOpen))
  if (!declaration) {
    return [rule('composition-array', 'the createModel per-call middleware array not found')]
  }
  const openIndex = paramsOpen + declaration.index + declaration[0].length - 1
  const entries = splitTopLevelEntries(source.slice(openIndex + 1, matchBracket(source, openIndex)))
  const expected = `createMaskingMiddleware(${maskParam})`
  const last = entries.at(-1) ?? ''
  if (last.replace(/\s+/g, '') !== expected) {
    return [rule('masking-last', `the last per-call element must be ${expected}, found ${last}`)]
  }
  if (entries.at(-2) !== '...MIDDLEWARE') {
    return [rule('spread-before-masking', `...MIDDLEWARE must come immediately before ${expected}`)]
  }
  return []
}

// Held-out fixtures (synthetic mini-sources) — these are what give the gate teeth.
function registryFixture(middleware: string[]): string {
  return [
    'const MIDDLEWARE: LanguageModelMiddleware[] = [retryMiddleware(), dropEmptyMessagesMiddleware()]',
    'export function createModel(',
    '  profile: ModelProfile,',
    '  auth: ResolvedModelAuth,',
    '  mask: MaskFn,',
    '  overrides: ModelProviderOverrides = {},',
    '): LanguageModelV3 {',
    '  const middleware = [',
    ...middleware.map(entry => `    ${entry},`),
    '  ]',
    '  return wrap(middleware)',
    '}',
  ].join('\n')
}

const FIXTURE_MISSING_MASKING = registryFixture([
  'capabilityUpdateMiddleware(profile)',
  '...MIDDLEWARE',
])

const FIXTURE_REORDERED_MASKING = registryFixture([
  'createMaskingMiddleware(mask)',
  'capabilityUpdateMiddleware(profile)',
  '...MIDDLEWARE',
])

const FIXTURE_SPREAD_AFTER_MASKING = registryFixture([
  'capabilityUpdateMiddleware(profile)',
  'createMaskingMiddleware(mask)',
  '...MIDDLEWARE',
])

const FIXTURE_ELEMENT_BETWEEN = registryFixture([
  'capabilityUpdateMiddleware(profile)',
  '...MIDDLEWARE',
  'dropEmptyMessagesMiddleware()',
  'createMaskingMiddleware(mask)',
])

const FIXTURE_FOREIGN_MASK = registryFixture([
  'capabilityUpdateMiddleware(profile)',
  '...MIDDLEWARE',
  'createMaskingMiddleware((text) => text)',
])

const MASKING_LAST =
  'fixture | masking-last | the last per-call element must be createMaskingMiddleware(mask), found'

describe('createModel keeps the masking middleware last', () => {
  it('reports zero structural offenders against the real model registry source', () => {
    expect(findSeamStructuralOffenders(modelRegistrySource, 'packages/model/src/registry.ts')).toEqual(
      [],
    )
  })

  it('rejects a held-out fixture whose createModel array omits the masking middleware', () => {
    expect(findSeamStructuralOffenders(FIXTURE_MISSING_MASKING, 'fixture')).toEqual([
      `${MASKING_LAST} ...MIDDLEWARE`,
    ])
  })

  it('rejects a held-out fixture with the masking middleware reordered out of last position', () => {
    expect(findSeamStructuralOffenders(FIXTURE_REORDERED_MASKING, 'fixture')).toEqual([
      `${MASKING_LAST} ...MIDDLEWARE`,
    ])
  })

  it('rejects a held-out fixture whose composition spreads ...MIDDLEWARE after the masking middleware', () => {
    expect(findSeamStructuralOffenders(FIXTURE_SPREAD_AFTER_MASKING, 'fixture')).toEqual([
      `${MASKING_LAST} ...MIDDLEWARE`,
    ])
  })

  it('rejects a held-out fixture with another element between ...MIDDLEWARE and the masking middleware', () => {
    expect(findSeamStructuralOffenders(FIXTURE_ELEMENT_BETWEEN, 'fixture')).toEqual([
      'fixture | spread-before-masking | ...MIDDLEWARE must come immediately before createMaskingMiddleware(mask)',
    ])
  })

  it("rejects a held-out fixture whose masking middleware is not given createModel's mask", () => {
    expect(findSeamStructuralOffenders(FIXTURE_FOREIGN_MASK, 'fixture')).toEqual([
      `${MASKING_LAST} createMaskingMiddleware((text) => text)`,
    ])
  })
})
