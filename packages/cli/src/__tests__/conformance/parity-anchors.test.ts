// The spawned `dist/cli.js` against the in-process enumeration sees the shipped command path.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join, relative } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { EXPLAIN_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { AGENT_QA_TOOL_PROJECTIONS } from '@vostride/agent-qa-mcp'
import { AgentManifestSchema, catalogRowKey } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadCapabilityCatalog } from '../../capability-catalog/loader.js'
import { createChatCommand } from '../../commands/chat.js'
import { MCP_STDIO_STARTUP_MESSAGE } from '../../commands/mcp.js'
import { enumerateMcpOpIds, expandMcpListedTools } from './adapters.js'
import {
  ANCHORED_BUILDS,
  CHAT_ANCHOR_UTTERANCE,
  CLI_ENTRY,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  driveChatSpawned,
  fixtureProject,
  hermeticEnv,
  spawnCollecting,
  trackTempRoot,
} from './spawned-chat.js'
import type { SpawnOutcome } from './spawned-chat.js'

// ---- The comparator ----------------------------------------------------------------------------

/** Which ids one side of an anchor reached and the other did not — both directions, always. */
export interface AnchorDifference {
  readonly onlyInBinary: readonly string[]
  readonly onlyInProcess: readonly string[]
}

/**
 * The difference between two enumerations, as sorted ids.
 *
 * PURE AND EXPORTED so the control cell below can drive both of its branches with synthetic input.
 * A comparator whose disagreeing branch is only reachable by breaking the product is a comparator
 * nobody has watched disagree, and this whole file exists because an anchor that cannot disagree is
 * decoration.
 *
 * BOTH DIRECTIONS, because the two failures are different defects. Ids only the binary has are
 * capabilities the shipped artifact reaches that the suite never measured; ids only the in-process
 * half has are capabilities the suite has been certifying that no shipped artifact serves.
 */
export function anchorDifference(
  binary: ReadonlySet<string>,
  inProcess: ReadonlySet<string>,
): AnchorDifference {
  return {
    onlyInBinary: [...binary].filter((id) => !inProcess.has(id)).sort(),
    onlyInProcess: [...inProcess].filter((id) => !binary.has(id)).sort(),
  }
}

// ---- Fixtures ----------------------------------------------------------------------------------

afterEach(() => {
  cleanupTempRoots()
})

// ---- The chat comparand ------------------------------------------------------------------------

/**
 * What one chat surface persisted when a conversation opened, as a comparable record.
 *
 * THE COMPARAND IS THE PERSISTED HEADER, and the header's `toolsetHash` is the shipped fingerprint
 * of what the turn engine could reach: `sha256hex16` over the SORTED id set the composed registry
 * lists for the chat caller. Sorting before hashing is what makes it an identity of the SET rather
 * than of a walk, so equality of the two hashes is equality of the two capability sets. Neither half
 * of this cell computes that hash — both sides let the shipped composition write it, which is the
 * only way to compare the recipe rather than a re-spelling of it.
 *
 * `hashShape` exists because `chatToolsetHash` answers the sentinel `'unbound'` for a registry that
 * never finished composing. Two sides that both answered the sentinel would agree perfectly while
 * measuring nothing, and a cell that could pass that way is a cell that will.
 */
export interface ChatAnchorReading {
  readonly sessions: number
  readonly model: string
  readonly toolsetHash: string
  readonly hashShape: 'sha256hex16' | 'unbound-sentinel' | 'unrecognised'
}

function hashShape(value: string): ChatAnchorReading['hashShape'] {
  if (/^[0-9a-f]{16}$/u.test(value)) return 'sha256hex16'
  if (value === 'unbound') return 'unbound-sentinel'
  return 'unrecognised'
}

/** Read whatever chat persisted under a project's runtime root. */
function readChatAnchor(root: string): ChatAnchorReading {
  const sessionsDir = join(root, '.agent-qa', 'sessions')
  const files = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((file) => file.endsWith('.jsonl')).sort()
    : []
  if (files.length !== 1) {
    return { sessions: files.length, model: '', toolsetHash: '', hashShape: 'unrecognised' }
  }
  const [first] = readFileSync(join(sessionsDir, files[0]!), 'utf8').split('\n')
  const header = JSON.parse(first ?? '{}') as { model?: unknown; toolsetHash?: unknown }
  const toolsetHash = typeof header.toolsetHash === 'string' ? header.toolsetHash : ''
  return {
    sessions: files.length,
    model: typeof header.model === 'string' ? header.model : '',
    toolsetHash,
    hashShape: hashShape(toolsetHash),
  }
}

