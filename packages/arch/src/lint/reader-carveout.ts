import type { OwnershipContract } from '../contract-types.js'
import type { SpecifierHit } from './extract-specifiers.js'

const KNOWLEDGE_LOCAL_MAIN_ENTRY = '@vostride/agent-qa-knowledge-local'
const KNOWLEDGE_LOCAL_READER_ENTRY = `${KNOWLEDGE_LOCAL_MAIN_ENTRY}/reader`

// A directory prefix; `findKnowledgeWriterSingletonOffenders` holds it to one file.
export const KNOWLEDGE_WRITER_ALLOWLIST = [
  'packages/agent-local/src/composition/',
] as const

// A path-keyed rule handed one package's files stops covering a file that moves out.
export const READER_CARVEOUT_SCANNED_DIRS = [
  'packages/cli',
  'packages/agent-local',
] as const

export const KNOWLEDGE_READER_FILES = [
  'packages/agent-local/src/composition/knowledge-reader.ts',
  // Inside the writer prefix, so listed here to hold the read port to the reader entry.
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

// The writer entry has exactly one importer in the workspace, and an unused allowance fails.
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
