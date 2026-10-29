// The shipped bin under `CI=true`, stdin `/dev/null` and stdout piped, with no colour variable set.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { generateRunId } from '@vostride/agent-qa-ids'
import { deriveBundleTrust, loadBundle } from '@vostride/agent-qa-knowledge-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { printedRunIds, refuseWithoutRecordingTools } from './run-doors-fixture.js'
import {
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_SECOND_TEST_PATH,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const FILE_BUDGET_MS = 900_000
const SPAWN_BUDGET_MS = 240_000

const COLOUR_CODE = '\x1b['
const SPINNER_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/u
const PROMPT_SHAPES = /\(y\/n\)|\[y\/N\]|\[Y\/n\]|\? .+ ›|Press (?:enter|any key)/iu

// `post-run-tail.ts`'s `CI_PENDING_SUFFIX` per stage drainer.
const CI_PENDING_SUFFIX = {
  analysis: " (resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up)",
  curation: " (resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up)",
} as const
type Stage = keyof typeof CI_PENDING_SUFFIX

const STAGE_WORD = /^(?:pending|running|complete|failed|skipped \((?:gate run|outcome-excluded|no verdict)\))$/u
// The close-out's buckets (`CURATION_BREAKDOWN_BUCKETS`) and its outcome line.
const BUCKETS_LINE =
  /^curation: added (\d+), confirmed (\d+), superseded (\d+), deprecated (\d+), proposed (\d+)$/u
const PROMOTION_LINE = /^curation: \S+ (?:held: |promoted via )/u
const CI_OUTCOME_LINE =
  /^curation: (\d+) learned change\(s\) recorded, (\d+) kept proposed \(ci runs never promote learned knowledge\)$/u

type Verdict = 'passed' | 'failed'

interface Buckets {
  readonly added: number
  readonly confirmed: number
  readonly superseded: number
  readonly deprecated: number
  readonly proposed: number
}

interface BundleFacts {
  readonly dir: string
  readonly kind: string
  readonly id?: string
  readonly status?: string
  readonly executionContext?: unknown
  readonly relations?: readonly { type: string; targetId: string }[]
  readonly files: Record<string, string>
}

interface Leg {
  readonly key: string
  readonly verdict: Verdict
  readonly testPath: string
  readonly flags: readonly string[]
  readonly runId: string
  code?: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  recordedVerdict?: unknown
  // The summary line (`post-processing — …`) or, when the tail drained the chain, its terminal
  // line (`post-processing <outcome> for <id> — …`): the one line naming the stages.
  exitLines?: string[]
  curationLines?: string[]
  requestKinds?: string[]
  knowledgeAfter?: BundleFacts[]
}

interface Scene {
  legs: Leg[]
  error?: string
}

const scene: Scene = { legs: [] }
let model: StubModelServer | undefined
let target: FixtureServer | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function headlessEnv(project: PopulatedRunProject, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    CI: 'true',
    AGENT_QA_RUN_ID: runId,
  }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  return env
}

function verdictOf(project: PopulatedRunProject, runId: string): unknown {
  const runs = join(project.agentQaRoot, 'runs')
  if (!existsSync(runs)) return undefined
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    const log = join(runs, entry.name, 'events.jsonl')
    if (!entry.isDirectory() || !existsSync(log)) continue
    const events = readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { runId?: string; type?: string; payload?: unknown })
    if (events[0]?.runId !== runId) continue
    return events.find((event) => event.type === 'verdict')?.payload
  }
  return undefined
}

function filesUnder(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return files
}

function knowledgeOf(project: PopulatedRunProject): BundleFacts[] {
  const memory = join(project.root, 'agent-qa-knowledge', 'memory')
  if (!existsSync(memory)) return []
  const facts: BundleFacts[] = []
  for (const product of readdirSync(memory).sort()) {
    const bundles = join(memory, product, 'bundles')
    if (!existsSync(bundles) || !statSync(bundles).isDirectory()) continue
    for (const name of readdirSync(bundles).sort()) {
      const dir = join(bundles, name)
      if (name.startsWith('.') || !statSync(dir).isDirectory()) continue
      const loaded = loadBundle(dir)
      facts.push(loaded.kind === 'loaded'
        ? {
            dir: relative(project.root, dir),
            kind: loaded.kind,
            id: loaded.bundle.manifest.id,
            status: deriveBundleTrust(loaded.bundle).status,
            executionContext: (loaded.bundle.provenance as { authorship?: { executionContext?: unknown } })
              .authorship?.executionContext,
            relations: loaded.bundle.relations.relations
              .map((relation) => ({ type: relation.type, targetId: relation.targetId })),
            files: filesUnder(dir),
          }
        : { dir: relative(project.root, dir), kind: loaded.kind, files: filesUnder(dir) })
    }
  }
  return facts
}

