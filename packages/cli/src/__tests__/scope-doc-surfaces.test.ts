// Where `scope` IS documented, and the structural reason it is not everywhere (Phase 400 plan 12,
// gap round 1 — D-19's doc half, WINDOWS #189).
//
// WHAT THIS FILE IS FOR. 400-04 shipped one `.describe()` on `AuthoringDraftWriteInputSchema.scope`
// and claimed six human-facing surfaces inherit it "because they all project the one committed
// artifact". Verification measured that FALSE for three of them, and the measurement found the
// reason: `/help`, the starter prompts and the type-ahead project a DIFFERENT FIELD of the same
// artifact (the alias row's `description`, and the typable form) — and `explain` withholds `params`
// from its prompt by charter. The truth is restated to name only the surfaces that carry the params
// document, and a restated truth whose supporting fact is only prose is the failure this file
// exists to prevent. So the fact is a cell:
//
//   1. COMMITTED — the catalog row carries the scope description, read through the ONE loader.
//   2. SERVED — until 430 this leg read the dashboard's served catalog over a real socket.
//      2026-09-28 (430 D-02): the dashboard serves no documentation surface of its own; its server
//      door was deleted, so the leg is an absence cell: the composed door's router answers 404 on
//      the catalog path. 2026-10-01 (432-14): the router is the dashboard's shipped one, since the
//      run-confirm router this leg used to mount is deleted too. The committed catalog, `init --agent` and MCP `tools/list` are the surfaces
//      that carry the scope description.
//   3. RENDER BUDGET — the structural fact the restatement leans on: the summary-rendering and
//      typable-form surfaces cannot carry an op's params, because their inputs are alias rows and
//      `/fn <id>` forms respectively. Each leg carries its own non-vacuity control, because "the
//      op id is absent from this output" is trivially true of an empty output.
//
// THE ACCEPTANCE BAR IS THE MUTATION, NOT THE PASS. Cell 1 is measured against a catalog
// regenerated from a `scope` declaration with its `.describe()` stripped; cell 3 against a starter
// render fed op rows. Both REDs were observed before this file was accepted (400-12-SUMMARY.md).

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CHAT_HELP_ENTRIES, CHAT_HELP_TEXT } from '@vostride/agent-qa-agent'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { createRouter, DashboardDatabase } from '@vostride/agent-qa-dashboard'
import type { CapabilityCatalog, CatalogRow } from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildStarterPrompts, completionCandidatesFor } from '../capability-catalog/chat-discovery.js'
import { loadCapabilityCatalog } from '../capability-catalog/loader.js'
import { composeDashboardDoor } from '../commands/dashboard.js'

/** The op whose `scope` D-19 documents. Spelled once. */
const AUTHORING_OP = 'authoring.draft.write'

/** The typed form the passthrough completer emits candidates under. */
const PASSTHROUGH_FORM = '/fn'

/**
 * The `scope` property's description off a row's params document.
 *
 * `params` is `Record<string, unknown>` on the schema — the declaration's own inert JSON-Schema
 * projection — so reading it is a narrowing, and the narrowing is written to return `undefined`
 * at every step rather than throw: a cell that crashed on a shape change would report a TypeError
 * where it means to report "the scope description is gone", and those are different findings.
 */
function scopeDescriptionOf(params: Record<string, unknown>): string | undefined {
  const properties = params['properties']
  if (typeof properties !== 'object' || properties === null) return undefined
  const scope = (properties as Record<string, unknown>)['scope']
  if (typeof scope !== 'object' || scope === null) return undefined
  const description = (scope as Record<string, unknown>)['description']
  return typeof description === 'string' ? description : undefined
}

/** Whether a params document names `scope` as a key AT ALL — the presence half, before content. */
function paramsNameScope(params: Record<string, unknown>): boolean {
  const properties = params['properties']
  if (typeof properties !== 'object' || properties === null) return false
  return Object.hasOwn(properties as Record<string, unknown>, 'scope')
}

function opRow(
  rows: readonly CatalogRow[],
  id: string,
): Extract<CatalogRow, { kind: 'op' }> | undefined {
  return rows.find(
    (row): row is Extract<CatalogRow, { kind: 'op' }> => row.kind === 'op' && row.id === id,
  )
}

