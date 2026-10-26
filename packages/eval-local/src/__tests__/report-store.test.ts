import * as fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

import { buildEvalReport, computeBatchKey, deriveLeafCassetteId, projectDecisionVectorsDocument } from '@vostride/agent-qa-eval'
import type { EvalBatchReport } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_EVAL_REPORTS_SUBDIR, FsReportStore, loadStagedReport } from '../report-store.js'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
}))

function report(batchKey?: string): EvalBatchReport {
  // A real eval-core report DTO — the store persists it verbatim (F9: no aggregation here).
  const built = buildEvalReport([])
  return batchKey === undefined ? built : { ...built, batchKey }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('FsReportStore (D-13/D-14)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-reports-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('writes <slugged batchKey>.json under root/eval/reports/ with deterministic bytes', async () => {
    expect(DEFAULT_EVAL_REPORTS_SUBDIR).toBe('eval/reports')

    const batchReport = report()
    expect(batchReport.batchKey).toBe(computeBatchKey([]))
    const written = new FsReportStore({ root }).save(batchReport)

    const expected = join(
      root,
      DEFAULT_EVAL_REPORTS_SUBDIR,
      `${slugBranch(batchReport.batchKey)}.json`,
    )
    expect(written.file).toBe(expected)

    const raw = await readFile(expected, 'utf8')
    expect(raw).toBe(`${JSON.stringify(batchReport, null, 2)}\n`)
    expect(JSON.parse(raw)).toEqual(batchReport)
  })

  it('rerun-stable: same batch key overwrites, a different key lands beside it untouched', async () => {
    const store = new FsReportStore({ root })

    const first = store.save({ ...report('batch-alpha'), modelMismatchCount: 1 })
    const rerun = store.save({ ...report('batch-alpha'), modelMismatchCount: 2 })
    expect(rerun.file).toBe(first.file)
    const rerunRaw = await readFile(rerun.file, 'utf8')
    expect((JSON.parse(rerunRaw) as EvalBatchReport).modelMismatchCount).toBe(2)

    const sibling = store.save(report('batch-beta'))
    expect(sibling.file).not.toBe(first.file)
    expect(await exists(first.file)).toBe(true)
    expect((JSON.parse(await readFile(first.file, 'utf8')) as EvalBatchReport).modelMismatchCount).toBe(2)
  })

  it('contains a hostile batchKey inside the reports root via slugBranch', async () => {
    const written = new FsReportStore({ root }).save(report('../../../escape/..\\evil'))

    const reportsRoot = join(root, DEFAULT_EVAL_REPORTS_SUBDIR)
    expect(relative(reportsRoot, written.file).startsWith('..')).toBe(false)
    expect(await exists(written.file)).toBe(true)

    // Nothing escapes the temp root: it contains only the eval/ staging subtree.
    expect(await readdir(root)).toEqual(['eval'])
  })

  it('honors an explicit outputDir override', async () => {
    const outputDir = join(root, 'retargeted-reports')
    const batchReport = report('batch-gamma')
    const written = new FsReportStore({ root, outputDir }).save(batchReport)

    expect(written.file).toBe(join(outputDir, `${slugBranch('batch-gamma')}.json`))
    expect(await exists(join(root, DEFAULT_EVAL_REPORTS_SUBDIR))).toBe(false)
  })

  function decisions(batchReport: EvalBatchReport) {
    return projectDecisionVectorsDocument({
      batchKey: batchReport.batchKey, matcherVersion: batchReport.matcherVersion, vectors: [],
    })
  }

  function scoredPair(correct: boolean) {
    const cassetteId = deriveLeafCassetteId({
      runSlug: 'r_proper-ewer-rud-ignore-ula-junk-may-effect-eva-ada',
      testIndex: 0, stepIndex: 0, decisionOrdinal: 0,
    })
    const batchReport = report(computeBatchKey([cassetteId]))
    batchReport.headline.firstAttemptDecisionAccuracy = {
      numerator: Number(correct), denominator: 1, rate: Number(correct),
    }
    batchReport.runIdentity = { fingerprint: 'a'.repeat(64), corpusDigest: 'b'.repeat(64) }
    const document = projectDecisionVectorsDocument({
      batchKey: batchReport.batchKey, matcherVersion: batchReport.matcherVersion,
      vectors: [{ cassetteId, key: `${cassetteId}#-#0`, decisionOrdinal: 0,
        product: 'example-web', briefSource: 'proof', axes: {
          headline: correct ? 'correct' : 'incorrect', elementIdentity: 'correct',
          value: 'not-applicable', loop: 'not-applicable', opClass: 'correct', sideEffect: 'correct',
        } }],
    })
    return { batchReport, document }
  }

  it('rejects sidecars from a different report generation even with the same run identity', async () => {
    const store = new FsReportStore({ root })
    const old = scoredPair(true)
    const next = scoredPair(false)
    const written = store.save(old.batchReport, old.document)
    const oldBytes = await readFile(written.decisionsFile!, 'utf8')
    store.save(next.batchReport, next.document)
    await writeFile(written.decisionsFile!, oldBytes)
    expect(loadStagedReport(root, next.batchReport.batchKey)).toMatchObject({
      kind: 'refused', reason: expect.stringMatching(/publication|digest/),
    })
  })

  it('rejects an interleaved reader spanning replacement of a legacy unbound report pair', async () => {
    const old = scoredPair(true)
    const next = scoredPair(false)
    const outputDir = join(root, DEFAULT_EVAL_REPORTS_SUBDIR)
    fs.mkdirSync(outputDir, { recursive: true })
    const file = join(outputDir, `${old.batchReport.batchKey}.json`)
    await writeFile(file, JSON.stringify(old.batchReport))
    await writeFile(join(outputDir, `${old.batchReport.batchKey}.decisions.json`), JSON.stringify(old.document))
    expect(loadStagedReport(root, old.batchReport.batchKey)).toMatchObject({ kind: 'loaded', decisions: old.document })
    const read = fs.readFileSync
    let replaced = false
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (!replaced && String(args[0]).endsWith('.decisions.json')) {
        replaced = true
        new FsReportStore({ root }).save(next.batchReport, next.document)
      }
      return read(...args)
    })
    expect(loadStagedReport(root, old.batchReport.batchKey)).toMatchObject({ kind: 'refused' })
  })

  it.each(['publication', 'report', 'decisions'] as const)(
    'keeps a coherent old pair or refuses after interruption at the %s replacement', part => {
      const store = new FsReportStore({ root })
      const old = scoredPair(true)
      const next = scoredPair(false)
      const written = store.save(old.batchReport, old.document)
      const rename = fs.renameSync
      vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
        if (String(target) === (part === 'report' ? written.file
          : written.file.replace(/\.json$/, `.${part}.json`))) {
          throw Object.assign(new Error('interrupted replacement'), { code: 'EIO', path: String(target) })
        }
        return rename(source, target)
      })
      expect(() => store.save(next.batchReport, next.document)).toThrow('interrupted replacement')
      const loaded = loadStagedReport(root, next.batchReport.batchKey)
      if (part === 'publication') {
        expect(loaded).toMatchObject({ kind: 'loaded', report: old.batchReport, decisions: old.document })
      } else {
        expect(loaded.kind).toBe('refused')
      }
      expect(fs.readdirSync(join(root, DEFAULT_EVAL_REPORTS_SUBDIR))
        .filter(name => name.startsWith('.publish-'))).toEqual([])
    },
  )

  it.each([false, true])('refuses interleaved writers even when reports are identical (%s)', identical => {
    const store = new FsReportStore({ root })
    const first = scoredPair(true)
    const next = scoredPair(false)
    if (identical) next.batchReport = first.batchReport
    const rename = fs.renameSync
    let interleaved = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      rename(source, target)
      if (!interleaved && String(target) === join(root, DEFAULT_EVAL_REPORTS_SUBDIR, `${first.batchReport.batchKey}.json`)) {
        interleaved = true
        store.save(next.batchReport, next.document)
      }
    })
    store.save(first.batchReport, first.document)
    expect(interleaved).toBe(true)
    expect(loadStagedReport(root, first.batchReport.batchKey)).toMatchObject({ kind: 'refused' })
  })

  it('round-trips a report and staged decisions without dropping seed, honesty, judge or cost', async () => {
    const batchReport = buildEvalReport([], {
      judgeModelId: 'fixture-judge', judgeFamily: 'fixture-family', judgeVersion: 1,
      confidenceThreshold: 'high',
    }, undefined, { declaredSeed: 11 })
    batchReport.seedHonored = false
    batchReport.totalCost.promptTokens = 17
    batchReport.honesty.harnessErrorCount = 2
    batchReport.honesty.judge.cost.calls = 1
    const document = decisions(batchReport)
    const written = new FsReportStore({ root }).save(batchReport, document)
    expect(written.decisionsFile).toBe(join(root, DEFAULT_EVAL_REPORTS_SUBDIR,
      `${slugBranch(batchReport.batchKey)}.decisions.json`))
    expect(await readFile(written.decisionsFile!, 'utf8')).toBe(`${JSON.stringify(document, null, 2)}\n`)
    expect(loadStagedReport(root, batchReport.batchKey)).toEqual({
      kind: 'loaded', report: batchReport, decisions: document, file: written.file,
    })
  })

  it('loads historical reports without a sidecar and names an absent report exactly', () => {
    const batchReport = report('historical')
    const file = join(root, DEFAULT_EVAL_REPORTS_SUBDIR, 'historical.json')
    expect(loadStagedReport(root, batchReport.batchKey)).toEqual({ kind: 'absent', file })
    expect(new FsReportStore({ root }).save(batchReport)).not.toHaveProperty('decisionsFile')
    expect(loadStagedReport(root, batchReport.batchKey)).toEqual({ kind: 'loaded', report: batchReport, file })
  })

  it.each([
    { judgeIdentity: 'mixed', mixedJudgeModelIds: 'malformed-list' },
    { judgeIdentity: 'mixed', mixedJudgeModelIds: ['valid', null] },
    { judgeIdentity: 'unknown' },
    { judge: 'malformed-block' },
    { judge: { judgeModelId: 'judge-only' } },
  ])('refuses malformed optional judge metadata without stripping it: %j', async metadata => {
    const batchReport = report()
    const { file } = new FsReportStore({ root }).save(batchReport)
    await writeFile(file, JSON.stringify({ ...batchReport, ...metadata }))
    expect(loadStagedReport(root, batchReport.batchKey)).toMatchObject({
      kind: 'refused', file, reason: expect.stringContaining('report rejected'),
    })
  })

  it('preserves valid mixed judge history and its absent judge block', async () => {
    const batchReport = buildEvalReport([], undefined, {
      judgeIdentity: 'mixed', judgeModelIds: ['judge-a', 'judge-b'],
    })
    const { file } = new FsReportStore({ root }).save(batchReport)
    expect(loadStagedReport(root, batchReport.batchKey)).toEqual({ kind: 'loaded', file, report: batchReport })
  })

  it('probes only the chosen directory, with no fallback to another report or sidecar', () => {
    const batchReport = report('retargeted')
    const document = decisions(batchReport)
    const defaultWrite = new FsReportStore({ root }).save(batchReport, document)
    const outputDir = join(root, 'chosen')
    const file = join(outputDir, 'retargeted.json')
    expect(loadStagedReport(root, batchReport.batchKey, outputDir)).toEqual({ kind: 'absent', file })
    const retargeted = { ...batchReport, modelMismatchCount: 9 }
    new FsReportStore({ root, outputDir }).save(retargeted)
    expect(loadStagedReport(root, batchReport.batchKey, outputDir)).toEqual({
      kind: 'loaded', report: retargeted, file,
    })
    expect(loadStagedReport(root, batchReport.batchKey)).toEqual({
      kind: 'loaded', report: batchReport, decisions: document, file: defaultWrite.file,
    })
  })

  it('removes only a stale owned sidecar when the same batch is saved without decisions', async () => {
    const store = new FsReportStore({ root })
    const first = report('repeated')
    const old = store.save(first, decisions(first))
    const sidecar = join(root, DEFAULT_EVAL_REPORTS_SUBDIR, 'repeated.decisions.json')
    expect(await exists(sidecar)).toBe(true)
    const sibling = report('sibling')
    const siblingWrite = store.save(sibling, decisions(sibling))
    const sentinel = join(root, DEFAULT_EVAL_REPORTS_SUBDIR, 'keep.txt')
    await writeFile(sentinel, 'owned fixture sentinel')
    const updated = { ...first, modelMismatchCount: 3 }
    const saved = store.save(updated)
    expect(saved).not.toHaveProperty('decisionsFile')
    expect(await exists(sidecar)).toBe(false)
    expect(loadStagedReport(root, first.batchKey)).toEqual({
      kind: 'loaded', report: updated, file: old.file,
    })
    expect(await exists(siblingWrite.decisionsFile!)).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('owned fixture sentinel')
  })

  it.each(['batchKey', 'matcherVersion'] as const)(
    'refuses a sidecar with a foreign %s on read', async field => {
      const batchReport = report('paired')
      const document = decisions(batchReport)
      const written = new FsReportStore({ root }).save(batchReport)
      if (field === 'batchKey') document.batchKey = 'foreign'
      else document.matcherVersion += 1
      const file = join(root, DEFAULT_EVAL_REPORTS_SUBDIR, 'paired.decisions.json')
      await writeFile(file, JSON.stringify(document))
      expect(loadStagedReport(root, batchReport.batchKey)).toEqual({
        kind: 'refused', file, reason: expect.stringContaining(field),
      })
      expect(await readFile(written.file, 'utf8')).toBe(`${JSON.stringify(batchReport, null, 2)}\n`)
    },
  )

  it('refuses a report whose identity differs from the requested staging key', async () => {
    const requested = report('requested')
    const written = new FsReportStore({ root }).save(requested)
    await writeFile(written.file, JSON.stringify(report('foreign')))
    expect(loadStagedReport(root, requested.batchKey)).toEqual({
      kind: 'refused', file: written.file, reason: expect.stringContaining('batchKey'),
    })
  })

  it.each(['not json', '{"batchKey":"invalid"}'])(
    'refuses malformed staged report bytes %s without throwing', async raw => {
      const written = new FsReportStore({ root }).save(report('invalid'))
      await writeFile(written.file, raw)
      expect(loadStagedReport(root, 'invalid')).toEqual({
        kind: 'refused', file: written.file, reason: expect.any(String),
      })
    },
  )

  it.each(['not json', '{"schemaVersion":3}'])(
    'refuses malformed staged decisions bytes %s without throwing', async raw => {
      const batchReport = report('invalid-sidecar')
      new FsReportStore({ root }).save(batchReport)
      const file = join(root, DEFAULT_EVAL_REPORTS_SUBDIR, 'invalid-sidecar.decisions.json')
      await writeFile(file, raw)
      expect(loadStagedReport(root, batchReport.batchKey)).toEqual({
        kind: 'refused', file, reason: expect.any(String),
      })
    },
  )

  it.each(['batchKey', 'matcherVersion'] as const)(
    'rejects a foreign decisions %s on save without changing the existing pair', async field => {
      const store = new FsReportStore({ root })
      const batchReport = report('paired')
      const document = decisions(batchReport)
      const original = store.save(batchReport, document)
      if (field === 'batchKey') document.batchKey = 'foreign'
      else document.matcherVersion += 1
      expect(() => store.save({ ...batchReport, modelMismatchCount: 7 }, document)).toThrow(TypeError)
      expect(await readFile(original.file, 'utf8')).toBe(`${JSON.stringify(batchReport, null, 2)}\n`)
      expect(JSON.parse(await readFile(original.decisionsFile!, 'utf8'))).toEqual(decisions(batchReport))
    },
  )
})
