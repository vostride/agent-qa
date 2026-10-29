import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { MARK_RECEIPT_SCHEMA_VERSION, asRunId, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  MarkReceipt,
  MaskFn,
  RunsMarkInput,
} from '@vostride/agent-qa-schema'
import { expect, it, vi } from 'vitest'

import { CHAT_SESSIONS_SUBDIR, createJsonlSessionLog } from '../../session/jsonl-session-log.js'
import { composeLocalAgent } from '../compose-local-agent.js'

it.each([true, false])('projects real mark chat with active masking=%s and preserves canonical bytes', async active => {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-chat-mark-masking-'))
  const canary = 'T41916-canary-note-not-a-real-credential'
  const declared = new SecretRedactor(SecretStore.fromEnvContent(`CANARY_441=${canary}\n`))
  const mask: MaskFn = active ? (text) => declared.redactString(text) : (text) => text
  const placeholder = '[secret:CANARY_441]'
  expect(declared.redactString(canary)).toBe(placeholder)
  const projectedNote = active ? placeholder : canary
  const input: RunsMarkInput = { runId: asRunId('audit-run'), kind: 'false-fail', note: canary }
  const canonical: MarkReceipt = {
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runId: input.runId, runSlug: 'audit-run',
    testIndex: 0, kind: input.kind, origin: 'user', ordinal: 1, markedAt: 0, note: canary,
    disposition: { kind: 'quarantined', class: 'flake' },
    evidence: { confirmed: 0, overturned: 0 },
  }
  const canonicalBytes = JSON.stringify(canonical)
  // The real registry operation receives and returns raw canonical feedback, just as the host
  // ledger does. Nothing in this test pre-masks the port's input or its result.
  const mark = vi.fn(async (_input: RunsMarkInput) => ({ kind: 'marked' as const, receipt: canonical }))
  const observed: ChatSessionEvent[] = []
  const model = vi.fn(() => { throw new Error('deterministic chat must not resolve a model') })
  const confirm = vi.fn(() => true)
  const host = composeLocalAgent({
    mask,
    agentQaRoot: root,
    mintQuarantineIdentityPath: path => path,
    config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }) },
    knowledgeRoot: () => join(root, 'knowledge'),
    model,
    feedback: { mark, marksFor: async () => [] },
    resolveExecutionContext: () => 'local-interactive',
    // The input type declares no `confirm`; the spy is smuggled past it.
    ...{ confirm: { surface: 'tty-prompt', ask: confirm } } as object,
    observeSessionEvent: (_sessionId, event) => { observed.push(event) },
  })
  try {
    const message = `/fn runs.mark ${JSON.stringify(input)}`
    const result = await invokeFunction(host.registry, 'agent.ask', { message }, {
      surface: 'cli', origin: 'human',
    }) as AgentAskResult
    expect(result.status).toBe('completed')
    expect(mark).toHaveBeenCalledExactlyOnceWith(input)
    expect(confirm).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(JSON.stringify(canonical)).toBe(canonicalBytes)
    expect(canonical.note).toBe(canary)
    expect(result.receipts).toMatchObject([{ functionId: 'runs.mark', status: 'executed',
      outcome: 'marked false-fail · quarantined', origin: 'human' }])
    expect.soft(result.results).toEqual([{ functionId: 'runs.mark', payload: {
      kind: 'marked', receipt: { ...canonical, note: projectedNote },
    } }])
    if (active) expect.soft(JSON.stringify(result)).not.toContain(canary)
    else expect(JSON.stringify(result)).toContain(canary)
    expect(JSON.parse(JSON.stringify(result.results[0]?.payload).replaceAll(placeholder, canary)))
      .toEqual({ kind: 'marked', receipt: canonical })

    const bytes = readFileSync(join(root, CHAT_SESSIONS_SUBDIR, `${result.sessionId}.jsonl`), 'utf8')
    const events = bytes.trim().split('\n').slice(1).map(line => JSON.parse(line) as ChatSessionEvent)
    expect(events).toEqual(observed)
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining([
      'user_message', 'clause_result', 'clause_receipt', 'turn_complete',
    ]))
    expect(events.find(event => event.kind === 'clause_result')).toMatchObject({
      functionId: 'runs.mark', payload: result.results[0]?.payload,
    })
    if (active) expect.soft(bytes).not.toContain(canary)
    expect.soft(bytes).toContain(projectedNote)

    const reader = createJsonlSessionLog({ root, now: () => new Date().toISOString(),
      model: () => 'unbound', toolsetHash: () => 'unused' })
    const reopened = await reader.open(result.sessionId)
    try {
      expect(reopened.refusedLines).toEqual([])
      expect(reopened.events).toEqual(events)
    } finally { await reopened.close() }

    // Reopening a conversation replays context, not old dispatches. The next resolver turn
    // must not feed a persisted placeholder back to the mark operation as authored input.
    const next = await invokeFunction(host.registry, 'agent.ask', {
      message: '/help', sessionId: result.sessionId,
    }, { surface: 'cli', origin: 'human' }) as AgentAskResult
    expect(next.status).toBe('completed')
    expect(mark).toHaveBeenCalledExactlyOnceWith(input)
    expect(model).not.toHaveBeenCalled()
  } finally {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
