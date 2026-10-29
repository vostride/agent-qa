// Stage 2 — the frozen dedup denominator (Phase 394, D-04/D-16 · WTST-01).
//
// Twelve rows, each the SOLE CATCHER for one property, and each one's rationale in
// `fixtures/dedup-corpus/expectations.json` says which. The table is frozen: a row that stops
// catching what it claims is a finding about the lane, never a reason to move the row.
//
// THE INTENT IS PRODUCED, NOT WRITTEN HERE — AND IT IS THE PRODUCER PRODUCTION ACTUALLY USES.
// `loop.ts:858` calls `dedupBeforeAuthor(input.intent, …)`: the intent is the PERSON'S ONE-LINE
// UTTERANCE, and there is no test document anywhere at stage 2 — having none is the entire premise
// of dedup-BEFORE-author. So every row's intent is read at test time out of the single `intent:`
// key of a fixture under `fixtures/dedup-corpus/intents/`, and what comes back is byte-identical
// to the string the op receives. The suite side is still a DOCUMENT, and that is not an
// inconsistency: a corpus entry is a committed test, which has a name and steps.
//
// UNTIL 2026-08-13 THIS FILE CLAIMED THAT AND DID THE OPPOSITE. Every intent was a whole house
// document projected `[name, ...steps].join(' ')` — a 21-token input no caller can emit — so the
// table could not red on the distribution production sees, and stage 2 shipped un-refusable for
// the whole phase (394-VERIFICATION round 4, gap SC-1 stage 2; WINDOWS 118). A corpus assembled
// through the WRONG producer fails exactly the way a corpus assembled as a type literal does: the
// mutation differential reds only impossible fixtures, and cannot tell a vacuous corpus from a
// real closure. The rows were re-minted; the row ids and their sole-catcher rationales were not.
//
// THE SUBJECT IS IMPORTED LAZILY, INSIDE EACH CELL, and that is the RED-first mechanism rather
// than a style choice. A top-level import of a module that does not exist yet fails the whole FILE
// to load, and vitest reports that identically to a corpus that was never written at all
// (`No test files found` and a load error are the same exit code). Imported per cell, the
// pre-implementation RED is N NAMED ROWS each failing on module resolution, which is a recording
// of the denominator rather than of the harness.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTHORING_DEDUP_CONTINUATIONS } from '@vostride/agent-qa-schema'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { textSimilarity } from '../adds-value.js'
import type { SuiteTextCorpusEntryLike } from '../ports.js'

const CORPUS_DIR = join(import.meta.dirname, 'fixtures', 'dedup-corpus')

interface SuiteMemberSpec {
  readonly identityPath: string
  readonly document: string
}

interface CorpusRow {
  readonly id: string
  /** Path to a one-line utterance fixture, or null when the row's intent comes from elsewhere. */
  readonly intent: string | null
  /**
   * The row's intent is the named suite member's OWN NAME, read out of its document.
   *
   * Not a fixture and deliberately not a string literal: a retyped copy of a test's name is a
   * second spelling that can drift from the suite it screens against, and the one row whose whole
   * point is "the intent IS the test's name" is the row that must not be able to drift.
   */
  readonly intentFromMemberName?: string
  /** The degenerate 0/0 row: an empty intent against an empty entry. No producer emits either. */
  readonly degenerate?: boolean
  readonly suite: readonly string[] | null
  readonly expected: 'duplicate' | 'no-duplicate'
  readonly matched: string | null
  readonly score: number | null
  readonly sharedTokens: number | null
  readonly comparedTests: number
  readonly rationale: string
  readonly measured: string
}

interface Expectations {
  readonly $comment: readonly string[]
  readonly schemaVersion: number
  readonly frozenAt: string
  readonly reMintedAt: string
  readonly vectorsMeasuredAgainst: string
  readonly threshold: number
  readonly thresholdComparison: string
  readonly suiteMembers: Readonly<Record<string, SuiteMemberSpec>>
  readonly the393Suite: readonly string[]
  readonly rows: readonly CorpusRow[]
}

