import { describe, expect, it } from 'vitest'

import type { OwnershipContract } from '../../contract-types.js'
import type { SpecifierHit } from '../extract-specifiers.js'
import {
  findKnowledgeLocalWallOffenders,
  findKnowledgeWriterSingletonOffenders,
  findReaderCarveoutOffenders,
  KNOWLEDGE_READER_FILES,
  KNOWLEDGE_WRITER_ALLOWLIST,
} from '../reader-carveout.js'

const MAIN_ENTRY = '@vostride/agent-qa-knowledge-local'
const READER_ENTRY = `${MAIN_ENTRY}/reader`
const RELOCATED_READER_FILE = KNOWLEDGE_READER_FILES[0]
/** The one file the allowance is for. Spelled through the shipped prefix, not repeated. */
const COMPOSITION_ROOT = `${KNOWLEDGE_WRITER_ALLOWLIST[0]}compose-local-agent.ts`

function fixtureHit(
  specifier: string,
  file: string,
  line = 1,
): SpecifierHit {
  return { specifier, file, line }
}

function fixtureContract(packageDir: string): OwnershipContract {
  return {
    packageName: `@vostride/agent-qa-${packageDir.replace('packages/', '')}`,
    packageDir,
    packageClasses: ['providerNeutral'],
    allowedResponsibilities: [],
    forbiddenResponsibilities: [],
    externalDependencies: [],
    internalDependencies: [],
  }
}

describe('reader carve-out', () => {
  it('rejects the write-capable main entry outside the pinned writer allowlist', () => {
    expect(KNOWLEDGE_WRITER_ALLOWLIST).toEqual(['packages/agent-local/src/composition/'])
    expect(findReaderCarveoutOffenders([
      fixtureHit(MAIN_ENTRY, 'packages/cli/src/curation/curation-tail.ts', 17),
    ])).toEqual([
      `reader-carveout: packages/cli/src/curation/curation-tail.ts:17 ⇏ ${MAIN_ENTRY} (main entry requires writer allowlist)`,
    ])
  })

  it('rejects non-reader knowledge-local imports from either pinned reader file', () => {
    // The path is spelled through the shipped pin, so a relocation updates one place.
    expect(findReaderCarveoutOffenders([
      fixtureHit(MAIN_ENTRY, RELOCATED_READER_FILE, 1),
      fixtureHit(`${MAIN_ENTRY}/index-reader`, 'packages/cli/src/commands/knowledge-read.ts', 7),
    ])).toEqual([
      `reader-carveout: ${RELOCATED_READER_FILE}:1 ⇏ ${MAIN_ENTRY} (reader file requires /reader)`,
      `reader-carveout: packages/cli/src/commands/knowledge-read.ts:7 ⇏ ${MAIN_ENTRY}/index-reader (reader file requires /reader)`,
    ])
  })

  it('accepts the pinned writer file and read-only reader imports', () => {
    expect(findReaderCarveoutOffenders([
      fixtureHit(MAIN_ENTRY, COMPOSITION_ROOT),
      fixtureHit(READER_ENTRY, RELOCATED_READER_FILE),
      fixtureHit(READER_ENTRY, 'packages/cli/src/commands/knowledge-read.ts'),
    ])).toEqual([])
  })
})

