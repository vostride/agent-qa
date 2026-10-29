// The local reader answers from the target names a run's artifact recorded when it ran, written
// here through the runner's own stores. Current configuration is never an input, so renaming a
// target today cannot rewrite what an old run recorded, and a run with no recorded names stays
// `unknown`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import {
  ARTIFACT_FILE,
  FsHandoffStore,
  FsRunArtifactStore,
  RUNS_SUBDIR,
} from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  MaskedResolvedConfig,
  RunId,
  RunSummary,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRunsReader } from '../compose-local-agent.js'

const READER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

let projectRoot: string
let agentQaRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-qa-431-run-targets-'))
  agentQaRoot = join(projectRoot, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function complete(runId: string, endedAt: number): void {
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as RunId,
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: endedAt - 10,
    endedAt,
    tests: [{
      testId: `t-${runId}`,
      testName: `Checkout ${runId}`,
      filePath: 'tests/checkout.yaml',
      testIndex: 0,
      outcome: 'passed',
      steps: [],
    }],
  }
  new FsHandoffStore({ root: agentQaRoot, runId }).save(handoff)
}

function recordTargets(runId: string, targets: readonly string[]): void {
  new FsRunArtifactStore({ root: agentQaRoot, runId }).stage({
    source: {
      kind: 'test',
      testId: `t-${runId}`,
      name: `Checkout ${runId}`,
      filePath: 'tests/checkout.yaml',
      rawYaml: 'name: Checkout',
      resolvedDefinition: {
        name: `Checkout ${runId}`,
        target: 'a-line-in-the-file',
        steps: ['open the cart'],
      },
      loadStatus: 'loaded',
    },
    targets: [...targets],
  })
}

function writeRawArtifact(runDir: string, contents: string): void {
  const dir = join(agentQaRoot, RUNS_SUBDIR, runDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ARTIFACT_FILE), contents, 'utf8')
}

function lookup(runId: string) {
  return createRunsReader(agentQaRoot).getRecordedTargets!(runId as RunId)
}

describe('the local reader answers from the recorded target names', () => {
  it('reads a run that recorded one target', async () => {
    complete('run-single', 1_000)
    recordTargets('run-single', ['staging-web'])

    expect(await lookup('run-single')).toEqual({ status: 'recorded', names: ['staging-web'] })
  })

  it('reads several recorded targets as one stable, unique, sorted list', async () => {
    complete('run-suite', 1_000)
    recordTargets('run-suite', ['web-prod', 'android-qa', 'web-prod'])

    expect(await lookup('run-suite')).toEqual({
      status: 'recorded',
      names: ['android-qa', 'web-prod'],
    })
  })

  it('a run recorded with a source and no targets reads unknown', async () => {
    complete('run-source-only', 1_000)
    new FsRunArtifactStore({ root: agentQaRoot, runId: 'run-source-only' }).stage({
      source: {
        kind: 'test',
        name: 'Checkout',
        resolvedDefinition: { name: 'Checkout', target: 'staging-web', steps: ['open the cart'] },
        loadStatus: 'loaded',
      },
    })

    expect(await lookup('run-source-only')).toEqual({ status: 'unknown' })
  })

  it('answers unknown when the run recorded no artifact snapshot', async () => {
    complete('run-bare', 1_000)

    expect(await lookup('run-bare')).toEqual({ status: 'unknown' })
  })

  it.each([
    ['unparseable JSON', '{"schemaVersion":1,'],
    ['no recorded targets', JSON.stringify({ schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION })],
    ['an empty target list', JSON.stringify({ schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION, targets: [] })],
    ['a non-string target', JSON.stringify({ schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION, targets: [42] })],
    ['an empty target', JSON.stringify({ schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION, targets: [''] })],
    ['targets that are not a list', JSON.stringify({
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      targets: 'staging-web',
    })],
    ['a list with one malformed target', JSON.stringify({
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      targets: ['staging-web', ['android']],
    })],
  ])('answers unknown, never an empty known list, for %s', async (_label, contents) => {
    complete('run-malformed', 1_000)
    writeRawArtifact('run-malformed', contents)

    expect(await lookup('run-malformed')).toEqual({ status: 'unknown' })
  })

  it('never resolves an id the reader does not enumerate as a completed run', async () => {
    writeRawArtifact('run-orphan', JSON.stringify({
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      targets: ['orphan-target'],
    }))
    mkdirSync(join(agentQaRoot, 'outside'), { recursive: true })
    writeFileSync(join(agentQaRoot, 'outside', ARTIFACT_FILE), JSON.stringify({
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      targets: ['escaped'],
    }))

    expect(await lookup('run-orphan')).toEqual({ status: 'unknown' })
    expect(await lookup('../outside')).toEqual({ status: 'unknown' })
    expect(await lookup('../../etc')).toEqual({ status: 'unknown' })
  })

  it('never answers one run from another run directory', async () => {
    complete('run-a', 1_000)
    recordTargets('run-a', ['good-target'])
    const impostorDir = join(agentQaRoot, RUNS_SUBDIR, 'run-b')
    mkdirSync(impostorDir, { recursive: true })
    writeFileSync(join(impostorDir, 'handoff.json'), JSON.stringify({
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: 'run-a',
      scope: { tier: 'product', key: 'shop' },
      buildOrdinal: 1,
      executionContext: 'local-headless',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 0,
      endedAt: 1,
      tests: [],
    }))
    writeRawArtifact('run-b', JSON.stringify({
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      targets: ['impostor-target'],
    }))

    expect(await lookup('run-a')).toEqual({ status: 'recorded', names: ['good-target'] })
  })

  it('answers unknown when the snapshot disappears after the run list was read', async () => {
    complete('run-vanishing', 1_000)
    recordTargets('run-vanishing', ['staging-web'])
    const reader = createRunsReader(agentQaRoot)
    const [listed] = await reader.list()
    rmSync(join(agentQaRoot, RUNS_SUBDIR, 'run-vanishing', ARTIFACT_FILE))

    expect(await reader.getRecordedTargets!(listed!.runId)).toEqual({ status: 'unknown' })
  })
})

