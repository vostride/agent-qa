import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import { FsHandoffStore } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  type CompletedRunHandoff,
  type ElementInfo,
  type MaskFn,
  type ScreenState,
  type StepEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { createDeclaredSecretMask } from '../../composition/declared-secrets.js'
import {
  completedRunDir,
  curateCompletedRun,
  defaultCurationTailOperations,
  readCurationTailReceipt,
  runCurationTail,
  type CurationTailOperations,
} from '../curation-tail.js'
import { composeCliPostRunTail } from '../post-run-tail-composition.js'
import type { PostRunTailHostInput, PostRunTailOperations } from '../post-run-tail.js'
import { createPostVerdictStep } from '../post-verdict-step.js'
import { readRunConfigRecord } from '../run-curation-context.js'

// Distinct secrets live in distinct `secretsFile`s.
const VALUE_A = 'alpha-tenant-7731'
const VALUE_B = 'bravo-tenant-4410'
const MARKER_A = '[secret:A_SECRET]'
const VALUE_LATE = 'late-tenant-9902'
const MARKER_LATE = '[secret:A_LATE]'
const RUN_A = 'r-c442-run-a'
const RUN_B = 'r-c442-run-b'
const RUN_A_LATER = 'r-c442-later-a'
const SCOPE_A = 'tenant-a'
const SCOPE_B = 'tenant-b'
const TAIL_TIMEOUT_MS = 180_000

type ChainResult = Awaited<ReturnType<PostRunTailHostInput['curateRun']>>

interface Project {
  readonly root: string
  readonly agentQaRoot: string
  readonly aConfig: string
  readonly bConfig: string
  readonly aSecrets: string
  readonly knowledgeA: string
  readonly knowledgeB: string
  readonly knowledgeDirA: string
  readonly knowledgeDirB: string
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function config(secretsFile: string, knowledgeDir: string): string {
  return `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: ${secretsFile}

knowledge:
  dir: ${knowledgeDir}

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
}

function project(options: { sharedKnowledge: boolean }): Project {
  const root = mkdtempSync(join(tmpdir(), 'c442-run-config-'))
  roots.push(root)
  const knowledgeDirA = 'knowledge-a'
  const knowledgeDirB = options.sharedKnowledge ? knowledgeDirA : 'knowledge-b'
  const aConfig = join(root, 'a.config.yaml')
  const bConfig = join(root, 'b.config.yaml')
  const aSecrets = join(root, '.env.secrets.a')
  writeFileSync(aConfig, config('.env.secrets.a', knowledgeDirA))
  writeFileSync(bConfig, config('.env.secrets.b', knowledgeDirB))
  writeFileSync(aSecrets, `A_SECRET=${VALUE_A}\n`)
  writeFileSync(join(root, '.env.secrets.b'), `B_SECRET=${VALUE_B}\n`)
  const knowledgeA = join(root, knowledgeDirA)
  const knowledgeB = join(root, knowledgeDirB)
  mkdirSync(knowledgeA, { recursive: true })
  mkdirSync(knowledgeB, { recursive: true })
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    aConfig,
    bConfig,
    aSecrets,
    knowledgeA,
    knowledgeB,
    knowledgeDirA,
    knowledgeDirB,
  }
}

function element(ref: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: {},
    attributes: { 'data-testid': name },
  }
}

function screen(target: ElementInfo, url: string): ScreenState {
  return {
    platform: 'web',
    tree: `${target.role} ${target.name}`,
    elements: [target],
    refMap: { [target.ref]: { bounds: target.bounds!, center: target.center! } },
    url,
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 1_440 },
    },
  }
}

function step(stepIndex: number, scopeKey: string, value: string): StepEvidence {
  const target = element(`open-${stepIndex}`, value)
  const state = screen(target, `https://${scopeKey}.example/account?user=${value}`)
  return {
    stepIndex,
    stepText: `Open the ${value} account`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: scopeKey },
      asOfBuild: 42,
      budget: 1_000,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest',
    },
    subActions: [
      {
        plan: `Use ${target.ref}`,
        plannedAction: { type: 'click', ref: target.ref },
        stateBefore: state,
        stateAfter: state,
        result: { success: true },
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'step verified' },
  }
}

