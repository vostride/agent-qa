// The session log's durability proof, and the one SIGKILL structurally cannot give (Phase 392
// plan 03, CHAT-05 / D-17 / D-19).
//
// Killing a process does not drop the pages the kernel already holds, so a log that never calls
// fsync at all survives every crash test run on one machine. The only way to know the syscalls
// happen — and happen at the one MOMENT that makes the loss bound the in-flight turn — is to watch
// them. This file watches them, on the idiom `__tests__/checkpoint-fsync-ordering.test.ts` set.
//
// EVERY ASSERTION IS ON THE ORDERED LIST, never on membership. "An fsync happened" is satisfied by
// an fsync at entirely the wrong moment: one per event would pay for a guarantee finer than any
// reader can use, and one at close would leave a killed process with a turn nobody synced. The
// labels below are derived from the raw arguments — which path, which flags, which descriptor came
// from which open — so the adapter cannot name its own calls into the right shape.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChatSessionEvent, SessionLogPort } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import {
  CHAT_SESSIONS_SUBDIR,
  CHAT_SESSION_READ_CHUNK_BYTES,
  ChatSessionBusyError,
  ChatSessionHeaderError,
  REAL_CHAT_SESSION_FS,
  UnknownChatSessionError,
  createJsonlSessionLog,
  createJsonlSessionLogOn,
  listSessions,
} from '../jsonl-session-log.js'
import type {
  ChatSessionFs,
  CreateJsonlSessionLogOptions,
} from '../jsonl-session-log.js'
import { createMemorySessionLog } from '../memory-session-log.js'

const NOW = '2026-08-09T10:11:12.000Z'
const LATER = '2026-08-09T10:11:13.000Z'

function options(root: string, now: string = NOW): CreateJsonlSessionLogOptions {
  return {
    root,
    now: () => now,
    model: () => 'unbound',
    toolsetHash: () => 'toolset-0001',
    random: () => 0.5,
  }
}

/**
 * The same options with a clock that MOVES, so two `open()` calls mint two ids.
 *
 * The pinned clock above is what makes the single-session assertions exact, and it is also why a
 * concurrency case cannot use it: both mints would produce one id and the second exclusive-create
 * would collide. One tick apart is the smallest change that makes two sessions expressible, and it
 * leaves every other pinned input alone.
 */
function concurrentOptions(root: string): CreateJsonlSessionLogOptions {
  let tick = 0
  return {
    root,
    now: () => (tick++ === 0 ? NOW : LATER),
    model: () => 'unbound',
    toolsetHash: () => 'toolset-0001',
    random: () => 0.5,
  }
}

function userMessage(turnId: string, text: string): ChatSessionEvent {
  return { kind: 'user_message', turnId, at: NOW, text }
}

function turnComplete(turnId: string): ChatSessionEvent {
  return { kind: 'turn_complete', turnId, at: NOW, status: 'completed' }
}

interface RecordedCall {
  readonly call: string
  readonly args: readonly unknown[]
  readonly result?: unknown
}

interface RecordingFs {
  readonly fs: ChatSessionFs
  readonly calls: RecordedCall[]
}

/**
 * A facade that RECORDS and then calls through to the real implementation.
 *
 * Calling through matters: a facade answering on its own behalf would turn this file into a test
 * of a recorder's bookkeeping, and the bytes asserted on disk below would say nothing about the
 * adapter.
 */
