import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { canonicalJson, slugBranch } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import { durableRename, fsyncDirectory, fsyncFile, fsyncTree } from '../durable-fs.js'
import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'

export const BUNDLE_MUTATION_JOURNAL_VERSION = 2

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOURNAL_FILE = 'mutation.json'
const RECOVERY_DIR = 'recovery'
const DIRECT_LIBRARY_LEASE_ID = 'direct-library'
// Canonical order with `manifest.json` last; `evidence/gates.jsonl` exists after a receipt append.
// prettier-ignore
export const MUTABLE_BUNDLE_TARGETS = ['record.md', 'provenance.json', 'evidence/outcomes.jsonl', 'evidence/measurements.json', 'evidence/gates.jsonl', 'relations.json', 'manifest.json'] as const
const MUTABLE_TARGETS = new Set<string>(MUTABLE_BUNDLE_TARGETS)

const journalReplacementSchema = z
  .object({
    targetRelPath: z.string().min(1),
    recoveryRelPath: z.string().min(1),
    sha256: z.string().regex(SHA256),
    manifest: z.boolean(),
  })
  .strict()

const bundleMutationJournalSchema = z
  .object({
    version: z.literal(BUNDLE_MUTATION_JOURNAL_VERSION),
    leaseId: z.string().min(1),
    bundleId: z.string().min(1),
    replacements: z.array(journalReplacementSchema).min(2),
  })
  .strict()

type BundleMutationJournal = z.infer<typeof bundleMutationJournalSchema>

export interface BundleMutationInput {
  knowledgeRoot: string
  bundleDir: string
  bundleId: string
  writerLeaseId?: string
  replacements: readonly {
    targetRelPath: string
    text: string
  }[]
  afterMutableReplacement?: (targetRelPath: string) => void
}

export interface BundleMutationRecoveryReport {
  mutationsRecovered: number
  recoveredBundleIds: string[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${label} must be a safe path segment`)
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertBundleLocation(knowledgeRoot: string, bundleDir: string, bundleId: string): void {
  if (!isAbsolute(knowledgeRoot) || !isAbsolute(bundleDir)) {
    throw new TypeError('knowledgeRoot and bundleDir must be absolute')
  }
  if (!isWithin(knowledgeRoot, bundleDir)) {
    throw new TypeError('bundleDir must remain inside knowledgeRoot')
  }
  if (slugBranch(bundleId) !== bundleId) {
    throw new TypeError('bundleId must already be a canonical path segment')
  }
  if (basename(bundleDir) !== slugBranch(bundleId)) {
    throw new TypeError('bundleDir must end with the canonical bundle id')
  }
  const rel = relative(resolve(knowledgeRoot), resolve(bundleDir)).split(sep)
  if (rel.length !== 4 || rel[0] !== 'memory' || rel[2] !== 'bundles') {
    throw new TypeError('bundleDir must use the canonical memory/<product>/bundles/<id> layout')
  }
  // The checks above are lexical; a directory linked out of the root is refused before any write.
  assertWithinKnowledgeRoot(knowledgeRoot, bundleDir)
  assertWithinKnowledgeRoot(knowledgeRoot, join(dirname(bundleDir), '.staging'))
}

function assertTargetsContained(
  knowledgeRoot: string,
  bundleDir: string,
  targetRelPaths: readonly string[],
): void {
  for (const targetRelPath of targetRelPaths) {
    assertWithinKnowledgeRoot(knowledgeRoot, dirname(join(bundleDir, targetRelPath)))
  }
}

function assertMutableTarget(targetRelPath: string): void {
  if (!MUTABLE_TARGETS.has(targetRelPath)) {
    throw new TypeError(`unsupported mutable bundle target: ${targetRelPath}`)
  }
  if (isAbsolute(targetRelPath) || targetRelPath.includes('\\')) {
    throw new TypeError(`mutable bundle target must be relative: ${targetRelPath}`)
  }
}

function recoveryRelPath(index: number): string {
  return `${RECOVERY_DIR}/${String(index).padStart(4, '0')}`
}

function validateJournalSemantics(journal: BundleMutationJournal): void {
  assertSafeSegment(journal.leaseId, 'mutation leaseId')
  if (slugBranch(journal.bundleId) !== journal.bundleId) {
    throw new TypeError('mutation bundleId must already be a canonical path segment')
  }

  const targets = new Set<string>()
  for (const [index, replacement] of journal.replacements.entries()) {
    assertMutableTarget(replacement.targetRelPath)
    if (targets.has(replacement.targetRelPath)) {
      throw new TypeError(`duplicate mutable bundle target: ${replacement.targetRelPath}`)
    }
    targets.add(replacement.targetRelPath)
    if (replacement.recoveryRelPath !== recoveryRelPath(index)) {
      throw new TypeError('mutation recovery paths must be canonical and ordered')
    }
    const isManifest = replacement.targetRelPath === 'manifest.json'
    if (replacement.manifest !== isManifest) {
      throw new TypeError('mutation manifest marker must match manifest.json')
    }
    if (isManifest !== (index === journal.replacements.length - 1)) {
      throw new TypeError('mutation manifest replacement must be last')
    }
  }
}

function parseCanonicalJournal(transactionDir: string): BundleMutationJournal {
  const text = readFileSync(join(transactionDir, JOURNAL_FILE), 'utf8')
  const journal = bundleMutationJournalSchema.parse(JSON.parse(text))
  validateJournalSemantics(journal)
  if (text !== `${canonicalJson(journal)}\n`) {
    throw new TypeError('mutation journal must use canonical JSON bytes')
  }
  return journal
}

function assertTransactionName(
  transactionDir: string,
  journal: BundleMutationJournal,
): void {
  const prefix = `${journal.leaseId}-mutation-${journal.bundleId}-`
  const name = basename(transactionDir)
  if (!name.startsWith(prefix) || !UUID.test(name.slice(prefix.length))) {
    throw new TypeError('mutation directory name does not bind its lease and bundle')
  }
}

function readRecoveryPayloads(
  transactionDir: string,
  journal: BundleMutationJournal,
): Buffer[] {
  const rootEntries = readdirSync(transactionDir, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'x'}:${entry.name}`)
    .sort()
  if (canonicalJson(rootEntries) !== canonicalJson(['d:recovery', 'f:mutation.json'])) {
    throw new TypeError('mutation directory contains unexpected entries')
  }