describe('runs.list filters on recorded targets, not current configuration', () => {
  let currentTargets: readonly string[]

  function maskedConfig(): MaskedResolvedConfig {
    return {
      schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
      configPath: join(projectRoot, 'agent-qa.config.yaml'),
      entries: currentTargets.map((name) => ({
        key: `registry.targets.${name}.url`,
        value: `https://${name}.example.test`,
        source: 'config-file' as const,
        masked: false,
      })),
    }
  }

  function writeCurrentConfig(): void {
    writeFileSync(join(projectRoot, 'agent-qa.config.yaml'), JSON.stringify({
      registry: {
        targets: Object.fromEntries(currentTargets.map((name) => [name, {
          platform: 'web',
          url: `https://${name}.example.test`,
        }])),
      },
    }))
  }

  function registry(): FunctionRegistry {
    return createFunctionRegistry({
      deps: {
        secretMask: (text: string) => text,
        runs: createRunsReader(agentQaRoot),
        knowledge: {
          listBundles: () => Promise.resolve([]),
          inspectRecords: () => Promise.resolve([]),
          diffSince: () => Promise.resolve([]),
          showRecord: ({ recordId }: { recordId: string }) =>
            Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
        },
        config: { getMasked: () => Promise.resolve(maskedConfig()) },
        entities: {
          resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
          get: () => Promise.resolve(undefined),
        },
      } as never,
    })
  }

  async function listed(input: unknown): Promise<RunSummary[]> {
    return await invokeFunction(registry(), 'runs.list', input, READER) as RunSummary[]
  }

  it('keeps a historical target match after the target is renamed in current configuration', async () => {
    complete('run-old', 1_000)
    recordTargets('run-old', ['staging-web'])
    complete('run-suite', 2_000)
    recordTargets('run-suite', ['staging-web', 'android-qa'])
    complete('run-unrecorded', 3_000)
    currentTargets = ['staging-web', 'android-qa']
    writeCurrentConfig()

    const before = await listed({ target: 'staging-web' })
    currentTargets = ['renamed-web']
    writeCurrentConfig()
    const after = await listed({ target: 'staging-web' })

    expect(before.map((row) => row.runId)).toEqual(['run-suite', 'run-old'])
    expect(after).toEqual(before)
    expect(await listed({ target: 'renamed-web' })).toEqual([])
    expect((await listed({})).map((row) => [row.runId, row.recordedTargets])).toEqual([
      ['run-unrecorded', { status: 'unknown' }],
      ['run-suite', { status: 'recorded', names: ['android-qa', 'staging-web'] }],
      ['run-old', { status: 'recorded', names: ['staging-web'] }],
    ])
  })
})
