// Ranges the census and renders documents produced from each op's own contract, in process.

import { stripVTControlCharacters } from 'node:util'

import { maskedToolResult } from '@vostride/agent-qa-mcp'
import { describe, expect, it } from 'vitest'

import { renderFnResult } from '../../commands/fn.js'
import { renderClauseResults } from '../../commands/result-render.js'
import { registryDeclarations, registryOpIds } from './adapters.js'
import { SCENARIO_TABLE, censusDiff, scenarioTableOpIds } from './scenario-table.js'
import { driveChatLines } from './surface-dispatch.js'
import type { ScenarioRow } from './scenario-table.js'

// ---- Producing one result document per capability, from that capability's own contract ---------

/** An inert JSON-Schema projection, as the registry publishes it. */
type SchemaDocument = Readonly<Record<string, unknown>>

/**
 * The arm a union answers with, chosen by ONE declared rule: the first.
 *
 * DETERMINISTIC RATHER THAN REPRESENTATIVE, and the difference matters for what this leg claims. A
 * rule that picked "the interesting arm" would be this file deciding which of an op's outcomes is
 * worth rendering, which is the curation the whole phase is about; first-arm is a rule, it is stable
 * across runs at one HEAD (the projection is committed source), and it makes the cell names below
 * derivable rather than chosen. The arms a union does NOT take here are not unmeasured: the three
 * spawned anchors and the credential differential in `render-anchors.test.ts` drive real refusal and
 * success arms of a real op through the real binary.
 */
function firstDeclaredArm(schema: SchemaDocument): SchemaDocument {
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arms = schema[key]
    if (Array.isArray(arms) && arms.length > 0) return arms[0] as SchemaDocument
  }
  return schema
}

/**
 * One result document, instantiated from a contract projection.
 *
 * TOTAL OVER THE VOCABULARY THE PROJECTIONS ACTUALLY USE, and `undefined` for anything else — which
 * is a named RED in the census cell below rather than a silent hole. The 42 shipped projections are
 * JSON Schema 2020-12 with no `$ref` and no `$defs`; they are objects with `properties`/`required`,
 * arrays with `items`, unions of those, and the scalars. A branch for a keyword none of them uses
 * would be a branch nobody has watched run.
 *
 * REQUIRED PROPERTIES ONLY, where a `required` list exists. The claim this leg makes is about the
 * fields an op's contract says it ALWAYS returns; an optional field absent from a document is absent
 * from the render for a reason that is not a defect, and asserting on one would make the leg red on
 * honest behaviour.
 *
 * STRING PLACEHOLDERS CARRY NO FIELD NAME, and that is load-bearing rather than tidy. A placeholder
 * spelling its own property path would put every marker into the document TWICE — once as a key and
 * once inside a value — and a render that printed values while dropping keys would then pass every
 * cell here. The mint is a counter, so the document is deterministic and its bytes name nothing.
 */
function produceResult(schema: SchemaDocument, mint: () => string): unknown {
  const arm = firstDeclaredArm(schema)
  if ('const' in arm) return arm['const']
  const enumerated = arm['enum']
  if (Array.isArray(enumerated) && enumerated.length > 0) return enumerated[0]

  const type = arm['type']
  if (type === 'object' || (type === undefined && arm['properties'] !== undefined)) {
    const properties = (arm['properties'] ?? {}) as SchemaDocument
    const required = Array.isArray(arm['required'])
      ? (arm['required'] as readonly string[])
      : Object.keys(properties)
    const document: Record<string, unknown> = {}
    for (const name of required) {
      const child = properties[name]
      if (child === undefined) continue
      document[name] = produceResult(child as SchemaDocument, mint)
    }
    return document
  }
  // One element, which is what `minItems: 1` needs and what a render of an EMPTY array could not be
  // asked anything about: `[]` carries no field to withhold.
  if (type === 'array') return [produceResult((arm['items'] ?? {}) as SchemaDocument, mint)]
  if (type === 'string') return mint()
  if (type === 'integer' || type === 'number') {
    return typeof arm['minimum'] === 'number' ? arm['minimum'] : 1
  }
  if (type === 'boolean') return true
  if (type === 'null') return null
  return undefined
}

