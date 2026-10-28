// `agent-qa ask "<message>"` — the one-shot chat verb, over the real composition (392 D-01/D-24).
//
// The claim under test is a STRUCTURAL one, and it is the reason D-24 exists: the CLI owns no turn
// capability of its own. It resolves a root, composes the local host, and calls `invokeFunction`
// with `agent.ask` exactly as `fn` does with any other op — so everything a turn can do, it can do
// because the function layer let it, and 397's parity suite picks the verb up from the registry
// without the CLI being consulted.
//
// The command builds the real registry through the real composition root, and the failure cases are
// driven by real refusals from the real dispatch pipeline rather than by thrown fixtures. Only the
// GitHub Actions cells stand in a turn result, because no model is bound here to write an answer.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Every composition input this command handed the real composition root (395-22 · (A3)).
 *
 * A PASS-THROUGH RECORDER AND NOT A DOUBLE. The mock below delegates to the genuine
 * `composeCliLocalAgent` — every other cell in this file drives the real registry through the real
 * composition and must keep doing so, because "the CLI owns no turn capability" is a structural
 * claim that a stubbed composition would make unmeasurable. What is added is a tap: the ARGUMENT is
 * captured on its way through, which is the only thing (A3) is about.
 */
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

// ---- The two inputs the 399.1-09 cells share, and why each is the input it is -------------------

/**
 * Prose no capability in this build handles, so the turn it reaches fail-closes DETERMINISTICALLY.
 *
 * NO MODEL IS CONSULTED ON THIS ROAD, which is what makes it usable in a hermetic cell: the resolver
 * table matches nothing, the composition is model-unbound, and `mark_unhandled` fails the turn
 * closed. Wrapped in `/fn agent.ask`, that fail-closed inner turn becomes the outer clause's
 * RETURNED `failed` verdict — the exact ending the engine used to derive `completed` over.
 */
const UNROUTABLE_PROSE = 'zzqq flibberwock zorptastic'

/** A value that is not shaped like an environment variable's name. */
const NOT_A_REFERENCE = 'sk-PROBE-0000000000000000000000000000'

