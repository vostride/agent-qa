// `composeAnalytics` has one call site here, and an opted-out host writes no identity file.

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentQaVersion } from '@vostride/agent-qa-core'

import {
  analyticsEvent,
  CLI_ANALYTICS_AGENT_QA_VERSION,
  composeAnalyticsHost,
} from '../analytics-host.js'
import type { CliAnalyticsHost } from '../analytics-host.js'
import { createDeclaredSecretMask } from '../declared-secrets.js'
import { createPosthogTransport } from '@vostride/agent-qa-analytics'
import type {
  AgentQaAnalyticsEvent,
  AnalyticsCapturePayload,
  AnalyticsMaskingContext,
  AnalyticsTransport,
} from '@vostride/agent-qa-analytics'

function recordingTransport(): AnalyticsTransport & { readonly sent: AnalyticsCapturePayload[] } {
  const sent: AnalyticsCapturePayload[] = []
  return {
    sent,
    capture(payload) {
      sent.push(payload)
    },
    flush() {},
    shutdown() {},
  }
}

/** The shipped source of this package, comments and all — the call-site censuses read it. */
function shippedSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      shippedSourceFiles(path, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const CLI_SRC = new URL('../../', import.meta.url).pathname

// Roots also call `(deps.composeAnalytics ?? composeAnalyticsHost)(…)`, so the walk skips that `)`.
const COMPOSE_HOST_IDENTIFIER = 'composeAnalyticsHost'

/**
 * The declaring file, excluded BY PATH and deliberately.
 *
 * The census's subject is the CALLERS of that function; its own declaration and header prose are
 * not roots. Doing it by path rather than by "the preceding token is `function`" makes the
 * exclusion legible as a decision instead of an emergent property of a regex.
 */
const COMPOSE_HOST_DECLARING_FILE = 'composition/analytics-host.ts'

/** The five shipped composition roots. Discovered by scanning; pinned here so a sixth reds. */
const PINNED_COMPOSITION_ROOTS = [
  'commands/chat.ts',
  'commands/daemon.ts',
  'commands/init.ts',
  'commands/mcp.ts',
  'commands/run.ts',
]

interface CompositionRootCallSite {
  readonly file: string
  /** The invocation's argument text, from its open paren to the matching close. */
  readonly argumentText: string
}

function sourceLineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index - 1) + 1
  const end = source.indexOf('\n', index)
  return source.slice(start, end === -1 ? source.length : end)
}

/** From the open paren to its matching close, counting parens, braces and brackets. */
function balancedArgumentText(source: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const character = source[i]
    if (character === '(' || character === '{' || character === '[') depth += 1
    else if (character === ')' || character === '}' || character === ']') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, i + 1)
    }
  }
  return ''
}

/** Every shipped call site of `composeAnalyticsHost` in this package, with its argument text. */
function compositionRootCallSites(): CompositionRootCallSite[] {
  const sites: CompositionRootCallSite[] = []
  for (const file of shippedSourceFiles(CLI_SRC)) {
    const relative = file.slice(CLI_SRC.length)
    if (relative === COMPOSE_HOST_DECLARING_FILE) continue
    const source = readFileSync(file, 'utf8')
    const pattern = new RegExp(`\\b${COMPOSE_HOST_IDENTIFIER}\\b`, 'gu')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      // A BINDING IS NOT A ROOT. Any occurrence on a line that also carries `import` covers the
      // four static imports, `init.ts`'s type-only alias and its dynamic-import destructure; a
      // `typeof` before it covers `chat.ts`'s deps-type reference.
      if (sourceLineAt(source, match.index).includes('import')) continue
      if (/\btypeof$/u.test(source.slice(0, match.index).trimEnd())) continue

      let cursor = match.index + COMPOSE_HOST_IDENTIFIER.length
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      // THE STEP THE NAIVE PREDICATE LACKS: the `??`-fallback close.
      if (source[cursor] === ')') {
        cursor += 1
        while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      }
      if (source[cursor] !== '(') continue

      sites.push({ file: relative, argumentText: balancedArgumentText(source, cursor) })
    }
  }
  return sites
}