// The `/fn` passthrough resolves at stage 1 without a model; the string itself is not asserted.
const CHAT_EXPLAIN_UTTERANCE = `/fn ${EXPLAIN_FUNCTION_ID} {"query": "how do I start a run"}`

/**
 * Drive the shipped chat command IN THIS PROCESS, over the same scripted-stdin idiom the spawned
 * half uses.
 *
 * THE SAME COMMAND, NOT AN IMITATION OF IT. The in-process half could have composed a host and
 * invoked `agent.ask` directly, and it would then have been comparing the binary against a path
 * nobody ships. Driving `createChatCommand` means the only difference between the two halves is
 * which artifact the command came out of — source here, bundle there — which is precisely the axis
 * this anchor exists to watch.
 */
async function driveChatInProcess(configPath: string): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const previousExitCode = process.exitCode
  process.exitCode = undefined

  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createChatCommand({ input, output }))
    program.exitOverride()
    const parsed = program.parseAsync(['node', 'agent-qa', '--config', configPath, 'chat'])
    // A tick, so a scripted line is never delivered to a readline that does not exist yet — the
    // shipped `chat-command.test.ts` idiom.
    await Promise.resolve()
    input.write(`${CHAT_ANCHOR_UTTERANCE}\n`)
    input.end()
    await parsed
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = previousExitCode
  }
}

/** Drive the SHIPPED binary's `init --agent` against a project directory. */
async function spawnAgentManifest(
  root: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  return await spawnCollecting(root, [CLI_ENTRY, 'init', '--agent', '--dir', root, ...args], extraEnv)
}

/** Run a one-liner in a child with the same constructed environment — the sentinel's own control. */
async function spawnNodeInline(
  root: string,
  source: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  return await spawnCollecting(root, ['-e', source], extraEnv)
}

// ---- The anchors -------------------------------------------------------------------------------