const EXPECTATIONS = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as Expectations

/** A house-style test document, reduced to the fields a text projection reads. */
interface HouseDocument {
  readonly name: string
  readonly steps: readonly string[]
  readonly 'test-id': string
  readonly target: string
}

function readDocument(relativePath: string): HouseDocument {
  return parse(readFileSync(join(CORPUS_DIR, relativePath), 'utf8')) as HouseDocument
}

/**
 * The intent, as the op receives it: ONE LINE of a person's speech and nothing else.
 *
 * There is no projection step here and that absence is the point — `authoring.draft.write` hands
 * `input.intent` straight to `dedupBeforeAuthor`, so any transformation applied on this side would
 * make the corpus measure an input shape the caller cannot send. The fixture's job is transport,
 * not shaping: it carries the utterance so the table's inputs are read from files rather than
 * written as literals, and it yields the string unchanged.
 */
function intentTextOf(relativePath: string): string {
  const fixture = parse(readFileSync(join(CORPUS_DIR, relativePath), 'utf8')) as {
    readonly intent: string
  }
  return fixture.intent
}

function suiteEntry(key: string): SuiteTextCorpusEntryLike {
  const member = EXPECTATIONS.suiteMembers[key]
  if (member === undefined) throw new Error(`no suite member named ${key}`)
  const document = readDocument(member.document)
  return { filePath: member.identityPath, testName: document.name, stepsText: document.steps }
}

/** The degenerate row's corpus entry: an empty name and no steps. No document produces this. */
const EMPTY_TEXT_ENTRY: SuiteTextCorpusEntryLike = {
  filePath: 'demo/init/tests/dedup-empty-text.yaml',
  testName: '',
  stepsText: [],
}

function intentOf(row: CorpusRow): string {
  if (row.intentFromMemberName !== undefined) {
    return suiteEntry(row.intentFromMemberName).testName
  }
  if (row.intent === null) throw new Error(`row ${row.id} names no intent source`)
  return intentTextOf(row.intent)
}

function inputsFor(row: CorpusRow): {
  readonly intent: string
  readonly corpus: readonly SuiteTextCorpusEntryLike[]
} {
  if (row.degenerate === true) return { intent: '', corpus: [EMPTY_TEXT_ENTRY] }
  return { intent: intentOf(row), corpus: (row.suite ?? []).map(suiteEntry) }
}

/**
 * The row's top NAME-AXIS score — `scoreIntentAgainst`'s name-only half, mirrored exactly.
 *
 * `dedup.ts` scores an intent on two comparable axes and keeps the larger. The name-only half is
 * `textOverlap({ testName: intent, steps: [] }, { filePath, testName, stepsText: [] })`, and that
 * construction is reproduced here CHARACTER FOR CHARACTER through the imported `textSimilarity`
 * rather than approximated: a second recipe for "how alike are these two texts" is what D-16
 * forbids, and a cell that invented one would measure its own arithmetic instead of the lane's.
 * Maximised over the row's OWN suite members, because that is the set `dedupBeforeAuthor` reduces
 * over when it produces the score this reading is compared against.
 */
function nameAxisTop(row: CorpusRow): number {
  const members = row.suite ?? []
  if (members.length === 0) throw new Error(`row ${row.id} has no suite to read an axis over`)
  const utterance = intentOf(row)
  return Math.max(...members.map((key) => {
    const entry = suiteEntry(key)
    return textSimilarity(
      { testName: utterance, steps: [] },
      { filePath: entry.filePath, testName: entry.testName, stepsText: [] },
    )
  }))
}

function rowNamed(id: string): CorpusRow {
  const row = EXPECTATIONS.rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`no frozen row named ${id}`)
  return row
}

async function loadDedup() {
  return await import('../dedup.js')
}