describe('composeAnalyticsHost', () => {
  it('is the ONLY shipped call site of composeAnalytics in this package', () => {
    const callers = shippedSourceFiles(CLI_SRC)
      .filter((file) => /\bcomposeAnalytics\s*[<(]/u.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(CLI_SRC.length))
      .sort()

    expect(callers).toEqual(['composition/analytics-host.ts'])
  })

  it('reads the same version --version prints — the second reader cannot drift', () => {
    // `analytics-host.ts` reads this package's own manifest rather than calling core's reader,
    // because the surface firewall does not admit core and the barrel that does is too heavy to
    // pull into every command (both reasons are written out at the constant). A second reader is a
    // real cost, and this is what pays it down: the day the two disagree, this reds instead of a
    // version field quietly disagreeing with what `agent-qa --version` prints.
    expect(CLI_ANALYTICS_AGENT_QA_VERSION).toBe(getAgentQaVersion())
  })

  it('mints NO identity file while opted out (the v1 early return, preserved)', async () => {
    const resolveIdentity = vi.fn(async () => ({
      distinctId: 'u_should-never-be-resolved',
      runtimeContext: 'user' as const,
    }))

    const host = await composeAnalyticsHost({
      surface: 'chat',
      env: {},
      config: { analytics: { privacy: true } },
      resolveIdentity,
    })
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 2 }))
    await host.flush()

    expect(resolveIdentity).not.toHaveBeenCalled()
    expect(host.optOutReasons).toEqual(['config-privacy'])
    // The properties still describe the process; what is absent is everything derived from the
    // identity store, because the store was never consulted.
    expect(host.properties.runtime_context).toBeUndefined()
    expect(host.properties.agent_product).toBeUndefined()
  })

  it('mints NO identity file on a blank-key checkout either — the v1 `disabled` set included it', async () => {
    // Not an opt-out (`optedOut` is false and must stay false: a developer who never configured
    // PostHog did not decline tracking). But nothing sends, so nothing needs an identity, and the
    // v1 module wrote none in this state. A rewire gated on `optedOut` alone would start writing
    // `~/.agent-qa/analytics.json` on every checkout that runs a test.
    const resolveIdentity = vi.fn(async () => ({
      distinctId: 'u_should-never-be-resolved',
      runtimeContext: 'user' as const,
    }))

    const host = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      projectKey: '   ',
      resolveIdentity,
    })
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    await host.flush()

    expect(host.optedOut).toBe(false)
    expect(host.transportKind).toBe('none')
    expect(resolveIdentity).not.toHaveBeenCalled()
  })

  it('resolves the identity ONCE on the opted-in arm and stamps it on every event', async () => {
    const transport = recordingTransport()
    const resolveIdentity = vi.fn(async () => ({
      distinctId: 'u_test-identity',
      runtimeContext: 'user' as const,
      agentProduct: 'claude_code' as const,
      isInternal: true,
    }))

    const host = await composeAnalyticsHost({
      surface: 'mcp',
      env: {},
      transportOverride: transport,
      resolveIdentity,
    })

    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.abstained', {
      suggested_row_count: 0,
      catalog_empty: false,
    }))
    await host.flush()

    expect(resolveIdentity).toHaveBeenCalledTimes(1)
    expect(transport.sent.map((payload) => payload.distinctId)).toEqual([
      'u_test-identity',
      'u_test-identity',
    ])
    expect(transport.sent.every((payload) => payload.isInternal === true)).toBe(true)
    expect(host.properties.runtime_context).toBe('user')
    expect(host.properties.agent_product).toBe('claude_code')
    expect(host.properties.surface).toBe('mcp')
    expect(host.properties.$process_person_profile).toBe(false)
  })

  it('masks through the context bound AFTER composition — the run masker does not exist yet at the root', async () => {
    // THE SHIPPED TRANSPORT, over a fake PostHog client. `transportOverride` would replace the very
    // seam under measurement, so this cell constructs the real `PosthogTransport` instead — the
    // masking call it makes is the one a user's events cross.
    const sent: { distinctId: string; event: string }[] = []
    const host = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      projectKey: 'phc_test_key',
      posthogTransportFactory: (options) => createPosthogTransport({
        ...options,
        client: {
          capture: (input) => sent.push({ distinctId: input.distinctId, event: input.event }),
          // The cell measures masking, so both lifecycle calls are inert.
          flush: () => {},
          shutdown: () => {},
        },
      }),
      resolveIdentity: async () => ({
        distinctId: 'hunter2-the-secret',
        runtimeContext: 'user' as const,
      }),
    })
    const transport = { sent }

    // Before the bind: nothing is seeded, so nothing is masked. This is the honest state, not a
    // gap — a host that has not built its run masking context knows no secrets to hide.
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    await host.flush()
    expect(transport.sent[0]?.distinctId).toBe('hunter2-the-secret')

    host.bindMaskingContext({
      mask: (text) => text.replaceAll('hunter2-the-secret', '***'),
    })
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    await host.flush()

    expect(transport.sent[1]?.distinctId).toBe('***')
  })

  it('builds events that carry the standard properties beside the member fields', async () => {
    const transport = recordingTransport()
    const host = await composeAnalyticsHost({
      surface: 'daemon',
      env: {},
      transportOverride: transport,
      resolveIdentity: async () => ({ distinctId: 'u_x', runtimeContext: 'user' as const }),
    })

    const event = analyticsEvent(host, 'agent-qa.daemon.job.completed', {
      job_kind: 'run',
      outcome: 'completed',
    })

    expect(event).toEqual({
      name: 'agent-qa.daemon.job.completed',
      properties: {
        agent_qa_version: host.properties.agent_qa_version,
        surface: 'daemon',
        runtime_context: 'user',
        $process_person_profile: false,
        job_kind: 'run',
        outcome: 'completed',
      },
    })
  })
})

