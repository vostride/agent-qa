// Every tool call settles once through the host's hook, and the hook never changes a result.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createFunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import type { AgentQaMcpPosture, McpToolSettled } from '../catalog.js'
import { maskedToolError } from '../masked-result.js'

const CALLER: FunctionCaller = { surface: 'mcp', origin: 'agent' }
const PLANTED = 'sk-live-planted-secret'
const maskPlanted = (text: string) => text.replaceAll(PLANTED, '<SECRET>')

const MARK = { name: 'agent_qa_mark_run', arguments: { runId: 'run-alpha', kind: 'false-fail' } }
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

// A real client over the shipped factory, as a coding agent reaches it.
async function connect(options: ServerOptions): Promise<Client> {
  const registry = createFunctionRegistry({
    deps: options.deps ?? markDeps(async () => RUN_NOT_FOUND),
  })
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry,
      caller: CALLER,
      maskText: options.maskText ?? maskPlanted,
      version: '0.0.0-test',
      ...(options.posture === undefined ? {} : { posture: options.posture }),
      ...(options.onToolSettled === undefined ? {} : { onToolSettled: options.onToolSettled }),
    }),
  )
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

async function callMark(options: ServerOptions): Promise<CallResult> {
  return (await (await connect(options)).callTool(MARK)) as CallResult
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

describe('the hook never changes a tool call', () => {
  // One call through each arm: a result, a throw, a withheld value and a posture.
  const ARMS: readonly { readonly arm: string; readonly options: ServerOptions }[] = [
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
  ]

  it('leaves every result byte-identical to a server with no hook, when the hook throws', async () => {
    const reached: string[] = []
    for (const { arm, options } of ARMS) {
      const plain = JSON.stringify(await callMark(options))
      const observed = await callMark({
        ...options,
        onToolSettled: () => {
          reached.push(arm)
          throw new Error('the observer failed')
        },
      })
      expect(JSON.stringify(observed), arm).toBe(plain)
    }
    expect(reached).toEqual(ARMS.map(({ arm }) => arm))
  })

  it('leaves every result byte-identical to a server with no hook, when the hook records', async () => {
    for (const { arm, options } of ARMS) {
      const { settled, hook } = recorder()
      const plain = JSON.stringify(await callMark(options))
      const observed = await callMark({ ...options, onToolSettled: hook })
      expect(JSON.stringify(observed), arm).toBe(plain)
      expect(settled, arm).toHaveLength(1)
    }
  })
})
