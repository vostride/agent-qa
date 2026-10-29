// KREV-01's "no new memidex code" claim, as a check rather than as a sentence (Phase 387-06).
//
// The four read verbs are supposed to be WIRING over functions the read-only reader entry
// already exports. That is a claim about what the op files DO, and nothing about a green
// behaviour suite could distinguish an op that called through the port from one that had
// quietly grown its own query — both would return rows.
//
// Three claims are checked here, each over the executable text of the real op files:
//
//   1. No op reaches for memidex query machinery. A verb that opened a reader, walked index
//      rows or built a MATCH expression would be a second place records are selected, and the
//      two would answer differently the first time either changed.
//   2. No op mints. D-01's sighting site is the COMPOSITION, so an op that touched the
//      addressing ledger would make a read verb a write to the one durable store this system
//      never rebuilds — and it would do so from a package that is storageNeutral and cannot
//      even see the file it was writing to.
//   3. No op recomputes trust. Every trust-shaped field is derived behind the port; an op that
//      re-derived one would publish a second opinion about a number the store already folded.
//
// Both controls are run, because a scan is only evidence if it can fail and only usable if it
// does not fail on the reasoning that explains it.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { scanFile, scanText } from './op-source-scan.js'

const OPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops')

const READ_OP_FILES = [
  'knowledge-bundles-list.ts',
  'knowledge-records-inspect.ts',
  'knowledge-records-diff.ts',
  'knowledge-record-show.ts',
] as const

/**
 * Memidex query machinery. Not the port's verb names — `inspectRecords` is what the op CALLS
 * and naming it is the whole point — but the things a verb would reach for if it were doing
 * the selecting itself.
 */
const MEMIDEX_MACHINERY = [
  'openKnowledgeReader',
  'readIndexRows',
  'hydrateRows',
  'retrieve(',
  'lexicalLeg',
  'denseLeg',
  'anchorSeedLeg',
  'fuseWeightedRrf',
  'admitCandidate',
  'enumerateMaintenanceBundleDirs',
  'loadMaintenanceBundle',
  'fts_records',
  'SELECT ',
  'MATCH ',
] as const

/** The addressing ledger's write vocabulary. D-01's sighting site is the composition. */
const LEDGER_WRITES = [
  'openAddressingLedger',
  'sightEntity',
  '.mint(',
  'recordTargetRename',
] as const

/** Trust is DERIVED behind the port; an op renders what it is handed. */
const TRUST_DERIVATION = [
  'deriveBundleTrust',
  'isServable',
  'survivingOutcomeEvents',
] as const

const FORBIDDEN = [...MEMIDEX_MACHINERY, ...LEDGER_WRITES, ...TRUST_DERIVATION]

describe('the scanner can fail and does not fail on prose (the two controls)', () => {
  it('POSITIVE CONTROL: a planted violation of every forbidden term is caught', () => {
    for (const term of FORBIDDEN) {
      // Planted as executable text, one term at a time, so a scanner that happened to catch
      // one term is not credited with catching the rest.
      const planted = `const outcome = wrapper${term}argument\n`
      expect(scanText(planted, FORBIDDEN).hits, term).not.toHaveLength(0)
    }
  })

  it('INVERSE CONTROL: prose naming every forbidden term is NOT flagged', () => {
    const prose = [
      '// This verb does not call openKnowledgeReader, readIndexRows or hydrateRows, and it',
      '// never builds a SELECT or a MATCH over fts_records. It runs no lexicalLeg, no denseLeg,',
      '// no anchorSeedLeg, no fuseWeightedRrf and no admitCandidate; it does not call retrieve(',
      '// or enumerateMaintenanceBundleDirs or loadMaintenanceBundle.',
      '/*',
      ' * It also does not call openAddressingLedger or sightEntity, never reaches .mint( and',
      ' * never calls recordTargetRename. Trust is not recomputed: no deriveBundleTrust, no',
      ' * isServable, no survivingOutcomeEvents.',
      ' */',
      'const answer = await deps.knowledge.inspectRecords(input)',
    ].join('\n')

    const scan = scanText(prose, FORBIDDEN)

    expect(scan.hits).toEqual([])
    // The half that separates "nothing was flagged" from "nothing was read": the scanner found
    // the one executable statement in that block and dropped the nine comment lines.
    expect(scan.statements).toEqual(['const answer = await deps.knowledge.inspectRecords(input)'])
  })

  it('does not flag a forbidden term that appears only inside a string literal', () => {
    // An op declares its id and its risk name as literals. A term inside one is a name, never
    // a call, and a scanner that could not tell the two apart would forbid honest naming.
    const scan = scanText("const id = 'openKnowledgeReader'\n", FORBIDDEN)
    expect(scan.hits).toEqual([])
  })
})

describe('every read verb is wiring over the reader entry', () => {
  for (const file of READ_OP_FILES) {
    it(`${file} reaches for no memidex machinery, no ledger write and no trust fold`, () => {
      const scan = scanFile(join(OPS_DIR, file), FORBIDDEN)

      // Read-and-non-empty first: a scan of an unreadable or empty file finds no offenders and
      // reads exactly like a pass.
      expect(scan.statements.length, file).toBeGreaterThan(10)
      expect(scan.hits, file).toEqual([])
    })

    it(`${file} dispatches through the injected knowledge port`, () => {
      const scan = scanFile(join(OPS_DIR, file), [])

      // The positive half of the same claim: the file does not merely avoid the forbidden
      // vocabulary (an empty file would), it actually calls through the port. Without this,
      // the check above would pass for an op that computed its answer out of thin air.
      expect(scan.statements.some((statement) => statement.includes('deps.knowledge.')), file)
        .toBe(true)
    })
  }
})