describe('the composition-root census', () => {
  it('discovers EXACTLY the five shipped composition roots — a sixth reds by absence', () => {
    const discovered = compositionRootCallSites()
      .map((site) => site.file)
      .sort()

    expect(
      discovered,
      'The set of shipped call sites of composeAnalyticsHost changed. Adding a composition root '
      + 'means adding its path to PINNED_COMPOSITION_ROOTS here AND verifying it hands over a '
      + 'config (the cell below); a root that is renamed or moved must be renamed here too. This '
      + 'list is what makes "every root honours analytics.privacy" a claim about ALL of them.',
    ).toEqual(PINNED_COMPOSITION_ROOTS)
  })

  it('every composition root hands a config to the one opt-out decision', () => {
    // THE DEFECT THIS RANGES, IN ONE SENTENCE: `analytics.privacy` is a shipped, user-settable
    // field, and a root that composes without passing its config drops the declaration silently
    // while the decision that reads it stays correct one layer below. `packages/analytics`'s
    // zero-network differential cannot see that, because it enters below the dropped argument.
    const sites = compositionRootCallSites()
    const missing = sites
      .filter((site) => !/\bconfig\b/u.test(site.argumentText))
      .map((site) => site.file)
    // A root that satisfies the key by writing the HOLE is the same defect with a spelling.
    const bound = sites
      .filter((site) => /\bconfig\s*:\s*undefined\b/u.test(site.argumentText))
      .map((site) => site.file)

    expect(
      missing,
      'These composition roots call composeAnalyticsHost without handing over a config, so a '
      + "user's analytics.privacy declaration never reaches the decision that reads it: "
      + `${missing.join(', ')}`,
    ).toEqual([])
    expect(
      bound,
      'These composition roots bind config to the absent value, which is the same defect with a '
      + `spelling — pass the resolved config, or omit the key entirely: ${bound.join(', ')}`,
    ).toEqual([])
    // Non-vacuity: the two assertions above are trivially true over an empty scan.
    expect(sites.length).toBe(PINNED_COMPOSITION_ROOTS.length)
  })

  // A source-shape check: removing an awaited drain call fails here with the count named.
  it("drains the memoised analytics host before the run action's terminal exits", () => {
    const runCommand = shippedSourceFiles(CLI_SRC).find(
      (file) => file.slice(CLI_SRC.length) === 'commands/run.ts',
    )
    expect(runCommand, 'commands/run.ts was not reached by the shipped source walk').toBeDefined()
    const source = readFileSync(runCommand as string, 'utf8')

    const declarations = source.match(/\bconst\s+drainAnalytics\s*=/gu) ?? []
    const awaitedCalls = source.match(/\bawait\s+drainAnalytics\s*\(\s*\)/gu) ?? []

    expect(
      declarations.length,
      'commands/run.ts must declare the once-only analytics drain `drainAnalytics` EXACTLY once — '
      + `found ${declarations.length}. Two declarations mean two drains, and the once-only guard `
      + 'stops being once-only.',
    ).toBe(1)
    // SCOPE, STATED IN THE MESSAGE ITSELF. The subject is the run ACTION's three terminal exits
    // (the suite-only path, the verdict path, the catch). It is NOT "every process.exit in this
    // file": run.ts carries ~28 of them, a dozen upstream of `executeSuites` where nothing is
    // composed yet, plus FOUR cancellation exits this round knowingly leaves undrained —
    // `run.ts:1184`/`:1187` inside `executeSuites`' shutdown controller and `run.ts:3483`/`:3486`
    // inside the one the action installs. A message implying the file's exit set is complete would
    // be false the moment a reader trusted it.
    expect(
      awaitedCalls.length,
      'At least three of the run ACTION\'s terminal exits must await the once-only analytics drain '
      + `\`await drainAnalytics()\` — found ${awaitedCalls.length}. This cell ranges the ACTION's `
      + 'three terminal exits (the suite-only path, the verdict path, the catch) and NOT the file\'s '
      + 'whole process.exit set: the four cancellation exits carried by the two shutdown '
      + 'controllers are deliberately out of scope, because they are user-initiated cancels where '
      + 'telemetry loss is the accepted failure direction and a drain awaited in a signal handler '
      + 'would unbound Ctrl+C.',
    ).toBeGreaterThanOrEqual(3)
  })
})