function createRecordingFs(): RecordingFs {
  const calls: RecordedCall[] = []

  function record<T>(call: string, args: readonly unknown[], body: () => T): T {
    const result = body()
    calls.push({ call, args, result })
    return result
  }

  const fs: ChatSessionFs = {
    mkdirSync: (path, mkdirOptions) =>
      record('mkdirSync', [path], () => {
        REAL_CHAT_SESSION_FS.mkdirSync(path, mkdirOptions)
      }),
    openSync: (path, flags) =>
      record('openSync', [path, flags], () => REAL_CHAT_SESSION_FS.openSync(path, flags)),
    writeFileSync: (fd, data, encoding) =>
      record('writeFileSync', [fd], () => {
        REAL_CHAT_SESSION_FS.writeFileSync(fd, data, encoding)
      }),
    fsyncSync: (fd) =>
      record('fsyncSync', [fd], () => {
        REAL_CHAT_SESSION_FS.fsyncSync(fd)
      }),
    closeSync: (fd) =>
      record('closeSync', [fd], () => {
        REAL_CHAT_SESSION_FS.closeSync(fd)
      }),
    readSync: (fd, buffer, offset, length, position) =>
      record('readSync', [fd], () =>
        REAL_CHAT_SESSION_FS.readSync(fd, buffer, offset, length, position),
      ),
    readFileSync: (path, encoding) =>
      record('readFileSync', [path], () => REAL_CHAT_SESSION_FS.readFileSync(path, encoding)),
    readdirSync: (path) => record('readdirSync', [path], () => REAL_CHAT_SESSION_FS.readdirSync(path)),
  }

  return { fs, calls }
}

/**
 * Turn raw recorded calls into the sequence a reader can judge.
 *
 * Paths become the two roles that matter (`dir`, `file`) and descriptors resolve back to the path
 * they were opened on, so `fsync file` and `fsync dir` are distinguishable without the adapter
 * having said which was which.
 */
function describeSequence(calls: readonly RecordedCall[], root: string, sessionId: string): string[] {
  const dir = join(root, CHAT_SESSIONS_SUBDIR)
  const file = join(dir, `${sessionId}.jsonl`)
  const fdPath = new Map<number, string>()

  function label(value: unknown): string {
    const path = String(value)
    if (path === file) return 'file'
    if (path === dir) return 'dir'
    return path
  }

  function labelFd(fd: unknown): string {
    const path = fdPath.get(Number(fd))
    return path === undefined ? `fd:${String(fd)}` : label(path)
  }

  return calls.map((entry) => {
    switch (entry.call) {
      case 'mkdirSync':
        return `mkdir ${label(entry.args[0])}`
      case 'openSync': {
        fdPath.set(Number(entry.result), String(entry.args[0]))
        return `open ${label(entry.args[0])} ${String(entry.args[1])}`
      }
      case 'writeFileSync':
        return `write ${labelFd(entry.args[0])}`
      case 'fsyncSync':
        return `fsync ${labelFd(entry.args[0])}`
      case 'closeSync':
        return `close ${labelFd(entry.args[0])}`
      case 'readFileSync':
        return `read ${label(entry.args[0])}`
      case 'readdirSync':
        return `readdir ${label(entry.args[0])}`
      case 'readSync':
        return `readbytes ${labelFd(entry.args[0])}`
      default:
        return `unknown:${entry.call}`
    }
  })
}

/**
 * The same sequence, labelled across SEVERAL sessions.
 *
 * `file:A` / `file:B` rather than one `file`, so a syscall's session is derived from the path it
 * was made on — the adapter cannot name its own calls into the right shape any more here than it
 * can above. Filtering this list by label is the per-session projection of the ordered assertions:
 * each session's write→write→fsync boundary has to hold on its OWN file, independently, while the
 * other session is open.
 */
function describeSequenceAcross(
  calls: readonly RecordedCall[],
  root: string,
  sessionIds: readonly string[],
): string[] {
  const dir = join(root, CHAT_SESSIONS_SUBDIR)
  const files = new Map(
    sessionIds.map((sessionId, index) => [
      join(dir, `${sessionId}.jsonl`),
      `file:${String.fromCharCode(65 + index)}`,
    ]),
  )
  const fdPath = new Map<number, string>()

  function label(value: unknown): string {
    const path = String(value)
    return files.get(path) ?? (path === dir ? 'dir' : path)
  }

  function labelFd(fd: unknown): string {
    const path = fdPath.get(Number(fd))
    return path === undefined ? `fd:${String(fd)}` : label(path)
  }

  return calls.map((entry) => {
    switch (entry.call) {
      case 'mkdirSync':
        return `mkdir ${label(entry.args[0])}`
      case 'openSync': {
        fdPath.set(Number(entry.result), String(entry.args[0]))
        return `open ${label(entry.args[0])} ${String(entry.args[1])}`
      }
      case 'writeFileSync':
        return `write ${labelFd(entry.args[0])}`
      case 'fsyncSync':
        return `fsync ${labelFd(entry.args[0])}`
      case 'closeSync':
        return `close ${labelFd(entry.args[0])}`
      default:
        return `other:${entry.call}`
    }
  })
}

