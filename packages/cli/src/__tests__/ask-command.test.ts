// The CLI owns no turn capability: it composes the local host and calls `agent.ask` like any op.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import type { AgentAskResult } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAskCommand } from '../commands/ask.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  fixtureProject,
  spawnCollecting,
} from './conformance/spawned-chat.js'
import type { SpawnOutcome } from './conformance/spawned-chat.js'

// A pass-through tap on the real composition, so the other cells still drive the real registry.
const compositionInputs = vi.hoisted(() => [] as { chatPresent?: (text: string) => void }[])

const standInTurn = vi.hoisted(() => ({ result: undefined as AgentAskResult | undefined }))

vi.mock('@vostride/agent-qa-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vostride/agent-qa-agent')>()
  return {
    ...original,
    invokeFunction: (...args: Parameters<typeof original.invokeFunction>) =>
      standInTurn.result === undefined
        ? original.invokeFunction(...args)
        : Promise.resolve(standInTurn.result),
  }
})

vi.mock('../composition/local-agent-host.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../composition/local-agent-host.js')>()
  return {
    ...original,
    composeCliLocalAgent: (input: Parameters<typeof original.composeCliLocalAgent>[0]) => {
      compositionInputs.push(input as { chatPresent?: (text: string) => void })
      return original.composeCliLocalAgent(input)
    },
  }
})

interface InvocationResult {
  stdout: string
  stderr: string
  writes: string[]
  exitCode: number | string | undefined
}

function fixtureWorkspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-ask-command-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return configPath
}

async function runAsk(configPath: string, args: string[]): Promise<InvocationResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  process.exitCode = undefined

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createAskCommand())
    program.exitOverride()
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'ask', ...args])
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      writes,
      exitCode: process.exitCode,
    }
  } finally {
    log.mockRestore()
    error.mockRestore()
    write.mockRestore()
  }
}

// Prose no capability handles, so the turn fail-closes deterministically with no model consulted.
const UNROUTABLE_PROSE = 'zzqq flibberwock zorptastic'

/** A value that is not shaped like an environment variable's name. */
const NOT_A_REFERENCE = 'sk-PROBE-0000000000000000000000000000'

// One clause whose op reaches its capability and declines on the reference field's shape.
const REFUSED_CLAUSE = `/fn config.auth.set ${JSON.stringify({
  target: 'web',
  envVarName: NOT_A_REFERENCE,
})}`

/**
 * The receipt line a person reads for a failed `agent.ask` clause, or `undefined` if there is none.
 *
 * READ AS A LINE, NOT AS TWO WHOLE-STDOUT SEARCHES. `receipt-line.ts` renders
 * `  <status>  <op>  <clause>`, and the clause is the utterance — which in these cells CONTAINS the
 * words being searched for. A `toContain('failed')` over the whole child stdout would therefore pass
 * against a build that rendered no receipt at all.
 */
function failedAgentAskReceiptLine(stdout: string): string | undefined {
  // picocolors colors when `CI` is set (the gate sets it), and an in-process drive keeps the escapes.
  return stripVTControlCharacters(stdout).split('\n').find(
    (line) => line.trim().startsWith('failed') && line.includes('agent.ask'),
  )
}

