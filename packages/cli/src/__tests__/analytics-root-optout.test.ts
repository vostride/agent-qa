// `analytics.privacy: true`, honoured AT EVERY COMPOSITION ROOT (Phase 398 plan 14, D-19 · ANLY-01).
//
// WHY THIS FILE EXISTS BESIDE A GREEN ZERO-NETWORK DIFFERENTIAL. `packages/analytics` already
// proves that `composeAnalytics` returns a walled transport when a config declares privacy. That
// differential enters ONE LAYER BELOW the seam that was broken: two shipped roots (`chat`, `init`)
// composed their host WITHOUT handing over the config at all, so the decision was correct and its
// input never arrived. A user who set the flag still emitted chat aggregates and init events, and
// every existing cell stayed green. These cells enter at the HOST layer — the shipped command's own
// action — which is the only altitude from which a dropped argument is visible.
//
// THE VACUITY TRAP, AND WHY EVERY CELL ASSERTS `optOutReasons`. `composeAnalytics` returns no
// transport in TWO states: the caller opted out, AND the PostHog project key is blank. The
// committed key file ships blank and the release pipeline fills it, so in this test process
// `transportKind` is `'none'` ALREADY, on every host, with or without a config. A cell asserting
// only `transportKind === 'none'` would be GREEN ON THE BROKEN BUILD. `optOutReasons` is computed
// by `composeAnalytics` purely from the config, independently of any project key, and carries
// `'config-privacy'` exactly when `config.analytics.privacy === true` REACHED the decision. Every
// cell below therefore asserts the reason on the privacy arm and its ABSENCE on a
// control arm, and asserts `transportKind` beside it — with a non-blank `projectKey` injected
// wherever the seam admits one, so the transport assertion is load-bearing too.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChatCommand } from '../commands/chat.js'
import { createDaemonCommand } from '../commands/daemon.js'
import type { DaemonCommandDeps } from '../commands/daemon.js'
import { createInitCommand } from '../commands/init.js'
import { createMcpCommand } from '../commands/mcp.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import type {
  CliAnalyticsHost,
  ComposeAnalyticsHostInput,
} from '../composition/analytics-host.js'
import type { AnalyticsCapturePayload } from '@vostride/agent-qa-analytics'

/** A non-blank key, so the opted-IN arm is genuinely `'posthog'` and the transport assert bites. */
const CELL_PROJECT_KEY = 'phc_root_optout_cell'

/**
 * A project on disk, with or without the one boolean under measurement.
 *
 * The config is a minimal valid one: `resolveConfig` accepts it, so the cells measure the privacy
 * arm rather than the tolerant read's `undefined` branch.
 *
 * The privacy arm adds the shipped `analytics.privacy` field from
 * `packages/core/src/schema/analytics-schema.ts`.
 */
function fixtureProject(
  roots: string[],
  options: { readonly privacy?: boolean; readonly withConfig?: boolean } = {},
): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-root-optout-'))
  roots.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  if (options.withConfig === false) return { dir, configPath }

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
      use: { mobile: { appState: 'reset' } },
      ...(options.privacy === true ? { analytics: { privacy: true } } : {}),
    })}\n`,
    'utf8',
  )
  // 2026-10-14 (441-06, E3): chat refuses a project whose secrets file is missing.
  writeFileSync(join(dir, '.env.secrets.local'), '', 'utf8')
  return { dir, configPath }
}

/**
 * A project whose config DECLARES privacy and is REJECTED by `resolveConfig` for an unrelated
 * reason.
 *
 * It declares a `use.mobile` block without `appState`, which the schema refuses, so this fixture
 * reaches the tolerant read's failure branch by the same door a real user's mistake does.
 *
 * The declaration itself is untouched and unambiguous: `analytics.privacy: true` sits in the
 * document exactly where the shipped schema puts it. The whole question is whether a root that
 * cannot VALIDATE the document is still able to READ that one boolean.
 */
function invalidConfigDeclaringPrivacy(
  roots: string[],
  options: { readonly privacy?: boolean; readonly unparseable?: boolean } = {},
): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-root-optout-invalid-'))
  roots.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')

  if (options.unparseable === true) {
    // Not YAML at all: the document exists but no reader can extract a declaration from it.
    writeFileSync(configPath, 'workspace: [unclosed\n  : : :\n', 'utf8')
    return { dir, configPath }
  }

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
      // A declared `use.mobile` without `appState` is what makes `resolveConfig` throw.
      use: { mobile: {} },
      ...(options.privacy === true ? { analytics: { privacy: true } } : {}),
    })}\n`,
    'utf8',
  )
  writeFileSync(join(dir, '.env.secrets.local'), '', 'utf8')
  return { dir, configPath }
}