/**
 * One session's whole life, as seen on its OWN file: create, land the header, reopen to append,
 * two event writes, one boundary fsync. It is `EXPECTED_NEW_SESSION_TURN` with the directory
 * entries taken out, which is the point — a second session open at the same time changes nothing
 * about this one's syscalls, and the re-keying added none.
 */
function expectedPerSessionTurn(label: string): string[] {
  return [
    `open ${label} wx`,
    `write ${label}`,
    `fsync ${label}`,
    `close ${label}`,
    `open ${label} a`,
    `write ${label}`,
    `write ${label}`,
    `fsync ${label}`,
  ]
}

/**
 * The whole life of a new session carrying ONE two-event turn.
 *
 * Read it top to bottom as the durability argument: the header is on the device before the file is
 * usable and its directory entry is durable too; then the two event lines go out through the append
 * descriptor; then ONE fsync, at the turn boundary, with nothing between it and the last write.
 */
const EXPECTED_NEW_SESSION_TURN = [
  'mkdir dir',
  'open file wx',
  'write file',
  'fsync file',
  'close file',
  'open dir r',
  'fsync dir',
  'close dir',
  'open file a',
  'write file',
  'write file',
  'fsync file',
]

const SESSION_ID = 'chat-20260809-101112-i000'

describe('the session log appends as it goes and fsyncs at the turn boundary', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-session-durability-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('executes exactly write -> write -> fsync(fd) at the boundary, in that order', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, options(root))

    const opened = await log.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()

    expect(opened.header.sessionId).toBe(SESSION_ID)
    expect(describeSequence(calls, root, opened.header.sessionId)).toEqual(
      EXPECTED_NEW_SESSION_TURN,
    )
  })

  // The ordered list above is the assertion; the three below are the reasons each position in it is
  // load-bearing, stated so a future reordering fails with a sentence rather than a diff.
  it('puts NOTHING between the last write of a turn and the fsync that lands it', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, options(root))

    const opened = await log.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()

    const sequence = describeSequence(calls, root, opened.header.sessionId)
    const boundary = sequence.lastIndexOf('fsync file')
    expect(sequence[boundary - 1]).toBe('write file')
  })

  it('fsyncs ONCE per turn, not once per event', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, options(root))

    const opened = await log.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()

    // Two on the whole life of the session: the header's own, and the turn boundary's. A third
    // would mean an event-level sync; a first-only would mean the turn never landed.
    const sequence = describeSequence(calls, root, opened.header.sessionId)
    expect(sequence.filter((entry) => entry === 'fsync file')).toHaveLength(2)
  })

  it('opens a new session exclusively, so a torn file from an earlier crash cannot alias', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, options(root))
    const opened = await log.open()

    expect(describeSequence(calls, root, opened.header.sessionId)).toContain('open file wx')
  })

  it('does NOT exclusive-create on resume — the file already exists and must not be re-made', async () => {
    const first = createRecordingFs()
    const creating = createJsonlSessionLogOn(first.fs, options(root))
    const opened = await creating.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()
    await opened.close()

    const second = createRecordingFs()
    const resuming = createJsonlSessionLogOn(second.fs, options(root, LATER))
    const reopened = await resuming.open(opened.header.sessionId)

    const sequence = describeSequence(second.calls, root, opened.header.sessionId)
    expect(sequence.some((entry) => entry.endsWith(' wx'))).toBe(false)
    expect(sequence).toContain('open file a')
    expect(reopened.header.createdAt).toBe(NOW)
    expect(reopened.events).toHaveLength(2)
  })

  // ------------------------------------------------------------------------------------------
  // TWO SESSIONS AT ONCE, ON ONE ADAPTER.
  //
  // This is the case the whole suite could not previously express: while the adapter owned one
  // mutable descriptor, a second `open()` repointed it, so the interleaved appends below would all
  // have landed on the file that opened last and one session would have been left without its
  // closing event. The assertions are the single-session ones PER SESSION — the same ordered lists,
  // asked of each file independently — which is what makes "the re-keying added no syscalls" a
  // measurement rather than a claim.
  // ------------------------------------------------------------------------------------------
  it('interleaves two sessions without a byte crossing, each on its own descriptor', async () => {
    const log = createJsonlSessionLog(concurrentOptions(root))

    const a = await log.open()
    const b = await log.open()
    expect(a.header.sessionId).not.toBe(b.header.sessionId)

    // Deliberately alternating, so a shared descriptor would split both turns across both files.
    await a.append(userMessage('turn-a', 'proposals'))
    await b.append(userMessage('turn-b', 'status'))
    await a.append(turnComplete('turn-a'))
    await b.append(turnComplete('turn-b'))
    await a.turnBoundary()
    await b.turnBoundary()
    await a.close()
    await b.close()

    for (const [sessionId, turnId, text] of [
      [a.header.sessionId, 'turn-a', 'proposals'],
      [b.header.sessionId, 'turn-b', 'status'],
    ] as const) {
      const file = join(root, CHAT_SESSIONS_SUBDIR, `${sessionId}.jsonl`)
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
      expect(lines.slice(1).map((line) => JSON.parse(line) as ChatSessionEvent)).toEqual([
        userMessage(turnId, text),
        turnComplete(turnId),
      ])
    }
  })

  it('gives each concurrent session its own write -> write -> fsync boundary, in order', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, concurrentOptions(root))

    const a = await log.open()
    const b = await log.open()
    await a.append(userMessage('turn-a', 'proposals'))
    await b.append(userMessage('turn-b', 'status'))
    await a.append(turnComplete('turn-a'))
    await b.append(turnComplete('turn-b'))
    await a.turnBoundary()
    await b.turnBoundary()

    const sequence = describeSequenceAcross(calls, root, [
      a.header.sessionId,
      b.header.sessionId,
    ])
    expect(sequence.filter((entry) => entry.includes('file:A'))).toEqual(
      expectedPerSessionTurn('file:A'),
    )
    expect(sequence.filter((entry) => entry.includes('file:B'))).toEqual(
      expectedPerSessionTurn('file:B'),
    )
    // Two per session and no more: the header's own, and the turn boundary's. A third would be an
    // event-level sync; a shared one would be one session paying for the other's durability.
    expect(sequence.filter((entry) => entry === 'fsync file:A')).toHaveLength(2)
    expect(sequence.filter((entry) => entry === 'fsync file:B')).toHaveLength(2)

    await a.close()
    await b.close()
  })

  it('fsyncs the sessions directory after creating the file, so the entry itself is durable', async () => {
    const { fs, calls } = createRecordingFs()
    const log = createJsonlSessionLogOn(fs, options(root))
    const opened = await log.open()

    const sequence = describeSequence(calls, root, opened.header.sessionId)
    expect(sequence.indexOf('fsync dir')).toBeGreaterThan(sequence.indexOf('close file'))
  })
})

