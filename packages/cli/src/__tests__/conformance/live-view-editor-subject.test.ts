// An editor subject is minted, opened, streamed and ended like a run; a token never crosses kinds.

import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'

import { EditorLiveUrlResultSchema, RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  plantEditorSubject,
  plantLiveRun,
  startLiveViewHarness,
} from './live-view-fixture.js'
import type { LiveViewHarness, PlantedLiveRun } from './live-view-fixture.js'
import { cleanupTempRoots } from './spawned-chat.js'

const RUN_ID = 'run-1'

let harness: LiveViewHarness | undefined
let run: PlantedLiveRun | undefined

function held(): LiveViewHarness {
  if (harness === undefined) throw new Error('the live-view harness never came up')
  return harness
}

function portOf(h: LiveViewHarness): number {
  return Number(new URL(h.origin).port)
}

beforeAll(async () => {
  harness = await startLiveViewHarness({ label: '428-12-editor' })
  run = plantLiveRun({ runId: RUN_ID, heartbeatMs: 10_000, capability: { kind: 'cdp-screencast' } })
  harness.plant(run)
}, 120_000)

afterAll(async () => {
  run?.close()
  run = undefined
  const open = harness
  harness = undefined
  if (open !== undefined) await open.close()
  cleanupTempRoots()
})

// ---- the raw frame-socket client ---------------------------------------------------------------
//
// BY HAND, on `live-view-cross-site.test.ts`'s reasoning: the cells state exactly the headers they
// mean (here: no Origin, the non-browser caller), and they need the binary half and the close code,
// which that file's reader drops. The masked text frame and the frame decoder are its idiom.

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  const header: number[] = [0x81]
  if (length < 126) header.push(0x80 | length)
  else if (length < 65_536) header.push(0x80 | 126, (length >> 8) & 0xff, length & 0xff)
  else throw new Error('this cell never sends a frame that large')
  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}

interface DecodedFrame {
  readonly opcode: number
  readonly payload: Buffer
}

function drainFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = (buffer[offset] ?? 0) & 0x0f
    const second = buffer[offset + 1] ?? 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    if (buffer.length - cursor < length) break
    frames.push({ opcode, payload: Buffer.from(buffer.subarray(cursor, cursor + length)) })
    offset = cursor + length
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) }
}

interface SocketMessage {
  type?: string
  reason?: string
  runId?: string
  handle?: number
  stream?: { kind?: string }
  id?: number
  ts?: number
}

interface FrameSocket {
  upgradeStatus(): number
  messages(): readonly SocketMessage[]
  /** Every binary frame, counted in arrival order. */
  binaries(): number
  /** The close code the server sent, once it sent one. */
  closeCode(): number | undefined
  waitFor(what: string, predicate: () => boolean, budgetMs?: number): Promise<void>
  destroy(): void
}

function openFrameSocket(input: { port: number; subjectId: string; token: string }): FrameSocket {
  const socket = connect(input.port, '127.0.0.1')
  const messages: SocketMessage[] = []
  let binaries = 0
  let closeCode: number | undefined
  let head = ''
  let upgraded = false
  let upgradeStatus = 0
  let pending: Buffer = Buffer.alloc(0)
  let hungUp = false

  socket.on('error', () => { hungUp = true })
  socket.on('close', () => { hungUp = true })
  socket.on('data', (chunk: Buffer) => {
    if (!upgraded) {
      head += chunk.toString('latin1')
      const split = head.indexOf('\r\n\r\n')
      if (split === -1) return
      upgradeStatus = Number.parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10) || 0
      if (upgradeStatus !== 101) { socket.destroy(); return }
      upgraded = true
      pending = Buffer.from(head.slice(split + 4), 'latin1')
      socket.write(maskedTextFrame(JSON.stringify({ type: 'hello', token: input.token })))
    } else {
      pending = Buffer.concat([pending, chunk])
    }
    const drained = drainFrames(pending)
    pending = drained.rest
    for (const frame of drained.frames) {
      if (frame.opcode === 0x1) {
        try { messages.push(JSON.parse(frame.payload.toString('utf8')) as SocketMessage) } catch { /* not a protocol message */ }
      } else if (frame.opcode === 0x2) {
        binaries += 1
      } else if (frame.opcode === 0x8 && frame.payload.length >= 2) {
        closeCode = frame.payload.readUInt16BE(0)
      }
    }
  })
  socket.on('connect', () => {
    socket.write(
      `GET /api/live-view/ws?runId=${encodeURIComponent(input.subjectId)} HTTP/1.1\r\n`
      + `host: 127.0.0.1:${String(input.port)}\r\n`
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n'
      + `sec-websocket-key: ${randomBytes(16).toString('base64')}\r\n`
      + 'sec-websocket-version: 13\r\n'
      + '\r\n',
    )
  })

  return {
    upgradeStatus: () => upgradeStatus,
    messages: () => [...messages],
    binaries: () => binaries,
    closeCode: () => closeCode,
    waitFor: async (what, predicate, budgetMs = 10_000) => {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        if (predicate()) return
        if (hungUp && !predicate()) break
        await new Promise((tick) => setTimeout(tick, 20))
      }
      if (predicate()) return
      throw new Error(
        `${what} never happened; upgrade=${String(upgradeStatus)} messages=${JSON.stringify(messages)} `
        + `binaries=${String(binaries)} close=${String(closeCode)} hungUp=${String(hungUp)}`,
      )
    },
    destroy: () => { socket.destroy() },
  }
}

