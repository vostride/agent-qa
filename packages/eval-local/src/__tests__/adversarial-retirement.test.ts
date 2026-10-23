import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, symlinkSync, renameSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  committedFileText,
  computeCorpusDigest,
  extractRunCassettes,
  projectCorpusEntry,
  projectSilverLabelRecord,
  type ArtifactSource,
  type LeafCassette,
  type SeedingPlan,
} from '@vostride/agent-qa-eval'
import {
  asRunId,
  computeBriefDigest,
  type LosslessServedBriefProofV1,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import {
  retireStagedAdversarialBatch,
  listStagedAdversarial,
  refreshAdversarialSplit,
  stageAdversarialProposal,
  type AdversarialAdmissionResult,
} from '../adversarial-composition.js'
import { readCommittedCorpus } from '../committed-corpus-source.js'
import { committedCassettePath } from '../committed-root-store.js'
import { seedCommittedCorpus } from '../seeding-composition.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'

const NO_DECLARED_SECRETS = (text: string) => text

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function proof(): LosslessServedBriefProofV1 {
  return {
    schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
    completeness: 'lossless',
    recordCap: 8,
    combinedBudget: 2048,
    admissionEvents: [],
    promptTurns: [
      {
        ordinal: 0,
        turnOrdinal: 0,
        runDate: '2026-09-11',
        policyL0: 'policy',
        learnedL1: 'learned one',
        learnedL2: 'learned two',
        contextTier: 'context',
        volatileTier: 'volatile',
        policyDigest: '1'.repeat(64),
        contextTierDigest: '2'.repeat(64),
        volatileTierDigest: '3'.repeat(64),
      },
    ],
  }
}

const artifacts: ArtifactSource = {
  getBlob: sha => (sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined),
}

interface Fixture {
  root: string
  committedRoot: string
  agentQaRoot: string
  seedIds: readonly string[]
}

/** `count` committed proof-backed natural leaf seeds, one per run so the ids differ. */
function fixture(count: number): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-admission-'))
  roots.push(root)
  const committedRoot = join(root, 'committed')
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  const seedIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const handoff = makeLocalV2Handoff({
      runId: asRunId(`run / adversarial-admission ${String(index).padStart(2, '0')}`),
    })
    const member = handoff.tests[0]!
    member.steps = [member.steps[0]!]
    const brief = member.steps[0]!.servedBrief
    brief.proof = proof()
    brief.channel3 = [{ id: 'adversarial-admission-caution' as never, anchors: [], summary: 'served caution' }]
    brief.briefDigest = computeBriefDigest(brief)
    const extraction = extractRunCassettes({ handoff, artifacts })
    const extracted = extraction.cassettes.find(row => row.cassette.granularity === 'leaf')!
    const seed = extracted.cassette as LeafCassette
    const plan: SeedingPlan = {
      product: 'default',
      runId: handoff.runId,
      runSlug: `adversarial-admission-${String(index).padStart(2, '0')}`,
      cases: [
        {
          cassetteId: seed.id,
          labelRecord: projectSilverLabelRecord({ cassette: seed, runId: handoff.runId }),
          corpusEntry: projectCorpusEntry({
            cassette: seed,
            product: 'default',
            runId: handoff.runId,
            assignment: { split: 'natural' },
          }),
        },
      ],
      pairSkips: [],
      silverExclusions: [],
      pairCounts: { total: 0, sameState: 0, differingState: 0 },
      proceduresExcludedCount: 0,
    }
    expect(
      seedCommittedCorpus({
        plan,
        cassettes: [{ cassette: seed, blobs: extracted.blobs }],
        committedRoot,
        mask: NO_DECLARED_SECRETS,
      }).refusals,
    ).toEqual([])
    seedIds.push(seed.id)
  }
  return { root, committedRoot, agentQaRoot, seedIds: [...seedIds].sort() }
}

async function stage(f: Fixture, mutator: 'confusable' | 'invisible' = 'confusable') {
  const staged = await stageAdversarialProposal({
    agentQaRoot: f.agentQaRoot,
    committedRoot: f.committedRoot,
    product: 'default',
    mutators: [mutator],
  })
  expect(staged.kind).toBe('staged')
  return staged
}

