// Searches run after the echoed clause, because starter prompts and the echo put row text earlier.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  AGENT_ASK_FUNCTION_ID,
  CONFIG_AUTH_SET_FUNCTION_ID,
  CONFIG_FIELD_SET_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import { maskedToolResult } from '@vostride/agent-qa-mcp'
import { ConfigChangeOutputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { renderFnResult } from '../../commands/fn.js'
import { renderClauseResults } from '../../commands/result-render.js'
import { registryDeclarations } from './adapters.js'
import { SCENARIO_TABLE } from './scenario-table.js'
import type { ScenarioRow } from './scenario-table.js'
import {
  CLI_ENTRY,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  driveChatSpawned,
  fixtureProject,
  hermeticEnv,
  spawnCollecting,
} from './spawned-chat.js'

afterEach(() => {
  cleanupTempRoots()
})

// ---- The three inputs, and why each one is the input it is --------------------------------------

/** A synthetic value that is not shaped like an environment variable's name. */
const NOT_A_REFERENCE = 'sk-PROBE-0000000000000000000000000000'

/** A real `z.string()` key on `UseSchema`, so the success cell's control is genuinely a success. */
const SETTABLE_PATH = 'use.buildTag'

/** A path that is NOT a key on `UseSchema`, so whole-config validation refuses the result. */
const UNSETTABLE_PATH = 'use.authState'

const BENIGN_VALUE = 'anchor-build-tag-v1'

function utteranceFor(path: string, value: string): string {
  return `/fn ${CONFIG_FIELD_SET_FUNCTION_ID} ${JSON.stringify({ path, value })}`
}

/** The refs-only refusal arm: `config.auth.set` with a value that is not a reference. */
const REFS_ONLY_DRIVE = {
  opId: CONFIG_AUTH_SET_FUNCTION_ID,
  utterance: `/fn ${CONFIG_AUTH_SET_FUNCTION_ID} ${JSON.stringify({
    target: 'web',
    envVarName: NOT_A_REFERENCE,
  })}`,
} as const

/**
 * The bytes a string OCCUPIES inside a pretty-printed JSON payload.
 *
 * A validation issue reads `use: Unrecognized key: "authState"` on the record and reaches a terminal
 * with its inner quotes escaped, because the render is `JSON.stringify(payload, null, 2)`. Asserting
 * the raw form would fail against a build that renders the field perfectly. The transform is applied
 * to a value READ off the record, so this is still the record's own content and not a literal.
 */
function asRendered(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

// ---- Driving one turn, and reading what it filed ------------------------------------------------

interface RenderReading {
  readonly utterance: string
  /** Everything the person read AFTER the echoed clause: the outcome line, and any payload. */
  readonly slice: string
  /**
   * The receipt line the echoed clause sits ON — which is where the VERDICT WORD is.
   *
   * `receipt-line.ts` renders `  <status>  <op>  <clause>`, so the status word PRECEDES the clause
   * the marker is and no post-marker slice can carry it. This is still one marker-anchored line and
   * still below every starter prompt; it is not a search of stdout.
   */
  readonly receiptLine: string
  /** The answer this very drive's op gave, off the child's session log, parsed with the contract. */
  readonly answer: ConfigChangeOutput
  readonly stdout: string
  readonly stderr: string
}

// Parsed with the shipped schema, so a nonconforming answer reds rather than `undefined`.
function changeAnswer(root: string, opId: string = CONFIG_FIELD_SET_FUNCTION_ID): ConfigChangeOutput {
  expect(existsSync(join(root, '.agent-qa', 'proposals')), 'the drive filed a proposal record')
    .toBe(false)
  const result = childClauseResult(root, opId)
  const parsed = ConfigChangeOutputSchema.safeParse(result.payload)
  expect(
    parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')),
    'the logged answer does not parse against the shipped config-change contract',
  ).toEqual([])
  if (!parsed.success) throw new Error('unreachable: the assertion above has already failed')
  return parsed.data
}

/**
 * Drive one `config.field.set` turn through the shipped binary and return what a person saw.
 *
 * THE FRESHNESS GUARD AND THE CLEAN EXIT ARE ASSERTED HERE, BEFORE ANY CONTENT IS RETURNED, and
 * both are the cells' own contract rather than a precondition somebody satisfied once: a child that
 * died folds to "nothing was printed", which is a red for the wrong reason wearing the calling
 * cell's failure message.
 */
async function driveFieldSet(label: string, path: string, value: string): Promise<RenderReading> {
  return await driveChange(label, CONFIG_FIELD_SET_FUNCTION_ID, utteranceFor(path, value))
}

async function driveChange(label: string, opId: string, utterance: string): Promise<RenderReading> {
  expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  expect(
    existsSync(CLI_ENTRY),
    `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
  ).toBe(true)

  const fixture = fixtureProject(`399-1-render-${label}`)
  const outcome = await driveChatSpawned(fixture.root, fixture.configPath, utterance)

  expect(
    { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
    `the spawned chat binary did not exit cleanly for the ${label} cell`,
  ).toMatchObject({ code: 0, signal: null })

  const markerIndex = outcome.stdout.indexOf(utterance)
  expect(
    markerIndex,
    `the spawned chat binary never echoed the ${label} cell's clause; its stdout was `
    + `${JSON.stringify(outcome.stdout.slice(0, 800))} and its stderr `
    + `${JSON.stringify(outcome.stderr.trim().slice(0, 400))}`,
  ).toBeGreaterThanOrEqual(0)
  expect(
    outcome.stdout.lastIndexOf(utterance),
    `the ${label} cell's clause occurs more than once in the child's stdout, so the post-marker `
    + 'slice this cell searches is not the one turn it means',
  ).toBe(markerIndex)

  const lineEnd = outcome.stdout.indexOf('\n', markerIndex)

  return {
    utterance,
    slice: outcome.stdout.slice(markerIndex + utterance.length),
    receiptLine: outcome.stdout.slice(
      outcome.stdout.lastIndexOf('\n', markerIndex) + 1,
      lineEnd === -1 ? undefined : lineEnd,
    ),
    answer: changeAnswer(fixture.root, opId),
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  }
}

/**
 * The one word the receipt line LEADS with — the verdict a person reads before anything else.
 *
 * Split on whitespace rather than sliced at a column, because the styling is `pc`'s and the leading
 * indent is the renderer's; what is being asserted is the WORD, not its typography.
 */
function verdictWord(reading: RenderReading): string {
  return reading.receiptLine.trim().split(/\s+/u)[0] ?? ''
}

/** The failure message every content assertion shares: what was searched, and what was in it. */
function withheld(label: string, reading: RenderReading): string {
  return `the shipped chat binary printed none of the ${label} arm's own report after the clause `
    + `it echoed. post-marker stdout: ${JSON.stringify(reading.slice.slice(0, 900))}; child stderr: `
    + `${JSON.stringify(reading.stderr.trim().slice(0, 300))}`
}

// ---- The anchors --------------------------------------------------------------------------------

describe('the chat render anchors', () => {
  it('prints the validation refusal and the validator\'s own words when the result is invalid',
    async () => {
      const reading = await driveFieldSet('schema-fail', UNSETTABLE_PATH, BENIGN_VALUE)

      expect(reading.answer.outcome, 'the schema-fail cell did not reach the blocked arm')
        .toBe('blocked')
      if (reading.answer.outcome !== 'blocked') return

      expect(reading.answer.blockedReason, 'the schema-fail cell reached the wrong blocked road')
        .toBe('schema-fail')
      expect(reading.slice, withheld('schema-fail', reading))
        .toContain(asRendered(reading.answer.blockedReason))

      const issues = reading.answer.validationIssues ?? []
      expect(issues.length, 'the blocked answer carried no validation issues to look for')
        .toBeGreaterThan(0)
      for (const issue of issues) {
        expect(reading.slice, withheld('schema-fail', reading)).toContain(asRendered(issue))
      }
    }, 180_000)

  it('prints the reviewable diff when the mutation is genuinely proposed', async () => {
    // The success arm is `applied`: the change is written in the call.
    const reading = await driveFieldSet('success', SETTABLE_PATH, BENIGN_VALUE)

    expect(reading.answer.outcome, 'the success cell did not reach the applied arm')
      .toBe('applied')
    if (reading.answer.outcome !== 'applied') return

    expect(reading.slice, withheld('success', reading))
      .toContain(asRendered(reading.answer.summaryLine))
    for (const path of reading.answer.files) {
      expect(reading.slice, withheld('success', reading)).toContain(asRendered(path))
    }

    // The whole diff: the render is `JSON.stringify(payload, null, 2)`, which withholds nothing.
    const shownDiff = reading.answer.shownDiff
    expect(shownDiff.length, 'the answer carried an empty diff to look for').toBeGreaterThan(0)
    expect(reading.slice, withheld('success', reading)).toContain(asRendered(shownDiff))
  }, 180_000)

  it('renders a SECOND op\'s payload too, on the read door chat advertises itself', async () => {
    // A second op on the same render path, so the mechanism is not one op special-cased.
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
    const fixture = fixtureProject('399-1-render-inbox')
    const readClause = '/fn config.get {}'
    const outcome = await driveChatSpawned(
      fixture.root,
      fixture.configPath,
      `${utteranceFor(SETTABLE_PATH, BENIGN_VALUE)}\n${readClause}`,
    )

    expect(
      { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
      'the spawned chat binary did not exit cleanly for the second-op cell',
    ).toMatchObject({ code: 0, signal: null })

    const markerIndex = outcome.stdout.indexOf(readClause)
    expect(
      markerIndex,
      `the spawned chat binary never echoed "${readClause}"; its stdout was `
      + `${JSON.stringify(outcome.stdout.slice(0, 900))}`,
    ).toBeGreaterThanOrEqual(0)
    expect(
      outcome.stdout.lastIndexOf(readClause),
      `"${readClause}" occurs more than once in the child's stdout, so the post-marker slice this `
      + 'cell searches is not the one turn it means',
    ).toBe(markerIndex)

    const slice = outcome.stdout.slice(markerIndex + readClause.length)
    const written = changeAnswer(fixture.root)
    expect(written.outcome, 'the first turn did not write its change').toBe('applied')
    expect(readFileSync(fixture.configPath, 'utf8')).toContain(BENIGN_VALUE)
    expect(
      slice,
      'the shipped chat binary read the configuration and printed nothing the first turn wrote. '
      + `post-marker stdout: ${JSON.stringify(slice.slice(0, 900))}; child stderr: `
      + `${JSON.stringify(outcome.stderr.trim().slice(0, 300))}`,
    ).toContain(asRendered(BENIGN_VALUE))
  }, 180_000)

  it('reports each arm\'s own VERDICT WORD on the receipt line, refusals and success alike',
    async () => {
      // The status word precedes the clause marker, so it is read from the marker's own line.
      const refused = await driveChange(
        'verdict-refs-only', REFS_ONLY_DRIVE.opId, REFS_ONLY_DRIVE.utterance)
      const schemaFail = await driveFieldSet('verdict-schema-fail', UNSETTABLE_PATH, BENIGN_VALUE)
      const proposed = await driveFieldSet('verdict-proposed', SETTABLE_PATH, BENIGN_VALUE)

      // NON-VACUITY FIRST: the three drives really reached the refused arm, the blocked arm and the
      // applied one. Without this, a fixture that landed three identical arms would satisfy every
      // pin below while measuring one arm three times.
      expect(
        [refused, schemaFail, proposed].map((reading) => reading.answer.outcome),
        'the three drives did not reach the refused, blocked and applied arms, so the verdict '
        + 'words below would be pinning whatever this fixture happened to produce',
      ).toEqual(['refused', 'blocked', 'applied'])

      // Both refusals and success in one cell, so a build answering `refused` for everything reds.
      expect(
        verdictWord(refused),
        'a reference field refused a value that is not a reference and the receipt does not read '
        + `\`refused\`. the line the person read: ${JSON.stringify(refused.receiptLine)}`,
      ).toBe('refused')
      expect(
        verdictWord(schemaFail),
        'the validator refused the mutation and the receipt does not read `refused`. the line the '
        + `person read: ${JSON.stringify(schemaFail.receiptLine)}`,
      ).toBe('refused')
      expect(
        verdictWord(proposed),
        'a change really was written and the receipt does not read `executed`. the line the person '
        + `read: ${JSON.stringify(proposed.receiptLine)}`,
      ).toBe('executed')
    }, 300_000)

  it('the nested composition: a refusal is never a success one composition layer up',
    async () => {
      // Wrapped in `/fn agent.ask`, the outer receipt must still carry the inner refusal's word.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      const fixture = fixtureProject('399-1-09-nested')
      // The inner refusal is the refs-only one.
      const inner = REFS_ONLY_DRIVE.utterance
      const outer = `/fn ${AGENT_ASK_FUNCTION_ID} ${JSON.stringify({ message: inner })}`
      const outcome = await driveChatSpawned(fixture.root, fixture.configPath, outer)

      expect(
        { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
        'the spawned chat binary did not exit cleanly for the nested-composition cell',
      ).toMatchObject({ code: 0, signal: null })

      // THE BANNER IS SLICED OFF FIRST, on this file's own vacuity law: `chat.ts` prints three
      // starter prompts at open, so committed text is in this child's stdout before any turn runs.
      const bannerEnd = outcome.stdout.indexOf('session ')
      expect(
        bannerEnd,
        `the spawned chat binary never announced a session; its stdout was ${
          JSON.stringify(outcome.stdout.slice(0, 800))}`,
      ).toBeGreaterThanOrEqual(0)
      const postBanner = outcome.stdout.slice(bannerEnd)

      const markerIndex = postBanner.indexOf(outer)
      expect(
        markerIndex,
        `the spawned chat binary never echoed the nested clause; its stdout was ${
          JSON.stringify(outcome.stdout.slice(0, 800))} and its stderr ${
          JSON.stringify(outcome.stderr.trim().slice(0, 400))}`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        postBanner.lastIndexOf(outer),
        'the nested clause occurs more than once in the child\'s stdout, so the receipt line this '
        + 'cell reads is not the one turn it means',
      ).toBe(markerIndex)

      const lineEnd = postBanner.indexOf('\n', markerIndex)
      const receiptLine = postBanner.slice(
        postBanner.lastIndexOf('\n', markerIndex) + 1,
        lineEnd === -1 ? undefined : lineEnd,
      )
      const slice = postBanner.slice(markerIndex + outer.length)

      // NON-VACUITY: the INNER refusal really happened, and the whole inner result really was
      // rendered underneath the outer receipt. Without this the verdict-word assertion below could
      // be satisfied by a turn that refused for some entirely different reason — or by one that
      // never reached `config.field.set` at all.
      expect(
        slice,
        `the outer receipt printed none of the inner turn's own report. post-marker stdout: ${
          JSON.stringify(slice.slice(0, 900))}; child stderr: ${
          JSON.stringify(outcome.stderr.trim().slice(0, 300))}`,
      ).toContain('"status": "refused"')
      expect(slice, 'the inner refusal did not name its reason').toContain('refs-only')

      // Success is the one claim a fold may never default to.
      expect(
        receiptLine.trim().split(/\s+/u)[0] ?? '',
        'an inner turn whose only clause was REFUSED is reported as a '
        + `success one composition layer up. the line the person read: ${
          JSON.stringify(receiptLine)}`,
      ).toBe('refused')

      // AND THE SUCCESS WORD IS ABSENT FROM THE OUTER RECEIPT, spelled as a line predicate rather
      // than a whole-slice search: `executed` legitimately appears elsewhere in a rendered turn.
      expect(
        postBanner.split('\n').filter((line) => /^\s*executed\s+agent\.ask/u.test(line)),
        'the outer agent.ask receipt still leads with the success status word',
      ).toEqual([])
    }, 180_000)

  it('renders three DIFFERENT filed payloads as three different terminal readings', async () => {
    // The drives reach different outcomes first, so differing renders are a fact of this run.
    const refused = await driveChange(
      'distinct-refs-only', REFS_ONLY_DRIVE.opId, REFS_ONLY_DRIVE.utterance)
    const schemaFail = await driveFieldSet('distinct-schema-fail', UNSETTABLE_PATH, BENIGN_VALUE)
    const success = await driveFieldSet('distinct-success', SETTABLE_PATH, BENIGN_VALUE)

    const filedOutcomes = [refused, schemaFail, success].map((reading) =>
      reading.answer.outcome === 'blocked'
        ? `${reading.answer.outcome}/${reading.answer.blockedReason}`
        : reading.answer.outcome,
    )
    expect(
      new Set(filedOutcomes).size,
      `the three drives did not produce three different filed outcomes (${filedOutcomes.join(', ')}), `
      + 'so a distinctness reading over them would be measuring the fixture rather than the render',
    ).toBe(3)

    const readings: readonly { readonly label: string; readonly slice: string }[] = [
      { label: 'refs-only', slice: refused.slice },
      { label: 'schema-fail', slice: schemaFail.slice },
      { label: 'applied', slice: success.slice },
    ]
    for (const left of readings) {
      for (const right of readings) {
        if (left.label === right.label) continue
        expect(
          left.slice,
          `a ${left.label} mutation and a ${right.label} mutation render IDENTICALLY on this `
          + 'terminal — a person cannot tell a refused change from a completed one. '
          + `both printed: ${JSON.stringify(left.slice.slice(0, 600))}`,
        ).not.toBe(right.slice)
      }
    }
  }, 300_000)
})

// Each door's built binary output is compared with the in-process render of the child's own result.

// The first sorted row reachable on every door, read-only, with an empty query and an object root.
function isEmptyQuery(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  return Object.values(input).every((value) =>
    value === 0
    || (typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 0))
}

function anchorRow(): ScenarioRow {
  const declarations = new Map(registryDeclarations().map((d) => [d.id, d]))
  const row = SCENARIO_TABLE.find((candidate) => {
    if (!candidate.perSurface.fn.reachable) return false
    if (!('reachable' in candidate.perSurface.mcp)) return false
    if (!isEmptyQuery(candidate.input)) return false
    const declaration = declarations.get(candidate.opId)
    if (declaration?.risk.readOnly !== true) return false
    const projection = declaration.output as Record<string, unknown> | undefined
    return projection?.['type'] === 'object'
  })
  expect(
    row,
    'no read-only scenario row is reachable on all three doors with an empty query and an '
    + 'object-rooted output contract, so these anchors have nothing they can drive on every door',
  ).toBeDefined()
  return row as ScenarioRow
}

/** The bytes a declared field occupies — `render-parity.test.ts`'s token, for its reason. */
function fieldToken(marker: string): string {
  return `${JSON.stringify(marker)}:`
}

/** The one clause_result the chat child filed for an op, parsed off the session log it wrote. */
function childClauseResult(root: string, opId: string): { functionId: string; payload: unknown } {
  const sessions = join(root, '.agent-qa', 'sessions')
  expect(existsSync(sessions), `the chat child filed no session directory under ${sessions}`)
    .toBe(true)
  const found: { functionId: string; payload: unknown }[] = []
  for (const file of readdirSync(sessions)) {
    for (const line of readFileSync(join(sessions, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const event = JSON.parse(line) as Record<string, unknown>
      if (event['kind'] !== 'clause_result') continue
      if (event['functionId'] !== opId) continue
      found.push({ functionId: opId, payload: event['payload'] })
    }
  }
  expect(
    found.length,
    `the chat child filed ${found.length} clause_result events for ${opId}; this anchor needs `
    + 'exactly one, or the render it compares against is not the render of one turn',
  ).toBe(1)
  return found[0]!
}

describe('the per-surface render anchors: in-process ≡ shipped', () => {
  it('chat: the shipped binary prints the bytes this process renders from its own filed result',
    async () => {
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      const row = anchorRow()
      const fixture = fixtureProject('399-1-anchor-chat')
      const utterance = `/fn ${row.opId} ${JSON.stringify(row.input)}`
      const outcome = await driveChatSpawned(fixture.root, fixture.configPath, utterance)

      expect(
        { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
        'the spawned chat binary did not exit cleanly for the chat render anchor',
      ).toMatchObject({ code: 0, signal: null })

      // The post-marker slice discipline, on the echoed clause and with its uniqueness asserted —
      // `render-anchors.test.ts`'s header says why the marker is the clause and not the outcome line.
      const markerIndex = outcome.stdout.indexOf(utterance)
      expect(
        markerIndex,
        `the spawned chat binary never echoed ${JSON.stringify(utterance)}; its stdout was `
        + `${JSON.stringify(outcome.stdout.slice(0, 800))} and its stderr `
        + `${JSON.stringify(outcome.stderr.trim().slice(0, 400))}`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        outcome.stdout.lastIndexOf(utterance),
        'the anchor clause occurs more than once in the child stdout, so the slice searched is not '
        + 'the one turn it means',
      ).toBe(markerIndex)
      const slice = outcome.stdout.slice(markerIndex + utterance.length)

      // IN-PROCESS ≡ SHIPPED. The comparand is this process's render of the result THE CHILD filed.
      const filed = childClauseResult(fixture.root, row.opId)
      // Receipt count `1`: each anchor drives one clause, so the child filed one receipt and the
      // comparand is the unlabelled single-clause shape the child actually printed.
      const inProcess = renderClauseResults([filed], 1).join('\n')
      expect(inProcess.length, 'the in-process render of the child\'s result is empty, so the '
        + 'comparison below would be vacuous').toBeGreaterThan(0)
      expect(
        slice,
        `the shipped chat binary and the in-process render disagree about what this result looks `
        + `like. the binary printed ${JSON.stringify(slice.slice(0, 700))}; this process renders `
        + `${JSON.stringify(inProcess.slice(0, 700))}`,
      ).toContain(inProcess)

      // …and the row's own declared expectation, asserted on child stdout exactly as its in-process
      // twin asserts it on the produced document.
      for (const marker of row.renderExpect.markers) {
        expect(
          slice,
          `${row.opId} on chat (spawned): the field ${marker} never reached the terminal. `
          + `post-marker stdout: ${JSON.stringify(slice.slice(0, 700))}`,
        ).toContain(fieldToken(marker))
      }
    }, 180_000)

  it('fn: the shipped binary\'s human bytes ARE this process\'s render of its own JSON channel',
    async () => {
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      const row = anchorRow()
      const fixture = fixtureProject('399-1-anchor-fn')
      const base = [CLI_ENTRY, '--config', fixture.configPath, 'fn', row.opId, '--input',
        JSON.stringify(row.input)]

      const human = await spawnCollecting(fixture.root, base)
      const machine = await spawnCollecting(fixture.root, [...base, '--json'])

      for (const [label, outcome] of [['human', human], ['--json', machine]] as const) {
        expect(
          { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
          `the spawned fn binary did not exit cleanly on its ${label} channel`,
        ).toMatchObject({ code: 0, signal: null })
      }

      // The child's OWN result, off the machine channel it publishes for exactly this purpose.
      const payload = JSON.parse(machine.stdout) as unknown
      expect(
        payload,
        'the fn child\'s --json channel answered nothing to render, so the comparison below is '
        + 'vacuous',
      ).not.toBeUndefined()

      // EXACT EQUALITY, which is available here and nowhere else in this file: `fn` prints one
      // document and nothing around it, so "the door showed the whole result" and "the door showed
      // only the result" are one assertion. A `toContain` would pass on a build that printed the
      // payload inside a wrapper this suite has never seen.
      expect(
        human.stdout.trim(),
        'the shipped `agent-qa fn` printed something other than this process\'s render of the very '
        + 'result it answered on its own --json channel',
      ).toBe(renderFnResult(payload))

      for (const marker of row.renderExpect.markers) {
        expect(
          human.stdout,
          `${row.opId} on fn (spawned): the field ${marker} never reached the terminal. stdout: `
          + `${JSON.stringify(human.stdout.slice(0, 700))}`,
        ).toContain(fieldToken(marker))
      }
    }, 180_000)

  it('mcp: the shipped server\'s two channels are one masking, and carry the declared fields',
    async () => {
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      const row = anchorRow()
      const mcp = row.perSurface.mcp
      expect('reachable' in mcp, 'the derived anchor row has no MCP door').toBe(true)
      if (!('reachable' in mcp)) return
      const fixture = fixtureProject('399-1-anchor-mcp')

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_ENTRY, '--config', fixture.configPath, 'mcp'],
        cwd: fixture.root,
        env: hermeticEnv(fixture.root),
        stderr: 'pipe',
      })
      let captured = ''
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      })
      const client = new Client({ name: 'agent-qa-399-1-render-anchor', version: '0.0.0' })
      try {
        await client.connect(transport)
        const result = await client.callTool({
          name: mcp.reachable.tool,
          arguments: row.input as Record<string, unknown>,
        })

        expect(
          {
            isError: (result as { isError?: boolean }).isError === true,
            stderr: captured.trim().slice(0, 400),
          },
          'the spawned MCP binary refused the anchor call in band; its stderr is quoted beside this',
        ).toMatchObject({ isError: false })

        const structured = (result as { structuredContent?: unknown }).structuredContent
        expect(
          structured,
          'the spawned MCP binary answered with no structuredContent, so this door rendered no '
          + 'result at all',
        ).toBeDefined()

        // IN-PROCESS ≡ SHIPPED, in the form this door's render makes checkable: `maskedToolResult`
        // answers BOTH channels from ONE masking, so the text a person reads must be the
        // serialization of the object a machine reads. Recomputing it here against the wire's own
        // structuredContent is the identity — a build whose two channels had drifted apart reds.
        const content = (result as { content?: readonly { type: string; text?: string }[] }).content
        const wireText = (content ?? [])
          .map((entry) => (entry.type === 'text' ? (entry.text ?? '') : ''))
          .join('\n')
        const recomputed = maskedToolResult(structured, (text: string) => text)
        const recomputedText = (recomputed.content ?? [])
          .map((entry) => (entry.type === 'text' ? (entry.text ?? '') : ''))
          .join('\n')
        expect(
          wireText,
          'the shipped MCP server\'s text channel is not the serialization of the object channel it '
          + 'answered beside it — the two are supposed to be one masking of one document',
        ).toBe(recomputedText)

        const serialized = JSON.stringify(structured)
        for (const marker of row.renderExpect.markers) {
          expect(
            serialized,
            `${row.opId} on mcp (spawned): the field ${marker} never reached the wire. `
            + `structuredContent: ${JSON.stringify(serialized.slice(0, 700))}`,
          ).toContain(fieldToken(marker))
        }
      } finally {
        await client.close().catch(() => {})
      }
    }, 180_000)
})
