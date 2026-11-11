// Every tool call settles once through the host's hook, and the hook never changes a result.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { createFunctionRegistry, FunctionInputError } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import type { AgentQaMcpPosture, McpToolSettled } from '../catalog.js'
import { AGENT_QA_OP_CONTRACTS } from '../mapping.js'
import { maskedToolError } from '../masked-result.js'

const CALLER: FunctionCaller = { surface: 'mcp', origin: 'agent' }
const PLANTED = 'sk-live-planted-secret'
const maskPlanted = (text: string) => text.replaceAll(PLANTED, '<SECRET>')

interface ToolCall {
  readonly name: string
  readonly arguments?: Record<string, unknown>
}

const MARK = { name: 'agent_qa_mark_run', arguments: { runId: 'run-alpha', kind: 'false-fail' } }
// What a caller typed; nothing a host observes may carry it.
const TYPED = 'typed-by-the-caller-4q7z'
const WRONG_TYPE: ToolCall = {
  name: 'agent_qa_mark_run',
  arguments: { runId: 'run-alpha', kind: 'false-fail', note: [TYPED] },
}
const RUN_NOT_FOUND = { kind: 'run-not-found', runId: 'run-alpha' } as const
const STEP_NOT_FOUND = {
  kind: 'step-not-found',
  runId: 'run-alpha',
  testIndex: 0,
  stepIndex: 7,
  stepCount: 3,
} as const

const POSTURES: readonly AgentQaMcpPosture[] = [
  { state: 'not-initialized', configPath: '/p/agent-qa.config.yaml' },
  {
    state: 'config-invalid',
    configPath: '/p/agent-qa.config.yaml',
    problem: 'workspace: Required',
  },
]

// Only the mark port is bound; each cell decides what it answers or throws.
function markDeps(mark: () => Promise<unknown>): FunctionDeps {
  return { feedback: { mark, marksFor: async () => [] } } as unknown as FunctionDeps
}

// A mark port that counts the calls reaching it.
function countingMark(): { readonly deps: FunctionDeps; readonly calls: () => number } {
  let calls = 0
  return {
    deps: markDeps(async () => {
      calls += 1
      return RUN_NOT_FOUND
    }),
    calls: () => calls,
  }
}

interface ServerOptions {
  readonly deps?: FunctionDeps
  readonly maskText?: (text: string) => string
  readonly posture?: AgentQaMcpPosture
  readonly onToolSettled?: (settled: McpToolSettled) => void
}

