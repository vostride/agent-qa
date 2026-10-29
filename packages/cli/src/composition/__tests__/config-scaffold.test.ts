// Scaffold from zero, through the REAL producer, on a real repository (395-08 · CFGM-05 · D-04/
// D-13/D-14/D-15).
//
// 2026-09-30, 432-11 D-05/D-07/D-14: THE SCAFFOLD WRITES IN THE CALL through the real direct writer:
// no proposal, no confirm, no commit. The cells below that pinned the proposal, the confirm and the
// one-commit apply are re-spelled in place to the direct write — the goldens are the answer's own
// `shownDiff`, the bytes are read off disk, and the commit count does not move.
//
// 2026-10-01, 432-16 D-07: no host binds a config apply port or an undo source any more, so the
// `config.proposal.apply` from-zero arm (14)-(14b) refuses a pre-432 scaffold record by name and
// writes and commits nothing, and the undo (11) answers unbound.
//
// THE PRODUCER IS PRODUCTION'S. `createScaffoldContentPort` is the same factory
// `composeCliLocalAgent` binds, over `commands/scaffold-content.ts` — the one module `agent-qa init`
// renders its own scaffold from. So what these cells pin is what a person actually gets, and D-04's
// no-drift claim is measured rather than asserted: there is no second content path for a golden to
// be taken over.
//
// THE GOLDENS ARE BYTES, COMMITTED, FOR TWO DIFFERENT DOMAINS. `__fixtures__/scaffold-*.diff` hold
// the exact `shownDiffBase64` bytes the pipeline rendered, produced BY THE REAL OP and reviewed at
// authoring time. Two domains rather than one is the acceptance bar, not thoroughness: a cell
// asserting one exact booking.com diff passes under an implementation that hard-codes booking.com,
// and the second golden is the case that implementation cannot produce. Regenerate deliberately
// with `SCAFFOLD_GOLDEN=write`, and read the diff before committing it — a golden updated without
// being read is a pin that has stopped pinning.
//
// WHAT MAKES EACH CELL RED:
//
//   (1) enumeration    — a config-set enumeration that answered differently for a project with no
//                        config file, or an apply whose pathspec disagreed with it. Both halves are
//                        read out of the SHIPPED `enumerateConfigFileSet` and out of git's own
//                        account of the commit, so neither side is this file's opinion.
//   (2) the golden     — ANY change to the derived scaffold's bytes, including one made in `init`'s
//                        half of the shared module. That is the point: the two write paths share a
//                        producer, so a drift in either is a red here.
//   (3) two domains    — an implementation that hard-codes a site. Same producer, same assertions,
//                        a golden it cannot emit.
//   (4) APPLYABLE      — the WINDOWS-129 shape: an op whose derived artifact cannot pass the
//                        pipeline's own whole-config validation has no success path at all, and the
//                        only way to find that out is to assert the arm. The config bytes are ALSO
//                        parsed through the shipped `AgentQaConfigSchema` here, so a proposal that
//                        was applyable because validation was skipped fails too.
//   (5) the commit     — an apply that wrote something other than the payload's bytes, or that
//                        committed more paths than the proposal names. Byte-compared against the
//                        record read back OFF DISK.
//   (6) the upsert     — a scaffold that overwrote a project's existing `.gitignore` instead of
//                        appending the managed block to it. The seeded file's own rule is asserted
//                        still present, which is the half a "the block is there" cell would miss.
//   (7) the confirm    — D-14's pause. The confirm port is a SPY and the cell asserts it was
//                        CALLED, because a turn that never reached a confirm also completes.
//   (8) fail closed    — a non-TTY caller. The same accept with no confirm bound must not commit.
//  (13) the MERGE      — 395-12: an `already-configured` predicate keyed on a config file EXISTING
//                        rather than on a configuration this scaffold would overwrite. The fixture
//                        declares an LLM, carries comments, and declares ZERO targets — the only
//                        project class that can reach a chat turn at all — so a file-keyed
//                        predicate reds here with `refused / already-configured`. Its second half
//                        is the merge itself: the emitted config is the person's own bytes with
//                        exactly one target entry inserted, asserted by REMOVING the inserted text
//                        and byte-comparing what is left against the committed file.
// (13b) hooks left be  — a merge that composed the scaffold's hooks template over a hooks file a
//                        person already wrote. That is the same wholesale overwrite
//                        `already-configured` refuses for the config yaml, one file over.
//
// 432-05 (D-19, D-20 · PXH-SAFE-03) adds three named families over the same real ports:
//
//   C432-SCAFFOLD-LLMS          — #130: a scaffold that drops `registry.llms` or `use.llm`, on either
//                                 the from-zero producer or the zero-target merge, or that "repairs"
//                                 an inconsistent selection instead of letting validation refuse it.
//   C432-LOCALHOST-ORIGIN       — #134: the local demo app's own address, scaffolded from zero, with
//                                 its http scheme and port kept and the config valid.
//   C432-TARGET-CREATE-ENVIRONMENT — a create whose class does not reach the committed file, or one
//                                 that overwrites an existing target.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import * as dashboard from '@vostride/agent-qa-dashboard'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  base64Decode,
  enumerateConfigFileSet,
  utf8Decode,
} from '@vostride/agent-qa-schema'
import type {
  ConfigChangeOutput,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { parseDocument, parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
  createConfigFilesPort,
  createConfigValidatePort,
  createConfigWritePort,
  createScaffoldContentPort,
} from '../local-agent-host.js'
import { filePre432ConfigProposal } from './pre-432-config-proposal.js'
import * as host from '../local-agent-host.js'
import { buildScaffoldFileSet } from '../../commands/scaffold-content.js'

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const CONFIG_FILE = 'agent-qa.config.yaml'

/** The project's OWN gitignore rule, seeded so the upsert has something to compose with. */
const SEEDED_GITIGNORE = '# the project\'s own rules\ndist/\n.agent-qa/\n'

/**
 * A configuration that declares an LLM, carries comments, and declares NO TARGETS (395-12).
 *
 * THIS IS THE CLASS SC-5 HAS TO SERVE, and it is measured rather than imagined:
 * `resolveCliChatCapabilities` reads the chat model out of `registry.llms`, so a project that can
 * hold a conversation at all is a project that HAS a config file. WINDOWS 132's jaw 2 is that the
 * scaffold refused exactly those projects — the ones able to reach it — because `already-configured`
 * was keyed on the file existing rather than on a configuration this scaffold would overwrite.
 *
 * IT ROUND-TRIPS BYTE-IDENTICALLY THROUGH `parseDocument` → `toString`, and cell (13) asserts that
 * FIRST. The comment-preserving edit re-emits some constructs with canonical spacing, so a fixture
 * that did not round-trip would fail the byte-preservation assertion below for a reason that has
 * nothing to do with the merge. Asserting the identity round-trip separately is what separates the
 * serializer's fidelity — which every `config.field.set` already rides — from this plan's own
 * claim, which is that the merge inserts one entry and moves no other byte.
 */
const ZERO_TARGET_CONFIG = `# my own agent-qa configuration

workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

# The model this project chats with. Without it there is no planner, and without a
# planner the write_test route never fires at all.
registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  mobile:
    appState: preserve
  parallel: false
`

/** The target entry the merge inserts, as the exact text it occupies in the emitted document. */
const INSERTED_TARGET_ENTRY
  = '  targets:\n    booking-com:\n      platform: web\n      url: https://booking.com\n'

/** A hooks file a person wrote themselves — valid, and NOT the scaffold's template. */
const SEEDED_HOOKS = '# the project\'s own hooks\nhooks: []\n'

let root: string
let configPath: string
let agentQaRoot: string
let confirms: number

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // 395-24 · WR-12 — a `git` that ran and failed must not return quietly; see
    // validate-resolution-surface.test.ts for the full note.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim())
}

