// Every caller lists the same catalogue and reaches every op; the listener reads no bearer.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { AGENT_QA_TOOL_PROJECTIONS, buildAgentQaMcpServer } from '@vostride/agent-qa-mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { composeMcpMasking, createMcpHttpRequestListener, MCP_FUNCTION_CALLER } from '../commands/mcp.js'
import { composeCliLocalAgent } from '../composition/local-agent-host.js'

// A legacy scope set smuggled past the type with a cast; nothing reads it.
function legacyCaller(scopes: readonly string[]): FunctionCaller {
  return { ...MCP_FUNCTION_CALLER, grantedScopes: scopes, safeMode: false } as FunctionCaller
}

// Read from the shipped mapping, because a hand-typed name keeps passing after a rename.
const CONFIG_TOOL_NAMES = AGENT_QA_TOOL_PROJECTIONS
  .filter((projection) => projection.ops.every((op) => op.startsWith('config.')))
  .map((projection) => projection.name)

/** The declared order, for the ordering cell. Also read out of the mapping rather than restated. */
const DECLARED_TOOL_ORDER = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name)

/** A tool whose required set has THREE members — the adjacency boundary needs one. */
const AUTHORING_TOOL = 'agent_qa_write_test'
const AUTHORING_SCOPES = ['test-write', 'run', 'read'] as const

// Legacy bearer values, none read; `PLANTED_RO` is also declared, so group 9 measures masking.
const PLANTED_CFG = 'zz-cfg-credential-8c14ae'
const PLANTED_RO = 'zz-ro-credential-3b90fd'
const PLANTED_AUTHORING = 'zz-authoring-credential-71ca'
const PLANTED_WRONG = 'zz-never-declared-credential-ff02'

const TOKEN_ENV = {
  AGENT_QA_PLANTED_CFG: PLANTED_CFG,
  AGENT_QA_PLANTED_RO: PLANTED_RO,
  AGENT_QA_PLANTED_AUTHORING: PLANTED_AUTHORING,
  AGENT_QA_PLANTED_AUTHORING_MINUS_TEST_WRITE: 'zz-minus-test-write-a1',
  AGENT_QA_PLANTED_AUTHORING_MINUS_RUN: 'zz-minus-run-b2',
  AGENT_QA_PLANTED_AUTHORING_MINUS_READ: 'zz-minus-read-c3',
}

interface Harness {
  readonly server: Server
  readonly port: number
  readonly url: string
  readonly registry: Parameters<typeof invokeFunction>[0]
  readonly mask: (text: string) => string
  close(): Promise<void>
}

let harness: Harness

function workspace(): { root: string; configPath: string; agentQaRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-visibility-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'preserve' } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), `AGENT_QA_PLANTED_RO_TOKEN=${PLANTED_RO}\n`, 'utf8')
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  return { root, configPath, agentQaRoot }
}

