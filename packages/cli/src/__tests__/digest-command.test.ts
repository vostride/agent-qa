// The output is compared with a cold second composition, so the byte claim is not circular.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction, RUNS_DIGEST_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig } from '@vostride/agent-qa-knowledge-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { asRecordId, asRunId, CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { Anchor, CompletedRunHandoff, RunDigest, Verdict } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDigestCommand } from '../commands/digest.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import { fileLeftoverKnowledgeProposal } from '../composition/__tests__/leftover-knowledge-proposal.js'

const OLDER_RUN = 'run-cmd-older'
const NEWER_RUN = 'run-cmd-newer'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rootCause(
  perTest: number,
  rationale = 'the submit control is gone from the checkout DOM',
): Verdict {
  return {
    class: 'app_bug',
    producer: 'deterministic-classifier',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale,
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  } as Verdict
}

function handoff(
  runId: string,
  endedAt: number,
  rationale = 'the submit control is gone from the checkout DOM',
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'digest-cmd-storefront' },
    buildOrdinal: 2,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt,
    tests: [
      {
        testId: 'TST-501',
        testName: 'checks out',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [],
        rootCause: rootCause(0, rationale),
      },
    ],
  } as unknown as CompletedRunHandoff
}

interface Workspace {
  root: string
  configPath: string
  agentQaRoot: string
  knowledgeRoot: string
}

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-cmd-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        testPathIgnore: [],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'preserve' } },
    }, null, 2)}\n`,
    'utf8',
  )
  // `runs.list` refuses without a readable secrets file.
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  // Two completed runs, the newer one ending later, so "most recent" is a claim about
  // chronology rather than about whichever id sorts last.
  for (const [runId, endedAt] of [[OLDER_RUN, 100], [NEWER_RUN, 900]] as const) {
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff(runId, endedAt))}\n`, 'utf8')
  }
  return { root, configPath, agentQaRoot, knowledgeRoot: join(root, 'agent-qa-knowledge') }
}

function storeConfig(ws: Workspace): BundleStoreConfig {
  return {
    knowledgeRoot: ws.knowledgeRoot,
    productKey: 'Digest Command Product',
  }
}

/** A real record, then an older proposal file about it planted beside it, attributed to a run. */
async function plantLeftoverProposal(ws: Workspace, runId: string, summary: string, ordinal: number): Promise<string> {
  const published = publishBundleForTest(storeConfig(ws), {
    draft: {
      kind: 'fact',
      subtype: 'selector',
      anchors: [ANCHOR],
      scope: { tier: 'product', key: 'digest-cmd' },
      summary,
      body: `Selecting ${summary} advances to the payment page.`,
      distilledEvidenceRef: { id: `cmd-${summary}`, sha: 'a'.repeat(64) },
      originStage: 'run-curation',
    },
    discriminant: {
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'Button', name: summary },
    },
    originClass: 'agent-verified',
    createdAtOrdinal: ordinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: { mode: 'run-linked', runId: 'digest-cmd', testId: 't', stepIndex: 0 },
    artifacts: [],
  })
  if (published.kind !== 'published') throw new Error(`fixture publish failed: ${published.kind}`)
  return await fileLeftoverKnowledgeProposal({
    agentQaRoot: ws.agentQaRoot,
    verb: 'forget',
    target: { grain: 'record', recordId: asRecordId(published.id) },
    runId,
  })
}

interface Invocation {
  stdout: string
  stderr: string
  exitCode: number | string | undefined
}

async function run(ws: Workspace, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const priorExit = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createDigestCommand())
    program.exitOverride()
    await program.parseAsync(['node', 'agent-qa', '--config', ws.configPath, ...args])
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  } finally {
    process.exitCode = priorExit
    log.mockRestore()
    error.mockRestore()
  }
}