function seedRun(p: Project, runId: string, scopeKey: string, values: readonly string[]): void {
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: scopeKey },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [
      {
        testId: `${scopeKey}::open-account`,
        testName: 'Open the account',
        testIndex: 0,
        outcome: 'passed',
        steps: values.map((value, index) => step(index, scopeKey, value)),
        filePath: 'account.spec.yaml',
      },
    ],
  }
  new FsHandoffStore({ root: p.agentQaRoot, runId }).save(handoff)
}

function recordPath(p: Project, runId: string): string {
  return join(completedRunDir(p.agentQaRoot, runId), 'run-config.json')
}

function writeRecord(p: Project, runId: string, configPath: string): void {
  writeFileSync(
    recordPath(p, runId),
    `${JSON.stringify({ schemaVersion: 2, runId, configPath })}\n`,
  )
}

// memory/index is the gitignored derived index, not committed knowledge.
function committedFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(dir, file).startsWith(join('memory', 'index')))
}

function filesHolding(dir: string, text: string): string[] {
  return committedFilesUnder(dir).filter(
    (file) => file.includes(text) || readFileSync(file, 'utf8').includes(text),
  )
}

function recordsOfRun(knowledgeRoot: string, runId: string): string[] {
  const memory = join(knowledgeRoot, 'memory')
  let scopes: string[]
  try {
    scopes = readdirSync(memory)
  } catch {
    return []
  }
  return scopes.flatMap((scope) => {
    const bundles = join(memory, scope, 'bundles')
    let names: string[]
    try {
      names = readdirSync(bundles)
    } catch {
      return []
    }
    return names
      .map((name) => join(bundles, name))
      .filter((bundle) =>
        readFileSync(join(bundle, 'provenance.json'), 'utf8').includes(JSON.stringify(runId)),
      )
      .map((bundle) => readFileSync(join(bundle, 'record.md'), 'utf8'))
  })
}

function fakeHost(): never {
  return {
    jobs: async () => ({
      queue: {
        runNextJob: async () => ({ ran: false, reason: 'no-job' }),
        recoverAbandonedClaims: async () => ({ released: [] }),
      },
      store: { adoptEpoch: async (epoch: number) => ({ epoch }) },
      idSource: DIGEST_JOB_ID_SOURCE,
    }),
    close: async () => undefined,
  } as never
}

interface AuthorEgress {
  readonly sourceRunId: string
  readonly mask: MaskFn
}

// The curator author's egress mask, paired with the run whose fold built it.
function authorSpy(egress: AuthorEgress[]): Partial<CurationTailOperations> {
  const shipped = defaultCurationTailOperations()
  let built: MaskFn | undefined
  return {
    buildCuratorAuthor: ((deps: { mask: MaskFn }) => {
      built = deps.mask
      return async () => ({ kind: 'fallback-required', reason: 'no-model' })
    }) as never,
    drainQueue: ((request: { sourceRunId: string }) => {
      if (built !== undefined) egress.push({ sourceRunId: request.sourceRunId, mask: built })
      built = undefined
      return shipped.drainQueue(request as never)
    }) as never,
  }
}

async function drainTail(input: {
  readonly p: Project
  readonly runId: string
  readonly configPath: string
  readonly knowledgeDir: string
  readonly chainRunId?: string
  readonly egress?: AuthorEgress[]
}): Promise<{ readonly warns: string[]; readonly chain?: ChainResult }> {
  const warns: string[] = []
  let bound: PostRunTailHostInput | undefined
  let chain: ChainResult | undefined
  const spy = input.egress === undefined ? undefined : authorSpy(input.egress)
  const operations: Partial<PostRunTailOperations> = {
    composeHost: (host) => {
      bound = host
      return fakeHost()
    },
    createChipEmitter: () => ({ observe: () => undefined, finish: () => undefined }) as never,
    nudgeDaemon: async () => undefined,
    ...(spy === undefined
      ? {}
      : {
          curateCompletedRun: (fold) =>
            curateCompletedRun({ ...fold, operations: { ...fold.operations, ...spy } }),
          runCurationTail: (sweep) =>
            runCurationTail({ ...sweep, operations: { ...sweep.operations, ...spy } }),
        }),
    ...(input.chainRunId === undefined
      ? {}
      : {
          runCurationTail: async () => {
            chain = await bound!.curateRun({
              runId: input.chainRunId!,
              executionContext: 'local-interactive',
            })
          },
        }),
  }
  const tail = composeCliPostRunTail({
    runId: input.runId,
    configDir: input.p.root,
    configFilePath: input.configPath,
    knowledgeConfig: { dir: input.knowledgeDir },
    mask: createDeclaredSecretMask(input.configPath).mask,
    ...(spy === undefined ? {} : { modelDeps: {} as never }),
    log: { warn: (message: string) => warns.push(message), info: () => undefined },
    operations,
  })
  await tail.drain()
  return { warns, ...(chain === undefined ? {} : { chain }) }
}

