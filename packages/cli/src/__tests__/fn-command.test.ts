// End-to-end tracer for the 384 function layer (Plan 01, D-05/D-06/D-11).
//
// `agent-qa fn runs.list` must resolve through the WHOLE path — composition-built
// registry → invokeFunction → evaluate() → injected run-dir reader → RunSummary[] —
// against a real on-disk fixture. Nothing here stubs the gate or the registry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The unfenced compatibility composition is test-only and intentionally absent from the
// knowledge-local package barrel. This fixture imports its internal test seam directly.
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import { EVENTS_FILE, RUNS_SUBDIR } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  KnowledgeBundleSummary,
  MaskedResolvedConfig,
  RunEventEnvelope,
  RunEventType,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFnCommand } from '../commands/fn.js'

/** The one value the fixture's secrets file declares, as `ACME_API_KEY`. */
const FIXTURE_API_KEY = 'sk-live-DO-NOT-LEAK-4242'
const FIXTURE_API_KEY_MARKER = '[secret:ACME_API_KEY]'

// 2026-10-15 (441-20, D-29): every other credential-shaped value below is undeclared, so
// `config.get` shows it as written. They stay in the fixture as the undeclared corpus.
const FIXTURE_HEADER_KEY = 'sk-live-HEADER-KEY-DO-NOT-LEAK-1111'
const FIXTURE_HEADER_CRED = 'sk-live-HEADER-CRED-DO-NOT-LEAK-2222'
const FIXTURE_HEADER_PWD = 'sk-live-HEADER-PWD-DO-NOT-LEAK-3333'
const FIXTURE_PROVIDER_KEY = 'sk-live-PROVIDER-KEY-DO-NOT-LEAK-5555'
const FIXTURE_URL_PASSWORD = 'hunter2-URL-DO-NOT-LEAK'

/** Values in the query, fragment and userinfo of absolute URLs. */
const FIXTURE_URL_QUERY_SECRET = 'sk-live-TICKET-DO-NOT-LEAK-7001'
const FIXTURE_URL_FRAGMENT_SECRET = 'sk-live-FRAGMENT-DO-NOT-LEAK-7002'
const FIXTURE_TARGET_URL_SECRET = 'sk-live-SSO-DO-NOT-LEAK-7003'

/** Values in protocol-relative, host-relative, path-relative and opaque-scheme URLs. */
const FIXTURE_PROTOREL_USERINFO_SECRET = 'sk-live-USERINFO-DO-NOT-LEAK-7101'
const FIXTURE_PROTOREL_QUERY_SECRET = 'sk-live-WAYBILL-DO-NOT-LEAK-7102'
const FIXTURE_PROTOREL_FRAGMENT_SECRET = 'sk-live-HALLMARK-DO-NOT-LEAK-7103'
const FIXTURE_HOST_RELATIVE_SECRET = 'sk-live-EMBLEM-DO-NOT-LEAK-7104'
const FIXTURE_PATH_RELATIVE_SECRET = 'sk-live-LANYARD-DO-NOT-LEAK-7105'
const FIXTURE_OPAQUE_SCHEME_SECRET = 'sk-live-OPAQUE-DO-NOT-LEAK-7106'

/** Values in the path of a URL. */
const FIXTURE_PATH_BORNE_TARGET_SECRET = 'sk-live-CARTOUCHE-DO-NOT-LEAK-7201'
const FIXTURE_PROTOREL_PATH_SECRET = 'sk-live-TRELLIS-DO-NOT-LEAK-7202'
const FIXTURE_KEY_IN_PATH_SECRET = 'sk-live-OBELISK-DO-NOT-LEAK-7203'

/** Ordinary glob, ignore-glob and CSS-selector values on the fields that take them. */
const FIXTURE_GLOB_WILDCARD = 'tests/**/case-?.yaml'
const FIXTURE_IGNORE_GLOB = 'tests/legacy#old/**'
const FIXTURE_CSS_SELECTOR = '#cookie-banner'

const FIXTURE_CLEAN_TARGET_URL = 'https://clean.acme.test'

/** Credential-shaped values under every key an android device's `match` allows. */
const FIXTURE_DEVICE_MATCH_CREDENTIALS: Record<string, string> = {
  avd: 'sk-live-AVD-DO-NOT-LEAK-0001',
  serial: 'sk-live-SERIAL-DO-NOT-LEAK-0002',
  appPackage: 'sk-live-APPPACKAGE-DO-NOT-LEAK-0003',
  appActivity: 'sk-live-APPACTIVITY-DO-NOT-LEAK-0004',
  automationName: 'sk-live-AUTOMATION-DO-NOT-LEAK-0005',
  browserName: 'sk-live-BROWSER-DO-NOT-LEAK-0006',
  platformVersion: 'sk-live-PLATFORMVERSION-DO-NOT-LEAK-0007',
}

/**
 * Two plugin package names, which are the opposite claim (Plan 10 / M-01).
 *
 * Both name packages that load in-process with full Node access, so both belong in the
 * output of the one capability whose purpose is configuration triage. Round 2 hid the first
 * and showed the second, purely because the word `auth` appeared in one path.
 */
const FIXTURE_AUTH_PLUGIN_PACKAGE = '@acme/auth-plugin-SHOW-ME-1234'
const FIXTURE_PROVIDER_PLUGIN_PACKAGE = '@acme/provider-plugin-SHOW-ME-5678'

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
}

