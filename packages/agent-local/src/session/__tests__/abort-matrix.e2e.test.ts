// Both abort arms hit one session in sequence, and the pre-repair bytes are compared after each.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_ASK_FUNCTION_ID,
  CHAT_RESOLVER_TABLE,
  createTurnEngine,
  deterministicOverrideStrategy,
  invokeFunction,
  splitClauses,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability, SessionReplay } from '@vostride/agent-qa-agent'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  FunctionCaller,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../../composition/compose-local-agent.js'
import type { LocalAgentHost } from '../../composition/compose-local-agent.js'
import { CHAT_SESSIONS_SUBDIR, ChatSessionHeaderError, createJsonlSessionLog } from '../jsonl-session-log.js'

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

// A person, so a refusal below can only be the axis under test.
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const MODEL: JobModelCapability = {
  modelId: 'fixture:abort-matrix-model',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath
const AT = '2026-08-09T12:00:00.000Z'

describe('the abort matrix: one session, both arms, then it carries on', () => {
  let root: string
  let agentQaRoot: string
  let host: LocalAgentHost
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-abort-matrix-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => MODEL,
    })
    hosts.push(host)
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function ask(message: string, sessionId?: string): Promise<AgentAskResult> {
    return (await invokeFunction(
      host.registry,
      AGENT_ASK_FUNCTION_ID,
      sessionId === undefined ? { message } : { message, sessionId },
      HUMAN,
    )) as AgentAskResult
  }

  function pathOf(sessionId: string): string {
    return join(agentQaRoot, CHAT_SESSIONS_SUBDIR, `${sessionId}.jsonl`)
  }

  function eventsOn(sessionId: string): ChatSessionEvent[] {
    return readFileSync(pathOf(sessionId), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .slice(1)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ChatSessionEvent]
        } catch {
          return []
        }
      })
  }

  /** A second writer on the same file — which is exactly what the process that died was. */
  function sideLog(): ReturnType<typeof createJsonlSessionLog> {
    return createJsonlSessionLog({
      root: agentQaRoot,
      now: () => AT,
      model: () => 'unbound',
      toolsetHash: () => 'toolset-abort',
    })
  }

  it('graceful Ctrl+C then hard kill, both repaired, and the session continues', async () => {
    // ---- Turn 1: an ordinary completed turn, so the file starts life healthy.
    const first = await ask('/fn quarantine.list')
    const sessionId = first.sessionId
    expect(first.status).toBe('completed')

    // ---- ARM ONE. What a Ctrl+C handler writes: the turn it was in the middle of, and its own
    // `aborted` record, landed at a boundary. Written through the REAL adapter, because a process
    // that can handle a signal is a process still holding this exact code.
    const graceful = await sideLog().open(sessionId)
    await graceful.append({ kind: 'user_message', turnId: 'turn-ctrlc', at: AT, text: 'digest RUN-1' })
    await graceful.append({ kind: 'aborted', turnId: 'turn-ctrlc', at: AT, source: 'explicit' })
    await graceful.turnBoundary()
    await graceful.close()

    const beforeGracefulRepair = readFileSync(pathOf(sessionId))

    // The next turn REOPENS the session — and must add nothing of its own to a turn that already
    // said how it ended.
    const afterGraceful = await ask('/fn quarantine.list', sessionId)
    expect(afterGraceful.status).toBe('completed')
    expect(afterGraceful.sessionId).toBe(sessionId)

    const aborts = eventsOn(sessionId).filter((event) => event.kind === 'aborted')
    expect(aborts).toEqual([
      { kind: 'aborted', turnId: 'turn-ctrlc', at: AT, source: 'explicit' },
    ])
    expect(readFileSync(pathOf(sessionId)).subarray(0, beforeGracefulRepair.length)).toEqual(
      beforeGracefulRepair,
    )

    // ---- ARM TWO. A turn that started and never finished, then the bytes cut mid-line. This is
    // the shape a SIGKILL leaves: a fragment where a JSON document should be, and no abort record
    // anywhere, because nothing was alive to write one.
    const dying = await sideLog().open(sessionId)
    await dying.append({ kind: 'user_message', turnId: 'turn-kill', at: AT, text: 'digest RUN-2' })
    await dying.append({
      kind: 'stage_outcome',
      turnId: 'turn-kill',
      at: AT,
      stage: 'resolver',
      outcome: 'resolved',
    })
    await dying.turnBoundary()
    await dying.close()

    const wholeLines = readFileSync(pathOf(sessionId), 'utf8').split('\n')
    const finalLine = wholeLines.at(-2)!
    const intactBytes = statSync(pathOf(sessionId)).size - Buffer.byteLength(finalLine, 'utf8') - 1
    // Cut INSIDE the final line: what survives is a fragment, not a short-but-whole record.
    truncateSync(pathOf(sessionId), intactBytes + 12)
    const beforeKillRepair = readFileSync(pathOf(sessionId))
    expect(beforeKillRepair.length).toBeLessThan(intactBytes + Buffer.byteLength(finalLine))

    // ---- The next turn repairs, then does its own work.
    const afterKill = await ask('/fn quarantine.list', sessionId)
    expect(afterKill.status).toBe('completed')

    const events = eventsOn(sessionId)
    const kinds = events.map((event) => event.kind)

    // The synthesized abort names the turn the kill interrupted, is marked as machine-written, and
    // lands BEFORE the resumed turn's first word — which is the on-disk form of "repair runs first".
    const synthesized = events.filter(
      (event) => event.kind === 'aborted' && event.source === 'synthesized',
    )
    expect(synthesized).toEqual([
      { kind: 'aborted', turnId: 'turn-kill', at: expect.any(String), source: 'synthesized' },
    ])
    expect(kinds.lastIndexOf('aborted')).toBeLessThan(kinds.lastIndexOf('user_message'))

    // The torn fragment is gone from the record, and the turn it belonged to is closed exactly
    // once — the two arms did not produce two different answers to "how did this turn end".
    expect(events.filter((event) => event.turnId === 'turn-kill' && event.kind === 'stage_outcome'))
      .toEqual([])
    expect(events.filter((event) => event.kind === 'aborted')).toHaveLength(2)

    // The session is a working conversation again: the resumed turn ran and landed its boundary.
    expect(kinds.at(-1)).toBe('turn_complete')

    // APPEND-ONLY, byte-verified: everything that was on the file before the repair is still there,
    // byte for byte, and the repair only ever added after it.
    expect(readFileSync(pathOf(sessionId)).subarray(0, beforeKillRepair.length)).toEqual(
      beforeKillRepair,
    )
  })

  // THE REGRESSION THIS SUITE FOUND, kept as its own claim. A torn line has no trailing newline,
  // so the first thing appended after it lands ON it and fuses two records into one unreadable
  // line. That turns a bounded, understood loss into permanent damage — and worse, the next open
  // sees the fused line as a fresh tear and loses the synthesized abort with it, so the session is
  // poisoned every time it is resumed. One newline, appended before anything else, is the whole
  // fix; the fragment survives verbatim as its own line for anyone auditing the file.
  it('repair terminates the torn fragment instead of writing onto it', async () => {
    const first = await ask('/fn quarantine.list')
    const sessionId = first.sessionId
    const path = pathOf(sessionId)

    const dying = await sideLog().open(sessionId)
    await dying.append({ kind: 'user_message', turnId: 'turn-kill', at: AT, text: 'digest RUN-2' })
    await dying.append({
      kind: 'stage_outcome',
      turnId: 'turn-kill',
      at: AT,
      stage: 'resolver',
      outcome: 'resolved',
    })
    await dying.turnBoundary()
    await dying.close()
    truncateSync(path, statSync(path).size - 20)
    const fragment = readFileSync(path, 'utf8').split('\n').at(-1)!
    expect(fragment).not.toBe('')

    const opened = await sideLog().open(sessionId)

    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
    // The fragment is still exactly the bytes the crash left, on a line of its own.
    expect(lines).toContain(fragment)
    // And every OTHER line still parses — the abort did not land on top of anything.
    const unparseable = lines.filter((line) => {
      try {
        JSON.parse(line)
        return false
      } catch {
        return true
      }
    })
    expect(unparseable).toEqual([fragment])
    expect(opened.events.at(-1)).toMatchObject({ kind: 'aborted', source: 'synthesized' })
    await opened.close()

    // NOT POISONED FOREVER. On the next open the fragment is no longer the tail, so it is reported
    // as ordinary mid-file damage — permanent, named, and costing the session nothing else. The
    // abort earned by the first repair is still there, so nothing further is synthesized.
    const reopened = await sideLog().open(sessionId)
    expect(reopened.refusedLines).toHaveLength(1)
    expect(reopened.refusedLines[0]?.reason).toContain('unparseable line')
    expect(
      reopened.events.filter((event) => event.kind === 'aborted'),
    ).toHaveLength(1)
    await reopened.close()
  })

  // The third crash shape, named so that nobody reads the two arms above as a claim about all
  // damage: a torn HEADER is refused outright. A build that guessed at an unreadable header would
  // append to a file whose grammar it does not know, in the one direction no later read can undo.
  it('a torn header refuses to open by name, and never becomes a silent new session', async () => {
    const first = await ask('/fn quarantine.list')
    const path = pathOf(first.sessionId)
    const bytes = readFileSync(path, 'utf8')
    truncateSync(path, 20)

    const error = await ask('/fn quarantine.list', first.sessionId).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ChatSessionHeaderError)
    expect((error as Error).message).toContain('not JSON')
    // Nothing was created to paper over it: the file is still the truncated one.
    expect(readFileSync(path, 'utf8')).toBe(bytes.slice(0, 20))
  })

  it('the resume path names the repair — an open that skipped it would be a silent read', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'jsonl-session-log.ts'), 'utf8')
    const openBody = source.slice(source.indexOf('open(sessionId?: string)'))

    expect(openBody).toContain('repairSession(')
    // And the repair's own write lands, so a second crash cannot lose the abort the first one
    // earned. Without this the same session would dangle again and the loss bound would stop
    // being the in-flight turn.
    expect(openBody.slice(openBody.indexOf('repairSession('))).toContain('fsyncSync')
  })
})

