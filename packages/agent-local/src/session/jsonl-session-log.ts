// Append-only, one fsync on the header and one per turn, one descriptor per session handle.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { repairSession } from '@vostride/agent-qa-agent'
import { CURRENT_CHAT_SESSION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  ChatSessionEvent,
  ChatSessionHandle,
  ChatSessionHeader,
  OpenedChatSession,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { DIRECTORY_FSYNC_SWALLOWED_CODES } from '../store/job-checkpoint-store.js'

// Directory segment under the agent-qa runtime root; gitignored.
export const CHAT_SESSIONS_SUBDIR = 'sessions'

/** The file extension every session log carries. A listing filters on it, nothing else. */
const SESSION_FILE_SUFFIX = '.jsonl'

export const CHAT_SESSION_READ_CHUNK_BYTES = 64 * 1024

/**
 * Ids that are safe as a single path segment.
 *
 * The same class `job-checkpoint-store.ts` uses, and the same reasoning: leading dots are excluded
 * so `..` cannot be an id at all, and the class admits no separator on any platform.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A caller-supplied session id that could not be a path segment. */
export class InvalidChatSessionIdError extends Error {
  override readonly name = 'InvalidChatSessionIdError'

  constructor(readonly sessionId: string) {
    super(
      `${JSON.stringify(sessionId)} is not a usable chat session id. Ids are minted by this `
      + 'adapter and are limited to letters, digits, dot, dash and underscore.',
    )
  }
}

// A refusal, never a create: a fresh session for a mistyped id would claim the history is lost.
export class UnknownChatSessionError extends Error {
  override readonly name = 'UnknownChatSessionError'

  constructor(readonly sessionId: string) {
    super(`No chat session ${sessionId} exists under this project's runtime root.`)
  }
}

// A refusal by name, not a second descriptor; the id is on the error so a caller can wait.
export class ChatSessionBusyError extends Error {
  override readonly name = 'ChatSessionBusyError'

  constructor(readonly sessionId: string) {
    super(
      `Chat session ${sessionId} is already open in this process. One writer at a time: a second `
      + 'handle would interleave two turns in one conversation.',
    )
  }
}

/** Bytes that do not describe a session this build can append to. */
export class ChatSessionHeaderError extends Error {
  override readonly name = 'ChatSessionHeaderError'

  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`The session file for ${sessionId} cannot be read: ${detail}.`)
  }
}

/**
 * Exactly the filesystem calls this module makes, and nothing else.
 *
 * `'a'` is the append-mode open the whole design rests on: the kernel places every write at the
 * current end of file, so two writers cannot interleave a partial line, and no offset bookkeeping
 * exists here to get wrong. `'r'` appears twice for two unrelated reasons — the parent-directory
 * fsync needs a descriptor on the directory, and the listing needs a bounded read on a file.
 *
 * `writeFileSync` on a descriptor rather than `writeSync` is deliberate. `writeSync` may report a
 * SHORT write and leave the caller to loop; a loop is exactly the offset bookkeeping the append
 * mode was chosen to abolish, and a forgotten one is a half-written line — the damage shape this
 * file is otherwise built to survive. `writeFileSync` writes the whole buffer or throws, which is
 * also what the checkpoint store's facade takes.
 */
export interface ChatSessionFs {
  mkdirSync(path: string, options: { readonly recursive: true }): void
  openSync(path: string, flags: 'a' | 'wx' | 'r'): number
  writeFileSync(fd: number, data: string, encoding: 'utf8'): void
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number
  readFileSync(path: string, encoding: 'utf8'): string
  readdirSync(path: string): string[]
}

/** The production implementation, frozen so it cannot be patched from a distance. */
export const REAL_CHAT_SESSION_FS: ChatSessionFs = Object.freeze({
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readSync,
  readFileSync,
  readdirSync,
})

/**
 * What a production caller supplies: a root and the session's opening context.
 *
 * The absence of an fs member is the guarantee, exactly as it is on `CreateJobCheckpointStoreOptions`.
 */
export interface CreateJsonlSessionLogOptions {
  /** Absolute path to the agent-qa runtime root, typically `<project>/.agent-qa`. */
  readonly root: string
  /** ISO instant source — the composition's clock, never `Date.now()` reached for here. */
  readonly now: () => string
  /**
   * The model in force when the session opens. Drift is `model_change` events, never a rewrite.
   *
   * A THUNK rather than a string, because a composition root resolves its model lazily — a host
   * that only lists the registry must not pay a provider resolution — and a header built from a
   * value captured at construction would name whatever was true before that resolution ran.
   */
  readonly model: () => string
  /** The toolset fingerprint at open, on the same thunk reasoning as `model` above. */
  readonly toolsetHash: () => string
  // A value, not a thunk, because the header is written once; absent writes no tag.
  readonly surface?: string
  /** Random source for the id suffix, injectable so a test can pin an id. */
  readonly random?: () => number
}