/** Every op's output projection, read off the shipped declarations — never listed here. */
const OUTPUT_PROJECTIONS: ReadonlyMap<string, SchemaDocument> = new Map(
  registryDeclarations().map((declaration) => [declaration.id, declaration.output]),
)

/**
 * The one produced document per op, minted once so every cell renders the same bytes.
 *
 * Memoised rather than re-derived per door: three doors disagreeing about a payload would make a
 * disagreement between their renders unattributable to the render.
 */
const producedResults = new Map<string, unknown>()
function producedResultFor(opId: string): unknown {
  if (producedResults.has(opId)) return producedResults.get(opId)
  const projection = OUTPUT_PROJECTIONS.get(opId)
  let count = 0
  const produced =
    projection === undefined
      ? undefined
      : produceResult(projection, () => `conformance-render-${(count += 1)}`)
  producedResults.set(opId, produced)
  return produced
}

/** The document as a person would read it — the bytes any marker has to survive to. */
function serialized(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? ''
}

// A field is present when its quoted key and colon are: a bare `ts` matches inside `runs.events`.
function fieldToken(marker: string): string {
  return `${JSON.stringify(marker)}:`
}

/**
 * Every string VALUE the produced document carries, as its own claim on the render.
 *
 * KEYS AND VALUES ARE TWO WAYS TO WITHHOLD, and a leg asserting only one of them can be satisfied by
 * a render that does the other. `produceResult` mints its string leaves from a counter, so they are
 * unique, opaque, and — being nowhere in any op id — absent from the drop-site line by construction.
 * The set is DERIVED from the document rather than carried on the row: a row-carried copy of what
 * the producer minted would be a second spelling of the same fact, free to fall behind it.
 */
function mintedLeaves(document: string): readonly string[] {
  return [...new Set(document.match(/conformance-render-\d+/gu) ?? [])].sort()
}

// ---- The doors -----------------------------------------------------------------------------

/**
 * What this phase repaired, kept here as the thing every cell must RED on.
 *
 * THE LITERAL PRE-399.1 BEHAVIOUR. `summariseOutcome` answered `<op> completed` and the turn had no
 * member that could carry a payload, so this string WAS the render for forty of forty-two
 * capabilities. Keeping it is what makes each cell's expectation discriminating rather than merely
 * satisfied: a marker this line already contains is a marker the blind build would have passed.
 */
function droppedRender(opId: string): string {
  return `${opId} completed`
}

/** One door, as this leg drives its render. */
interface RenderDoor {
  readonly id: string
  /** Whether this row has a door here at all — a declared-unprojected op has none over MCP. */
  covers(row: ScenarioRow): boolean
  /** The human-visible bytes this door produces for one op's result. */
  render(opId: string, payload: unknown): string
}

/**
 * The three rostered doors, in `SURFACE_ROSTER`'s own order.
 *
 * THE RENDERS ARE IMPORTED, NEVER RE-SPELLED. Each entry below calls the exact function the shipped
 * surface calls: a second `JSON.stringify(payload, null, 2)` written here would be a second render
 * of a door, free to disagree with the one a person meets, with the measured one green — which is
 * the RC-2 shape (a re-derived spelling of a rule that already existed) this phase repaired.
 */
