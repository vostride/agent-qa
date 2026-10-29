// The one-call change receipt, and the absence of the apply round.
//
// THIS FILE USED TO DRIVE `apply-refusal.ts`, the refuse-and-teach primitive in front of the two
// MCP apply tools: a first call answered a refusal carrying the
// proposal summary and the exact re-call, `confirmed: true` applied, and a SEP-2322 elicitation
// form rode on connections that could answer it. 432-12 deletes that round with the tools: the
// change tools write in the call and answer what they changed. Its claims transfer as follows.
//
//   first call commits nothing; apply invoked zero times  -> C432-MCP-DIRECT-RECEIPT: the change
//                                                            tool applies on its one call, once
//   summary read through the same invoke                  -> no second read: the port is reached once
//   `confirmed` strict boolean; doctored one-shots        -> C432-MCP-NO-ELICITATION: `confirmed` is
//                                                            not an input on any tool, refused at the
//                                                            schema wall and at the op
//   the form rides only where it can be answered          -> no form on any connection, including one
//                                                            that declared elicitation
//   refusal carried as data on its own arm                -> typed absence is data, a writer refusal
//                                                            is a masked error
//   dual-channel masking of the receipt                   -> kept: one masked serialization feeds
//                                                            `structuredContent` and the text
//
// The sovereign mark door's credential refusal is not a confirmation round. It moved to
// `masked-result.ts` and keeps its cells below until the permission wave removes it.

import { existsSync } from 'node:fs'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { FunctionInputError, createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import { maskedToolError } from '../masked-result.js'
import { FORGET_RECEIPT_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

// RE-SPELLED 2026-10-01. The mark tool's handler-level credential refusal
// left with the MCP bearer credential, and `createMarkToolHandler` with it: the mark tool goes
// through the generic projection handler. The surviving claims are measured through the real
// catalogue over a real client: the input reaches the one invoke unchanged, and both result channels
// are masked from one serialization.
describe('a mark through the MCP catalogue needs no credential', () => {
  const MARK_INPUT = { runId: 'run-alpha', kind: 'false-fail', note: 'untrusted-input' } as const

  it('a tokenless mark is invoked once with its input unchanged, and nothing refuses for a credential', async () => {
    const port = directDeps(() => ({ outcome: 'applied' }))
    const marks: unknown[] = []
    const deps = { ...port.deps, feedback: {
      mark: async (input: unknown) => { marks.push(input); return { kind: 'run-not-found', runId: 'run-alpha' } },
      marksFor: async () => [],
    } } as unknown as FunctionDeps
    const session = await wire(deps)
    const outcome = await callSettled(session, 'agent_qa_mark_run', { ...MARK_INPUT })
    expect(outcome.error).toBeUndefined()
    expect(marks).toEqual([MARK_INPUT])
    expect(outcome.result?.isError ?? false).toBe(false)
    expect(outcome.result?.structuredContent).toEqual({ kind: 'run-not-found', runId: 'run-alpha' })
    const frames = session.frames.join('\n')
    expect(frames).not.toContain('credential-required')
    expect(frames).not.toMatch(/present a bearer|--trust-session/)
  })
  it('passes the mark input unchanged through the sole invoke and masks both result channels', async () => {
    const marks: unknown[] = []
    const port = directDeps(() => ({ outcome: 'applied' }))
    const deps = { ...port.deps, feedback: {
      mark: async (input: unknown) => {
        marks.push(input)
        return { kind: 'member-not-found', runId: 'run-alpha', testId: `t-${PLANTED}` }
      },
      marksFor: async () => [],
    } } as unknown as FunctionDeps
    const session = await wire(deps)
    const outcome = await callSettled(session, 'agent_qa_mark_run', { ...MARK_INPUT })
    expect(marks).toEqual([MARK_INPUT])
    expect(outcome.result?.structuredContent).toEqual({ kind: 'member-not-found', runId: 'run-alpha', testId: 't-<SECRET>' })
    const text = (outcome.result?.content ?? []).map((block) => block.text ?? '').join('\n')
    expect(JSON.parse(text)).toEqual(outcome.result?.structuredContent)
    expect(session.frames.join('\n')).not.toContain(PLANTED)
  })
  // RE-SPELLED 2026-10-01 from 'renders typed gate denials with neutral prose and only
  // actionable MCP affordances'. The gate's denial error and its remedy vocabulary are deleted, so the
  // MCP error result has no denial arm and no remedy projection: every refusal renders its own
  // message, masked, and nothing is appended to it.
  it('renders every refusal as its own masked message, with no remedy appended', () => {
    const result = maskedToolError(new FunctionInputError('runs.mark', 'note: planted-secret'), text => text.replaceAll('planted-secret', '<SECRET>'))
    expect(result.content).toEqual([{ type: 'text', text: 'Invalid input for runs.mark: note: <SECRET>' }])
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/--trust-session|present a bearer|answer the confirm/)
  })
})

// ---- 432-12: a direct receipt through the real catalogue, and no confirm round --

/** The MCP caller: since 432-21 it carries no credential, scope set or safe-mode flag. */
const TOKENLESS: FunctionCaller = { surface: 'mcp', origin: 'agent' }

const PLANTED = 'sk-live-432-planted-secret'

interface DirectPort {
  readonly calls: unknown[]
  readonly deps: FunctionDeps
}

/** A registry whose review port answers direct changes, recording each call it receives. */
function directDeps(answer: (request: { verb: string, input: Record<string, unknown> }) => unknown): DirectPort {
  const calls: unknown[] = []
  const deps = {
    runs: {
      list: () => Promise.resolve([]), get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]), inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }: { recordId: string }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }),
    },
    knowledgeReview: {
      propose: () => Promise.reject(new Error('a direct change never proposes')),
      apply: () => Promise.reject(new Error('a direct change never applies a proposal')),
      change: async (request: { verb: string, input: Record<string, unknown> }) => {
        calls.push(request)
        return answer(request)
      },
    },
  } as unknown as FunctionDeps
  return { calls, deps }
}