describe('the observation seam cannot become a production escape hatch', () => {
  // The production constructor takes a root and the session's opening context — and no filesystem.
  // That absence IS the guarantee: "append without the fsync" is not a one-argument change any
  // composition root could make by accident.
  it('exposes no filesystem member on the production option bag', () => {
    expectTypeOf<keyof CreateJsonlSessionLogOptions>().toEqualTypeOf<
      'root' | 'now' | 'model' | 'toolsetHash' | 'random' | 'surface'
    >()
  })

  it('refuses a filesystem handed to the production factory at compile time', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-session-noseam-'))
    try {
      const log = createJsonlSessionLog({
        ...options(root),
        // @ts-expect-error the production options carry no fs member, which is the guarantee
        fs: REAL_CHAT_SESSION_FS,
      })
      expect(log).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults to the real node:fs implementations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-session-default-'))
    try {
      const log = createJsonlSessionLog(options(root))
      const opened = await log.open()
      await opened.append(userMessage('t1', 'proposals'))
      await opened.turnBoundary()
      await opened.close()

      const file = join(root, CHAT_SESSIONS_SUBDIR, `${opened.header.sessionId}.jsonl`)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A type that forbids the wrong argument is only half of it — the seam factory is still an
  // exported function. This asserts nobody outside a test has reached for it. The scan carries a
  // positive control and asserts the tree it walks really exists, because a scanner that quietly
  // found nothing would report exactly the same all-clear.
  it('is called from test files only, anywhere in the workspace', () => {
    const packagesDir = join(import.meta.dirname, '..', '..', '..', '..')
    expect(existsSync(join(packagesDir, 'agent-local'))).toBe(true)

    const offenders: string[] = []
    let scanned = 0
    let positiveControl = false

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        scanned += 1
        const text = readFileSync(path, 'utf8')
        // The CALL form, not the bare name: a rationale comment that mentions the seam in prose is
        // not a way to reach it, and a barrel line re-exporting it would be caught by the separate
        // assertion below that the barrel does not publish it at all.
        if (text.includes('createJsonlSessionLogOn(')) {
          if (path.includes('__tests__')) positiveControl = true
          else if (!path.endsWith(join('session', 'jsonl-session-log.ts'))) offenders.push(path)
        }
      }
    }

    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(packagesDir, pkg.name, 'src')
      if (!existsSync(src)) continue
      walk(src)
    }

    expect(scanned).toBeGreaterThan(100)
    expect(positiveControl).toBe(true)
    expect(offenders).toEqual([])
  })

  // The other half of "a test names it explicitly": the package BARREL must not publish it. A seam
  // every surface can import is not a seam, and the mandated precedent publishes neither of its
  // factories — `createJobCheckpointStore` appears nowhere on this barrel either.
  // Read off the barrel's REAL export surface rather than its text, so a rationale comment naming
  // the seam cannot fail the assertion and a re-export hidden behind a `export *` cannot pass it.
  it('is absent from the package barrel, which publishes only the production factory', async () => {
    const barrel = await import('../../index.js')
    const published = Object.keys(barrel)

    expect(published).toContain('createJsonlSessionLog')
    expect(published).toContain('listSessions')
    expect(published).not.toContain('createJsonlSessionLogOn')
    expect(published).not.toContain('REAL_CHAT_SESSION_FS')
  })
})