describe('the built-binary anchors', () => {
  it('refuses to measure a build that is missing or older than its source', () => {
    // THE GUARD ITSELF, asserted before either anchor spawns anything, so a stale-build refusal is
    // reported as what it is rather than as an enumeration disagreement forty seconds later. The
    // two anchors below repeat the check inside their own bodies: a guard that only ran in a
    // neighbouring cell would be a guard that a `--testNamePattern` run silently skips.
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  it('the shipped MCP binary lists exactly the op ids the in-process adapter does', async () => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
    // The entry the transport is about to spawn, named separately from the freshness reading above:
    // "there is no such file" and "that file is a revision behind" are different instructions.
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
    ).toBe(true)

    const fixture = fixtureProject('mcp')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, '--config', fixture.configPath, 'mcp'],
      cwd: fixture.root,
      env: hermeticEnv(fixture.root),
      stderr: 'pipe',
    })

    let captured = ''
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    const client = new Client({ name: 'agent-qa-mcp-anchor', version: '0.0.0' })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      const spawnedToolNames = listed.tools.map((tool) => tool.name)

      // The startup line first, so a dead process cannot pass as one empty set equal to another.
      expect(
        { tools: spawnedToolNames.length > 0, stderr: captured.trim().slice(0, 400) },
        'the spawned MCP binary listed no tools at all; its stderr is quoted beside this',
      ).toMatchObject({ tools: true })
      expect(captured, 'the spawned MCP host never announced itself on stderr').toContain(
        MCP_STDIO_STARTUP_MESSAGE,
      )

      const spawned = expandMcpListedTools(spawnedToolNames, AGENT_QA_TOOL_PROJECTIONS)
      // Stdio carries no bearer, so both sides list under the shipped `MCP_FUNCTION_CALLER`.
      const inProcess = await enumerateMcpOpIds()
      expect([...spawnedToolNames].sort()).toEqual(AGENT_QA_TOOL_PROJECTIONS
        .map(projection => projection.name).sort())

      // The uncatalogued-capability check on the binary: a tool only the artifact serves shows.
      expect(
        spawned.strayTools,
        'the shipped MCP binary listed tools the declared mapping does not catalogue',
      ).toEqual([])

      // ONE FOLD CORE FOR BOTH SIDES, deliberately: a second expansion recipe written here could
      // disagree with the shipped mapping and would then be measuring itself. What makes the two
      // sides independent is the INPUT — two `tools/list` answers from two server instances in two
      // processes, one of them built by tsdown out of this package's source — and not the
      // arithmetic applied to them.
      expect(
        anchorDifference(spawned.opIds, inProcess.opIds),
        `the shipped MCP binary and the in-process adapter disagree about which registry ops this `
        + `surface reaches (binary listed ${spawnedToolNames.length} tools)`,
      ).toEqual({ onlyInBinary: [], onlyInProcess: [] })

      // The comparison above is vacuous against two empty sets, and the fold is where a listing
      // becomes ops, so the produced set is asserted non-empty on its own line.
      expect(spawned.opIds.size, 'the fold produced no op ids from the binary listing')
        .toBeGreaterThan(0)
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  }, 120_000)

  it('the shipped chat binary stamps the same toolset a chat session composed here does', async () => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
    ).toBe(true)

    // TWO PROJECTS, because both halves persist into `<project>/.agent-qa/sessions` and one root
    // would leave two sessions in one directory with nothing to attribute them by.
    const spawnedFixture = fixtureProject('chat-binary')
    const inProcessFixture = fixtureProject('chat-in-process')

    const outcome = await driveChatSpawned(spawnedFixture.root, spawnedFixture.configPath)

    // AGAIN THE SHAPE FIRST. A non-zero exit, a signal death or an empty transcript must not reach
    // the comparison as "no session was written"; each of those is its own diagnosis and the
    // child's own stderr is quoted so the reason is in the failure rather than in a rerun.
    expect(
      { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
      'the spawned chat binary did not exit cleanly',
    ).toMatchObject({ code: 0, signal: null })
    // The RECEIPT, not merely the absence of a throw: the deterministic route resolved the clause
    // to a registry op and the shipped surface reported that op by id.
    expect(
      outcome.stdout,
      `the spawned chat binary never reported a capability for "${CHAT_ANCHOR_UTTERANCE}"`,
    ).toContain('quarantine.list')

    await driveChatInProcess(inProcessFixture.configPath)

    const binary = readChatAnchor(spawnedFixture.root)
    const inProcess = readChatAnchor(inProcessFixture.root)

    // THE VACUITY GUARD BEFORE THE EQUALITY. `chatToolsetHash` answers the string `unbound` for a
    // registry that never composed, and two halves that both answered it would agree exactly while
    // proving nothing about any capability.
    //
    // THE SESSION COUNT TRAVELS WITH THE SHAPE, so a refusal names its own cause: a half that
    // persisted nothing at all and a half that persisted an unstamped header are different
    // failures, and "no usable toolset stamp" alone would report the second wording for the first
    // situation.
    expect(
      { side: 'binary', sessions: binary.sessions, shape: binary.hashShape },
      'the shipped chat binary persisted no usable toolset stamp',
    ).toEqual({ side: 'binary', sessions: 1, shape: 'sha256hex16' })
    expect(
      { side: 'in-process', sessions: inProcess.sessions, shape: inProcess.hashShape },
      'the in-process chat session persisted no usable toolset stamp',
    ).toEqual({ side: 'in-process', sessions: 1, shape: 'sha256hex16' })

    // The whole record rather than the hash alone, so a disagreement names the field it is in —
    // a session that was never written, a model the two halves resolved differently, or the
    // capability set itself.
    expect(
      binary,
      'the shipped chat binary and an in-process chat session disagree about what a conversation '
      + 'opened against (the hash is sha256hex16 over the sorted op-id set the composed registry '
      + 'lists for the chat caller, so a difference here is a difference in reachable capabilities)',
    ).toEqual(inProcess)
  }, 180_000)

  it('the shipped chat binary PRINTS a capability line quoted out of the committed catalog',
    async () => {
      // Starter prompts print row text at open, so the search runs only after the echoed clause.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      expect(
        existsSync(CLI_ENTRY),
        `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
      ).toBe(true)

      const fixture = fixtureProject('explain-answer')
      const outcome = await driveChatSpawned(
        fixture.root,
        fixture.configPath,
        CHAT_EXPLAIN_UTTERANCE,
      )

      // THE SHAPE OF THE ANSWER BEFORE ANY SEARCH OF IT. A child that died folds to "no rows
      // quoted", which is a red for the wrong reason wearing this cell's failure message — so the
      // exit code is its own assertion and the child's stderr travels with it.
      expect(
        { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
        'the spawned chat binary did not exit cleanly',
      ).toMatchObject({ code: 0, signal: null })

      const marker = CHAT_EXPLAIN_UTTERANCE
      const markerIndex = outcome.stdout.indexOf(marker)
      expect(
        markerIndex,
        `the spawned chat binary never echoed the clause "${marker}"; its `
        + `stdout was ${JSON.stringify(outcome.stdout.slice(0, 800))} and its stderr `
        + `${JSON.stringify(outcome.stderr.trim().slice(0, 400))}`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        outcome.stdout.lastIndexOf(marker),
        `"${marker}" occurs more than once in the child's stdout, so the post-marker slice this `
        + 'cell searches is not the one turn it means',
      ).toBe(markerIndex)

      // The answer channel's whole territory: everything the person read AFTER the receipt.
      const answerSlice = outcome.stdout.slice(markerIndex + marker.length)

      // THE EXPECTED TEXT IS READ THROUGH THE ONE SHIPPED LOADER, never spelled here — an
      // assertion carrying its own copy of a row's description is an assertion that keeps passing
      // after the artifact it claims to be about has changed.
      const committed = loadCapabilityCatalog()
      const quotedRowIds = committed.rows
        .filter((row) => answerSlice.includes(row.description))
        .map((row) => `${row.kind}:${catalogRowKey(row)}`)

      expect(
        quotedRowIds.length,
        'the spawned chat binary printed NOTHING quoted out of the committed catalog after '
        + `"${marker}" — a grounded or abstention explain answer must reach the person, e.g. as `
        + `the row op:runs.start's own description. rows found: [${quotedRowIds.join(', ')}]; `
        + `post-marker stdout: ${JSON.stringify(answerSlice.slice(0, 800))}; child stderr: `
        + `${JSON.stringify(outcome.stderr.trim().slice(0, 400))}`,
      ).toBeGreaterThan(0)

      // The denominator on the other side, so the search above cannot be vacuous against a catalog
      // that carried no rows to find.
      expect(committed.rows.length, 'the committed catalog carried no rows').toBeGreaterThan(0)
    }, 180_000)

  it('the shipped init --agent manifest is the committed catalog, row for row',
    async () => {
      // WHAT THIS CELL CAN SEE THAT NOTHING IN `manifest.test.ts` CAN. That file drives
      // `buildAgentManifest` in this process, which is the right fidelity for the manifest's own
      // laws and leaves one question unanswerable from inside: whether the thing a person installs,
      // running its own argument parsing and its own bundled command path, hands an agent the same
      // capability set. A cell that passed against a test-composed manifest and never against the
      // shipped artifact would prove nothing about what a user gets.
      //
      // THE STALE-DIST GUARD IS THE FIRST LINE, for this file's standing reason: an anchor spawned
      // against yesterday's build passes and certifies the wrong artifact.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      expect(
        existsSync(CLI_ENTRY),
        `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
      ).toBe(true)

      const fixture = fixtureProject('manifest')
      const outcome = await spawnAgentManifest(fixture.root, [])

      // THE SHAPE OF THE ANSWER BEFORE ANY COMPARISON OF IT. A command that refused to start, or
      // exited non-zero, would otherwise fold to an unparseable string — and the diagnosis for
      // that is the child's own stderr, quoted here rather than found in a rerun.
      expect(
        { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
        'the spawned `init --agent` did not exit cleanly',
      ).toMatchObject({ code: 0, signal: null })

      // The whole of stdout is parsed as the document; a machine entry point needs no filter.
      const parsed = AgentManifestSchema.safeParse(JSON.parse(outcome.stdout) as unknown)
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')),
        'the shipped manifest does not parse against the published contract',
      ).toEqual([])
      if (!parsed.success) return
      const manifest = parsed.data

      const committed = loadCapabilityCatalog()
      expect(
        manifest.rows,
        'the shipped `init --agent` and the committed catalog disagree about the capability rows',
      ).toEqual(committed.rows)

      // The comparison above is vacuous against two empty documents, so its denominator is
      // asserted on its own line.
      expect(manifest.rows.length, 'the shipped manifest carried no rows').toBeGreaterThan(0)

      // Shape-asserted, not byte-pinned: the posture describes the temp workspace, one member.
      expect(Object.keys(manifest.posture), 'the shipped posture still reports a scope grant')
        .not.toContain('defaultScopes')
      expect(manifest.posture.configuration, 'the fixture project\'s config did not resolve')
        .toBe('resolved')
      expect(Object.keys(manifest.posture), 'the shipped posture still has a safe-mode state')
        .toEqual(['configuration'])
    }, 120_000)

  it('the shipped init --agent prints a declared credential\'s NAME and never its value',
    async () => {
      // Refs-only on a shipped process's bytes, both streams, with a sentinel that unlocks nothing.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

      const sentinel = 'sk-anchor-sentinel-6f21ba9c04d7e358'
      const tokenEnvVar = 'AGENT_QA_ANCHOR_TOKEN'
      const fixture = fixtureProject('refs-only', [
        { name: 'ci', tokenEnvVar, scopes: ['read'] },
      ])

      const outcome = await spawnAgentManifest(fixture.root, [], { [tokenEnvVar]: sentinel })

      expect(
        { code: outcome.code, signal: outcome.signal },
        'the spawned `init --agent` did not exit cleanly',
      ).toEqual({ code: 0, signal: null })

      const manifest = AgentManifestSchema.parse(JSON.parse(outcome.stdout) as unknown)

      // The legacy token block is a deleted key, so the config does not resolve; the rest is whole.
      expect(manifest.posture.configuration, 'a legacy token block must fail strict validation')
        .toBe('unresolved')
      // No ref is reported; the whole document and the echo cell are the non-vacuity controls.
      expect(manifest.posture, 'the shipped manifest reported a legacy token declaration')
        .not.toHaveProperty('tokenEnvRefs')
      expect(manifest.rows.length, 'the shipped manifest carried no rows').toBeGreaterThan(0)

      // …and the VALUE is on neither stream. The variable was set in the child's environment, so a
      // path from a declared name to its contents would have had one.
      expect(
        outcome.stdout.includes(sentinel),
        'the shipped manifest printed the token VALUE on stdout',
      ).toBe(false)
      expect(
        outcome.stderr.includes(sentinel),
        'the shipped `init --agent` printed the token VALUE on stderr',
      ).toBe(false)

      // THE CONTROL ON THE CONTROL: the child really could read the sentinel. Without this the two
      // absences above are properties of an unset variable rather than of this product, and the
      // whole cell measures nothing. Driven by asking the same binary to echo its own environment
      // — through a command that is allowed to, rather than by trusting the plumbing.
      const echoed = await spawnNodeInline(
        fixture.root,
        `process.stdout.write(String(process.env[${JSON.stringify(tokenEnvVar)}] ?? ''))`,
        { [tokenEnvVar]: sentinel },
      )
      expect(echoed.stdout, 'the sentinel never reached the child environment').toBe(sentinel)
    }, 120_000)

  it('the anchor comparator names a divergence in both directions', () => {
    // Drives the comparator's disagreeing branches with synthetic sets, so it is seen to fire.
    const shared = new Set(['runs.list', 'quarantine.list'])
    const binaryOnly = new Set([...shared, 'control.stray.anchor'])
    const inProcessOnly = new Set([...shared, 'control.absent.anchor'])

    expect(anchorDifference(binaryOnly, inProcessOnly)).toEqual({
      onlyInBinary: ['control.stray.anchor'],
      onlyInProcess: ['control.absent.anchor'],
    })
    expect(anchorDifference(shared, shared)).toEqual({ onlyInBinary: [], onlyInProcess: [] })
  })

  it('the chat reading distinguishes two different toolset stamps', () => {
    // THE CHAT COMPARAND'S OWN NON-VACUITY, and it needs its own control for a structural reason
    // worth stating: within one workspace both halves of the chat anchor read the SAME built
    // `agent` and `agent-local` dists, and the toolset hash is a function of the registry those
    // dists declare — so no edit to THIS package can make the two hashes differ, and the anchor's
    // hash-difference branch is unreachable from a mutation of the source it actually guards. What
    // that branch WOULD catch is a shipped binary composed against a different build of the
    // function layer, which is exactly what an installed artifact is. It is driven here with two
    // planted headers instead.
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-stamp-'))
    trackTempRoot(root)
    const plant = (label: string, toolsetHash: string): string => {
      const project = join(root, label)
      mkdirSync(join(project, '.agent-qa', 'sessions'), { recursive: true })
      writeFileSync(
        join(project, '.agent-qa', 'sessions', `chat-control-${label}.jsonl`),
        `${JSON.stringify({
          schemaVersion: 1,
          sessionId: `chat-control-${label}`,
          createdAt: '2026-08-16T00:00:00.000Z',
          model: 'unbound',
          toolsetHash,
        })}\n`,
        'utf8',
      )
      return project
    }

    const left = readChatAnchor(plant('left', '0123456789abcdef'))
    const right = readChatAnchor(plant('right', 'fedcba9876543210'))

    expect(left).toEqual({
      sessions: 1,
      model: 'unbound',
      toolsetHash: '0123456789abcdef',
      hashShape: 'sha256hex16',
    })
    // The record comparison the anchor makes, driven over a real difference: same session count,
    // same model, different capability set.
    expect(left).not.toEqual(right)
    // And the sentinel a never-composed registry writes is read as the sentinel rather than as a
    // stamp, which is what stops two unbound halves from agreeing about nothing.
    expect(readChatAnchor(plant('sentinel', 'unbound')).hashShape).toBe('unbound-sentinel')
  })

  it('the freshness guard refuses a missing build and a stale one, by name', () => {
    // BOTH REFUSING BRANCHES, DRIVEN. A synthetic package tree stands in for a real one so the
    // reading is produced by the same function the anchors call rather than described here.
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-freshness-'))
    trackTempRoot(root)

    // (a) No dist at all — the `clean` reading, and the one the plan's must-have names.
    mkdirSync(join(root, 'control', 'src'), { recursive: true })
    const source = join(root, 'control', 'src', 'thing.ts')
    writeFileSync(source, 'export const a = 1\n', 'utf8')
    // FIXED STAMPS, never the wall clock: `utimes` rounds toward the second on this platform, and a
    // control whose two timestamps can land in the same second is a control that reports the
    // rounding rather than the rule.
    const at = (seconds: number): Date => new Date(seconds * 1000)
    utimesSync(source, at(2_000_000), at(2_000_000))
    const builds = [{ pkg: 'control', artifact: join('dist', 'index.js') }]
    expect(buildFreshness(builds, root)).toEqual({
      missing: [join('control', 'dist', 'index.js')],
      stale: [],
    })

    // (b) A dist that exists and is OLDER than the source it was built from — the trap this guard
    // exists for, and the one a missing-file check cannot see.
    mkdirSync(join(root, 'control', 'dist'), { recursive: true })
    const artifact = join(root, 'control', 'dist', 'index.js')
    writeFileSync(artifact, 'export const a = 1\n', 'utf8')
    utimesSync(artifact, at(1_000_000), at(1_000_000))
    expect(buildFreshness(builds, root)).toEqual({
      missing: [],
      stale: [
        `${join('control', 'src', 'thing.ts')} is newer than `
        + `${join('control', 'dist', 'index.js')}`,
      ],
    })

    // (c) Rebuilt: the artifact now post-dates its source and the guard says so.
    utimesSync(artifact, at(3_000_000), at(3_000_000))
    expect(buildFreshness(builds, root)).toEqual({ missing: [], stale: [] })

    // (d) A test source is NOT a product source. Touching one after a build must not read as an
    // unbuilt change, or the guard becomes an alarm people learn to silence.
    mkdirSync(join(root, 'control', 'src', '__tests__'), { recursive: true })
    const testSource = join(root, 'control', 'src', '__tests__', 'thing.test.ts')
    writeFileSync(testSource, 'export const b = 2\n', 'utf8')
    utimesSync(testSource, at(9_000_000), at(9_000_000))
    expect(buildFreshness(builds, root)).toEqual({ missing: [], stale: [] })
  })
})