beforeAll(async () => {
  const where = workspace()
  const host = composeCliLocalAgent({
    agentQaRoot: where.agentQaRoot,
    configPath: where.configPath,
  })

  // THE PRODUCTION MASKER, not a stand-in. `composeMcpMasking` is the function the `mcp` command
  // itself calls. The project declares ONE secret, so a masking cell below passes only on that
  // value's masking.
  const maskText = composeMcpMasking({ configPath: where.configPath }).mask

  const server = createServer(
    createMcpHttpRequestListener({ registry: host.registry, maskText }),
  )
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  harness = {
    server,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    registry: host.registry,
    mask: maskText,
    close: async () => {
      await new Promise<void>((closed) => server.close(() => closed()))
      await host.close().catch(() => {})
      rmSync(where.root, { recursive: true, force: true })
    },
  }
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

/** One recorded HTTP exchange — the bytes, exactly as they crossed. */
interface Frame {
  readonly status: number
  readonly text: string
}

/**
 * Connect as a caller holding `token`, recording every response body.
 *
 * `era` is explicit because the SDK client defaults to the 2025 handshake and the two eras answer
 * differently on exactly the axis cell 8 measures. A suite that only ever spoke one of them would
 * be asserting a property of its own default.
 */
async function connectAs(
  token: string | undefined,
  era: 'legacy' | 'modern' = 'legacy',
): Promise<{ client: Client; frames: Frame[] }> {
  const frames: Frame[] = []
  const tokenFetch = (async (input: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
    const res = await fetch(input as string, { ...init, headers })
    const text = await res.clone().text()
    frames.push({ status: res.status, text })
    return res
  }) as typeof fetch

  const client = new Client(
    { name: 'agent-qa-396-05-differential', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(harness.url), { fetch: tokenFetch }),
  )
  return { client, frames }
}

async function toolNamesFor(token: string | undefined): Promise<string[]> {
  const { client } = await connectAs(token)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Whether `bytes` holds one complete HTTP/1.1 response: its head, then a chunked body through the
 * zero-size chunk, or a body of exactly `content-length` bytes. Undefined when the length is
 * delimited only by the server closing the connection.
 */
function httpResponseComplete(bytes: Buffer): boolean | undefined {
  const headEnd = bytes.indexOf('\r\n\r\n')
  if (headEnd < 0) return false
  const head = bytes.subarray(0, headEnd).toString('latin1').toLowerCase()
  let at = headEnd + 4
  if (/^transfer-encoding:\s*chunked\s*$/mu.test(head)) {
    for (;;) {
      const lineEnd = bytes.indexOf('\r\n', at)
      if (lineEnd < 0) return false
      const size = Number.parseInt(bytes.subarray(at, lineEnd).toString('latin1'), 16)
      if (Number.isNaN(size)) return false
      if (size === 0) return bytes.indexOf('\r\n', lineEnd + 2) >= 0
      at = lineEnd + 2 + size + 2
      if (at > bytes.length) return false
    }
  }
  const length = /^content-length:\s*(\d+)\s*$/mu.exec(head)
  if (length !== null) return bytes.length - at >= Number(length[1])
  return undefined
}

// Raw socket, as `fetch` overwrites `Host`; it resolves on the complete response, not the close.
async function rawRequest(headers: Record<string, string>): Promise<Frame> {
  return await new Promise((done, failed) => {
    const socket = netConnect(harness.port, '127.0.0.1', () => {
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
      socket.write(
        [
          'POST /mcp HTTP/1.1',
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      )
    })
    let bytes = Buffer.alloc(0)
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      const buffer = bytes.toString()
      done({
        status: Number.parseInt(buffer.split(' ')[1] ?? '0', 10),
        text: buffer,
      })
    }
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (httpResponseComplete(bytes) === true) {
        settle()
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      if (!settled) failed(error)
    })
    socket.on('end', settle)
  })
}

/** The JSON-RPC payload of the last frame that carried one, SSE framing removed. */
function lastPayload(frames: readonly Frame[]): unknown {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const text = frames[i]!.text
    const line = text.split('\n').find((candidate) => candidate.startsWith('data: '))
    const json = line === undefined ? text : line.slice('data: '.length)
    if (json.trim().startsWith('{')) return JSON.parse(json)
  }
  throw new Error('no JSON-RPC payload was recorded')
}

describe('1 · the config tools are PRESENT for every caller', () => {
  it('names the config tool in the shipped mapping, so the presence below is about something', () => {
    expect(CONFIG_TOOL_NAMES).toEqual(['agent_qa_change_config'])
  })

  // RE-SPELLED from 'a read-only caller sees NEITHER config tool'.
  it('a read-only caller sees the config tool', async () => {
    const names = await toolNamesFor(PLANTED_RO)
    for (const tool of CONFIG_TOOL_NAMES) expect(names).toContain(tool)
  })

  it('a config-write caller sees BOTH — the same machinery, answering the same way', async () => {
    const names = await toolNamesFor(PLANTED_CFG)
    for (const tool of CONFIG_TOOL_NAMES) {
      expect(names, `${tool} is missing from a config-write caller's listing`).toContain(tool)
    }
  })

  // RE-SPELLED from 'the two listings differ in EXACTLY the config tools and nothing else'.
  it('the two listings are identical', async () => {
    const [ro, cfg] = await Promise.all([toolNamesFor(PLANTED_RO), toolNamesFor(PLANTED_CFG)])
    expect(ro).toEqual(cfg)
    expect(ro.length).toBeGreaterThan(0)
  })
})

describe('2 · no tool is hidden, so a formerly hidden tool answers unlike a nonexistent one', () => {
  it('answers the config tool in band for a read-only caller, and a ghost as not found', async () => {
    const formerlyHidden = CONFIG_TOOL_NAMES[0]!
    const ghostName = 'agent_qa_a_tool_that_was_never_declared'

    const { client, frames } = await connectAs(PLANTED_RO)
    try {
      const answered = await client
        .callTool({ name: formerlyHidden, arguments: { action: 'config.field.set' } })
        .then((result) => JSON.stringify(result), (error: unknown) => String(error))
      await client.callTool({ name: ghostName, arguments: {} }).catch(() => undefined)
      const ghost = lastPayload(frames)

      expect(answered).not.toContain('not found')
      expect(answered).not.toContain('scope')
      expect(JSON.stringify(ghost)).toContain('not found')
    } finally {
      await client.close().catch(() => {})
    }
  })
})

describe('3 · the function layer reads no grant', () => {
  async function outcomeFor(caller: FunctionCaller): Promise<string> {
    try {
      return JSON.stringify(await invokeFunction(
        harness.registry,
        'config.field.set',
        { path: 'a.b', value: 1 },
        caller,
      ))
    } catch (error) {
      return `${(error as Error).name}`
    }
  }

  // RE-SPELLED from 'refuses a config op for a caller without the scope, naming the missing scope'.
  it('serves a config op to a caller without the scope, with no scope refusal', async () => {
    const outcome = await outcomeFor(legacyCaller(['read']))
    expect(outcome).not.toBe('FunctionScopeError')
  })

  it('admits the same op for a caller that holds the scope — the same answer either way', async () => {
    const withScope = await outcomeFor(legacyCaller(['read', 'config-write']))
    expect(withScope).not.toBe('FunctionScopeError')
    expect(await outcomeFor(legacyCaller(['read']))).toBe(withScope)
  })

  // RE-SPELLED from 'refuses even when the SERVER was built for a caller that holds the scope'.
  it('serves the op whatever caller the SERVER was built for', async () => {
    const openServer = buildAgentQaMcpServer({
      registry: harness.registry,
      caller: legacyCaller(['read', 'run', 'config-write']),
      maskText: (text: string) => text,
    })
    expect(openServer).toBeDefined()
    expect(await outcomeFor(legacyCaller(['read', 'run']))).not.toBe('FunctionScopeError')
  })
})

describe('4 · every grant set sees a three-scope tool, with no adjacency boundary', () => {
  it('names a three-scope tool, so the cells below have three sides to test', () => {
    const projection = AGENT_QA_TOOL_PROJECTIONS.find((entry) => entry.name === AUTHORING_TOOL)
    expect(projection, `${AUTHORING_TOOL} is not in the shipped mapping`).toBeDefined()
    expect(AUTHORING_SCOPES).toHaveLength(3)
  })

  it('the exact set sees it', async () => {
    expect(await toolNamesFor(PLANTED_AUTHORING)).toContain(AUTHORING_TOOL)
  })

  it('the exact set minus test-write sees it too', async () => {
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_PLANTED_AUTHORING_MINUS_TEST_WRITE))
      .toContain(AUTHORING_TOOL)
  })

  it('the exact set minus run sees it too', async () => {
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_PLANTED_AUTHORING_MINUS_RUN)).toContain(AUTHORING_TOOL)
  })

  it('the exact set minus read sees it too', async () => {
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_PLANTED_AUTHORING_MINUS_READ)).toContain(AUTHORING_TOOL)
  })

  it('a config-write-only grant and a read-only grant list the same tools', async () => {
    const onlyConfigWrite = await namesFromFactory(['config-write'])
    for (const tool of CONFIG_TOOL_NAMES) expect(onlyConfigWrite).toContain(tool)
    expect(await namesFromFactory(['read'])).toEqual(onlyConfigWrite)
  })
})

