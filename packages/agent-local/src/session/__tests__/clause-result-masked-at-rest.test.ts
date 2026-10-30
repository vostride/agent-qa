// The payload is masked by an explicit declared mask, never an ambient context, and never restored.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHAT_RESOLVER_TABLE,
  createTurnEngine,
  deterministicOverrideStrategy,
  splitClauses,
} from '@vostride/agent-qa-agent'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { maskPayloadStrings } from '@vostride/agent-qa-schema'
import type { FunctionCaller, MaskFn } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHAT_SESSIONS_SUBDIR, createJsonlSessionLog } from '../jsonl-session-log.js'

const NOW = '2026-08-20T00:00:00.000Z'
const QUARANTINE_LIST = 'quarantine.list'

const PLANTED_CREDENTIAL = 'sk-live-399105-Wq7zR2mKpX4nT8vB'
const MARKER = '[secret:PLANTED_SECRET]'

const HUMAN: FunctionCaller = { origin: 'human', surface: 'cli' } as unknown as FunctionCaller

describe('clause_result persists the MASKED payload, on the real file', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-clause-result-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the PLACEHOLDER and never the credential — and the placeholder really stands for it',
    async () => {
      const mask: MaskFn = (text) => new SecretRedactor(
        SecretStore.fromEnvContent(`PLANTED_SECRET=${PLANTED_CREDENTIAL}\n`),
      ).redactString(text)
      const maskedPayload = maskPayloadStrings(
        { entries: [{ id: 'P-1', token: PLANTED_CREDENTIAL }] }, mask,
      ) as unknown

      // THE MASK ACTUALLY FIRED, so the absence below is not vacuous.
      expect(JSON.stringify(maskedPayload)).not.toContain(PLANTED_CREDENTIAL)
      expect(JSON.stringify(maskedPayload)).toContain(MARKER)

      const sessionLog = createJsonlSessionLog({
        root,
        now: () => NOW,
        model: () => 'unbound',
        toolsetHash: () => 'toolset-0001',
        random: () => 0.5,
      })

      const engine = createTurnEngine({
        table: CHAT_RESOLVER_TABLE,
        split: splitClauses,
        reconcile: deterministicOverrideStrategy,
        sessionLog,
        // The mint takes no session and stamps none, as production's does.
        mint: { forStage: () => HUMAN },
        // THE OP ANSWERS WITH THE MASKED PAYLOAD. This is the one fixture fact; everything after it
        // is the shipped engine and the shipped adapter.
        invoke: () => Promise.resolve({
          payload: maskedPayload,
          verdict: { status: 'executed' as const, outcome: '1 quarantine entry' },
          foldLines: [],
        }),
        now: () => NOW,
        mintTurnId: () => 'turn-1',
      })

      const result = await engine.runTurn({ message: '/fn quarantine.list' })
      expect(result.status).toBe('completed')
      expect(result.results).toHaveLength(1)

      // THE BYTES, off the file the adapter actually wrote — not the handle, not the event object.
      const sessionId = (result as { sessionId?: string }).sessionId
      expect(sessionId).toBeDefined()
      const file = join(root, CHAT_SESSIONS_SUBDIR, `${String(sessionId)}.jsonl`)
      const bytes = readFileSync(file, 'utf8')

      // THE EVENT IS THERE, addressed to the op, carrying the payload verbatim as it rode
      // `results[]` — a persistence that dropped or summarised it would satisfy the absence
      // assertion below trivially, so the presence half is asserted first.
      const events = bytes.split('\n').filter((line) => line !== '').slice(1)
        .map((line) => JSON.parse(line) as { kind: string; functionId?: string; payload?: unknown })
      const persisted = events.filter((event) => event.kind === 'clause_result')
      expect(persisted).toHaveLength(1)
      expect(persisted[0]?.functionId).toBe(QUARANTINE_LIST)
      expect(persisted[0]?.payload).toEqual(maskedPayload)

      // THE CLAIM. Not one byte of the credential is on this disk — anywhere in the file, not
      // merely on the line under test, because a leak on the receipt line is the same leak.
      expect(bytes).not.toContain(PLANTED_CREDENTIAL)

      // THE PLACEHOLDER STANDS FOR THE CREDENTIAL: it names the declared secret, and the same mask
      // over the raw value yields exactly it.
      expect(bytes).toContain(MARKER)
      expect(mask(PLANTED_CREDENTIAL)).toBe(MARKER)
    })

  it('replays: a log carrying clause_result reopens clean, with the event in the history',
    async () => {
      // APPEND-ONLY MEANS THE READER SURVIVES THE WIDENING. `open(sessionId)` runs the adapter's
      // real guard/repair path over every line, so a kind the reader did not know would surface
      // here as a refused line rather than as a green in-memory object.
      const sessionLog = createJsonlSessionLog({
        root,
        now: () => NOW,
        model: () => 'unbound',
        toolsetHash: () => 'toolset-0001',
        random: () => 0.5,
      })
      const engine = createTurnEngine({
        table: CHAT_RESOLVER_TABLE,
        split: splitClauses,
        reconcile: deterministicOverrideStrategy,
        sessionLog,
        // The mint takes no session and stamps none, as production's does.
        mint: { forStage: () => HUMAN },
        invoke: () => Promise.resolve({
          payload: { entries: [] },
          verdict: { status: 'executed' as const, outcome: '0 quarantine entries' },
          foldLines: [],
        }),
        now: () => NOW,
        mintTurnId: () => 'turn-1',
      })

      const result = await engine.runTurn({ message: '/fn quarantine.list' })
      const sessionId = String((result as { sessionId?: string }).sessionId)

      const reopened = await sessionLog.open(sessionId)
      try {
        // NOT ONE REFUSED LINE. This is the whole replay-safety claim: the widened vocabulary did
        // not make any byte this build wrote unreadable to the build that reads it.
        expect(reopened.refusedLines).toEqual([])
        const kinds = reopened.events.map((event) => event.kind)
        expect(kinds).toContain('clause_result')
        expect(kinds).toContain('clause_receipt')
        expect(kinds).toContain('turn_complete')
      } finally {
        await reopened.close()
      }
    })
})