function reasonOf(chain: ChainResult | undefined): string | undefined {
  return (chain as { readonly reason?: string } | undefined)?.reason
}

function nothingOfRunA(p: Project): void {
  for (const knowledgeRoot of [p.knowledgeA, p.knowledgeB]) {
    expect(recordsOfRun(knowledgeRoot, RUN_A)).toEqual([])
    expect(filesHolding(knowledgeRoot, VALUE_A)).toEqual([])
  }
}

function receiptOfRunA(p: Project): unknown {
  return readCurationTailReceipt(completedRunDir(p.agentQaRoot, RUN_A))
}

// One fixture per hand-back case, each driven through both drain paths.
async function handedBackByB(p: Project, reasonPart: string): Promise<void> {
  const { chain } = await drainTail({
    p,
    runId: RUN_B,
    configPath: p.bConfig,
    knowledgeDir: p.knowledgeDirB,
    chainRunId: RUN_A,
  })
  expect(chain?.complete).toBe(false)
  const reason = reasonOf(chain)
  expect(reason).toContain(RUN_A)
  expect(reason).toContain(reasonPart)
  expect(reason).not.toContain(VALUE_A)
  expect(receiptOfRunA(p)).toBeUndefined()
  nothingOfRunA(p)

  const { warns } = await drainTail({
    p,
    runId: RUN_B,
    configPath: p.bConfig,
    knowledgeDir: p.knowledgeDirB,
  })
  expect(warns.filter((line) => line.includes(RUN_A) && line.includes(reasonPart))).toHaveLength(1)
  expect(receiptOfRunA(p)).toBeUndefined()
  expect(readCurationTailReceipt(completedRunDir(p.agentQaRoot, RUN_B))).toBeDefined()
  nothingOfRunA(p)
}