async function runLeg(project: PopulatedRunProject, leg: Leg): Promise<void> {
  const before = model?.requests.length ?? 0
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', project.configPath, 'run', leg.testPath, ...leg.flags],
    { cwd: project.root, env: headlessEnv(project, leg.runId), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, SPAWN_BUDGET_MS)
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (settle, fail) => {
        child.once('error', fail)
        child.once('close', (code, signal) => { settle({ code, signal }) })
      },
    )
    leg.code = exit.code
    leg.signal = exit.signal
  } finally {
    clearTimeout(budget)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  leg.stdout = stdout
  leg.stderr = stderr
  const lines = [...stdout.split('\n'), ...stderr.split('\n')]
  leg.exitLines = lines.filter((line) => line.startsWith('post-processing — ')
    || line.startsWith(`post-processing complete for ${leg.runId} — `)
    || line.startsWith(`post-processing failed for ${leg.runId} — `))
  leg.curationLines = lines.filter((line) => line.startsWith('curation: '))
  leg.requestKinds = (model?.requests ?? []).slice(before).map((request) => request.kind)
  leg.recordedVerdict = verdictOf(project, leg.runId)
  leg.knowledgeAfter = knowledgeOf(project)
}

function leg(key: string, verdict: Verdict, testPath: string, flags: readonly string[]): Leg {
  return { key, verdict, testPath, flags, runId: generateRunId() }
}

// The second CI run sees the first run's record as a neighbor, and the stub curator supersedes it.
async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    curatorOutcome: 'supersede-first',
  })
  const project = populatedRunFixtureProject('444-ci-headless', {
    modelBaseUrl: model.baseUrl,
    targetUrl: target.url,
  }, {
    stepText: POPULATED_PASSING_STEP_TEXT,
    secondStepText: POPULATED_FAILURE_STEP_TEXT,
  })
  const legs = [
    leg('passed', 'passed', project.testPath, []),
    leg('supersede', 'passed', project.testPath, []),
    leg('failed', 'failed', POPULATED_SECOND_TEST_PATH, []),
    leg('detached', 'passed', project.testPath, ['--detach']),
  ]
  for (const each of legs) {
    scene.legs.push(each)
    await runLeg(project, each)
  }
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

function legOf(key: string): Leg {
  expect(scene.error, seen()).toBeUndefined()
  const found = scene.legs.find((each) => each.key === key)
  expect(found, `${key} ran\n${seen()}`).toBeDefined()
  return found as Leg
}

function stagesOf(exitLine: string): Partial<Record<Stage, string>> {
  const stages: Partial<Record<Stage, string>> = {}
  for (const part of exitLine.slice(exitLine.indexOf(' — ') + 3).split(' · ')) {
    const match = /^(analysis|curation): (.*)$/u.exec(part)
    if (match !== null) stages[match[1] as Stage] = match[2]!
  }
  return stages
}