type CallResult = {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

const openClients: Client[] = []
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

async function clientOf(build: () => McpServer): Promise<Client> {
  const handler = createMcpHandler(build)
  const client = new Client({ name: 'agent-qa-settle', version: '0.0.0' })
  openClients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://settle.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
  return client
}

// A real client over the shipped factory, as a coding agent reaches it.
async function connect(options: ServerOptions): Promise<Client> {
  const registry = createFunctionRegistry({
    deps: options.deps ?? markDeps(async () => RUN_NOT_FOUND),
  })
  return await clientOf(() =>
    buildAgentQaMcpServer({
      registry,
      caller: CALLER,
      maskText: options.maskText ?? maskPlanted,
      version: '0.0.0-test',
      ...(options.posture === undefined ? {} : { posture: options.posture }),
      ...(options.onToolSettled === undefined ? {} : { onToolSettled: options.onToolSettled }),
    }),
  )
}

// The mark contract registered with the SDK as it is, with a handler that must never run.
function markContractServer(): McpServer {
  const server = new McpServer(
    { name: 'mark-contract', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool(
    'agent_qa_mark_run',
    { inputSchema: AGENT_QA_OP_CONTRACTS['runs.mark']!.input },
    () => {
      throw new Error('the mark contract admitted a call it refuses')
    },
  )
  return server
}

async function callMark(options: ServerOptions, call: ToolCall = MARK): Promise<CallResult> {
  return (await (await connect(options)).callTool(call)) as CallResult
}

function recorder() {
  const settled: McpToolSettled[] = []
  return {
    settled,
    hook: (entry: McpToolSettled) => {
      settled.push(entry)
    },
  }
}

// Everything an error object holds: its message, its stack and each of its own properties.
function carried(error: unknown): string {
  const record = error as Record<string, unknown>
  return Object.getOwnPropertyNames(error)
    .map((name) => `${name}=${String(record[name])}`)
    .concat(String((error as Error).message), String((error as Error).stack))
    .join('\n')
}

function expectOneInputError(settled: readonly McpToolSettled[], tool: string, typed?: string) {
  expect(settled).toHaveLength(1)
  const [entry] = settled
  expect(Object.keys(entry!).sort()).toEqual(['durationMs', 'error', 'outcome', 'tool'])
  expect(entry).toMatchObject({ tool, outcome: 'error' })
  expect(entry!.durationMs).toBeGreaterThanOrEqual(0)
  expect(entry!.error).toBeInstanceOf(FunctionInputError)
  expect((entry!.error as Error).message).toBe(
    `Invalid input for ${tool}: the arguments do not match the tool's input schema`,
  )
  if (typed !== undefined) expect(carried(entry!.error)).not.toContain(typed)
}

describe('a tool call settles once through the host hook', () => {
  it('settles a call that succeeds with its tool, the time it took and success, and no error', async () => {
    const { settled, hook } = recorder()
    const result = await callMark({
      deps: markDeps(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return RUN_NOT_FOUND
      }),
      onToolSettled: hook,
    })

    expect(result.isError ?? false).toBe(false)
    expect(settled).toEqual([
      { tool: 'agent_qa_mark_run', durationMs: expect.any(Number), outcome: 'success' },
    ])
    expect(settled[0]).not.toHaveProperty('error')
    expect(settled[0]!.durationMs).toBeGreaterThanOrEqual(30)
  })

  it('settles a call whose op throws with error and the thrown error, and answers as before', async () => {
    const thrown = new Error(`the mark store refused ${PLANTED}`)
    const { settled, hook } = recorder()
    const result = await callMark({
      deps: markDeps(() => Promise.reject(thrown)),
      onToolSettled: hook,
    })

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ tool: 'agent_qa_mark_run', outcome: 'error' })
    expect(settled[0]!.error).toBe(thrown)
    expect(settled[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual(maskedToolError(thrown, maskPlanted).content)
  })

  it('settles a result that is an error with no throw as error, with no error member', async () => {
    // A number cannot be masked in place, so a step index spelling a declared secret is withheld.
    const { settled, hook } = recorder()
    const result = await callMark({
      deps: markDeps(async () => STEP_NOT_FOUND),
      maskText: (text) => text.replaceAll('7', '<SECRET>'),
      onToolSettled: hook,
    })

    expect(result.isError).toBe(true)
    expect(settled).toEqual([
      { tool: 'agent_qa_mark_run', durationMs: expect.any(Number), outcome: 'error' },
    ])
    expect(settled[0]).not.toHaveProperty('error')
    expect(settled[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('settles every call of a server with no project to serve as error', async () => {
    for (const posture of POSTURES) {
      const { settled, hook } = recorder()
      const client = await connect({ posture, onToolSettled: hook })
      await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
      await client.callTool(MARK)

      expect(settled.map(({ tool, outcome }) => [tool, outcome]), posture.state).toEqual([
        ['agent_qa_list_runs', 'error'],
        ['agent_qa_mark_run', 'error'],
      ])
      for (const entry of settled) {
        expect(entry.durationMs).toBeGreaterThanOrEqual(0)
        expect(entry).not.toHaveProperty('error')
      }
    }
  })
})

describe('a call with arguments the input schema refuses', () => {
  const REFUSED_MARKS: readonly {
    readonly shape: string
    readonly call: ToolCall
    readonly typed?: string
  }[] = [
    { shape: 'a wrong type', call: WRONG_TYPE, typed: TYPED },
    {
      shape: 'a missing required key',
      call: { name: 'agent_qa_mark_run', arguments: { kind: 'false-fail', note: TYPED } },
      typed: TYPED,
    },
    {
      shape: 'an unknown key',
      call: { name: 'agent_qa_mark_run', arguments: { ...MARK.arguments, [TYPED]: true } },
      typed: TYPED,
    },
    { shape: 'no arguments', call: { name: 'agent_qa_mark_run' } },
  ]

  it.each(REFUSED_MARKS)(
    'settles $shape once as an input error naming the tool, never reaches the op, and answers as the mark contract does',
    async ({ call, typed }) => {
      const mark = countingMark()
      const { settled, hook } = recorder()
      const result = (await (await connect({ deps: mark.deps, onToolSettled: hook })).callTool(
        call,
      )) as CallResult

      expectOneInputError(settled, 'agent_qa_mark_run', typed)
      expect(mark.calls()).toBe(0)
      expect(result.isError).toBe(true)
      const contract = await (await clientOf(markContractServer)).callTool(call)
      expect(JSON.stringify(result)).toBe(JSON.stringify(contract))
    },
  )

  it('settles a fold call its arm refuses once as an input error naming the fold', async () => {
    const { settled, hook } = recorder()
    const result = (await (await connect({ onToolSettled: hook })).callTool({
      name: 'agent_qa_change_knowledge',
      arguments: {
        action: 'knowledge.accept',
        target: { grain: 'record', recordId: 'rec-1' },
        reason: TYPED,
      },
    })) as CallResult

    expectOneInputError(settled, 'agent_qa_change_knowledge', TYPED)
    expect(result.isError).toBe(true)
  })

  it('answers an unknown key that spells a declared secret with its marker, and settles nothing that holds it', async () => {
    const { settled, hook } = recorder()
    const result = await callMark(
      { onToolSettled: hook },
      { name: 'agent_qa_mark_run', arguments: { ...MARK.arguments, [PLANTED]: true } },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Input validation error: Invalid arguments for tool agent_qa_mark_run: '
          + 'Unrecognized key: "<SECRET>"',
      },
    ])
    expectOneInputError(settled, 'agent_qa_mark_run', PLANTED)
  })

  it('answers a wrong-typed call on a server with no project to serve as a valid one, and settles it once', async () => {
    for (const posture of POSTURES) {
      const valid = JSON.stringify(await callMark({ posture }))
      const { settled, hook } = recorder()
      const refused = await callMark({ posture, onToolSettled: hook }, WRONG_TYPE)

      expect(JSON.stringify(refused), posture.state).toBe(valid)
      expect(settled, posture.state).toEqual([
        { tool: 'agent_qa_mark_run', durationMs: expect.any(Number), outcome: 'error' },
      ])
      expect(settled[0]).not.toHaveProperty('error')
    }
  })
})

describe('the hook never changes a tool call', () => {
  // One call through each arm: a result, a throw, a withheld value, a posture and refused input.
  const ARMS: readonly {
    readonly arm: string
    readonly options: ServerOptions
    readonly call?: ToolCall
  }[] = [
    { arm: 'result', options: {} },
    {
      arm: 'throw',
      options: { deps: markDeps(() => Promise.reject(new Error(`refused ${PLANTED}`))) },
    },
    {
      arm: 'withheld',
      options: {
        deps: markDeps(async () => STEP_NOT_FOUND),
        maskText: (text) => text.replaceAll('7', '<SECRET>'),
      },
    },
    { arm: 'posture', options: { posture: POSTURES[0]! } },
    { arm: 'refused input', options: {}, call: WRONG_TYPE },
  ]

  it('leaves every result byte-identical to a server with no hook, when the hook throws', async () => {
    const reached: string[] = []
    for (const { arm, options, call } of ARMS) {
      const plain = JSON.stringify(await callMark(options, call))
      const observed = await callMark(
        {
          ...options,
          onToolSettled: () => {
            reached.push(arm)
            throw new Error('the observer failed')
          },
        },
        call,
      )
      expect(JSON.stringify(observed), arm).toBe(plain)
    }
    expect(reached).toEqual(ARMS.map(({ arm }) => arm))
  })

  it('leaves every result byte-identical to a server with no hook, when the hook records', async () => {
    for (const { arm, options, call } of ARMS) {
      const { settled, hook } = recorder()
      const plain = JSON.stringify(await callMark(options, call))
      const observed = await callMark({ ...options, onToolSettled: hook }, call)
      expect(JSON.stringify(observed), arm).toBe(plain)
      expect(settled, arm).toHaveLength(1)
    }
  })
})