interface RecordedComposition {
  /** Exactly what the ROOT handed the binding. The argument is what is under measurement. */
  readonly inputs: ComposeAnalyticsHostInput[]
  readonly hosts: CliAnalyticsHost[]
  readonly compose: typeof composeAnalyticsHost
}

/**
 * A recording WRAPPER, not a replacement.
 *
 * It delegates to the REAL `composeAnalyticsHost`, so the opt-out decision, the identity gate and
 * the transport selection every assertion reads are the shipped ones. What it adds is only what
 * keeps the measurement hermetic: `env: {}` so the identity resolution never sees the developer's
 * own environment, a non-blank project key, a transport that records and sends nothing, and an
 * identity stub so no real home directory is touched.
 */
function recordingCompose(): RecordedComposition {
  const inputs: ComposeAnalyticsHostInput[] = []
  const hosts: CliAnalyticsHost[] = []
  const compose = async (input: ComposeAnalyticsHostInput): Promise<CliAnalyticsHost> => {
    inputs.push(input)
    const host = await composeAnalyticsHost({
      ...input,
      env: {},
      projectKey: CELL_PROJECT_KEY,
      posthogTransportFactory: () => ({
        capture: () => {},
        flush: () => {},
        shutdown: () => {},
      }),
      resolveIdentity: async () => ({
        distinctId: 'u_root-optout-cell',
        runtimeContext: 'user' as const,
      }),
    })
    hosts.push(host)
    return host
  }
  return { inputs, hosts, compose }
}

const CHAT_ROOT = 'packages/cli/src/commands/chat.ts'

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: number | string | undefined
}

/** `chat-command.test.ts`'s idiom: scripted stdin, no tty, a tick before the first line. */
async function runChat(
  configPath: string,
  typed: readonly string[],
  extraDeps: Parameters<typeof createChatCommand>[0] = {},
): Promise<InvocationResult> {
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
      .addCommand(createChatCommand({ input, output, ...extraDeps }))
    program.exitOverride()
    const parsed = program.parseAsync(['node', 'agent-qa', '--config', configPath, 'chat'])
    await Promise.resolve()
    for (const line of typed) input.write(`${line}\n`)
    input.end()
    await parsed
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  } finally {
    process.exitCode = previousExitCode
    log.mockRestore()
    error.mockRestore()
  }
}