/**
 * One clause whose op reaches its capability and DECLINES: the refs-only arm, not a failure.
 *
 * 2026-10-14 (441 D-15): re-aimed from the deleted construction-scan block to the reference
 * field's shape refusal, which is decided on the input before anything is read past the set.
 */
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

  // 432-13: the bare `proposals` alias left the resolver table with the inbox route (C432-CHAT-DIRECT).
  // 432-17 deleted `proposals.list` too; the generic `/fn` passthrough reaches `runs.list` instead.
  it('D-24: routes a deterministic utterance through agent.ask and renders the receipt', async () => {
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
    // SC-5's REPORTING half (WINDOWS 124, WTST-08's remaining half), owner-ratified 2026-08-13:
    // the RENDERED LINE governs. The scripted surface shares the REPL's receipt wording by design
    // (D-01: one turn, two surfaces), so it shares the omission too — fixing one alone would leave
    // a person's scripted run and their conversation disagreeing about what an invocation cost.
    // `Runs consumed: N (previewed up to M)` rides `ClauseReceipt.outcome`; this pins that the
    // field reaches stdout at all, on the deterministic turn.
    //
    // 2026-08-20 (399.1-04): THE LINE MOVED AND THE CLAIM DID NOT. `proposals.list` declares a
    // classifier now — `classify` is a REQUIRED member of `FunctionSpec` as of plan 04 — so the
    // engine's `${functionId} completed` fallback is not what this op reports any more. The op's
    // own one-line map is, and the string below is it for an EMPTY inbox, which is what this
    // fixture workspace has. 2026-10-01 (432-17): `proposals.list` is deleted; `runs.list` is the
    // subject now, and the string is its own map for a workspace with no completed run. It is still a contiguous string the shipped line renders only by
    // printing `outcome`: the functionId and the clause are separate fields, and neither of them
    // is this sentence.
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, ['/fn runs.list'])

    expect(result.stdout).toContain('0 completed run(s)')
  })

  it('(A3) binds a presentation port on the SAME stream its confirm prompts on', async () => {
    // 432-13: no confirm prompts on this stream any more (the door builds none); the presentation
    // port is still bound to stdout, which is the half of this claim that survives.
    //
    // 395-22 · CR-03 · CFGM-05. `composeCliLocalAgent` supplies `createTtyConfirmPort()` whenever
    // this process has two TTYs, so at a terminal this command DOES ask a person to approve gated
    // work — and until this plan it bound no surface to show them what they were approving. Round
    // 4's verification measured the consequence end to end: the complete set of bytes on the
    // terminal before the decision was the approval prompt itself.
    //
    // THE BINDING IS THE CLAIM, MEASURED AT THE SEAM. `ask.ts` cannot decide what a turn is, and it
    // does not: it hands the composition a writer, exactly as `chat.ts:289` does, and everything
    // downstream is the shared composition's. So the cell asserts the argument, and then asserts
    // what the argument DOES — a binding present but inert would pass the first half alone.
    const configPath = fixtureWorkspace(roots)
    await runAsk(configPath, ['/fn runs.list'])

    expect(compositionInputs).toHaveLength(1)
    const chatPresent = compositionInputs[0]?.chatPresent
    expect(typeof chatPresent).toBe('function')

    // AND IT WRITES TO STDOUT, WITH A TRAILING NEWLINE, THROUGH THE MASKER. The stream matters more
    // than the bytes: a render on any other stream is a render the person answering the prompt is
    // not reading, which is the whole content of the 2026-08-14 "reviewable binds at approval time"
    // ruling. `process.stdout.write` is spied rather than `console.log`, because the confirm prompt
    // this must share a stream with writes the same way.
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

  it('D-08: a fail-closed turn reports the clause and exits non-zero', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runAsk(configPath, ['write a test for two factor auth'])

    // Non-zero, because a scripted `ask` whose request was not carried out must not look like
    // success to the shell that called it (the fn.ts error idiom).
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('write a test for two factor auth')
  })

  // ---- 399.1-09 (gap round 1, D-12): one receipt word, one exit code ---------------------------
  //
  // WHAT THE CELL ABOVE COULD NOT SEE. It drives a turn that fail-closes at the TOP level, so
  // `result.status` is `fail_closed` and the first exit gate raises. The gap-1 defect lives on the
  // other road: a clause whose op RETURNED a non-success verdict. The engine set its `failed` flag
  // only in the catch, so a `failed` receipt left the aggregate `completed`, `ask.ts`'s
  // `clause-failed` branch was dead code, and a CI step went green over a turn that carried nothing
  // out. The two cells below are that differential, in this process; the spawned describe after
  // them is the same differential on the artifact a person installs.

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

  it('a refused-only turn keeps the success exit (D-12, door parity with fn)', async () => {
    // A D-12 POSTURE CONTROL, GREEN BEFORE AND AFTER THE FIX. D-11 stops on FAILURE and D-02 ruled
    // a refusal is not one: the op ran and answered a refusal, and the verifier measured
    // the `fn` door exiting 0 on this identical payload. E2E-02 clause 2 makes door DISAGREEMENT the
    // defect class, so moving this door's exit unilaterally would mint a parity break inside the
    // phase that exists to close one. The refusal is surfaced where a person and a script actually
    // read it — the receipt word, the payload beneath it, and `agent.ask`'s own outer verdict.
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

// ---- The same differential on the SHIPPED binary (399.1-09, R5) ---------------------------------
//
// WHY A SEPARATE DESCRIBE WITH ITS OWN INSTRUMENT. The module-level `vi.mock` above taps this
// process's composition root and reaches nothing inside a spawned child, which is the point: an
// exit code is what a CI step actually reads, and a CI step runs `dist/cli.js`. The three cells are
// one spawn each — a RETURNED failure, a THROWN failure and a refusal — so the mapping under test
// is receipt word to exit code, never how the op happened to end.
//
// THE INSTRUMENT IS IMPORTED, NEVER RE-ROLLED (`spawned-chat.ts`'s own no-second-copy law): the
// freshness guard, the hermetic environment and the fixture recipe are that module's, and a second
// answer to "what did the child inherit" is the one thing these cells cannot afford.

describe('agent-qa ask on the shipped binary: one receipt word, one exit code (399.1-09)', () => {
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

  it('keeps the success exit on a refused-only turn (D-12 posture)', async () => {
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