describe('the frozen dedup corpus is intact', () => {
  it('carries the treadmill warning and twelve sole-catcher rows', () => {
    const comment = EXPECTATIONS.$comment.join(' ')
    expect(comment).toContain('MUST NOT mint new members')
    // The one suspension of that law is CITED rather than asserted, so a reader can check the
    // adjudication that authorised it instead of taking this file's word for it.
    expect(comment).toContain('394-VERIFICATION round')
    expect(EXPECTATIONS.rows).toHaveLength(12)
    for (const row of EXPECTATIONS.rows) {
      expect(row.rationale, `${row.id} states the property it is the sole catcher for`)
        .toContain('SOLE CATCHER for')
      expect(row.measured.length, `${row.id} records what was measured`).toBeGreaterThan(40)
    }
    expect(new Set(EXPECTATIONS.rows.map((row) => row.id)).size).toBe(12)
  })

  it('kept every pre-existing row id and its sole-catcher claim through the re-mint', () => {
    // The re-mint replaced INPUTS and VECTORS. If it had also replaced the properties, the table
    // would be a new denominator wearing the old one's name -- the treadmill this phase is named
    // for. These nine ids are the pre-re-mint table, verbatim.
    const preserved = [
      'obvious-duplicate',
      'accept-control',
      'at-threshold',
      'below-threshold',
      'above-threshold',
      'empty-suite',
      'empty-texts',
      'tie',
      'unfingerprinted-duplicate',
    ]
    for (const id of preserved) expect(() => rowNamed(id)).not.toThrow()
    // And exactly the three rows the verification's own `missing:` list named were added.
    const added = EXPECTATIONS.rows
      .map((row) => row.id)
      .filter((id) => !preserved.includes(id))
      .sort()
    expect(added).toEqual(['exact-name-utterance', 'step-detailed-admit', 'step-detailed-refuse'])
  })

  it('is a boundary TRIPLE: one row exactly on the pin, one below, one above', () => {
    const at = rowNamed('at-threshold')
    const below = rowNamed('below-threshold')
    const above = rowNamed('above-threshold')

    expect(at.score).toBe(EXPECTATIONS.threshold)
    expect(below.score).toBeLessThan(EXPECTATIONS.threshold)
    expect(above.score).toBeGreaterThan(EXPECTATIONS.threshold)
    // The triple pins a POINT, not a region: the two flanking rows sit within a hundredth of
    // the pin, so a lane that rounded or compared at reduced precision reds here.
    expect(EXPECTATIONS.threshold - (below.score ?? 0)).toBeLessThan(0.01)
    expect((above.score ?? 0) - EXPECTATIONS.threshold).toBeLessThan(0.01)
    expect(at.expected).toBe('duplicate')
    expect(below.expected).toBe('no-duplicate')
    expect(above.expected).toBe('duplicate')
  })

  it('has an ADMITTING leg beside every refusing one', () => {
    const admits = EXPECTATIONS.rows.filter((row) => row.expected === 'no-duplicate')
    const refuses = EXPECTATIONS.rows.filter((row) => row.expected === 'duplicate')
    // A threshold that refused everything would pass a refuse-only corpus.
    expect(admits.length).toBeGreaterThanOrEqual(3)
    expect(refuses.length).toBeGreaterThanOrEqual(3)
    // And the closest admitting row is a genuine near-miss rather than a stranger.
    const control = rowNamed('accept-control')
    expect(EXPECTATIONS.threshold - (control.score ?? 0)).toBeLessThan(0.05)
  })

  it('carries refuse AND admit cases from OUTSIDE the name-axis assumption', () => {
    // A guard whose corpus is drawn entirely from inside its own assumption is only ever tested
    // where it already believes. These two utterances name no test at all -- they recite a
    // procedure -- and the table needs one of each direction or "it refuses names" is the only
    // thing the table can say.
    const refuse = rowNamed('step-detailed-refuse')
    const admit = rowNamed('step-detailed-admit')
    expect(refuse.expected).toBe('duplicate')
    expect(admit.expected).toBe('no-duplicate')
    for (const row of [refuse, admit]) {
      // THE DECIDING AXIS, ASSERTED DIRECTLY. Until 2026-08-13 this cell compared the utterance's
      // CHARACTER LENGTH against the longest suite name -- a proxy for an axis, and a proxy of the
      // wrong kind: `textOverlap` is a token-set Jaccard, so a re-mint that shortened a suite name
      // (or lengthened an utterance without moving its overlap) left this cell green with both
      // rows back INSIDE the assumption it exists to place them outside of (394-VERIFICATION
      // round 5, WR-06). What "outside the name-axis assumption" means arithmetically is that the
      // name axis alone CANNOT reach the row's verdict -- so that is what is measured.
      expect(nameAxisTop(row), `${row.id} must be decided on the DOCUMENT axis: the name axis `
        + 'alone cannot reach its frozen score, which is what places it outside the assumption')
        .toBeLessThan(row.score ?? 0)
    }
  })

  it('discrimination control: the SAME axis computation reads a name-decided row the other way',
    () => {
      // THE MUTATION BAR FOR THE CELL ABOVE, in-suite and permanent rather than a session
      // observation. `unfingerprinted-duplicate`'s frozen 0.8000000000 IS its name-axis reading
      // (8 shared of 10+8, measured 2026-08-13 on the producible universe) -- it is a name-decided
      // row. If `nameAxisTop` ever stops distinguishing a name-decided row from a document-decided
      // one -- a mirrored construction that drifted from `scoreIntentAgainst`, a maximisation over
      // the wrong members, an axis that collapsed onto the whole-document reading -- this control
      // reds BEFORE the cell above goes silently vacuous by passing for everything.
      const nameDecided = rowNamed('unfingerprinted-duplicate')
      expect(nameAxisTop(nameDecided), 'the name axis DECIDES this row, so it must reach the '
        + 'frozen score rather than fall short of it')
        .toBeGreaterThanOrEqual(nameDecided.score ?? 0)
    })
})