const directClients: Client[] = []
afterEach(async () => {
  for (const client of directClients.splice(0)) await client.close().catch(() => {})
})

interface Wire {
  readonly client: Client
  readonly frames: string[]
  readonly elicited: unknown[]
}

/** A real client over the shipped factory; `modern` pins the 2026 wire and declares elicitation. */
async function wire(deps: FunctionDeps, modern = false): Promise<Wire> {
  const registry = createFunctionRegistry({ deps })
  const handler = createMcpHandler(() => buildAgentQaMcpServer({
    registry, caller: TOKENLESS, maskText: (text: string) => text.replaceAll(PLANTED, '<SECRET>'),
  }))
  const frames: string[] = []
  const elicited: unknown[] = []
  const client = new Client({ name: 'agent-qa-432-12-direct', version: '0.0.0' }, {
    ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { elicitation: {} } } : {}),
  } as never)
  if (modern) {
    client.setRequestHandler('elicitation/create' as never, ((request: unknown) => {
      elicited.push(request)
      return { action: 'accept', content: {} }
    }) as never)
  }
  directClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://direct.local/mcp'), {
    fetch: (async (url: URL | string, init?: RequestInit) => {
      const response = await handler.fetch(new Request(url, init))
      frames.push(await response.clone().text())
      return response
    }) as typeof fetch,
  }))
  return { client, frames, elicited }
}

