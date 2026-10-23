// The capability catalog's freshness and loader legs (Phase 398 plan 01 — XPLN-01, D-03).
//
// These legs JOIN the 397 conformance suite rather than standing beside it: they run in the same
// directory, under the same CI job, on every PR, and the regen script's refuse-while-red gate reads
// the whole directory's result. One suite, one denominator (397 D-10).
//
// WHAT THE FRESHNESS LEG IS. The committed artifact is a photograph of the live seams. The leg
// re-takes the photograph in memory and compares — and when they disagree it names WHICH ROW and
// WHICH FIELD, because "the catalog is stale" is not something a person can act on and
// "runs.digest.description moved" is.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FunctionDeclaration } from '@vostride/agent-qa-agent'
import { CHAT_RESOLVER_TABLE } from '@vostride/agent-qa-agent'
import { AGENT_QA_TOOL_PROJECTIONS, UNPROJECTED_OPS } from '@vostride/agent-qa-mcp'
import {
  CapabilityCatalogSchema,
  catalogRowKey,
  committedFileText,
  type CapabilityCatalog,
  type CatalogAliasRow,
  type CatalogOpRow,
  type CatalogSkillRow,
} from '@vostride/agent-qa-schema'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  CapabilityCatalogUnavailableError,
  CATALOG_REGEN_SCRIPT,
  loadCapabilityCatalog,
} from '../../capability-catalog/loader.js'
import {
  agentQaRoot,
  CATALOG_DOC_PATHS,
  CATALOG_NOTE,
  CATALOG_PATH,
  CATALOG_REGEN_INSTRUCTION,
  CHAT_ALIAS_PROBES,
  capabilityCatalogFromRoot,
  capabilityCatalogText,
  catalogEmitRequested,
  catalogFindings,
  emitCatalogText,
  shippedSkillDirectoryNames,
} from './catalog.js'
import { GOLDEN_PATH, withGoldenRootDeclarations } from './golden.js'
import { unprojectedReasonKeyOf } from './scenario-table.js'

/** This directory, so the source sweep below reads the files it names. */
const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))
const PUBLISHED_DOCS_ROOT = 'https://vostride.com/docs/agent-qa/'

describe('the capability catalog', () => {
  let live: CapabilityCatalog

  beforeAll(async () => {
    live = await capabilityCatalogFromRoot()
    // The PRINT the regen script lifts out. It happens here, once, off the same value the leg below
    // compares with — so the script cannot be handed a catalog the suite did not just measure.
    if (catalogEmitRequested()) emitCatalogText(capabilityCatalogText(live))
  })

  it('regenerates byte-identically from the live seams into the committed artifact (D-03)', () => {
    const committed = loadCapabilityCatalog(CATALOG_PATH)

    const findings = catalogFindings(live.rows, committed.rows)
    const named = findings.map((finding) => `${finding.kind}:${finding.key}.${finding.field}`)
    expect(
      named,
      `the committed capability catalog disagrees with the live tree:\n`
      + findings.map((finding) => `  - ${finding.message}`).join('\n'),
    ).toEqual([])

    // …and then the whole document, so the note, the count and the digest are pinned too. The
    // findings above are what a person READS; this is what makes the artifact byte-exact.
    expect(committed.$note, 'the committed note is not the produced one').toEqual([...CATALOG_NOTE])
    expect(committed.rowCount, 'the committed row count disagrees with its own rows')
      .toBe(committed.rows.length)
    expect(committed.rowsDigest, 'the committed digest disagrees with the live rows')
      .toBe(live.rowsDigest)
    expect(committedFileText(committed), 'the committed catalog is not canonically serialized')
      .toBe(capabilityCatalogText(live))
  })

  it('carries every capability the composition root declares, and nothing it does not', () => {
    // The vacuity floor, in the suite rather than only in the script: a freshness leg that agreed
    // because both sides were empty is the CI-shaped version of the failure the artifact prevents.
    const opRows = live.rows.filter((row) => row.kind === 'op')
    const aliasRows = live.rows.filter((row) => row.kind === 'alias')
    const skillRows = live.rows.filter((row) => row.kind === 'skill')
    expect(opRows.length, 'the catalog produced no op rows').toBeGreaterThan(0)
    expect(aliasRows.length, 'the catalog produced no alias rows').toBeGreaterThan(0)
    expect(skillRows.length, 'the catalog produced no skill rows').toBeGreaterThan(0)
    expect(live.rowCount, 'the catalog\'s own count sentence disagrees with its rows')
      .toBe(live.rows.length)
  })

  it('parses through the published contract, so no consumer has to defend against its shape', () => {
    const parsed = CapabilityCatalogSchema.safeParse(
      JSON.parse(capabilityCatalogText(live)) as unknown,
    )
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')))
      .toEqual([])
  })
})