const RENDER_DOORS: readonly RenderDoor[] = Object.freeze([
  Object.freeze({
    id: 'chat',
    covers: () => true,
    // What `chat.ts` and `ask.ts` print through; a single-clause result is the unlabelled shape.
    render: (opId: string, payload: unknown) =>
      renderClauseResults([{ functionId: opId, payload }], 1).join('\n'),
  }),
  Object.freeze({
    id: 'mcp',
    // The same skip grammar the existing legs use, and for the same reason: a declared-unprojected
    // op has no door here to render through, and asserting about one would be asserting about a
    // capability this surface has a dated decision not to carry. It is a partition, not a skip list
    // — `parity.test.ts` asserts every census op is reachable over MCP or declared unprojected,
    // exactly one, so nothing can drop out of this leg by going quiet.
    covers: (row: ScenarioRow) => 'reachable' in row.perSurface.mcp,
    // The single masking the server answers BOTH channels from; the identity masker because these
    // documents carry no secret and the question here is what is WITHHELD, not what is masked.
    render: (_opId: string, payload: unknown) => {
      const result = maskedToolResult(payload, (text: string) => text)
      const texts = (result.content ?? []).map((entry) =>
        entry.type === 'text' ? entry.text : '',
      )
      return [...texts, JSON.stringify(result.structuredContent)].join('\n')
    },
  }),
  Object.freeze({
    id: 'fn',
    covers: () => true,
    // The door taken as the honest baseline for the default render.
    render: (_opId: string, payload: unknown) => renderFnResult(payload),
  }),
] as const satisfies readonly RenderDoor[])

/**
 * Every cell this leg will raise, derived ONCE so the census assertion and the `it` names cannot
 * disagree about what was measured.
 *
 * THE ORDER IS THE TABLE'S, WHICH IS THE OP ID'S. `SCENARIO_TABLE` is sorted by op id as its own
 * committed convention and a cell below asserts that it still is; the doors are iterated in the
 * roster's registration order. Two runs at one HEAD therefore raise the identical cell-name list,
 * which is the property that makes a failure in this leg something a person can look up rather than
 * something they have to reproduce.
 */
const MATRIX: readonly { readonly row: ScenarioRow; readonly door: RenderDoor }[] = Object.freeze(
  SCENARIO_TABLE.flatMap((row) =>
    RENDER_DOORS.filter((door) => door.covers(row)).map((door) => ({ row, door })),
  ),
)

