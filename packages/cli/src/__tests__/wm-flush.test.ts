// The run-end flush masks every value with the declared mask, disposes the store, never throws.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { flushWorkingMemory } from '../wm-flush.js'

const TMP_DIR = join(tmpdir(), 'agent-qa-wm-flush-test-' + process.pid)

interface Entry { key: string; value: string; kind: string; provenance: string }

function fakeStore(entries: Entry[]) {
  let disposed = false
  return {
    entries: () => entries,
    dispose: () => { disposed = true },
    get disposed() { return disposed },
  }
}

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true })
})
afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('flushWorkingMemory — happy path', () => {
  it('writes a JSON artifact with masked values + kind/provenance, then disposes the store', async () => {
    const store = fakeStore([
      { key: 'otp', value: '4821', kind: 'extracted-value', provenance: 'observation' },
      { key: 'file', value: 'report.pdf', kind: 'filename', provenance: 'observation' },
    ])
    const result = await flushWorkingMemory(store, { artifactsDir: TMP_DIR, mask: (v: string) => `MASKED(${v})` })

    const written = JSON.parse(await readFile(result.path, 'utf8')) as { entries: Entry[] }
    expect(written.entries).toHaveLength(2)
    const otp = written.entries.find((e) => e.key === 'otp')
    expect(otp?.value).toBe('MASKED(4821)') // masked, never verbatim
    expect(otp?.kind).toBe('extracted-value')
    expect(otp?.provenance).toBe('observation')
    expect(store.disposed).toBe(true)
    expect(result.entriesWritten).toBe(2)
  })
})

describe('working-memory flush masking', () => {
  it('the working-memory flush masks a declared value and keeps the rest', async () => {
    const redactor = new SecretRedactor(SecretStore.fromEnvContent('PW_441=Hunter-42-zz'))
    const store = fakeStore([
      { key: 'password', value: 'Hunter-42-zz', kind: 'extracted-value', provenance: 'observation' },
      { key: 'card', value: '4242 4242 4242 4242', kind: 'extracted-value', provenance: 'observation' },
    ])
    const result = await flushWorkingMemory(store, {
      artifactsDir: TMP_DIR,
      mask: (v: string) => redactor.redactString(v),
    })

    const raw = await readFile(result.path, 'utf8')
    const written = JSON.parse(raw) as { entries: Entry[] }
    expect(written.entries.find((e) => e.key === 'password')?.value).toBe('[secret:PW_441]')
    expect(written.entries.find((e) => e.key === 'card')?.value).toBe('4242 4242 4242 4242')
    expect(raw).not.toContain('Hunter-42-zz')
    expect('blocked' in result).toBe(false)
  })
})

describe('flushWorkingMemory — never throws', () => {
  it('resolves best-effort with the artifact when the mask throws, writing no raw value', async () => {
    const store = fakeStore([{ key: 'otp', value: '4821', kind: 'extracted-value', provenance: 'toolResult' }])
    const result = await flushWorkingMemory(store, {
      artifactsDir: TMP_DIR,
      mask: () => { throw new Error('mask failed') },
    })

    expect(result.entriesWritten).toBe(1)
    const written = JSON.parse(await readFile(result.path, 'utf8')) as { entries: Entry[] }
    expect(written.entries[0]?.value).toBe('[mask-error]')
    expect(store.disposed).toBe(true)
  })
})