/**
 * The golden, compared or written.
 *
 * WRITTEN ONLY UNDER AN EXPLICIT ENVIRONMENT FLAG. A golden that regenerates itself on mismatch is
 * not a pin; it is a record of the last thing that happened.
 */
function golden(name: string, actual: string): void {
  const path = join(FIXTURES, name)
  if (process.env.SCAFFOLD_GOLDEN === 'write') {
    mkdirSync(FIXTURES, { recursive: true })
    writeFileSync(path, actual)
    return
  }
  expect(existsSync(path), `golden ${name} is missing — regenerate with SCAFFOLD_GOLDEN=write`)
    .toBe(true)
  expect(actual).toBe(readFileSync(path, 'utf8'))
}

// 2026-10-01 (432-17): the proposals store, its inbox and the config proposal filer are deleted, so
// this registry binds neither.
function registryFor(options: { readonly confirm?: boolean } = {}) {
  const deps: FunctionDeps = {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: CONFIG_FILE,
        entries: [],
      }),
    },
    configFiles: createConfigFilesPort(configPath),
    configValidate: createConfigValidatePort(),
    // 432-16 (D-07): no config apply port and no undo source — the production host binds neither.
    // THE REAL PRODUCER. Not a double, and not a copy — the factory the CLI composition binds.
    scaffoldContent: createScaffoldContentPort(),
    // 432-11: THE REAL DIRECT WRITER the scaffold publishes through.
    configWrite: createConfigWritePort(configPath, (text) => text),
  }

  return createFunctionRegistry({
    deps,
    // A SPY, so "the confirm was reached" is a measurement rather than an inference from the turn
    // having completed (D-14). Omitted entirely for the fail-closed cell.
    ...(options.confirm === undefined
      ? {}
      : {
        confirm: {
          surface: 'tty-prompt' as const,
          ask: () => {
            confirms += 1
            return options.confirm as boolean
          },
        },
      }),
  })
}

async function scaffold(
  registry: ReturnType<typeof registryFor>,
  domain: string,
): Promise<ConfigChangeOutput> {
  return await invokeFunction(
    registry, 'config.project.scaffold', { domain }, HUMAN,
  ) as ConfigChangeOutput
}

/** The applied answer, or the answer itself in the failure message. */
function applied(answer: ConfigChangeOutput): Extract<ConfigChangeOutput, { outcome: 'applied' }> {
  if (answer.outcome !== 'applied') {
    throw new Error(`expected a direct write, got ${JSON.stringify(answer)}`)
  }
  return answer
}

/** The config as the scaffold wrote it, parsed off disk. */
function writtenConfig(): ParsedConfig {
  return parseYaml(readFileSync(configPath, 'utf8')) as ParsedConfig
}

/**
 * THE SECOND LAYOUT for the CREATE direction: configDir is not the repository root (395-11).
 *
 * The undo's half of this axis is `config-apply-discipline.test.ts` cells 15-17; this is the same
 * blind spot on the other side of the same pipeline. Every fixture in this file used one temp
 * directory as both git root and config dir, so a scaffold that answered in the wrong path
 * vocabulary would have written to the same place either way and no cell could tell.
 *
 * `sub/dir/.gitignore` IS SEEDED AND COMMITTED, because the pinned set is resolved relative to the
 * CONFIG directory: the project's `.gitignore` for this layout is the one beside the config, and a
 * fixture that seeded only the root's would be measuring the upsert against a file the scaffold
 * never reads.
 */
function relocateToSubdir(): string {
  const configDir = join(root, 'sub', 'dir')
  mkdirSync(configDir, { recursive: true })
  configPath = join(configDir, CONFIG_FILE)
  agentQaRoot = join(configDir, '.agent-qa')
  writeFileSync(join(configDir, '.gitignore'), SEEDED_GITIGNORE)
  git('add', '--', 'sub/dir/.gitignore')
  git('commit', '--quiet', '-m', 'seed the subdirectory that will hold the configuration')
  return configDir
}

/**
 * Commit a configuration that declares an LLM and no targets (395-12), plus an optional hooks file.
 *
 * COMMITTED, never merely written. `config.project.scaffold` re-reads the committed set at proposal
 * time (CFGM-04) and the apply's porcelain check is scoped to that same set, so a fixture that left
 * the config dirty would be measuring D-05's two-commit human-first road instead of the merge.
 */
