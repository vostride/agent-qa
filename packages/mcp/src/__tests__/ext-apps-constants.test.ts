// Restated Apps literals pinned against ext-apps itself: a drifted id is silently never negotiated.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { describe, expect, it } from 'vitest'

import { APP_RESOURCE_MIME_TYPE, MCP_APPS_EXTENSION_ID } from '../app-resource.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '../..')
const SRC_ROOT = resolve(PACKAGE_ROOT, 'src')
const TESTS_DIR = resolve(SRC_ROOT, '__tests__')

/** The package name, spelled ONCE — the boundary census and the manifest cells both key on it. */
const EXT_APPS = '@modelcontextprotocol/ext-apps'

const AUDITED_VERSION = '1.7.5'

const requireFrom = createRequire(join(SRC_ROOT, 'app-resource.ts'))

/**
 * The installed package's own root, walked up from a subpath it DOES export.
 *
 * `./package.json` is not in ext-apps' `exports` map, so `require.resolve` refuses it — which is
 * the package's right and not a defect. The manifest is still the only place its version is
 * stated, so it is found by walking up from the schema document rather than by hardcoding a
 * `node_modules/.pnpm/...` path that changes with every peer resolution.
 */
function installedPackageRoot(): string {
  let dir = dirname(requireFrom.resolve(`${EXT_APPS}/schema.json`))
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { readonly name?: string }
      if (parsed.name === EXT_APPS) return dir
    } catch {
      // not this level — keep walking
    }
    dir = dirname(dir)
  }
  throw new Error(`could not find the installed ${EXT_APPS} manifest above its schema.json`)
}

/**
 * Every place a module SPECIFIER for ext-apps appears — an import, a dynamic import, or a require.
 *
 * Deliberately NOT a substring search for the package name: the production modules mention
 * `ext-apps` in PROSE, on purpose, to record why the boundary exists (`app-resource.ts` explains
 * the v1 peer, `app-wrapper.ts` explains why the handshake is hand-rolled). A census that counted
 * those would force the explanation out of the code to stay green, which is exactly backwards —
 * the comment is the thing keeping the next person from adding the import.
 */
function extAppsSpecifiers(source: string): readonly string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(@modelcontextprotocol\/ext-apps(?:\/[^'"]*)?)\1/gu
  return [...source.matchAll(pattern)].map((match) => match[2] as string)
}

interface ExtAppsSchema {
  readonly $id: string
  readonly $defs: Record<string, unknown>
}

/** The OFFICIAL schema document, read off the installed package rather than restated. */
const officialSchema = JSON.parse(
  readFileSync(requireFrom.resolve(`${EXT_APPS}/schema.json`), 'utf8'),
) as ExtAppsSchema

const officialSchemaBytes = readFileSync(requireFrom.resolve(`${EXT_APPS}/schema.json`), 'utf8')

const manifest = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

// ---- 1. The two constants the must-have truth names ---------------------------------------------

describe('our restated Apps vocabulary equals the official one, byte for byte (A5)', () => {
  it('(1) MCP_APPS_EXTENSION_ID is ext-apps\' own EXTENSION_ID', () => {
    // Read at RUNTIME from the official module — not from a `.d.ts`, not from prose, and not from
    // a literal in this file. A reverse-DNS id that drifts by one character does not throw
    // anywhere: the server advertises an extension nobody asked for and the gate refuses every
    // caller, which reads exactly like "no host supports Apps yet".
    expect(MCP_APPS_EXTENSION_ID).toBe(EXTENSION_ID)
    // And the value is not vacuously equal because both are empty.
    expect(EXTENSION_ID.length).toBeGreaterThan(0)
  })

  it('(2) APP_RESOURCE_MIME_TYPE is ext-apps\' own RESOURCE_MIME_TYPE', () => {
    expect(APP_RESOURCE_MIME_TYPE).toBe(RESOURCE_MIME_TYPE)
    expect(RESOURCE_MIME_TYPE.length).toBeGreaterThan(0)

    // The SECOND route, kept deliberately: the mime type also appears inside the shipped schema's
    // own prose ("Must include `\"text/html;profile=mcp-app\"` for MCP Apps support"), so the
    // runtime export and the schema document have to agree with each other as well as with us.
    // If ext-apps ever ships an export and a schema that disagree, this cell says so rather than
    // silently picking one.
    expect(officialSchemaBytes).toContain(APP_RESOURCE_MIME_TYPE)
  })

  it('(3) the pin is against the AUDITED version, not whatever happens to be installed', () => {
    const installed = JSON.parse(
      readFileSync(join(installedPackageRoot(), 'package.json'), 'utf8'),
    ) as { readonly version: string }
    // The legitimacy audit (verdict OK, 3.59M weekly downloads, github.com/modelcontextprotocol/
    // ext-apps, no postinstall) was performed against 1.7.5. A census that passed against some
    // other version would be pinning our strings to a package nobody audited.
    expect(installed.version).toBe(AUDITED_VERSION)
    expect(officialSchema.$id).toBe('https://modelcontextprotocol.io/ext-apps/schema.json')
  })
})

// ---- 2. Every spec string this repository restates ----

describe('the other restated spec strings are in the official schema (A5)', () => {
  // Strings spelled here by hand, each checked against the schema and its own source file.
  const RESTATED: readonly { readonly value: string; readonly spelledIn: string }[] = [
    { value: 'ui/initialize', spelledIn: 'app-wrapper.ts' },
    { value: 'protocolVersion', spelledIn: 'app-wrapper.ts' },
    { value: 'frameDomains', spelledIn: 'app-resource.ts' },
    { value: 'connectDomains', spelledIn: 'app-resource.ts' },
    { value: 'resourceUri', spelledIn: 'projection.ts' },
  ]

  for (const { value, spelledIn } of RESTATED) {
    it(`(4) \`${value}\` is spelled the same in ${spelledIn} and in the official schema`, () => {
      expect(
        officialSchemaBytes.includes(`"${value}"`),
        `${value} is spelled by hand in ${spelledIn}; the official ext-apps schema no longer names `
        + 'it, so either the spec renamed it or this repository invented it',
      ).toBe(true)
      expect(
        readFileSync(join(SRC_ROOT, spelledIn), 'utf8').includes(value),
        `${spelledIn} no longer spells ${value} — this row is stale and the census is measuring `
        + 'a string nobody uses',
      ).toBe(true)
    })
  }

  it('(4b) the census is non-vacuous — a string the spec does NOT name is reported as absent', () => {
    // Without this, a schema that failed to load (or an `includes` over an empty string) would
    // make every cell above pass by matching nothing.
    expect(officialSchemaBytes.includes('"frameDomainsButMisspelled"')).toBe(false)
    expect(officialSchemaBytes.length).toBeGreaterThan(1_000)
  })

  it('(4c) the csp field names are the ones the schema declares, enumerated FROM the schema', () => {
    const csp = officialSchema.$defs.McpUiResourceCsp as {
      readonly properties: Record<string, unknown>
    }
    // Enumerated from the schema's csp record: every field this repository emits must be in it.
    expect(Object.keys(csp.properties)).toContain('frameDomains')
    expect(Object.keys(csp.properties)).toContain('connectDomains')
  })

  it('(4d) the wrapper\'s ui/initialize carries every param the official schema REQUIRES', () => {
    // Reads the schema's `required` array rather than restating it as a third copy that can drift.
    const request = officialSchema.$defs.McpUiInitializeRequest as {
      readonly properties: { readonly params: { readonly required: readonly string[] } }
    }
    const required = request.properties.params.required
    expect(required.length, 'the schema really declares required params').toBeGreaterThan(0)

    const wrapper = readFileSync(join(SRC_ROOT, 'app-wrapper.ts'), 'utf8')
    // Scoped to the handshake's own `postMessage` call, so a comment elsewhere cannot satisfy it.
    const start = wrapper.indexOf("method: 'ui/initialize'")
    expect(start, 'the wrapper still posts a ui/initialize request').toBeGreaterThan(-1)
    const end = wrapper.indexOf("}, '*');", start)
    expect(
      end,
      'the ui/initialize handshake is no longer a single postMessage call — this is a finding about '
      + 'the served document, not about this test: the census can no longer say which bytes are the '
      + 'handshake, so re-derive the bound from whatever structure now carries it',
    ).toBeGreaterThan(start)
    const block = wrapper.slice(start, end)

    const missing = required.filter((param) => !block.includes(`${param}:`))
    expect(
      missing,
      'the official ext-apps schema requires these ui/initialize params; the wrapper\'s handshake '
      + 'block names none of them, so a conformant host would reject the request',
    ).toEqual([])
  })
})

// ---- 3. The production boundary: ext-apps is dev-only, as a source census ----

/** Every `.ts` under `src`, excluding `__tests__` — the production surface of this package. */
function productionSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (path === TESTS_DIR) continue
      found.push(...productionSources(path))
      continue
    }
    if (path.endsWith('.ts')) found.push(path)
  }
  return found
}

