// One change call writes and answers what it changed: no commit, no proposal, no confirm input.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildAgentQaMcpServer } from '@vostride/agent-qa-mcp'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import { KnowledgeChangeOutputSchema } from '@vostride/agent-qa-schema'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeMcpMasking, MCP_FUNCTION_CALLER } from '../commands/mcp.js'
import { composeCliLocalAgent } from '../composition/local-agent-host.js'

const CONFIG_FILE = 'agent-qa.config.yaml'

const KNOWLEDGE_TOOL = 'agent_qa_change_knowledge'
const CONFIG_TOOL = 'agent_qa_change_config'
const RETIRED_TOOLS = [
  'agent_qa_apply_proposal',
  'agent_qa_apply_config_proposal',
  'agent_qa_propose_knowledge_change',
  'agent_qa_propose_config_change',
  'agent_qa_list_proposals',
  'agent_qa_show_proposal',
] as const

/** The house-style config, valid against the real schema. */
const SEEDED_CONFIG = `# agent-qa Configuration

workspace:
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
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html

use:
  llm: judge
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`

let root: string
let configPath: string
let agentQaRoot: string
let knowledgeRoot: string
let host: ReturnType<typeof composeCliLocalAgent> | undefined
let masking: ReturnType<typeof composeMcpMasking> | undefined

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`)
  }
  return result.stdout
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').trim())
}

/** The working tree's own answer about whether anything is uncommitted. */
function porcelain(): string {
  return git('status', '--porcelain').trim()
}

/** One committed candidate record in the real store, through the layer's own publish helper. */
function publishRecord(name: string): string {
  const outcome = publishBundleForTest(
    { knowledgeRoot, productKey: 'Change Differential' },
    {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'Button', name }],
        scope: { tier: 'product', key: 'change-differential' },
        summary: `${name.toLowerCase()} button`,
        body: `Selecting ${name} advances the flow.`,
        distilledEvidenceRef: { id: `evidence-${name.toLowerCase()}`, sha: 'c'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name } },
      originClass: 'agent-verified',
      createdAtOrdinal: 3,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'change-differential', testId: 't', stepIndex: 0 },
      artifacts: [],
    },
  )
  if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
  return outcome.id
}

/** One recorded exchange: the bytes a caller's transport actually received. */
interface Frame {
  readonly status: number
  readonly text: string
}

interface Session {
  readonly client: Client
  readonly frames: Frame[]
  readonly elicited: unknown[]
  close(): Promise<void>
}

/** Which protocol era, and whether the client tells the server it can answer an input request. */
interface Era {
  readonly wire: 'legacy' | 'modern'
  readonly elicitation: boolean
}

const LEGACY: Era = { wire: 'legacy', elicitation: false }
const MODERN_CAPABLE: Era = { wire: 'modern', elicitation: true }

// A real MCP client on a server from the shipped factory; every change tool is listed for it.
async function connect(era: Era = LEGACY): Promise<Session> {
  const frames: Frame[] = []
  const elicited: unknown[] = []
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: host!.registry,
      caller: MCP_FUNCTION_CALLER,
      maskText: (text: string) => masking!.mask(text),
    }),
  )
  const recordingFetch = (async (url: URL | string, init?: RequestInit) => {
    const res = await handler.fetch(new Request(url as string, init))
    frames.push({ status: res.status, text: await res.clone().text() })
    return res
  }) as typeof fetch

  const client = new Client({ name: 'agent-qa-432-12-change', version: '0.0.0' }, {
    ...(era.wire === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    ...(era.elicitation ? { capabilities: { elicitation: {} } } : {}),
  } as never)
  if (era.elicitation) {
    // A client that WOULD answer a form. The claim is that it is never asked.
    client.setRequestHandler('elicitation/create' as never, ((request: unknown) => {
      elicited.push(request)
      return { action: 'accept', content: {} }
    }) as never)
  }

  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://change.local/mcp'), { fetch: recordingFetch }),
  )
  return {
    client,
    frames,
    elicited,
    close: async () => {
      await client.close().catch(() => {})
      await handler.close().catch(() => {})
    },
  }
}

function allFrames(session: Session): string {
  return session.frames.map((frame) => frame.text).join('\n')
}

interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
  readonly resultType?: string
}

async function call(session: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await session.client.callTool({ name, arguments: args })) as ToolResult
}

function rendered(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n')
}

/** The store's statuses, read through the knowledge bundle read tool over the same wire. */
async function statuses(session: Session): Promise<string[]> {
  const listed = await call(session, 'agent_qa_list_knowledge_bundles', {})
  const rows = (listed.structuredContent as { result?: unknown } | undefined)?.result
    ?? listed.structuredContent
  return ((rows ?? []) as { status: string }[]).map((row) => row.status).sort()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-432-12-change-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })
  writeFileSync(configPath, SEEDED_CONFIG)
  // The MCP masker reads this project's declared secrets.
  writeFileSync(join(root, '.env.secrets.local'), '')

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa change differential')
  git('config', 'user.email', 'change-differential@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n.env.secrets.local\n')
  git('add', '--', '.gitignore', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'seed')

  host = composeCliLocalAgent({ agentQaRoot, configPath })
  masking = composeMcpMasking({ configPath })
})

afterEach(async () => {
  await host?.close().catch(() => {})
  host = undefined
  masking = undefined
  rmSync(root, { recursive: true, force: true })
})

/** Everything runs headless, the MCP host's own context. */
async function driven(era: Era, cell: (session: Session) => Promise<void>): Promise<void> {
  await runSafetyScope({ executionContext: 'local-headless' }, async () => {
    const session = await connect(era)
    try {
      await cell(session)
    } finally {
      await session.close()
    }
  })
}

describe('1 · changing config writes in the call and commits nothing', () => {
  it('writes the change on the first call, files nothing, and leaves history exactly where it was', async () => {
    await driven(LEGACY, async (session) => {
      const before = commitCount()
      const result = await call(session, CONFIG_TOOL, {
        action: 'config.field.set',
        path: 'use.timeout.step',
        value: '45s',
      })
      const structured = result.structuredContent as { outcome?: string; files?: string[] }

      expect(structured.outcome, rendered(result)).toBe('applied')
      expect(structured.files).toEqual([CONFIG_FILE])
      expect(allFrames(session)).toContain('applied')

      // A plain edit git shows as modified; no commit, and no proposal record.
      expect(commitCount(), 'changing must not commit').toBe(before)
      expect(porcelain()).toBe(`M ${CONFIG_FILE}`)
      expect(readFileSync(configPath, 'utf8')).toContain('step: 45s')
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    })
  })
})

describe('2 · knowledge changes apply on their one call', () => {
  it('accept, reject and forget each change the real store once and answer the records they changed', async () => {
    const forgotten = publishRecord('Checkout')
    const rejected = publishRecord('Coupon')
    await driven(LEGACY, async (session) => {
      const before = commitCount()
      expect(await statuses(session)).toEqual(['candidate', 'candidate'])

      const forget = await call(session, KNOWLEDGE_TOOL, {
        action: 'knowledge.forget', target: { grain: 'record', recordId: forgotten },
      })
      const forgetAnswer = KnowledgeChangeOutputSchema.parse(forget.structuredContent)
      expect(forgetAnswer).toMatchObject({ outcome: 'applied', verb: 'forget', recordIds: [forgotten] })
      if (forgetAnswer.outcome !== 'applied') throw new Error('forget did not apply')
      expect(forgetAnswer.forgetReceipt?.resultingBundleStatus).toBe('tombstoned')

      const reject = await call(session, KNOWLEDGE_TOOL, {
        action: 'knowledge.reject', target: { grain: 'record', recordId: rejected }, reason: 'moved',
      })
      expect(KnowledgeChangeOutputSchema.parse(reject.structuredContent))
        .toMatchObject({ outcome: 'applied', verb: 'reject', recordIds: [rejected] })

      // Read back from disk through the same wire: both changes landed in the call.
      expect(await statuses(session)).toEqual(['deprecated', 'deprecated'])
      // The prose a person reads is the same masked serialization as the machine channel.
      expect(JSON.parse(rendered(reject))).toEqual(reject.structuredContent)

      // Knowledge is gitignored here: nothing tracked moved, no commit, no proposal filed.
      expect(commitCount()).toBe(before)
      expect(porcelain()).toBe('')
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    })
  })

  it('a typed absence is data, and a malformed id is refused before any write', async () => {
    const recordId = publishRecord('Checkout')
    await driven(LEGACY, async (session) => {
      const absent = await call(session, KNOWLEDGE_TOOL, {
        action: 'knowledge.accept', target: { grain: 'record', recordId: 'rec-not-in-this-store' },
      })
      expect(absent.isError ?? false, rendered(absent)).toBe(false)
      expect(absent.structuredContent).toMatchObject({
        outcome: 'target-not-found', target: { grain: 'record', recordId: 'rec-not-in-this-store' },
      })

      for (const target of [
        { grain: 'record', recordId: '' },
        { grain: 'bundle', shortId: 'TST-001' },
      ]) {
        const refused = await call(session, KNOWLEDGE_TOOL, { action: 'knowledge.forget', target })
        expect(refused.isError, JSON.stringify(target)).toBe(true)
      }
      expect(await statuses(session)).toEqual(['candidate'])
      expect(recordId.length).toBeGreaterThan(0)
    })
  })
})

describe('3 · a repeated operation identity is the same change', () => {
  it('answers the same records for a retried identity and lands the change once', async () => {
    const recordId = publishRecord('Checkout')
    await driven(LEGACY, async (session) => {
      const operationId = '7b6a5f4e-3d2c-4b1a-9f8e-7d6c5b4a3f2e'
      const args = { action: 'knowledge.forget', target: { grain: 'record', recordId }, operationId }
      const first = KnowledgeChangeOutputSchema.parse((await call(session, KNOWLEDGE_TOOL, args)).structuredContent)
      const retry = KnowledgeChangeOutputSchema.parse((await call(session, KNOWLEDGE_TOOL, args)).structuredContent)

      expect(first).toMatchObject({ outcome: 'applied', operationId, recordIds: [recordId] })
      expect(retry).toMatchObject({ outcome: 'applied', operationId, recordIds: [recordId] })
      expect(await statuses(session)).toEqual(['deprecated'])
    })
  })
})

describe('4 · there is no confirmation round on either era', () => {
  it('a 2026 client that can answer a form is never asked, and its one call lands', async () => {
    const recordId = publishRecord('Checkout')
    await driven(MODERN_CAPABLE, async (session) => {
      const answer = await call(session, KNOWLEDGE_TOOL, {
        action: 'knowledge.forget', target: { grain: 'record', recordId },
      })
      expect(answer.isError ?? false, rendered(answer)).toBe(false)
      expect(answer.resultType ?? 'complete').not.toBe('input_required')
      expect(answer.structuredContent).toMatchObject({ outcome: 'applied', verb: 'forget' })
      expect(session.elicited).toEqual([])
      expect(allFrames(session)).not.toContain('input_required')
      expect(await statuses(session)).toEqual(['deprecated'])
    })
  })

  it('`confirmed` is not an input — refused at the schema wall, and nothing changes', async () => {
    const recordId = publishRecord('Checkout')
    await driven(LEGACY, async (session) => {
      const before = commitCount()
      for (const [tool, args] of [
        [KNOWLEDGE_TOOL, { action: 'knowledge.forget', target: { grain: 'record', recordId }, confirmed: true }],
        [CONFIG_TOOL, { action: 'config.field.set', path: 'use.timeout.step', value: '45s', confirmed: true }],
      ] as const) {
        const doctored = await call(session, tool, args as Record<string, unknown>)
        expect(doctored.isError, `${tool} accepted a confirmation`).toBe(true)
      }
      expect(await statuses(session)).toEqual(['candidate'])
      expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
      expect(commitCount()).toBe(before)
      expect(porcelain()).toBe('')

      const tools = (await session.client.listTools()).tools
      for (const tool of tools) {
        const schema = JSON.stringify(tool.inputSchema)
        expect(schema, tool.name).not.toContain('"confirmed"')
        expect(schema, tool.name).not.toContain('"proposal_id"')
      }
    })
  })
})

describe('5 · the retired doors are unknown, and each change tool reaches only its own ops', () => {
  it('lists none of the retired names and answers a call to one as an unknown tool, changing nothing', async () => {
    const recordId = publishRecord('Checkout')
    await driven(LEGACY, async (session) => {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain(KNOWLEDGE_TOOL)
      expect(names).toContain(CONFIG_TOOL)
      for (const retired of RETIRED_TOOLS) {
        expect(names, retired).not.toContain(retired)
        const answer = await call(session, retired, { proposal_id: 'prop_0123456789ab', confirmed: true })
          .catch((error: unknown) => ({ isError: true, content: [{ type: 'text', text: String(error) }] }))
        expect(answer.isError, retired).toBe(true)
        expect(rendered(answer), retired).toMatch(/not found|unknown/i)
      }
      expect(await statuses(session)).toEqual(['candidate'])
      expect(recordId.length).toBeGreaterThan(0)
    })
  })

  it('the knowledge tool cannot reach a config op, nor the config tool a knowledge op', async () => {
    await driven(LEGACY, async (session) => {
      const crossed = await call(session, KNOWLEDGE_TOOL, {
        action: 'config.field.set', path: 'use.timeout.step', value: '45s',
      })
      expect(crossed.isError).toBe(true)
      const crossedBack = await call(session, CONFIG_TOOL, {
        action: 'knowledge.forget', target: { grain: 'record', recordId: 'rec-x' },
      })
      expect(crossedBack.isError).toBe(true)
      expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    })
  })
})