interface FixtureWorkspace {
  root: string
  configPath: string
  runtimeRoot: string
  knowledgeRoot: string
}

function fixtureWorkspace(roots: string[]): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-fn-command-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        // A required field whose value carries the standard glob wildcard, and an ignore
        // glob carrying a '#'. Round 5 masked both (CR-02).
        testMatch: [FIXTURE_GLOB_WILDCARD],
        testPathIgnore: [FIXTURE_IGNORE_GLOB],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      // A CSS selector on the field that takes CSS selectors — the third CR-02 value.
      services: {
        accessibility: { enabled: false, exclude: [FIXTURE_CSS_SELECTOR] },
      },
      registry: {
        llms: [
          {
            name: 'judge',
            // `anthropic-compatible` is the one provider family allowed to carry
            // providerHeaders, and a compatible provider requires a baseURL — so this is
            // the schema-legal shape a real operator credential arrives in.
            provider: 'anthropic-compatible',
            model: 'claude-fixture',
            // Userinfo, a query string AND a fragment, all on one schema-visible field:
            // the three parts of a URL that belong to no key, so no name-based rule can
            // ever reach them.
            baseURL: `https://ops:${FIXTURE_URL_PASSWORD}@llm.acme.test/v1?ticket=${FIXTURE_URL_QUERY_SECRET}#assertion=${FIXTURE_URL_FRAGMENT_SECRET}`,
            providerHeaders: {
              'x-key': FIXTURE_HEADER_KEY,
              'x-cred': FIXTURE_HEADER_CRED,
              'x-pwd': FIXTURE_HEADER_PWD,
              'x-acme-access': FIXTURE_API_KEY,
              'x-acme-key': FIXTURE_PROVIDER_KEY,
              'x-acme-origin': 'https://acme.test',
            },
          },
          // Two more schema-legal entries carrying baseURLs the URL parser will NOT resolve
          // absolutely (round-4 CR-01). `anthropic-compatible` requires a baseURL and the
          // schema puts no URL format on it, so these are shapes a real config file holds.
          {
            name: 'host-relative-judge',
            provider: 'anthropic-compatible',
            model: 'claude-fixture',
            baseURL: `llm.acme.test/v1?emblem=${FIXTURE_HOST_RELATIVE_SECRET}`,
          },
          {
            // The form that PARSES: scheme `ops:` with an opaque path, so the credential
            // before the first '@' rides in `pathname` where a userinfo check cannot see it.
            name: 'opaque-scheme-judge',
            provider: 'anthropic-compatible',
            model: 'claude-fixture',
            baseURL: `ops:${FIXTURE_OPAQUE_SCHEME_SECRET}@llm.acme.test/v1`,
          },
          {
            // A key written into the PATH of an absolute base — the component rounds 3 and 4
            // both KEPT. Appended last so the round-4 indices above stay stable.
            name: 'key-in-path-judge',
            provider: 'anthropic-compatible',
            model: 'claude-fixture',
            baseURL: `https://ops.acme.test/v1/keys/${FIXTURE_KEY_IN_PATH_SECRET}`,
          },
        ],
        // A web target requires a url, so this is the schema-legal shape the SECOND
        // credential-bearing visible field arrives in.
        targets: {
          web: {
            platform: 'web',
            url: `https://x.test/checkout?sso=${FIXTURE_TARGET_URL_SECRET}`,
          },
          // A protocol-relative url carrying all three no-key parts at once, and a
          // path-relative one carrying a query — neither resolves without a base, so round
          // 3's rule never looked at either (round-4 CR-01).
          'protocol-relative': {
            platform: 'web',
            url: `//opsx:${FIXTURE_PROTOREL_USERINFO_SECRET}@x.test/checkout`
              + `?waybill=${FIXTURE_PROTOREL_QUERY_SECRET}`
              + `#hallmark=${FIXTURE_PROTOREL_FRAGMENT_SECRET}`,
          },
          'path-relative': {
            platform: 'web',
            url: `/checkout?lanyard=${FIXTURE_PATH_RELATIVE_SECRET}`,
          },
          // A webhook token in the PATH of an absolute url, and the same in a
          // protocol-relative one — the round-5 CR-03 pair.
          hook: {
            platform: 'web',
            url: `https://hooks.acme.test/services/T00/B00/${FIXTURE_PATH_BORNE_TARGET_SECRET}`,
          },
          relhook: {
            platform: 'web',
            url: `//hooks.acme.test/services/${FIXTURE_PROTOREL_PATH_SECRET}`,
          },
          clean: { platform: 'web', url: FIXTURE_CLEAN_TARGET_URL },
        },
        devices: {
          pixel: {
            platform: 'android',
            match: FIXTURE_DEVICE_MATCH_CREDENTIALS,
          },
        },
      },
      plugins: {
        auth: [{ package: FIXTURE_AUTH_PLUGIN_PACKAGE }],
        providers: [{ package: FIXTURE_PROVIDER_PLUGIN_PACKAGE }],
      },
      // The config schema's superRefine requires this leaf, so a resolvable fixture
      // must carry it before `config.get` can read anything at all.
      use: { mobile: { appState: 'preserve' } },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), `ACME_API_KEY=${FIXTURE_API_KEY}\n`, 'utf8')
  return {
    root,
    configPath,
    runtimeRoot: join(root, '.agent-qa'),
    // `knowledge.dir` defaults to the repo-relative `agent-qa-knowledge` beside the config.
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
  }
}