describe('ext-apps never crosses into production', () => {
  it('(5) no file under src/ outside __tests__ IMPORTS the ext-apps package', () => {
    const sources = productionSources(SRC_ROOT)
    // The positive control FIRST: a census over an empty file list is a census that proves nothing,
    // and this package has real modules.
    expect(sources.length, 'the census walked the package and found production modules').toBeGreaterThan(5)

    const offenders = sources
      .map((path) => ({ path, specifiers: extAppsSpecifiers(readFileSync(path, 'utf8')) }))
      .filter((row) => row.specifiers.length > 0)

    expect(
      offenders.map((row) => `${row.path.slice(PACKAGE_ROOT.length + 1)}: ${row.specifiers.join(', ')}`),
      `${EXT_APPS} peer-depends on the v1 monolith SDK while this package ships on the 2.0.0 split `
      + 'SDK — a production import would put two SDK generations in one bundle. It is a dev/test '
      + 'dependency and nothing else.',
    ).toEqual([])
  })

  it('(5b) the census REACHES the files it claims are clean, and its detector really detects', () => {
    // Non-vacuity for cell (5), both halves. First the walk: it must actually visit the two App
    // modules, so a walk that silently returned nothing (a renamed directory, a changed rootDir)
    // cannot pass as "clean".
    const sources = productionSources(SRC_ROOT).map((path) => path.slice(SRC_ROOT.length + 1))
    expect(sources).toContain('app-resource.ts')
    expect(sources).toContain('app-wrapper.ts')

    // Then the detector: THIS file really does import ext-apps, and the same predicate that
    // reported zero above reports it here. Without this, a regex that matched nothing at all would
    // make cell (5) green forever.
    const thisFile = readFileSync(join(TESTS_DIR, 'ext-apps-constants.test.ts'), 'utf8')
    expect(extAppsSpecifiers(thisFile)).toContain(`${EXT_APPS}/server`)
  })

  it('(6) the manifest keeps it in devDependencies and out of dependencies', () => {
    expect(manifest.devDependencies?.[EXT_APPS]).toBe(AUDITED_VERSION)
    expect(manifest.dependencies?.[EXT_APPS]).toBeUndefined()
  })
})
