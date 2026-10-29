// The render anchors: what the SHIPPED chat binary prints when an op answers (Phase 399.1 plan 01).
//
// THE DEFECT THESE CELLS EXIST FOR (G-399-2, measured 2026-08-20 at HEAD 50513a31). A credential
// refusal, a validation refusal and a genuine success all rendered byte-identically on chat's
// stdout as `config.field.set completed`, with `executed` in green. The guardrail HELD — nothing
// was written — and the person was told the mutation completed. The corrective information the
// product had already computed and persisted (`blockedReason` distinguishing "you tried to write a
// secret" from "your config is invalid"; the scan findings naming the detector and the file) never
// reached the one person it was written for. 2026-10-14 (441-39, D-15): a config change is no
// longer scanned, so the only blocked reason left is `schema-fail`.
//
// THE ASSERTION SURFACE IS CHILD STDOUT, AND THAT IS THE POINT (criterion 1's own words; 395's
// corpus-blind-by-assertion-surface lesson). Every cell in phase 399 asserted on the op's RETURN
// VALUE, which was correct, complete and safely redacted the whole time — and none of them asked
// whether any byte of it reached a terminal. So these cells spawn `dist/cli.js`, type one turn into
// a real pipe, and read what came back. An in-process `renderTurn` assertion is not stdout either.
//
// THE VACUITY TRAP, NAMED RATHER THAN AVOIDED BY LUCK (the 398-13 cell's law). `chat.ts` prints
// three starter prompts at open, and each starter is a catalog row's own description — committed
// text is in this child's stdout before any turn runs. Worse for these cells specifically: the
// utterance is echoed on the receipt line, so a whole-stdout search for a value THE UTTERANCE
// CARRIES would pass on a build that renders nothing at all. Every search below therefore runs over
// the slice AFTER a marker, the marker is the echoed clause itself, and its uniqueness is asserted
// so the slice cannot be silently widened by a second occurrence.
//
// THE MARKER IS THE CLAUSE, NOT `<op> completed`. The 398-13 cell marks on the outcome line, which
// is exactly the string this phase changes: a refused clause stops saying `completed` the moment
// the fix lands, and a marker that vanished under the fix would red these cells for the wrong
// reason at GREEN time. The echoed clause is stable across both revisions and unique per cell.
//
// EXPECTATIONS ARE READ OFF THE ANSWER THE RUN ITSELF GAVE (produced-not-literal; 390-03's law).
// Not one blocked reason, detector name, validation issue or diff line is spelled in this file.
// Each cell drives the binary, reads the op's own answer off the session log the child wrote,
// parses it with the SHIPPED contract, and asks whether those bytes reached the terminal. 2026-09-30,
// 432-11 D-05: the answer used to be read off the proposal record the drive filed; the config op now
// writes in the call and files nothing, so the child's own clause_result is the record.
//
// NO CREDENTIAL, REAL OR OTHERWISE. 2026-10-14 (441-18, D-15): config changes are not scanned, so
// the guardrail arm these cells once drove is gone. The refusal arm they drive instead is the
// reference field's refs-only refusal, over a SYNTHETIC value that is not shaped like a variable
// name. The child's environment is constructed rather than inherited so no ambient provider
// credential can reach it.
//
// THE INSTRUMENT IS IMPORTED, NEVER RE-ROLLED. `spawned-chat.ts` owns the driver, the hermetic
// environment, the fixture recipe and the freshness guard — see its header for why a second copy of
// any of them would be a second answer to "what did the child inherit".

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

