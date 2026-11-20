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

const SPINNER_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/u
const PROMPT_SHAPES = /\(y\/n\)|\[y\/N\]|\[Y\/n\]|\? .+ ›|Press (?:enter|any key)/iu

// `knowledgePendingResumeWords` in `ci`, the end of the line under a `Knowledge:` line.
const CI_RESUME_SENTENCE = "resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up"

// The line under each leg's `Knowledge:` line. The three legs that are not detached finish their
// chain in their own process, so their curation stage reads complete and they print none.
const SECOND_LINE: Record<string, string | undefined> = {
  passed: undefined,
  supersede: undefined,
  failed: undefined,
  detached: `  not finished, ${CI_RESUME_SENTENCE}`,
}

type Verdict = 'passed' | 'failed'

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
  // Each `Knowledge:` line on stderr, with the indented line under it when there is one.
  knowledge?: KnowledgeLines[]
  requestKinds?: string[]
  knowledgeAfter?: BundleFacts[]
}

interface KnowledgeLines {
  readonly line: string
  readonly second?: string
}

interface Scene {
  legs: Leg[]
  error?: string
}

const scene: Scene = { legs: [] }
let model: StubModelServer | undefined
let target: FixtureServer | undefined

// The readers below find lines by their words, whichever of those words are coloured.
function withoutColour(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

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
  leg.knowledge = knowledgeLinesOf(withoutColour(stderr))
  leg.requestKinds = (model?.requests ?? []).slice(before).map((request) => request.kind)
  leg.recordedVerdict = verdictOf(project, leg.runId)
  leg.knowledgeAfter = knowledgeOf(project)
}

function knowledgeLinesOf(stderr: string): KnowledgeLines[] {
  const lines = stderr.split('\n')
  return lines.flatMap((line, index) => {
    if (!line.startsWith('Knowledge: ')) return []
    const next = lines[index + 1]
    return [next !== undefined && next.startsWith('  ') ? { line, second: next } : { line }]
  })
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
  const project = populatedRunFixtureProject('ci-headless', {
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
      expect(printedRunIds(withoutColour(`${run.stdout}\n${run.stderr}`)), `${key}'s run id\n${seen()}`)
        .toContain(run.runId)
    }
  })

  // On stdout under the summary block, after a blank line; the Knowledge line follows on stderr.
  it('a headless CI run prints its run id once, under its summary block', () => {
    for (const key of ['passed', 'supersede', 'failed', 'detached']) {
      const run = legOf(key)
      const lines = withoutColour(run.stdout ?? '').split('\n')
      const idLines = lines.flatMap((line, index) => line.startsWith('Run ID: ') ? [index] : [])
      expect(idLines.map((index) => lines[index]), `${key}'s one Run ID line\n${seen()}`)
        .toEqual([`Run ID: ${run.runId}`])
      const at = idLines[0]!
      expect(lines[at - 1], `${key}'s blank line above its run id\n${seen()}`).toBe('')
      expect(lines[at - 2]?.startsWith('Time: '), `${key}'s summary ends above it\n${seen()}`)
        .toBe(true)
      expect(lines.slice(at + 1).join(''), `${key} prints nothing on stdout after it\n${seen()}`)
        .toBe('')
      expect(withoutColour(run.stderr ?? '').includes('Run ID: '), `${key}'s stderr\n${seen()}`)
        .toBe(false)
    }
  })

  it('a headless CI run colours its report and prints no redraw, spinner or prompt', () => {
    for (const key of ['passed', 'supersede', 'failed', 'detached']) {
      const run = legOf(key)
      const streams = { stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
      expect(streams.stdout.length, `${key} printed its report\n${seen()}`).toBeGreaterThan(0)
      expect(streams.stdout, `${key}'s stdout is coloured in CI\n${seen()}`).toMatch(/\x1b\[[0-9;]*m/u)
      for (const [name, text] of Object.entries(streams)) {
        expect(text.includes('\r'), `${key}'s ${name} has no carriage-return redraw\n${seen()}`).toBe(false)
        expect(SPINNER_GLYPHS.test(text), `${key}'s ${name} has no spinner\n${seen()}`).toBe(false)
        expect(PROMPT_SHAPES.test(text), `${key}'s ${name} has no prompt\n${seen()}`).toBe(false)
        // The close-out line, the digest block and the fold's lines print with --verbose only.
        for (const line of withoutColour(text).split('\n')) {
          expect(line.includes('post-processing'), `${key}'s ${name} line: ${line}\n${seen()}`)
            .toBe(false)
          expect(line.startsWith('digest — '), `${key}'s ${name} line: ${line}\n${seen()}`)
            .toBe(false)
          expect(line.startsWith('curation: '), `${key}'s ${name} line: ${line}\n${seen()}`)
            .toBe(false)
        }
      }
      expect(run.knowledge?.length, `${key} prints one Knowledge line\n${seen()}`).toBe(1)
      expect(run.knowledge![0]!.second, `${key}'s line under its Knowledge line\n${seen()}`)
        .toBe(SECOND_LINE[key])
    }
  })

  it('a detached CI run prints a pending summary with the resume limit', () => {
    const run = legOf('detached')
    expect(run.recordedVerdict, seen()).toEqual({ verdict: 'passed' })
    expect({ code: run.code, signal: run.signal }, seen()).toEqual({ code: 0, signal: null })
    expect(run.knowledge, seen()).toEqual([
      { line: 'Knowledge: pending', second: `  not finished, ${CI_RESUME_SENTENCE}` },
    ])
  })
})

describe('curation in CI only proposes', () => {
  it('curation in CI keeps what it adds a candidate and what it supersedes proposed', () => {
    const first = legOf('passed')
    const second = legOf('supersede')

    expect(first.knowledge?.map((each) => each.line), `the first CI run's summary\n${seen()}`)
      .toEqual(['Knowledge: learned 1, held 0'])
    const added = first.knowledgeAfter ?? []
    expect(added.map((each) => ({ kind: each.kind, status: each.status, ctx: each.executionContext })),
      `the first CI run wrote one candidate\n${seen()}`)
      .toEqual([{ kind: 'loaded', status: 'candidate', ctx: 'ci' }])
    const victim = added[0]!

    expect(second.requestKinds, `the curator arm authored the Supersede\n${seen()}`).toContain('curator')
    expect(second.knowledge?.map((each) => each.line), `the second CI run's summary\n${seen()}`)
      .toEqual(['Knowledge: learned 0, held 0, proposed 1'])
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
  })
})