/** Open, say hello, and read until the socket answers `ready` or `refused`. */
async function greet(subjectId: string, token: string): Promise<FrameSocket> {
  const socket = openFrameSocket({ port: portOf(held()), subjectId, token })
  await socket.waitFor(
    `an answer to the hello at ${subjectId}`,
    () => socket.messages().some((message) => message.type === 'ready' || message.type === 'refused'),
  )
  return socket
}

async function mintEditor(sessionId: string): Promise<{ status: number; raw: string }> {
  const response = await fetch(
    `${held().origin}/api/live-editor/sessions/${encodeURIComponent(sessionId)}/live-url`,
  )
  return { status: response.status, raw: await response.text() }
}

async function mintEditorToken(sessionId: string): Promise<string> {
  const minted = await mintEditor(sessionId)
  expect(minted.status, `the editor mint door answered ${minted.raw.slice(0, 200)}`).toBe(200)
  const token = EditorLiveUrlResultSchema.parse(JSON.parse(minted.raw)).liveUrl.split('#')[1]
  expect(typeof token, 'the liveUrl carries its token in the fragment').toBe('string')
  return token as string
}

async function mintRunToken(runId: string): Promise<string> {
  const response = await fetch(`${held().origin}/api/runs/${encodeURIComponent(runId)}/live-url`)
  const raw = await response.text()
  expect(response.status, `the run mint door answered ${raw.slice(0, 200)}`).toBe(200)
  const token = RunsLiveUrlResultSchema.parse(JSON.parse(raw)).liveUrl.split('#')[1]
  expect(typeof token, 'the run liveUrl carries its token in the fragment').toBe('string')
  return token as string
}