/** The op result, read through a SECOND cold composition over the same directories. */
async function digestThroughTheOp(ws: Workspace, runId: string): Promise<RunDigest> {
  const host = composeCliLocalAgent({ agentQaRoot: ws.agentQaRoot, configPath: ws.configPath })
  try {
    return await invokeFunction(
      host.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as RunDigest
  } finally {
    await host.close()
  }
}

describe('agent-qa digest, the on-demand channel', () => {
  it('prints the op result\'s lines, byte for byte, and composes nothing of its own', async () => {
    const ws = workspace()
    await plantLeftoverProposal(ws, NEWER_RUN, 'checkout button', 11)

    const invocation = await run(ws, ['digest', NEWER_RUN])
    const digest = await digestThroughTheOp(ws, NEWER_RUN)

    expect(invocation.stderr).toBe('')
    expect(invocation.exitCode).toBeUndefined()
    // The whole claim, as one comparison: the printed bytes ARE the op's lines.
    expect(invocation.stdout).toBe(digest.lines.join('\n'))
    // Non-vacuity: the digest has real sections; the planted proposal is read nowhere.
    expect(digest.lines.length).toBeGreaterThan(3)
    expect(invocation.stdout).toContain('marks — no changes applied')
    expect(invocation.stdout).not.toMatch(/proposal|minted/)
  })

  it('digests the most recently FINISHED run when none is named', async () => {
    const ws = workspace()

    const invocation = await run(ws, ['digest'])

    // `${OLDER_RUN}` sorts AFTER `${NEWER_RUN}` by id — so an implementation that picked by
    // runId rather than by completion would answer the older run here. The chronology is what
    // is being pinned.
    expect(OLDER_RUN > NEWER_RUN).toBe(true)
    expect(invocation.stdout).toContain(`digest — ${NEWER_RUN}`)
    expect(invocation.stdout).not.toContain(`digest — ${OLDER_RUN}`)
  })

  it('emits the structured sections under --json, not the rendered lines', async () => {
    const ws = workspace()
    const invocation = await run(ws, ['digest', NEWER_RUN, '--json'])

    const parsed = JSON.parse(invocation.stdout) as RunDigest
    expect(parsed.runId).toBe(NEWER_RUN)
    expect(parsed.chain).toEqual({ analysis: 'pending', curation: 'pending' })
    expect(parsed.markChanges).toEqual([])
    expect(parsed).not.toHaveProperty('pendingProposalCount')
  })

  it('reports a run that never happened as an error, and sets a non-zero exit code', async () => {
    const ws = workspace()
    const invocation = await run(ws, ['digest', 'run-that-never-happened'])

    expect(invocation.stdout).toBe('')
    expect(invocation.stderr).toContain('RunNotFoundError')
    expect(invocation.exitCode).toBe(1)
  })
})

const CRAFTED_RATIONALE = '##[error]x ::set-output name=x::y'
const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

function craftedWorkspace(): Workspace {
  const ws = workspace()
  const runDir = join(ws.agentQaRoot, RUNS_SUBDIR, slugBranch(NEWER_RUN))
  writeFileSync(
    join(runDir, HANDOFF_FILE),
    `${JSON.stringify(handoff(NEWER_RUN, 900, CRAFTED_RATIONALE))}\n`,
    'utf8',
  )
  return ws
}

async function runCapturingWrites(
  ws: Workspace,
  args: readonly string[],
): Promise<Invocation & { writes: string[] }> {
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  try {
    return { ...(await run(ws, args)), writes }
  } finally {
    write.mockRestore()
  }
}

describe('agent-qa digest under GitHub Actions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prints the digest lines as one stop-commands pair on stdout', async () => {
    const ws = craftedWorkspace()
    const digest = await digestThroughTheOp(ws, NEWER_RUN)
    const rendered = digest.lines.join('\n')
    expect(rendered).toContain(CRAFTED_RATIONALE)
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runCapturingWrites(ws, ['digest', NEWER_RUN])

    expect(invocation.stdout).toBe('')
    expect(invocation.writes).toHaveLength(1)
    expect(invocation.writes[0]).toMatch(PAIR)
    expect(invocation.writes[0]).toContain(`\n${rendered}\n`)
  })

  it('prints the --json document with no # and parses back to the digest', async () => {
    const ws = craftedWorkspace()
    const digest = await digestThroughTheOp(ws, NEWER_RUN)
    expect(JSON.stringify(digest)).toContain('#')
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runCapturingWrites(ws, ['digest', NEWER_RUN, '--json'])

    expect(invocation.writes.join('')).not.toContain('::stop-commands::')
    expect(invocation.stdout).not.toContain('#')
    expect(invocation.stdout).not.toContain('::stop-commands::')
    expect(JSON.parse(invocation.stdout)).toEqual(digest)
  })

  it('prints a run-derived error inside a pair on stdout', async () => {
    const ws = craftedWorkspace()
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runCapturingWrites(ws, ['digest', 'run-that-never-happened'])

    expect(invocation.exitCode).toBe(1)
    expect(invocation.stderr).toBe('')
    expect(invocation.writes).toHaveLength(1)
    expect(invocation.writes[0]).toMatch(PAIR)
    expect(invocation.writes[0]).toContain('RunNotFoundError')
  })

  it('prints the same lines and JSON as before without the variable', async () => {
    const ws = craftedWorkspace()
    const digest = await digestThroughTheOp(ws, NEWER_RUN)

    const human = await runCapturingWrites(ws, ['digest', NEWER_RUN])
    const json = await runCapturingWrites(ws, ['digest', NEWER_RUN, '--json'])

    expect(human.writes).toEqual([])
    expect(human.stdout).toBe(digest.lines.join('\n'))
    expect(json.writes).toEqual([])
    expect(json.stdout).toBe(JSON.stringify(digest, null, 2))
  })
})

describe('the surfaces own no capability of their own', () => {
  it('dispatches through invokeFunction with the CLI caller mint, and holds no gate', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    for (const file of ['digest.ts']) {
      const source = readFileSync(
        fileURLToPath(new URL(`../commands/${file}`, import.meta.url)),
        'utf8',
      )
      // One dispatch path and one caller; a hand-rolled caller lets a surface pick its own origin.
      expect(source).toContain('invokeFunction')
      expect(source).toContain('CLI_FUNCTION_CALLER')
      expect(source).not.toMatch(/origin:\s*'(human|agent)'/u)
      // No gate, registry construction or store, or a surface has a path around the pipeline.
      expect(source).not.toContain('evaluate')
      expect(source).not.toContain('createRegistryFromSpecs')
      expect(source).not.toContain('agent-qa-knowledge-local')
      expect(source).not.toContain('agent-qa-safety')
    }
  })
})
