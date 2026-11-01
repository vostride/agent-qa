// A declared value typed in chat is stored as `[secret:<name>]`; an undeclared one as typed.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENT_ASK_FUNCTION_ID, invokeFunction } from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import {
  createJsonlSessionLog, listSessions, type ComposeLocalAgentInput,
} from '@vostride/agent-qa-agent-local'
import {
  CHAT_SESSION_EVENT_KINDS, CHAT_TURN_STATUSES, CLAUSE_RECEIPT_STATUSES,
  type AgentAskResult, type MaskFn,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runDaemonHost, type DaemonHostOperations } from '../../daemon/host.js'
import { createDeclaredSecretMask } from '../declared-secrets.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'

const DECLARED = 'Hunter-42-zz'
const MARKER = '[secret:PW_KEY]'
const UNDECLARED = 'sk-PROBE-123456'
const TYPED = `use ${DECLARED} with ${UNDECLARED}`
const MESSAGE = `/fn knowledge.record.show ${JSON.stringify({ recordId: TYPED })}`
const KEYED_INPUT_MESSAGE =
  `/fn knowledge.record.show ${JSON.stringify({ [DECLARED]: 1, recordId: 'x' })}`
const KEYED_RESULT_MESSAGE = `/fn runs.detail ${JSON.stringify({ runId: 'run-keyed' })}`

const CONFIG = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  mobile:
    appState: preserve
  parallel: false
