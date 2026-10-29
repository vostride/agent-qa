// Keyed by content digest, so an edited draft cannot inherit the verdict its earlier bytes earned.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt } from '@vostride/agent-qa-schema'

import { durableRename, fsyncDirectory, fsyncFile } from '../durable-fs.js'

/** The one directory name receipts live under, beneath the agent-qa runtime root. */
export const DRAFT_RECEIPTS_DIR_NAME = 'draft-receipts'

/** The durable name shape, and the in-flight sibling that is never a receipt. */
const RECEIPT_SUFFIX = '.json'
const TEMP_SUFFIX = '.tmp'

// A caller's digest becomes a filename, so the shape excludes separators, parent dirs and dotfiles.
const SAFE_DIGEST = /^[A-Za-z0-9_-]{1,128}$/

/** Thrown when a content digest could not be safely turned into a filename. */
export class DraftReceiptDigestError extends Error {
  constructor(readonly contentDigest: string) {
    super(
      'A draft receipt content digest must be 1-128 characters of [A-Za-z0-9_-]; '
      + `refusing to address ${JSON.stringify(contentDigest)}`,
    )
    this.name = 'DraftReceiptDigestError'
  }
}

/** Thrown when a persisted receipt was written under a different schema version. */
export class DraftReceiptSchemaVersionError extends Error {
  constructor(
    readonly path: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Draft receipt at ${path} declares schemaVersion ${String(foundVersion)}, but this build `
      + `reads version ${CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION}`,
    )
    this.name = 'DraftReceiptSchemaVersionError'
  }
}

export interface DraftReceiptsStoreOptions {
  /**
   * Where receipts are durable — `<configDir>/.agent-qa`. A FACTORY on the `createProposalsInbox`
   * precedent: the CLI resolves its root asynchronously and per call, so closing over one resolved
   * value would cache a fact this module does not own.
   */
  readonly resolveAgentQaRoot: () => Promise<string> | string
}

export interface DraftReceiptsStore {
  /** Persist a receipt under its own `draftRef.contentDigest`. Create-on-first-write. */
  put(receipt: DraftReceipt): Promise<void>
  /** The receipt for these draft bytes, or `undefined` if none was ever written. */
  get(contentDigest: string): Promise<DraftReceipt | undefined>
  /** Every stored receipt, ordered by digest so two calls render the same table. */
  list(): Promise<DraftReceipt[]>
}

export function draftReceiptsDir(agentQaRoot: string): string {
  return join(agentQaRoot, DRAFT_RECEIPTS_DIR_NAME)
}

function receiptPath(agentQaRoot: string, contentDigest: string): string {
  if (!SAFE_DIGEST.test(contentDigest)) throw new DraftReceiptDigestError(contentDigest)
  return join(draftReceiptsDir(agentQaRoot), `${contentDigest}${RECEIPT_SUFFIX}`)
}

/**
 * Write bytes atomically: full content to a pid-suffixed sibling, fsync, rename.
 *
 * Verbatim the proposals-store posture, and the pid is the same load-bearing detail — a shared
 * temp name would make the rename's atomicity irrelevant, because the bytes being renamed could be
 * half of another process's document.
 */
function writeFileAtomically(path: string, contents: string): void {
  const temp = `${path}.${process.pid}${TEMP_SUFFIX}`
  writeFileSync(temp, contents, 'utf8')
  fsyncFile(temp)
  durableRename(temp, path)
}

/**
 * Parse one durable record, refusing a foreign schema version by name.
 *
 * The version is checked BEFORE the schema parse even though `DraftReceiptSchema` pins the literal
 * and would refuse it anyway. The difference is the answer a caller gets: a typed
 * `DraftReceiptSchemaVersionError` naming the file and the version it found is actionable, and a
 * generic validation error listing a literal mismatch among other issues is not. Stamp and
 * hard-fail is only useful if the failure says what happened.
 */
function parseReceipt(path: string, raw: unknown): DraftReceipt {
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
  if (version !== CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION) {
    throw new DraftReceiptSchemaVersionError(path, version)
  }
  return DraftReceiptSchema.parse(raw)
}

function readReceiptIfPresent(path: string): DraftReceipt | undefined {
  let bytes: string
  try {
    bytes = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseReceipt(path, JSON.parse(bytes) as unknown)
}

/**
 * Bind the three receipt verbs over one agent-qa runtime root.
 *
 * Nothing opens here and nothing is created until the first write, which is what lets a
 * composition root bind this unconditionally without deciding whether a project has ever
 * evaluated a draft — an absent directory and an empty store are the same answer.
 */
export function createDraftReceiptsStore(
  options: DraftReceiptsStoreOptions,
): DraftReceiptsStore {
  async function root(): Promise<string> {
    return await options.resolveAgentQaRoot()
  }

  return {
    async put(receipt: DraftReceipt): Promise<void> {
      const agentQaRoot = await root()
      // VALIDATED ON THE WAY OUT, before any syscall. A receipt is read back by a different
      // process — possibly a different build — so the boundary that matters is the file, and a
      // check performed only on read would let a malformed document be written today and
      // discovered by whoever needed it most.
      const validated = DraftReceiptSchema.parse(receipt)
      const path = receiptPath(agentQaRoot, validated.draftRef.contentDigest)
      const directory = draftReceiptsDir(agentQaRoot)
      mkdirSync(directory, { recursive: true })
      writeFileAtomically(path, `${JSON.stringify(validated, undefined, 2)}\n`)
      fsyncDirectory(directory)
    },

    async get(contentDigest: string): Promise<DraftReceipt | undefined> {
      return readReceiptIfPresent(receiptPath(await root(), contentDigest))
    },

    async list(): Promise<DraftReceipt[]> {
      const directory = draftReceiptsDir(await root())
      let names: readonly string[]
      try {
        names = readdirSync(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const receipts: DraftReceipt[] = []
      // DETERMINISTIC ORDER. `readdirSync` order is a filesystem fact that differs between
      // machines and between two calls after a rename, so a listing that inherited it would render
      // two different tables from one store.
      for (const name of [...names].sort()) {
        // An in-flight temp is NOISE, never a receipt: it sits beside a durable name that either
        // is already in this listing or is about to be, and reading half a document would fail the
        // schema parse on a file nobody asked about.
        if (name.endsWith(TEMP_SUFFIX) || !name.endsWith(RECEIPT_SUFFIX)) continue
        const receipt = readReceiptIfPresent(join(directory, name))
        if (receipt !== undefined) receipts.push(receipt)
      }
      return receipts
    },
  }
}