// A finished stage on the chain line carries its counts in parentheses; a pending one its suffix.
function stageWordOf(stage: Stage, printed: string): string {
  if (printed.endsWith(CI_PENDING_SUFFIX[stage])) return printed.slice(0, -CI_PENDING_SUFFIX[stage].length)
  return /^(?:complete|failed) \(/u.test(printed) ? printed.slice(0, printed.indexOf(' (')) : printed
}

function bucketsOf(run: Leg): Buckets[] {
  return (run.curationLines ?? []).flatMap((line) => {
    const match = BUCKETS_LINE.exec(line)
    return match === null ? [] : [{
      added: Number(match[1]),
      confirmed: Number(match[2]),
      superseded: Number(match[3]),
      deprecated: Number(match[4]),
      proposed: Number(match[5]),
    }]
  })
}

beforeAll(async () => {
  refuseWithoutRecordingTools()
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  try {
    await drive()
  } catch (error) {
    scene.error = message(error)
  }
}, FILE_BUDGET_MS)

afterAll(async () => {
  await model?.close().catch(() => undefined)
  await target?.close().catch(() => undefined)
  cleanupTempRoots()
}, 120_000)

describe('headless CI runs', () => {
  it('a passing headless CI run exits 0 and a failing one exits 1', () => {
    for (const key of ['passed', 'supersede', 'failed']) {
      const run = legOf(key)
      expect(run.recordedVerdict, `${key}'s verdict\n${seen()}`).toEqual({ verdict: run.verdict })
      expect({ code: run.code, signal: run.signal }, `${key}'s exit\n${seen()}`)
        .toEqual({ code: run.verdict === 'passed' ? 0 : 1, signal: null })
      expect(printedRunIds(`${run.stdout}\n${run.stderr}`), `${key}'s run id\n${seen()}`)
        .toContain(run.runId)
    }
  })

  it('a headless CI run prints no colour code, redraw or prompt', () => {
    for (const key of ['passed', 'supersede', 'failed', 'detached']) {
      const run = legOf(key)
      const streams = { stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
      expect(streams.stdout.length, `${key} printed its report\n${seen()}`).toBeGreaterThan(0)
      for (const [name, text] of Object.entries(streams)) {
        expect(text.includes(COLOUR_CODE), `${key}'s ${name} has no colour code\n${seen()}`).toBe(false)
        expect(text.includes('\r'), `${key}'s ${name} has no carriage-return redraw\n${seen()}`).toBe(false)
        expect(SPINNER_GLYPHS.test(text), `${key}'s ${name} has no spinner\n${seen()}`).toBe(false)
        expect(PROMPT_SHAPES.test(text), `${key}'s ${name} has no prompt\n${seen()}`).toBe(false)
      }
      expect(run.exitLines?.length, `${key}'s one stage line\n${seen()}`).toBe(1)
      const stages = stagesOf(run.exitLines![0]!)
      for (const stage of ['analysis', 'curation'] as const) {
        const printed = stages[stage]
        expect(printed, `${key}'s ${stage} stage\n${seen()}`).toBeDefined()
        const word = stageWordOf(stage, printed!)
        expect(word, `${key}'s ${stage} reads D-13's word\n${seen()}`).toMatch(STAGE_WORD)
        if (word === 'pending') {
          expect(printed, `${key}'s pending ${stage} states the resume limit\n${seen()}`)
            .toBe(`pending${CI_PENDING_SUFFIX[stage]}`)
        }
      }
      expect(`${streams.stdout}\n${streams.stderr}`, `${key} prints no done or excluded stage\n${seen()}`)
        .not.toMatch(/(?:analysis|curation): (?:done|excluded)\b/u)
    }
  })

  it('a detached CI run prints pending stages with the resume limit', () => {
    const run = legOf('detached')
    expect(run.recordedVerdict, seen()).toEqual({ verdict: 'passed' })
    expect({ code: run.code, signal: run.signal }, seen()).toEqual({ code: 0, signal: null })
    expect(run.exitLines?.length, seen()).toBe(1)
    expect(run.exitLines![0]!.startsWith('post-processing — '), seen()).toBe(true)
    expect(stagesOf(run.exitLines![0]!), seen()).toEqual({
      analysis: `pending${CI_PENDING_SUFFIX.analysis}`,
      curation: `pending${CI_PENDING_SUFFIX.curation}`,
    })
  })

  it('a CI run curation outcome line counts only the changes its buckets line shows', () => {
    const measured = ['passed', 'supersede', 'failed'].map((key) => {
      const run = legOf(key)
      const buckets = bucketsOf(run)
      expect(buckets, `${key}'s one buckets line\n${seen()}`).toHaveLength(1)
      const bucketed = Object.values(buckets[0]!).reduce((sum, count) => sum + count, 0)
      const outcome = (run.curationLines ?? []).flatMap((line) => {
        const match = CI_OUTCOME_LINE.exec(line)
        return match === null ? [] : [Number(match[1]) + Number(match[2])]
      })
      return { key, bucketed, outcome }
    })
    expect(measured, seen()).toEqual(measured.map(({ key, bucketed }) =>
      ({ key, bucketed, outcome: bucketed === 0 ? [] : [bucketed] })))
    expect(measured.filter((each) => each.bucketed > 0).length, seen()).toBeGreaterThan(0)
  })
})

describe('curation in CI only proposes', () => {
  it('curation in CI keeps what it adds a candidate and what it supersedes proposed', () => {
    const first = legOf('passed')
    const second = legOf('supersede')

    expect(bucketsOf(first), `the first CI run's close-out\n${seen()}`)
      .toEqual([{ added: 1, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 }])
    expect(first.curationLines, `D-57's outcome line\n${seen()}`).toContain(
      'curation: 1 learned change(s) recorded, 0 kept proposed (ci runs never promote learned knowledge)',
    )
    const added = first.knowledgeAfter ?? []
    expect(added.map((each) => ({ kind: each.kind, status: each.status, ctx: each.executionContext })),
      `the first CI run wrote one candidate\n${seen()}`)
      .toEqual([{ kind: 'loaded', status: 'candidate', ctx: 'ci' }])
    const victim = added[0]!

    expect(second.requestKinds, `the curator arm authored the Supersede\n${seen()}`).toContain('curator')
    expect(bucketsOf(second), `the second CI run's close-out\n${seen()}`)
      .toEqual([{ added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 1 }])
    expect(second.curationLines, `D-57's outcome line for the proposed correction\n${seen()}`).toContain(
      'curation: 0 learned change(s) recorded, 1 kept proposed (ci runs never promote learned knowledge)',
    )
    const after = second.knowledgeAfter ?? []
    const victimAfter = after.find((each) => each.dir === victim.dir)
    expect(victimAfter, `the victim record is unchanged\n${seen()}`).toEqual(victim)
    const proposals = after.filter((each) => each.dir !== victim.dir)
    expect(proposals.map((each) => ({ status: each.status, ctx: each.executionContext, relations: each.relations })),
      `the supersession is a candidate with its proposed relation\n${seen()}`)
      .toEqual([{
        status: 'candidate',
        ctx: 'ci',
        relations: [{ type: 'proposed-supersession-of', targetId: victim.id }],
      }])

    for (const run of [first, second]) {
      expect((run.curationLines ?? []).filter((line) => PROMOTION_LINE.test(line)),
        `${run.key} attempted no promotion\n${seen()}`).toEqual([])
    }
  })
})