describe('the editor subject on the shipped composition', () => {
  it('EDITOR-LIVE-VIEW-END-TO-END: minted through the door, opened, streamed, and ended by name', async () => {
    const h = held()
    const editor = plantEditorSubject(h, { sessionId: 'ed-1', kind: 'cdp-screencast' })
    let socket: FrameSocket | undefined
    try {
      const minted = await mintEditor('ed-1')
      expect(minted.status, `a no-Origin caller mints: ${minted.raw.slice(0, 200)}`).toBe(200)
      const result = EditorLiveUrlResultSchema.parse(JSON.parse(minted.raw))
      expect(
        result.liveUrl.startsWith(`${h.origin}/live/ed-1#v2.`),
        `the embed path for the session, with the token in the fragment only: ${result.liveUrl.split('#')[0] ?? ''}`,
      ).toBe(true)
      expect(result.stream, 'the declared stream of the session').toEqual({ kind: 'cdp-screencast' })

      const token = result.liveUrl.split('#')[1] as string
      socket = await greet('ed-1', token)
      const open = socket
      expect(open.upgradeStatus(), 'the frame socket accepts the upgrade').toBe(101)
      const ready = open.messages().find((message) => message.type === 'ready')
      expect(ready, `the socket says ready: ${JSON.stringify(open.messages())}`).toBeDefined()
      expect(ready?.runId, 'the path id, reused for the editor subject').toBe('ed-1')
      expect(ready?.handle, 'an editor session has one stream, handle 0').toBe(0)
      expect(ready?.stream, 'ready names the declared stream').toEqual({ kind: 'cdp-screencast' })

      await open.waitFor(
        'a frame header and its binary',
        () => open.messages().some((message) => message.type === 'frame') && open.binaries() >= 1,
      )
      const header = open.messages().find((message) => message.type === 'frame')
      expect(typeof header?.ts, 'the frame carries its capture time').toBe('number')

      await editor.end()
      await open.waitFor(
        'ended sessionEnded and close 1000',
        () => open.messages().some((message) => message.type === 'ended') && open.closeCode() !== undefined,
      )
      expect(
        open.messages().filter((message) => message.type === 'ended'),
        'the session end is said by name, once',
      ).toEqual([{ type: 'ended', reason: 'sessionEnded' }])
      expect(open.closeCode(), 'a normal close').toBe(1000)
    } finally {
      socket?.destroy()
      await editor.close()
    }
  }, 60_000)

  it('RUN-TOKEN-CANNOT-OPEN-EDITOR: a run token at an editor subject is refused scope_mismatch', async () => {
    const h = held()
    const editor = plantEditorSubject(h, { sessionId: 'ed-1', kind: 'cdp-screencast' })
    const sockets: FrameSocket[] = []
    try {
      const runToken = await mintRunToken(RUN_ID)
      const editorToken = await mintEditorToken('ed-1')

      // The allowed twins first: each token opens its own subject, so the refusal below is about
      // the kind and not about a socket that stopped working.
      const runTwin = await greet(RUN_ID, runToken)
      const editorTwin = await greet('ed-1', editorToken)
      sockets.push(runTwin, editorTwin)
      expect(runTwin.messages().map((message) => message.type), 'the run token opens its run')
        .toContain('ready')
      expect(editorTwin.messages().map((message) => message.type), 'the editor token opens its session')
        .toContain('ready')

      const crossed = await greet('ed-1', runToken)
      sockets.push(crossed)
      expect(
        crossed.messages(),
        'a run token names a run subject, and an editor session is not one',
      ).toEqual([{ type: 'refused', reason: 'scope_mismatch' }])
    } finally {
      for (const socket of sockets) socket.destroy()
      await editor.close()
    }
  }, 60_000)

  it('EDITOR-TOKEN-CANNOT-OPEN-RUN: an editor token at a run is refused scope_mismatch', async () => {
    const h = held()
    const editor = plantEditorSubject(h, { sessionId: 'ed-1', kind: 'cdp-screencast' })
    const sockets: FrameSocket[] = []
    try {
      const editorToken = await mintEditorToken('ed-1')
      const editorTwin = await greet('ed-1', editorToken)
      sockets.push(editorTwin)
      expect(editorTwin.messages().map((message) => message.type), 'the editor token opens its session')
        .toContain('ready')

      const crossed = await greet(RUN_ID, editorToken)
      sockets.push(crossed)
      expect(
        crossed.messages(),
        'an editor token names an editor subject, and a run is not one',
      ).toEqual([{ type: 'refused', reason: 'scope_mismatch' }])
    } finally {
      for (const socket of sockets) socket.destroy()
      await editor.close()
    }
  }, 60_000)

  it('EDITOR-IS-NOT-A-RUN: the run registry never holds the editor id, and the run mint says unknown_run', async () => {
    const h = held()
    const editor = plantEditorSubject(h, { sessionId: 'ed-1', kind: 'cdp-screencast' })
    try {
      // Non-vacuity: the editor subject is held, and the run registry does hold a planted run.
      expect(h.editorSubjects.attach('ed-1'), 'the editor subject is registered').toBeDefined()
      expect(h.attachRun(RUN_ID), 'the run registry answers for a run').toBeDefined()

      expect(h.attachRun('ed-1'), 'the run registry does not attach the editor id').toBeUndefined()
      const response = await fetch(`${h.origin}/api/runs/ed-1/live-url`)
      const raw = await response.text()
      expect(response.status, `the run mint door answered ${raw.slice(0, 200)}`).toBe(404)
      expect(JSON.parse(raw), 'refused by name').toEqual({ error: 'unknown_run' })
    } finally {
      await editor.close()
    }
  }, 60_000)
})
