// The two D-02 anchors: the SHIPPED binary's enumeration, compared with the in-process one.
//
// WHY THE REST OF THIS DIRECTORY NEEDS THIS FILE. Every other leg of the parity suite reads an
// enumeration composed inside the test process — a real `McpServer` built by the shipped factory, a
// real registry, the shipped planner projection and resolver table. That is the right fidelity for a
// matrix that runs on every PR, and it leaves exactly one question unanswerable from inside: whether
// the thing a person actually installs enumerates the same capabilities. A suite that only ever asks
// its own process is a suite whose subject is its own composition. These two cells spawn
// `dist/cli.js` and ask it.
//
// WHAT IS INDEPENDENT ABOUT THE TWO SIDES, STATED HONESTLY (397-02's lens warning). The workspace
// packages resolve through their BUILT dists in both halves, so `agent`, `agent-local`, `mcp` and
// `schema` are the same artifact on both sides of every comparison here. The axis that genuinely
// differs is THIS package's own bundle: the in-process half runs `packages/cli/src`, and the spawned
// half runs `packages/cli/dist/cli.js`, which is that source after tsup has bundled it and after the
// shipped command path — argument parsing, configuration resolution, credential resolution,
// composition root wiring, process lifecycle — has had its say. A divergence in the shipped command
// path is what these cells can see and no other cell in this directory can. What they cannot see is
// a divergence inside a dependency's dist, because both halves read the same file; the freshness
// guard below is what keeps that shared artifact from being a PREVIOUS revision of the source the
// rest of the suite is reasoning about.
//
// THE INSTRUMENT ITSELF LIVES IN `spawned-chat.ts`, AND ONLY THERE. The stale-dist
// freshness guard, the hermetic child environment, the fixture project and the chat driver were all
// defined in this file until phase 399.1 needed the same instrument for its render differential.
// This file's own law about the driver — "a second spawn helper would be a second answer to 'what
// did the child inherit'" — is the reason they were EXTRACTED rather than copied: the sibling file
// imports the same functions this one does, so there is still exactly one answer to that question,
// one freshness reading and one fixture recipe. What stays here is what these two anchors ASSERT.

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