/**
 * The ONE `config.field.set` answer the child logged after a drive, parsed rather than read as JSON.
 *
 * PARSED WITH THE SHIPPED SCHEMA so a cell cannot build its expectation out of a shape the product
 * does not actually produce, and so an answer that stopped conforming is a red here rather than an
 * `undefined` quietly reaching a `toContain`. Nothing is filed any more (432-11), and the drive's
 * runtime root is asserted to hold no proposal record.
 */
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
  // 2026-10-14 (441-18, D-15): 'prints the guardrail refusal and its findings when a mutation would
  // write a secret' is deleted with the construction scan it measured.

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
    // 432-11: "genuinely proposed" now means genuinely WRITTEN — the success arm is `applied`.
    const reading = await driveFieldSet('success', SETTABLE_PATH, BENIGN_VALUE)

    expect(reading.answer.outcome, 'the success cell did not reach the applied arm')
      .toBe('applied')
    if (reading.answer.outcome !== 'applied') return

    expect(reading.slice, withheld('success', reading))
      .toContain(asRendered(reading.answer.summaryLine))
    for (const path of reading.answer.files) {
      expect(reading.slice, withheld('success', reading)).toContain(asRendered(path))
    }

    // THE WHOLE DIFF, not a line of it (D-04). The default render is `JSON.stringify(payload, null,
    // 2)` precisely so it is structurally incapable of withholding a field, and a cell that settled
    // for one recognisable line would pass against a hand-picked field join — which is the RC-2
    // drop-site shape this phase's prohibition exists to forbid.
    const shownDiff = reading.answer.shownDiff
    expect(shownDiff.length, 'the answer carried an empty diff to look for').toBeGreaterThan(0)
    expect(reading.slice, withheld('success', reading)).toContain(asRendered(shownDiff))
  }, 180_000)

  it('renders a SECOND op\'s payload too, on the read door chat advertises itself', async () => {
    // THE PER-DOOR RENDER CELL (RESEARCH Pitfall 4). A render that worked for exactly one op id
    // would be the hardcoded shape this phase demotes (criterion 6); this cell reds if the
    // mechanism is `config.field.set` special-casing wearing a general name.
    //
    // 432-11 D-05: the second op was `proposals.list`, reading the proposal the first turn filed.
    // The first turn now WRITES the config in the call, so the second op is the configuration read
    // door, `config.get`, and the payload searched for is the value the first turn wrote — so this
    // cell cannot pass on a read that rendered an unchanged config honestly.
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
      // WHY THIS CELL EXISTS, AND IT IS A MEASUREMENT RATHER THAN AN ARGUMENT. Every content
      // assertion in this file reads the POST-MARKER slice — the payload block. 399.1-07's VERDICT
      // leg folded `blocked` to `executed` in `config-propose-verdict.ts` (the exact implementation
      // D-01 forbids, and the literal G-399-2 defect: a guardrail declined and chat said the change
      // was carried out), rebuilt, and ran the whole conformance directory: 271/271 GREEN. A
      // guardrail's own words printed underneath the word `executed` is not the repair this phase
      // claims — it is the defect with better prose. So the verdict word is pinned here, on the
      // line a person reads it on, and the leg that found this file blind now reds exactly here.
      //
      // WHY IT WAS MISSED, structurally rather than by oversight: `receipt-line.ts` renders
      // `  <status>  <op>  <clause>`, so the status word PRECEDES the clause the marker is and a
      // strict post-marker slice CANNOT carry it. `receiptLine` above reads the marker's own line.
      // 2026-10-14 (441-18, D-15): the guardrail arm is replaced by the refs-only refusal.
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

      // D-01's decision, arm by arm. `blocked` is `refused` because the CONTROL WORKED and nothing
      // happened; `applyable` is `executed` because a proposal really was filed. The success arm is
      // pinned in the SAME cell deliberately: a cell asserting only the two refusals would pass
      // against a build that answered `refused` for everything — which would destroy every real
      // verdict in the product — so both directions are one cell's business.
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
      // GAP 1's THIRD MEASURED CONSEQUENCE (P2, 399.1-VERIFICATION), on the surface it was measured
      // on. The cells above pin ONE composition layer: the op refuses, the receipt says `refused`.
      // Wrap that same turn in `/fn agent.ask` and the outer clause is a turn whose own receipts
      // carry the refusal — and `agent.ask`'s classify folded only the turn STATUS, which the engine
      // derived from throw-versus-return. Nothing threw, so the inner aggregate read `completed` and
      // the outer receipt read the success word over a blocked credential write. A person reading
      // the outer line was told the mutation was carried out; the file was byte-unchanged.
      //
      // THE UTTERANCE IS COMPOSED, NEVER HAND-ESCAPED. The inner clause is itself JSON-bearing, so
      // spelling the nesting by hand is how a fixture silently drives a DIFFERENT utterance from the
      // one its name claims — and a drive that reached the wrong op would red for the wrong reason.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      const fixture = fixtureProject('399-1-09-nested')
      // 2026-10-14 (441-18, D-15): the inner refusal is the refs-only one, the guardrail being gone.
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

      // THE CLAIM. One layer up, the word a person reads must still be the one its own receipts
      // support — success is the one claim a fold may never default to (D-03's asymmetry, D-12).
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
    // THE MEASUREMENT THAT SET THIS PHASE'S SEVERITY, as a standing cell. Content assertions above
    // can each be satisfied by a render that says a great deal; only this one asks the question the
    // owner actually rejected at UAT — whether a person can TELL THE THREE APART. All three slices
    // were byte-identical at HEAD 50513a31, and each of the three cells above passed no part of it.
    //
    // ITS OWN NON-VACUITY, both ways: the three drives are asserted to have reached three different
    // filed outcomes first, so "the payloads differ" is a fact about this run rather than an
    // assumption, and three identical renderings of three identical payloads could not pass here.
    // 2026-10-14 (441-18, D-15): the guardrail arm is replaced by the refs-only refusal.
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

// ---- The per-surface render anchors: in-process ≡ shipped, one cell per door (D-08) -------------
//
// WHAT THESE THREE ADD THAT THE MATRIX CANNOT. `render-parity.test.ts` drives the shipped render
// FUNCTIONS for all 42 capabilities on all three doors, in this process, against documents produced
// from the ops' own contracts. That is the coverage half, and it is blind to exactly one thing: the
// artifact a person installs is a bundle, and a bundle can differ from the source it was built from
// — a tree-shaken branch, an unbundled dependency resolved to a stale `dist`, a masker wired
// differently at the composition root a `dist` entry point reaches. Each cell below spawns the built
// binary for ONE door and asserts that the bytes it printed are the bytes the in-process render
// produces for THE CHILD'S OWN RESULT. Spawned cells stay few, on D-08's wall-clock argument.
//
// THE COMPARAND IS THE CHILD'S OWN OUTPUT, NEVER A LITERAL (390-03, and `filedProposal` above is the
// same move). Each anchor obtains the result the child actually computed — out of the session log
// the chat child wrote, out of the `--json` channel the `fn` child publishes, off the wire the MCP
// child answered on — and renders THAT in this process. A cell carrying its own copy of an expected
// document keeps passing after the thing it claims to be about has changed.

/**
 * The row all three anchors drive, DERIVED from the table by a stated rule rather than picked.
 *
 * THE RULE, and each clause of it is a requirement of the measurement rather than a taste: the first
 * row in the table's committed sorted order that (1) is reachable on every rostered door, so one op
 * makes three comparable readings instead of three incomparable ones; (2) takes the EMPTY input, so
 * the same fixture invocation can be typed at a chat prompt, passed to `fn --input` and sent as MCP
 * tool arguments without three different spellings; and (3) whose output contract's root is an
 * OBJECT, because an op answering a bare array answers `[]` in an empty fixture and a render of `[]`
 * has no declared field to withhold — a cell driven there would pass on a door that prints nothing
 * but brackets.
 *
 * DERIVED RATHER THAN NAMED because a hardcoded op id here is the shape success criterion 6 forbids
 * one file away: the day this op is retired, a literal would leave three anchors asserting about a
 * capability that no longer exists, while the rule re-lands on whatever the table's next qualifying
 * row is and says so.
 *
 * 2026-09-30 (432-12, D-05): THAT DAY CAME, and the rule is re-stated rather than bent. The row it
 * landed on, `proposals.list`, left the MCP door with the proposal round, and the next row with an
 * empty input and an object root is `runs.start` — which STARTS A RUN, so an empty fixture refuses
 * it and the anchors would measure a failure. Clause (2) is therefore widened from "the empty
 * input" to "an EMPTY QUERY": every field of the row's input is an empty object or a zero baseline,
 * so it addresses nothing and the fixture's honest answer is a whole result rather than an absence.
 * The three doors still spell it identically (each sends the row's own JSON). A fourth clause is
 * added: (4) the op declares itself read-only, because an anchor drives the shipped binary against
 * a fixture and must change nothing. The rule now lands on `knowledge.records.diff`.
 */
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
