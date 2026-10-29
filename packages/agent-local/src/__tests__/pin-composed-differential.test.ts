// `/pin` through the composed stack. `/pin` is not a directive or an alias: it is an ordinary
// clause stage 1 does not resolve, so it reaches the planner, here a tripwire that refuses, and the
// turn fails closed with nothing run. The three arms check it reaches nothing else: the op executes
// before and after a typed `/pin`, the scope control is unchanged, no row is written at the
// execution audit file the composition writes, and no `approval_decision` lands in the session.
// The reads go through `quarantine.list`, an allow-tier read that answers with an empty listing in
// a bare temp project.

import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ASK_FUNCTION_ID,
  QUARANTINE_LIST_FUNCTION_ID,
  RUNS_LIST_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { ChatLanguageModel, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  ChatSessionEvent,
  FunctionCaller,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHAT_SESSIONS_SUBDIR } from '../session/jsonl-session-log.js'
import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type { LocalAgentHost } from '../composition/compose-local-agent.js'

/** The class the person pins. The NORMALISED spelling the holder records and the gate compares. */
const PINNED_CLASS = `fn:${QUARANTINE_LIST_FUNCTION_ID}`

/** The class the pin must NOT reach — the scope control's subject. */
const UNPINNED_CLASS = `fn:${RUNS_LIST_FUNCTION_ID}`

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be the pin. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const JOB_MODEL: JobModelCapability = {
  modelId: 'fixture:pin-differential',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const MINT_IDENTITY = (filePath: string): string => filePath

// A planner that fails the turn whenever it is reached.
function plannerTripwire(): ChatLanguageModel {
  const reached = (): never => {
    throw new Error('the planner tripwire refuses every clause')
  }
  return {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'fixture:tripwire',
    supportedUrls: {},
    doGenerate: reached,
    doStream: reached,
  } as unknown as ChatLanguageModel
}

interface AuditRow {
  readonly action: string
  readonly verdict: string
  readonly outcome: string
  readonly reason: string
}

describe('retired: a typed /pin reaches nothing through the composed stack', () => {
  let root: string
  let agentQaRoot: string
  let host: LocalAgentHost

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pin-composed-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => JOB_MODEL,
      chatModel: plannerTripwire(),
    })
  })

  afterEach(() => {
    void host.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** One turn through the registered op, on the session the previous turn opened. */
  async function ask(message: string, sessionId?: string): Promise<AgentAskResult> {
    return (await invokeFunction(
      host.registry,
      AGENT_ASK_FUNCTION_ID,
      { message, ...(sessionId === undefined ? {} : { sessionId }) },
      HUMAN,
    )) as AgentAskResult
  }

  function sessionEvents(sessionId: string): readonly ChatSessionEvent[] {
    return readFileSync(join(agentQaRoot, CHAT_SESSIONS_SUBDIR, `${sessionId}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .slice(1)
      .map((line) => JSON.parse(line) as ChatSessionEvent)
  }

  /** The audit trail as the COMPOSITION writes it — the real file, not a spy. */
  function auditRows(): readonly AuditRow[] {
    const path = join(agentQaRoot, 'execution_audit.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AuditRow)
  }

  it('all three arms execute, before and after a typed /pin, with no audit row', async () => {
    // ---- ARM 1: no pin. The op executes; no gate records a decision.
    const before = await ask('/fn quarantine.list')
    expect(before.status).toBe('completed')
    expect(before.receipts.map((receipt) => receipt.functionId)).toEqual([
      QUARANTINE_LIST_FUNCTION_ID,
    ])
    expect(before.receipts[0]?.status).toBe('executed')

    // ---- `/pin`, typed into the SAME session: a clause nothing routes, so the turn refuses it.
    const pinned = await ask(`/pin ${QUARANTINE_LIST_FUNCTION_ID}`, before.sessionId)
    expect(pinned.status).toBe('fail_closed')
    expect(pinned.receipts).toEqual([])
    expect(pinned.answer ?? '').not.toContain(PINNED_CLASS)
    expect(
      sessionEvents(before.sessionId).filter((event) => event.kind === 'approval_decision'),
    ).toEqual([])

    // ---- ARM 2: the SAME utterance, same session, same composition. Still executes.
    const after = await ask('/fn quarantine.list', before.sessionId)
    expect(after.status).toBe('completed')
    expect(after.receipts[0]?.status).toBe('executed')

    // ---- ARM 3: the scope control, unchanged.
    const other = await ask('status', before.sessionId)
    expect(other.status).toBe('completed')
    expect(other.receipts.map((receipt) => receipt.functionId)).toEqual([RUNS_LIST_FUNCTION_ID])
    expect(other.receipts[0]?.status).toBe('executed')

    // No decision row of any kind at the file the composition writes.
    expect(auditRows()).toEqual([])
  })

  // RE-SPELLED 2026-09-30 from 'the pin is a LIVE view: a second class pinned mid-session
  // denies from the next turn'. There is no pin set to be live.
  it('a /pin typed mid-session denies nothing on the next turn', async () => {
    const opened = await ask('status')
    expect(opened.receipts[0]?.status).toBe('executed')

    await ask(`/pin ${RUNS_LIST_FUNCTION_ID}`, opened.sessionId)
    const after = await ask('status', opened.sessionId)

    expect(after.receipts[0]?.status).toBe('executed')
    expect(auditRows().some((row) => row.action === UNPINNED_CLASS
      && row.outcome === 'session-pin-denied')).toBe(false)
  })

  it('a /pin against a class this host does not declare is refused by name, like any unrouted clause', async () => {
    const refused = await ask('/pin nonsense.notacapability')

    expect(refused.status).toBe('fail_closed')
    expect(refused.unhandled?.clause).toBe('/pin nonsense.notacapability')
    // And it left a countable row, like every other refusal.
    expect(
      sessionEvents(refused.sessionId).filter((event) => event.kind === 'mark_unhandled'),
    ).toHaveLength(1)
  })
})

describe('the pin differential drives the composed stack, not the gate directly', () => {
  it('reaches the gate only through invokeFunction — SPECIFIERS, never vocabulary', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Structure, not words: this file's header discusses the gate and `evaluate()` repeatedly and
    // must stay free to. What is pinned is which modules it is built out of.
    const specifiers = [...source.matchAll(/^import[^'\n]*'([^']+)'/gm)].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(4)
    expect(specifiers.filter((specifier) => specifier.includes('agent-qa-safety'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.includes('pin-overlay'))).toEqual([])
    // POSITIVE CONTROL: without it, "no such import" and "the walker found nothing" are one green.
    expect(specifiers).toContain('../composition/compose-local-agent.js')
  })
})