describe('the rendered-output matrix: leg 8', () => {
  it('produces a result document for every registered capability, from its own contract', () => {
    // Both directions, read off live enumerations, so the leg cannot quietly stop ranging.
    const rendered = [...new Set(MATRIX.map((cell) => cell.row.opId))]
    const diff = censusDiff(registryOpIds(), rendered)
    expect(
      diff.missing,
      'capabilities the registry declares that this leg renders nothing for — a capability with no '
        + 'render cell is one whose result can be withheld from a person with the suite still green',
    ).toEqual([])
    expect(diff.stray, 'render cells naming a capability the registry no longer declares').toEqual([])

    // …and every one of them produced a document with bytes in it. `undefined` is what
    // `produceResult` answers for a schema keyword it does not know, and a cell fed `undefined`
    // would assert about the string `''` while reading like a measurement.
    const unproducible = rendered
      .filter((opId) => {
        const document = serialized(producedResultFor(opId))
        return document === '' || document === '{}' || document === '[]'
      })
      .sort()
    expect(
      unproducible,
      "capabilities whose output projection this leg could not instantiate into a document with any "
        + 'field in it — every marker assertion for them would pass or fail on nothing',
    ).toEqual([])
  })

  it('derives its cell names from the table\'s committed sorted order', () => {
    // Cell names follow the table's committed order, which is asserted, so a red can be looked up.
    const ids = scenarioTableOpIds()
    expect([...ids], 'the scenario table is no longer sorted by op id, so this leg\'s cell names '
      + 'depend on the order rows happened to be appended in').toEqual([...ids].sort())

    const names = MATRIX.map((cell) => `${cell.row.opId} on ${cell.door.id}`)
    expect(new Set(names).size, 'two cells in this leg carry the same name, so a red in one of them '
      + 'is unattributable').toBe(names.length)
    expect(names.length, 'the matrix ranges nothing').toBeGreaterThan(0)
  })

  for (const { row, door } of MATRIX) {
    it(`${row.opId} on ${door.id}: every declared field of its result reaches a person`, () => {
      const markers = row.renderExpect.markers
      // A cast defeats the non-empty tuple type, and an empty row passes every build.
      expect(
        markers.length,
        `${row.opId}: the row carries an EMPTY render expectation, so this cell asserts nothing — `
          + "state the payload content a person must see, from the op's own output contract",
      ).toBeGreaterThan(0)

      const payload = producedResultFor(row.opId)
      const document = serialized(payload)

      // NON-VACUITY, FIRST DIRECTION: a marker the op's own contract cannot produce. Without this,
      // a row could name any string and the cell would be measuring whether the render invents it.
      const unproduced = markers.filter((marker) => !document.includes(fieldToken(marker)))
      expect(
        unproduced,
        `${row.opId}: these markers name nothing in the document its OWN output contract produces, `
          + `so this cell would be asserting about a shape nothing returns. produced: `
          + `${JSON.stringify(document.slice(0, 400))}`,
      ).toEqual([])

      // The mutation bar: a marker the `<op> completed` drop site already contains proves nothing.
      const alreadyThere = markers.filter((marker) =>
        droppedRender(row.opId).includes(fieldToken(marker)),
      )
      expect(
        alreadyThere,
        `${row.opId}: these markers are already present in the line this phase REPLACED `
          + `(${JSON.stringify(droppedRender(row.opId))}), so this cell would read green on the `
          + 'build the defect was measured on',
      ).toEqual([])

      // THE CLAIM.
      const rendered = door.render(row.opId, payload)
      const withheld = markers.filter((marker) => !rendered.includes(fieldToken(marker)))
      expect(
        withheld,
        `${row.opId} on ${door.id}: the op declares these fields on every result it returns and the `
          + `door showed a person none of them. what it rendered: `
          + `${JSON.stringify(rendered.slice(0, 600))}`,
      ).toEqual([])

      // …and the values, which is the other half of withholding. A render that kept the field names
      // and elided what was in them would satisfy every line above.
      const leaves = mintedLeaves(document)
      expect(
        leaves.length,
        `${row.opId}: the produced document carries no string leaf, so the value half of this cell `
          + 'ranges nothing',
      ).toBeGreaterThan(0)
      const elided = leaves.filter((leaf) => !rendered.includes(leaf))
      expect(
        elided,
        `${row.opId} on ${door.id}: the door printed this op's field names and withheld what was `
          + `IN them. what it rendered: ${JSON.stringify(rendered.slice(0, 600))}`,
      ).toEqual([])
    })
  }
})

// ---- The turn's own shape: what a turn with NO op prints, and what order two of them print in ----
//
// THESE TWO ARE NOT MATRIX CELLS AND COULD NOT BE. The matrix ranges one op at a time, which is the
// right shape for "does this capability's result reach a person" and the wrong one for two questions
// about the TURN: a turn with no op has no row to key on, and a turn with two has two. Both are
// spec-less probe edges on E2E-02 (empty, ordering) and both are driven through the shipped REPL
// rather than asserted about `renderClauseResults` in isolation — `renderClauseResults([])` answering
// `[]` is this phase's own unit-level claim, and a cell asserting it would be asking the render
// whether it agrees with itself.