type WireResult = {
  readonly content?: readonly { readonly type: string, readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
  readonly resultType?: string
}

async function callSettled(session: Wire, name: string, args: Record<string, unknown>) {
  try {
    return { result: (await session.client.callTool({ name, arguments: args })) as WireResult }
  } catch (error) {
    return { error }
  }
}

const RECORD_TARGET = { grain: 'record', recordId: 'rec-alpha' } as const

describe('a knowledge change answers its receipt on the first call', () => {
  it('the change tool applies once and masks both result channels from one serialization', async () => {
    const port = directDeps((request) => ({
      outcome: 'applied', verb: request.verb, operationId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
      recordIds: ['rec-alpha', `rec-${PLANTED}`],
    }))
    const session = await wire(port.deps)
    const outcome = await callSettled(session, 'agent_qa_change_knowledge', {
      action: 'knowledge.accept', target: RECORD_TARGET,
    })

    expect(outcome.error, 'the change tool must be listed and callable').toBeUndefined()
    expect(port.calls).toEqual([{ verb: 'accept', input: { target: RECORD_TARGET } }])
    expect(outcome.result?.isError ?? false).toBe(false)
    expect(outcome.result?.structuredContent).toMatchObject({
      outcome: 'applied', verb: 'accept', recordIds: ['rec-alpha', 'rec-<SECRET>'],
    })
    const text = (outcome.result?.content ?? []).map((block) => block.text ?? '').join('\n')
    expect(JSON.parse(text)).toEqual(outcome.result?.structuredContent)
    expect(session.frames.join('\n')).not.toContain(PLANTED)
  })

  it('a typed absence is data and a writer refusal is a masked error, both after one call', async () => {
    const absent = directDeps((request) => ({
      outcome: 'target-not-found', verb: request.verb,
      operationId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', target: request.input['target'],
    }))
    const notFound = await callSettled(await wire(absent.deps), 'agent_qa_change_knowledge', {
      action: 'knowledge.forget', target: RECORD_TARGET,
    })
    expect(notFound.result?.isError ?? false).toBe(false)
    expect(notFound.result?.structuredContent).toMatchObject({ outcome: 'target-not-found', target: RECORD_TARGET })
    expect(absent.calls).toHaveLength(1)

    const refusing = directDeps(() => {
      const error = new Error(`bundle egress refused: ${PLANTED} would leave the machine`)
      error.name = 'BundleEgressRefusedError'
      throw error
    })
    const session = await wire(refusing.deps)
    const refused = await callSettled(session, 'agent_qa_change_knowledge', {
      action: 'knowledge.reject', target: RECORD_TARGET, reason: 'stale',
    })
    expect(refused.result?.isError).toBe(true)
    expect(refusing.calls).toHaveLength(1)
    expect(session.frames.join('\n')).not.toContain(PLANTED)
    expect(session.frames.join('\n')).toContain('egress refused')
  })
})

describe('no confirmation input, no elicitation, no apply round', () => {
  it('a client that can answer a form is never asked, and the change lands on its one call', async () => {
    // an applied forget carries its forget receipt by rule.
    const port = directDeps((request) => ({
      outcome: 'applied', verb: request.verb, operationId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
      recordIds: ['rec-alpha'],
      forgetReceipt: {
        schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo', tombstonedRecords: [],
        projectionsScrubbed: ['fts'], resultingBundleStatus: 'forgotten', forgottenAt: 1,
      },
    }))
    const session = await wire(port.deps, true)
    const outcome = await callSettled(session, 'agent_qa_change_knowledge', {
      action: 'knowledge.forget', target: RECORD_TARGET,
    })

    expect(outcome.error).toBeUndefined()
    expect(outcome.result?.structuredContent).toMatchObject({ outcome: 'applied', verb: 'forget' })
    expect(outcome.result?.resultType ?? 'complete').not.toBe('input_required')
    expect(session.elicited).toEqual([])
    expect(port.calls).toHaveLength(1)
    expect(session.frames.join('\n')).not.toContain('input_required')
  })

  it('no listed tool takes a confirmation or a proposal id, and confirmed is refused at the schema wall', async () => {
    const port = directDeps(() => ({ outcome: 'applied' }))
    const session = await wire(port.deps)
    const tools = (await session.client.listTools()).tools
    for (const tool of tools) {
      const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      const armProperties = ((tool.inputSchema as { oneOf?: readonly { properties?: Record<string, unknown> }[] }).oneOf ?? [])
        .flatMap((arm) => Object.keys(arm.properties ?? {}))
      expect([...properties, ...armProperties], tool.name).not.toContain('confirmed')
      expect([...properties, ...armProperties], tool.name).not.toContain('proposal_id')
    }
    expect(tools.map((tool) => tool.name)).not.toContain('agent_qa_apply_proposal')
    expect(tools.map((tool) => tool.name)).not.toContain('agent_qa_apply_config_proposal')

    const doctored = await callSettled(session, 'agent_qa_change_knowledge', {
      action: 'knowledge.accept', target: RECORD_TARGET, confirmed: true,
    })
    expect(doctored.error ?? doctored.result?.isError, 'a confirmed key is not an input').toBeTruthy()
    expect(port.calls).toEqual([])
  })

  it('the refuse-and-teach module is gone, and the op layer takes no confirmation', async () => {
    expect(existsSync(new URL('../apply-refusal.ts', import.meta.url))).toBe(false)
    const port = directDeps(() => ({ outcome: 'applied' }))
    const registry = createFunctionRegistry({ deps: port.deps })
    const refusal = await invokeFunction(registry, 'knowledge.accept', {
      target: RECORD_TARGET, confirmed: true,
    }, TOKENLESS).then(() => undefined, (error: unknown) => error)
    expect((refusal as Error | undefined)?.name).toBe('FunctionInputError')
    expect(port.calls).toEqual([])
  })
})
