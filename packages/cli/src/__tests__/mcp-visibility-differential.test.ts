// safe mode proven by ABSENCE, with two independent walls.
//
// BOTH WALLS ARE DELETED. `visibleToCaller` (wall one) and
// `invokeFunction`'s scope refusal (wall two) are gone: every caller of this server lists the same
// catalogue and reaches every op. Groups 1-5, 7 and the first cell of 8 are re-spelled in place to
// pin that sameness — W1 and W2 below are now the shipped behaviour.
//
// THE BEARER IS DELETED TOO. The listener reads no `Authorization`
// header, so the "tokens" below are legacy header values a pre-432 client might still send, and
// every one of them — and none — is the same caller. Group 9's Host and Origin guards are unchanged;
// its bearer cells are re-spelled to "never read, never echoed". 2026-10-14: its
// masking cells declare their plant in the project's secrets file, the only thing the masker reads.
//
// WHAT THIS SUITE IS AND WHY IT IS DRIVEN. Every cell below speaks to a REAL loopback socket, over
// a REAL `Authorization` header, against the production `createMcpHttpRequestListener` composed
// over the production `composeCliLocalAgent`. Nothing here hand-assembles a tool list or a caller.
// The reason is the lesson 395 round 2 paid for: ten cells passed while two shipped commands leaked
// a planted credential, because the corpus asserted on an internal error object while the live
// channel was that error's serialization. So this suite asserts on the bytes a caller reads — the
// wire payload and the HTTP response — and reaches them by being a caller.
//
// THE PLAN'S THESIS IS AN ABSENCE, WHICH IS THE EASIEST KIND OF CLAIM TO FAKE. A cell asserting
// "the list does not contain X" passes over a server that lists nothing at all, over a client that
// never connected, and over a filter that was deleted. Three things guard against that here:
//
//   1. EVERY absence is paired with the presence that proves the same machinery can answer the
//      other way. No cell says only "absent".
//   2. The absent NAME is always drawn from the shipped mapping rather than typed as a literal, so
//      a rename cannot silently turn the assertion into a tautology about a tool nobody ships.
//   3. The phase's mutation driver (since removed) tore each wall SEPARATELY and required that the cells
//      aimed at THAT wall go red while the cells aimed at the other stay green. A conjunction of
//      two whole-input checks is weaker than the spec it implements; two legs is what tells the two
//      walls apart. Measured results are recorded below and in the SUMMARY.
//
// OBSERVED RED, from the phase's mutation driver (since removed):
//   W1  `visibleToCaller` severed to always-true       -> RED, 10 cells across groups 1, 2, 4, 5,
//                                                         7 and 8 · the wall-2 group GREEN
//   W2  `invokeFunction`'s scope refusal defeated      -> RED, 2 cells, BOTH in group 3
//                                                         · the absence group GREEN
//   K1  the masker's declared-credential seeding cut   -> RED, 2 cells in group 9
//   K2  the 401 body made to echo the presented header -> RED, 2 cells in group 9
//
// W1's TEN and W2's TWO are the pair that carries D-08's independence claim. Tearing the listing
// filter reds cells in six different groups, because they are all instances of ONE law rather than
// six rules that happen to agree; tearing the function layer's check reds only the group that
// reaches it without a listing. Neither leg reds the other's cells. A single cell that only passed
// when both walls stood would have told us nothing about either.
//
// A2 (RESEARCH's flagged assumption on SEP-2549 caching) IS RESOLVED HERE BY MEASUREMENT, not by
// reading a default out of a type declaration: cell 8 connects on BOTH protocol eras and asserts
// what the SDK actually stamped. Measured 2026-08-16 — 2026-07-28 era: `ttlMs: 0`,
// `cacheScope: 'private'` on every `tools/list`, for every caller; 2025 era: no cache fields on the
// result at all (that codec has no cache path). Either way no shared cacheable identity exists
// between two callers' listings, which is T-396-16's whole content.

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

/**
 * A caller carrying a LEGACY scope set — the fields 432-20 made optional and unread. Built from the
 * one caller the MCP host mints, so the only difference is fields nothing reads. 2026-10-02:
 * the fields are deleted from the type, so they are smuggled past it with a cast.
 */