describe('the chat composition root honours analytics.privacy (398-14, D-19)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('walls the host when the project declares analytics.privacy: true', async () => {
    const { configPath } = fixtureProject(roots, { privacy: true })
    const recorder = recordingCompose()

    await runChat(configPath, ['/quit'], { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    // BEHAVIOUR FIRST, then the input that produced it. The reason is the discriminator; the
    // transport is item 2b's literal wording, kept and honest.
    expect(
      host?.optOutReasons,
      `${CHAT_ROOT} composed a host that does not report the config opt-out reason — the `
      + 'declaration was dropped between the config file and composeAnalytics',
    ).toContain('config-privacy')
    expect(host?.optedOut).toBe(true)
    expect(host?.transportKind).toBe('none')
    expect(
      recorder.inputs[0]?.config,
      `${CHAT_ROOT}'s analytics composition root handed no config to the one opt-out decision, `
      + 'so a user\'s analytics.privacy declaration never reached its reader',
    ).toBeDefined()
  })

  it('does NOT report the config reason when no analytics block is declared', async () => {
    const { configPath } = fixtureProject(roots)
    const recorder = recordingCompose()

    await runChat(configPath, ['/quit'], { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    // The control half. Without it the privacy arm could pass on a host that is walled for an
    // unrelated reason — a blank key, a stray environment variable — and prove nothing.
    expect(host?.optOutReasons).not.toContain('config-privacy')
    expect(host?.optedOut).toBe(false)
    expect(host?.transportKind).toBe('posthog')
  })

  // 2026-10-14 (441-06, E3): `still opens a session in a directory with NO config file` is
  // deleted with its subject; chat refuses at start when no secrets file can be read.

  // ── Finding F-1 / review CR-01 (Phase 398 gap round) ──────────────────────────────────────
  //
  // The tolerant read collapsed TWO states into one `undefined`: "there is no config" and "there
  // is a config, it declares privacy, and it failed validation for an unrelated reason". The
  // second is a user who set a shipped privacy control and was transmitted anyway, silently.
  //
  // Availability is NOT the thing being traded here, and these cells assert that too: the session
  // still opens on a document that cannot be validated. Reading one boolean out of a document is
  // not the same act as validating it, and only the second one was ever failing.

  it('honours analytics.privacy: true even when the config FAILS validation (F-1)', async () => {
    const { configPath } = invalidConfigDeclaringPrivacy(roots, { privacy: true })
    const recorder = recordingCompose()

    const result = await runChat(configPath, ['/quit'], { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    expect(
      host?.optOutReasons,
      `${CHAT_ROOT} composed a host that does not report the config opt-out reason, on a config `
      + 'that DECLARES analytics.privacy: true and merely fails schema validation for an '
      + 'unrelated reason. The declaration was discarded and telemetry was composed against it.',
    ).toContain('config-privacy')
    expect(host?.transportKind).toBe('none')
    // And the surface still opened — the fix reads the document, it does not start refusing it.
    expect(result.exitCode === undefined || result.exitCode === 0).toBe(true)
  })

  it('does NOT report the config reason when an INVALID config declares no privacy (F-1 control)', async () => {
    const { configPath } = invalidConfigDeclaringPrivacy(roots)
    const recorder = recordingCompose()

    await runChat(configPath, ['/quit'], { composeAnalytics: recorder.compose })

    // The discriminator. Without this arm the cell above would pass on a root that opted every
    // invalid config out — which would honour nothing and merely break telemetry.
    expect(recorder.hosts).toHaveLength(1)
    expect(recorder.hosts[0]?.optOutReasons).not.toContain('config-privacy')
    expect(recorder.hosts[0]?.transportKind).toBe('posthog')
  })

  it('fails CLOSED when a config file exists but cannot be parsed at all (F-1)', async () => {
    const { configPath } = invalidConfigDeclaringPrivacy(roots, { unparseable: true })
    const recorder = recordingCompose()

    const result = await runChat(configPath, ['/quit'], { composeAnalytics: recorder.compose })

    // A document we cannot read MIGHT carry the declaration, so the doubt resolves toward the user.
    // 2026-10-14 (441-06, E3): the secrets declaration cannot be read either, so chat refuses at
    // start and composes no analytics host at all: nothing can be transmitted.
    expect(recorder.hosts).toHaveLength(0)
    expect(result.exitCode).toBe(1)
  })
})

const INIT_ROOT = 'packages/cli/src/commands/init.ts'

/** Drive the SHIPPED init command, non-interactively (no prompts on the `--platform` arm). */
async function runInit(
  dir: string,
  extraHooks: Parameters<typeof createInitCommand>[0] = {},
): Promise<{ exitCode: number | string | undefined }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const parent = new Command().option('--config <path>', 'config file path')
    parent.addCommand(createInitCommand(extraHooks))
    parent.exitOverride()
    await parent.parseAsync([
      'node', 'agent-qa', 'init', '--dir', dir, '--platform', 'web',
    ])
    return { exitCode: process.exitCode }
  } finally {
    process.exitCode = previousExitCode
    log.mockRestore()
    error.mockRestore()
  }
}

describe('the init composition root honours analytics.privacy (398-14, D-19)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('walls the host when the directory already carries analytics.privacy: true', async () => {
    const { dir } = fixtureProject(roots, { privacy: true })
    const recorder = recordingCompose()

    await runInit(dir, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    expect(
      host?.optOutReasons,
      `${INIT_ROOT}'s emitInitCompleted composed a host that does not report the config opt-out `
      + 'reason — the declaration in the directory it is scaffolding never reached composeAnalytics',
    ).toContain('config-privacy')
    expect(host?.optedOut).toBe(true)
    expect(host?.transportKind).toBe('none')
    expect(recorder.inputs[0]?.config).toBeDefined()
  })

  it('does NOT report the config reason when the existing config declares no analytics block', async () => {
    const { dir } = fixtureProject(roots)
    const recorder = recordingCompose()

    await runInit(dir, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    expect(host?.optOutReasons).not.toContain('config-privacy')
    expect(host?.optedOut).toBe(false)
    expect(host?.transportKind).toBe('posthog')
  })

  // Finding F-1 / review CR-01, at the second root. `init` matters here for a reason chat does
  // not: it is frequently the FIRST command a user runs against a directory they have just hand-
  // edited, which is exactly when a config is most likely to be both privacy-declaring and
  // schema-invalid.
  it('honours analytics.privacy: true even when the config FAILS validation (F-1)', async () => {
    const { dir } = invalidConfigDeclaringPrivacy(roots, { privacy: true })
    const recorder = recordingCompose()

    const result = await runInit(dir, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    const host = recorder.hosts[0]
    expect(
      host?.optOutReasons,
      `${INIT_ROOT} composed a host that does not report the config opt-out reason, on a config `
      + 'that DECLARES analytics.privacy: true and merely fails schema validation for an '
      + 'unrelated reason. The declaration was discarded and init events were composed against it.',
    ).toContain('config-privacy')
    expect(host?.optedOut).toBe(true)
    expect(host?.transportKind).toBe('none')
    // Availability half: it still scaffolded.
    expect(result.exitCode === undefined || result.exitCode === 0).toBe(true)
  })

  it('does NOT report the config reason when an INVALID config declares no privacy (F-1 control)', async () => {
    const { dir } = invalidConfigDeclaringPrivacy(roots)
    const recorder = recordingCompose()

    await runInit(dir, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    expect(recorder.hosts[0]?.optOutReasons).not.toContain('config-privacy')
    expect(recorder.hosts[0]?.transportKind).toBe('posthog')
  })

  it('still scaffolds and still emits in a FRESH directory with no config yet', async () => {
    // The ordinary first run. There is genuinely no declaration to honour before the scaffold
    // writes one, so the absence of the config reason here is the honest posture, not a gap — and
    // the availability half of T-398-32: the tolerant read cannot turn a missing config into a
    // refusal to scaffold.
    const { dir } = fixtureProject(roots, { withConfig: false })
    const recorder = recordingCompose()

    const result = await runInit(dir, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    expect(recorder.hosts[0]?.optOutReasons).not.toContain('config-privacy')
    expect(existsSync(join(dir, 'agent-qa.config.yaml'))).toBe(true)
    expect(result.exitCode === undefined || result.exitCode === 0).toBe(true)
  })
})

/**
 * THE CONTROL ON THE ASSERTION ITSELF.
 *
 * `daemon.ts` already resolves its config and already hands it to `composeAnalyticsHost`. Both arms
 * below are therefore expected to pass UNAIDED, on their first run and with no product change —
 * which is what shows the same assertion that RED'd at chat and init discriminates ROOTS rather
 * than tracking something incidental to the harness. If this pair failed to discriminate it would
 * be a finding about the assertion, not about the daemon.
 *
 * No `vi.mock` of the analytics binding: the composed host is read straight off the shipped root
 * through the `runHost` dep it is handed to. The transport kind is `none` on BOTH arms here (the
 * committed project key is blank and this root admits no key seam), which is exactly why
 * `optOutReasons` and not `transportKind` is the discriminator.
 */
function daemonDepsCapturing(captured: { analytics?: unknown }): DaemonCommandDeps {
  const unused = (name: string) => () => {
    throw new Error(`daemon dep ${name} must not be reached by the bare 'daemon' action`)
  }
  return {
    runHost: (options) => {
      captured.analytics = options.analytics
      return Promise.resolve(0)
    },
    resolvePaths: unused('resolvePaths'),
    resolveAgentQaRoot: unused('resolveAgentQaRoot'),
    readRegistration: unused('readRegistration'),
    processIsAlive: unused('processIsAlive'),
    readIdentity: unused('readIdentity'),
    readWriterLease: unused('readWriterLease'),
    countPendingCurationJobs: unused('countPendingCurationJobs'),
    signalProcess: unused('signalProcess'),
    now: () => 1_700_000_000_000,
  } as DaemonCommandDeps
}

async function runDaemon(configPath: string): Promise<CliAnalyticsHost | undefined> {
  const captured: { analytics?: unknown } = {}
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command().name('agent-qa').option('--config <path>').exitOverride()
    const daemon = createDaemonCommand(daemonDepsCapturing(captured))
    daemon.exitOverride()
    program.addCommand(daemon)
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'daemon'])
    return captured.analytics as CliAnalyticsHost | undefined
  } finally {
    process.exitCode = previousExitCode
    log.mockRestore()
    error.mockRestore()
  }
}