function seedZeroTargetConfig(options: { readonly hooks?: string } = {}): void {
  writeFileSync(configPath, ZERO_TARGET_CONFIG)
  const paths = [CONFIG_FILE]
  if (options.hooks !== undefined) {
    writeFileSync(join(root, 'hooks.yaml'), options.hooks)
    paths.push('hooks.yaml')
  }
  git('add', '--', ...paths)
  git('commit', '--quiet', '-m', 'the project configures a model and no targets')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-scaffold-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  confirms = 0

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa scaffold test')
  git('config', 'user.email', 'scaffold-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  // A project with source and a gitignore of its own — and NO agent-qa configuration. That absence
  // is the whole fixture: CFGM-05's sentence is about the from-zero case.
  writeFileSync(join(root, '.gitignore'), SEEDED_GITIGNORE)
  writeFileSync(join(root, 'README.md'), 'a project that has never run agent-qa\n')
  git('add', '--', '.gitignore', 'README.md')
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the pinned config set answers for a project that has no config file', () => {
  it('(1) enumerates three members, and the scaffold writes exactly those it touches', async () => {
    // THE SHIPPED ENUMERATION, ASKED DIRECTLY. A project with no config file names no hooks file
    // either, so the answer comes from the default — which is the enumeration's own business and
    // not this test's. Read back rather than typed, so a member added later reds here first.
    expect(enumerateConfigFileSet({ configFile: CONFIG_FILE }))
      .toEqual(['.gitignore', CONFIG_FILE, 'hooks.yaml'])

    const before = commitCount()
    const answer = applied(await scaffold(registryFor(), 'booking.com'))

    // The written file set IS the enumeration. A scaffold that wrote a fourth file would be
    // flagged `out-of-set-path` and would be writing outside the pinned set.
    expect([...answer.files].sort())
      .toEqual([...enumerateConfigFileSet({ configFile: CONFIG_FILE })])
    for (const path of answer.files) expect(existsSync(join(root, path)), path).toBe(true)

    // NO COMMIT (D-07): the three files are plain edits git shows as changed and new.
    expect(commitCount()).toBe(before)
    expect(git('status', '--porcelain').stdout.split('\n').filter(Boolean).sort())
      .toEqual([' M .gitignore', `?? ${CONFIG_FILE}`, '?? hooks.yaml'])
  })
})

describe('the derivation is byte-pinned through the real producer', () => {
  for (const row of [
    { domain: 'booking.com', targetName: 'booking-com', golden: 'scaffold-booking-com.diff' },
    {
      domain: 'shop.example.co.uk',
      targetName: 'shop-example-co-uk',
      golden: 'scaffold-shop-example-co-uk.diff',
    },
  ]) {
    it(`(2/3) ${row.domain} → exactly the committed golden bytes`, async () => {
      // (4) APPLIED. `applied` throws with the blocked answer's own report otherwise, so a scaffold
      // whose derived config the shipped schema refuses fails here naming the reason.
      const answer = applied(await scaffold(registryFor(), row.domain))

      // THE GOLDEN. Every byte of the rendered diff — the config yaml, the hooks file and the
      // gitignore upsert — compared against a file produced by this same op and reviewed.
      golden(row.golden, answer.shownDiff)

      // And the derived facts are IN those bytes, stated separately so a golden somebody
      // regenerated without reading still has to carry the derivation.
      const shown = answer.shownDiff
      expect(shown).toContain(`url: https://${row.domain}`)
      expect(shown).toContain(`    ${row.targetName}:`)
      // NO AUTH BINDING ON THE TARGET, and no auth plugin declaration. The utterance carried a
      // domain and nothing else, and D-13 says the derivation adds nothing it was not given. Stated
      // over the PARSED target entry rather than over the diff text, because the scaffolded config
      // legitimately carries `services.authState.dir` — a directory setting, not a credential
      // binding — and an absence assertion over the whole text would have been wrong about which
      // fact it was making. The presence half is the keyset itself: exactly `platform` and `url`.
      const derived = parseYaml(readFileSync(configPath, 'utf8')) as {
        registry?: { targets?: Record<string, Record<string, unknown>> }
        plugins?: unknown
      }
      expect(Object.keys(derived.registry?.targets?.[row.targetName] ?? {}).sort())
        .toEqual(['platform', 'url'])
      expect(derived.plugins).toBeUndefined()
      expect(answer.summaryLine)
        .toBe(`configure this project for https://${row.domain} as target ${row.targetName}`)

      // ALWAYS CROSS-BOUNDARY (D-14/D-02) — computed by the classifier, reported on the receipt.
      expect(answer.crossBoundary).toBe(true)
      expect(answer.crossBoundaryReasons).toContain('new-origin')
    })
  }

  it('(4) the derived config parses through the SHIPPED AgentQaConfigSchema', async () => {
    // The half `applied` alone would not give: this reads the bytes the scaffold wrote and parses
    // them with `core`'s own schema. A pipeline that stopped validating would still answer
    // `applied`, and this cell is what notices.
    applied(await scaffold(registryFor(), 'booking.com'))
    expect(existsSync(configPath)).toBe(true)

    const parsed = AgentQaConfigSchema.safeParse(parseYaml(readFileSync(configPath, 'utf8')))
    expect(parsed.success ? null : JSON.stringify(parsed.error?.issues)).toBeNull()
  })
})

describe('the scaffold writes exactly the bytes it shows, in the call', () => {
  it('(5/6/7) writes with no confirm asked, and APPENDS the managed block to the project\'s own gitignore',
    async () => {
      const answer = applied(await scaffold(registryFor({ confirm: true }), 'booking.com'))

      // (7) 432-11 D-14: NO CONFIRM. The spy is bound and was never asked.
      expect(confirms).toBe(0)

      // (5) The bytes on disk are the bytes the answer's diff describes: every added line of the
      // new config is in the file.
      const added = answer.shownDiff.split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1))
      expect(added.length).toBeGreaterThan(0)
      const onDisk = answer.files.map((path) => readFileSync(join(root, path), 'utf8')).join('\n')
      for (const line of added) expect(onDisk, line).toContain(line)

      // (6) THE UPSERT. The project's own rules survive and the managed block is appended — the
      // half a "the block is present" assertion would miss entirely.
      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
      expect(gitignore.startsWith(SEEDED_GITIGNORE)).toBe(true)
      expect(gitignore).toContain('# agent-qa init:start')
      expect(gitignore).toContain('# agent-qa init:end')

      // And the config really is a working configuration for the site that was named.
      expect(writtenConfig().registry?.targets?.['booking-com']?.url).toBe('https://booking.com')
    })

  it('(8) needs no confirm: with none bound the scaffold still writes, and commits nothing', async () => {
    const before = commitCount()
    applied(await scaffold(registryFor(), 'booking.com'))

    expect(commitCount()).toBe(before)
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })
})