function admit(
  f: Fixture,
  batchDigest: string,
  opts: { afterCaseCommitted?: (cassetteId: string) => void; dryRun?: boolean } = {},
): AdversarialAdmissionResult {
  return refreshAdversarialSplit({
    agentQaRoot: f.agentQaRoot,
    committedRoot: f.committedRoot,
    product: 'default',
    batchDigest,
    ...(opts.afterCaseCommitted === undefined ? {} : { afterCaseCommitted: opts.afterCaseCommitted }),
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    mask: NO_DECLARED_SECRETS,
  })
}

function corpusDigest(committedRoot: string): string {
  return computeCorpusDigest(readCommittedCorpus(committedRoot).snapshot.entries)
}

function committedIds(committedRoot: string): string[] {
  return readCommittedCorpus(committedRoot)
    .snapshot.entries.filter(entry => entry.split === 'adversarial')
    .map(entry => entry.cassetteId)
    .sort()
}

function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return { '<absent>': '' }
  if (fs.lstatSync(root).isFile()) return { '<file>': readFileSync(root).toString('base64') }
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name).slice(root.length),
      readFileSync(join(entry.parentPath, entry.name)).toString('base64')]))
}

async function stagedFixture(count = 3) {
  const f = fixture(count)
  const staged = await stage(f)
  const batchDigest = staged.batchDigest!
  const dir = listStagedAdversarial({ agentQaRoot: f.agentQaRoot, product: 'default' })[0]!.dir
  const lock = join(dir, '..', `.pending-lifecycle-${batchDigest}`)
  return { ...f, batchDigest, dir, lock, product: 'default' }
}

