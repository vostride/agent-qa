import type { OwnershipContract } from '../contract-types.js'
import type { SpecifierHit } from './extract-specifiers.js'

const KNOWLEDGE_LOCAL_MAIN_ENTRY = '@vostride/agent-qa-knowledge-local'
const KNOWLEDGE_LOCAL_READER_ENTRY = `${KNOWLEDGE_LOCAL_MAIN_ENTRY}/reader`

/**
 * Where the knowledge package's writer-gated main entry may be named at all.
 *
 * 2026-07-29 (Phase 385 plan 09, D-14/SC5): shrunk from two CLI entries to one. Every writer power
 * the curation surfaces used is now taken off the local host's capabilities, so the surface names
 * the composition root and the composition root names the writer.
 *
 * A trailing slash makes an entry a directory PREFIX, and that is what this one is — it says where
 * the naming may live, matching the location shape of the sibling composition carve-out. It does
 * NOT say how many files may do it, so on its own it would pass with five importers in the subtree
 * while SC5's "the single place" was false. `findKnowledgeWriterSingletonOffenders` below is what
 * makes the claim the phase actually asserts enforceable, at file granularity.
 */
export const KNOWLEDGE_WRITER_ALLOWLIST = [
  'packages/agent-local/src/composition/',
] as const

/**
 * The packages whose sources this carve-out is scanned over. 2026-07-29:
 * the local agent package joins the CLI, because the reader binding moved there with the run
 * composition. A path-keyed rule that is only ever handed one package's files silently stops
 * covering a file the moment that file moves — the rule would still pass, and would still read
 * like proof.
 */
export const READER_CARVEOUT_SCANNED_DIRS = [
  'packages/cli',
  'packages/agent-local',
] as const

export const KNOWLEDGE_READER_FILES = [
  // relocated out of the CLI with the run composition.
  'packages/agent-local/src/composition/knowledge-reader.ts',
  // the function layer's knowledge READ port. It sits
  // inside the writer allow-list's directory prefix, so without this row the subtree's own
  // allowance would have let the five read verbs name the writer entry and every gate would
  // have stayed green. Listing it here inverts that: the file is held to /reader, and the
  // ledger write its D-01 sighting site performs is injected by the composition root instead.
  'packages/agent-local/src/composition/knowledge-review-reader.ts',
  'packages/cli/src/commands/knowledge-read.ts',
] as const

const KNOWLEDGE_LOCAL_WALL_RATIONALES = {
  'packages/eval': 'replay-hermeticity',
  'packages/eval-local': 'replay-hermeticity',
  'packages/dashboard-server': 'spawn-until-M5',
  'packages/runner': 'port-type-only',
} as const

function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/')
}

function isKnowledgeLocalSpecifier(specifier: string): boolean {
  return specifier === KNOWLEDGE_LOCAL_MAIN_ENTRY
    || specifier.startsWith(`${KNOWLEDGE_LOCAL_MAIN_ENTRY}/`)
}

function isWriterFile(file: string): boolean {
  return KNOWLEDGE_WRITER_ALLOWLIST.some((entry) => (
    entry.endsWith('/') ? file.startsWith(entry) : file === entry
  ))
}

function isReaderFile(file: string): boolean {
  return KNOWLEDGE_READER_FILES.includes(file as (typeof KNOWLEDGE_READER_FILES)[number])
}

export function findReaderCarveoutOffenders(hits: readonly SpecifierHit[]): string[] {
  const offenders: string[] = []

  for (const hit of hits) {
    const file = normalizeRepoPath(hit.file)

    if (
      isReaderFile(file)
      && isKnowledgeLocalSpecifier(hit.specifier)
      && hit.specifier !== KNOWLEDGE_LOCAL_READER_ENTRY
    ) {
      offenders.push(
        `reader-carveout: ${file}:${hit.line} ⇏ ${hit.specifier} (reader file requires /reader)`,
      )
      continue
    }

    if (hit.specifier === KNOWLEDGE_LOCAL_MAIN_ENTRY && !isWriterFile(file)) {
      offenders.push(
        `reader-carveout: ${file}:${hit.line} ⇏ ${hit.specifier} (main entry requires writer allowlist)`,
      )
    }
  }

  return offenders
}

/**
 * SC5, as a rule rather than as a sentence: the writer entry has EXACTLY ONE importer.
 *
 * Two directions, and both of them fail.
 *
 *   1. More than one allow-listed file names the main entry. The allow-list is a directory prefix,
 *      so without this the subtree could accumulate importers indefinitely and every gate would
 *      stay green while "the single place `composeLocalAgent()` imports it" quietly stopped being
 *      true. This is the direction the phase's own success criterion rests on.
 *   2. NO file names it. A shrunken allow-list that matches nothing is the way this kind of rule
 *      usually dies: it passes forever, checks nothing, and reads like proof. An allowance nobody
 *      uses is therefore an offender, exactly as in the composition carve-out — and it doubles as
 *      the guard against a mistyped prefix, because a wrong prefix leaves the real importer
 *      unallowed (direction "main entry requires writer allowlist" above) AND the allowance unused.
 *
 * Takes the union of hits across every scanned package rather than one package's, because "exactly
 * one in the workspace" cannot be decided from a slice of it.
 */
export function findKnowledgeWriterSingletonOffenders(hits: readonly SpecifierHit[]): string[] {
  const importers = new Set<string>()

  for (const hit of hits) {
    if (hit.specifier !== KNOWLEDGE_LOCAL_MAIN_ENTRY) continue
    const file = normalizeRepoPath(hit.file)
    if (isWriterFile(file)) importers.add(file)
  }

  if (importers.size === 0) {
    return [
      `reader-carveout: the knowledge writer allowance [${KNOWLEDGE_WRITER_ALLOWLIST.join(', ')}]`
      + ` is used by no file — either the prefix is wrong or the last importer left, and an`
      + ' allowance nothing uses is a rule that cannot fail',
    ]
  }

  if (importers.size === 1) return []

  return [...importers].sort().map((file) => (
    `reader-carveout: ${file} ⇏ ${KNOWLEDGE_LOCAL_MAIN_ENTRY}`
    + ` (${String(importers.size)} importers; SC5 requires exactly one — the local composition root)`
  ))
}

export function findKnowledgeLocalWallOffenders(
  contract: OwnershipContract,
  hits: readonly SpecifierHit[],
): string[] {
  const rationale = KNOWLEDGE_LOCAL_WALL_RATIONALES[
    contract.packageDir as keyof typeof KNOWLEDGE_LOCAL_WALL_RATIONALES
  ]
  if (rationale === undefined) return []

  return hits
    .filter(hit => isKnowledgeLocalSpecifier(hit.specifier))
    .map((hit) => {
      const file = normalizeRepoPath(hit.file)
      return `knowledge-local-wall: ${contract.packageDir} (${rationale}) ⇏ ${hit.specifier} at ${file}:${hit.line}`
    })
}