describe('agent-qa ask (the one-shot chat verb)', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
    compositionInputs.length = 0
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('routes a deterministic utterance through agent.ask and renders the receipt', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, ['/fn runs.list'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    // The receipt line names the op that actually ran, which is the whole visible difference
    // between a turn and a chatbot: the surface reports a capability invocation, not prose.
    expect(result.stdout).toContain('runs.list')
    expect(result.stdout).toContain('executed')
  })

  it('the rendered receipt line carries the receipt\'s own `outcome`', async () => {
    // The rendered `outcome` line governs: the scripted surface shares the REPL's receipt wording.
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, ['/fn runs.list'])

    expect(result.stdout).toContain('0 completed run(s)')
  })

  it('binds a presentation port on the SAME stream its confirm prompts on', async () => {
    // The presentation port is bound to stdout; the cell asserts the binding and what it writes.
    const configPath = fixtureWorkspace(roots)
    await runAsk(configPath, ['/fn runs.list'])

    expect(compositionInputs).toHaveLength(1)
    const chatPresent = compositionInputs[0]?.chatPresent
    expect(typeof chatPresent).toBe('function')

    // Spies `process.stdout.write`, because a render on another stream is not what a person reads.
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return true
      })
    try {
      chatPresent?.('a summary line\nagent-qa.config.yaml\n--- /dev/null')
    } finally {
      write.mockRestore()
    }
    expect(written.join('')).toBe('a summary line\nagent-qa.config.yaml\n--- /dev/null\n')
  })

  it('a fail-closed turn reports the clause and exits non-zero', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, ['write a test for two factor auth'])

    // Non-zero, because a scripted `ask` whose request was not carried out must not look like
    // success to the shell that called it (the fn.ts error idiom).
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('write a test for two factor auth')
  })

  // A clause whose op returned a non-success verdict must fail the aggregate and the shell.

  it('a returned failure fails the shell (in-process)', async () => {
    // The INNER turn fail-closes with no model consulted — the prose routes to no capability in
    // this build — and `agent.ask`'s own classifier RETURNS `failed` for the OUTER clause. Nothing
    // throws anywhere on this path, which is the whole reason the exit gate never fired.
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, [`/fn agent.ask ${JSON.stringify({
      message: UNROUTABLE_PROSE,
    })}`])

    // NON-VACUITY FIRST: the turn really reached `agent.ask` and really came back with the failed
    // verdict on the receipt line a person reads. Without this, a drive that died for some other
    // reason — a missing binding, a thrown composition error — would satisfy the exit assertion
    // while measuring nothing about the derivation.
    expect(
      failedAgentAskReceiptLine(result.stdout),
      'the turn printed no receipt line carrying both the failed status word and agent.ask, so '
      + `the exit assertion below would be measuring something else. stdout: ${
        JSON.stringify(result.stdout.slice(0, 900))}`,
    ).not.toBeUndefined()

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('agent.ask')
  })

  it('a refused-only turn keeps the success exit, as fn does', async () => {
    // A refusal is not a failure: the op answered, so this door exits 0 like the `fn` door.
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, [REFUSED_CLAUSE])

    // NON-VACUITY: the refusal actually fired, rather than the mutation quietly succeeding.
    expect(result.stdout).toContain('refused')
    expect(result.stdout).toContain('refs-only')

    expect(result.exitCode).toBeUndefined()
  })
})