`

interface SessionEvent {
  readonly kind: string
  readonly text?: string
  readonly clause?: string
  readonly payload?: unknown
}

let root: string
let configPath: string
let agentQaRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-'))
  configPath = join(root, 'agent-qa.config.yaml')
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  writeFileSync(configPath, CONFIG)
  writeFileSync(join(root, '.env.secrets.local'), `PW_KEY=${DECLARED}\n`)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function typeInChat(): Promise<AgentAskResult> {
  const host = composeCliLocalAgent({ agentQaRoot, configPath })
  try {
    return await runSafetyScope(
      { executionContext: 'local-interactive' },
      async () => await invokeFunction(
        host.registry, AGENT_ASK_FUNCTION_ID, { message: MESSAGE }, CLI_FUNCTION_CALLER,
      ) as AgentAskResult,
    )
  } finally {
    await host.close()
  }
}

function sessionBytes(): string {
  const dir = join(agentQaRoot, 'sessions')
  if (!existsSync(dir)) return ''
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFileSync(join(dir, name), 'utf8')).join('')
}

function sessionEvents(kind: string): SessionEvent[] {
  return sessionBytes().split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SessionEvent)
    .filter((event) => event.kind === kind)
}

const DAEMON_MODEL: JobModelCapability = {
  modelId: 'test:chat-daemon',
  generate: () => Promise.reject(new Error('the daemon cells never author')),
}

async function daemonMask(withConfigPath: boolean): Promise<MaskFn | undefined> {
  const signals = new Map<NodeJS.Signals, () => void>()
  const errors: string[] = []
  let composed: ComposeLocalAgentInput | undefined
  const operations = {
    setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    setTimeout: () => 2 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    onSignal: (signal: NodeJS.Signals, listener: () => void) => { signals.set(signal, listener) },
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: (code: number) => { throw new Error(`unexpected hard exit ${code}`) },
    startHeartbeatSupervisor: () => Promise.resolve({
      exited: Promise.resolve(), stop: () => Promise.resolve(),
    }),
    composeJobRecovery: () => ({
      store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
      recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
      resumePending: () => Promise.resolve([]),
      close: vi.fn(),
    }),
    composeLocalAgent: (input: ComposeLocalAgentInput) => {
      composed = input
      return {
        registry: {},
        jobs: () => Promise.resolve({
          queue: { runNextJob: () => Promise.resolve({ ran: false, reason: 'no-job' }) },
        }),
        close: vi.fn(),
      }
    },
    inspectDrainableCurationWork: () => ({ queuedCandidateIds: [], recoverableClaimedCandidateIds: [] }),
    countRemainingCurationWork: () => ({ queued: 0, claimedNonterminal: 0, quarantined: 0 }),
    listQueuedCandidates: () => [],
    drainQueue: () => Promise.resolve({ drained: 0 }),
    appendDrainSessionReceipt: () => undefined,
    startInvokeServer: (started: { socketPath: string }) => Promise.resolve({
      socketPath: started.socketPath, close: () => Promise.resolve(),
    }),
  } as unknown as Partial<DaemonHostOperations>

  const running = runDaemonHost({
    agentQaRoot,
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    ...(withConfigPath ? { configPath } : {}),
    config: {
      getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath, entries: [] }),
    },
    model: () => DAEMON_MODEL,
    operations,
    logger: { info: vi.fn(), error: (message) => errors.push(message) },
  })
  const deadline = Date.now() + 30_000
  while (composed === undefined || !signals.has('SIGTERM')) {
    if (errors.length > 0) throw new Error(`the daemon refused to start: ${errors.join(' | ')}`)
    if (Date.now() >= deadline) throw new Error('the daemon never composed its local agent')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  signals.get('SIGTERM')?.()
  await running
  return composed.mask
}

describe('declared secrets in chat transcripts and turn results', () => {
  it('a declared secret typed in chat is masked in user_message and clause_receipt', async () => {
    await typeInChat()

    const messages = sessionEvents('user_message')
    const receipts = sessionEvents('clause_receipt')
    expect(messages).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(messages[0]?.text).toContain(MARKER)
    expect(receipts[0]?.clause).toContain(MARKER)
    expect(sessionBytes()).not.toContain(DECLARED)
  })

  it('an undeclared credential typed in chat is stored as typed', async () => {
    await typeInChat()

    const messages = sessionEvents('user_message')
    const receipts = sessionEvents('clause_receipt')
    expect(messages[0]?.text).toContain(`use ${MARKER} with ${UNDECLARED}`)
    expect(receipts[0]?.clause).toContain(`use ${MARKER} with ${UNDECLARED}`)
  })

  it('the op result and the turn result are masked with the same mask', async () => {
    const result = await typeInChat()

    const persisted = sessionEvents('clause_result')
    expect(persisted).toHaveLength(1)
    const opResult = JSON.stringify(persisted[0]?.payload)
    expect(opResult).toContain(MARKER)
    expect(opResult).not.toContain(DECLARED)

    const turn = JSON.stringify(result)
    expect(result.results).toHaveLength(1)
    expect(JSON.stringify(result.results[0]?.payload)).toContain(MARKER)
    expect(JSON.stringify(result.receipts)).toContain(MARKER)
    expect(turn).toContain(UNDECLARED)
    expect(turn).not.toContain(DECLARED)
  })

  it('the daemon composes its host with the declared mask for its config path', async () => {
    const mask = await daemonMask(true)

    expect(mask?.(TYPED)).toBe(`use ${MARKER} with ${UNDECLARED}`)
  })

  it('a daemon host composed with no config path passes the identity', async () => {
    const mask = await daemonMask(false)

    expect(mask?.(TYPED)).toBe(TYPED)
  })
})

// The recorded objects runs.detail serves are open records, so an op result can hold a data key.
const KEYED_RUN_DETAIL: NonNullable<Parameters<typeof composeCliLocalAgent>[0]['runDetail']> = {
  read: () => Promise.resolve({
    runId: 'run-keyed',
    members: [],
    steps: [],
    subActions: [{
      testIndex: 0,
      stepIndex: 0,
      subActionIndex: 0,
      plan: 'fill the form',
      plannedAction: { type: 'fill', [DECLARED]: 'x' },
      result: { success: true },
      screenStateHash: 'hash',
    }],
  } as never),
}

async function sendInChat(
  message: string,
  runDetail?: typeof KEYED_RUN_DETAIL,
): Promise<AgentAskResult> {
  const host = composeCliLocalAgent({
    agentQaRoot, configPath, ...(runDetail === undefined ? {} : { runDetail }),
  })
  try {
    return await runSafetyScope(
      { executionContext: 'local-interactive' },
      async () => await invokeFunction(
        host.registry, AGENT_ASK_FUNCTION_ID, { message }, CLI_FUNCTION_CALLER,
      ) as AgentAskResult,
    )
  } finally {
    await host.close()
  }
}

describe('a declared value used as a payload key', () => {
  it('a declared value used as a payload key is masked in the session file and the turn result', async () => {
    const refused = await sendInChat(KEYED_INPUT_MESSAGE)
    const answered = await sendInChat(KEYED_RESULT_MESSAGE, KEYED_RUN_DETAIL)

    const persisted = sessionEvents('clause_result')
    expect(persisted).toHaveLength(1)
    const detail = persisted[0]?.payload as {
      readonly subActions?: ReadonlyArray<{ readonly plannedAction?: object }>
    } | undefined
    expect(Object.keys(detail?.subActions?.[0]?.plannedAction ?? {})).toContain(MARKER)
    expect(sessionBytes()).not.toContain(DECLARED)
    expect(JSON.stringify(refused)).not.toContain(DECLARED)
    expect(JSON.stringify(answered)).not.toContain(DECLARED)
  })
})

describe('chat sessions with a one-character declared value', () => {
  beforeEach(() => {
    writeFileSync(join(root, '.env.secrets.local'), `T_KEY=t\nPW_KEY=${DECLARED}\n`)
  })

  function sessionFileLines(): string[] {
    const dir = join(agentQaRoot, 'sessions')
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    return readFileSync(join(dir, files[0]!), 'utf8').split('\n').filter((line) => line.trim() !== '')
  }

  it('a chat session written while a one-character value is declared re-opens with every event', async () => {
    const answered = await sendInChat(MESSAGE).then((result) => result, (error: unknown) => error)

    const lines = sessionFileLines()
    const { sessionId } = JSON.parse(lines[0]!) as { sessionId: string }
    const log = createJsonlSessionLog({
      root: agentQaRoot, now: () => new Date(0).toISOString(), model: () => 'unbound', toolsetHash: () => 'unbound',
    })
    const reopened = await log.open(sessionId)
    try {
      expect(reopened.refusedLines).toEqual([])
      expect(reopened.events).toHaveLength(lines.length - 1)
      expect(reopened.events.find((event) => event.kind === 'user_message'))
        .toMatchObject({ text: createDeclaredSecretMask(configPath).mask(MESSAGE) })
      const turnId = reopened.events[0]?.turnId
      for (const event of reopened.events) {
        expect(CHAT_SESSION_EVENT_KINDS).toContain(event.kind)
        expect(event.turnId).toBe(turnId)
        expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      }
      expect(answered).toMatchObject({ turnId })
    } finally {
      await reopened.close()
    }
    expect(sessionBytes()).not.toContain(DECLARED)
  })

  it('the turn result keeps its statuses as written and masks its answer and receipt clauses', async () => {
    const result = await sendInChat(MESSAGE)

    expect(CHAT_TURN_STATUSES).toContain(result.status)
    expect(result.receipts).toHaveLength(1)
    expect(CLAUSE_RECEIPT_STATUSES).toContain(result.receipts[0]?.status)
    expect(sessionEvents('clause_receipt').map((event) => (event as { status?: string }).status))
      .toEqual(result.receipts.map((receipt) => receipt.status))
    expect(result.receipts[0]?.clause).toContain(MARKER)

    const switched = await sendInChat(`/model ${DECLARED}`)
    expect(CHAT_TURN_STATUSES).toContain(switched.status)
    expect(switched.answer).toContain(MARKER)
    expect(sessionEvents('model_change')).toMatchObject([{ to: MARKER }])
    expect(JSON.stringify([result, switched])).not.toContain(DECLARED)
    expect(sessionBytes()).not.toContain(DECLARED)
  })
})

describe('a chat model name holding a declared value', () => {
  const CHAT_MODEL_ID = `fixture:${DECLARED}`

  const declaredIdChatModel = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId: CHAT_MODEL_ID,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('these cells never plan')),
    doStream: (): never => {
      throw new Error('these cells never stream')
    },
  }

  // Every message goes to one host and one session, so the session's model state carries over.
  async function chatTurns(
    messages: readonly string[],
    chatModel?: unknown,
  ): Promise<AgentAskResult[]> {
    const host = composeCliLocalAgent({
      agentQaRoot, configPath, ...(chatModel === undefined ? {} : { chatModel: chatModel as never }),
    })
    try {
      const results: AgentAskResult[] = []
      let sessionId: string | undefined
      for (const message of messages) {
        const result = await runSafetyScope(
          { executionContext: 'local-interactive' },
          async () => await invokeFunction(
            host.registry,
            AGENT_ASK_FUNCTION_ID,
            { message, ...(sessionId === undefined ? {} : { sessionId }) },
            CLI_FUNCTION_CALLER,
          ) as AgentAskResult,
        )
        sessionId = result.sessionId
        results.push(result)
      }
      return results
    } finally {
      await host.close()
    }
  }

  function modelChanges(): { source?: string; to?: string }[] {
    return sessionEvents('model_change') as { source?: string; to?: string }[]
  }

  it('a /model whose name holds a declared value is recorded once, and two more turns record no switch', async () => {
    const results = await chatTurns([`/model ${DECLARED}`, MESSAGE, MESSAGE])

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1)
    const changes = modelChanges()
    expect(changes.filter((change) => change.source === 'config_reread')).toEqual([])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ source: 'verb', to: MARKER })
    expect(sessionBytes()).not.toContain(DECLARED)
  })

  it('a chat model id holding a declared value is shown as its marker in the header and the listing', async () => {
    await chatTurns([MESSAGE, MESSAGE], declaredIdChatModel)

    const dir = join(agentQaRoot, 'sessions')
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const header = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8').split('\n')[0]!) as {
      model?: string
    }
    expect(header.model).toBe(`fixture:${MARKER}`)
    expect(listSessions(agentQaRoot).sessions.map((session) => session.model))
      .toEqual([`fixture:${MARKER}`])
    expect(modelChanges()).toEqual([])
    expect(sessionBytes()).not.toContain(DECLARED)
  })
})