describe('the capability catalog loader', () => {
  it('fails loud on a missing artifact, naming the regen script (edge XPLN-01/empty)', () => {
    const absent = join(tmpdir(), 'agent-qa-398-no-such-catalog', 'capability-catalog.json')
    let thrown: unknown
    try {
      loadCapabilityCatalog(absent)
    } catch (error) {
      thrown = error
    }
    // A silently empty catalog would present a broken install as a product that knows nothing —
    // which is exactly what `explain`'s abstention arm looks like when it is working correctly.
    expect(thrown, 'a missing catalog loaded without complaint').toBeInstanceOf(
      CapabilityCatalogUnavailableError,
    )
    expect((thrown as Error).message).toContain(CATALOG_REGEN_SCRIPT)
    expect((thrown as Error).message).toContain(CATALOG_REGEN_INSTRUCTION)
  })

  it('fails loud on an unparseable artifact rather than reading past the damage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-398-torn-'))
    try {
      const path = join(dir, 'capability-catalog.json')
      writeFileSync(path, '{ "rows": [', 'utf8')
      expect(() => loadCapabilityCatalog(path)).toThrow(CapabilityCatalogUnavailableError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is never written from the suite: the only writer is the regen script (D-01)', () => {
    // THE PROHIBITION, AS SOURCE — the golden's own cell next door, applied to this artifact. The
    // sweep ranges every `.ts` file in this directory INCLUDING ONE ADDED TOMORROW, because "the
    // catalog must not be one keystroke from silently blessed" is a claim about what this directory
    // CAN do, not about what it happens to do today.
    const files = readdirSync(CONFORMANCE_DIR).filter((name) => name.endsWith('.ts'))
    expect(files.length, 'the conformance directory read back empty').toBeGreaterThan(4)

    // ASSEMBLED FROM FRAGMENTS, on the ledger sweep's precedent and for its reason: the sweep reads
    // its own file, so a forbidden token written out here is the sweep finding its own prohibition.
    const forbidden: readonly string[] = [
      ['writeFileSync(', 'CATALOG_PATH'].join(''),
      ['writeFile(', 'CATALOG_PATH'].join(''),
      ['appendFileSync(', 'CATALOG_PATH'].join(''),
    ]
    for (const file of files) {
      const code = readFileSync(join(CONFORMANCE_DIR, file), 'utf8')
      for (const token of forbidden) {
        expect(code, `${file} carries a path that could bless the catalog: ${token}`)
          .not.toContain(token)
      }
    }
    // …and the sweep is not vacuous: a fragment assembled wrong would leave it quietly searching
    // for a string that cannot occur.
    for (const token of forbidden) {
      expect(`prefix ${token} suffix`, `the sweep no longer recognises ${token}`).toContain(token)
    }
  })

  it('loads a PRODUCED zero-row catalog as a valid zero-row catalog (edge XPLN-01/empty)', () => {
    // PRODUCED, NOT LITERAL: the fixture goes out through the same canonical serializer the
    // committed artifact does and comes back through the same parser, so it is a document the
    // producer could actually emit. A hand-typed `{"rows":[]}` would prove only that the parser
    // accepts something nobody can generate.
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-398-empty-'))
    try {
      const path = join(dir, 'capability-catalog.json')
      const empty: CapabilityCatalog = {
        $note: [...CATALOG_NOTE],
        rowCount: 0,
        rowsDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        rows: [],
        // The migration section takes the same zero arm. A catalog produced from an empty tree
        // describes no capabilities and rewrites no history; the edge this cell pins is that BOTH
        // empty sections load as themselves rather than as a broken artifact (398-08).
        migrationMap: [],
        migrationCount: 0,
      }
      writeFileSync(path, committedFileText(empty), 'utf8')

      const loaded = loadCapabilityCatalog(path)
      expect(loaded.rows, 'a produced zero-row catalog did not load as zero rows').toEqual([])
      expect(loaded.rowCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- The censuses (D-01 / D-05 / D-06 / D-07) ----------------------------------------------------
//
// THE LAW, RESTATED FOR THIS ARTIFACT. `scenario-table.ts` states it once for the registry: two
// enumerations of one universe are asserted set-equal in BOTH directions, so a member that lands on
// either side alone is a named RED on every PR. Every cell below is that law applied to a different
// pair — the catalog against the golden, the alias rows against the shipped resolver table, the
// skill rows against the skills directory, the doc table against the registry.
//
// ONE-DIRECTION EQUALITY IS THE FAILURE THIS PREVENTS. A cell asserting only that every catalog row
// has a golden row would stay green through a capability that shipped without a catalog entry —
// which is precisely the drift D-01 exists to make impossible.

describe('the capability catalog census', () => {
  let catalog: CapabilityCatalog
  let declarations: readonly FunctionDeclaration[]

  beforeAll(async () => {
    catalog = await capabilityCatalogFromRoot()
    declarations = await withGoldenRootDeclarations((rows) => rows)
  })

  const opRows = (): readonly CatalogOpRow[] =>
    catalog.rows.filter((row): row is CatalogOpRow => row.kind === 'op')
  const aliasRows = (): readonly CatalogAliasRow[] =>
    catalog.rows.filter((row): row is CatalogAliasRow => row.kind === 'alias')
  const skillRows = (): readonly CatalogSkillRow[] =>
    catalog.rows.filter((row): row is CatalogSkillRow => row.kind === 'skill')
  const sorted = (values: readonly string[]): readonly string[] => [...values].sort()

  it('carries exactly the capabilities the committed golden ledger records (D-01)', () => {
    // Against the COMMITTED golden, not a freshly minted one: the claim is that the two committed
    // projections cannot drift, and comparing two live mints would compare the tree to itself.
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { rows: { id: string }[] }
    const goldenIds = sorted(golden.rows.map((row) => row.id))
    const catalogIds = sorted(opRows().map((row) => row.id))

    const missing = goldenIds.filter((id) => !catalogIds.includes(id))
    const stray = catalogIds.filter((id) => !goldenIds.includes(id))
    expect(missing, 'the golden records capabilities the catalog has no row for').toEqual([])
    expect(stray, 'the catalog carries op rows the golden ledger does not record').toEqual([])
    expect(catalogIds, 'the catalog and the golden disagree about the capability set')
      .toEqual(goldenIds)
  })

  it('joins every alias to a live registry op, and every op-alias to a row (D-05)', () => {
    const registryIds = sorted(declarations.map((declaration) => declaration.id))

    // Direction 1: no alias points at a capability that does not exist. An alias naming a
    // non-registry target is a door onto nothing, and the catalog would quote it as a command.
    const danglingTargets = aliasRows()
      .filter((row) => !registryIds.includes(row.targetOpId))
      .map((row) => `${row.alias} -> ${row.targetOpId}`)
    expect(danglingTargets, 'alias rows naming capabilities the registry does not declare')
      .toEqual([])

    // Direction 2: every op-alias the shipped table carries has exactly one row. The op-alias set
    // is derived by running the shipped rules over the probe clauses — the SAME producer path the
    // rows came from, so what is compared is coverage, not a second opinion about the table.
    const shippedOpAliases: string[] = []
    for (const rule of CHAT_RESOLVER_TABLE) {
      const probe = CHAT_ALIAS_PROBES.find((candidate) => candidate.alias === rule.alias)
      if (probe?.expects !== 'op') continue
      shippedOpAliases.push(rule.alias)
    }
    expect(sorted(aliasRows().map((row) => row.alias)), 'the alias rows are not the op-alias set')
      .toEqual(sorted(shippedOpAliases))

    // …and exactly one row per alias, so a duplicated row cannot hide inside a set comparison.
    expect(aliasRows().length, 'an alias is carried more than once').toBe(shippedOpAliases.length)
  })

  it('carries exactly the skills the shipped skills directory holds (D-05)', () => {
    const directories = sorted(shippedSkillDirectoryNames())
    expect(directories.length, 'the skills directory read back empty').toBeGreaterThan(0)
    expect(sorted(skillRows().map((row) => row.name)), 'the skill rows and the skills directory '
      + 'disagree — a skill row name comes from SKILL.md frontmatter and the directory is the other '
      + 'half of that identity').toEqual(directories)
  })

  it('produces every surface claim from the shipped mapping, never from a written list (D-06)', () => {
    const projectedTools = new Map<string, string>()
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const opId of projection.ops) projectedTools.set(opId, projection.name)
    }

    const disagreements: string[] = []
    for (const row of opRows()) {
      const tool = projectedTools.get(row.id)
      const unprojected = UNPROJECTED_OPS.find((entry) => entry.opId === row.id)

      // Exactly one of the two arms, per row. Both present would be a row claiming a door and a
      // dated decision not to have one; neither would be the blank D-06 replaces with a reason.
      const arms = [row.mcpTool, row.mcpUnprojectedReasonKey].filter((value) => value !== undefined)
      if (arms.length !== 1) {
        disagreements.push(`${row.id}: ${arms.length} mcp arms present, expected exactly 1`)
      }

      if (tool !== undefined) {
        if (row.mcpTool !== tool) {
          disagreements.push(`${row.id}: mapping projects it as ${tool}, the row says ${row.mcpTool}`)
        }
        if (!row.surfaces.includes('mcp')) {
          disagreements.push(`${row.id}: mapping projects it, the row omits the mcp surface`)
        }
      } else {
        if (row.surfaces.includes('mcp')) {
          disagreements.push(`${row.id}: the row claims the mcp surface, the mapping projects no tool`)
        }
        const expectedKey = unprojected === undefined
          ? 'uncatalogued'
          : unprojectedReasonKeyOf(unprojected.reason) ?? 'uncatalogued'
        if (row.mcpUnprojectedReasonKey !== expectedKey) {
          disagreements.push(
            `${row.id}: the shipped reason classifies as ${expectedKey}, the row says `
            + `${row.mcpUnprojectedReasonKey}`,
          )
        }
      }

      // Every op is reachable in chat 1:1 (392 D-07/D-08), so the chat surface is on every row.
      if (!row.surfaces.includes('chat')) {
        disagreements.push(`${row.id}: the row omits the chat surface`)
      }
    }
    expect(disagreements, 'op rows disagree with the shipped mapping').toEqual([])
  })

  it('adjudicates a doc for every registry capability, and for no other (D-07)', () => {
    const registryIds = sorted(declarations.map((declaration) => declaration.id))
    const adjudicated = sorted(CATALOG_DOC_PATHS.map(([id]) => id))

    const unadjudicated = registryIds.filter((id) => !adjudicated.includes(id))
    const stray = adjudicated.filter((id) => !registryIds.includes(id))
    expect(unadjudicated, 'capabilities with no doc adjudication — a new op must declare either a '
      + 'repo-relative path or a dated reason there is none').toEqual([])
    expect(stray, 'CATALOG_DOC_PATHS adjudicates capabilities the registry does not declare')
      .toEqual([])
    expect(adjudicated.length, 'CATALOG_DOC_PATHS carries a duplicate key')
      .toBe(new Set(adjudicated).size)
  })

  it('links only into repository files that exist, at headings that exist, or into the published docs (D-07)', () => {
    const root = agentQaRoot()
    const broken: string[] = []
    let filesChecked = 0
    let publishedChecked = 0

    const checkDoc = (label: string, docPath: string, anchor: string | undefined): void => {
      if (docPath.startsWith('https://')) {
        // Published pages live on vostride.com. No file here can confirm a heading on them, so a
        // published link carries none, and it may not leave the agent-qa docs.
        if (!docPath.startsWith(PUBLISHED_DOCS_ROOT)) broken.push(`${label}: ${docPath} is not under ${PUBLISHED_DOCS_ROOT}`)
        if (anchor !== undefined) broken.push(`${label}: ${docPath} carries an anchor no file here can confirm`)
        publishedChecked += 1
        return
      }
      const absolute = join(root, docPath)
      if (!existsSync(absolute)) {
        broken.push(`${label}: ${docPath} does not exist`)
        return
      }
      filesChecked += 1
      if (anchor === undefined) return
      const body = readFileSync(absolute, 'utf8')
      // A real markdown heading, not a substring: a page that merely MENTIONS the phrase is not a
      // page a deep link lands on.
      const heading = new RegExp(`^#{1,6}\\s+\\*{0,2}${anchor.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\*{0,2}\\s*$`, 'imu')
      if (!heading.test(body)) broken.push(`${label}: ${docPath} carries no heading "${anchor}"`)
    }

    for (const row of catalog.rows) {
      const label = `${row.kind}:${catalogRowKey(row)}`
      if (row.kind === 'skill') {
        checkDoc(label, row.docPath, undefined)
        continue
      }
      if (row.docPath === null) {
        // The explicit-absent arm is only honest if it says WHY. A null with no reason is the
        // blank D-07 refuses.
        if ((row.docAbsentReason ?? '').trim() === '') {
          broken.push(`${label}: carries a null docPath with no reason`)
        }
        if (row.docAnchor !== undefined) {
          broken.push(`${label}: carries an anchor into a doc it says does not exist`)
        }
        continue
      }
      if (row.docAbsentReason !== undefined) {
        broken.push(`${label}: carries both a doc path and an absent-reason`)
      }
      checkDoc(label, row.docPath, row.docAnchor)
    }

    expect(broken, 'the catalog deep-links into docs that are not there').toEqual([])
    // …and the cell is not vacuous: a catalog whose every row took the absent arm would pass the
    // loop above without opening a single file.
    expect(filesChecked, 'no doc path was checked — the existence cell measured nothing')
      .toBeGreaterThan(0)
    expect(publishedChecked, 'no published doc link was checked — the published half measured nothing')
      .toBeGreaterThan(0)
  })
})