// A degrade pass is handed the repaired replay, so repair before pruning is fixed by the type.
describe('the compaction pass is handed an already-repaired conversation', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-abort-prune-order-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sees the aborted turn excluded, not the partial work the crash left behind', async () => {
    const sessionLog = createJsonlSessionLog({
      root,
      now: () => AT,
      model: () => 'unbound',
      toolsetHash: () => 'toolset-abort',
    })
    const seen: SessionReplay[] = []
    const engine = createTurnEngine({
      table: CHAT_RESOLVER_TABLE,
      split: splitClauses,
      reconcile: deterministicOverrideStrategy,
      sessionLog,
      mint: { forStage: () => HUMAN },
      // The classified envelope with the legacy verdict; what an op returns is not under test here.
      invoke: () => Promise.resolve({ payload: {}, verdict: { status: 'executed' as const, outcome: '' }, foldLines: [] }),
      compaction: ({ replay }) => {
        seen.push(replay)
      },
      now: () => AT,
      mintTurnId: () => 'turn-resumed',
    })

    const seeded = await sessionLog.open()
    const sessionId = seeded.header.sessionId
    await seeded.append({ kind: 'user_message', turnId: 'turn-1', at: AT, text: 'proposals' })
    await seeded.append({
      kind: 'clause_receipt',
      turnId: 'turn-1',
      at: AT,
      clause: 'proposals',
      functionId: 'proposals.list',
      origin: 'human',
      status: 'executed',
      outcome: 'proposals.list completed',
    })
    await seeded.append({ kind: 'turn_complete', turnId: 'turn-1', at: AT, status: 'completed' })
    // The dangling turn: a user message and nothing that closes it.
    await seeded.append({ kind: 'user_message', turnId: 'turn-dead', at: AT, text: 'digest RUN-9' })
    await seeded.turnBoundary()
    // Closed before the engine runs: one live handle per session, so a held one is refused.
    await seeded.close()

    await engine.runTurn({ message: '/fn quarantine.list', sessionId })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.abortedTurnIds).toEqual(['turn-dead'])
    // The completed turn survives; the interrupted one contributes nothing a model would answer.
    expect(seen[0]?.messages.map((message) => message.turnId)).toEqual(['turn-1', 'turn-1'])
  })
})