// The prefix alone admits any number of importers, so these cases fail on a second one.
describe('the knowledge writer has exactly one importer', () => {
  it('accepts the one composition root, alongside any number of reader-entry imports', () => {
    expect(findKnowledgeWriterSingletonOffenders([
      fixtureHit(MAIN_ENTRY, COMPOSITION_ROOT, 40),
      fixtureHit(READER_ENTRY, COMPOSITION_ROOT, 41),
      fixtureHit(READER_ENTRY, 'packages/cli/src/commands/knowledge-read.ts', 7),
      fixtureHit(`${MAIN_ENTRY}/index-reader`, 'packages/agent-local/src/store/logical-dump.ts', 3),
    ])).toEqual([])
  })

  it('accepts many statements in the SAME file — the claim is about files, not lines', () => {
    expect(findKnowledgeWriterSingletonOffenders([
      fixtureHit(MAIN_ENTRY, COMPOSITION_ROOT, 40),
      fixtureHit(MAIN_ENTRY, COMPOSITION_ROOT, 93),
    ])).toEqual([])
  })

  it('rejects a SECOND importer inside the allowed subtree, naming both', () => {
    const sibling = `${KNOWLEDGE_WRITER_ALLOWLIST[0]}compose-job-recovery.ts`
    const offenders = findKnowledgeWriterSingletonOffenders([
      fixtureHit(MAIN_ENTRY, COMPOSITION_ROOT, 40),
      fixtureHit(MAIN_ENTRY, sibling, 12),
    ])

    // Sorted, so the report is stable whichever order the scan walked the files in.
    expect(offenders).toEqual([
      `reader-carveout: ${sibling} ⇏ ${MAIN_ENTRY}`
      + ' (2 importers; SC5 requires exactly one — the local composition root)',
      `reader-carveout: ${COMPOSITION_ROOT} ⇏ ${MAIN_ENTRY}`
      + ' (2 importers; SC5 requires exactly one — the local composition root)',
    ])
  })

  it('rejects an allowance no file uses — a shrink that matches nothing cannot fail', () => {
    // The anti-vacuity direction. A rule whose scope is empty passes every build forever and reads
    // like proof, and that is the failure mode a one-entry allow-list is most exposed to.
    expect(findKnowledgeWriterSingletonOffenders([
      fixtureHit(READER_ENTRY, 'packages/cli/src/commands/knowledge-read.ts', 7),
    ])).toEqual([
      'reader-carveout: the knowledge writer allowance [packages/agent-local/src/composition/]'
      + ' is used by no file — either the prefix is wrong or the last importer left, and an'
      + ' allowance nothing uses is a rule that cannot fail',
    ])
  })

  it('does NOT count an importer outside the allowance towards the one it permits', () => {
    // Otherwise a leak in the CLI would satisfy the singleton rule and the whole allowance could be
    // pointing nowhere. `findReaderCarveoutOffenders` reports that file separately; here it must
    // leave the allowance unused.
    expect(findKnowledgeWriterSingletonOffenders([
      fixtureHit(MAIN_ENTRY, 'packages/cli/src/curation/curation-tail.ts', 17),
    ])).toEqual([
      'reader-carveout: the knowledge writer allowance [packages/agent-local/src/composition/]'
      + ' is used by no file — either the prefix is wrong or the last importer left, and an'
      + ' allowance nothing uses is a rule that cannot fail',
    ])
  })
})

describe('knowledge-local negative package walls', () => {
  it.each([
    ['packages/eval', READER_ENTRY, 'replay-hermeticity'],
    ['packages/eval-local', `${MAIN_ENTRY}/deep/path`, 'replay-hermeticity'],
    ['packages/dashboard-server', MAIN_ENTRY, 'spawn-until-M5'],
    ['packages/runner', READER_ENTRY, 'port-type-only'],
  ])('rejects %s imports from every knowledge-local entry', (packageDir, specifier, rationale) => {
    const file = `${packageDir}/src/fixture.ts`
    expect(findKnowledgeLocalWallOffenders(
      fixtureContract(packageDir),
      [fixtureHit(specifier, file, 9)],
    )).toEqual([
      `knowledge-local-wall: ${packageDir} (${rationale}) ⇏ ${specifier} at ${file}:9`,
    ])
  })

  it('ignores knowledge-local imports in packages outside the negative walls', () => {
    expect(findKnowledgeLocalWallOffenders(
      fixtureContract('packages/cli'),
      [fixtureHit(MAIN_ENTRY, 'packages/cli/src/curation/curation-tail.ts')],
    )).toEqual([])
  })
})