describe('the daemon root — the control that shows the assertion discriminates (398-14)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('walls the host it hands runHost when the project declares analytics.privacy: true', async () => {
    const { configPath } = fixtureProject(roots, { privacy: true })

    const host = await runDaemon(configPath)

    expect(host?.optOutReasons).toContain('config-privacy')
    expect(host?.optedOut).toBe(true)
    expect(host?.transportKind).toBe('none')
  })

  it('does NOT report the config reason when no analytics block is declared', async () => {
    const { configPath } = fixtureProject(roots)

    const host = await runDaemon(configPath)

    expect(host?.optOutReasons).not.toContain('config-privacy')
  })
})

const CI_MARKERS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'BUILDKITE',
  'JENKINS_URL',
  'TRAVIS',
  'APPVEYOR',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
  'DRONE',
  'SEMAPHORE',
  'BITBUCKET_BUILD_NUMBER',
  'TEAMCITY_VERSION',
]

describe('C447-IDENTITY-STORAGE-FAILURE', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('an identity location that cannot be written composes a host that sends nothing and init still exits 0', async () => {
    for (const name of CI_MARKERS) vi.stubEnv(name, '')
    const { dir } = fixtureProject(roots, { withConfig: false })
    const home = mkdtempSync(join(tmpdir(), 'agent-qa-447-xdg-'))
    roots.push(home)
    // A regular file where the data directory should be: mkdir under it fails for every user.
    const xdgFile = join(home, 'xdg-file')
    writeFileSync(xdgFile, 'not a directory\n', 'utf8')
    const captured: AnalyticsCapturePayload[] = []
    const hosts: CliAnalyticsHost[] = []
    const composeAnalytics = async (input: ComposeAnalyticsHostInput): Promise<CliAnalyticsHost> => {
      const host = await composeAnalyticsHost({
        ...input,
        env: { XDG_DATA_HOME: xdgFile },
        projectKey: CELL_PROJECT_KEY,
        posthogTransportFactory: () => ({
          capture: (payload) => {
            captured.push(payload)
          },
          flush: () => {},
          shutdown: () => {},
        }),
      })
      hosts.push(host)
      return host
    }

    const outcome = await runInit(dir, { composeAnalytics }).then(
      (result) => ({ ok: true as const, ...result }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    expect(outcome.ok, `init failed: ${outcome.ok ? '' : String(outcome.error)}`).toBe(true)
    expect(outcome.ok && (outcome.exitCode === undefined || outcome.exitCode === 0)).toBe(true)
    expect(existsSync(join(dir, 'agent-qa.config.yaml'))).toBe(true)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.transportKind).toBe('posthog')
    expect(captured).toEqual([])
  })
})

