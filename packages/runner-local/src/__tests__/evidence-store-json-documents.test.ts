import { createHash } from 'node:crypto'
import { fsyncSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { EvidenceDocument, StepFinalizedPayload } from '@vostride/agent-qa-schema'
import {
  NetworkEvidenceDocumentSchema,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { createMemberEventSink, createRunEventBus, runMemberTest, SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type { MemberRunConfig, PlatformAdapter } from '@vostride/agent-qa-runner'
import { FsEvidenceArtifactStore } from '../evidence-artifact-store.js'

const io = vi.hoisted(() => ({ beforeWrite: undefined as undefined | ((path: unknown) => void) }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    writeFileSync: vi.fn((...args: Parameters<typeof fs.writeFileSync>) => {
      io.beforeWrite?.(args[0])
      return fs.writeFileSync(...args)
    }),
  }
})

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), '423-json-evidence-'))
  roots.push(root)
  return { root, dir: join(root, 'runs', 'run-423', 'blobs'),
    store: new FsEvidenceArtifactStore({ root, runId: 'run-423' }) }
}
afterEach(() => {
  io.beforeWrite = undefined
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const syntheticSecret = 'synthetic-console-secret-423'
const masked = '[secret]'
const document: Exclude<EvidenceDocument, { kind: 'variables' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [
    { level: 'warn', text: syntheticSecret.replace(syntheticSecret, masked), timestamp: 20 },
    { level: 'error', text: 'second', timestamp: 10 },
  ],
}
const bytes = Buffer.from(JSON.stringify(document))
const sha = createHash('sha256').update(bytes).digest('hex')

test('MASK-BEFORE-HASH: exact masked serialized bytes retain capture order and typed identity', () => {
  const { store } = fixture()
  const ref = store.persistEvidenceDocument(document)
  expect(ref).toEqual({ id: `console-evidence:${sha}`, sha })
  expect(Buffer.from(store.getBlob(ref.sha)!)).toEqual(bytes)
  expect(Buffer.from(store.getBlob(ref.sha)!).toString()).not.toContain(syntheticSecret)
  expect(JSON.parse(Buffer.from(store.getBlob(ref.sha)!).toString()).records.map(
    (record: { timestamp: number }) => record.timestamp,
  )).toEqual([20, 10])
})

test('NETWORK-READBACK: real member terminal refers to one reopened masked SHA blob with retained byte bounds', async () => {
  const { root, store, dir } = fixture()
  const adapter: PlatformAdapter = {
    platform: 'web', setup: async () => {}, cleanup: async () => {},
    observe: async () => { throw new Error('No additional capture expected') },
    execute: async () => { throw new Error('Inline fixture uses appiumScript') },
  }
  const secret = 'synthetic-network-secret-423'
  const body = secret + 'a'.repeat(32768 - secret.length)
  const oversized = '§'.repeat(16385)
  adapter.drainNetworkLogs = () => Array.from({ length: 600 }, (_, index) => ({
    url: `https://example.test/${secret}/${index}`, method: 'POST', status: index === 1 ? 404 : index === 2 ? 0 : 200,
    requestHeaders: { Authorization: 'synthetic-session-token', 'content-type': 'text/plain' },
    responseHeaders: { 'Set-Cookie': 'synthetic-session-cookie', 'content-type': 'text/plain' },
    body: index === 3 ? oversized : body,
    requestBody: index === 3 ? oversized : body, startTime: 1000 - index, endTime: 2000 - index,
  }))
  const bus = createRunEventBus({ runId: 'run-423' })
  let terminal: StepFinalizedPayload | undefined
  let visibleAtTerminal: Uint8Array | undefined
  bus.subscribe(1, event => {
    if (event.type !== 'stepFinalized') return
    terminal = event.payload as StepFinalizedPayload
    const entry = terminal.evidence?.network
    if (entry?.state === 'present') visibleAtTerminal = store.getBlob(entry.ref.sha)
  })
  const unusedModel = {} as MemberRunConfig['plannerModel']
  await runMemberTest({ testId: 'synthetic-network', name: 'Network readback', filePath: 'synthetic.yaml', steps: ['{{appium: mobile: hideKeyboard}}'] }, {
    adapter, planner: { plan: async () => { throw new Error('No provider call expected') } },
    plannerModel: unusedModel, verifierModel: unusedModel, appiumScript: async () => ({ success: true }),
    sink: createMemberEventSink({ bus, mask: text => text.replaceAll(secret, '[secret]').replaceAll('§', '[secret]'), testIndex: 0 }), testIndex: 0,
    abortSignal: new AbortController().signal, evidenceArtifacts: store,
    secretRedactor: new SecretRedactor(new SecretStore({ NET_KEY: secret })),
  })
  expect(terminal?.evidence?.network).toMatchObject({ state: 'present', counts: { total: 600, failed: 1, errored: 1 } })
  const entry = terminal!.evidence!.network
  if (entry.state !== 'present') throw new Error('Expected persisted network entry')
  const reopened = new FsEvidenceArtifactStore({ root, runId: 'run-423' })
  const stored = Buffer.from(reopened.getBlob(entry.ref.sha)!)
  // Native byte equality avoids expanding a 39-MB typed array into millions of matcher keys.
  expect(Buffer.from(visibleAtTerminal!).equals(stored)).toBe(true)
  expect(createHash('sha256').update(stored).digest('hex')).toBe(entry.ref.sha)
  expect(entry.ref.id).toBe(`network-evidence:${entry.ref.sha}`)
  expect(readdirSync(dir)).toEqual([entry.ref.sha])
  const decoded = NetworkEvidenceDocumentSchema.parse(JSON.parse(stored.toString('utf8')))
  expect(stored.toString('utf8')).not.toContain(secret)
  expect(stored.toString('utf8')).toContain('synthetic-session-token')
  expect(decoded.records.map(record => record.startTime)).toEqual(Array.from({ length: 600 }, (_, index) => 1000 - index))
  expect(decoded.records[3]).not.toHaveProperty('body')
  expect(decoded.records[3]).not.toHaveProperty('requestBody')
  for (const [index, record] of decoded.records.entries()) {
    if (index === 3) continue
    expect(record.requestBody).toBe(record.body)
    expect(Buffer.byteLength(record.body!)).toBe(32768 - secret.length + '[secret:NET_KEY]'.length)
  }
})

test('DEDUP: identical complete bytes do not rewrite an existing blob', () => {
  const { store, dir } = fixture()
  const first = store.persistEvidenceDocument(document)
  vi.mocked(writeFileSync).mockClear()
  expect(store.persistEvidenceDocument(document)).toEqual(first)
  expect(writeFileSync).not.toHaveBeenCalled()
  expect(readdirSync(dir)).toEqual([sha])
})

test('CONCURRENT-BLOB: another store sees no partial target during publication', async () => {
  const { store, root, dir } = fixture()
  const other = new FsEvidenceArtifactStore({ root, runId: 'run-423' })
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  let visibleDuringWrite: Uint8Array | undefined
  io.beforeWrite = path => {
    io.beforeWrite = undefined
    if (typeof path === 'number') fs.writeSync(path, bytes, 0, 12, 0)
    else fs.writeFileSync(path as string, bytes.subarray(0, 12))
    visibleDuringWrite = other.getBlob(sha)
    other.persistEvidenceDocument(document)
  }
  store.persistEvidenceDocument(document)
  expect(visibleDuringWrite).toBeUndefined()
  expect(Buffer.from(other.getBlob(sha)!)).toEqual(bytes)
  expect(readdirSync(dir)).toEqual([sha])
})

test('INTERRUPTED-BLOB: partial write failure never publishes a successful ref or target', async () => {
  const { store, dir } = fixture()
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  io.beforeWrite = path => {
    io.beforeWrite = undefined
    if (typeof path === 'number') fs.writeSync(path, bytes, 0, 12, 0)
    else fs.writeFileSync(path as string, bytes.subarray(0, 12))
    throw new Error('synthetic interrupted write')
  }
  expect(() => store.persistEvidenceDocument(document)).toThrow('synthetic interrupted write')
  expect(store.hasBlob(sha)).toBe(false)
  expect(store.getBlob(sha)).toBeUndefined()
  expect(readdirSync(dir)).toEqual([])
  expect(store.persistEvidenceDocument(document).sha).toBe(sha)
})

test('JSON-KINDS: schema-owned prefixes and validation reject unsupported documents before writing', () => {
  const { store, dir } = fixture()
  for (const [value, prefix] of [
    [{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [] }, 'network-evidence:'],
    [{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y', records: [] }, 'a11y-evidence:'],
    [{ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: masked }, 'aria-state:'],
  ] as const) {
    const ref = store.persistEvidenceDocument(value as Exclude<EvidenceDocument, { kind: 'variables' }>)
    expect(ref.id).toBe(`${prefix}${ref.sha}`)
    expect(createHash('sha256').update(store.getBlob(ref.sha)!).digest('hex')).toBe(ref.sha)
  }
  const before = readdirSync(dir)
  for (const invalid of [
    { ...document, schemaVersion: 3 }, { ...document, extra: true },
    { ...document, records: [{ level: 'warn', text: masked }] },
    { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: {} },
  ]) {
    expect(() => store.persistEvidenceDocument(invalid as typeof document)).toThrow()
  }
  expect(readdirSync(dir)).toEqual(before)
})

test.each([1, 2, 5])('INTERRUPTED-BLOB: sync failure at stage %s never returns a successful reference', stage => {
  const { store, dir } = fixture()
  const original = vi.mocked(fsyncSync).getMockImplementation()!
  let calls = 0
  vi.mocked(fsyncSync).mockImplementation(fd => {
    if (++calls === stage) throw new Error('synthetic sync failure')
    original(fd)
  })
  try {
    expect(() => store.persistEvidenceDocument(document)).toThrow('synthetic sync failure')
    const persisted = store.getBlob(sha)
    if (stage === 1) expect(persisted).toBeUndefined()
    else expect(Buffer.from(persisted!)).toEqual(bytes)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  } finally {
    vi.mocked(fsyncSync).mockImplementation(original)
  }
  expect(store.persistEvidenceDocument(document).sha).toBe(sha)
})

test('DURABLE-PARENTS: a returned reference synchronizes the complete newly-created run family', () => {
  const { root } = fixture()
  const store = new FsEvidenceArtifactStore({ root: join(root, 'new-root'), runId: 'run-423' })
  store.persistEvidenceDocument(document)
  // File, blobs directory, run directory, runs directory, root, and root parent.
  expect(fsyncSync).toHaveBeenCalledTimes(6)
})

const directoryRefusals = ['EINVAL', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'] as const
test.each(directoryRefusals)('DIR-FSYNC-TOLERATED: directory fsync refusal %s after the synced file still returns the reference', code => {
  const { store, dir } = fixture()
  const original = vi.mocked(fsyncSync).getMockImplementation()!
  let calls = 0
  vi.mocked(fsyncSync).mockImplementation(fd => {
    if (++calls === 2) throw Object.assign(new Error('synthetic refusal'), { code })
    original(fd)
  })
  try {
    expect(store.persistEvidenceDocument(document)).toEqual({ id: `console-evidence:${sha}`, sha })
    expect(calls).toBeGreaterThan(2)
    expect(Buffer.from(store.getBlob(sha)!)).toEqual(bytes)
    expect(readdirSync(dir)).toEqual([sha])
  } finally {
    vi.mocked(fsyncSync).mockImplementation(original)
  }
})

test('DIR-FSYNC-TOLERATED: an EINVAL refusal on the file fsync itself still throws and publishes nothing', () => {
  const { store, dir } = fixture()
  const original = vi.mocked(fsyncSync).getMockImplementation()!
  let calls = 0
  vi.mocked(fsyncSync).mockImplementation(fd => {
    if (++calls === 1) throw Object.assign(new Error('synthetic refusal'), { code: 'EINVAL' })
    original(fd)
  })
  try {
    expect(() => store.persistEvidenceDocument(document)).toThrow('synthetic refusal')
    expect(store.hasBlob(sha)).toBe(false)
    expect(store.getBlob(sha)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  } finally {
    vi.mocked(fsyncSync).mockImplementation(original)
  }
})
