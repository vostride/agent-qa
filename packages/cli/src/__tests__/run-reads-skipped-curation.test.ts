// A run whose chain was never enqueued carries the skipped fact beside its curation chip.

import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { generateRunId } from '@vostride/agent-qa-ids'
import { FsHandoffStore } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, PerTestOutcome } from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composeMcpMasking, createMcpHttpRequestListener } from '../commands/mcp.js'
import { createRunsCommand } from '../commands/runs.js'
import * as host from '../composition/local-agent-host.js'
import { cleanupTempRoots, fixtureProject } from './conformance/spawned-chat.js'

const cleanups: (() => void | Promise<void>)[] = []
let originalExitCode: typeof process.exitCode

beforeEach(() => {
  originalExitCode = process.exitCode
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
  for (const close of cleanups.splice(0).reverse()) await close()
  cleanupTempRoots()
})

// ---- The fixtures ---------------------------------------------------------------------------------

type Marker = 'gate-run' | 'outcome-excluded' | 'none'

function completedRun(agentQaRoot: string, endedAt: number, marker: Marker,
  verdict: CompletedRunHandoff['aggregateVerdict']): string {
  const runId = generateRunId()
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: verdict,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: endedAt - 50,
    endedAt,
    tests: [{
      testId: 't-checkout', testName: 'Checkout', filePath: 'tests/t-checkout.yaml', testIndex: 0,
      outcome: verdict === 'passed' ? 'passed' : 'failed', steps: [],
    } as unknown as PerTestOutcome],
    ...(marker === 'gate-run' ? { gateRun: true as const } : {}),
    ...(marker === 'outcome-excluded' ? { excludedFromOutcomes: true as const } : {}),
  }
  new FsHandoffStore({ root: agentQaRoot, runId }).save(handoff)
  return runId
}

/** One project holding a gate run, an outcome-excluded run and an ordinary run, read by every cell. */
function skippedRuns() {
  const project = fixtureProject('skipped')
  writeFileSync(join(project.root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project.root, '.env'), '')
  writeFileSync(join(project.root, '.env.secrets.local'), '')
  const agentQaRoot = join(project.root, '.agent-qa')
  return {
    configPath: project.configPath,
    agentQaRoot,
    gateRun: completedRun(agentQaRoot, 1_700_000_001_000, 'gate-run', 'passed'),
    outcomeExcluded: completedRun(agentQaRoot, 1_700_000_002_000, 'outcome-excluded', 'failed'),
    ordinary: completedRun(agentQaRoot, 1_700_000_003_000, 'none', 'passed'),
  }
}

// ---- Drivers --------------------------------------------------------------------------------------

interface Invocation {
  stdout: string
  stderr: string
  exitCode: number
}

function allCommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap(allCommands)]
}

async function cli(configPath: string, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined
  const program = new Command()
    .option('--config <path>', 'config file path')
    .addCommand(createRunsCommand())
  for (const command of allCommands(program)) {
    command.exitOverride().configureOutput({
      writeOut: (text) => { stdout.push(text) },
      writeErr: (text) => { stderr.push(text) },
    })
  }
  let exitCode: number
  try {
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, ...args])
    exitCode = Number(process.exitCode ?? 0)
  } catch (thrown) {
    if (!(thrown instanceof CommanderError)) throw thrown
    exitCode = thrown.exitCode
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = undefined
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode }
}

function json(invocation: Invocation): unknown {
  expect(invocation.exitCode, invocation.stderr).toBe(0)
  return JSON.parse(invocation.stdout) as unknown
}