// 2026-10-21 (447-06, D-09): `--http 0` is refused inside the serve `try`, so the action composes
// its analytics and its host, then returns through its own `finally` and `catch` without serving.
async function runMcp(
  configPath: string,
  deps: { composeAnalytics: typeof composeAnalyticsHost },
): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand((createMcpCommand as (deps: unknown) => Command)(deps))
    program.exitOverride()
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'mcp', '--http', '0'])
  } finally {
    process.exitCode = previousExitCode
    error.mockRestore()
  }
}

describe('C447-MCP-PRIVACY', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('agent-qa mcp honours analytics.privacy when the config fails validation', async () => {
    const { configPath } = invalidConfigDeclaringPrivacy(roots, { privacy: true })
    const recorder = recordingCompose()

    await runMcp(configPath, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    expect(recorder.hosts[0]?.optOutReasons).toContain('config-privacy')
    expect(recorder.hosts[0]?.transportKind).toBe('none')
  })

  it('agent-qa mcp does not report the config reason when an invalid config declares no privacy', async () => {
    const { configPath } = invalidConfigDeclaringPrivacy(roots)
    const recorder = recordingCompose()

    await runMcp(configPath, { composeAnalytics: recorder.compose })

    expect(recorder.hosts).toHaveLength(1)
    expect(recorder.hosts[0]?.optOutReasons).not.toContain('config-privacy')
    expect(recorder.hosts[0]?.transportKind).toBe('posthog')
  })
})