describe('undoing a scaffold', () => {
  it('(11) a direct scaffold leaves no agent commit, so the undo has nothing to take back', async () => {
    // 432-11 D-07/D-09: the scaffold's files are plain edits a person reverts with git.
    // RE-SPELLED 2026-10-01 (432-16): the undo used to find no agent commit and refuse
    // `no-agent-commit`; its git-history source is no longer bound, so it refuses unbound by name
    // before reading any history, and files and commits nothing.
    const registry = registryFor({ confirm: true })
    applied(await scaffold(registry, 'booking.com'))
    const written = readFileSync(configPath, 'utf8')

    const before = commitCount()
    // RE-SPELLED 2026-10-01 (432-17, D-09): the undo op is deleted, so it is an unknown function.
    await expect(invokeFunction(registry, 'config.undo.propose', {}, HUMAN))
      .rejects.toMatchObject({ name: 'UnknownFunctionError' })

    expect(commitCount()).toBe(before)
    expect(readFileSync(configPath, 'utf8')).toBe(written)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })
})

describe('a project that already has a configuration is refused, not overwritten', () => {
  it('(9) refuses `already-configured` for a config that DECLARES targets, and writes nothing',
    async () => {
      // A DESIGNED FIXTURE BREAK (395-12). This fixture used to be `workspace:\n  hooksFile: …` —
      // a config file that declares NO targets — so it measured "a config file exists" and would
      // now propose a merge. The predicate it is here to pin is the narrowed one: a configuration
      // this scaffold would OVERWRITE, which is a declared target registry. The refusal must still
      // stand where it should, and this is the two-sided half of cell (13) rather than a separate
      // claim: the same op, the same fixture family, the opposite verdict.
      writeFileSync(
        configPath,
        'workspace:\n  hooksFile: hooks.yaml\n'
        + 'registry:\n  targets:\n    shop:\n      platform: web\n      url: https://shop.test\n',
      )
      const before = readFileSync(configPath, 'utf8')

      const answer = await scaffold(registryFor({ confirm: true }), 'booking.com')
      expect(answer).toMatchObject({ outcome: 'refused', reason: 'already-configured' })
      // It names the targets it will not replace, so a person reads WHICH configuration is standing
      // in the way rather than merely that one is — and still points at the op that adds a target.
      expect(answer.outcome === 'refused' && answer.detail).toContain('shop')
      expect(answer.outcome === 'refused' && answer.detail).toContain('config.target.create')
      expect(readFileSync(configPath, 'utf8')).toBe(before)
    })

  it('(10) refuses a token that is not a hostname, and writes nothing', async () => {
    const answer = await scaffold(registryFor({ confirm: true }), 'the checkout flow')
    expect(answer).toMatchObject({ outcome: 'refused', reason: 'not-a-hostname' })
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(existsSync(configPath)).toBe(false)
  })
})

describe('a configuration with ZERO declared targets is MERGED, never replaced', () => {
  it('(13) inserts exactly one target entry and preserves every other byte of the person\'s config',
    async () => {
      seedZeroTargetConfig()

      // THE FIXTURE'S OWN ROUND TRIP, asserted before anything else — see ZERO_TARGET_CONFIG's
      // header. This line is what keeps the byte assertion below a statement about the INSERTION
      // rather than about the serializer's spacing.
      expect(String(parseDocument(ZERO_TARGET_CONFIG))).toBe(ZERO_TARGET_CONFIG)

      const before = commitCount()
      // RED PRE-FIX: `refused` / `already-configured`, because the predicate was keyed on the config
      // FILE existing. This project declares no target at all — there is nothing to overwrite.
      const answer = applied(await scaffold(registryFor({ confirm: true }), 'booking.com'))

      // The config was MODIFIED, not created: its old side is in the diff.
      expect(answer.shownDiff).toContain(`--- a/${CONFIG_FILE}`)

      // THE MERGE, MEASURED BY SUBTRACTION. Removing the inserted entry's exact text from the
      // written document must leave the committed bytes untouched — the LLM entry, both comment
      // blocks, the blank lines and the key order. A whole-file render fails this by every line it
      // rewrote, which is precisely the overwrite `already-configured` existed to prevent.
      const merged = readFileSync(configPath, 'utf8')
      expect(merged).toContain(INSERTED_TARGET_ENTRY)
      expect(merged.replace(INSERTED_TARGET_ENTRY, '')).toBe(ZERO_TARGET_CONFIG)
      expect(merged).toContain('provider: openai-subscription')
      expect(merged).toContain('# my own agent-qa configuration')

      // The merged candidate is a WORKING configuration, through the shipped schema rather than by
      // inspection — the half that says the insert landed where a target belongs.
      const parsedConfig = AgentQaConfigSchema.safeParse(parseYaml(merged))
      expect(parsedConfig.success ? null : JSON.stringify(parsedConfig.error?.issues)).toBeNull()

      // The written files are exactly the changed members: the config it merged into, the hooks
      // file this project did not have, and the gitignore upsert — with no confirm and no commit.
      expect([...answer.files].sort()).toEqual(['.gitignore', CONFIG_FILE, 'hooks.yaml'])
      expect(confirms).toBe(0)
      expect(commitCount()).toBe(before)
    })

  it('(13b) leaves a hooks file the project ALREADY has out of the candidate entirely', async () => {
    seedZeroTargetConfig({ hooks: SEEDED_HOOKS })

    const answer = applied(await scaffold(registryFor({ confirm: true }), 'booking.com'))

    // NOT A MEMBER OF THE CHANGE SET AT ALL. The scaffold's hooks template is content for a project
    // that has none; writing it over a file a person wrote would be the widest silent overwrite
    // this op could still make after the narrowing — one file over from the one it stopped making.
    expect([...answer.files].sort()).toEqual(['.gitignore', CONFIG_FILE])
    // `addsHook` is STATED (D-02), so it must stop being stated when no hook is added.
    expect(answer.crossBoundaryReasons).not.toContain('hook-added')
    expect(readFileSync(join(root, 'hooks.yaml'), 'utf8')).toBe(SEEDED_HOOKS)
  })
})

