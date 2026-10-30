import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  curationCandidatePayloadSchema,
  queuedCandidateDir,
  type CurationCandidatePayload,
} from '@vostride/agent-qa-knowledge-local'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { FsHandoffStore } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  type CompletedRunHandoff,
  type ElementInfo,
  type ScreenState,
  type StepEvidence,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { runCurationTail } from '../curation-tail.js'
import {
  emitCurationCandidates,
  parseProcedureTrajectorySeed,
  type EmitReport,
} from '../emit-candidates.js'

const DECLARED = 'qa-admin-42'
const MARKER = '[secret:DECLARED_USER]'
const SCOPE_KEY = 'storefront'
const PAGE = `https://shop.example/account?user=${DECLARED}`
const TAIL_TIMEOUT_MS = 180_000

function declaredMask(): (text: string) => string {
  const redactor = new SecretRedactor(new SecretStore({ DECLARED_USER: DECLARED }))
  return (text) => redactor.redactString(text)
}

function element(ref: string, name: string, testId?: string, role = 'button'): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: {},
    attributes: testId === undefined ? {} : { 'data-testid': testId },
  }
}

function screen(elements: ElementInfo[], url: string): ScreenState {
  return {
    platform: 'web',
    tree: elements.map((entry) => `${entry.role} ${entry.name}`).join('\n'),
    elements,
    refMap: Object.fromEntries(
      elements.map((entry) => [entry.ref, { bounds: entry.bounds!, center: entry.center! }]),
    ),
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

function step(input: {
  stepIndex: number
  stepText: string
  target: ElementInfo
  url: string
  fillText?: string
  interpolatedVariables?: { name: string; value: string }[]
}): StepEvidence {
  const state = screen([input.target], input.url)
  const ref = input.target.ref
  return {
    stepIndex: input.stepIndex,
    stepText: input.stepText,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: SCOPE_KEY },
      asOfBuild: 42,
      budget: 1_000,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest',
    },
    subActions: [{
      plan: `Use ${ref}`,
      plannedAction: input.fillText === undefined
        ? { type: 'click', ref }
        : { type: 'fill', ref, text: input.fillText, clearMode: 'replace', submit: false },
      stateBefore: state,
      stateAfter: state,
      result: { success: true },
    }],
    verifierVerdict: { pass: true, reasoning: 'step verified' },
    ...(input.interpolatedVariables === undefined
      ? {}
      : { interpolatedVariables: input.interpolatedVariables }),
  }
}

function run(runId: string, steps: StepEvidence[]): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: SCOPE_KEY },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [{
      testId: 'account::open-admin',
      testName: 'Open the admin account',
      testIndex: 0,
      outcome: 'passed',
      steps,
      filePath: 'account.spec.yaml',
    }],
  }
}

function factRun(runId: string): CompletedRunHandoff {
  return run(runId, [
    step({
      stepIndex: 0,
      stepText: 'Open the admin account',
      target: element('admin', DECLARED, DECLARED),
      url: PAGE,
    }),
  ])
}

function queuedPayloads(knowledgeRoot: string, report: EmitReport): CurationCandidatePayload[] {
  return report.details.map((detail) => {
    if (detail.candidateId === undefined) {
      throw new Error(`candidate not queued: ${detail.outcome.kind}`)
    }
    return curationCandidatePayloadSchema.parse(JSON.parse(readFileSync(
      join(queuedCandidateDir(knowledgeRoot, detail.candidateId), 'payload.json'),
      'utf8',
    )))
  })
}

// memory/index is the gitignored derived index, not committed knowledge.
function committedFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(dir, file).startsWith(join('memory', 'index')))
}

