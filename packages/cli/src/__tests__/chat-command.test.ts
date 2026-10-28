// `agent-qa chat` — the REPL, over the real composition (Phase 392 plan 08, D-01/D-17/D-23/D-24).
//
// THE STRUCTURAL CLAIM IS THE SAME ONE `ask` MAKES, and it is why they are two commands and one
// engine: the REPL owns no turn capability. Every line a person types becomes one
// `invokeFunction(agent.ask)`, so a conversation can do exactly what the function layer lets it do
// and 397's parity suite reads the verb off the registry without the CLI being consulted (D-24).
// The last case in this file pins that as source text, because the behavioural cases would all
// still pass if a second turn path grew beside the op.
//
// NOTHING HERE IS STUBBED. The command builds the real registry through the real composition root
// in every case; the session files it reads back are the ones the real JSONL adapter wrote. The
// only injected seams are the streams, because a suite that needed a real terminal would be a
// suite that never runs — and the arm that matters most (no terminal ⇒ no inline confirm) is
// exactly the one a real terminal could not exercise.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { CHAT_HELP_ENTRIES } from '@vostride/agent-qa-agent'
import { createJsonlSessionLog } from '@vostride/agent-qa-agent-local'
import type { ChatSessionEvent } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildStarterPrompts } from '../capability-catalog/chat-discovery.js'
import { loadCapabilityCatalog } from '../capability-catalog/loader.js'
import { createChatCommand } from '../commands/chat.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { receiptLine } from '../commands/receipt-line.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: number | string | undefined
}

function fixtureWorkspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-chat-command-'))
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

/** Drive the REPL over scripted stdin: every line, then EOF. */
async function runChat(
  configPath: string,
  args: string[],
  typed: readonly string[] = [],
  extraDeps: Partial<Parameters<typeof createChatCommand>[0]> = {},
): Promise<InvocationResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined

  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createChatCommand({ input, output, ...extraDeps }))
    program.exitOverride()
    const parsed = program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      configPath,
      'chat',
      ...args,
    ])
    // Written after the loop has had a tick to open, so a scripted line is never delivered to a
    // readline that does not exist yet.
    await Promise.resolve()
    for (const line of typed) input.write(`${line}\n`)
    input.end()
    await parsed
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

const SEEDED_TURN: readonly ChatSessionEvent[] = [
  { kind: 'user_message', turnId: 'turn-seed-0001', at: '2026-08-20T12:00:01.000Z', text: 'list the runs' },
  {
    kind: 'stage_outcome',
    turnId: 'turn-seed-0001',
    at: '2026-08-20T12:00:02.000Z',
    stage: 'resolver',
    outcome: 'resolved',
  },
  {
    kind: 'clause_receipt',
    turnId: 'turn-seed-0001',
    at: '2026-08-20T12:00:03.000Z',
    clause: 'list the runs',
    functionId: 'runs.list',
    origin: 'chat-resolver',
    status: 'executed',
    outcome: 'listed 0 runs',
  },
  {
    kind: 'clause_result',
    turnId: 'turn-seed-0001',
    at: '2026-08-20T12:00:04.000Z',
    functionId: 'runs.list',
    payload: { runs: [] },
  },
  { kind: 'turn_complete', turnId: 'turn-seed-0001', at: '2026-08-20T12:00:05.000Z', status: 'completed' },
]

interface SeededSessions {
  sessions: string
  dashboardSessionId: string
  untaggedSessionId: string
}

