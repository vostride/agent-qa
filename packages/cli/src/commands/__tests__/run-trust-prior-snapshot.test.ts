import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from 'commander'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { calibrateLabels, canonicalJson } from '@vostride/agent-qa-eval'
import { sha256hex } from '@vostride/agent-qa-schema'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import { createRunCommand } from '../run.js'
import * as drive from '../../composition/in-process-run-execution.js'
import * as tail from '../../curation/post-run-tail-composition.js'

vi.mock('@vostride/agent-qa-eval-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-eval-local')>()
  return { ...actual, readLabelCalibration: vi.fn(actual.readLabelCalibration) }
})
vi.mock('@vostride/agent-qa-agent-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-agent-local')>()
  return { ...actual, openRunKnowledgeComposition: vi.fn(actual.openRunKnowledgeComposition) }
})
import { LABEL_CALIBRATION_SCHEMA_VERSION, readLabelCalibration } from '@vostride/agent-qa-eval-local'
import { openRunKnowledgeComposition } from '@vostride/agent-qa-agent-local'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => { removeInProcessFixtures() })

function artifact(root: string, precision: number) {
  const report = calibrateLabels({ snapshot: { entries: [], labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map() }, marks: [] })
  const body = { ...report, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('command fixture'), targetRevisions: [],
    channels: { ...report.channels, 'recorded-verdict': { status: 'calibrated', n: 20, n_gold: 20, precision,
      wilson95: { lower: 0.1, upper: 0.9, halfWidth: 0.4 } } },
    priors: { 'agent-verified': { alpha: precision * 3, beta: (1 - precision) * 3 } } }
  const value = { ...body, generationId: sha256hex(canonicalJson(body)) }
  const path = join(root, 'agent-qa-eval/labels/calibration.json')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value))
  return value
}

it.each([
  ['direct', false], ['direct', true], ['suite', false], ['suite', true],
] as const)('ordinary %s command keeps one snapshot (malformed replacement=%s)', async (mode, malformed) => {
    vi.clearAllMocks()
    const f = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
    roots.push(f.project)
    const old = artifact(f.project, 0.75)
    vi.stubEnv('DO_NOT_TRACK', '1')
    // The update notice answers from a fresh cache in a temporary HOME: no registry, no real home.
    const home = freshUpdateCheckHome()
    roots.push(home)
    vi.stubEnv('HOME', home)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider access forbidden'))
    vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockResolvedValue(undefined)
    vi.mocked(openRunKnowledgeComposition).mockImplementation(() => { throw new Error('captured serving boundary') })
    const actualTail = tail.composeCliPostRunTail
    const composedTail = vi.spyOn(tail, 'composeCliPostRunTail').mockImplementation(input => {
      const handle = actualTail(input)
      return { ...handle, drain: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    })
    const execution = vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
      // The command has already composed its REAL producer. Read its serving seam before the
      // simulated verdict, without a browser, planner, provider, gate or synthetic producer.
      const produced = await input.produceMembers!({} as never)
      try {
        if (mode === 'suite') expect(() => produced.bindKnowledge!(1)).toThrow('captured serving boundary')
        else {
          const result = await produced.executor(produced.members[0]!, { testIndex: 0 } as never)
          expect(result.failureSummary).toContain('captured serving boundary')
        }
        expect(vi.mocked(openRunKnowledgeComposition).mock.calls.at(-1)![0].resolveTrustPriors?.()).toEqual(old.priors)
        if (malformed) writeFileSync(join(f.project, 'agent-qa-eval/labels/calibration.json'), '{"private":"invalid replacement"}')
        else artifact(f.project, 0.25)
        await input.afterVerdict!({ verdict: 'passed', exitCode: input.freezeVerdict!('passed'), runId: request.runId, configDir: f.project,
          configFilePath: f.configPath, postVerdict: { takeAcquiredLease: () => undefined } } as never)
        return { runId: request.runId, exitCode: 0 } as never
      } finally { await produced.finalize?.() }
    })
    const program = new Command().option('--config <path>').addCommand(createRunCommand())
    await expect(program.parseAsync(['--config', f.configPath, 'run', mode === 'suite' ? f.suitePattern : f.testPattern], { from: 'user' }))
      .rejects.toThrow('fixture command exit')
    expect(execution).toHaveBeenCalledTimes(1)
    expect(exit.mock.calls[0]![0]).toBe(0)
    const serving = vi.mocked(openRunKnowledgeComposition).mock.calls.at(-1)![0].resolveTrustPriors
    expect(composedTail.mock.calls[0]![0].trustPriors?.resolve).toBe(serving)
    expect(composedTail.mock.calls[0]![0].trustPriors?.resolve()).toEqual(old.priors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
})
