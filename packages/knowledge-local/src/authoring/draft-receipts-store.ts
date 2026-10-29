// The durable draft-receipts store.
//
// A KEEP-GATE EVALUATION IS A DECISION SOMEBODY HAS TO BE ABLE TO READ BACK. The op returns the
// receipt AND persists it, because 394's accept flow carries it as evidence refs and the author of
// a rejected draft is owed the exact reason days later — neither of which survives in memory. So
// this is the proposals-store idiom applied to a second kind of durable
// record: one `<contentDigest>.json` per draft under a gitignored `<agentQaRoot>/draft-receipts/`,
// a sibling of `proposals/`, written atomically through a `.tmp` name that is never enumerated.
//
// KEYED BY THE DRAFT'S CONTENT DIGEST, not by its path or its test id. That is what makes a
// receipt mean "this evaluation is about THESE bytes": an author who edits the draft mints a new
// digest and therefore cannot inherit the verdict earned by the version that was actually run. It
// is also why the store needs no versioning of its own — a superseding evaluation of the SAME
// bytes replaces the record, and an evaluation of different bytes is a different record.
//
// WHAT IT WILL NOT HOLD. Receipts are refs plus findings, never run payloads and never resolved
// secrets (D-19, map-not-territory). That is enforced structurally rather than by convention:
// `DraftReceiptSchema` is `.strict()` and is parsed on the way OUT as well as on the way in, so a
// payload smuggled onto a receipt is a typed refusal at the moment of writing rather than a field
// somebody notices in a durable file months later.
//
// STAMP AND HARD-FAIL. The schema pins `schemaVersion` as a literal. A record written under a
// future shape is refused loudly here rather than reinterpreted under today's — the house
// convention `AddressingLedgerSchemaVersionError` and `QuarantineLedgerVersionError` already set,
// and the only safe answer for a store whose whole purpose is to say what was decided.

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

/**
 * The digest shapes this store will turn into a path.
 *
 * IN-03, applied where the joining happens (the proposals-store precedent: the shape check lives
 * in the module that calls `join`, not only in the function layer one package away). A
 * `contentDigest` arrives from a caller and becomes a filename two lines later, so a value
 * carrying `../` is a caller-supplied arbitrary-path primitive on both the read and the write
 * verb. Deliberately WIDER than sha256-hex — the DTO promises only a non-empty string, and a
 * store that refused a legitimate digest of another width would be enforcing a rule the
 * vocabulary does not make — but narrow enough that no member of it can name a path separator, a
 * parent directory, or a hidden file.
 */
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