/**
 * The `test-id` rule the SCHEMA asserts, spelled locally.
 *
 * `TestDefinitionSchema` refines `test-id` on `isCanonicalTestId`, which is `t_` followed by
 * exactly `CANONICAL_ID_WORDS = 10` id-agent words. `packages/agent` may not import
 * `@vostride/agent-qa-ids` any more than it may import the parser, so the rule is spelled here --
 * but it is spelled AT ITS OWN STRENGTH. The predecessor of this constant was `/^t_[a-z0-9-]+$/u`,
 * which accepts any hyphenated lowercase string, and it waved through a SEVEN-word id for the life
 * of the corpus: `dedup-unfingerprinted.yaml` was a document `parseTestFile` refuses outright, and
 * therefore a document `suiteTextCorpus()` can never yield (`local-agent-host.ts` does
 * `if (parsed.errors.length > 0) continue`), sitting inside the row that pins "the comparison
 * universe is EVERY test in the suite". A stand-in weaker than the rule it stands in for is not a
 * check (394-VERIFICATION round 5, CR-01).
 *
 * This is the CHEAP half of the guard and it is deliberately not the only half: the real parser
 * walk lives in `packages/cli/src/authoring/__tests__/dedup-corpus-producibility.test.ts`, in the
 * one package permitted to import `@vostride/agent-qa-core`, because the only assertion that
 * cannot be weaker than the parser is the parser.
 */
const CANONICAL_TEST_ID = /^t_[a-z0-9]+(-[a-z0-9]+){9}$/u