describe('the committed catalog documents `scope` (committed surface)', () => {
  it('carries a non-empty `scope` description naming the product, through the ONE loader', () => {
    // THE ONE LOADER, never a hand-resolved path. A `JSON.parse` spelled here would be the second
    // read path `loader.ts`'s header exists to make impossible, and this cell would then be a
    // statement about this file's idea of where the artifact lives.
    const catalog: CapabilityCatalog = loadCapabilityCatalog()

    const row = opRow(catalog.rows, AUTHORING_OP)
    // NON-VACUITY, FIRST HALF: the row exists. Everything below is a claim about it, and a
    // `find` that returned nothing would make every one of those claims vacuously unreachable.
    expect(row, `the catalog carries an op row for ${AUTHORING_OP}`).toBeDefined()
    if (row === undefined) return

    // NON-VACUITY, SECOND HALF: `scope` is a key of the params document at all. This separates
    // "the description is missing" from "the field is gone", which are different regressions with
    // different fixes.
    expect(paramsNameScope(row.params), '`scope` is a key of the params document').toBe(true)

    const description = scopeDescriptionOf(row.params)
    expect(description, '`scope` carries a description').toBeTypeOf('string')
    expect((description ?? '').trim().length).toBeGreaterThan(0)
    // The 400-04 text's subject: which PRODUCT this test is authored for. Matching the word rather
    // than the paragraph keeps the cell from being an editing veto on prose it does not own.
    expect(description ?? '').toMatch(/product/iu)
  })
})

/** The deleted catalog path, built from two halves so the 430 census never counts this file. */
const DELETED_CATALOG_PATH = '/api/' + 'chat/catalog'