describe('sessions are listable without loading a whole log', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-session-list-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers an empty list when no session was ever opened', () => {
    expect(listSessions(root)).toEqual({ sessions: [], refused: [] })
  })

  it('reports id, creation instant, opening model and event count from the header', async () => {
    const log = createJsonlSessionLog(options(root))
    const opened = await log.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()
    await opened.close()

    expect(listSessions(root)).toEqual({
      sessions: [
        {
          sessionId: opened.header.sessionId,
          createdAt: NOW,
          model: 'unbound',
          eventCount: 2,
        },
      ],
      refused: [],
    })
  })

  it('lists the good session and REPORTS the damaged one by name, never throwing over it', async () => {
    const log = createJsonlSessionLog(options(root))
    const opened = await log.open()
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()
    await opened.close()

    const damaged = join(root, CHAT_SESSIONS_SUBDIR, 'chat-20260101-000000-zzzz.jsonl')
    writeFileSync(damaged, 'this first line is not JSON at all\n', 'utf8')

    const listed = listSessions(root)
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([
      opened.header.sessionId,
    ])
    // Refused-lines-as-data, the grants-ledger posture: a damaged neighbour costs a caller the
    // listing of that one file and nothing else. Throwing would make one corrupt file hide every
    // healthy session from the person trying to find their conversation.
    expect(listed.refused).toHaveLength(1)
    expect(listed.refused[0]?.file).toBe('chat-20260101-000000-zzzz.jsonl')
    expect(listed.refused[0]?.reason).toMatch(/not JSON/)
  })

  // The listing's cost claim, made falsifiable. It NEVER parses an event line — so a session
  // carrying a line that `open()` would refuse still lists, from its header, with the right length.
  // A listing that guarded every line would be `open()` wearing a cheaper name, and would inherit
  // `open()`'s right to refuse a whole session over one damaged line.
  it('never parses an event line: a session with damaged events still lists from its header', async () => {
    const log = createJsonlSessionLog(options(root))
    const opened = await log.open()
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()
    await opened.close()

    const file = join(root, CHAT_SESSIONS_SUBDIR, `${opened.header.sessionId}.jsonl`)
    writeFileSync(file, `${readFileSync(file, 'utf8')}not an event at all\n`, 'utf8')

    expect(listSessions(root)).toEqual({
      sessions: [
        { sessionId: opened.header.sessionId, createdAt: NOW, model: 'unbound', eventCount: 2 },
      ],
      refused: [],
    })
  })

  it('scans in a pinned constant-size chunk, so a huge log costs a listing one buffer', async () => {
    const log = createJsonlSessionLog(options(root))
    const opened = await log.open()
    await opened.append(userMessage('t1', 'x'.repeat(300_000)))
    await opened.turnBoundary()
    await opened.close()

    // A chunk bigger than a filesystem read buys nothing and a chunk that grows with the file is
    // the very thing "without loading full logs" forbids.
    expect(CHAT_SESSION_READ_CHUNK_BYTES).toBeLessThanOrEqual(64 * 1024)
    expect(listSessions(root).sessions).toEqual([
      { sessionId: opened.header.sessionId, createdAt: NOW, model: 'unbound', eventCount: 1 },
    ])
  })

  it('sorts by id, which is sorted by time — a plain listing IS the session list', async () => {
    const first = createJsonlSessionLog(options(root, '2026-08-09T10:11:12.000Z'))
    await (await first.open()).close()
    const second = createJsonlSessionLog(options(root, '2026-08-09T10:11:13.000Z'))
    await (await second.open()).close()

    const ids = listSessions(root).sessions.map((session) => session.sessionId)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toHaveLength(2)
  })
})