function legacyCaller(scopes: readonly string[]): FunctionCaller {
  return { ...MCP_FUNCTION_CALLER, grantedScopes: scopes, safeMode: false } as FunctionCaller
}

/**
 * The config tools (one since 432-12), read OUT of the shipped mapping.
 *
 * Never typed as literals. An absence cell naming a tool by hand keeps passing after a rename —
 * it would then be asserting that a tool nobody ships is not listed, which is true of every string.
 */
const CONFIG_TOOL_NAMES = AGENT_QA_TOOL_PROJECTIONS
  .filter((projection) => projection.ops.every((op) => op.startsWith('config.')))
  .map((projection) => projection.name)

/** The declared order, for the ordering cell. Also read out of the mapping rather than restated. */
const DECLARED_TOOL_ORDER = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name)

/** A tool whose required set has THREE members — the adjacency boundary needs one. */
const AUTHORING_TOOL = 'agent_qa_write_test'
const AUTHORING_SCOPES = ['test-write', 'run', 'read'] as const

/**
 * The legacy bearer values a pre-432 client might present. None is read. `PLANTED_RO` is ALSO
 * declared in the project's secrets file, so the masking cells in group 9 measure the
 * declared masking D-01 keeps.
 */
const PLANTED_CFG = 'zz-396-05-cfg-credential-8c14ae'
const PLANTED_RO = 'zz-396-05-ro-credential-3b90fd'
const PLANTED_AUTHORING = 'zz-396-05-authoring-credential-71ca'
const PLANTED_WRONG = 'zz-396-05-never-declared-credential-ff02'

const TOKEN_ENV = {
  AGENT_QA_396_CFG: PLANTED_CFG,
  AGENT_QA_396_RO: PLANTED_RO,
  AGENT_QA_396_AUTHORING: PLANTED_AUTHORING,
  AGENT_QA_396_AUTHORING_MINUS_TEST_WRITE: 'zz-396-05-minus-test-write-a1',
  AGENT_QA_396_AUTHORING_MINUS_RUN: 'zz-396-05-minus-run-b2',
  AGENT_QA_396_AUTHORING_MINUS_READ: 'zz-396-05-minus-read-c3',
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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-396-05-visibility-'))
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
  writeFileSync(join(root, '.env.secrets.local'), `AGENT_QA_396_RO_TOKEN=${PLANTED_RO}\n`, 'utf8')
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

/**
 * A raw HTTP request over a socket, because `fetch` refuses to let a caller set `Host`.
 *
 * The DNS-rebinding guard is a claim ABOUT the `Host` header, and undici silently overwrites it —
 * a cell built on `fetch` would have asserted the guard while never once presenting a bad host.
 *
 * it resolves on the COMPLETE response rather than on the server
 * closing the socket. A served (200) request answers in about 80 ms, chunked and terminated, but
 * with `connection: keep-alive` (the MCP SDK's streamable transport sets it, despite the request's
 * `Connection: close`), so Node held the socket until its keep-alive timeout: 6.05-6.09 s per
 * request, 12.2 s for the two-request cell, which failed at 15.9 s under the 432-04 forced gate.
 * The recorded bytes are the same: nothing follows the terminating chunk on that socket.
 */
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

// ---------------------------------------------------------------------------------------------
// CELL 1 — ABSENCE, both sides
// ---------------------------------------------------------------------------------------------

// RE-SPELLED 2026-10-01 from '1 · the config tools are ABSENT from a caller without
// config-write'. The listing filter is deleted: every token lists the same catalogue.
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

// RE-SPELLED 2026-10-01 from '2 · calling a hidden tool is indistinguishable from
// calling a nonexistent one'. No tool is hidden: the config tool is answered IN BAND, and a ghost
// name still answers the SDK's unknown-tool shape.
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

// RE-SPELLED 2026-10-01 from '3 · the function layer refuses independently of
// anything a surface listed'. The second wall is deleted too: the function layer serves the op to
// a caller holding no `config-write`, exactly as to one that holds it.
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

// RE-SPELLED 2026-10-01 from '4 · a caller granted EXACTLY a tool's required set
// sees it; minus any one member, it does not'. There is no boundary: every grant set sees the tool.
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
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_396_AUTHORING_MINUS_TEST_WRITE))
      .toContain(AUTHORING_TOOL)
  })

  it('the exact set minus run sees it too', async () => {
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_396_AUTHORING_MINUS_RUN)).toContain(AUTHORING_TOOL)
  })

  it('the exact set minus read sees it too', async () => {
    expect(await toolNamesFor(TOKEN_ENV.AGENT_QA_396_AUTHORING_MINUS_READ)).toContain(AUTHORING_TOOL)
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

// RE-SPELLED 2026-10-01 from '5 · a caller granted NOTHING is served an empty
// catalogue'. The floor of the deleted law is gone: a caller granted nothing is served everything.
describe('5 · a caller granted NOTHING is served the full catalogue', () => {
  it('lists every tool a read caller lists', async () => {
    const nothing = await namesFromFactory([])
    expect(nothing.length).toBeGreaterThan(0)
    expect(nothing).toEqual(await namesFromFactory(['read']))
  })
})

// ---------------------------------------------------------------------------------------------
// CELL 6 — ordering (MCPS-04 ordering row, SEP-2567)
// ---------------------------------------------------------------------------------------------

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
    // Without this, the cell above would pass over a server that sorted its output, and the claim
    // "the order comes from the mapping" would be untested. 396-04 chose declared order over sorted
    // deliberately; this is where that choice is measurable.
    const names = await toolNamesFor(PLANTED_CFG)
    expect(names).not.toEqual([...names].sort())
  })
})

