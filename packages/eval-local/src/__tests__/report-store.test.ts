import * as fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

import { buildEvalReport, computeBatchKey } from '@vostride/agent-qa-eval'
import type { EvalBatchReport } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_EVAL_REPORTS_SUBDIR, FsReportStore } from '../report-store.js'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
}))

function report(batchKey?: string): EvalBatchReport {
  // A real eval-core report DTO — the store persists it verbatim, with no aggregation here.
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

describe('FsReportStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-reports-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('writes exactly one file, <slugged batchKey>.json under root/eval/reports/, with deterministic bytes', async () => {
    expect(DEFAULT_EVAL_REPORTS_SUBDIR).toBe('eval/reports')

    const batchReport = report()
    expect(batchReport.batchKey).toBe(computeBatchKey([]))
    const written = new FsReportStore({ root }).save(batchReport)

    const reportsRoot = join(root, DEFAULT_EVAL_REPORTS_SUBDIR)
    const expected = join(reportsRoot, `${slugBranch(batchReport.batchKey)}.json`)
    expect(written).toEqual({ batchKey: batchReport.batchKey, file: expected })
    expect(await readdir(reportsRoot)).toEqual([`${slugBranch(batchReport.batchKey)}.json`])

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
    expect((await readdir(join(root, DEFAULT_EVAL_REPORTS_SUBDIR))).sort()).toEqual(['batch-alpha.json', 'batch-beta.json'])
  })

  it('contains a hostile batchKey inside the reports root via slugBranch', async () => {
    const written = new FsReportStore({ root }).save(report('../../../escape/..\\evil'))

    const reportsRoot = join(root, DEFAULT_EVAL_REPORTS_SUBDIR)
    expect(relative(reportsRoot, written.file).startsWith('..')).toBe(false)
    expect(await exists(written.file)).toBe(true)

    // Nothing escapes the temp root: it contains only the eval/ staging subtree.
    expect(await readdir(root)).toEqual(['eval'])
  })

  it('names the report path on an interrupted replacement and leaves the old report and no staging directory', async () => {
    const store = new FsReportStore({ root })
    const old = report('interrupted')
    const written = store.save(old)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('interrupted replacement'), { code: 'EIO' })
    })
    expect(() => store.save({ ...old, modelMismatchCount: 5 })).toThrow(
      expect.objectContaining({ message: 'interrupted replacement', code: 'EIO', path: written.file }),
    )
    expect(await readFile(written.file, 'utf8')).toBe(`${JSON.stringify(old, null, 2)}\n`)
    expect(await readdir(join(root, DEFAULT_EVAL_REPORTS_SUBDIR))).toEqual(['interrupted.json'])
  })
})