describe('422 adversarial retirement integrity and recovery', () => {
  it('preserves an operational before-write TypeError instead of calling it staging corruption', async () => {
    const f = await stagedFixture(1)
    const before = tree(f.committedRoot)
    const failure = new TypeError('standing knowledge receipt schema is unavailable')
    expect(() => refreshAdversarialSplit({ ...f,
      beforeWrites: () => { throw failure }, mask: NO_DECLARED_SECRETS,
    })).toThrow(failure)
    expect(tree(f.committedRoot)).toEqual(before)
    expect(existsSync(f.lock)).toBe(false)
  })

  it('refuses an unexpected symlink inside the reviewed batch before publishing a decision', async () => {
    const f = await stagedFixture()
    symlinkSync(f.committedRoot, join(f.dir, 'unreviewed-link'))
    const before = tree(f.committedRoot)
    expect(() => retireStagedAdversarialBatch(f)).toThrow(/unsafe|unexpected/)
    expect(existsSync(join(f.dir, 'retirement.json'))).toBe(false)
    expect(tree(f.committedRoot)).toEqual(before)
  })

  it('keeps partial admission survivors and blocks both real and preview retries', async () => {
    const f = await stagedFixture()
    const interrupted = admit(f, f.batchDigest, { afterCaseCommitted: () => { throw new Error('stop after one') } })
    expect(interrupted).toMatchObject({ kind: 'partial', reason: 'admission-interrupted' })
    expect(interrupted.admitted).toHaveLength(1)
    const corpus = tree(f.committedRoot)
    const spend = tree(join(f.agentQaRoot, 'eval/adversarial-state'))
    const result = retireStagedAdversarialBatch(f)
    expect(result.alreadyCommittedCaseIds).toEqual(interrupted.admitted.map(row => row.cassetteId))
    expect(result.remainingCaseIds).toHaveLength(2)
    for (const dryRun of [false, true]) expect(admit(f, f.batchDigest, { dryRun })).toMatchObject({
      kind: 'refused', reason: 'admission-refused', writesStarted: false, admitted: [], retirement: { retired: true } })
    expect(tree(f.committedRoot)).toEqual(corpus)
    expect(tree(join(f.agentQaRoot, 'eval/adversarial-state'))).toEqual(spend)
    expect(listStagedAdversarial(f)).toEqual([])
    expect(listStagedAdversarial({ ...f, includeRetired: true })).toHaveLength(1)
    expect((await stageAdversarialProposal({ ...f, mutators: ['confusable'] })).kind).toBe('nothing-derived')
    expect(tree(join(f.agentQaRoot, 'eval/adversarial-state'))).toEqual(spend)
  })

  it('discloses a fully committed retained batch without deleting committed history', async () => {
    const f = await stagedFixture(1)
    const interrupted = admit(f, f.batchDigest, { afterCaseCommitted: () => { throw new Error('last case') } })
    const corpus = tree(f.committedRoot)
    const retired = retireStagedAdversarialBatch(f)
    expect(retired.alreadyCommittedCaseIds).toEqual(interrupted.admitted.map(row => row.cassetteId))
    expect(retired.remainingCaseIds).toEqual([])
    expect(tree(f.committedRoot)).toEqual(corpus)
  })

  it('keeps real probe reservations and completions spent without reauthoring after retirement', async () => {
    const f = fixture(1)
    const author = vi.fn(async () => ({ text: 'Continue to the reviewed control', usage: { promptTokens: 101, completionTokens: 11 } }))
    const options = { ...f, product: 'default', mutators: ['confusable'] as const,
      probeAuthor: { author }, authoringModel: { id: 'fixture-retirement-author', family: 'fixture-family' } }
    const staged = await stageAdversarialProposal(options)
    expect(staged.spend.modelCalls).toBe(2)
    const probes = tree(join(f.agentQaRoot, 'eval/adversarial-probes'))
    expect(Object.keys(probes).filter(path => path.endsWith('.reservation.json'))).toHaveLength(2)
    expect(Object.keys(probes).filter(path => path.endsWith('.completion.json'))).toHaveLength(2)
    const settled = tree(join(f.agentQaRoot, 'eval/adversarial-state'))
    retireStagedAdversarialBatch({ ...f, product: 'default', batchDigest: staged.batchDigest! })
    const retry = await stageAdversarialProposal(options)
    expect(retry.staged).toEqual([])
    expect(retry.spend.modelCalls).toBe(0)
    expect(author).toHaveBeenCalledTimes(2)
    expect(tree(join(f.agentQaRoot, 'eval/adversarial-probes'))).toEqual(probes)
    expect(tree(join(f.agentQaRoot, 'eval/adversarial-state'))).toEqual(settled)
  })

  it('never removes a different owner token on release after durable marker publication', async () => {
    const f = await stagedFixture(1)
    const link = fs.linkSync
    let replacement = ''
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      link(from, to)
      if (String(to).endsWith('/retirement.json')) {
        const path = join(f.lock, 'owner.json')
        const owner = JSON.parse(readFileSync(path, 'utf8'))
        replacement = committedFileText({ ...owner, token: '22222222-2222-4222-8222-222222222222' })
        writeFileSync(path, replacement)
      }
    })
    syncBuiltinESMExports()
    expect(() => retireStagedAdversarialBatch(f)).toThrow(/busy/)
    expect(readFileSync(join(f.lock, 'owner.json'), 'utf8')).toBe(replacement)
    expect(existsSync(join(f.dir, 'retirement.json'))).toBe(true)
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', writesStarted: false })
  })

  it.each(['../default', '', 'default/other', 'default..other'])('rejects unsafe product %j', async product => {
    const f = await stagedFixture(1)
    const before = tree(f.root)
    expect(() => retireStagedAdversarialBatch({ ...f, product })).toThrow(TypeError)
    expect(tree(f.root)).toEqual(before)
  })
  it.each(['../batch', '', 'A'.repeat(64), '0'.repeat(63)])('rejects unsafe digest %j', async batchDigest => {
    const f = await stagedFixture(1)
    const before = tree(f.root)
    expect(() => retireStagedAdversarialBatch({ ...f, batchDigest })).toThrow(TypeError)
    expect(tree(f.root)).toEqual(before)
  })

  it.each(['batch', 'ancestor', 'case', 'document', 'marker', 'root'])('rejects a symlinked %s without following it', async target => {
    const f = await stagedFixture(1)
    const original = target === 'batch' ? f.dir : target === 'ancestor' ? join(f.dir, '..')
      : target === 'case' ? join(f.dir, 'case-0000') : target === 'root' ? f.agentQaRoot
      : join(f.dir, target === 'marker' ? 'retirement.json' : 'case-0000/cassette.json')
    const saved = join(f.root, 'saved')
    if (target === 'marker') writeFileSync(saved, '{}')
    else renameSync(original, saved)
    symlinkSync(saved, original)
    const before = tree(saved)
    expect(() => retireStagedAdversarialBatch(f)).toThrow()
    expect(tree(saved)).toEqual(before)
  })

  it.each(['manifest', 'cassette', 'label', 'entry'])('refuses altered reviewed %s bytes', async part => {
    const f = await stagedFixture(1)
    const file = part === 'manifest' ? join(f.dir, 'manifest.json') : join(f.dir, 'case-0000', part + '.json')
    writeFileSync(file, readFileSync(file, 'utf8') + ' ')
    // The manifest hash binds retirement only once a record exists; before that its semantic
    // digest still pins all reviewed case bytes. Change its identity rather than whitespace.
    if (part === 'manifest') {
      const doc = JSON.parse(readFileSync(file, 'utf8')); doc.product = 'foreign'; writeFileSync(file, JSON.stringify(doc))
    }
    const corpus = tree(f.committedRoot)
    expect(() => retireStagedAdversarialBatch(f)).toThrow()
    expect(existsSync(join(f.dir, 'retirement.json'))).toBe(false)
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', writesStarted: false })
    expect(tree(f.committedRoot)).toEqual(corpus)
  })

  it.each(['product', 'digest', 'manifest-hash', 'order', 'duplicate', 'foreign-committed', 'extra', 'syntax'])('fails closed on a conflicting %s retirement record', async change => {
    const f = await stagedFixture()
    const result = retireStagedAdversarialBatch(f)
    const record = JSON.parse(readFileSync(result.retirementRecordPath, 'utf8'))
    if (change === 'product') record.product = 'foreign'
    if (change === 'digest') record.batchDigest = 'f'.repeat(64)
    if (change === 'manifest-hash') record.manifestSha256 = 'f'.repeat(64)
    if (change === 'order') record.reviewedCaseIds.reverse()
    if (change === 'duplicate') record.reviewedCaseIds.push(record.reviewedCaseIds[0])
    if (change === 'foreign-committed') record.alreadyCommittedCaseIds.push('foreign')
    if (change === 'extra') record.extra = true
    writeFileSync(result.retirementRecordPath, change === 'syntax' ? '{' : committedFileText(record))
    const before = tree(f.root)
    expect(() => listStagedAdversarial(f)).toThrow()
    expect(() => retireStagedAdversarialBatch(f)).toThrow()
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', reason: 'staging-integrity', writesStarted: false })
    expect(tree(f.root)).toEqual(before)
  })

  it('binds the original manifest bytes even when only its whitespace changes after retirement', async () => {
    const f = await stagedFixture(1)
    retireStagedAdversarialBatch(f)
    const path = join(f.dir, 'manifest.json')
    writeFileSync(path, readFileSync(path, 'utf8') + '\n')
    expect(() => retireStagedAdversarialBatch(f)).toThrow(/conflict/)
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', writesStarted: false })
  })

  it.each(['before-link', 'after-link'])('recovers a publication exception %s without deleting a published decision', async timing => {
    const f = await stagedFixture(1)
    const original = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/retirement.json')) {
        if (timing === 'after-link') { original(from, to); const fd = fs.openSync(f.dir, 'r'); fs.fsyncSync(fd); fs.closeSync(fd) }
        throw new Error('injected publication interruption')
      }
      original(from, to)
    })
    syncBuiltinESMExports()
    expect(() => retireStagedAdversarialBatch(f)).toThrow('injected publication interruption')
    expect(existsSync(join(f.dir, 'retirement.json'))).toBe(timing === 'after-link')
    expect(existsSync(f.lock)).toBe(false)
    expect(readdirSync(f.dir).some(name => name.startsWith('.pending-'))).toBe(false)
    const marker = timing === 'after-link' ? readFileSync(join(f.dir, 'retirement.json'), 'utf8') : undefined
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    const retried = retireStagedAdversarialBatch(f)
    expect(retried.alreadyRetired).toBe(timing === 'after-link')
    if (marker !== undefined) expect(readFileSync(retried.retirementRecordPath, 'utf8')).toBe(marker)
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', writesStarted: false })
  })

  it.each(['empty', 'malformed', 'foreign', 'live', 'symlink', 'partial', 'extra-file'])('leaves %s lifecycle ownership busy and intact', async mode => {
    const f = await stagedFixture(1)
    const owner = { schemaVersion: 2, product: 'default', batchDigest: f.batchDigest, pid: process.pid,
      token: '11111111-1111-4111-8111-111111111111' }
    mkdirSync(f.lock)
    if (mode === 'symlink') {
      const target = join(f.root, 'owner'); writeFileSync(target, committedFileText(owner)); symlinkSync(target, join(f.lock, 'owner.json'))
    } else if (mode !== 'empty') writeFileSync(join(f.lock, 'owner.json'), mode === 'partial' ? '{'
      : mode === 'malformed' ? '{}' : committedFileText({ ...owner, product: mode === 'foreign' ? 'foreign' : 'default' }))
    if (mode === 'extra-file') writeFileSync(join(f.lock, 'extra'), 'uncertain')
    const before = tree(f.root)
    expect(() => retireStagedAdversarialBatch(f)).toThrow(/busy/)
    expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', reason: 'admission-refused', writesStarted: false })
    expect(admit(f, f.batchDigest, { dryRun: true })).toMatchObject({ kind: 'refused', writesStarted: false })
    expect(tree(f.root)).toEqual(before)
  })

  it.each(['EPERM', 'UNKNOWN'])('does not reap an owner whose liveness check returns %s', async code => {
    const f = await stagedFixture(1)
    mkdirSync(f.lock)
    writeFileSync(join(f.lock, 'owner.json'), committedFileText({ schemaVersion: 2, product: f.product,
      batchDigest: f.batchDigest, pid: process.pid, token: '11111111-1111-4111-8111-111111111111' }))
    const before = tree(f.root)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('uncertain'), { code }) })
    expect(() => retireStagedAdversarialBatch(f)).toThrow(/busy/)
    expect(tree(f.root)).toEqual(before)
  })
})