describe('every corpus fixture is what its side of the comparison actually receives', () => {
  // The producer check, per side. The SUITE side is a house-style test document, because a corpus
  // entry is a committed test. The INTENT side is a bare utterance, because that is what the op
  // is handed. `parseTestFile` itself lives in `@vostride/agent-qa-core`, which the FUNC-02
  // firewall forbids this package to import, so what is asserted here is that the suite documents
  // parse as YAML and carry the four fields the house format requires -- with `test-id` held to
  // the schema's own rule, and the shipped parser itself driven over these same six files by the
  // cli-side producibility cell named on CANONICAL_TEST_ID above.
  const suiteDocuments = [...new Set(
    Object.values(EXPECTATIONS.suiteMembers).map((member) => member.document),
  )]

  it.each(suiteDocuments)('%s parses and carries the house fields', (relativePath) => {
    const document = readDocument(relativePath)
    expect(typeof document.name).toBe('string')
    expect(document.name.length).toBeGreaterThan(0)
    expect(
      document['test-id'],
      `${relativePath}'s test-id must be t_ + exactly ten id-agent words -- a document `
      + 'parseTestFile refuses is a document suiteTextCorpus() can never yield',
    ).toMatch(CANONICAL_TEST_ID)
    expect(document.target).toBe('local-form')
    expect(Array.isArray(document.steps)).toBe(true)
    expect(document.steps.length).toBeGreaterThan(0)
    for (const step of document.steps) expect(typeof step).toBe('string')
  })

  const intentFixtures = [...new Set(
    EXPECTATIONS.rows.map((row) => row.intent).filter((path): path is string => path !== null),
  )]

  it.each(intentFixtures)('%s is ONE utterance and carries no document', (relativePath) => {
    const raw = parse(readFileSync(join(CORPUS_DIR, relativePath), 'utf8')) as Record<
      string,
      unknown
    >
    // Exactly one key, so a document cannot creep back in beside the utterance and be silently
    // ignored -- the re-mint's failure mode in reverse.
    expect(Object.keys(raw)).toEqual(['intent'])
    const utterance = raw['intent']
    expect(typeof utterance).toBe('string')
    expect(utterance as string).not.toContain('\n')
    expect((utterance as string).trim()).toBe(utterance)
    expect((utterance as string).length).toBeGreaterThan(0)
  })

  it('copies the corpus suite VERBATIM, so the two denominators describe one world', () => {
    // 393's corpus scores against these three documents. If a copy drifts, the claim that stage 2
    // and gate 3 screen the same world is silently false, and no other cell would notice.
    const localForm = suiteEntry('uat-381-local-form')
    expect(localForm.testName).toBe('Sign in on the local account form')
    expect(localForm.stepsText).toEqual([
      'Type "{{env:PROBE_USER}}" into the Username field',
      'Type "{{secret:PROBE_TOKEN}}" into the Password field',
      'Click the Submit button',
      'Verify the page says "Received!"',
    ])
    expect(EXPECTATIONS.the393Suite).toEqual([
      'uat-381-local-form',
      'uat-381-ladder',
      'uat-381-ladder-current-target',
    ])
  })
})