/** Commit one real bundle so the knowledge listing has a row that came off disk. */
function seedKnowledgeBundle(workspace: FixtureWorkspace): string {
  const outcome = publishBundle(
    {
      knowledgeRoot: workspace.knowledgeRoot,
      productKey: 'shop',
    },
    {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [
          { t: 'el', role: 'Button', name: 'Checkout Now' },
          { t: 'page', route: '/cart' },
        ],
        scope: { tier: 'product', key: 'checkout' },
        summary: 'Checkout control on the cart page',
        body: 'Selecting Checkout Now advances the cart to the payment step.',
        distilledEvidenceRef: {
          id: 'fn-command-fixture',
          sha: 'd9113d37fe29084657c462ac5628ddd56519aeafad8883092a2596075878cbee',
        },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Checkout Now' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 5,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'fn-command-fixture',
        testId: 'fn-command',
        stepIndex: 0,
      },
      artifacts: [],
    },
  )

  expect(outcome.kind).toBe('published')
  if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
  return outcome.id
}

function handoff(input: {
  runId: string
  buildOrdinal: number
  aggregateVerdict: CompletedRunHandoff['aggregateVerdict']
  tests?: CompletedRunHandoff['tests']
  gateRun?: true
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: input.buildOrdinal,
    ...(input.gateRun === undefined ? {} : { gateRun: input.gateRun }),
    executionContext: 'local-headless',
    aggregateVerdict: input.aggregateVerdict,
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1_000 + input.buildOrdinal,
    endedAt: 2_000 + input.buildOrdinal,
    tests: input.tests ?? [],
  }
}

function seedRuns(workspace: FixtureWorkspace, handoffs: readonly CompletedRunHandoff[]): void {
  for (const document of handoffs) {
    const dir = join(workspace.runtimeRoot, RUNS_SUBDIR, document.runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'handoff.json'), `${JSON.stringify(document)}\n`, 'utf8')
  }
}

function envelope(runId: string, seq: number, type: RunEventType): RunEventEnvelope {
  return { seq, ts: 1_700_000_000_000 + seq, runId, type, payload: {} }
}

/**
 * Write a real `events.jsonl` in the exact layout the v49 `FsEventLog` appends — one JSON
 * envelope per line, seq-ordered and gap-free at 1. The stream op reads it back through the
 * same concrete store the runner writes it with, so the CLI leg is a genuine replay.
 */
function seedEvents(
  workspace: FixtureWorkspace,
  runId: string,
  events: readonly RunEventEnvelope[],
): void {
  const dir = join(workspace.runtimeRoot, RUNS_SUBDIR, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, EVENTS_FILE),
    events.map((event) => `${JSON.stringify(event)}\n`).join(''),
    'utf8',
  )
}

/** Five gap-free envelopes for `run-alpha`, the shape a completed run leaves behind. */
function fiveEvents(runId = 'run-alpha'): RunEventEnvelope[] {
  return [
    envelope(runId, 1, 'runStarted'),
    envelope(runId, 2, 'testStarted'),
    envelope(runId, 3, 'stepStarted'),
    envelope(runId, 4, 'testFinished'),
    envelope(runId, 5, 'runFinished'),
  ]
}