// -------------------------------------------------------------------------------------------
// THE THIRD ARM: `config.proposal.apply` from a project with NO config file (395-12 · SC-5).
//
// THE VERB THE ROUTE ITSELF CALLS, and the only one of CFGM-05's three blocks that was not in
// WINDOWS at all. 395-VERIFICATION found it by execution: the route invokes `config.proposal.apply`
// in-turn immediately after the scaffold, and on a zero-config project that verb threw
// `Config file not found` — so even with the other two blocks removed the sentence could not
// complete. `proposals accept` reaches the same apply by a different gate path and DID work from
// zero, which is the asymmetry these cells close.
//
// THE PRODUCTION COMPOSITION, NOT `registryFor`. The cells above build a registry by hand and bind
// no grants port, so the road that failed — `coveringGrantInForce` → `grants.list` →
// `resolveKnowledgeRoot` → `resolveConfig` — does not exist in them. `composeCliLocalAgent` is the
// host the CLI runs, and it is what the trace named.
//
// WHAT MAKES EACH CELL RED:
//
//  (14) apply from zero  — the fault escaping. Pre-fix this threw
//                          `Config file not found: <root>/agent-qa.config.yaml`, with the stack
//                          above. Its second half is the ASK: the confirm is a spy and its call
//                          count is asserted, because "applied" alone cannot tell a gate that
//                          asked from a fold that skipped the ask arm entirely.
// (14a) unknown id       — a fold that turned a typed refusal into something else. From zero, an
//                          id nothing filed must still answer the verb's own not-found refusal.
// (14b) the NO sibling   — a fold that BYPASSED the ask arm. Same fixture class, a fresh from-zero
//                          scaffold, the confirm answering NO: the verb must refuse, commit
//                          nothing, and leave the proposal pending. A bypassed confirm would apply
//                          and commit despite the NO, so the deny-safe claim is measured by a case
//                          the folded gate still REJECTS rather than argued in a comment.
//
// THE CONFIGURED ROAD IS PINNED ELSEWHERE, BY NAME: `config-grant-enforcement.test.ts` cells
// (R1)/(R2)/(R3) drive this same verb through this same composition in a CONFIGURED project. Those
// cells are the two-sided half of this fold and they must stay green beside it.
// -------------------------------------------------------------------------------------------

/**
 * Drive one verb through the PRODUCTION composition, interactive, with a SPY confirm.
 *
 * IT NEVER RETHROWS, and that is what lets the refusal cells assert the confirm count too: an
 * exception propagating out of here would take the spy's reading with it, and "the ask was reached"
 * would become an inference from the refusal's wording rather than a measurement.
 */
async function invokeComposed(input: {
  readonly functionId: string
  readonly payload: unknown
  readonly confirmAnswer: boolean
}): Promise<{
  readonly answer?: unknown
  readonly error?: Error
  readonly confirmCalls: number
}> {
  const ask = vi.fn(() => input.confirmAnswer)
  // 432-16 (D-14): the input declares no confirm; one smuggled past the type is never read.
  const smuggledConfirm = { confirm: { surface: 'tty-prompt', ask } }
  const host = composeCliLocalAgent({
    agentQaRoot,
    configPath,
    ...smuggledConfirm,
  })
  try {
    const answer = await runSafetyScope({ executionContext: 'local-interactive' }, async () =>
      await invokeFunction(host.registry, input.functionId, input.payload, CLI_FUNCTION_CALLER))
    return { answer, confirmCalls: ask.mock.calls.length }
  } catch (error) {
    return { error: error as Error, confirmCalls: ask.mock.calls.length }
  } finally {
    await host.close()
  }
}

/**
 * A pre-432 from-zero scaffold proposal on disk (432-11: the op writes in the call and files none).
 *
 * The content is the REAL producer's for `booking.com`, composed with the project's own
 * `.gitignore`, and the record carries the verdict the classifier gave every scaffold: a new origin
 * and a hook added.
 */
async function composedScaffoldId(): Promise<string> {
  const rendered = await createScaffoldContentPort().render({
    targetName: 'booking-com',
    baseUrl: 'https://booking.com',
    existingGitignore: Uint8Array.from(readFileSync(join(root, '.gitignore'))),
  })
  return (await filePre432ConfigProposal({
    configPath,
    agentQaRoot,
    action: 'config.project.scaffold',
    files: rendered,
    summaryLine: 'configure this project for https://booking.com as target booking-com',
    crossBoundaryReasons: ['hook-added', 'new-origin'],
  })).proposalId
}

// RE-SPELLED 2026-10-01 (432-17, D-05): `config.proposal.apply` is deleted, so each cell below is now
// refused as an unknown function — still before any record or config is read, still never by the
// pre-fix `Config file not found`, and still without consulting a confirm.
describe('config.proposal.apply reaches its own answer from ZERO', () => {
  // RE-SPELLED 2026-09-30 (432-13, D-14/D-15): was '... with the confirm OBSERVED asked'.
  // RE-SPELLED 2026-10-01 (432-16, D-07): was '(14) applies a from-zero scaffold as ONE commit, with
  // no confirm asked'. The composed CLI host binds no config apply port, so the verb refuses by name
  // before it reads the record or the (absent) config — never the pre-fix `Config file not found`.
  it('(14) an old from-zero scaffold proposal record is refused unbound, and nothing is written or committed', async () => {
    const id = await composedScaffoldId()
    const before = commitCount()

    const { error, confirmCalls } = await invokeComposed({
      functionId: 'config.proposal.apply',
      payload: { proposalId: id },
      confirmAnswer: true,
    })
    expect(error?.name).toBe('UnknownFunctionError')
    expect(error?.message).not.toContain('Config file not found')
    expect(confirmCalls).toBe(0)

    expect(commitCount()).toBe(before)
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(join(root, 'hooks.yaml'))).toBe(false)
  })

  // RE-SPELLED 2026-10-01 (432-16): was answering the verb's own not-found refusal. The unbound
  // refusal comes first now, so an unknown id is refused the same way, still never by the config
  // throw.
  it('(14a) an unknown id is refused unbound too, from zero, never by the config throw', async () => {
    const before = commitCount()
    const { error } = await invokeComposed({
      functionId: 'config.proposal.apply',
      payload: { proposalId: 'prop_00000000-0000-4000-8000-000000000000' },
      confirmAnswer: true,
    })
    expect(error?.name).toBe('UnknownFunctionError')
    expect(error?.message).not.toContain('Config file not found')
    expect(commitCount()).toBe(before)
    expect(existsSync(configPath)).toBe(false)
  })

  // RE-SPELLED 2026-09-30 (432-13): was '(14b) refuses on a NO answer from zero'.
  // RE-SPELLED 2026-10-01 (432-16): the scaffold no longer applies either way; a smuggled NO confirm
  // is still never consulted.
  it('(14b) a NO-answering confirm is never consulted, and the record is refused unbound', async () => {
    const id = await composedScaffoldId()
    const before = commitCount()

    const { error, confirmCalls } = await invokeComposed({
      functionId: 'config.proposal.apply',
      payload: { proposalId: id },
      confirmAnswer: false,
    })
    expect(error?.name).toBe('UnknownFunctionError')
    expect(confirmCalls).toBe(0)
    expect(commitCount()).toBe(before)
    expect(existsSync(configPath)).toBe(false)
  })
})