/**
 * The 398-13 answer-channel utterance: the `/fn` passthrough, so stage 1 resolves it.
 *
 * NOTHING ABOUT THIS STRING IS ASSERTED. It is the deterministic route and only that — a braced
 * JSON body the clause splitter keeps as one clause, naming the explain op and a question whose
 * words overlap real catalog rows. No model and no credential are involved, which is what lets a
 * hermetic child answer at all.
 */
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

    const client = new Client({ name: 'agent-qa-397-07-mcp-anchor', version: '0.0.0' })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      const spawnedToolNames = listed.tools.map((tool) => tool.name)

      // THE SHAPE OF THE ANSWER, BEFORE ANY COMPARISON OF IT (397-04's lesson). A transport that
      // died, a command that refused to start or a listing that came back empty would otherwise
      // fold to an empty op-id set — and an empty set compared against an empty set is a green
      // cell that measured a dead process. The startup line is asserted on the captured stderr,
      // which is also the evidence that this process really did start serving.
      expect(
        { tools: spawnedToolNames.length > 0, stderr: captured.trim().slice(0, 400) },
        'the spawned MCP binary listed no tools at all; its stderr is quoted beside this',
      ).toMatchObject({ tools: true })
      expect(captured, 'the spawned MCP host never announced itself on stderr').toContain(
        MCP_STDIO_STARTUP_MESSAGE,
      )

      const spawned = expandMcpListedTools(spawnedToolNames, AGENT_QA_TOOL_PROJECTIONS)
      // stdio has no request bearer. Compare the SAME caller posture.
      // no tool is hidden from a bearer-less caller any more, so the binary lists
      // every projected tool, the credential-required mark door included. 2026-10-02: the
      // in-process side lists under the shipped `MCP_FUNCTION_CALLER` too — the binary's own caller.
      const inProcess = await enumerateMcpOpIds()
      expect([...spawnedToolNames].sort()).toEqual(AGENT_QA_TOOL_PROJECTIONS
        .map(projection => projection.name).sort())

      // D-01's uncatalogued-capability shape, asked of the BINARY. `parity.test.ts` asks it of the
      // in-process server; a tool that only the shipped artifact serves would be invisible there.
      expect(
        spawned.strayTools,
        'the shipped MCP binary listed tools the declared mapping does not catalogue',
      ).toEqual([])

      // ONE FOLD CORE FOR BOTH SIDES, deliberately: a second expansion recipe written here could
      // disagree with the shipped mapping and would then be measuring itself. What makes the two
      // sides independent is the INPUT — two `tools/list` answers from two server instances in two
      // processes, one of them built by tsup out of this package's source — and not the arithmetic
      // applied to them.
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
      // THE CELL THAT WOULD HAVE CAUGHT THE GAP. 398-12 measured the whole of what a grounded
      // explain turn showed a person: the receipt line `agent.explain completed`, and nothing else.
      // Every cell in the phase asserted on the op's RETURN VALUE, which was correct and complete,
      // and none of them asked whether any byte of it reached a terminal. This one spawns the
      // shipped binary, types one turn, and reads the child's stdout.
      //
      // THE VACUITY TRAP, NAMED RATHER THAN AVOIDED BY LUCK. `chat.ts` prints three STARTER PROMPTS
      // at open and each starter is a catalog row's own description — so committed row text is
      // already in this child's stdout before any turn runs. A cell that asked "does some row
      // description appear in stdout" would pass on the unwired build and prove nothing. The search
      // therefore runs over the stdout slice AFTER a marker, and the marker's uniqueness is
      // asserted so the slice cannot be silently widened by a second occurrence.
      //
      // THE MARKER IS THE ECHOED CLAUSE, NOT `<op> completed` (moved 2026-08-20, 399.1-04). It was
      // the receipt line, which the engine printed only while `agent.explain` declared no
      // classifier — plan 04 makes `classify` a REQUIRED member of `FunctionSpec`, the op now
      // reports its own one-line verdict, and that string no longer exists to mark on. This is the
      // idiom `render-anchors.test.ts` already uses for exactly this reason, and it costs the cell
      // nothing it was relying on: the starter prompts are printed at OPEN, before the clause is
      // typed and echoed, so everything after the echo is still the one turn this cell means. The
      // slice is WIDER by one receipt line, and that line is a map — an op id and a verdict, never
      // a catalog row's description — so it cannot be what the search below finds.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
      expect(
        existsSync(CLI_ENTRY),
        `the built CLI entry is missing at ${relative(PACKAGES_ROOT, CLI_ENTRY)}; ${REBUILD_INSTRUCTION}`,
      ).toBe(true)

      const fixture = fixtureProject('398-13-explain-answer')
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

      const fixture = fixtureProject('398-08-manifest')
      const outcome = await spawnAgentManifest(fixture.root, [])

      // THE SHAPE OF THE ANSWER BEFORE ANY COMPARISON OF IT. A command that refused to start, or
      // exited non-zero, would otherwise fold to an unparseable string — and the diagnosis for
      // that is the child's own stderr, quoted here rather than found in a rerun.
      expect(
        { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr.trim().slice(0, 600) },
        'the spawned `init --agent` did not exit cleanly',
      ).toMatchObject({ code: 0, signal: null })

      // THE WHOLE OF STDOUT IS THE DOCUMENT. Not "contains JSON" — parsed outright, because the
      // claim D-16 makes is that this is a machine entry point, and a machine entry point that
      // needs a filter in front of it to parse is a claim with a caveat.
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

      // THE POSTURE IS SHAPE-ASSERTED, NOT BYTE-PINNED, and that is the honest bar: it is a fact
      // about the workspace the binary ran in — a temporary directory here — so pinning its bytes
      // would pin the fixture. What must hold is that the section is WHOLE and reports the shipped
      // default grant rather than a list this cell wrote down. 2026-10-01: that grant
      // is the whole closed scope union — no caller is withheld anything. 2026-10-02:
      // the posture's grant and safe-mode members are deleted, so WHOLE now means exactly the one
      // member that is left, and no retired member rides along.
      expect(Object.keys(manifest.posture), 'the shipped posture still reports a scope grant')
        .not.toContain('defaultScopes')
      expect(manifest.posture.configuration, 'the fixture project\'s config did not resolve')
        .toBe('resolved')
      expect(Object.keys(manifest.posture), 'the shipped posture still has a safe-mode state')
        .toEqual(['configuration'])
    }, 120_000)

  // RE-SPELLED 2026-10-01: the NAME half is retired (no token declaration is read);
  // the never-its-value half is measured unchanged.
  it('the shipped init --agent prints a declared credential\'s NAME and never its value',
    async () => {
      // THE REFS-ONLY LAW, ON THE SURFACE A PERSON ACTUALLY SEES. `manifest.test.ts` proves the
      // value is absent from the OBJECT this process builds; this proves it is absent from the
      // BYTES a shipped process writes — both streams, including any diagnostic nobody
      // anticipated. Those are different claims, and a suite that only made the first one has
      // shipped a leak through the second before (395: the assertion read `error.message` while
      // the live channel was the error's serialization).
      //
      // ON PLANTING A VALUE AT ALL. This file's other fixtures deliberately plant NOTHING, on the
      // reasoning that a value which does not exist cannot be printed. That reasoning is right for
      // an enumeration anchor and is exactly backwards for this one: refs-only is the claim that a
      // value which DOES exist is not printed, and it is unmeasurable without one. The sentinel
      // below is minted here, authenticates nothing anywhere, and travels only in the constructed
      // environment of a child this cell kills.
      expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

      const sentinel = 'sk-398-08-anchor-sentinel-6f21ba9c04d7e358'
      const tokenEnvVar = 'AGENT_QA_398_08_ANCHOR_TOKEN'
      const fixture = fixtureProject('398-08-refs-only', [
        { name: 'ci', tokenEnvVar, scopes: ['read'] },
      ])

      const outcome = await spawnAgentManifest(fixture.root, [], { [tokenEnvVar]: sentinel })

      expect(
        { code: outcome.code, signal: outcome.signal },
        'the spawned `init --agent` did not exit cleanly',
      ).toEqual({ code: 0, signal: null })

      const manifest = AgentManifestSchema.parse(JSON.parse(outcome.stdout) as unknown)

      // the legacy token block is a deleted key, so the project's config
      // does not resolve (the ordinary strict error) and the manifest still answers, whole.
      expect(manifest.posture.configuration, 'a legacy token block must fail strict validation')
        .toBe('unresolved')
      // NO REF IS REPORTED — the legacy token block is read by nothing.
      // The non-vacuity control is the whole document and the echo cell below: the binary ran, the
      // value was readable in its environment, and it printed it nowhere.
      // the posture has no ref member at all now.
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
    // A DETECTOR NOBODY HAS SEEN FIRE IS A COMMENT. Both cells above pass today, which says nothing
    // about whether they COULD fail; this drives the comparator's disagreeing branches with
    // synthetic sets. The stray id carries this plan's number so 397-09's mutation script can tell
    // a deliberate control fixture from a planted one.
    const shared = new Set(['runs.list', 'quarantine.list'])
    const binaryOnly = new Set([...shared, 'control.stray.397.07'])
    const inProcessOnly = new Set([...shared, 'control.absent.397.07'])

    expect(anchorDifference(binaryOnly, inProcessOnly)).toEqual({
      onlyInBinary: ['control.stray.397.07'],
      onlyInProcess: ['control.absent.397.07'],
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
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-397-07-stamp-'))
    trackTempRoot(root)
    const plant = (label: string, toolsetHash: string): string => {
      const project = join(root, label)
      mkdirSync(join(project, '.agent-qa', 'sessions'), { recursive: true })
      writeFileSync(
        join(project, '.agent-qa', 'sessions', `chat-control-397-07-${label}.jsonl`),
        `${JSON.stringify({
          schemaVersion: 1,
          sessionId: `chat-control-397-07-${label}`,
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
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-397-07-freshness-'))
    trackTempRoot(root)

    // (a) No dist at all — the `clean` reading, and the one the plan's must-have names.
    mkdirSync(join(root, 'control-397-07', 'src'), { recursive: true })
    const source = join(root, 'control-397-07', 'src', 'thing.ts')
    writeFileSync(source, 'export const a = 1\n', 'utf8')
    // FIXED STAMPS, never the wall clock: `utimes` rounds toward the second on this platform, and a
    // control whose two timestamps can land in the same second is a control that reports the
    // rounding rather than the rule.
    const at = (seconds: number): Date => new Date(seconds * 1000)
    utimesSync(source, at(2_000_000), at(2_000_000))
    const builds = [{ pkg: 'control-397-07', artifact: join('dist', 'index.js') }]
    expect(buildFreshness(builds, root)).toEqual({
      missing: [join('control-397-07', 'dist', 'index.js')],
      stale: [],
    })

    // (b) A dist that exists and is OLDER than the source it was built from — the trap this guard
    // exists for, and the one a missing-file check cannot see.
    mkdirSync(join(root, 'control-397-07', 'dist'), { recursive: true })
    const artifact = join(root, 'control-397-07', 'dist', 'index.js')
    writeFileSync(artifact, 'export const a = 1\n', 'utf8')
    utimesSync(artifact, at(1_000_000), at(1_000_000))
    expect(buildFreshness(builds, root)).toEqual({
      missing: [],
      stale: [
        `${join('control-397-07', 'src', 'thing.ts')} is newer than `
        + `${join('control-397-07', 'dist', 'index.js')}`,
      ],
    })

    // (c) Rebuilt: the artifact now post-dates its source and the guard says so.
    utimesSync(artifact, at(3_000_000), at(3_000_000))
    expect(buildFreshness(builds, root)).toEqual({ missing: [], stale: [] })

    // (d) A test source is NOT a product source. Touching one after a build must not read as an
    // unbuilt change, or the guard becomes an alarm people learn to silence.
    mkdirSync(join(root, 'control-397-07', 'src', '__tests__'), { recursive: true })
    const testSource = join(root, 'control-397-07', 'src', '__tests__', 'thing.test.ts')
    writeFileSync(testSource, 'export const b = 2\n', 'utf8')
    utimesSync(testSource, at(9_000_000), at(9_000_000))
    expect(buildFreshness(builds, root)).toEqual({ missing: [], stale: [] })
  })
})