describe('dedupBeforeAuthor against the frozen corpus', () => {
  it('pins the threshold and the comparison direction the table was frozen against', async () => {
    const { DEDUP_REFUSE_SIMILARITY_THRESHOLD } = await loadDedup()
    expect(DEDUP_REFUSE_SIMILARITY_THRESHOLD).toBe(EXPECTATIONS.threshold)
    expect(EXPECTATIONS.thresholdComparison).toBe('>=')
    // Deliberately BELOW gate 3's, which is the whole retune argument in one assertion: a pre-run
    // screen that over-flags costs one refused invocation, an under-flagging one costs a duplicate
    // test in the suite forever.
    const { TEXT_FALLBACK_SIMILARITY_THRESHOLD } = await import('../adds-value.js')
    expect(DEDUP_REFUSE_SIMILARITY_THRESHOLD).toBeLessThan(TEXT_FALLBACK_SIMILARITY_THRESHOLD)
  })

  it.each(EXPECTATIONS.rows.map((row) => [row.id, row] as const))(
    'row %s reproduces its frozen vector',
    async (_id, row) => {
      const { dedupBeforeAuthor } = await loadDedup()
      const { intent, corpus } = inputsFor(row)
      const screening = dedupBeforeAuthor(intent, corpus)

      expect(screening.kind, row.rationale).toBe(row.expected)
      expect(screening.comparedTests).toBe(row.comparedTests)

      if (row.expected === 'no-duplicate') {
        if (row.comparedTests === 0) expect(screening.closest).toBeUndefined()
        else expect(screening.closest?.similarity).toBeCloseTo(row.score ?? 0, 10)
        return
      }

      // The refusal NAMES ITS EVIDENCE. Asserting only that a refusal occurred passes for a
      // refusal that named the wrong test, which is the failure this block exists to exclude.
      if (screening.kind !== 'duplicate') throw new Error('unreachable: arm checked above')
      const expectedMember = EXPECTATIONS.suiteMembers[row.matched ?? '']
      expect(expectedMember).toBeDefined()
      const expectedDocument = readDocument(expectedMember?.document ?? '')

      expect(screening.evidence.matched.filePath).toBe(expectedMember?.identityPath)
      expect(screening.evidence.matched.testName).toBe(expectedDocument.name)
      expect(screening.evidence.matchedRef)
        .toBe(`${expectedMember?.identityPath}::${expectedDocument.name}`)
      expect(screening.evidence.score).toBeCloseTo(row.score ?? 0, 10)
      expect(screening.evidence.sharedTokens).toBe(row.sharedTokens)
      expect(screening.evidence.threshold).toBe(EXPECTATIONS.threshold)
    },
  )

  it('refuses EVERY suite member the member\'s own name handed back verbatim', async () => {
    // WINDOWS 118, generalised, and driven through the REAL dedupBeforeAuthor rather than a
    // re-implemented Jaccard -- a re-implementation would measure my arithmetic, not the lane's.
    // A test's name handed back to the screen is the STRONGEST duplicate signal an intent can
    // carry: there is no larger overlap available, because the intent IS the identity. A lane
    // that admits this admits everything, which is exactly what round 4 measured across the ten
    // committed tests of the shipping demo suite (ceiling 0.40 against a 0.45 pin).
    const { dedupBeforeAuthor } = await loadDedup()
    const members = Object.keys(EXPECTATIONS.suiteMembers)
    // ONE assertion over the WHOLE sweep, deliberately. A per-member assertion inside the loop
    // stops at the first member that misbehaves, and the reading this cell exists to produce is
    // the shape of the failure ACROSS the suite -- how many admit, and at what scores.
    const readings = members.map((key) => {
      const entry = suiteEntry(key)
      const screening = dedupBeforeAuthor(entry.testName, [entry])
      const matchedRef = screening.kind === 'duplicate' ? screening.evidence.matchedRef : '-'
      const score = screening.kind === 'duplicate'
        ? screening.evidence.score
        : (screening.closest?.similarity ?? 0)
      return `${key}: ${screening.kind} score=${score.toFixed(10)} matched=${matchedRef}`
    })
    // An intent identical to a member's identity is a TOTAL match on the axis the two share, so
    // the expected score is 1 exactly and the expected link is that member -- not merely "some
    // refusal happened".
    expect(readings).toEqual(members.map((key) => {
      const entry = suiteEntry(key)
      return `${key}: duplicate score=1.0000000000 matched=${entry.filePath}::${entry.testName}`
    }))
  })

  it('still refuses a name-verbatim intent when the WHOLE suite is the comparison universe',
    async () => {
      // The sweep above screens each member alone. Production screens against everything, where a
      // stronger match could in principle displace the member itself -- so the verdict is asserted
      // over the full real suite too. Which member is named is NOT asserted here: two of the three
      // carry byte-identical names, and the tie-break between them is `tie`'s property, not this
      // row's.
      const { dedupBeforeAuthor } = await loadDedup()
      const corpus = EXPECTATIONS.the393Suite.map(suiteEntry)
      for (const key of EXPECTATIONS.the393Suite) {
        const screening = dedupBeforeAuthor(suiteEntry(key).testName, corpus)
        expect(screening.kind, `${key}'s own name against the whole suite`).toBe('duplicate')
      }
    })

  it('names BOTH continuations on every refusal, out of one closed vocabulary', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    const row = rowNamed('obvious-duplicate')
    const { intent, corpus } = inputsFor(row)
    const screening = dedupBeforeAuthor(intent, corpus)

    if (screening.kind !== 'duplicate') throw new Error('the obvious duplicate must refuse')
    // D-04: refuse-and-link carries the two named continuations. Two, not "at least one" -- a
    // refusal offering only "extend that test" cannot be acted on by an author whose draft is a
    // different assertion about the same flow. The vocabulary is the SCHEMA's, which is the
    // assertion that no second spelling was minted in this package.
    expect(AUTHORING_DEDUP_CONTINUATIONS).toHaveLength(2)
    expect(screening.continuations).toEqual([...AUTHORING_DEDUP_CONTINUATIONS])
    expect(AUTHORING_DEDUP_CONTINUATIONS.join(' ')).toContain('extend')
    expect(AUTHORING_DEDUP_CONTINUATIONS.join(' ')).toContain('assertion')
  })

  it('REFUSES BY RETURNING, never by throwing (a typed op result)', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    const row = rowNamed('obvious-duplicate')
    const { intent, corpus } = inputsFor(row)

    // A throw would make the refusal an error surface, and the op would FAIL rather than answer
    // `refused` with its link. D-04 makes it a result the caller reads and chat renders, which is
    // only checkable by asserting the call returns at all.
    expect(() => dedupBeforeAuthor(intent, corpus)).not.toThrow()
    const screening = dedupBeforeAuthor(intent, corpus)
    if (screening.kind !== 'duplicate') throw new Error('the obvious duplicate must refuse')
    expect(screening.evidence.matchedRef)
      .toBe('demo/init/tests/uat-381-local-form.yaml::Sign in on the local account form')
  })

  it('is deterministic: two screenings of one suite report one duplicate', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    // The tie row is the one that can differ between invocations if the tie-break is dropped, so
    // it is the one worth running twice. Determinism is what makes the frozen corpus a proof at
    // all -- a lane whose answer moved between runs could not be pinned by any table.
    const row = rowNamed('tie')
    const { intent, corpus } = inputsFor(row)
    const first = dedupBeforeAuthor(intent, corpus)
    const second = dedupBeforeAuthor(intent, [...corpus].reverse())
    expect(first).toEqual(second)
  })
})

