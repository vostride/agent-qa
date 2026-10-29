// Each intent is a one-line utterance read from a fixture, the shape `dedupBeforeAuthor` receives.

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

// Mirrors `scoreIntentAgainst`'s name-only half through the imported `textSimilarity`.
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
    // The re-mint replaced inputs and vectors, never the properties the row ids claim.
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
      // The name axis alone cannot reach this row's verdict.
      expect(nameAxisTop(row), `${row.id} must be decided on the DOCUMENT axis: the name axis `
        + 'alone cannot reach its frozen score, which is what places it outside the assumption')
        .toBeLessThan(row.score ?? 0)
    }
  })

  it('discrimination control: the SAME axis computation reads a name-decided row the other way',
    () => {
      // Control: a name-decided row, so `nameAxisTop` cannot pass vacuously for every row.
      const nameDecided = rowNamed('unfingerprinted-duplicate')
      expect(nameAxisTop(nameDecided), 'the name axis DECIDES this row, so it must reach the '
        + 'frozen score rather than fall short of it')
        .toBeGreaterThanOrEqual(nameDecided.score ?? 0)
    })
})

// Agent cannot import the ids package, so the schema's `test-id` rule is spelled here in full.
const CANONICAL_TEST_ID = /^t_[a-z0-9]+(-[a-z0-9]+){9}$/u

describe('every corpus fixture is what its side of the comparison actually receives', () => {
  // Core is off limits here, so suite documents are checked as YAML; cli runs the parser on them.
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
    // Stage 2 and gate 3 must screen the same suite documents, and only this cell sees a drift.
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
    // A test's own name as the intent is the strongest duplicate signal, so the lane refuses it.
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
    // Two continuations, so an author whose draft is a different assertion can still act.
    expect(AUTHORING_DEDUP_CONTINUATIONS).toHaveLength(2)
    expect(screening.continuations).toEqual([...AUTHORING_DEDUP_CONTINUATIONS])
    expect(AUTHORING_DEDUP_CONTINUATIONS.join(' ')).toContain('extend')
    expect(AUTHORING_DEDUP_CONTINUATIONS.join(' ')).toContain('assertion')
  })

  it('REFUSES BY RETURNING, never by throwing (a typed op result)', async () => {
    const { dedupBeforeAuthor } = await loadDedup()
    const row = rowNamed('obvious-duplicate')
    const { intent, corpus } = inputsFor(row)

    // A refusal is a result the caller reads, not a throw that fails the op.
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
    // Shares `textSimilarity` with the lane, so a private tokenizer in `dedup.ts` would drift here.
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