describe('curation candidates queue declared values only masked', () => {
  it("a fact candidate's seeds, anchors and natural keys are queued only masked", () => {
    const root = mkdtempSync(join(tmpdir(), 'gap-fact-'))
    try {
      const knowledgeRoot = join(root, 'agent-qa-knowledge')
      const runDir = join(root, 'runs', 'r-gap-fact')
      mkdirSync(runDir, { recursive: true })
      const report = emitCurationCandidates({
        handoff: factRun('r-gap-fact'),
        runDir,
        knowledgeRoot,
        mask: declaredMask(),
      })

      const payloads = queuedPayloads(knowledgeRoot, report)
      const fact = payloads.find((row) => row.kind === 'fact')
      if (fact === undefined) throw new Error('expected a queued fact candidate')
      expect(fact.summarySeed).toBe(`button "${MARKER}" selector [data-testid="${MARKER}"]`)
      expect(fact.bodySeed).toBe(`Verified button "${MARKER}" at [data-testid="${MARKER}"].`)
      expect(fact.anchors).toContainEqual({ t: 'selector', literal: `[data-testid="${MARKER}"]` })
      expect(fact.anchors.find((anchor) => anchor.t === 'el')).toMatchObject({ name: MARKER })
      expect(fact.distilledObservations[0]?.element?.naturalKey).toContain(MARKER)
      expect(fact.distilledObservations[0]?.locator?.selector).toBe(`[data-testid="${MARKER}"]`)
      expect(fact.distilledObservations[0]?.surface?.naturalKey)
        .toBe(`https://shop.example/account?user=${MARKER}`)
      expect(JSON.stringify(payloads)).not.toContain(DECLARED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it(
    'the fallback commits a fact through the real drain with no declared value under the knowledge root',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'gap-drain-'))
      try {
        const handoff = factRun('r-gap-drain')
        const agentQaRoot = join(root, '.agent-qa')
        const knowledgeRoot = join(root, 'agent-qa-knowledge')
        mkdirSync(knowledgeRoot, { recursive: true })
        new FsHandoffStore({ root: agentQaRoot, runId: String(handoff.runId) }).save(handoff)
        const warns: string[] = []
        await runCurationTail({
          runId: String(handoff.runId),
          agentQaRoot,
          knowledgeConfig: { dir: 'agent-qa-knowledge' },
          configDir: root,
          mask: declaredMask(),
          log: { warn: (message: string) => warns.push(message) },
        })

        expect(warns.filter((line) => line.includes('incomplete'))).toEqual([])
        const bundlesDir = join(knowledgeRoot, 'memory', SCOPE_KEY, 'bundles')
        const facts = readdirSync(bundlesDir).filter((name) => name.startsWith('fact-'))
        expect(facts).toHaveLength(1)
        expect(readFileSync(join(bundlesDir, facts[0]!, 'record.md'), 'utf8')).toContain(MARKER)
        const leaked = committedFilesUnder(knowledgeRoot).filter((file) =>
          file.includes(DECLARED) || readFileSync(file, 'utf8').includes(DECLARED))
        expect(leaked).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    TAIL_TIMEOUT_MS,
  )

  it('a procedure seed masks target names, page routes and a typed declared value', () => {
    const root = mkdtempSync(join(tmpdir(), 'gap-procedure-'))
    try {
      const knowledgeRoot = join(root, 'agent-qa-knowledge')
      const runDir = join(root, 'runs', 'r-gap-procedure')
      mkdirSync(runDir, { recursive: true })
      const upper = DECLARED.toUpperCase()
      const handoff = run('r-gap-procedure', [
        step({
          stepIndex: 0,
          stepText: 'Open the admin account',
          target: element('open', upper),
          url: PAGE,
        }),
        step({
          stepIndex: 1,
          stepText: 'Type the admin user',
          target: element('user', upper, undefined, 'textbox'),
          url: PAGE,
          fillText: DECLARED,
        }),
      ])
      const report = emitCurationCandidates({
        handoff,
        runDir,
        knowledgeRoot,
        mask: declaredMask(),
      })

      const payloads = queuedPayloads(knowledgeRoot, report)
      const procedure = payloads.find((row) => row.kind === 'procedure')
      if (procedure === undefined) throw new Error('expected a queued procedure candidate')
      const seed = parseProcedureTrajectorySeed(procedure.bodySeed)
      if (seed === undefined) throw new Error('expected a parseable trajectory seed')
      const route = `https://shop.example/account?user=${MARKER}`
      expect(seed.steps.map((entry) => entry.pageRoute)).toEqual([route, route])
      expect(seed.steps.map((entry) => entry.action?.targets['ref']?.nameNormalized))
        .toEqual([MARKER, MARKER])
      expect(seed.steps[1]?.action?.values['text']).toEqual({
        observed: MARKER,
        source: 'masked-secret',
        sourceName: 'DECLARED_USER',
      })
      expect(JSON.stringify(procedure)).not.toContain(DECLARED)
      expect(JSON.stringify(payloads)).not.toContain(DECLARED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const GAP2_PAGE = 'https://shop.example/sign-in'

function maskOf(declared: Record<string, string>): (text: string) => string {
  const redactor = new SecretRedactor(new SecretStore(declared))
  return (text) => redactor.redactString(text)
}

function typedSlot(input: {
  runId: string
  declared: Record<string, string>
  fillText: string
  interpolatedVariables?: { name: string; value: string }[]
}): { slot: unknown; payloads: CurationCandidatePayload[] } {
  const root = mkdtempSync(join(tmpdir(), 'gap2-curation-'))
  try {
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const runDir = join(root, 'runs', input.runId)
    mkdirSync(runDir, { recursive: true })
    const report = emitCurationCandidates({
      handoff: run(input.runId, [
        step({
          stepIndex: 0,
          stepText: 'Open the sign-in form',
          target: element('open', 'Sign in'),
          url: GAP2_PAGE,
        }),
        step({
          stepIndex: 1,
          stepText: 'Type the value',
          target: element('field', 'Value', undefined, 'textbox'),
          url: GAP2_PAGE,
          fillText: input.fillText,
          ...(input.interpolatedVariables === undefined
            ? {}
            : { interpolatedVariables: input.interpolatedVariables }),
        }),
      ]),
      runDir,
      knowledgeRoot,
      mask: maskOf(input.declared),
    })
    const payloads = queuedPayloads(knowledgeRoot, report)
    const procedure = payloads.find((row) => row.kind === 'procedure')
    if (procedure === undefined) throw new Error('expected a queued procedure candidate')
    const seed = parseProcedureTrajectorySeed(procedure.bodySeed)
    if (seed === undefined) throw new Error('expected a parseable trajectory seed')
    return { slot: seed.steps[1]?.action?.values['text'], payloads }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('a typed value that contains a declared value', () => {
  it('a typed value that only contains a declared value is queued as a masked literal', () => {
    const { slot, payloads } = typedSlot({
      runId: 'r-gap2-extra',
      declared: { PW: 'hunter2' },
      fillText: 'hunter2-extra',
    })

    expect(slot).toEqual({ observed: '[secret:PW]-extra', source: 'literal' })
    expect(JSON.stringify(payloads)).not.toContain('hunter2')
  })

  it('a test variable whose value contains a declared value keeps its own binding', () => {
    const { slot } = typedSlot({
      runId: 'r-gap2-email',
      declared: { USER: 'qa-admin-42' },
      fillText: 'qa-admin-42@example.com',
      interpolatedVariables: [{ name: 'EMAIL', value: 'qa-admin-42@example.com' }],
    })

    expect(slot).toEqual({
      observed: '[secret:USER]@example.com',
      source: 'test-variable',
      sourceName: 'EMAIL',
    })
  })

  it('a template or marker with trailing text is not bound to the secret, and the whole value still is', () => {
    const declared = { PW: 'hunter2' }

    expect(typedSlot({
      runId: 'r-gap2-template',
      declared,
      fillText: '{{secret:PW}}-extra',
    }).slot).toEqual({ observed: '[secret:PW]-extra', source: 'literal' })
    expect(typedSlot({
      runId: 'r-gap2-marker',
      declared,
      fillText: '[secret:PW]-extra',
    }).slot).toEqual({ observed: '[secret:PW]-extra', source: 'literal' })
    expect(typedSlot({
      runId: 'r-gap2-whole',
      declared,
      fillText: 'hunter2',
    }).slot).toEqual({ observed: '[secret:PW]', source: 'masked-secret', sourceName: 'PW' })
  })
})