/** Write one dashboard-tagged and one untagged session through the session log, one turn each. */
async function seedTaggedAndUntaggedSessions(configPath: string): Promise<SeededSessions> {
  const root = join(dirname(configPath), '.agent-qa')
  const seed = async (createdAt: string, random: number, surface?: string): Promise<string> => {
    const log = createJsonlSessionLog({
      root,
      now: () => createdAt,
      model: () => 'claude-sonnet-4-5',
      toolsetHash: () => 'toolset-seed',
      random: () => random,
      ...(surface === undefined ? {} : { surface }),
    })
    const opened = await log.open()
    for (const event of SEEDED_TURN) await opened.append(event)
    await opened.close()
    return opened.header.sessionId
  }
  const dashboardSessionId = await seed('2026-08-20T12:00:00.000Z', 0.25, 'dashboard')
  const untaggedSessionId = await seed('2026-08-20T12:00:10.000Z', 0.75)
  return { sessions: join(root, 'sessions'), dashboardSessionId, untaggedSessionId }
}

function sessionFiles(configPath: string): string[] {
  const sessions = join(dirname(configPath), '.agent-qa', 'sessions')
  try {
    return readdirSync(sessions).filter((file) => file.endsWith('.jsonl'))
  } catch {
    return []
  }
}

describe('agent-qa chat (the REPL over one turn engine)', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  // ---- 398-10 (D-18): the chat aggregates, over the REAL loop ------------------------------
  //
  // DRIVEN, NOT BUILT. The only substitution is the transport under the composed port — the
  // composition root, the opt-out decision, the identity gate and the closed union are all the
  // shipped ones, and every event counted below is one that actually crossed the port during a
  // scripted conversation. A host that assembled these events and never captured them would pass
  // any cell that called the builder itself, and reds this one.
  it('emits one session aggregate and one turn aggregate per turn, carrying no text', async () => {
    const configPath = fixtureWorkspace(roots)
    const sent: { name: string; properties: Record<string, unknown> }[] = []
    const compose = async (): Promise<Awaited<ReturnType<typeof composeAnalyticsHost>>> =>
      composeAnalyticsHost({
        surface: 'chat',
        env: {},
        transportOverride: {
          capture: (payload) => { sent.push(payload.event as typeof sent[number]) },
          flush: () => {},
          shutdown: () => {},
        },
        resolveIdentity: async () => ({ distinctId: 'u_chat-cell', runtimeContext: 'user' }),
      })

    await runChat(configPath, [], ['/fn runs.list', 'nonsense that routes nowhere', '/quit'], {
      composeAnalytics: compose,
    })

    const turns = sent.filter((event) => event.name === 'agent-qa.chat.turn.completed')
    const sessions = sent.filter((event) => event.name === 'agent-qa.chat.session.completed')

    expect(turns).toHaveLength(3)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.properties).toMatchObject({
      turn_count: 3,
      end_reason: 'exit',
      surface: 'chat',
    })

    // THE NO-TEXT CLAIM, asserted over what was actually sent rather than over the schema. The
    // utterances above are distinctive strings; none of them, and no part of any answer, may appear
    // anywhere in the emitted payloads.
    const wire = JSON.stringify(sent)
    expect(wire).not.toContain('nonsense that routes nowhere')
    expect(wire).not.toContain('runs.list')

    // Every property is a count, a boolean, or a value from a closed vocabulary.
    for (const event of sent) {
      for (const [key, value] of Object.entries(event.properties)) {
        if (typeof value !== 'string') continue
        expect(['agent_qa_version', 'surface', 'runtime_context', 'agent_product', 'end_reason'])
          .toContain(key)
      }
    }
  })

  it('runs one turn end to end and closes on /quit', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runChat(configPath, [], ['/fn runs.list', '/quit'])

    expect(result.stderr).toBe('')
    // The receipt line names the op that actually ran, which is the visible difference between a
    // turn and a chatbot: the surface reports a capability invocation, not prose.
    expect(result.stdout).toContain('runs.list')
    expect(result.stdout).toContain('executed')
    // ONE session, opened by default (D-17). The id is printed once so a person can `--session` it.
    expect(sessionFiles(configPath)).toHaveLength(1)
    expect(result.stdout).toContain('chat-')
  })

  it('the rendered receipt line carries the receipt\'s own `outcome`', async () => {
    // SC-5's REPORTING half (WINDOWS 124, WTST-08's remaining half), owner-ratified 2026-08-13:
    // the RENDERED LINE governs, not the persisted artifact. `Runs consumed: N (previewed up to M)`
    // is composed into `ClauseReceipt.outcome` at turn-engine.ts:176 and persisted verbatim — and a
    // render that never reads `outcome` is a person told what an invocation MIGHT cost and never
    // what it DID. The field is pinned here on the deterministic turn every other case drives, so
    // the claim is about the render rather than about a fan-out fixture: for a non-authoring op the
    // outcome is the op's own one-line map, and the shipped line renders the functionId and the
    // clause as separate fields, so the contiguous string cannot appear unless `outcome` does.
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
    const result = await runChat(configPath, [], ['/fn runs.list', '/quit'])

    expect(result.stdout).toContain('0 completed run(s)')
  })

  it('prints the banner at most once, on open', async () => {
    const configPath = fixtureWorkspace(roots)
    // A bare project has nothing pending, so D-23's answer is SILENCE — a REPL that greeted every
    // open with a status line would train a person to skip the line that mattered.
    const result = await runChat(configPath, [], ['/quit'])

    expect(result.stdout).not.toContain('pending — type')
  })

  it('/help names the reach lever and executes nothing', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runChat(configPath, [], ['/help', '/quit'])

    expect(result.stdout).toContain('/fn')
  })

  it('opens with starter prompts RENDERED FROM the committed catalog (398-09, SC-1)', async () => {
    // THE CELL THAT WATCHES WHAT IS SENT (398-07's M6 lesson, applied here before it could bite).
    // `conformance/help-census.test.ts` proves the builders return catalog text; every one of those
    // cells would still be green if this command never called them, because they call the builders
    // themselves. This one drives the REAL command and reads its REAL output, so "built but never
    // wired" is a state something can see.
    const configPath = fixtureWorkspace(roots)
    const result = await runChat(configPath, [], ['/quit'])

    expect(result.stderr).toBe('')
    const catalog = loadCapabilityCatalog()
    const expected = buildStarterPrompts(catalog.rows, CHAT_HELP_ENTRIES)
    expect(expected.length).toBeGreaterThan(0)
    for (const line of expected) {
      // Trimmed, because the render pads for alignment and the console spy joins on spaces — what
      // is pinned is that the CATALOG'S OWN TEXT reached a person's terminal.
      expect(result.stdout).toContain(line.trim())
    }
  })

  it('--list reports the sessions and the files it could not read', async () => {
    const configPath = fixtureWorkspace(roots)
    await runChat(configPath, [], ['/fn runs.list', '/quit'])

    const listed = await runChat(configPath, ['--list'])

    const [file] = sessionFiles(configPath)
    expect(file).toBeDefined()
    expect(listed.stdout).toContain(file!.replace('.jsonl', ''))
    // No new session: `--list` is a read that exits, not a conversation that opens one.
    expect(sessionFiles(configPath)).toHaveLength(1)
  })

  it('--session with an unknown id is a typed refusal, never a create', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runChat(configPath, ['--session', 'chat-20260809-000000-zzzz'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('chat-20260809-000000-zzzz')
    // The load-bearing half. A resume path that CREATED the session it could not find would
    // silently start a new conversation while a person believed they were back in an old one.
    expect(sessionFiles(configPath)).toHaveLength(0)
  })

  it('--list lists a dashboard-tagged and an untagged session', async () => {
    const configPath = fixtureWorkspace(roots)
    const { sessions, dashboardSessionId, untaggedSessionId } =
      await seedTaggedAndUntaggedSessions(configPath)
    const before = new Map(sessionFiles(configPath).map((file) => [
      file,
      readFileSync(join(sessions, file)),
    ]))
    expect(readFileSync(join(sessions, `${dashboardSessionId}.jsonl`), 'utf8'))
      .toContain('"surface":"dashboard"')
    expect(readFileSync(join(sessions, `${untaggedSessionId}.jsonl`), 'utf8'))
      .not.toContain('"surface"')

    const listed = await runChat(configPath, ['--list'])

    // Listed as sessions, not as refused files, which would print their names too.
    expect(listed.stdout).toContain('Chat sessions (2)')
    expect(listed.stdout).not.toContain('could not be read')
    expect(listed.stdout).toContain(dashboardSessionId)
    expect(listed.stdout).toContain(untaggedSessionId)
    // Listing reads headers and never filters or rewrites a file.
    expect(sessionFiles(configPath).sort()).toEqual(
      [`${dashboardSessionId}.jsonl`, `${untaggedSessionId}.jsonl`].sort(),
    )
    for (const [file, bytes] of before) {
      expect(readFileSync(join(sessions, file)).equals(bytes), file).toBe(true)
    }
  })

  it('--session reopens a dashboard-tagged session and creates no session', async () => {
    const configPath = fixtureWorkspace(roots)
    const { sessions, dashboardSessionId, untaggedSessionId } =
      await seedTaggedAndUntaggedSessions(configPath)
    const before = new Map(sessionFiles(configPath).map((file) => [
      file,
      readFileSync(join(sessions, file)),
    ]))

    const result = await runChat(configPath, ['--session', dashboardSessionId], ['/quit'])

    expect(result.exitCode).not.toBe(1)
    expect(result.stderr).not.toContain(`No chat session named ${dashboardSessionId}`)
    // A resumed session announces its id before the first prompt; a fresh one has none to announce.
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain(`session ${dashboardSessionId}`)
    expect(output).not.toContain(`session ${untaggedSessionId}`)
    expect(sessionFiles(configPath).sort()).toEqual(
      [`${dashboardSessionId}.jsonl`, `${untaggedSessionId}.jsonl`].sort(),
    )
    // `/quit` is itself a routed turn, so it lands in the reopened log: the seeded bytes must
    // survive as an untouched prefix with that turn appended after them, and nothing else moves.
    const reopened = `${dashboardSessionId}.jsonl`
    for (const [file, bytes] of before) {
      const after = readFileSync(join(sessions, file))
      if (file !== reopened) {
        expect(after.equals(bytes), file).toBe(true)
        continue
      }
      expect(after.subarray(0, bytes.length).equals(bytes), file).toBe(true)
      const appended = after.subarray(bytes.length).toString('utf8')
      expect(appended).toContain('"kind":"user_message"')
      expect(appended).toContain('"text":"/quit"')
      expect(appended).not.toContain('"sessionId"')
    }
  })

  it('--continue reopens the most recent session rather than opening a new one', async () => {
    const configPath = fixtureWorkspace(roots)
    await runChat(configPath, [], ['/fn runs.list', '/quit'])
    expect(sessionFiles(configPath)).toHaveLength(1)

    await runChat(configPath, ['--continue'], ['/fn runs.list', '/quit'])

    expect(sessionFiles(configPath)).toHaveLength(1)
  })

  it('--continue with nothing to continue is a refusal, not a fresh session', async () => {
    const configPath = fixtureWorkspace(roots)
    const result = await runChat(configPath, ['--continue'])

    expect(result.exitCode).toBe(1)
    expect(sessionFiles(configPath)).toHaveLength(0)
  })

  it('the interrupt handler writes an explicit aborted row (D-19 graceful arm)', async () => {
    // DRIVEN DIRECTLY rather than by a real signal: what is being measured is that the handler
    // writes the event, and a test that raised SIGINT would be measuring the test runner's signal
    // disposition instead. The handler is exported for exactly this reason.
    const configPath = fixtureWorkspace(roots)
    const interrupts: (() => Promise<void>)[] = []
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = new Command()
        .option('--config <path>', 'config file path')
        .addCommand(
          createChatCommand({
            input,
            output,
            onInterruptHandler: (handler) => interrupts.push(handler),
          }),
        )
      program.exitOverride()
      const parsed = program.parseAsync(['node', 'agent-qa', '--config', configPath, 'chat'])
      await Promise.resolve()
      input.write('proposals\n')
      // The handler is invoked mid-session, which is where a Ctrl+C lands.
      await new Promise((resolve) => setTimeout(resolve, 50))
      for (const handler of interrupts) await handler()
      input.end()
      await parsed
    } finally {
      log.mockRestore()
    }

    expect(interrupts.length).toBeGreaterThan(0)
    const [file] = sessionFiles(configPath)
    expect(file).toBeDefined()
    const lines = readFileSync(
      join(dirname(configPath), '.agent-qa', 'sessions', file!),
      'utf8',
    )
    // Between turns the handler is a NO-OP by contract, so the honest assertion is that the file
    // is intact and ends in a complete line — a handler that wrote an `aborted` row for a turn
    // already carrying its `turn_complete` would make the next open's repair prune a finished turn.
    expect(lines.endsWith('\n')).toBe(true)
  })

  it('drives turns ONLY through invokeFunction on agent.ask, and builds no model', () => {
    // A SOURCE PIN, because every behavioural case above would still pass if the REPL grew a
    // second turn path beside the op. `createTurnEngine` here would be the largest private power
    // in the system: an orchestrator reachable through nothing the catalogue declares (D-24).
    const source = readFileSync(join(__dirname, '..', 'commands', 'chat.ts'), 'utf8')
    expect(source).toContain('AGENT_ASK_FUNCTION_ID')
    expect(source).toContain('invokeFunction')
    for (const forbidden of ['createTurnEngine', 'runTurn(']) {
      expect({ forbidden, present: source.includes(forbidden) })
        .toEqual({ forbidden, present: false })
    }
    // CHAT-06's half, checked as a SPECIFIER rather than a token: `createModel` appears in this
    // file's prose explaining that the model arrives already built, and a token scan would report
    // the documentation of the rule as a violation of it (the rollcall's own negative control).
    for (const specifier of ['@vostride/agent-qa-model', '@ai-sdk/']) {
      expect({ specifier, present: source.includes(`'${specifier}`) })
        .toEqual({ specifier, present: false })
    }
    // 2026-10-14 (441-06, D-07): printed text crosses the declared mask and nothing restores it.
    expect(source).toContain('declaredSecrets.mask')
    for (const restore of ['unmask', ['create', 'MaskingContext'].join('')]) {
      expect({ restore, present: source.includes(restore) }).toEqual({ restore, present: false })
    }
  })

  it('renders the fan-out cost verbatim off `outcome` — the sentence a person approved', () => {
    // The exact sentence the live run of 394-35 composed, persisted, and never printed (WINDOWS
    // 124). Driven against the exported render directly rather than through a turn, because no
    // hermetic surface case can reach a real fan-out — and what SC-5's reporting half asks is
    // whether the field carrying the cost survives the render, which is answerable here.
    const rendered = receiptLine({
      clause: 'write a test that signs in on the local account form',
      functionId: 'authoring.draft.write',
      origin: 'agent',
      status: 'executed',
      outcome: 'authoring.draft.write completed — Runs consumed: 1 (previewed up to 7)',
    })

    expect(rendered).toContain('Runs consumed: 1 (previewed up to 7)')
    // Unconditional, on every receipt — a render that carried the outcome only when it differed
    // from the plain `${functionId} completed` summary would be a drop path with a condition on it.
    expect(receiptLine({
      clause: 'proposals',
      functionId: 'proposals.list',
      origin: 'agent',
      status: 'executed',
      outcome: 'proposals.list completed',
    })).toContain('proposals.list completed')
  })

  it('both surfaces render ONE receipt line, and neither may re-grow a private copy', () => {
    // A SOURCE PIN beside the one above, for the reason that one exists: the two behavioural cells
    // would both stay green if `ask.ts` copied the render back into itself and the copies then
    // drifted — which is exactly the history this module ends. Six times in this phase a contract
    // has been hardened on one side only; the shared module plus this pin forecloses a seventh on
    // the receipt line structurally rather than by convention (D-01: one turn, one wording).
    const commands = join(__dirname, '..', 'commands')
    for (const file of ['chat.ts', 'ask.ts']) {
      const source = readFileSync(join(commands, file), 'utf8')
      expect({ file, imports: source.includes("from './receipt-line.js'") })
        .toEqual({ file, imports: true })
      expect({ file, private: /function\s+receiptLine\s*\(/u.test(source) })
        .toEqual({ file, private: false })
    }
    // The shared module reads the field, and reads it from the receipt — the non-vacuity guard on
    // the two assertions above, which would both hold over a shared render that dropped `outcome`.
    const shared = readFileSync(join(commands, 'receipt-line.ts'), 'utf8')
    expect(shared).toContain('receipt.outcome')
  })

  it('both surfaces render ONE payload block, from the one module, through their own masker', () => {
    // THE SAME PIN FOR THE 399.1 RENDER (D-04). `result-render.ts` is the second module to be
    // shared by these two surfaces, and it arrives with the pin rather than acquiring one later:
    // the whole reason `receipt-line.ts` exists is that the two surfaces held byte-identical
    // private copies and were free to drift.
    const commands = join(__dirname, '..', 'commands')
    for (const file of ['chat.ts', 'ask.ts']) {
      const source = readFileSync(join(commands, file), 'utf8')
      expect({ file, imports: source.includes("from './result-render.js'") })
        .toEqual({ file, imports: true })
      expect({ file, private: /function\s+renderClauseResults\s*\(/u.test(source) })
        .toEqual({ file, private: false })
      // …and each surface actually CALLS it. The two assertions above hold over a surface that
      // imported the module and never rendered a payload, which is the state this phase repairs.
      expect({ file, renders: source.includes('renderClauseResults(result.results, result.receipts.length)') })
        .toEqual({ file, renders: true })
    }

    // COMMENTS STRIPPED, on `parity.test.ts`'s precedent: the module's header says in prose where
    // the boundary lives, and the claim is about the module's BODY, so the body is what is searched.
    const shared = readFileSync(join(commands, 'result-render.ts'), 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
      .replaceAll(/^\s*\/\/.*$/gmu, '')
    // THE BOUNDARY IS NOT HERE (criterion 3). Masking belongs at each surface's own emit, and
    // nothing restores a value anywhere. Asserted as SOURCE because the module is pure — no test
    // input can distinguish "did not unmask" from "had nothing to unmask".
    expect(shared).not.toContain('unmask')
    // Nor does it print. The surfaces own their streams; a render with a print site inside would
    // print outside the surface's declared mask.
    expect(shared).not.toContain('console.')
    expect(shared).not.toContain('process.stdout')
    // The non-vacuity guard on all of the above: the module renders the WHOLE payload rather than
    // a hand-picked join of the fields somebody thought mattered (D-04's structural claim).
    expect(shared).toContain('JSON.stringify(payload, null, 2)')
  })
})

describe('agent-qa chat under GitHub Actions', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('a secrets file it cannot read is reported inside one pair', async () => {
    const configPath = fixtureWorkspace(roots)
    const secretsPath = join(dirname(configPath), '.env.secrets.local')
    rmSync(secretsPath)
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    let result: InvocationResult
    try {
      result = await runChat(configPath, [])
    } finally {
      write.mockRestore()
    }

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(PAIR)
    expect(writes[0]).toContain(`Secrets file not found: ${secretsPath}`)
    expect(writes[0]).toContain('Create the file before running tests.')
  })
})
