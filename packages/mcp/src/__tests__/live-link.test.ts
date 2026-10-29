// Every cell reads a real `tools/call` result off the wire, not the composition helper.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import { CURRENT_HANDOFF_SCHEMA_VERSION, asRunId } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { appResourceUriFor } from '../app-resource.js'
import { buildAgentQaMcpServer } from '../catalog.js'
import * as barrel from '../index.js'
import {
  LIVE_LINK_ABSENT_LINE,
  LIVE_LINK_NO_RUN_LINE,
  liveLinkLine,
  liveLinkLineFor,
  liveRunLinkOf,
} from '../live-link.js'

// ---- The fixture composition -------------------------------------------------------------------

/** The run the STARTER produces — the id `agent_qa_start_run`'s reference can only come from. */
const STARTED_RUN_ID = 'run-408-03-started'
/** A DIFFERENT run, asked about by id — the id `agent_qa_get_run_digest`'s reference comes from. */
const ASKED_RUN_ID = 'run-408-03-asked'

const FIXTURE_BASE = 'http://localhost:4100'

function handoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'live-link' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_live_link',
        testName: 'a member this fixture recorded',
        filePath: 'tests/live-link.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      },
    ],
  }
}

const RECORDED: ReadonlyMap<string, CompletedRunHandoff> = new Map([
  [STARTED_RUN_ID, handoff(STARTED_RUN_ID)],
  [ASKED_RUN_ID, handoff(ASKED_RUN_ID)],
])

// The ops and outputs are the shipped ones; only the two recorded run documents are scripted.
function fixtureRegistry(): FunctionRegistry {
  const deps = {
    runs: {
      list: () => Promise.resolve([...RECORDED.values()]),
      get: (runId: string) => Promise.resolve(RECORDED.get(String(runId))),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    // The STARTER always answers the same run, whatever it was asked to start — which is what
    // makes the `runIdFrom: 'output'` cell a statement about the source rather than an accident of
    // two ids that happened to match.
    runInvocation: { start: () => Promise.resolve({ runId: asRunId(STARTED_RUN_ID) }) },
    secretMask: (text: string) => text,
  } as unknown as FunctionDeps

  return createFunctionRegistry({ deps })
}

// The registry and the MCP server read no scopes or safe mode, so the caller carries neither.
const caller: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}

const identity = (text: string): string => text

interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly isError?: boolean
  readonly _meta?: Record<string, unknown>
}

const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