describe('one scorer, not two', () => {
  it('reports a score adds-value.ts produces for the same pair, not a copy of it', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    // The shared vector: the obvious duplicate against the member it duplicates. If dedup.ts ever
    // grows its own tokenizer or its own Jaccard, the two readings drift and this cell is what
    // notices -- the key link is an import, and an import is what this asserts the behaviour of.
    //
    // The lane scores an intent on TWO comparable axes and keeps the larger, so the reproduction
    // here is over both. Both are `textSimilarity` calls: the axes differ in what is compared, not
    // in how, and a second recipe is what D-16 forbids.
    const entry = suiteEntry('uat-381-local-form')
    const intent = intentTextOf('intents/duplicate.yaml')
    const wholeDocument = textSimilarity({ testName: intent, steps: [] }, entry)
    const nameOnly = textSimilarity(
      { testName: intent, steps: [] },
      { filePath: entry.filePath, testName: entry.testName, stepsText: [] },
    )

    const screening = dedupBeforeAuthor(intent, [entry])
    if (screening.kind !== 'duplicate') throw new Error('the obvious duplicate must refuse')
    expect(screening.evidence.score).toBe(Math.max(wholeDocument, nameOnly))
  })

  it('inherits the two-empty-texts rule rather than re-deriving it', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    const empty = textSimilarity({ testName: '', steps: [] }, EMPTY_TEXT_ENTRY)
    expect(empty).toBe(0)
    const screening = dedupBeforeAuthor('', [EMPTY_TEXT_ENTRY])
    expect(screening.kind).toBe('no-duplicate')
    expect(screening.closest?.similarity).toBe(0)
  })
})