type WireResult = {
  readonly content: readonly { type: string; text?: string }[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

async function mcpReader(p: { configPath: string; agentQaRoot: string }) {
  const composed = host.composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
  cleanups.push(() => composed.close())
  const masking = composeMcpMasking({ configPath: p.configPath })
  const server = createServer(createMcpHttpRequestListener({
    registry: composed.registry, maskText: (text) => masking.mask(text),
  }))
  await new Promise<void>((listening, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', listening)
  })
  cleanups.push(() => new Promise<void>((closed) => server.close(() => closed())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MCP did not bind')
  const client = new Client({ name: 'agent-qa', version: '0.0.0' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(address.port)}/mcp`)))
  return {
    async structured(name: string, args: Record<string, unknown>): Promise<unknown> {
      const result = await client.callTool({ name, arguments: args }) as unknown as WireResult
      const text = result.content.map((block) => block.text ?? '').join('\n')
      expect(result.isError ?? false, text.slice(0, 400)).toBe(false)
      return result.structuredContent
    },
  }
}

type OverviewCuration = { learned: { curation: Record<string, unknown> } }

async function overviewCuration(p: ReturnType<typeof skippedRuns>, runId: string,
  mcp: Awaited<ReturnType<typeof mcpReader>>): Promise<Record<string, unknown>> {
  const overview = json(await cli(p.configPath, ['runs', 'overview', runId, '--json']))
  expect(overview).toEqual(await mcp.structured('agent_qa_get_run_overview', { runId }))
  return (overview as OverviewCuration).learned.curation
}

describe('the overview carries skipped curation', () => {
  it("a gate run's overview carries skipped with reason gate-run beside its curation chip", async () => {
    const p = skippedRuns()
    const mcp = await mcpReader(p)
    const curation = await overviewCuration(p, p.gateRun, mcp)
    expect(curation).toEqual({ status: 'pending', skipped: { reason: 'gate-run' } })
  })

  it("an outcome-excluded run's overview carries skipped with reason outcome-excluded", async () => {
    const p = skippedRuns()
    const mcp = await mcpReader(p)
    const curation = await overviewCuration(p, p.outcomeExcluded, mcp)
    expect(curation).toEqual({ status: 'pending', skipped: { reason: 'outcome-excluded' } })
  })

  it("an ordinary run's overview carries no skipped key", async () => {
    const p = skippedRuns()
    const mcp = await mcpReader(p)
    const curation = await overviewCuration(p, p.ordinary, mcp)
    expect('skipped' in curation).toBe(false)
    expect(curation).toEqual({ status: 'pending' })
  })

  it('the overview text prints curation skipped (gate run)', async () => {
    const p = skippedRuns()
    const learnedLine = async (runId: string) => {
      const human = await cli(p.configPath, ['runs', 'overview', runId])
      expect(human.exitCode, human.stderr).toBe(0)
      const lines = human.stdout.split('\n').filter((line) => line.startsWith('Learned:'))
      expect(lines, human.stdout).toHaveLength(1)
      return lines[0]!
    }
    const gate = await learnedLine(p.gateRun)
    expect(gate).toContain('curation skipped (gate run)')
    expect(gate).not.toContain('curation pending')
    expect(gate).toBe('Learned: snapshot not recorded · curation skipped (gate run)')
    expect(await learnedLine(p.ordinary)).toBe('Learned: snapshot not recorded · curation pending')
  })
})

// The knowledge read carries skipped curation.

type KnowledgeCuration = { kind: string; curation: Record<string, unknown> }

async function knowledgeCuration(p: ReturnType<typeof skippedRuns>, runId: string,
  mcp: Awaited<ReturnType<typeof mcpReader>>): Promise<Record<string, unknown>> {
  const knowledge = json(await cli(p.configPath, ['runs', 'knowledge', runId, '--json']))
  expect(knowledge).toEqual(await mcp.structured('agent_qa_get_run_knowledge', { runId }))
  expect((knowledge as KnowledgeCuration).kind).toBe('ready')
  return (knowledge as KnowledgeCuration).curation
}

describe('the knowledge read carries skipped curation', () => {
  it("a gate run's knowledge carries skipped with reason gate-run beside its curation chip", async () => {
    const p = skippedRuns()
    const mcp = await mcpReader(p)
    const curation = await knowledgeCuration(p, p.gateRun, mcp)
    expect(curation).toEqual({ status: 'pending', skipped: { reason: 'gate-run' } })
  })

  it("an ordinary run's knowledge carries no skipped key", async () => {
    const p = skippedRuns()
    const mcp = await mcpReader(p)
    const curation = await knowledgeCuration(p, p.ordinary, mcp)
    expect('skipped' in curation).toBe(false)
    expect(curation).toEqual({ status: 'pending' })
  })

  it('the knowledge text prints curation skipped (gate run)', async () => {
    const p = skippedRuns()
    const headerLine = async (runId: string) => {
      const human = await cli(p.configPath, ['runs', 'knowledge', runId])
      expect(human.exitCode, human.stderr).toBe(0)
      const lines = human.stdout.split('\n').filter((line) => line.startsWith(`Run ${runId} knowledge`))
      expect(lines, human.stdout).toHaveLength(1)
      return lines[0]!
    }
    const gate = await headerLine(p.gateRun)
    expect(gate).toContain('curation skipped (gate run)')
    expect(gate).not.toContain('curation pending')
    expect(gate.endsWith(' · curation skipped (gate run)'), gate).toBe(true)
    const ordinary = await headerLine(p.ordinary)
    expect(ordinary.endsWith(' · curation pending'), ordinary).toBe(true)
  })
})