// One table, two implementations. A twin is only honest if it answers the SAME port contract the
// disk adapter does — a second, looser shape would let a hermetic test pass against a contract
// production never signs.
const FACTORIES: readonly [string, (root: string) => SessionLogPort][] = [
  ['jsonl (disk)', (root) => createJsonlSessionLog(options(root))],
  ['memory (twin)', () => createMemorySessionLog(options('/unused'))],
]

/** The same two implementations over a moving clock, so two sessions can exist at once. */
const CONCURRENT_FACTORIES: readonly [string, (root: string) => SessionLogPort][] = [
  ['jsonl (disk)', (root) => createJsonlSessionLog(concurrentOptions(root))],
  ['memory (twin)', () => createMemorySessionLog(concurrentOptions('/unused'))],
]

async function refusalOf(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body()
  } catch (error) {
    return error
  }
  return undefined
}

describe.each(FACTORIES)('SessionLogPort contract: %s', (_name, factory) => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-session-contract-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a session with an empty event list and a header naming it', async () => {
    const log = factory(root)
    const opened = await log.open()

    expect(opened.events).toEqual([])
    expect(opened.header.sessionId).toBe(SESSION_ID)
    expect(opened.header.createdAt).toBe(NOW)
    expect(opened.header.schemaVersion).toBe(2)
  })

  it('refuses an unknown session id rather than creating one', async () => {
    const log = factory(root)
    const error = await refusalOf(() => log.open('chat-19700101-000000-0000'))

    expect(error).toBeInstanceOf(UnknownChatSessionError)
  })

  // RE-SPELLED BY THE HANDLE CONTRACT, and the property it names is stronger than the one
  // it replaces. "Append before open" is no longer expressible — there is no log-level append to
  // reach — so what remains to prove is the other end of ownership: a handle that has been closed
  // refuses rather than writing somewhere. A silent no-op there, or a quiet reopen, would be the
  // aliasing this refactor removed, wearing a different name.
  it('refuses an append through a CLOSED handle rather than writing somewhere', async () => {
    const log = factory(root)
    const opened = await log.open()
    await opened.close()

    const error = await refusalOf(() => opened.append(turnComplete('t1')))
    expect(error).toBeInstanceOf(TypeError)

    const boundary = await refusalOf(() => opened.turnBoundary())
    expect(boundary).toBeInstanceOf(TypeError)
  })

  it('round-trips appended events through a close and a reopen', async () => {
    const log = factory(root)
    const opened = await log.open()
    await opened.append(userMessage('t1', 'proposals'))
    await opened.append(turnComplete('t1'))
    await opened.turnBoundary()
    await opened.close()

    const reopened = await log.open(opened.header.sessionId)
    expect(reopened.events).toEqual([userMessage('t1', 'proposals'), turnComplete('t1')])
  })
})