describe('the config dir is NOT the repository root when a scaffold creates its files', () => {
  it('(12) a from-zero scaffold at sub/dir lands its three members THERE, once each, in one commit',
    async () => {
      const configDir = relocateToSubdir()
      const before = commitCount()
      const answer = applied(await scaffold(registryFor({ confirm: true }), 'booking.com'))

      // The answer's paths are configDir-relative — the vocabulary the pinned set, the writer and
      // the classifier all speak. Repo-root-relative paths here would be CR-03's defect arriving
      // from the create direction.
      expect([...answer.files].sort())
        .toEqual([...enumerateConfigFileSet({ configFile: CONFIG_FILE })])

      // NO COMMIT, and git sees each member EXACTLY ONCE under sub/dir. A doubled prefix is what a
      // writer resolving a repo-root-relative path against configDir produces.
      expect(commitCount()).toBe(before)
      expect(git('status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean).sort())
        .toEqual([' M sub/dir/.gitignore', `?? sub/dir/${CONFIG_FILE}`, '?? sub/dir/hooks.yaml'])
      expect(existsSync(join(configDir, 'sub'))).toBe(false)

      // THE BYTES LANDED IN THE CONFIG dir, and the config is a working one where it landed.
      for (const path of answer.files) expect(existsSync(join(configDir, path)), path).toBe(true)
      const written = parseYaml(readFileSync(configPath, 'utf8')) as {
        registry?: { targets?: Record<string, { url?: string }> }
      }
      expect(AgentQaConfigSchema.safeParse(written).success).toBe(true)
      expect(written.registry?.targets?.['booking-com']?.url).toBe('https://booking.com')

      // The project's own rule in the gitignore BESIDE the config survives the upsert — the half
      // that says the scaffold composed with the right file rather than merely wrote one.
      const gitignore = readFileSync(join(configDir, '.gitignore'), 'utf8')
      expect(gitignore.startsWith(SEEDED_GITIGNORE)).toBe(true)
      expect(gitignore).toContain('# agent-qa init:start')
    })
})

/** A config with one target and a model, for the create cells. */
const ONE_TARGET_CONFIG = `workspace:
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
    shop:
      platform: web
      url: https://shop.example.com
use:
  llm: judge
  mobile:
    appState: preserve
`

async function createTarget(
  registry: ReturnType<typeof registryFor>,
  input: Record<string, unknown>,
): Promise<ConfigChangeOutput> {
  return await invokeFunction(registry, 'config.target.create', input, HUMAN) as ConfigChangeOutput
}

function seedOneTargetConfig(): void {
  writeFileSync(configPath, ONE_TARGET_CONFIG)
  git('add', '--', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'the project configures one target')
}

type ParsedConfig = {
  registry?: {
    llms?: { name: string }[]
    targets?: Record<string, Record<string, unknown>>
  }
  use?: { llm?: string }
}

describe('the class reaches the committed file', () => {
  it('a production create writes its declaration, read back through the shipped schema',
    async () => {
      seedOneTargetConfig()
      applied(await createTarget(registryFor({ confirm: true }), {
        name: 'stage',
        platform: 'web',
        url: 'http://localhost:3000',
        environment: 'production',
      }))

      const parsed = AgentQaConfigSchema.safeParse(parseYaml(readFileSync(configPath, 'utf8')))
      expect(parsed.success ? null : JSON.stringify(parsed.error?.issues)).toBeNull()
      const written = parseYaml(readFileSync(configPath, 'utf8')) as ParsedConfig
      expect(written.registry?.targets?.stage)
        .toEqual({ platform: 'web', url: 'http://localhost:3000', environment: 'production' })
      expect(written.registry?.targets?.shop).toEqual({ platform: 'web', url: 'https://shop.example.com' })
    })

  it('a duplicate create is refused and the file is untouched', async () => {
    seedOneTargetConfig()
    const before = readFileSync(configPath, 'utf8')
    const answer = await createTarget(registryFor({ confirm: true }), {
      name: 'shop',
      platform: 'web',
      url: 'https://other.example.com',
      environment: 'local',
    })

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'target-exists' })
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  it('a Unicode label the registry refuses is blocked by validation, not rewritten',
    async () => {
      seedOneTargetConfig()
      const answer = await createTarget(registryFor({ confirm: true }), {
        name: 'straße',
        platform: 'web',
        url: 'https://strasse.example.com',
        environment: 'shared',
      })

      expect(answer).toMatchObject({ outcome: 'blocked', blockedReason: 'schema-fail' })
      // Refused for the label and nothing else: the registry key rule, in the validator's words.
      expect(answer.outcome === 'blocked' && answer.validationIssues).toEqual([
        'agent-qa.config.yaml: registry.targets.straße: Invalid key in record',
      ])
      expect(readFileSync(configPath, 'utf8')).toBe(ONE_TARGET_CONFIG)
    })
})

describe('the local demo app scaffolds from zero', () => {
  it('http://127.0.0.1:8931 keeps its scheme and port and validates', async () => {
    const answer = applied(await scaffold(registryFor({ confirm: true }), 'http://127.0.0.1:8931/form.html'))

    const derived = writtenConfig()
    expect(AgentQaConfigSchema.safeParse(derived).success).toBe(true)
    expect(derived.registry?.targets).toEqual({
      'ip-127-0-0-1-8931': { platform: 'web', url: 'http://127.0.0.1:8931' },
    })
    expect(answer.summaryLine)
      .toBe('configure this project for http://127.0.0.1:8931 as target ip-127-0-0-1-8931')
  })

  it('localhost and bracketed IPv6 loopback scaffold with their ports', async () => {
    for (const [domain, name, url] of [
      ['localhost:5173', 'localhost-5173', 'https://localhost:5173'],
      ['http://[::1]:3000', 'ipv6-loopback-3000', 'http://[::1]:3000'],
    ] as const) {
      // Each spelling scaffolds a project from zero, so the previous one's files are cleared.
      rmSync(configPath, { force: true })
      rmSync(join(root, 'hooks.yaml'), { force: true })
      writeFileSync(join(root, '.gitignore'), SEEDED_GITIGNORE)
      applied(await scaffold(registryFor({ confirm: true }), domain))
      const derived = writtenConfig()
      expect(derived.registry?.targets, domain).toEqual({ [name]: { platform: 'web', url } })
      expect(AgentQaConfigSchema.safeParse(derived).success, domain).toBe(true)
    }
  })
})

describe('local origin retries and rewritten spellings', () => {
  it('a second scaffold of an applied local origin is refused, and the file is kept',
    async () => {
      const registry = registryFor({ confirm: true })
      applied(await scaffold(registry, 'http://localhost:3000'))
      const written = readFileSync(configPath, 'utf8')

      const again = await scaffold(registry, 'http://localhost:3000')
      expect(again).toMatchObject({
        outcome: 'refused',
        reason: 'already-configured',
        candidates: ['localhost-3000'],
      })
      expect(readFileSync(configPath, 'utf8')).toBe(written)
    })

  it('a spelling the parser would rewrite into loopback writes nothing', async () => {
    for (const domain of ['http://127.1:3000', 'http://2130706433/', 'ftp://localhost']) {
      const answer = await scaffold(registryFor({ confirm: true }), domain)
      expect(answer, domain).toMatchObject({ outcome: 'refused', reason: 'not-a-hostname' })
    }
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(existsSync(configPath)).toBe(false)
  })
})

describe('the scaffold keeps the model registry and its selection', () => {
  it('the zero-target merge writes every model entry and the selected model',
    async () => {
      seedZeroTargetConfig()
      applied(await scaffold(registryFor({ confirm: true }), 'http://localhost:3000'))

      const onDisk = parseYaml(readFileSync(configPath, 'utf8')) as ParsedConfig
      const parsed = AgentQaConfigSchema.safeParse(onDisk)
      expect(parsed.success ? null : JSON.stringify(parsed.error?.issues)).toBeNull()
      expect(onDisk.registry?.llms).toEqual([
        { name: 'judge', provider: 'openai-subscription', model: 'gpt-5.6-terra' },
      ])
      expect(onDisk.use?.llm).toBe('judge')
      expect(onDisk.registry?.targets).toEqual({
        'localhost-3000': { platform: 'web', url: 'http://localhost:3000' },
      })
      // Unrelated files are left as they were, and the managed block is an upsert.
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('a project that has never run agent-qa\n')
      expect(readFileSync(join(root, '.gitignore'), 'utf8').startsWith(SEEDED_GITIGNORE)).toBe(true)
    })

  it('the merge does not repair an inconsistent selection — validation refuses it', async () => {
    writeFileSync(configPath, ZERO_TARGET_CONFIG.replace('  llm: judge\n', '  llm: ghost\n'))
    git('add', '--', CONFIG_FILE)
    git('commit', '--quiet', '-m', 'a selection naming no registered model')

    const answer = await scaffold(registryFor({ confirm: true }), 'booking.com')
    expect(answer).toMatchObject({ outcome: 'blocked', blockedReason: 'schema-fail' })
    expect(answer.outcome === 'blocked' && answer.validationIssues?.join('\n')).toContain('ghost')
  })

  it('the from-zero producer writes the model entries it is given, with a coherent selection',
    () => {
      const entries = [
        { name: 'judge', provider: 'openai-subscription', model: 'gpt-5.6-terra' },
        { name: 'planner', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' },
      ]
      const files = buildScaffoldFileSet({
        cacheDir: '.agent-qa/cache',
        authStatesDir: '.agent-qa/auth-states',
        targetName: 'booking-com',
        baseUrl: 'https://booking.com',
        gitignoreEntries: ['.env'],
        llmEntries: entries,
      })
      const config = parseYaml(files.find((file) => file.path === CONFIG_FILE)?.text as string) as ParsedConfig
      expect(config.registry?.llms).toEqual(entries)
      expect(config.use?.llm).toBe('judge')
      const parsed = AgentQaConfigSchema.safeParse(config)
      expect(parsed.success ? null : JSON.stringify(parsed.error?.issues)).toBeNull()
      // The hooks file is the empty list (445-02, D-40), and the managed block is present.
      expect(files.find((file) => file.path === 'hooks.yaml')?.text).toBe('hooks: []\n')
      expect(files.find((file) => file.path === '.gitignore')?.text).toContain('# agent-qa init:start')

      const selected = buildScaffoldFileSet({
        cacheDir: '.agent-qa/cache',
        authStatesDir: '.agent-qa/auth-states',
        targetName: 'booking-com',
        baseUrl: 'https://booking.com',
        gitignoreEntries: ['.env'],
        llmEntries: entries,
        selectedLlm: 'planner',
      })
      const chosen = parseYaml(selected.find((file) => file.path === CONFIG_FILE)?.text as string) as ParsedConfig
      expect(chosen.use?.llm).toBe('planner')
      expect(AgentQaConfigSchema.safeParse(chosen).success).toBe(true)

      const incoherent = buildScaffoldFileSet({
        cacheDir: '.agent-qa/cache',
        authStatesDir: '.agent-qa/auth-states',
        targetName: 'booking-com',
        baseUrl: 'https://booking.com',
        gitignoreEntries: ['.env'],
        llmEntries: entries,
        selectedLlm: 'ghost',
      })
      const refused = parseYaml(incoherent.find((file) => file.path === CONFIG_FILE)?.text as string) as ParsedConfig
      expect(refused.use?.llm).toBe('ghost')
      expect(AgentQaConfigSchema.safeParse(refused).success).toBe(false)
    })

  // 2026-10-03 (quick 261003-cpv, 432 review IN-09): THE PRODUCTION PORT, measured. Its request
  // carries a domain and nothing else, and from zero there is no configuration to read a model
  // from, so it passes no model entries (D-13: none is invented). #130's from-zero half therefore
  // stays bare; only the merge half (a zero-target config keeps its own `registry.llms`) is fixed.
  it('the production port renders no model half from zero', async () => {
    const rendered = await createScaffoldContentPort().render({
      targetName: 'booking-com',
      baseUrl: 'https://booking.com',
    })
    const text = Buffer.from(rendered.find((file) => file.path === CONFIG_FILE)?.bytes ?? []).toString('utf8')
    const config = parseYaml(text) as ParsedConfig
    expect(config.registry?.targets).toEqual({ 'booking-com': { platform: 'web', url: 'https://booking.com' } })
    expect(Object.hasOwn(config.registry ?? {}, 'llms')).toBe(false)
    expect(Object.hasOwn(config.use ?? {}, 'llm')).toBe(false)
    expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
  })

  it('with no model given, the from-zero config carries no model half and still validates',
    () => {
      const files = buildScaffoldFileSet({
        cacheDir: '.agent-qa/cache',
        authStatesDir: '.agent-qa/auth-states',
        targetName: 'booking-com',
        baseUrl: 'https://booking.com',
        gitignoreEntries: ['.env'],
      })
      const config = parseYaml(files.find((file) => file.path === CONFIG_FILE)?.text as string) as ParsedConfig
      expect(Object.hasOwn(config.registry ?? {}, 'llms')).toBe(false)
      expect(Object.hasOwn(config.use ?? {}, 'llm')).toBe(false)
      expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
    })
})

// ---- 432-11 D-05/D-07: the scaffold publishes every file in the call, and says what happened ---
//
// C432-CONFIG-SIX-OPS          through the real ports and the real direct writer: a from-zero
//                              scaffold writes .gitignore, the config and the hooks file before it
//                              answers, commits nothing and files nothing.
// C432-CONFIG-MULTIFILE-TRUTH  a file that changes between the preflight and its own turn stops the
//                              publication there: the answer names the file already written, the one
//                              that refused and the one never reached, and the disk agrees.

let directFiled = 0

function directRegistry() {
  const deps = {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: CONFIG_FILE,
        entries: [],
      }),
    },
    configFiles: createConfigFilesPort(configPath),
    configValidate: createConfigValidatePort(),
    scaffoldContent: createScaffoldContentPort(),
    configWrite: (host as Record<string, unknown>).createConfigWritePort === undefined
      ? undefined
      : ((host as Record<string, unknown>).createConfigWritePort as (path: string) => unknown)(configPath),
    configProposals: {
      put: () => {
        directFiled += 1
        return Promise.resolve({ proposalId: `prop-direct-${directFiled}` })
      },
    },
  } as unknown as FunctionDeps
  return createFunctionRegistry({
    deps,
  })
}