/**
 * List the tools a caller with an arbitrary scope set is registered, through the production factory.
 *
 * Used only where a scope set is not expressible as a config token — the empty grant, and a
 * `config-write`-only grant. It is the same `buildAgentQaMcpServer` the socket path builds; what is
 * skipped is the credential, not the server.
 */
async function namesFromFactory(scopes: readonly string[]): Promise<string[]> {
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: harness.registry,
      caller: legacyCaller(scopes),
      maskText: (text: string) => text,
    }),
  )
  const client = new Client({ name: 'agent-qa-396-05-factory', version: '0.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://factory.local/mcp'), {
        fetch: ((url: URL | string, init?: RequestInit) =>
          handler.fetch(new Request(url, init))) as typeof fetch,
      }),
    )
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close().catch(() => {})
    await handler.close().catch(() => {})
  }
}

describe('5 · a caller granted NOTHING is served the full catalogue', () => {
  it('lists every tool a read caller lists', async () => {
    const nothing = await namesFromFactory([])
    expect(nothing.length).toBeGreaterThan(0)
    expect(nothing).toEqual(await namesFromFactory(['read']))
  })
})

// Cell 6: ordering (SEP-2567).

describe('6 · tools/list order is stable and derived from the mapping', () => {
  it('is identical across repeated requests with the same token', async () => {
    const [first, second] = await Promise.all([toolNamesFor(PLANTED_CFG), toolNamesFor(PLANTED_CFG)])
    expect(first).toEqual(second)
  })

  it('equals the mapping\'s DECLARED order, filtered to what this composition serves', async () => {
    const names = await toolNamesFor(PLANTED_CFG)
    expect(names).toEqual(DECLARED_TOOL_ORDER.filter((name) => names.includes(name)))
  })

  it('and that is NOT merely the sorted order — the assertion above discriminates', async () => {
    // Without this, a server that sorted its output would pass; the order is declared, not sorted.
    const names = await toolNamesFor(PLANTED_CFG)
    expect(names).not.toEqual([...names].sort())
  })
})