// BOTH ADAPTERS, OR NEITHER (the sibling-input corpus law, 390's one-sided-hardening lesson). The
// concurrency contract is stated once on the port, so it is asserted once here and answered twice:
// a twin that kept a single-session shape would let every hermetic test in this repo pass against
// a contract production no longer signs.
describe.each(CONCURRENT_FACTORIES)('the concurrency contract: %s', (_name, factory) => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-session-concurrent-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves two sessions at once, each append landing in the session it was made through', async () => {
    const log = factory(root)
    const a = await log.open()
    const b = await log.open()
    expect(a.header.sessionId).not.toBe(b.header.sessionId)

    await a.append(userMessage('turn-a', 'proposals'))
    await b.append(userMessage('turn-b', 'status'))
    await a.append(turnComplete('turn-a'))
    await b.append(turnComplete('turn-b'))
    await a.turnBoundary()
    await b.turnBoundary()
    await a.close()
    await b.close()

    // Read back through the port itself, which is what a resumed conversation actually sees.
    const reopenedA = await log.open(a.header.sessionId)
    const reopenedB = await log.open(b.header.sessionId)
    expect(reopenedA.events).toEqual([userMessage('turn-a', 'proposals'), turnComplete('turn-a')])
    expect(reopenedB.events).toEqual([userMessage('turn-b', 'status'), turnComplete('turn-b')])
    await reopenedA.close()
    await reopenedB.close()
  })

  it('refuses a SECOND live handle on one session by name, and admits one after the first closes', async () => {
    const log = factory(root)
    const opened = await log.open()

    const busy = await refusalOf(() => log.open(opened.header.sessionId))
    expect(busy).toBeInstanceOf(ChatSessionBusyError)
    // The id is ON the error rather than only in its text: the caller's remedy is to wait for the
    // holder of THAT session, which it has to be able to name.
    expect((busy as ChatSessionBusyError).sessionId).toBe(opened.header.sessionId)

    await opened.close()
    const reopened = await log.open(opened.header.sessionId)
    expect(reopened.header.sessionId).toBe(opened.header.sessionId)
    await reopened.close()
  })
})

describe('a header this build cannot read is a refusal, never a silent new session', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-session-header-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['a header that is not JSON', '{"schemaVersion":1,"sessi'],
    ['a header from a schema this build does not read', '{"schemaVersion":99,"sessionId":"chat-x"}'],
  ])('refuses %s', async (_label, headerLine) => {
    const log = createJsonlSessionLog(options(root))
    const opened = await log.open()
    await opened.close()

    const file = join(root, CHAT_SESSIONS_SUBDIR, `${opened.header.sessionId}.jsonl`)
    writeFileSync(file, `${headerLine}\n`, 'utf8')

    const error = await refusalOf(() => createJsonlSessionLog(options(root)).open(opened.header.sessionId))
    expect(error).toBeInstanceOf(ChatSessionHeaderError)
  })
})