/** One session, as a listing knows it: everything the header line says, plus how long the log is. */
export interface ChatSessionListEntry {
  readonly sessionId: string
  readonly createdAt: string
  /** The model in force when the session OPENED. Drift after that is `model_change` events. */
  readonly model: string
  // An event count, because a turn count would mean parsing every line of every log.
  readonly eventCount: number
}

/** One session file the listing could not read, surfaced as data rather than thrown over. */
export interface RefusedChatSessionFile {
  /** The file's own name, which is what a person has to go and look at. */
  readonly file: string
  readonly reason: string
}

export interface ChatSessionListing {
  readonly sessions: readonly ChatSessionListEntry[]
  readonly refused: readonly RefusedChatSessionFile[]
}

/**
 * `chat-<UTCyyyymmdd-HHMMSS>-<4 base36>`.
 *
 * Sorted-by-name equals sorted-by-time, which is what makes a plain directory listing the session
 * list; the random tail is what keeps two sessions opened in the same second distinct. Every
 * character is in `SAFE_PATH_SEGMENT` by construction, so a minted id can never be refused by the
 * guard that protects a supplied one.
 */
export function mintChatSessionId(nowIso: string, random: () => number): string {
  const stamp = nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-').replace('Z', '')
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `chat-${stamp}-${suffix}`
}

function requireSessionId(sessionId: string): string {
  if (!SAFE_PATH_SEGMENT.test(sessionId)) throw new InvalidChatSessionIdError(sessionId)
  return sessionId
}

function isSwallowableDirectoryFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return DIRECTORY_FSYNC_SWALLOWED_CODES.some((allowed) => allowed === code)
}

/**
 * The header guard: version BEFORE shape.
 *
 * The order is the same decision `job-checkpoint-store.ts:231-237` states — a version mismatch has
 * a remedy an operator can act on, and reporting it as a generic shape failure names a field
 * instead. The `readonly` cast is safe because the value is re-validated field by field below.
 */
function guardHeader(sessionId: string, line: string): ChatSessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new ChatSessionHeaderError(sessionId, 'its first line is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ChatSessionHeaderError(sessionId, 'its header line is not an object')
  }
  const header = parsed as Record<string, unknown>
  if (header.schemaVersion !== CURRENT_CHAT_SESSION_SCHEMA_VERSION) {
    throw new ChatSessionHeaderError(
      sessionId,
      `it declares schemaVersion ${String(header.schemaVersion)} and this build reads `
      + String(CURRENT_CHAT_SESSION_SCHEMA_VERSION),
    )
  }
  if (header.sessionId !== sessionId) {
    throw new ChatSessionHeaderError(
      sessionId,
      `its header names session ${String(header.sessionId)}`,
    )
  }
  if (typeof header.createdAt !== 'string' || typeof header.model !== 'string') {
    throw new ChatSessionHeaderError(sessionId, 'its header names no creation instant or model')
  }
  // Absent passes; a present non-string `surface` is refused rather than narrowed.
  if (header.surface !== undefined && typeof header.surface !== 'string') {
    throw new ChatSessionHeaderError(
      sessionId,
      `its header names a surface of type ${typeof header.surface} and this build reads a string`,
    )
  }
  return header as unknown as ChatSessionHeader
}