async function invoke(
  workspace: FixtureWorkspace,
  args: readonly string[],
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

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createFnCommand())
    program.exitOverride()
    await program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      workspace.configPath,
      'fn',
      ...args,
    ])
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe('agent-qa fn (generic function invoker)', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves runs.list end-to-end against two on-disk handoffs', async () => {
    const workspace = fixtureWorkspace(roots)
    seedRuns(workspace, [
      handoff({ runId: 'run-beta', buildOrdinal: 12, aggregateVerdict: 'failed' }),
      handoff({ runId: 'run-alpha', buildOrdinal: 11, aggregateVerdict: 'passed' }),
    ])

    const result = await invoke(workspace, ['runs.list', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const summaries = JSON.parse(result.stdout) as {
      runId: string
      buildOrdinal: number
      aggregateVerdict: string
      testCount: number
    }[]
    // 431 D-08: newest finished first; the fixture's run-beta ended after run-alpha.
    expect(summaries.map((summary) => summary.runId)).toEqual(['run-beta', 'run-alpha'])
    expect(summaries[1]).toMatchObject({
      runId: 'run-alpha',
      buildOrdinal: 11,
      aggregateVerdict: 'passed',
      testCount: 0,
    })
    expect(summaries[0]).toMatchObject({ runId: 'run-beta', aggregateVerdict: 'failed' })
  })

  it('emits a deterministic listing for a fixed fixture', async () => {
    const workspace = fixtureWorkspace(roots)
    seedRuns(workspace, [
      handoff({ runId: 'run-beta', buildOrdinal: 12, aggregateVerdict: 'failed' }),
      handoff({ runId: 'run-alpha', buildOrdinal: 11, aggregateVerdict: 'passed' }),
    ])

    const first = await invoke(workspace, ['runs.list', '--json'])
    const second = await invoke(workspace, ['runs.list', '--json'])

    expect(first).toEqual(second)
  })

  // RE-SPELLED 2026-10-01 (432-20, D-12) from 'lists every registered function id with its scopes,
  // result kind and binding'. Declarations carry no scopes, so the listing has no scope column.
  it('lists every registered function id with its result kind and binding, and no scope column', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['--list', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).not.toContain('requiredScopes')
    const declarations = JSON.parse(result.stdout) as {
      id: string
      resultKind: string
      bindingStatus: string
    }[]
    // The registered capability set verbatim: the four D-06 seed reads, the D-08 stream op,
    // 387-01's two `entities.` reads, and 387-06's three `knowledge.` review reads.
    // `resultKind` and `bindingStatus` are part of the
    // published contract, so the listing is asserted as an exact table rather than a shape
    // check — a contains check would let an op join the catalogue unnoticed, which is the one
    // drift direction this case exists to catch. Every phase that adds an op repins it here on
    // purpose; 387-06 and 387-08 each add more and will each have to.
    expect(Object.fromEntries(declarations.map((declaration) => [declaration.id, {
      resultKind: declaration.resultKind,
      bindingStatus: declaration.bindingStatus,
    }]))).toEqual({
      // 392 D-24: the chat turn entry, BOUND on this host because `composeLocalAgent` assembles a
      // turn engine in every local composition. Its presence in the CLI's own catalog is the L10
      // claim made observable: `agent-qa ask` reaches the turn through the same registry listing
      // this test reads, so the REPL holds no capability the catalogue does not declare.
      'agent.ask': { resultKind: 'unary', bindingStatus: 'bound' },
      // 398 D-09: the catalog explainer. BOUND on this host, and — like `runs.start` below — not
      // because a literal was flipped: `composeCliLocalAgent` constructs the catalog port
      // unconditionally, because a CLI always ships beside the committed capability catalog. It
      // read `unbound` between 398-07's Task 1 and Task 2, which is the whole point of computing
      // the column: the capability was registered before this host could run it, and the ledger
      // said so for exactly that long.
      'agent.explain': { resultKind: 'unary', bindingStatus: 'bound' },
      // 389 D-11: THE analysis read — verdicts + sentences + clusters. BOUND since plan 06:
      // the composition root binds the artifact reader over `agentQaRoot` in every local
      // composition, so an artifact-less run answers the floor rather than a refusal.
      'analysis.get': { resultKind: 'unary', bindingStatus: 'bound' },
      // 393 D-01: the keep-gate evaluator. BOUND on this host, and — like `runs.start` below — not
      // because a literal was flipped: this composition supplies BOTH halves the binding needs, a
      // run executor and the draft-authoring port over `parseTestFile`, and `bindingStatus` reports
      // what THIS host can do. The same capability still lists `unbound` from a composition missing
      // either, which is what agent's `parity-coverage.test.ts` and 393-07's e2e both assert.
      //
      // It declares BOTH `run` and `read` because the evaluation starts gate-runs and reads their
      // records back through the sibling ops (D-02, op-calls-op), which also makes it non-read and
      // therefore filtered out of safe mode with `runs.start`.
      'authoring.draft.verify': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 394 D-01: the authoring loop's one public entry, BOUND on this host for the reason its
      // sibling above is — the CLI supplies the draft-authoring port and a run executor, which is
      // the same condition both halves of the loop bind under. It declares a THIRD scope,
      // `test-write`, because it writes a file where its sibling only starts runs; 394-01 minted
      // that scope for exactly this declaration, and it is what a listing shows a person who asks
      // what authoring a test costs them.
      'authoring.draft.write': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 394-09 D-21 · WTST-07: the user-facing edit. BOUND on this host for its siblings' reason —
      // the CLI supplies the draft-authoring port and the draft evaluation, which are the two
      // halves this op checks. It declares TWO scopes and NOT `run`: it edits a committed test and
      // starts nothing, so a listing shows a person that letting the agent edit their tests does
      // not also buy it the power to spend their machine on runs.
      'authoring.draft.edit': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 394-07 D-12/D-13 · WTST-05: the honesty funnel read. BOUND on this host and — unlike its
      // two authoring siblings above — bound UNCONDITIONALLY, because it is a read over records
      // this composition owns by owning the agent-qa runtime root rather than a capability that
      // needs a model and a run executor. It declares `read` ALONE, which is what a listing shows
      // a person who asks what reading their own authoring history costs them; the exposure it
      // implies is stated in the op's own header so a reviewer can object to the tier.
      'authoring.funnel.get': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 395-01 D-01/D-03 · CFGM-01/03: both BOUND on this composition — the CLI host binds the
      // config-file, validation and apply ports unconditionally, because a CLI always has a config
      // path and therefore a checkout root. Both declare `config-write` and NOT `read`, which is
      // what a listing shows a person who asks what editing their configuration costs them: the
      // propose op carries the write scope because the scope describes what the CAPABILITY is
      // about, not what one call happens to reach.
      'config.auth.set': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'config.field.set': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'config.hook.add': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'config.get': { resultKind: 'unary', bindingStatus: 'bound' },
      // 395-08 D-04: BOUND, because `scaffoldContent` needs no filesystem and no repository — it is
      // a pure render of the one producer `agent-qa init` writes from, so there is no CLI posture
      // in which the scaffold is unavailable.
      'config.project.scaffold': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 2026-10-01 (432-17 D-05): `config.proposal.apply`, `config.undo.propose`,
      // `knowledge.proposal.apply` and the four `proposals.*` verbs are deleted, so they are not listed.
      // 395-05 D-01: the rest of the closed action class, BOUND on this composition for the reason
      // above — the CLI host binds the config ports unconditionally. Both carry `config-write` and
      // nothing else, which is what a listing shows a person who asks what letting the agent edit
      // their configuration costs them.
      'config.target.create': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'config.target.edit': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // BOUND because `entities` is a REQUIRED FunctionDeps port (387-01 D-4): this
      // composition supplies an entity directory, so both read at the `read` tier.
      'entities.get': { resultKind: 'unary', bindingStatus: 'bound' },
      'entities.resolve': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 391 PROP-01 / D-03's `grants.list` and `grants.revoke` rows left with the ops (432-18).
      'knowledge.bundles.list': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 416 D-10: gate receipts are a read over the same bound knowledge reader.
      'knowledge.gates.list': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 387-06 KREV-01: the read half of the review-verb family. BOUND for the same reason
      // the entity pair is — they dispatch through the REQUIRED `knowledge` port, so no
      // composition lists them and then refuses. 387-08's mutating verbs go through the
      // OPTIONAL `knowledgeReview` dep and are the first rows here that can read `unbound`.
      'knowledge.brief.why': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'knowledge.record.show': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'knowledge.records.diff': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'knowledge.records.inspect': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 387-08 KREV-01 D-17: the MUTATING half — `knowledge-write` tier, and BOUND here because
      // the CLI composes a local host that owns the knowledge root it serves from. They are the
      // first rows in this table whose binding is a statement about the HOST rather than about
      // the required-port set: a read-only composition lists these same four `unbound`, which is
      // asserted directly in agent-local's `review-verbs.test.ts`.
      // 2026-09-30, 432-12 (D-05): the three changes apply in the call and lose `.propose`.
      'knowledge.accept': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'knowledge.forget': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'knowledge.reject': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 390 D-12/D-13: the three quarantine verbs, FLIPPED to bound by plan 06 (plan 04
      // registered the specs and left this row saying so). BOUND here for the same reason the
      // knowledge-write rows above are — the CLI composes a local host that owns the committed
      // knowledge root the ledger lives at — and the binding is a statement about THIS host: a
      // composition supplying no quarantine port still lists all three `unbound` and refuses
      // them by name, which is what agent's `parity-coverage.test.ts` asserts.
      'quarantine.add': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'quarantine.list': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      'quarantine.release': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // 391 D-16: BOUND on every local host. Read-tier, so it survives safe mode. (Its inbox dep
      // was deleted in 432-17; the digest never read it after 432-09.)
      // 405-05 D-12/D-13: BOUND here: a run's evidence blobs live under the runtime root EVERY
      // local host has.
      'runs.artifact': { resultKind: 'unary', bindingStatus: 'bound' },
      // 431-15: bound — this host binds a reader over the configured or default runs database path whenever the config parses; a read before that file exists answers not recorded in it.
      'runs.detail': { resultKind: 'unary', bindingStatus: 'bound' },
      'runs.digest': { resultKind: 'unary', bindingStatus: 'bound' },
      'runs.events': { resultKind: 'stream', bindingStatus: 'bound' },
      // 431-15: bound — this host binds a reader over the configured or default runs database path whenever the config parses; a read before that file exists answers not recorded in it.
      'runs.evidence': { resultKind: 'unary', bindingStatus: 'bound' },
      'runs.get': { resultKind: 'unary', bindingStatus: 'bound' },
      // 407-01 D-05: `bound` rather than `unbound`, and that is the row worth reading. The op
      // declares no optional-dep binding key — its substrate is the REQUIRED runs port — so unlike
      // `runs.detail` beside it there is no composition that lists this verb and then refuses it.
      'runs.knowledge': { resultKind: 'unary', bindingStatus: 'bound' },
      'runs.list': { resultKind: 'unary', bindingStatus: 'bound' },
      'runs.mark': { resultKind: 'unary', bindingStatus: 'bound' },
      // 423 D-16: the consequence preview binds through the same read host, read-tier beside the writer.
      'runs.mark.preview': { resultKind: 'unary', bindingStatus: 'bound' },
      // 423 D-19: bound through the CLI's dedicated read host, read-tier beside the writer.
      'runs.marks.history': { resultKind: 'unary', bindingStatus: 'bound' },
      // 431-15: bound — this host binds a reader over the configured or default runs database path whenever the config parses; a read before that file exists answers not recorded in it.
      'runs.overview': { resultKind: 'unary', bindingStatus: 'bound' },
      // 403 D-03: UNBOUND from this composition, and that is the honest answer rather than an
      // oversight. `runs.liveurl` mints a viewing credential for a LIVE run, so it binds only where
      // a live-view port exists — `agent-qa dashboard`'s `composeLiveView`. A CLI host with no
      // server to serve the embed page from has nothing to mint a link TO, and says so.
      'runs.liveurl': { resultKind: 'unary', bindingStatus: 'unbound' },
      // 428 D-07: UNBOUND here on runs.liveurl's reasoning. A live editor binds only where the
      // dashboard serves one, so a plain CLI host has no editor session to mint a link for.
      'editor.liveurl': { resultKind: 'unary', bindingStatus: 'unbound' },
      // 388 D-14: BOUND on every local host, and NOT gated on whether this one drains the
      // chain — the two are different questions, and a host that only ever reads is exactly
      // the caller that most needs durable chip truth. Read-tier, so it survives safe mode.
      'runs.postprocessing': {
        resultKind: 'unary',
        bindingStatus: 'bound',
      },
      // BOUND since 385 plan 10 (D-16). Not because a literal was flipped — because this
      // composition supplies a run executor, and `bindingStatus` reports what THIS host can
      // do. The same capability still lists `unbound` from a composition without one, which
      // is what compose-local-agent.test.ts and the agent-layer suites assert.
      'runs.start': { resultKind: 'unary', bindingStatus: 'bound' },
    })
    // Sorted lexicographically by id, so a catalog projection is deterministic.
    expect(declarations.map((declaration) => declaration.id)).toEqual(
      [...declarations.map((declaration) => declaration.id)].sort(),
    )
  })

  it('renders a human listing naming each registered function', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['--list'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('runs.list')
  })

  it('returns an empty list for a root with no runs directory', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['runs.list', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toEqual([])
  })

  it('refuses a runs.start input naming scope at the input check, before anything is read', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(
      workspace,
      ['runs.start', '--input', '{"scope":{"tier":"product","key":"shop"}}', '--json'],
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Invalid input for runs.start')
    expect(result.stderr).toContain('scope')
    expect(result.stderr).not.toContain('Unknown function')
    // This fixture's config declares an auth plugin that is not installed, so a refusal that came
    // after the project's config was resolved would report the plugin's error instead.
    expect(result.stderr).not.toContain('PluginNotInstalledError')
  })

  it('reports an unknown function id without throwing out of the action', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['runs.nope', '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('runs.nope')
  })

  it('resolves runs.get end-to-end for a run recorded on disk', async () => {
    const workspace = fixtureWorkspace(roots)
    seedRuns(workspace, [
      handoff({ runId: 'run-alpha', buildOrdinal: 11, aggregateVerdict: 'passed' }),
      handoff({
        runId: 'run-beta',
        buildOrdinal: 12,
        aggregateVerdict: 'failed',
        gateRun: true,
        tests: [{
          testId: 'test-1',
          testName: 'checks out',
          filePath: 'tests/checkout.yaml',
          testIndex: 0,
          outcome: 'failed',
          steps: [],
        }],
      }),
    ])

    const result = await invoke(workspace, [
      'runs.get',
      '--input',
      JSON.stringify({ runId: 'run-beta' }),
      '--json',
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({
      runId: 'run-beta',
      buildOrdinal: 12,
      aggregateVerdict: 'failed',
      gateRun: true,
      configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
      tests: [{
        testId: 'test-1',
        testName: 'checks out',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'failed',
        stepCount: 0,
      }],
    })
  })

  it('fails runs.get with the typed not-found error for an unknown runId', async () => {
    const workspace = fixtureWorkspace(roots)
    seedRuns(workspace, [
      handoff({ runId: 'run-alpha', buildOrdinal: 11, aggregateVerdict: 'passed' }),
    ])

    const result = await invoke(workspace, [
      'runs.get',
      '--input',
      JSON.stringify({ runId: 'run-missing' }),
      '--json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('RunNotFoundError')
    expect(result.stderr).toContain('run-missing')
  })

  it('resolves knowledge.bundles.list end-to-end against a committed bundle', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedKnowledgeBundle(workspace)

    const result = await invoke(workspace, ['knowledge.bundles.list', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const rows = JSON.parse(result.stdout) as KnowledgeBundleSummary[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      bundleId,
      product: 'shop',
      kind: 'fact',
      subtype: 'selector',
      scope: { tier: 'product', key: 'checkout' },
      dir: `memory/shop/bundles/${bundleId}`,
      summary: 'Checkout control on the cart page',
    })
  })

  it('returns an empty knowledge listing for a workspace with no committed bundles', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['knowledge.bundles.list', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toEqual([])
  })

  it('resolves config.get and never renders the raw secret (T-384-07)', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['config.get', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()

    // The declared value, asserted against the bytes a caller actually sees.
    expect(result.stdout).not.toContain(FIXTURE_API_KEY)
    expect(result.stdout).toContain(FIXTURE_API_KEY_MARKER)

    const config = JSON.parse(result.stdout) as MaskedResolvedConfig
    expect(config.configPath).toBe(workspace.configPath)
    const apiKey = config.entries.find(
      (entry) => entry.key === 'registry.llms.0.providerHeaders.x-acme-access',
    )
    expect(apiKey).toEqual({
      key: 'registry.llms.0.providerHeaders.x-acme-access',
      value: FIXTURE_API_KEY_MARKER,
      source: 'config-file',
      masked: true,
    })
    // A neighbouring undeclared leaf in the same record is shown as written.
    expect(config.entries).toContainEqual({
      key: 'registry.llms.0.providerHeaders.x-acme-origin',
      value: 'https://acme.test',
      source: 'config-file',
      masked: false,
    })
    // Schema defaults the file never mentioned are attributed to the default layer.
    expect(config.entries.find((entry) => entry.key === 'knowledge.dir')).toEqual({
      key: 'knowledge.dir',
      value: 'agent-qa-knowledge',
      source: 'default',
      masked: false,
    })
  })

  it('shows undeclared credential-named and credential-shaped values as written (D-29)', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['config.get', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()

    const config = JSON.parse(result.stdout) as MaskedResolvedConfig
    const byKey = Object.fromEntries(config.entries.map((entry) => [entry.key, entry]))
    for (const [key, value] of [
      ['registry.llms.0.providerHeaders.x-key', FIXTURE_HEADER_KEY],
      ['registry.llms.0.providerHeaders.x-cred', FIXTURE_HEADER_CRED],
      ['registry.llms.0.providerHeaders.x-pwd', FIXTURE_HEADER_PWD],
      ['registry.llms.0.providerHeaders.x-acme-key', FIXTURE_PROVIDER_KEY],
      [
        'registry.llms.0.baseURL',
        `https://ops:${FIXTURE_URL_PASSWORD}@llm.acme.test/v1?ticket=${FIXTURE_URL_QUERY_SECRET}#assertion=${FIXTURE_URL_FRAGMENT_SECRET}`,
      ],
      ['registry.targets.web.url', `https://x.test/checkout?sso=${FIXTURE_TARGET_URL_SECRET}`],
      [
        'registry.targets.protocol-relative.url',
        `//opsx:${FIXTURE_PROTOREL_USERINFO_SECRET}@x.test/checkout?waybill=${FIXTURE_PROTOREL_QUERY_SECRET}#hallmark=${FIXTURE_PROTOREL_FRAGMENT_SECRET}`,
      ],
      ['registry.targets.path-relative.url', `/checkout?lanyard=${FIXTURE_PATH_RELATIVE_SECRET}`],
      ['registry.llms.1.baseURL', `llm.acme.test/v1?emblem=${FIXTURE_HOST_RELATIVE_SECRET}`],
      ['registry.llms.2.baseURL', `ops:${FIXTURE_OPAQUE_SCHEME_SECRET}@llm.acme.test/v1`],
      ['registry.llms.3.baseURL', `https://ops.acme.test/v1/keys/${FIXTURE_KEY_IN_PATH_SECRET}`],
      [
        'registry.targets.hook.url',
        `https://hooks.acme.test/services/T00/B00/${FIXTURE_PATH_BORNE_TARGET_SECRET}`,
      ],
      ['registry.targets.relhook.url', `//hooks.acme.test/services/${FIXTURE_PROTOREL_PATH_SECRET}`],
      ['registry.targets.clean.url', FIXTURE_CLEAN_TARGET_URL],
      ['workspace.testMatch.0', FIXTURE_GLOB_WILDCARD],
      ['workspace.testPathIgnore.0', FIXTURE_IGNORE_GLOB],
      ['services.accessibility.exclude.0', FIXTURE_CSS_SELECTOR],
      ...Object.entries(FIXTURE_DEVICE_MATCH_CREDENTIALS)
        .map(([name, value]) => [`registry.devices.pixel.match.${name}`, value] as const),
    ] as const) {
      expect(byKey[key], key).toEqual({ key, value, source: 'config-file', masked: false })
    }
    expect(config.entries.filter((entry) => entry.masked).map((entry) => entry.key))
      .toEqual(['registry.llms.0.providerHeaders.x-acme-access'])
  })

  it('shows which packages load in-process, for BOTH plugin kinds (M-01)', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['config.get', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()

    // The round-2 asymmetry: one of these was hidden and the other shown, because the word
    // `auth` appeared in one path. Both are schema-constrained package names identifying
    // code that runs with full Node access, and `config.get` exists to show them.
    expect(result.stdout).toContain(FIXTURE_AUTH_PLUGIN_PACKAGE)
    expect(result.stdout).toContain(FIXTURE_PROVIDER_PLUGIN_PACKAGE)

    const config = JSON.parse(result.stdout) as MaskedResolvedConfig
    const byKey = Object.fromEntries(config.entries.map((entry) => [entry.key, entry]))
    expect(byKey['plugins.auth.0.package']).toEqual({
      key: 'plugins.auth.0.package',
      value: FIXTURE_AUTH_PLUGIN_PACKAGE,
      source: 'config-file',
      masked: false,
    })
    expect(byKey['plugins.providers.0.package']).toEqual({
      key: 'plugins.providers.0.package',
      value: FIXTURE_PROVIDER_PLUGIN_PACKAGE,
      source: 'config-file',
      masked: false,
    })
  })
})

describe('agent-qa fn runs.events (the D-08 stream kind)', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits one NDJSON line per envelope against a real events.jsonl', async () => {
    const workspace = fixtureWorkspace(roots)
    seedEvents(workspace, 'run-alpha', fiveEvents())

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-alpha' }),
      '--json',
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(5)
    // NDJSON, not a JSON array: every line parses on its own, which is what makes the
    // rendering identical for a live attach that has no end.
    const envelopes = lines.map((line) => JSON.parse(line) as RunEventEnvelope)
    expect(envelopes.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(envelopes.map((event) => event.type)).toEqual([
      'runStarted',
      'testStarted',
      'stepStarted',
      'testFinished',
      'runFinished',
    ])
  })

  it('resumes after --from <lastEventId>, yielding lastEventId + 1 onward', async () => {
    const workspace = fixtureWorkspace(roots)
    seedEvents(workspace, 'run-alpha', fiveEvents())

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-alpha' }),
      '--from',
      '2',
      '--json',
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const envelopes = result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RunEventEnvelope)
    expect(envelopes.map((event) => event.seq)).toEqual([3, 4, 5])
  })

  it('ends human output with the final seq so the next --from is readable', async () => {
    const workspace = fixtureWorkspace(roots)
    seedEvents(workspace, 'run-alpha', fiveEvents())

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-alpha' }),
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
    // One line per event, then a summary naming the last seq observed.
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('runStarted')
    expect(lines[4]).toContain('runFinished')
    expect(lines[5]).toContain('5 events')
    expect(lines[5]).toContain('last seq 5')
  })

  it('rejects a non-numeric --from without touching the event log', async () => {
    const workspace = fixtureWorkspace(roots)
    seedEvents(workspace, 'run-alpha', fiveEvents())

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-alpha' }),
      '--from',
      'later',
      '--json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('--from')
  })

  it('yields an empty stream for a run that recorded no events', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-never-ran' }),
      '--json',
    ])

    // An absent log is an ordinary empty replay, never an error (the v49 read contract).
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toBe('')
  })
})