interface SentEvent {
  readonly distinctId: string
  readonly event: string
  readonly properties: Record<string, unknown>
}

const c441Roots: string[] = []

afterAll(() => {
  for (const root of c441Roots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function declaringProject(secrets: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-441-analytics-'))
  c441Roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    [
      'workspace:',
      "  testMatch: ['tests/**/*.yaml']",
      "  suiteMatch: ['suites/**/*.yaml']",
      '  hooksFile: hooks.yaml',
      '  envFile: .env.local',
      '  secretsFile: .secrets.local',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'hooks.yaml'), '')
  writeFileSync(join(root, '.env.local'), '')
  writeFileSync(join(root, '.secrets.local'), secrets)
  return configPath
}

function fakeClient(sent: SentEvent[]) {
  return {
    capture: (input: SentEvent) => sent.push(input),
    flush: () => {},
    shutdown: () => {},
  }
}

async function shippedSendPath(
  maskingContext: AnalyticsMaskingContext,
): Promise<{ host: CliAnalyticsHost; sent: SentEvent[] }> {
  const sent: SentEvent[] = []
  const host = await composeAnalyticsHost({
    surface: 'chat',
    env: {},
    maskingContext,
    projectKey: 'phc_test_key',
    posthogTransportFactory: (options) =>
      createPosthogTransport({ ...options, client: fakeClient(sent) }),
    resolveIdentity: async () => ({ distinctId: 'u_c441', runtimeContext: 'user' as const }),
  })
  return { host, sent }
}

function eventCarrying(host: CliAnalyticsHost, text: string): AgentQaAnalyticsEvent {
  const event = analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 })
  return {
    ...event,
    properties: { ...event.properties, planted_text: `before ${text} after` },
  } as AgentQaAnalyticsEvent
}