// Cell 7: concurrency (SEP-2575).

describe('7 · interleaved requests bearing different tokens all get the same catalogue', () => {
  it('answers four simultaneous connections identically', async () => {
    const [cfgA, roA, cfgB, roB] = await Promise.all([
      toolNamesFor(PLANTED_CFG),
      toolNamesFor(PLANTED_RO),
      toolNamesFor(PLANTED_CFG),
      toolNamesFor(PLANTED_RO),
    ])
    expect(cfgA).toEqual(cfgB)
    expect(roA).toEqual(roB)
    expect(roA).toEqual(cfgA)
    for (const tool of CONFIG_TOOL_NAMES) expect(roA).toContain(tool)
  })
})

// Cell 8: cache identity (SEP-2549).

describe('8 · two callers\' listings never share a cacheable identity', () => {
  it('stamps cacheScope private and ttlMs 0 on BOTH callers\' lists, on the `2026-07-28` era', async () => {
    // The measured value, asserted rather than described in a comment. `private` is what makes a
    // per-caller listing safe to cache at all: a shared cache may not hold it, so one caller's
    // absent config tools can never be served to another.
    const cfg = await connectAs(PLANTED_CFG, 'modern')
    const ro = await connectAs(PLANTED_RO, 'modern')
    try {
      const cfgList = (await cfg.client.listTools()) as unknown as Record<string, unknown>
      const roList = (await ro.client.listTools()) as unknown as Record<string, unknown>
      expect(cfgList.cacheScope).toBe('private')
      expect(roList.cacheScope).toBe('private')
      expect(cfgList.ttlMs).toBe(0)
      expect(roList.ttlMs).toBe(0)
      // Both documents are the same; the SDK keeps the private stamp.
      expect((cfgList.tools as unknown[]).length).toBe((roList.tools as unknown[]).length)
    } finally {
      await cfg.client.close().catch(() => {})
      await ro.client.close().catch(() => {})
    }
  })

  it('stamps no cache fields at all on the 2025 era — that codec has no cache path', async () => {
    const { client } = await connectAs(PLANTED_CFG, 'legacy')
    try {
      const listed = (await client.listTools()) as unknown as Record<string, unknown>
      expect(Object.keys(listed)).toEqual(['tools'])
      expect(listed.cacheScope).toBeUndefined()
      expect(listed.ttlMs).toBeUndefined()
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('emits no HTTP cache header that a shared proxy could key on', async () => {
    // The other place a cache identity could live. Asserted on the raw response because the client
    // does not report headers it does not read — the same reason the CORS prohibition is asserted
    // on a raw response in the tracer.
    const raw = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Authorization: `Bearer ${PLANTED_RO}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    const headerBlock = raw.text.split('\r\n\r\n')[0]!.toLowerCase()
    expect(headerBlock).not.toContain('cache-control: public')
    expect(headerBlock).not.toContain('etag:')
  })
})

// Cell 9: the guards in front, and what they must never echo.

describe('9 · the walls in front of the handler refuse without becoming a channel', () => {
  it('refuses a rebound Host with 403, before anything else', async () => {
    const refused = await rawRequest({
      Host: 'evil.example.com',
      'Content-Type': 'application/json',
    })
    expect(refused.status).toBe(403)
    expect(refused.text).toContain('forbidden_host')
  })

  it('accepts a loopback Host — the guard is a filter, not a wall against everything', async () => {
    const allowed = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Authorization: `Bearer ${PLANTED_RO}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    expect(allowed.status).toBe(200)
  })

  it('refuses a cross-origin Origin with 403', async () => {
    const refused = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Origin: 'https://evil.example.com',
      'Content-Type': 'application/json',
    })
    expect(refused.status).toBe(403)
    expect(refused.text).toContain('forbidden_origin')
  })

  // No header a caller adds rescues a rebound host.
  it('checks Host BEFORE the credential — a valid token does not buy a rebound host', async () => {
    const refused = await rawRequest({
      Host: 'evil.example.com',
      Authorization: `Bearer ${PLANTED_CFG}`,
      'Content-Type': 'application/json',
    })
    expect(refused.status).toBe(403)
    expect(refused.text).toContain('forbidden_host')
    expect(refused.text).not.toContain('invalid_token')
  })

  it('serves an undeclared legacy bearer like none and NEVER echoes it', async () => {
    const served = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Authorization: `Bearer ${PLANTED_WRONG}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    expect(served.status).toBe(200)
    expect(served.text).not.toContain('invalid_token')
    expect(served.text).not.toContain(PLANTED_WRONG)
    expect(served.text.toLowerCase()).not.toContain('bearer zz')
  })

  it('answers the SAME body for a malformed header as for a wrong credential', async () => {
    const wrong = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Authorization: `Bearer ${PLANTED_WRONG}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    const malformed = await rawRequest({
      Host: `127.0.0.1:${harness.port}`,
      Authorization: 'Basic aGk6dGhlcmU=',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    })
    const bodyOf = (frame: Frame): string =>
      frame.text.split('\r\n\r\n').slice(1).join('').replace(/[0-9a-f]+\r\n/gi, '').trim()
    expect(bodyOf(wrong)).toBe(bodyOf(malformed))
    expect(wrong.status).toBe(malformed.status)
  })

  it('a valid credential presented to a formerly REFUSED tool still does not leak it into the answer', async () => {
    // Every byte of a tool error is checked for the header value the caller presented.
    const { client, frames } = await connectAs(PLANTED_RO)
    try {
      await client
        .callTool({ name: CONFIG_TOOL_NAMES[0]!, arguments: {} })
        .catch(() => undefined)
      for (const frame of frames) expect(frame.text).not.toContain(PLANTED_RO)
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('masks an environment secret a caller smuggles back through a tool argument', async () => {
    // `runs.digest` builds its unknown-id refusal from the caller's string, so it echoes input.
    const { client, frames } = await connectAs(PLANTED_RO)
    try {
      const called = await client.callTool({
        name: 'agent_qa_get_run_digest',
        arguments: { runId: PLANTED_RO },
      })
      const rendered = JSON.stringify(called)
      // The path echoes SOMETHING — otherwise there is no channel here and the absence below is
      // free. This is the integrity half of the cell.
      expect(rendered).toContain('No completed run recorded for id')
      expect(rendered).not.toContain(PLANTED_RO)
      // And not on the wire either, which is the surface a person actually reads.
      for (const frame of frames) expect(frame.text).not.toContain(PLANTED_RO)
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('the masker the COMMAND composes hides the environment secret it was seeded with', async () => {
    expect(harness.mask(`presented ${PLANTED_RO} here`)).not.toContain(PLANTED_RO)
    // And it is a masker of what it was given, not of everything: an unseeded value is untouched.
    expect(harness.mask(`presented ${PLANTED_CFG} here`)).toContain(PLANTED_CFG)
  })
})