describe('C441-DISPLAY', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fn prints a declared value in an op result as its named marker', async () => {
    const workspace = fixtureWorkspace(roots)
    writeFileSync(join(workspace.root, '.env.secrets.local'), 'PW_441=Hunter-42-zz\n', 'utf8')
    seedRuns(workspace, [
      handoff({
        runId: 'run-secret',
        buildOrdinal: 3,
        aggregateVerdict: 'failed',
        tests: [{
          testId: 'test-1',
          testName: 'log in with Hunter-42-zz',
          filePath: 'tests/login.yaml',
          testIndex: 0,
          outcome: 'failed',
          steps: [],
        }],
      }),
    ])
    const args = ['runs.get', '--input', JSON.stringify({ runId: 'run-secret' })]

    const human = await invoke(workspace, args)
    const json = await invoke(workspace, [...args, '--json'])

    for (const result of [human, json]) {
      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('log in with [secret:PW_441]')
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('Hunter-42-zz')
    }
    expect(JSON.parse(json.stdout)).toMatchObject({
      runId: 'run-secret',
      tests: [{ testName: 'log in with [secret:PW_441]' }],
    })
  })

  it('fn refuses at start when the secrets file cannot be read', async () => {
    const workspace = fixtureWorkspace(roots)
    rmSync(join(workspace.root, '.env.secrets.local'))

    const result = await invoke(workspace, ['runs.list', '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      `Error: Secrets file not found: ${join(workspace.root, '.env.secrets.local')}`,
    )
    expect(result.stderr).toContain('Create the file before running tests.')
  })
})