/**
 * Call one tool on a real build and answer the result off the wire.
 *
 * `base` is what the host's supplier answers; `undefined` is the degenerate case a host with no
 * dashboard anywhere is in, and `absent: true` drops the `liveLink` member entirely — the two must
 * be indistinguishable, which is why both are reachable from this one helper.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  link: { readonly base?: string; readonly absent?: boolean } = {},
): Promise<ToolCallResult> {
  const registry = fixtureRegistry()
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry,
      caller,
      maskText: identity,
      ...(link.absent === true
        ? {}
        : { liveLink: { dashboardBaseUrl: () => link.base } }),
    }),
  )
  const client = new Client({ name: 'agent-qa-408-03-live-link', version: '0.0.0' })
  openClients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://live-link.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
  return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult
}

const textsOf = (result: ToolCallResult): readonly string[] =>
  (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '')

const resourceUriOf = (result: ToolCallResult): unknown =>
  (result._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri

// ---- 1. The composition: one composed string ----

describe('the permanent link is one composed string over the tokenless live page', () => {
  it('composes <base>/runs/<runId>/live', () => {
    expect(liveRunLinkOf(FIXTURE_BASE, 'run-9')).toBe('http://localhost:4100/runs/run-9/live')
  })

  it('composes a trailing-slash base without a double slash', () => {
    expect(liveRunLinkOf('http://localhost:4100/', 'run-9')).toBe(
      'http://localhost:4100/runs/run-9/live',
    )
    expect(liveRunLinkOf('http://localhost:4100///', 'run-9')).toBe(
      'http://localhost:4100/runs/run-9/live',
    )
  })

  it('carries no token and no query of any kind — it is the TOKENLESS page', () => {
    const link = liveRunLinkOf(FIXTURE_BASE, 'run-9')
    expect(link).not.toContain('?')
    expect(link).not.toContain('#')
    expect(new URL(link).search).toBe('')
  })
})

// ---- 2. The decoration, on the wire ----------------------------------------------

describe('every carrier result carries the link AND the concrete App address', () => {
  it('decorates a carrier result with the link line and _meta.ui.resourceUri', async () => {
    const result = await callTool('agent_qa_get_run_digest', { runId: ASKED_RUN_ID }, {
      base: FIXTURE_BASE,
    })

    expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
    expect(textsOf(result)).toContain(
      liveLinkLine(liveRunLinkOf(FIXTURE_BASE, ASKED_RUN_ID)),
    )
    expect(resourceUriOf(result)).toBe(`ui://agent-qa/live-run/${ASKED_RUN_ID}`)
    expect(resourceUriOf(result)).toBe(appResourceUriFor(ASKED_RUN_ID))
  })

  it('decorates a NON-carrier result with neither', async () => {
    const result = await callTool('agent_qa_list_runs', {}, { base: FIXTURE_BASE })

    expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
    expect(textsOf(result).some((text) => text.includes('/live'))).toBe(false)
    expect(textsOf(result).some((text) => text.includes(LIVE_LINK_ABSENT_LINE))).toBe(false)
    expect(result._meta).toBeUndefined()
    // The op's own answer is untouched: a non-carrier result is exactly one text part, as before.
    expect(textsOf(result)).toHaveLength(1)
  })
})

// ---- 3. The named absence ----

describe('with no dashboard anywhere, the line is the NAMED ABSENCE and never a URL', () => {
  it('carries LIVE_LINK_ABSENT_LINE verbatim when the supplier answers undefined', async () => {
    const result = await callTool('agent_qa_get_run_digest', { runId: ASKED_RUN_ID }, {
      base: undefined,
    })

    expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
    expect(textsOf(result)).toContain(LIVE_LINK_ABSENT_LINE)
    // The whole point of a NAMED absence: nothing that reads as an address.
    expect(LIVE_LINK_ABSENT_LINE).not.toContain('http')
    expect(LIVE_LINK_ABSENT_LINE).toContain('services.dashboard.baseUrl')
  })

  it('is the same answer when the host supplies no liveLink member at all', async () => {
    const result = await callTool('agent_qa_get_run_digest', { runId: ASKED_RUN_ID }, {
      absent: true,
    })

    expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
    expect(textsOf(result)).toContain(LIVE_LINK_ABSENT_LINE)
  })

  it('still carries the concrete App address — the absence is the LINK, not the App', async () => {
    const result = await callTool('agent_qa_get_run_digest', { runId: ASKED_RUN_ID }, {
      absent: true,
    })
    expect(resourceUriOf(result)).toBe(appResourceUriFor(ASKED_RUN_ID))
  })
})

// ---- 3b. TWO absences, two sentences -------------------------------

// A configured base with an unreadable run id gets its own sentence, not the configure-me line.
describe('the two absences are two sentences, and the base is the arm tested first', () => {
  const BASE = 'http://127.0.0.1:7777'

  it('a base with NO resolvable run id names the missing RUN, not a knob already set', () => {
    expect(liveLinkLineFor(BASE, undefined)).toBe(LIVE_LINK_NO_RUN_LINE)
    // The precise regression: it must NOT be the no-dashboard sentence on a configured host.
    expect(liveLinkLineFor(BASE, undefined)).not.toBe(LIVE_LINK_ABSENT_LINE)
  })

  it('an EMPTY run id is the same absence as a missing one', () => {
    expect(liveLinkLineFor(BASE, '')).toBe(LIVE_LINK_NO_RUN_LINE)
  })

  it('no base with a run id present is still the no-dashboard sentence — now by ORDER', () => {
    // Pinned by the guard order rather than by accident: the base arm is tested first.
    expect(liveLinkLineFor(undefined, 'run-1')).toBe(LIVE_LINK_ABSENT_LINE)
    expect(liveLinkLineFor('   ', 'run-1')).toBe(LIVE_LINK_ABSENT_LINE)
  })

  it('with BOTH absent the base is the fact reported — it is the actionable one', () => {
    expect(liveLinkLineFor(undefined, undefined)).toBe(LIVE_LINK_ABSENT_LINE)
    expect(liveLinkLineFor('', '')).toBe(LIVE_LINK_ABSENT_LINE)
  })

  it('the composed line is unchanged — the split moved no byte of the present arm', () => {
    expect(liveLinkLineFor('http://127.0.0.1:7777/', 'run-1')).toBe(
      'watch live or review: http://127.0.0.1:7777/runs/run-1/live',
    )
    expect(liveLinkLineFor(` ${BASE} `, 'run-1')).toBe(liveLinkLine(liveRunLinkOf(BASE, 'run-1')))
  })

  it('the new absence FABRICATES NO URL — the property both constants are held to', () => {
    expect(LIVE_LINK_NO_RUN_LINE).not.toContain('://')
    expect(LIVE_LINK_NO_RUN_LINE).not.toContain('http')
    // And it names no config knob, because there is nothing here for an operator to set.
    expect(LIVE_LINK_NO_RUN_LINE).not.toContain('services.dashboard.baseUrl')
  })

  it('rides the package barrel, so every consumer asserts the SAME sentence', () => {
    expect(barrel.LIVE_LINK_NO_RUN_LINE).toBe(LIVE_LINK_NO_RUN_LINE)
    expect(barrel.LIVE_LINK_ABSENT_LINE).toBe(LIVE_LINK_ABSENT_LINE)
    expect(LIVE_LINK_NO_RUN_LINE).not.toBe(LIVE_LINK_ABSENT_LINE)
  })
})

// ---- 4. `runIdFrom` routing -------------------------------------------------------------

describe('the concrete runId comes from the source the projection DECLARES', () => {
  it("reads agent_qa_start_run's runId off the op OUTPUT", async () => {
    // Asked to start under one id, the scripted starter answers another. A decoration reading the
    // INPUT would name the id nobody ran under.
    const result = await callTool('agent_qa_start_run', { runId: ASKED_RUN_ID }, {
      base: FIXTURE_BASE,
    })

    expect(result.isError ?? false, JSON.stringify(textsOf(result))).toBe(false)
    expect(textsOf(result)).toContain(
      liveLinkLine(liveRunLinkOf(FIXTURE_BASE, STARTED_RUN_ID)),
    )
    expect(resourceUriOf(result)).toBe(appResourceUriFor(STARTED_RUN_ID))
  })

  it("reads agent_qa_get_run_digest's runId off the validated INPUT", async () => {
    const result = await callTool('agent_qa_get_run_digest', { runId: ASKED_RUN_ID }, {
      base: FIXTURE_BASE,
    })

    expect(textsOf(result)).toContain(
      liveLinkLine(liveRunLinkOf(FIXTURE_BASE, ASKED_RUN_ID)),
    )
    expect(resourceUriOf(result)).toBe(appResourceUriFor(ASKED_RUN_ID))
  })
})