const childProgram = String.raw`
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const input = JSON.parse(process.argv[1])
const signal = (path, value) => { fs.writeFileSync(path + '.pending', JSON.stringify(value)); fs.renameSync(path + '.pending', path) }
const wait = path => { const end = Date.now() + 10000; while (!fs.existsSync(path)) { if (Date.now() > end) throw new Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } }
if (input.pauseRead) {
  const read = fs.readFileSync
  let paused = false
  fs.readFileSync = function(path, ...args) {
    const bytes = read.call(this, path, ...args)
    if (!paused && String(path) === input.lock + '/owner.json') {
      paused = true; signal(input.entered, JSON.parse(String(bytes))); wait(input.release)
    }
    return bytes
  }
}
if (input.holdPublication) {
  const link = fs.linkSync
  fs.linkSync = function(from, to) {
    if (String(to).endsWith('/retirement.json')) { signal(input.entered, {}); wait(input.release) }
    return link(from, to)
  }
}
syncBuiltinESMExports()
const local = await import(input.module)
if (input.hold) {
  signal(input.ready, {})
  const end = Date.now() + 30000
  while (!fs.existsSync(input.go)) { if (Date.now() > end) throw new Error('go timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
}
try {
  let paused = false
  const result = input.mode === 'retire' ? local.retireStagedAdversarialBatch(input)
    : local.refreshAdversarialSplit({ ...input, mask: text => text,
      afterCaseCommitted: input.entered ? id => {
        if (!paused) { paused = true; signal(input.entered, { id, owner: JSON.parse(fs.readFileSync(input.lock + '/owner.json', 'utf8')) }); wait(input.release); if (input.stopAfterHold) throw new Error('stop') }
      } : undefined })
  process.stdout.write(JSON.stringify({ result }))
} catch (error) { process.stdout.write(JSON.stringify({ error: error.message, name: error.name })); process.exitCode = 2 }
`

