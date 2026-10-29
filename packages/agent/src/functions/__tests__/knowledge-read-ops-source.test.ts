// The read ops are wiring: no memidex query, no ledger write and no trust recomputation.

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

// The addressing ledger's write vocabulary; sightings are minted by the composition.
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