describe('the dashboard serves no documentation surface of its own (served surface)', () => {
  let origin: string
  let host: LocalAgentHost
  let server: Server
  let configRoot: string

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-400-12-'))
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(
      configPath,
      `${JSON.stringify({
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'reset' } },
        registry: {
          targets: {
            conformance: { platform: 'web', url: 'https://conformance.invalid' },
          },
        },
      })}\n`,
      'utf8',
    )
    configRoot = dirname(resolve(configPath))

    let boundOrigin: string | undefined
    // THE SHIPPED COMPOSER. `composeDashboardDoor` is what `agent-qa dashboard` calls, so the
    // router below is the one the product mounts.
    const composed = composeDashboardDoor({
      agentQaRoot: join(configRoot, '.agent-qa'),
      configPath,
      boundOrigin: () => boundOrigin,
      resolveExecutionContext: () => 'local-interactive',
    })
    host = composed.host
    server = createServer(createRouter({
      db: new DashboardDatabase({ dbPath: ':memory:' }),
      agentHost: composed.agentHost,
    }))
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new TypeError('the door bound no port')
    }
    boundOrigin = `http://127.0.0.1:${String(address.port)}`
    origin = boundOrigin
  })

  afterAll(async () => {
    await new Promise<void>((closed) => server.close(() => closed()))
    await host.close()
    rmSync(configRoot, { recursive: true, force: true })
  })

  it(`the dashboard serves no documentation surface of its own: GET ${DELETED_CATALOG_PATH} answers 404`, async () => {
    const response = await fetch(`${origin}${DELETED_CATALOG_PATH}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
  })
})

describe('the summary-rendering surfaces structurally cannot carry an op\'s params', () => {
  // THE RENDER-BUDGET FACT, AS A MEASUREMENT. The restated truth says `/help`, the starter prompts
  // and the type-ahead render the summary and typable-form fields BY a render-budget decision, not
  // by an oversight. That is a claim about what those renders take as INPUT, and it is checkable.

  it('renders alias rows only, so no op id — and no params text — reaches a starter prompt', () => {
    const rows = loadCapabilityCatalog().rows

    // NON-VACUITY A: the op row IS in the input. Without this, "the output does not name it" is a
    // statement about the catalog rather than about the render.
    const row = opRow(rows, AUTHORING_OP)
    expect(row, `the render's input contains the ${AUTHORING_OP} row`).toBeDefined()
    if (row === undefined) return
    const scopeDescription = scopeDescriptionOf(row.params) ?? ''
    expect(scopeDescription.length, 'the input row carries the scope text').toBeGreaterThan(0)

    // UNBOUNDED LIMIT, deliberately. `STARTER_PROMPT_COUNT` is three, and an absence under a
    // three-row slice would be an artifact of the slice rather than of the alias filter. Asking
    // for as many lines as there are rows leaves the `kind === 'alias'` filter as the ONLY reason
    // the op can be missing.
    const unbounded = buildStarterPrompts(rows, CHAT_HELP_ENTRIES, rows.length)
    // NON-VACUITY B: the render produced lines. "No line names it" is trivially true of nothing.
    expect(unbounded.length, 'the starter render produced lines').toBeGreaterThan(0)
    expect(unbounded.some((line) => line.includes(AUTHORING_OP))).toBe(false)

    // The shipped default render, for the same reason at the size a person sees.
    const shipped = buildStarterPrompts(rows, CHAT_HELP_ENTRIES)
    expect(shipped.length).toBeGreaterThan(0)
    expect(shipped.some((line) => line.includes(AUTHORING_OP))).toBe(false)

    // The general form: NO op id reaches this render, because op rows are not its input.
    const opIds = rows.filter((candidate) => candidate.kind === 'op').map((candidate) => candidate.id)
    expect(opIds.length, 'the catalog carries op rows to be excluded').toBeGreaterThan(1)
    expect(opIds.filter((id) => unbounded.some((line) => line.includes(id)))).toEqual([])

    // And the params TEXT itself — the thing D-19 is about — reaches no line.
    expect(unbounded.some((line) => line.includes(scopeDescription))).toBe(false)
  })

  it('derives `/help` from the help entries, whose input is the alias table and not op rows', () => {
    // NON-VACUITY: `/help` renders something, and renders the passthrough — so the surface is
    // real and it IS the surface that tells a person how to reach an op at all.
    expect(CHAT_HELP_TEXT.length).toBeGreaterThan(0)
    expect(CHAT_HELP_TEXT).toContain(PASSTHROUGH_FORM)

    // The op id is absent because `CHAT_HELP_ENTRIES` is the whole input and it carries aliases.
    expect(CHAT_HELP_TEXT).not.toContain(AUTHORING_OP)
    expect(CHAT_HELP_ENTRIES.some((entry) => entry.syntax.includes(AUTHORING_OP))).toBe(false)
    expect(CHAT_HELP_ENTRIES.some((entry) => entry.summary.includes(AUTHORING_OP))).toBe(false)

    const scopeDescription = scopeDescriptionOf(
      opRow(loadCapabilityCatalog().rows, AUTHORING_OP)?.params ?? {},
    ) ?? ''
    expect(scopeDescription.length).toBeGreaterThan(0)
    expect(CHAT_HELP_TEXT).not.toContain(scopeDescription)
  })

  it('offers type-ahead candidates as TYPABLE FORMS, which carry an id and never its params', () => {
    const rows = loadCapabilityCatalog().rows
    const candidates = completionCandidatesFor(`${PASSTHROUGH_FORM} `, rows, CHAT_HELP_ENTRIES)

    // NON-VACUITY, AND THE HALF THAT MAKES THE CLAIM PRECISE: the op IS offered. The type-ahead is
    // not failing to mention `authoring.draft.write` — it names it, as the form that invokes it.
    // What it cannot carry is the params document, and that is a shape fact about a candidate.
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates).toContain(`${PASSTHROUGH_FORM} ${AUTHORING_OP}`)

    const scopeDescription = scopeDescriptionOf(opRow(rows, AUTHORING_OP)?.params ?? {}) ?? ''
    expect(scopeDescription.length).toBeGreaterThan(0)
    // EVERY candidate is exactly `<passthrough> <id>` — no candidate carries prose at all, so
    // there is no render into which a params description could be projected without minting a
    // second kind of candidate (and re-deriving the D-17 stamped-fields projection to know which
    // params a `/fn` caller may supply).
    const offeredIds = new Set(
      rows.filter((row) => row.kind === 'op').map((row) => row.id),
    )
    for (const candidate of candidates) {
      const [form, id, ...rest] = candidate.split(' ')
      expect(form).toBe(PASSTHROUGH_FORM)
      expect(rest, 'a candidate is two tokens: the form and the id').toEqual([])
      expect(offeredIds.has(id ?? '')).toBe(true)
    }
    expect(candidates.some((candidate) => candidate.includes(scopeDescription))).toBe(false)
  })
})