async function waitUntil(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}

describe('the scaffold writes every file before it answers', () => {
  it('a from-zero scaffold publishes three files, commits nothing and files nothing',
    async () => {
      const before = commitCount()
      const answer = await invokeFunction(
        directRegistry(), 'config.project.scaffold', { domain: 'booking.com' }, HUMAN,
      ) as Record<string, unknown>

      expect(answer).toMatchObject({
        outcome: 'applied',
        files: ['.gitignore', CONFIG_FILE, 'hooks.yaml'],
      })
      expect(commitCount()).toBe(before)
      expect(directFiled).toBe(0)
      expect(readFileSync(join(root, '.gitignore'), 'utf8').startsWith(SEEDED_GITIGNORE)).toBe(true)
      expect(AgentQaConfigSchema.safeParse(parseYaml(readFileSync(configPath, 'utf8'))).success).toBe(true)
      expect(readFileSync(join(root, 'hooks.yaml'), 'utf8')).toBe('hooks: []\n')
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    })
})

describe('a partial publication reports exactly what it wrote', () => {
  it('the config changing in its turn stops the scaffold after .gitignore',
    async () => {
      const serialize = (dashboard as Record<string, unknown>).serializeConfigWrite as
        | (<T>(path: string, work: () => Promise<T>) => Promise<T>)
        | undefined
      expect(typeof serialize, 'the per-path config queue is exported').toBe('function')
      if (serialize === undefined) return

      // Hold the config path's write turn, so the scaffold's config write waits behind it.
      let release!: () => void
      let entered!: () => void
      const holding = new Promise<void>((resolve) => { entered = resolve })
      const held = serialize(configPath, () => new Promise<void>((resolve) => {
        release = resolve
        entered()
      }))
      await holding

      const pending = invokeFunction(
        directRegistry(), 'config.project.scaffold', { domain: 'booking.com' }, HUMAN,
      ) as Promise<Record<string, unknown>>
      let answeredEarly = false
      void pending.then(() => { answeredEarly = true }, () => { answeredEarly = true })
      const gitignoreWritten = await waitUntil(() =>
        answeredEarly || readFileSync(join(root, '.gitignore'), 'utf8') !== SEEDED_GITIGNORE)
      expect(gitignoreWritten && !answeredEarly, 'the scaffold wrote .gitignore and is waiting its turn')
        .toBe(true)

      // Somebody writes a config while the scaffold waits for that file's turn.
      const outside = 'workspace:\n  hooksFile: hooks.yaml\n'
      writeFileSync(configPath, outside)
      release()
      await held

      const answer = await pending
      expect(answer).toMatchObject({
        outcome: 'interrupted',
        written: ['.gitignore'],
        failed: { path: CONFIG_FILE, reason: 'file-changed' },
        unwritten: ['hooks.yaml'],
      })
      // The disk agrees with the answer, file by file, and nothing was rolled back or invented.
      expect(readFileSync(join(root, '.gitignore'), 'utf8').startsWith(SEEDED_GITIGNORE)).toBe(true)
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).not.toBe(SEEDED_GITIGNORE)
      expect(readFileSync(configPath, 'utf8')).toBe(outside)
      expect(existsSync(join(root, 'hooks.yaml'))).toBe(false)
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    })
})