// ---------------------------------------------------------------------------------------------
// CELL 7 — concurrency (MCPS-02 concurrency row, SEP-2575)
// ---------------------------------------------------------------------------------------------

// RE-SPELLED 2026-10-01 from '7 · interleaved requests bearing different tokens
// each get their own catalogue'. Every token now gets the same catalogue, concurrently too.
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

// ---------------------------------------------------------------------------------------------
// CELL 8 — cache identity (Pitfall 8 / SEP-2549 · T-396-16 · RESEARCH A2)
// ---------------------------------------------------------------------------------------------

describe('8 · two callers\' listings never share a cacheable identity', () => {
  it('stamps cacheScope private and ttlMs 0 on BOTH callers\' lists, on the 2026-07-28 era', async () => {
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
      // the two documents are now the same; the private stamp is kept by the SDK.
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

// ---------------------------------------------------------------------------------------------
// CELL 9 — the guards in front, and what they must never echo
// ---------------------------------------------------------------------------------------------

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

  // a legacy bearer is not a credential any more; the claim that no header a caller
  // adds rescues a rebound host is unchanged.
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

  // RE-SPELLED 2026-10-01 from 'answers 401 for an undeclared credential and NEVER
  // echoes it'. Nothing is refused for a bearer; the never-echoes half is the claim that survives
  // (leg K2's subject — the 401 body — is deleted with the bearer rung).
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

  // RE-SPELLED 2026-10-01 from 'answers the SAME 401 body for a malformed header as
  // for a wrong credential': the SAME body still, because neither header is read.
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
    // The refusal path a caller reaches with a good credential: a hidden tool. Every byte of the
    // answer is checked for the credential the caller presented, because a server that echoed the
    // Authorization header into a tool error would be exactly T-395-R5-10 arriving on this surface.
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

  // RE-SPELLED 2026-10-01 from 'masks a declared credential a caller smuggles back
  // through a tool argument': no credential is declared; the value is an environment secret the
  // production masker was seeded with (D-13 keeps environment secret masking).
  it('masks an environment secret a caller smuggles back through a tool argument', async () => {
    // Driven through the channel a caller reads — the 395-round-2 lesson applied. `runs.digest` was
    // MEASURED to be an echoing path: its refusal for an unknown id is composed from
    // the caller's own string, which is exactly the shape T-395-R5-10's credential rode out on.
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

  // RE-SPELLED 2026-10-01 from 'the masker the COMMAND composes hides every declared
  // credential': it hides the environment secret it was seeded with, and only that.
  it('the masker the COMMAND composes hides the environment secret it was seeded with', async () => {
    expect(harness.mask(`presented ${PLANTED_RO} here`)).not.toContain(PLANTED_RO)
    // And it is a masker of what it was given, not of everything: an unseeded value is untouched.
    expect(harness.mask(`presented ${PLANTED_CFG} here`)).toContain(PLANTED_CFG)
  })
})