describe('declared secrets in analytics payloads', () => {
  it('a declared value in an analytics property leaves as its named marker', async () => {
    const configPath = declaringProject('SHORT_441=q^7\n')
    const { host, sent } = await shippedSendPath({ mask: createDeclaredSecretMask(configPath).mask })
    const event = eventCarrying(host, 'q^7')

    host.port.capture(event)
    await host.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.event).toBe('agent-qa.explain.answered')
    expect(Object.keys(sent[0]!.properties).sort()).toEqual(Object.keys(event.properties).sort())
    expect(sent[0]?.properties.planted_text).toBe('before [secret:SHORT_441] after')
    expect(JSON.stringify(sent)).not.toContain('q^7')
  })

  it('an environment-only value is not masked in an analytics payload', async () => {
    vi.stubEnv('AGENT_QA_X_PASSWORD', 'env-only-value-441')
    const configPath = declaringProject('SHORT_441=q^7\n')
    const { host, sent } = await shippedSendPath({ mask: createDeclaredSecretMask(configPath).mask })

    host.port.capture(eventCarrying(host, process.env.AGENT_QA_X_PASSWORD!))
    await host.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.properties.planted_text).toBe('before env-only-value-441 after')
  })

  it('a mask that throws drops the event', async () => {
    const throwing: AnalyticsMaskingContext = {
      mask: () => {
        throw new Error('secrets file became unreadable')
      },
    }
    const { host, sent } = await shippedSendPath(throwing)

    expect(() => host.port.capture(eventCarrying(host, 'anything'))).not.toThrow()
    await host.flush()
    expect(sent).toEqual([])

    const direct: SentEvent[] = []
    const transport = createPosthogTransport({
      projectKey: 'phc_test_key',
      host: 'https://example.invalid',
      maskingContext: throwing,
      client: fakeClient(direct),
    })
    expect(() =>
      transport.capture({ distinctId: 'u_c441', event: eventCarrying(host, 'anything') }),
    ).not.toThrow()
    expect(direct).toEqual([])
  })
})