describe('curation masks each run with its own secrets', () => {
  it(
    "run B's tail curates run A only under A's secrets (janitor)",
    async () => {
      const p = project({ sharedKnowledge: true })
      seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
      writeRecord(p, RUN_A, p.aConfig)
      seedRun(p, RUN_B, SCOPE_B, [VALUE_B])

      await drainTail({ p, runId: RUN_B, configPath: p.bConfig, knowledgeDir: p.knowledgeDirB })

      const recordsA = recordsOfRun(p.knowledgeA, RUN_A)
      expect(recordsA.length, "run A's run was never folded").toBeGreaterThan(0)
      expect(filesHolding(p.knowledgeA, VALUE_A)).toEqual([])
      expect(recordsA.every((record) => record.includes(MARKER_A))).toBe(true)
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    "run B's tail curates run A only under A's secrets (chain)",
    async () => {
      const p = project({ sharedKnowledge: true })
      seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
      writeRecord(p, RUN_A, p.aConfig)
      seedRun(p, RUN_B, SCOPE_B, [VALUE_B])

      const { chain } = await drainTail({
        p,
        runId: RUN_B,
        configPath: p.bConfig,
        knowledgeDir: p.knowledgeDirB,
        chainRunId: RUN_A,
      })

      expect(chain?.complete).toBe(true)
      const recordsA = recordsOfRun(p.knowledgeA, RUN_A)
      expect(recordsA.length, "run A's run was never folded").toBeGreaterThan(0)
      expect(filesHolding(p.knowledgeA, VALUE_A)).toEqual([])
      expect(recordsA.every((record) => record.includes(MARKER_A))).toBe(true)
      expect(readCurationTailReceipt(completedRunDir(p.agentQaRoot, RUN_A))).toBeDefined()
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    "the curator author's egress mask for run A's fold is A's",
    async () => {
      for (const chainRunId of [undefined, RUN_A]) {
        const p = project({ sharedKnowledge: true })
        seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
        writeRecord(p, RUN_A, p.aConfig)
        seedRun(p, RUN_B, SCOPE_B, [VALUE_B])
        const egress: AuthorEgress[] = []

        await drainTail({
          p,
          runId: RUN_B,
          configPath: p.bConfig,
          knowledgeDir: p.knowledgeDirB,
          egress,
          ...(chainRunId === undefined ? {} : { chainRunId }),
        })

        const forA = egress.filter((entry) => entry.sourceRunId === RUN_A)
        expect(forA, "no author was built for run A's fold").toHaveLength(1)
        expect(forA[0]!.mask(`Open the ${VALUE_A} account`)).toBe(`Open the ${MARKER_A} account`)
        expect(recordsOfRun(p.knowledgeA, RUN_A).length).toBeGreaterThan(0)
        expect(filesHolding(p.knowledgeA, VALUE_A)).toEqual([])
      }
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    "distinct knowledge roots hand run A back and A's own project curates it",
    async () => {
      const p = project({ sharedKnowledge: false })
      seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
      writeRecord(p, RUN_A, p.aConfig)
      seedRun(p, RUN_B, SCOPE_B, [VALUE_B])

      await handedBackByB(p, 'keeps its knowledge in')

      seedRun(p, RUN_A_LATER, SCOPE_A, ['later-account'])
      writeRecord(p, RUN_A_LATER, p.aConfig)
      await drainTail({
        p,
        runId: RUN_A_LATER,
        configPath: p.aConfig,
        knowledgeDir: p.knowledgeDirA,
      })

      const recordsA = recordsOfRun(p.knowledgeA, RUN_A)
      expect(recordsA.length, "run A's run was never folded").toBeGreaterThan(0)
      expect(recordsA.every((record) => record.includes(MARKER_A))).toBe(true)
      expect(receiptOfRunA(p)).toBeDefined()
      expect(recordsOfRun(p.knowledgeB, RUN_A)).toEqual([])
      expect(filesHolding(p.knowledgeA, VALUE_A)).toEqual([])
      expect(filesHolding(p.knowledgeB, VALUE_A)).toEqual([])
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    'a value added to the secrets file after the run is masked at curation',
    async () => {
      for (const chainRunId of [undefined, RUN_A]) {
        const p = project({ sharedKnowledge: true })
        seedRun(p, RUN_A, SCOPE_A, [VALUE_A, VALUE_LATE])
        writeRecord(p, RUN_A, p.aConfig)
        seedRun(p, RUN_B, SCOPE_B, [VALUE_B])
        appendFileSync(p.aSecrets, `A_LATE=${VALUE_LATE}\n`)

        await drainTail({
          p,
          runId: RUN_B,
          configPath: p.bConfig,
          knowledgeDir: p.knowledgeDirB,
          ...(chainRunId === undefined ? {} : { chainRunId }),
        })

        const recordsA = recordsOfRun(p.knowledgeA, RUN_A)
        expect(recordsA.filter((record) => record.includes(MARKER_LATE))).toHaveLength(1)
        expect(filesHolding(p.knowledgeA, VALUE_LATE)).toEqual([])
        expect(filesHolding(p.knowledgeA, VALUE_A)).toEqual([])
      }
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    'a run whose secrets file cannot be read is handed back, never curated under another mask',
    async () => {
      const cases: ReadonlyArray<readonly [string, (p: Project) => void]> = [
        ['whose secrets file cannot be read', (p) => rmSync(p.aSecrets)],
        ['whose secrets file cannot be read', (p) => chmodSync(p.aSecrets, 0o000)],
        ['which cannot be read', (p) => rmSync(p.aConfig)],
      ]
      for (const [reasonPart, breakRunA] of cases) {
        const p = project({ sharedKnowledge: true })
        seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
        writeRecord(p, RUN_A, p.aConfig)
        seedRun(p, RUN_B, SCOPE_B, [VALUE_B])
        breakRunA(p)

        await handedBackByB(p, reasonPart)
      }
    },
    TAIL_TIMEOUT_MS,
  )

  it(
    "a run with no config record is never curated by another run's tail",
    async () => {
      const records: ReadonlyArray<(p: Project) => void> = [
        () => undefined,
        (p) =>
          writeFileSync(
            recordPath(p, RUN_A),
            `${JSON.stringify({
              schemaVersion: 2,
              runId: RUN_A,
              configPath: p.aConfig,
              mask: 'none',
            })}\n`,
          ),
        (p) => {
          const elsewhere = join(p.root, 'planted-run-config.json')
          writeFileSync(
            elsewhere,
            `${JSON.stringify({
              schemaVersion: 2,
              runId: RUN_A,
              configPath: p.aConfig,
            })}\n`,
          )
          symlinkSync(elsewhere, recordPath(p, RUN_A))
        },
      ]
      for (const writeRunARecord of records) {
        const p = project({ sharedKnowledge: true })
        seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
        writeRunARecord(p)
        seedRun(p, RUN_B, SCOPE_B, [VALUE_B])

        await handedBackByB(p, 'has no config record')
      }
    },
    TAIL_TIMEOUT_MS,
  )
})

async function runStep(
  p: Project,
  runId: string,
  configPath: string,
  input: { readonly gateRun?: true } = {},
): Promise<{ readonly warns: string[]; readonly outcome: unknown }> {
  const warns: string[] = []
  const step = createPostVerdictStep({
    runId,
    agentQaRoot: p.agentQaRoot,
    knowledgeRoot: p.knowledgeA,
    configPath: relative(process.cwd(), configPath),
    detach: true,
    log: { warn: (message: string) => warns.push(message) },
    operations: { ownContinuation: (async () => 'enqueued') as never },
  })
  const outcome = await step.port.run(input as never)
  return { warns, outcome }
}

function temporaryFiles(p: Project, runId: string): string[] {
  return readdirSync(completedRunDir(p.agentQaRoot, runId)).filter((name) => name.endsWith('.tmp'))
}

describe('the run-config record', () => {
  it("a run's post-verdict step records its own config", async () => {
    for (const input of [{}, { gateRun: true as const }]) {
      const p = project({ sharedKnowledge: true })
      seedRun(p, RUN_A, SCOPE_A, [VALUE_A])

      const { warns } = await runStep(p, RUN_A, p.aConfig, input)

      expect(existsSync(recordPath(p, RUN_A)), 'the step wrote no run-config record').toBe(true)
      expect(warns).toEqual([])
      expect(JSON.parse(readFileSync(recordPath(p, RUN_A), 'utf8'))).toEqual({
        schemaVersion: 2,
        runId: RUN_A,
        configPath: p.aConfig,
      })
      expect(statSync(recordPath(p, RUN_A)).mode & 0o777).toBe(0o600)
      expect(temporaryFiles(p, RUN_A)).toEqual([])
    }
  })

  it('a run-config record stamped 1 reads as absent', () => {
    const p = project({ sharedKnowledge: true })
    seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
    writeRecord(p, RUN_A, p.aConfig)
    expect(readRunConfigRecord(p.agentQaRoot, RUN_A)?.configPath).toBe(p.aConfig)

    writeFileSync(
      recordPath(p, RUN_A),
      `${JSON.stringify({ schemaVersion: 1, runId: RUN_A, configPath: p.aConfig })}\n`,
    )
    expect(readRunConfigRecord(p.agentQaRoot, RUN_A)).toBeUndefined()
  })

  it('writing the same record twice is success, a different one is refused', async () => {
    const p = project({ sharedKnowledge: true })
    seedRun(p, RUN_A, SCOPE_A, [VALUE_A])

    await runStep(p, RUN_A, p.aConfig)
    expect(existsSync(recordPath(p, RUN_A)), 'the step wrote no run-config record').toBe(true)
    const first = readFileSync(recordPath(p, RUN_A), 'utf8')
    expect((await runStep(p, RUN_A, p.aConfig)).warns).toEqual([])
    const refused = await runStep(p, RUN_A, p.bConfig)
    expect(refused.warns).toHaveLength(1)
    expect(refused.warns[0]).toContain(RUN_A)
    expect(readFileSync(recordPath(p, RUN_A), 'utf8')).toBe(first)
    expect(temporaryFiles(p, RUN_A)).toEqual([])
  })

  it("a record write failure does not change the run's verdict path", async () => {
    const control = project({ sharedKnowledge: true })
    seedRun(control, RUN_A, SCOPE_A, [VALUE_A])
    const expected = await runStep(control, RUN_A, control.aConfig)

    const p = project({ sharedKnowledge: true })
    seedRun(p, RUN_A, SCOPE_A, [VALUE_A])
    const runDir = completedRunDir(p.agentQaRoot, RUN_A)
    chmodSync(runDir, 0o500)
    let failed: Awaited<ReturnType<typeof runStep>>
    try {
      failed = await runStep(p, RUN_A, p.aConfig)
    } finally {
      chmodSync(runDir, 0o700)
    }

    expect(failed.outcome).toEqual(expected.outcome)
    expect(failed.warns).toHaveLength(1)
    expect(failed.warns[0]).toContain(RUN_A)
    expect(existsSync(recordPath(p, RUN_A))).toBe(false)
  })
})