  const recoveryRoot = join(transactionDir, RECOVERY_DIR)
  const expectedNames = journal.replacements.map((_replacement, index) =>
    basename(recoveryRelPath(index)),
  )
  const actualEntries = readdirSync(recoveryRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  if (
    actualEntries.some((entry) => !entry.isFile())
    || canonicalJson(actualEntries.map((entry) => entry.name)) !== canonicalJson(expectedNames)
  ) {
    throw new TypeError('mutation recovery set is incomplete or contains unexpected entries')
  }

  return journal.replacements.map((replacement) => {
    const recoveryPath = join(transactionDir, replacement.recoveryRelPath)
    if (!isWithin(transactionDir, recoveryPath)) {
      throw new TypeError('mutation recovery path escapes its transaction')
    }
    const bytes = readFileSync(recoveryPath)
    if (sha256(bytes) !== replacement.sha256) {
      throw new TypeError(`mutation recovery digest mismatch: ${replacement.targetRelPath}`)
    }
    return bytes
  })
}

function applyJournal(
  bundleDir: string,
  transactionDir: string,
  journal: BundleMutationJournal,
  afterMutableReplacement?: (targetRelPath: string) => void,
): void {
  const recoveryPayloads = readRecoveryPayloads(transactionDir, journal)

  for (const [index, replacement] of journal.replacements.entries()) {
    const target = join(bundleDir, replacement.targetRelPath)
    if (!isWithin(bundleDir, target)) {
      throw new TypeError('mutation target escapes its bundle')
    }
    const temporary = join(
      dirname(target),
      `.${basename(target)}.mutation-${randomUUID()}.tmp`,
    )
    try {
      writeFileSync(temporary, recoveryPayloads[index]!, { flag: 'wx' })
      fsyncFile(temporary)
      durableRename(temporary, target)
    } finally {
      if (existsSync(temporary)) {
        rmSync(temporary, { force: true })
        fsyncDirectory(dirname(temporary))
      }
    }
    afterMutableReplacement?.(replacement.targetRelPath)
  }

  for (const replacement of journal.replacements) {
    if (sha256(readFileSync(join(bundleDir, replacement.targetRelPath))) !== replacement.sha256) {
      throw new TypeError(`mutation destination digest mismatch: ${replacement.targetRelPath}`)
    }
  }
}

function removeEmptyStagingRoot(stagingRoot: string): void {
  let removed = false
  try {
    rmdirSync(stagingRoot)
    removed = true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
  if (removed) fsyncDirectory(dirname(stagingRoot))
}

function removeCompletedTransaction(transactionDir: string): void {
  const stagingRoot = dirname(transactionDir)
  rmSync(transactionDir, { recursive: true, force: true })
  fsyncDirectory(stagingRoot)
  removeEmptyStagingRoot(stagingRoot)
}

function orderedReplacements(
  replacements: BundleMutationInput['replacements'],
): BundleMutationInput['replacements'] {
  const manifests = replacements.filter(({ targetRelPath }) => targetRelPath === 'manifest.json')
  if (manifests.length !== 1) {
    throw new TypeError('bundle mutation requires exactly one manifest.json replacement')
  }
  const ordered = [
    ...replacements.filter(({ targetRelPath }) => targetRelPath !== 'manifest.json'),
    manifests[0]!,
  ]
  if (ordered.length < 2) {
    throw new TypeError('bundle mutation requires at least one target before manifest.json')
  }
  const targets = new Set<string>()
  for (const replacement of ordered) {
    assertMutableTarget(replacement.targetRelPath)
    if (targets.has(replacement.targetRelPath)) {
      throw new TypeError(`duplicate mutable bundle target: ${replacement.targetRelPath}`)
    }
    targets.add(replacement.targetRelPath)
  }
  return ordered
}

/** Commit one immutable, lease-attributed replacement set and expose manifest.json last. */
export function commitBundleMutation(input: BundleMutationInput): void {
  assertBundleLocation(input.knowledgeRoot, input.bundleDir, input.bundleId)
  const leaseId = input.writerLeaseId ?? DIRECT_LIBRARY_LEASE_ID
  assertSafeSegment(leaseId, 'writerLeaseId')
  const replacements = orderedReplacements(input.replacements)
  assertTargetsContained(input.knowledgeRoot, input.bundleDir,
    replacements.map((replacement) => replacement.targetRelPath))
  const bundlesDir = dirname(input.bundleDir)
  const stagingRoot = join(bundlesDir, '.staging')
  const transactionDir = join(
    stagingRoot,
    `${leaseId}-mutation-${input.bundleId}-${randomUUID()}`,
  )
  const recoveryRoot = join(transactionDir, RECOVERY_DIR)
  let journalDurable = false

  mkdirSync(recoveryRoot, { recursive: true })
  fsyncDirectory(bundlesDir)
  fsyncDirectory(stagingRoot)

  try {
    const journal: BundleMutationJournal = {
      version: BUNDLE_MUTATION_JOURNAL_VERSION,
      leaseId,
      bundleId: input.bundleId,
      replacements: replacements.map((replacement, index) => {
        const bytes = Buffer.from(replacement.text)
        const relPath = recoveryRelPath(index)
        writeFileSync(join(transactionDir, relPath), bytes, { flag: 'wx' })
        return {
          targetRelPath: replacement.targetRelPath,
          recoveryRelPath: relPath,
          sha256: sha256(bytes),
          manifest: replacement.targetRelPath === 'manifest.json',
        }
      }),
    }
    validateJournalSemantics(journal)
    writeFileSync(join(transactionDir, JOURNAL_FILE), `${canonicalJson(journal)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    fsyncTree(transactionDir)
    fsyncDirectory(stagingRoot)
    journalDurable = true

    applyJournal(
      input.bundleDir,
      transactionDir,
      journal,
      input.afterMutableReplacement,
    )
    removeCompletedTransaction(transactionDir)
  } catch (error) {
    if (!journalDurable) removeCompletedTransaction(transactionDir)
    throw error
  }
}

function listMutationRoots(knowledgeRoot: string): string[] {
  if (!isAbsolute(knowledgeRoot)) throw new TypeError('knowledgeRoot must be absolute')
  const memoryRoot = join(knowledgeRoot, 'memory')
  let products: Dirent<string>[]
  try {
    products = readdirSync(memoryRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return products
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(memoryRoot, entry.name, 'bundles', '.staging'))
    .filter((stagingRoot) => existsSync(stagingRoot))
    .sort()
}

function matchingExpiredLease(name: string, expiredLeaseIds: readonly string[]): string | undefined {
  return expiredLeaseIds.find((leaseId) => name.startsWith(`${leaseId}-mutation-`))
}

/** Replay complete mutation journals owned by expired writers and preserve malformed evidence. */
export function recoverExpiredBundleMutations(
  knowledgeRoot: string,
  expiredLeaseIds: readonly string[],
): BundleMutationRecoveryReport {
  const leases = [...new Set(expiredLeaseIds)].sort((left, right) =>
    right.length - left.length || left.localeCompare(right),
  )
  for (const leaseId of leases) assertSafeSegment(leaseId, 'expired leaseId')

  const recoveredBundleIds: string[] = []
  for (const stagingRoot of listMutationRoots(knowledgeRoot)) {
    const entries = readdirSync(stagingRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) {
      const expectedLeaseId = matchingExpiredLease(entry.name, leases)
      if (expectedLeaseId === undefined) continue
      if (!entry.isDirectory()) {
        throw new TypeError(`expired mutation entry must be a directory: ${entry.name}`)
      }

      const transactionDir = join(stagingRoot, entry.name)
      const journal = parseCanonicalJournal(transactionDir)
      assertTransactionName(transactionDir, journal)
      if (journal.leaseId !== expectedLeaseId) {
        throw new TypeError('mutation journal lease does not match its expired owner')
      }
      const bundleDir = join(dirname(stagingRoot), journal.bundleId)
      assertBundleLocation(knowledgeRoot, bundleDir, journal.bundleId)
      assertTargetsContained(knowledgeRoot, bundleDir,
        journal.replacements.map((replacement) => replacement.targetRelPath))
      applyJournal(bundleDir, transactionDir, journal)
      removeCompletedTransaction(transactionDir)
      recoveredBundleIds.push(journal.bundleId)
    }
  }

  return {
    mutationsRecovered: recoveredBundleIds.length,
    recoveredBundleIds,
  }
}