function launch(f: Awaited<ReturnType<typeof stagedFixture>>, name: string, extra: Record<string, unknown>) {
  const entered = join(f.root, `${name}.entered`)
  const release = join(f.root, `${name}.release`)
  // With `hold: true` the child imports the module, writes `ready`, and waits for `go`.
  const ready = join(f.root, `${name}.ready`)
  const go = join(f.root, `${name}.go`)
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram, JSON.stringify({ ...f,
    entered, release, ready, go, module: new URL('../../dist/index.js', import.meta.url).href, ...extra })], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', bytes => { output += String(bytes) })
  child.stderr.on('data', bytes => { errors += String(bytes) })
  const closed = new Promise<{ exit: number | null; signal: string | null; output: string; errors: string }>(resolve => {
    child.on('close', (exit, signal) => resolve({ exit, signal, output, errors }))
  })
  return { child, entered, release, ready, go, closed }
}

async function until(path: string) {
  const end = Date.now() + 10_000
  while (!existsSync(path) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
  expect(existsSync(path), `child barrier ${path}`).toBe(true)
}

async function stop(children: ReturnType<typeof launch>[]) {
  for (const row of children) if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGKILL')
  await Promise.all(children.map(row => row.closed))
}

describe('422 separate-process batch lifecycle ownership', () => {
  it('an active admission excludes retirement until its committed survivors can be observed', async () => {
    const f = await stagedFixture()
    const child = launch(f, 'admit', { mode: 'admit', stopAfterHold: true })
    try {
      await until(child.entered)
      expect(committedIds(f.committedRoot)).toHaveLength(1)
      expect(() => retireStagedAdversarialBatch(f)).toThrow(/busy/)
      expect(existsSync(join(f.dir, 'retirement.json'))).toBe(false)
      writeFileSync(child.release, '')
      const finished = await child.closed
      expect(finished.exit, finished.errors).toBe(0)
      expect(JSON.parse(finished.output).result.kind).toBe('partial')
      const retired = retireStagedAdversarialBatch(f)
      expect(retired.alreadyCommittedCaseIds).toHaveLength(1)
      expect(retired.remainingCaseIds).toHaveLength(2)
    } finally { await stop([child]) }
  }, 20_000)

  it('retirement publication excludes admission and two callers retain one identical decision', async () => {
    const f = await stagedFixture()
    const corpus = tree(f.committedRoot)
    const first = launch(f, 'retire-first', { mode: 'retire', holdPublication: true, hold: true })
    const contender = launch(f, 'retire-second', { mode: 'retire', hold: true })
    const admission = launch(f, 'admit-contender', { mode: 'admit', entered: undefined, hold: true })
    const later = launch(f, 'admit-later', { mode: 'admit', entered: undefined, hold: true })
    const children = [first, contender, admission, later]
    try {
      await Promise.all(children.map(row => until(row.ready)))
      writeFileSync(first.go, '')
      await until(first.entered)
      writeFileSync(contender.go, '')
      const second = await contender.closed
      expect(second.exit).toBe(2)
      expect(JSON.parse(second.output).error).toContain('busy')
      writeFileSync(admission.go, '')
      expect(JSON.parse((await admission.closed).output).result).toMatchObject({ kind: 'refused', writesStarted: false, admitted: [] })
      writeFileSync(first.release, '')
      const published = await first.closed
      expect(published.exit, published.errors).toBe(0)
      const decision = readFileSync(join(f.dir, 'retirement.json'), 'utf8')
      expect(retireStagedAdversarialBatch(f).alreadyRetired).toBe(true)
      writeFileSync(later.go, '')
      expect(JSON.parse((await later.closed).output).result).toMatchObject({ kind: 'refused', reason: 'admission-refused', retirement: { retired: true }, writesStarted: false })
      expect(readFileSync(join(f.dir, 'retirement.json'), 'utf8')).toBe(decision)
      expect(tree(f.committedRoot)).toEqual(corpus)
    } finally { await stop(children) }
  }, 20_000)

  it('recovers a positively dead admission owner and preserves its already committed case', async () => {
    const f = await stagedFixture()
    const child = launch(f, 'killed-admit', { mode: 'admit' })
    try {
      await until(child.entered)
      const owner = JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8'))
      child.child.kill('SIGKILL'); await child.closed
      const corpus = tree(f.committedRoot)
      const retired = retireStagedAdversarialBatch(f)
      expect(retired.alreadyCommittedCaseIds).toHaveLength(1)
      expect(retired.remainingCaseIds).toHaveLength(2)
      expect(tree(f.committedRoot)).toEqual(corpus)
      expect(existsSync(f.lock)).toBe(false)
      expect(JSON.parse(readFileSync(`${f.lock}.dead-${owner.token}/owner.json`, 'utf8'))).toEqual(owner)
      expect(admit(f, f.batchDigest)).toMatchObject({ kind: 'refused', writesStarted: false })
    } finally { await stop([child]) }
  }, 20_000)

  it('fences a delayed dead-G reclaimer from removing newer live H', async () => {
    const f = await stagedFixture(4)
    const dead = launch(f, 'dead', { mode: 'admit' })
    const children = [dead]
    try {
      await until(dead.entered)
      dead.child.kill('SIGKILL'); await dead.closed
      const a = launch(f, 'reclaimer-a', { mode: 'retire', pauseRead: true }); children.push(a)
      await until(a.entered)
      const b = launch(f, 'reclaimer-b', { mode: 'admit', stopAfterHold: true }); children.push(b)
      await until(b.entered)
      const ownerH = readFileSync(join(f.lock, 'owner.json'), 'utf8')
      writeFileSync(a.release, '')
      const failed = await a.closed
      expect(failed.exit, failed.errors).toBe(2)
      expect(JSON.parse(failed.output).error).toContain('busy')
      expect(readFileSync(join(f.lock, 'owner.json'), 'utf8')).toBe(ownerH)
      writeFileSync(b.release, '')
      expect((await b.closed).exit).toBe(0)
      expect(retireStagedAdversarialBatch(f).alreadyCommittedCaseIds).toHaveLength(2)
    } finally { await stop(children) }
  }, 30_000)
})