// A damaged file costs only its own entry; throwing would hide every healthy session.
export function listSessions(root: string): ChatSessionListing {
  if (!isAbsolute(root)) throw new TypeError('chat session log root must be absolute')
  const fs = REAL_CHAT_SESSION_FS
  const sessionsRoot = join(root, CHAT_SESSIONS_SUBDIR)

  let files: string[]
  try {
    files = fs.readdirSync(sessionsRoot)
  } catch (error) {
    // No sessions directory is no sessions, not a failure: a project that has never opened chat is
    // in exactly that state, and it is the state the very first `chat` command starts from.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], refused: [] }
    throw error
  }

  const sessions: ChatSessionListEntry[] = []
  const refused: RefusedChatSessionFile[] = []

  for (const file of [...files].sort()) {
    if (!file.endsWith(SESSION_FILE_SUFFIX)) continue
    const sessionId = file.slice(0, -SESSION_FILE_SUFFIX.length)
    try {
      const scanned = scanSessionFile(fs, join(sessionsRoot, file))
      if (scanned.headerLine === undefined) {
        refused.push({ file, reason: 'it carries no complete header line' })
        continue
      }
      const header = guardHeader(sessionId, scanned.headerLine)
      sessions.push({
        sessionId: header.sessionId,
        createdAt: header.createdAt,
        model: header.model,
        eventCount: Math.max(scanned.lineCount - 1, 0),
      })
    } catch (error) {
      refused.push({ file, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return { sessions, refused }
}

/**
 * One pass over a session file: its first line, and how many complete lines it has.
 *
 * Constant memory by construction — one reused chunk buffer, no accumulation past the header line,
 * and NO EVENT IS EVER PARSED. A listing that guarded every line would be `open()` wearing a
 * cheaper name, and would inherit `open()`'s right to refuse a whole session over one damaged line.
 */
function scanSessionFile(
  fs: ChatSessionFs,
  path: string,
): { headerLine: string | undefined; lineCount: number } {
  const fd = fs.openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(CHAT_SESSION_READ_CHUNK_BYTES)
    let headerLine: string | undefined
    let headerBytes = ''
    let lineCount = 0
    let read = fs.readSync(fd, buffer, 0, buffer.length, null)
    while (read > 0) {
      const chunk = buffer.subarray(0, read)
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) lineCount += 1
      }
      if (headerLine === undefined) {
        headerBytes += chunk.toString('utf8')
        const newline = headerBytes.indexOf('\n')
        if (newline >= 0) headerLine = headerBytes.slice(0, newline)
        // A "header" longer than one chunk is not a header this build wrote; stop accumulating so
        // one damaged file cannot be read into memory in its entirety by a listing.
        else if (headerBytes.length > CHAT_SESSION_READ_CHUNK_BYTES) break
      }
      read = fs.readSync(fd, buffer, 0, buffer.length, null)
    }
    return { headerLine, lineCount }
  } finally {
    fs.closeSync(fd)
  }
}

export function createJsonlSessionLog(options: CreateJsonlSessionLogOptions): SessionLogPort {
  return createJsonlSessionLogOn(REAL_CHAT_SESSION_FS, options)
}

/**
 * The same log over an injected filesystem. TEST SEAM — production uses the factory above.
 *
 * It exists because the syscall ORDER is the durability property and no crash test can observe it
 * (the kernel does not drop pages it already holds when a process dies). Keeping it a separate
 * function rather than an optional field means a production construction cannot reach it by filling
 * in one more property, and keeping it off this package's barrel means no other package can reach
 * it at all. A test asserts that nothing outside `__tests__` calls it.
 */
export function createJsonlSessionLogOn(
  fs: ChatSessionFs,
  options: CreateJsonlSessionLogOptions,
): SessionLogPort {
  if (!isAbsolute(options.root)) {
    throw new TypeError('chat session log root must be absolute')
  }
  const sessionsRoot = join(options.root, CHAT_SESSIONS_SUBDIR)
  const random = options.random ?? Math.random

  // Descriptors are keyed by session id and reached only through the handle that owns each.
  const liveDescriptors = new Map<string, number>()

  function pathFor(sessionId: string): string {
    return join(sessionsRoot, `${sessionId}.jsonl`)
  }

  function bestEffortFsyncDirectory(dir: string): void {
    let directoryFd: number | undefined
    try {
      directoryFd = fs.openSync(dir, 'r')
      fs.fsyncSync(directoryFd)
    } catch (error) {
      if (!isSwallowableDirectoryFsyncError(error)) throw error
    } finally {
      if (directoryFd !== undefined) fs.closeSync(directoryFd)
    }
  }

  function readLines(
    sessionId: string,
  ): { lines: { lineNumber: number; text: string }[]; terminated: boolean } | undefined {
    let text: string
    try {
      text = fs.readFileSync(pathFor(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return {
      // Line numbers are 1-based and count the header, so a refusal names what an editor shows the
      // person who has to go and look at the file.
      lines: text
        .split('\n')
        .map((line, index) => ({ lineNumber: index + 1, text: line }))
        .filter((line) => line.text !== ''),
      // Every line this adapter writes ends in a newline, so a file that does not is a file whose
      // last write was cut short. That fact cannot be recovered once the lines are split, and the
      // append path needs it BEFORE it writes anything (see `terminateTornTail`).
      terminated: text === '' || text.endsWith('\n'),
    }
  }

  function writeEvent(target: number, event: ChatSessionEvent): void {
    // One JSON document per line, written through an `O_APPEND` fd so the kernel places it at the
    // end of file. No offset is tracked here, which is what makes a second writer's line impossible
    // to interleave with a partial one of ours.
    fs.writeFileSync(target, `${JSON.stringify(event)}\n`, 'utf8')
  }

  /**
   * One session's handle, closing over the descriptor THAT session's open produced.
   *
   * The descriptor is a closure variable of one handle rather than a field of the adapter, which is
   * the structural statement of the contract: there is no expression anywhere in this module that
   * reaches another session's fd, so no interleaving of two callers' awaits can produce one.
   */
  function handleFor(
    id: string,
    fd: number,
    opened: OpenedChatSession,
  ): ChatSessionHandle {
    let live = true
    const requireLive = (verb: string): void => {
      if (!live) {
        throw new TypeError(
          `a chat session ${verb} cannot go through a closed handle for ${id}. Open the session `
          + 'again to write to it.',
        )
      }
    }
    const handle: ChatSessionHandle = {
      header: opened.header,
      events: opened.events,
      refusedLines: opened.refusedLines,
      append(event: ChatSessionEvent): Promise<void> {
        requireLive('event')
        writeEvent(fd, event)
        return Promise.resolve()
      },
      turnBoundary(): Promise<void> {
        // A REFUSAL rather than a silent no-op: a boundary that quietly skipped its fsync would
        // report a durability guarantee it did not buy, which is the one lie this file is built
        // to make impossible.
        requireLive('turn boundary')
        fs.fsyncSync(fd)
        return Promise.resolve()
      },
      close(): Promise<void> {
        // Idempotent, so a caller's `finally` may call it unconditionally — the turn engine's does.
        if (live) {
          live = false
          liveDescriptors.delete(id)
          fs.closeSync(fd)
        }
        return Promise.resolve()
      },
    }
    liveDescriptors.set(id, fd)
    return handle
  }

  return {
    open(sessionId?: string): Promise<ChatSessionHandle> {
      fs.mkdirSync(sessionsRoot, { recursive: true })

      if (sessionId !== undefined) {
        const id = requireSessionId(sessionId)
        // BEFORE ANY WORK, and before any byte is read: a busy session is a refusal, not a second
        // descriptor. Asked first so a double-submit costs a caller nothing but the answer.
        if (liveDescriptors.has(id)) throw new ChatSessionBusyError(id)
        const read = readLines(id)
        // The refusal, not a create. See `UnknownChatSessionError`.
        if (read === undefined || read.lines.length === 0) throw new UnknownChatSessionError(id)
        const header = guardHeader(id, read.lines[0]!.text)
        // Repair runs before any caller sees an event; the version comes from the validated header.
        const repair = repairSession(read.lines.slice(1), {
          declaredVersion: header.schemaVersion,
          now: options.now,
        })
        const resumed = fs.openSync(pathFor(id), 'a')
        // TERMINATE A TORN TAIL BEFORE APPENDING ANYTHING. A crash leaves the last line without
        // its newline, so the very next append would land ON that fragment and fuse two records
        // into one unreadable line — turning a bounded, understood loss into permanent damage
        // that the next open would mistake for a fresh tear and lose all over again. One newline
        // closes the fragment where it stopped. It is still an APPEND: no existing byte moves,
        // and the fragment survives verbatim as its own refused line for anyone auditing the file.
        let wroteDuringRepair = false
        if (!read.terminated) {
          fs.writeFileSync(resumed, '\n', 'utf8')
          wroteDuringRepair = true
        }
        for (const event of repair.synthesized) {
          writeEvent(resumed, event)
          wroteDuringRepair = true
        }
        if (wroteDuringRepair) {
          // A repair CLOSES the dangling turn, so it lands like any other turn boundary. A
          // synthesized abort a second crash could lose would leave the same session dangling
          // again, and the loss bound would stop being the in-flight turn.
          fs.fsyncSync(resumed)
        }
        return Promise.resolve(
          handleFor(id, resumed, {
            header,
            events: repair.repaired,
            refusedLines: repair.refusedLines,
          }),
        )
      }

      const createdAt = options.now()
      const id = mintChatSessionId(createdAt, random)
      const header: ChatSessionHeader = {
        schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
        sessionId: id,
        createdAt,
        model: options.model(),
        toolsetHash: options.toolsetHash(),
        // Spread conditionally, so absent means the option is not given.
        ...(options.surface === undefined ? {} : { surface: options.surface }),
      }
      // Exclusive create, then fsync the header BEFORE the file is used, then fsync the directory
      // that now names it: a session file that exists at all is a session file whose header is on
      // the device, and whose entry survives the crash that follows.
      const created = fs.openSync(pathFor(id), 'wx')
      try {
        fs.writeFileSync(created, `${JSON.stringify(header)}\n`, 'utf8')
        fs.fsyncSync(created)
      } finally {
        fs.closeSync(created)
      }
      bestEffortFsyncDirectory(sessionsRoot)
      const appendFd = fs.openSync(pathFor(id), 'a')
      return Promise.resolve(handleFor(id, appendFd, { header, events: [], refusedLines: [] }))
    },
  }
}
