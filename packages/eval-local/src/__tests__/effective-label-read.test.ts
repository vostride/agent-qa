import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJson, computeCorpusDigest, createLabelRevision, extractRunCassettes,
  projectCorpusEntry, projectSilverLabelRecord,
} from '@vostride/agent-qa-eval'
import type { StandaloneLabelRecord } from '@vostride/agent-qa-eval'
import { asRunId, sha256hex } from '@vostride/agent-qa-schema'
import { readCommittedCorpus, readActiveCommittedCorpus } from '../index.js'
import { committedCassettePath, committedCorpusPath, committedLabelPath } from '../committed-root-store.js'
import { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES, LOCAL_FIXTURE_BLOB_SHA } from './fixtures/local-handoff-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function write(root: string, path: string, value: unknown) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(value))
  return target
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-effective-label-'))
  roots.push(root)
  const handoff = makeLocalV2Handoff()
  handoff.runId = asRunId('effective-label-run')
  const cassette = extractRunCassettes({ handoff, artifacts: { getBlob: sha => sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined } }).cassettes.map(row => row.cassette).find(row => row.granularity === 'leaf')!
  if (cassette.granularity !== 'leaf') throw new Error('fixture requires a leaf')
  const entry = projectCorpusEntry({ cassette, product: 'fixture', runId: handoff.runId, assignment: { split: 'natural' } })
  const original = projectSilverLabelRecord({ cassette, runId: handoff.runId })
  const cassettePath = write(root, committedCassettePath(entry.product, cassette.id), cassette)
  const entryPath = write(root, committedCorpusPath(entry.product, cassette.id), entry)
  const labelPath = write(root, committedLabelPath(entry.product, cassette.id), original)
  return { root, entry, original, cassette, handoff, cassettePath, entryPath, labelPath }
}
function append(fixture: ReturnType<typeof setup>, record: StandaloneLabelRecord) {
  return write(fixture.root, committedLabelPath(fixture.entry.product, record.cassetteId).replace(/\.json$/, `--revision-${record.revision!.id}.json`), record)
}

describe('420 effective committed label reads', () => {
  it('reads terminal revisions without mutating cassette or membership bytes', () => {
    const f = setup()
    const before = readCommittedCorpus(f.root)
    const bytes = [f.cassettePath, f.entryPath, f.labelPath].map(path => sha256hex(readFileSync(path, 'utf8')))
    const next = createLabelRevision(f.original, { provenance: { ...f.original.provenance, rerun: { attempt: 1 } } })
    append(f, next)
    const after = readCommittedCorpus(f.root)
    expect(after.snapshot.labelsById.get(f.original.cassetteId)).toEqual(next)
    expect(after.snapshot.labelHistory).toHaveLength(2)
    expect(after.refusals).toEqual([])
    expect(after.snapshot.entries).toEqual(before.snapshot.entries)
    expect(computeCorpusDigest(after.snapshot.entries)).toBe(computeCorpusDigest(before.snapshot.entries))
    expect([f.cassettePath, f.entryPath, f.labelPath].map(path => sha256hex(readFileSync(path, 'utf8')))).toEqual(bytes)
    expect(canonicalJson(createLabelRevision(next, { provenance: next.provenance }))).toBe(canonicalJson(next))
  })

  it('keeps quarantine history but excludes the embedded silver scoring entry', () => {
    const f = setup()
    const next = createLabelRevision(f.original, { quarantine: 'rerun-overturned' })
    append(f, next)
    const read = readCommittedCorpus(f.root)
    expect(read.snapshot.entries).toEqual([])
    expect(read.snapshot.labelsById.get(f.original.cassetteId)).toEqual(next)
    expect(read.snapshot.labelHistory).toHaveLength(2)
    expect(read.snapshot.excludedLabelIds?.has(f.original.cassetteId)).toBe(true)
    expect(read.snapshot.cassettesById.get(f.original.cassetteId)?.label.tier).toBe('silver')
    expect(readActiveCommittedCorpus(f.root, join(f.root, 'runtime')).snapshot.entries).toEqual([])
  })

  it('fails closed for forks in either creation order and retains original bytes', () => {
    for (const reversed of [false, true]) {
      const f = setup()
      const records = [createLabelRevision(f.original, { quarantine: 'rerun-overturned' }), createLabelRevision(f.original, { provenance: { ...f.original.provenance, rerun: { attempt: 1 } } })]
      for (const record of reversed ? records.reverse() : records) append(f, record)
      const read = readCommittedCorpus(f.root)
      expect(read.snapshot.labelsById.has(f.original.cassetteId)).toBe(false)
      expect(read.snapshot.entries).toEqual([])
      expect(read.refusals.some(row => row.reason.includes('fork'))).toBe(true)
      expect(read.snapshot.labelHistory).toHaveLength(3)
    }
  })

  it('does not resurrect silver when authoritative JSON or numerical data is malformed', () => {
    for (const corrupt of ['{broken', JSON.stringify({ invalid: true })]) {
      const f = setup()
      writeFileSync(f.labelPath, corrupt)
      const read = readCommittedCorpus(f.root)
      expect(read.snapshot.entries).toEqual([])
      expect(read.snapshot.excludedLabelIds?.has(f.original.cassetteId)).toBe(true)
      expect(read.refusals.length).toBeGreaterThan(0)
    }
    const f = setup()
    const next = createLabelRevision(f.original, { quarantine: 'rerun-overturned' })
    const path = append(f, next)
    writeFileSync(path, JSON.stringify({ ...next, weight: { value: 2 } }))
    expect(readCommittedCorpus(f.root).snapshot.entries).toEqual([])
  })

  it('ignores unpublished generation revisions and refuses forged filename or product ownership', () => {
    const f = setup()
    append(f, createLabelRevision(f.original, { quarantine: 'rerun-overturned' }, 'unpublished'))
    expect(readCommittedCorpus(f.root).snapshot.labelsById.get(f.original.cassetteId)).toEqual(f.original)
    expect(readCommittedCorpus(f.root).snapshot.entries).toHaveLength(1)
    const next = createLabelRevision(f.original, { quarantine: 'rerun-overturned' })
    write(f.root, committedLabelPath('foreign', f.original.cassetteId).replace(/\.json$/, `--revision-${next.revision!.id}.json`), next)
    const read = readCommittedCorpus(f.root)
    expect(read.refusals.some(row => row.reason.includes('ownership'))).toBe(true)
    expect(read.snapshot.entries).toEqual([])
    const wrongName = setup()
    write(wrongName.root, committedLabelPath('fixture', wrongName.original.cassetteId).replace(/\.json$/, `--revision-${'f'.repeat(64)}.json`), createLabelRevision(wrongName.original, { quarantine: 'rerun-overturned' }))
    expect(readCommittedCorpus(wrongName.root).snapshot.entries).toEqual([])
  })

})