describe('C441-GAP-DISPLAY', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fn prints a declared value holding a quote and a backslash only as its marker', async () => {
    const workspace = fixtureWorkspace(roots)
    writeFileSync(join(workspace.root, '.env.secrets.local'), 'PW_441=pa"ss\\x\n', 'utf8')
    seedRuns(workspace, [
      handoff({
        runId: 'run-escaped',
        buildOrdinal: 3,
        aggregateVerdict: 'failed',
        tests: [{
          testId: 'test-1',
          testName: 'log in with pa"ss\\x',
          filePath: 'tests/login.yaml',
          testIndex: 0,
          outcome: 'failed',
          steps: [],
        }],
      }),
    ])
    const args = ['runs.get', '--input', JSON.stringify({ runId: 'run-escaped' })]

    const human = await invoke(workspace, args)
    const json = await invoke(workspace, [...args, '--json'])

    for (const result of [human, json]) {
      const printed = `${result.stdout}\n${result.stderr}`
      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('log in with [secret:PW_441]')
      expect(printed).not.toContain('pa"ss')
      expect(printed).not.toContain('pa\\"ss')
      expect(printed).not.toContain('ss\\\\x')
    }
  })
})

describe('C441-GAP2-DISPLAY', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fn runs.events --json keeps each line\'s seq and type and masks its payload', async () => {
    const workspace = fixtureWorkspace(roots)
    writeFileSync(join(workspace.root, '.env.secrets.local'), 'E_441=e\nPW_441=Hunter-42-zz\n', 'utf8')
    seedEvents(workspace, 'run-alpha', fiveEvents().map((event) => ({
      ...event, payload: { note: 'log in with Hunter-42-zz' } as never,
    })))

    const result = await invoke(workspace, [
      'runs.events',
      '--input',
      JSON.stringify({ runId: 'run-alpha' }),
      '--json',
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5])
    expect(lines.map((line) => line.type)).toEqual([
      'runStarted', 'testStarted', 'stepStarted', 'testFinished', 'runFinished',
    ])
    expect(lines.map((line) => line.ts)).toEqual(fiveEvents().map((event) => event.ts))
    expect(lines.map((line) => line.runId)).toEqual(Array(5).fill('run-alpha'))
    expect(JSON.stringify(lines)).toContain('[secret:PW_441]')
    expect(result.stdout).not.toContain('Hunter-42-zz')
  })
})