describe('the turn shape a person reads, at its empty and ordering edges', () => {
  it('prints no payload block, and no `undefined`, for a turn that executed nothing', async () => {
    // An unroutable turn renders no `undefined` or bare `[]` for its empty results.
    const observed = await driveChatLines(['this fixture can route absolutely nothing at all'])

    // NON-VACUITY FIRST: the turn happened and was refused for the right reason. Without this, a
    // drive that crashed before opening a session would satisfy every assertion below.
    expect(
      observed.unhandled,
      'the utterance was routed somewhere, so this cell is not measuring a turn that executed nothing',
    ).toHaveLength(1)
    expect(observed.receipts, 'a turn meant to execute nothing filed a clause receipt').toEqual([])
    expect(
      observed.results,
      'a turn that executed nothing must answer results: [] — the channel is REQUIRED, so "nothing '
        + 'ran" and "this build does not report results" must not be the same bytes',
    ).toEqual([])

    // Sliced after the banner, past the starter prompts; picocolors colours whenever `CI` is set.
    const read = stripVTControlCharacters(observed.stdout)
    const marker = 'session chat-'
    const at = read.indexOf(marker)
    expect(at, `the drive never printed a session banner; stdout was `
      + `${JSON.stringify(read.slice(0, 600))}`).toBeGreaterThanOrEqual(0)
    const turnBytes = read.slice(at + marker.length)

    for (const artifact of ['undefined', '(no result)', '{', '[']) {
      expect(
        turnBytes.includes(artifact),
        `a turn that executed nothing printed ${JSON.stringify(artifact)} where a result would go. `
          + `what the person read: ${JSON.stringify(turnBytes.slice(0, 600))}`,
      ).toBe(false)
    }
  }, 180_000)

  it('prints a compound turn\'s payloads in the order its clauses ran', async () => {
    // THE E2E-02/ordering EDGE. Two clauses in ONE utterance — the splitter's ` then ` conjunction,
    // with each clause's JSON argument protected by the bracket depth it maintains. The ops are
    // reached by the deterministic `/fn` passthrough, so no model is consulted and nothing is spent.
    //
    // WHY ORDER IS A CLAIM AND NOT A DETAIL: two payload documents printed with no ordering
    // guarantee are two documents a reader has to tell apart by content, and the labels the render
    // adds for a compound turn are only useful if they sit above the payload they name.
    const observed = await driveChatLines(['/fn quarantine.list {} then /fn config.get {}'])

    expect(
      observed.receipts.map((receipt) => receipt.functionId),
      'the compound utterance did not run two DIFFERENT capabilities, so an ordering claim over it '
        + 'would be measuring the fixture rather than the render',
    ).toHaveLength(2)
    expect(
      new Set(observed.receipts.map((receipt) => receipt.functionId)).size,
      'the two clauses reached one capability twice',
    ).toBe(2)
    expect(
      observed.receipts.map((receipt) => receipt.status),
      'a clause that did not execute files no result, which would make the ordering claim vacuous',
    ).toEqual(['executed', 'executed'])

    // The channel, in clause execution order — asserted against the RECEIPTS rather than against a
    // list spelled here, so the claim is that the two records agree rather than that both match
    // something this file decided.
    expect(
      observed.results.map((result) => result.functionId),
      "the turn's results[] is not in the order its clauses ran",
    ).toEqual(observed.receipts.map((receipt) => receipt.functionId))

    // …and what the person read. The comparand is the SHIPPED render of the results this very drive
    // filed, so this cannot pass on a render that printed something else in a plausible order.
    const inOrder = renderClauseResults(observed.results, observed.receipts.length).join('\n')
    expect(
      observed.stdout,
      `the compound turn's payload blocks are not on the terminal in clause order. what the person `
        + `read: ${JSON.stringify(observed.stdout.slice(0, 1200))}`,
    ).toContain(inOrder)

    // THE CONTROL, so the assertion above is known to be about ORDER and not merely about presence:
    // the same two blocks the other way round must NOT be what was printed.
    const reversed = renderClauseResults([...observed.results].reverse(), observed.receipts.length).join('\n')
    expect(
      reversed === inOrder,
      'the two clauses rendered identically, so a reversed-order control cannot discriminate',
    ).toBe(false)
    expect(
      observed.stdout.includes(reversed),
      'the compound turn printed its payload blocks in REVERSE clause order',
    ).toBe(false)
  }, 180_000)

  // Receipts outnumber results here, so the survivor must label its payload with its own op.

  it('a mixed-outcome compound turn labels the surviving payload with its own op', async () => {
    // Receipts print before payloads, so the nearest receipt can belong to another clause.
    const observed = await driveChatLines([
      '/fn quarantine.list {} then /fn runs.digest {"runId":"r_nope"}',
    ])

    // NON-VACUITY FIRST, each naming what broke if it trips. The mixed shape is a property of the
    // ENGINE, not of this file: an engine change, a routing change or a stop-gate change could stop
    // producing it, and then every assertion below would be about a turn that is not the subject.
    // This cell must fail HERE, loudly, rather than going quietly vacuous.
    expect(
      observed.receipts.map((receipt) => receipt.status),
      'the fixture stopped producing the MIXED shape (one executed clause, one failed clause), so '
        + 'nothing below is measuring the misattribution this cell exists for',
    ).toEqual(['executed', 'failed'])
    expect(
      observed.results,
      'a mixed turn must file exactly one surviving payload; with none there is no payload to label '
        + 'and the render assertions below would be vacuous',
    ).toHaveLength(1)
    expect(
      observed.results[0]?.functionId,
      "the surviving payload does not belong to the FIRST clause, so the misattribution premise — a "
        + "payload printed beneath a DIFFERENT op's failure receipt — is not what this drive produced",
    ).toBe(observed.receipts[0]?.functionId)
    expect(
      observed.receipts.length,
      'receipts do not outnumber results, so this is not the receipts-exceed-results shape gap 2 '
        + 'was measured in',
    ).toBeGreaterThan(observed.results.length)

    // THE DISCRIMINATING ASSERTIONS, on the module's own output so the comparand cannot drift from
    // the shipped render. Soft, so one run records BOTH values the fix changes.
    //
    // Note vitest does not typecheck: at the pre-fix HEAD the second argument is silently ignored
    // and `rendered` is a single unlabelled payload line. That is exactly why the assertions are on
    // the rendered LINES — a containment-only assertion would be green before the fix and certify
    // nothing.
    const rendered = renderClauseResults(observed.results, observed.receipts.length)
    expect
      .soft(
        rendered,
        'the surviving payload rendered WITHOUT a label line: a person reads it directly beneath a '
          + "different op's failure receipt, with nothing on screen saying whose output it is",
      )
      .toHaveLength(2)
    expect
      .soft(
        rendered[0],
        'the first rendered line does not name the op the payload belongs to (it is the payload '
          + `itself). what the render produced: ${JSON.stringify(rendered)}`,
      )
      .toContain(String(observed.results[0]?.functionId))

    // …and the shipped surface really prints that block, label directly above its own payload.
    expect(
      observed.stdout,
      `the labelled block is not on the terminal. what the person read: `
        + `${JSON.stringify(observed.stdout.slice(-1200))}`,
    ).toContain(rendered.join('\n'))
  }, 180_000)

  it("a single-clause turn stays unlabelled (the guard's reject side)", async () => {
    // The reject side: one receipt, one result, no label, because the receipt line names the op.
    const observed = await driveChatLines(['/fn quarantine.list {}'])

    // NON-VACUITY FIRST: a drive that never reached the capability would satisfy "no label" trivially.
    expect(
      observed.receipts.map((receipt) => receipt.status),
      'the single-clause fixture did not file exactly one executed receipt, so the unlabelled claim '
        + 'below would be about a turn that never ran an op',
    ).toEqual(['executed'])
    expect(observed.results, 'a single executed clause filed no payload to render').toHaveLength(1)

    const rendered = renderClauseResults(observed.results, observed.receipts.length)
    expect(
      rendered,
      `a single-receipt turn grew a label line — the op's name now appears twice on two consecutive `
        + `lines. what the render produced: ${JSON.stringify(rendered)}`,
    ).toHaveLength(1)
    expect(
      rendered[0]?.includes(String(observed.results[0]?.functionId)),
      'the sole rendered line names the op, which is the label the receipt line above already carries',
    ).toBe(false)
    expect(
      observed.stdout,
      `the single-clause payload is not on the terminal. what the person read: `
        + `${JSON.stringify(observed.stdout.slice(-1200))}`,
    ).toContain(rendered.join('\n'))
  }, 180_000)
})