describe('an opted-out host builds no transport', () => {
  it('an opted-out or blank-key host constructs no transport and resolves no identity', async () => {
    const optedOutFactory = vi.fn(() => recordingTransport())
    const override = { capture: vi.fn(), flush: vi.fn(), shutdown: vi.fn() }
    const optedOutResolver = vi.fn(async () => ({
      distinctId: 'u_should-never-be-resolved',
      runtimeContext: 'user' as const,
    }))
    const optedOut = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      config: { analytics: { privacy: true } },
      projectKey: 'phc_cell',
      posthogTransportFactory: optedOutFactory,
      transportOverride: override,
      resolveIdentity: optedOutResolver,
    })
    optedOut.port.capture(
      analyticsEvent(optedOut, 'agent-qa.explain.answered', { cited_row_count: 1 }),
    )
    await optedOut.flush()
    await optedOut.shutdown()

    expect(optedOut.optedOut).toBe(true)
    expect(optedOut.optOutReasons).toEqual(['config-privacy'])
    expect(optedOut.transportKind).toBe('none')
    expect(optedOutFactory).not.toHaveBeenCalled()
    expect(override.capture).not.toHaveBeenCalled()
    expect(override.flush).not.toHaveBeenCalled()
    expect(override.shutdown).not.toHaveBeenCalled()
    expect(optedOutResolver).not.toHaveBeenCalled()

    const keylessFactory = vi.fn(() => recordingTransport())
    const keylessResolver = vi.fn(async () => ({
      distinctId: 'u_should-never-be-resolved',
      runtimeContext: 'user' as const,
    }))
    const keyless = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      projectKey: '   ',
      posthogTransportFactory: keylessFactory,
      resolveIdentity: keylessResolver,
    })
    keyless.port.capture(
      analyticsEvent(keyless, 'agent-qa.explain.answered', { cited_row_count: 1 }),
    )
    await keyless.flush()
    await keyless.shutdown()

    expect(keyless.optedOut).toBe(false)
    expect(keyless.optOutReasons).toEqual([])
    expect(keyless.transportKind).toBe('none')
    expect(keylessFactory).not.toHaveBeenCalled()
    expect(keylessResolver).not.toHaveBeenCalled()
  })
})

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('identity resolution is bounded', () => {
  it('a stalled identity resolution releases composition at the bound and nothing is sent under any id', async () => {
    // Loaded before the clock is faked, so a dynamic import by the host resolves from the cache.
    await import('@vostride/agent-qa-agent-local')
    const transport = recordingTransport()
    let called = false
    const resolveIdentity = () => {
      called = true
      return new Promise<never>(() => {})
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const composing = composeAnalyticsHost({
        surface: 'cli',
        env: {},
        transportOverride: transport,
        resolveIdentity,
      }).then((host) => {
        settled = true
        return host
      })
      for (let turn = 0; !called && turn < 1000; turn += 1) await nextTurn()
      expect(called).toBe(true)

      await vi.advanceTimersByTimeAsync(999)
      await nextTurn()
      expect(settled, 'composition settled before the bound').toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      for (let turn = 0; !settled && turn < 1000; turn += 1) await nextTurn()
      expect(settled, 'composition is still pending at 1000 ms').toBe(true)

      const host = await composing
      host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
      await host.flush()

      expect(host.transportKind).toBe('posthog')
      expect(host.properties.runtime_context).toBeUndefined()
      expect(transport.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
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

function clearCiMarkers(): void {
  for (const name of CI_MARKERS) vi.stubEnv(name, '')
}

const c447Roots: string[] = []

afterAll(() => {
  for (const root of c447Roots) rmSync(root, { recursive: true, force: true })
})

describe('CI classification through the execution-context detector', () => {
  it('the host classifies CI through the execution-context detector and passes it to identity resolution', async () => {
    const arms: {
      readonly label: string
      readonly markers: Readonly<Record<string, string>>
      readonly env?: Readonly<Record<string, string>>
      readonly ci: boolean
    }[] = [
      { label: 'markers cleared', markers: {}, ci: false },
      { label: 'CI=1', markers: { CI: '1' }, ci: true },
      { label: 'JENKINS_URL alone', markers: { JENKINS_URL: 'http://ci.invalid' }, ci: true },
      { label: 'CI only in the host env input', markers: {}, env: { CI: 'true' }, ci: false },
    ]

    for (const arm of arms) {
      clearCiMarkers()
      for (const [name, value] of Object.entries(arm.markers)) vi.stubEnv(name, value)
      const resolveIdentity = vi.fn(async () => ({
        distinctId: 'u_ci-detector-cell',
        runtimeContext: 'user' as const,
      }))

      const host = await composeAnalyticsHost({
        surface: 'cli',
        env: arm.env ?? {},
        projectKey: 'phc_cell',
        posthogTransportFactory: () => ({ capture: () => {}, flush: () => {}, shutdown: () => {} }),
        resolveIdentity,
      })

      expect(host.transportKind, arm.label).toBe('posthog')
      expect(resolveIdentity, arm.label).toHaveBeenCalledTimes(1)
      expect(resolveIdentity, arm.label).toHaveBeenCalledWith(
        expect.objectContaining({ ci: arm.ci }),
      )
    }
  })
})

describe('distinct CI identities per composition', () => {
  it('two CI compositions carry two different ci_ ids, each one stable across its own events', async () => {
    vi.stubEnv('CI', '1')
    const home = mkdtempSync(join(tmpdir(), 'agent-qa-447-ci-home-'))
    c447Roots.push(home)

    const ids: string[] = []
    for (let composition = 0; composition < 2; composition += 1) {
      const transport = recordingTransport()
      const host = await composeAnalyticsHost({
        surface: 'cli',
        env: { XDG_DATA_HOME: home },
        transportOverride: transport,
      })
      host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
      host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 2 }))
      await host.flush()

      expect(transport.sent).toHaveLength(2)
      const [first, second] = transport.sent.map((payload) => payload.distinctId)
      expect(first).toMatch(/^ci_/)
      expect(second).toBe(first)
      expect(host.properties.runtime_context).toBe('ci')
      ids.push(first as string)
    }

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(existsSync(join(home, 'agent-qa'))).toBe(false)
  })
})