describe('agent-qa ask under GitHub Actions', () => {
  const ANSWER = '::add-mask::secret-looking ##[error]x'
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  function turn(overrides: Partial<AgentAskResult>): AgentAskResult {
    return {
      sessionId: 'session-1', turnId: 'turn-1', status: 'completed', receipts: [], results: [],
      ...overrides,
    }
  }

  beforeEach(() => {
    originalExitCode = process.exitCode
    compositionInputs.length = 0
  })

  afterEach(() => {
    standInTurn.result = undefined
    vi.unstubAllEnvs()
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('prints a model answer as text inside one stop-commands pair', async () => {
    const configPath = fixtureWorkspace(roots)
    standInTurn.result = turn({ answer: ANSWER })
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const result = await runAsk(configPath, ['what changed'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toBe('')
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toMatch(PAIR)
    expect(result.writes[0]).toContain(`\n${ANSWER}\n`)
  })

  it('prints an error carrying model text inside its own pair', async () => {
    const configPath = fixtureWorkspace(roots)
    standInTurn.result = turn({
      status: 'fail_closed', unhandled: { clause: 'what changed', reason: ANSWER },
    })
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const result = await runAsk(configPath, ['what changed'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.writes).toHaveLength(2)
    expect(result.writes[1]).toMatch(PAIR)
    expect(result.writes[1]).toContain(ANSWER)
  })

  it('prints a mid-turn render inside one pair', async () => {
    const configPath = fixtureWorkspace(roots)
    standInTurn.result = turn({})
    await runAsk(configPath, ['what changed'])
    const chatPresent = compositionInputs[0]?.chatPresent
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      chatPresent?.(ANSWER)
    } finally {
      write.mockRestore()
    }

    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(PAIR)
    expect(written[0]).toContain(`\n${ANSWER}\n`)
  })

  it('a secrets file it cannot read is reported inside one pair', async () => {
    const configPath = fixtureWorkspace(roots)
    const secretsPath = join(dirname(configPath), '.env.secrets.local')
    rmSync(secretsPath)
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const result = await runAsk(configPath, ['what changed'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toMatch(PAIR)
    expect(result.writes[0]).toContain(`Secrets file not found: ${secretsPath}`)
    expect(result.writes[0]).toContain('Create the file before running tests.')
  })

  it('prints a model answer and its error exactly as before off GitHub Actions', async () => {
    const configPath = fixtureWorkspace(roots)
    standInTurn.result = turn({ answer: ANSWER })
    const answered = await runAsk(configPath, ['what changed'])
    standInTurn.result = turn({
      status: 'fail_closed', unhandled: { clause: 'what changed', reason: ANSWER },
    })
    const refused = await runAsk(configPath, ['what changed'])

    expect(answered.writes).toEqual([])
    expect(answered.stdout.split('\n').at(-1)).toBe(ANSWER)
    expect(refused.writes).toEqual([])
    expect(stripVTControlCharacters(refused.stderr))
      .toContain(`Ask error [fail-closed]: ${ANSWER}`)
    expect(refused.stderr).not.toContain('::stop-commands::')
  })
})

// A spawned child escapes the module mock, and its exit code is what a CI step reads.

describe('agent-qa ask on the shipped binary: one receipt word, one exit code', () => {
  afterEach(() => {
    cleanupTempRoots()
  })

  /** Spawn the built entry for one `ask`, asserting the build is the one this source describes. */
  async function spawnAsk(label: string, message: string): Promise<SpawnOutcome> {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
    const fixture = fixtureProject(`399-1-09-exit-${label}`)
    return await spawnCollecting(
      fixture.root,
      [CLI_ENTRY, '--config', fixture.configPath, 'ask', message],
    )
  }

  it('exits 1 on a RETURNED failed verdict', async () => {
    const outcome = await spawnAsk('returned', `/fn agent.ask ${JSON.stringify({
      message: UNROUTABLE_PROSE,
    })}`)

    // NON-VACUITY BEFORE THE CODE: the child really printed the failed verdict for `agent.ask`.
    expect(
      failedAgentAskReceiptLine(outcome.stdout),
      'the shipped binary printed no receipt line carrying both the failed status word and '
      + `agent.ask. stdout: ${JSON.stringify(outcome.stdout.slice(0, 900))}; stderr: ${
        JSON.stringify(outcome.stderr.slice(0, 400))}`,
    ).not.toBeUndefined()

    expect(outcome.code).toBe(1)
  }, 180_000)

  it('exits 1 on a THROWN failure (cross-axis control)', async () => {
    // THE OTHER AXIS, HELD FIXED. This one was always 1 — the op throws, the engine's catch mints
    // the `failed` receipt and sets the flag. It is here so the fix cannot be read as "returned
    // failures now exit 1" without also being read as "and thrown ones still do".
    const outcome = await spawnAsk('thrown', '/fn runs.digest {"runId":"r_nope"}')

    expect(
      outcome.stdout,
      `the shipped binary printed no failed receipt for the thrown case. stdout: ${
        JSON.stringify(outcome.stdout.slice(0, 900))}`,
    ).toContain('RunNotFoundError')

    expect(outcome.code).toBe(1)
  }, 180_000)

  it('keeps the success exit on a refused-only turn', async () => {
    const outcome = await spawnAsk('refused', REFUSED_CLAUSE)

    // NON-VACUITY: the refusal fired on the shipped binary too.
    expect(
      outcome.stdout,
      `the shipped binary did not print the refs-only refusal. stdout: ${
        JSON.stringify(outcome.stdout.slice(0, 900))}`,
    ).toContain('refused')
    expect(outcome.stdout).toContain('refs-only')

    expect(outcome.code).toBe(0)
  }, 180_000)
})
