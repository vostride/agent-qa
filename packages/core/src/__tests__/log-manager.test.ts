import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LogManager, MemberLogScopeUnavailableError } from '../logging/log-manager.js'
import type { MemberLogScope } from '../logging/log-manager.js'
import type { LogStorage, LogEntry } from '../logging/types.js'
import { formatLogEntry } from '../logging/cli-formatter.js'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'

describe('LogManager', () => {
  let stderrSpy: any
  let stdoutSpy: any

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it('buffers entries and flush() clears buffer', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('info', 'agent', 'test message')
    expect(lm.getBuffer()).toHaveLength(1)
    lm.flush()
    expect(lm.getBuffer()).toHaveLength(0)
  })

  it('creates entries with correct structure', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('info', 'cache', 'cache hit', { operation: 'get', hit: true })
    const buffer = lm.getBuffer()
    expect(buffer).toHaveLength(1)
    const entry = buffer[0]
    expect(entry.id).toBeDefined()
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/) // UUID format
    expect(entry.runId).toBe('run-1')
    expect(entry.level).toBe('info')
    expect(entry.source).toBe('cache')
    expect(entry.message).toBe('cache hit')
    expect(entry.data).toEqual({ operation: 'get', hit: true })
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 8601
    expect(entry.stepId).toBeNull()
  })

  it('setCurrentStep() scopes entries to stepId', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('info', 'agent', 'before step')
    lm.setCurrentStep('step-42')
    lm.log('info', 'agent', 'during step')
    lm.clearCurrentStep()
    lm.log('info', 'agent', 'after step')
    const buffer = lm.getBuffer()
    expect(buffer[0].stepId).toBeNull()
    expect(buffer[1].stepId).toBe('step-42')
    expect(buffer[2].stepId).toBeNull()
  })

  it('display filtering: debug entries hidden when displayLevel=warn', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'warn' })
    lm.log('debug', 'agent', 'should not display')
    lm.log('info', 'agent', 'should not display either')
    lm.log('warn', 'agent', 'should display')
    lm.log('error', 'agent', 'should also display')
    // debug and info should NOT write to stderr, warn and error should
    const calls = stderrSpy.mock.calls
    const output = calls.map((c: unknown[]) => String(c[0])).join('')
    expect(output).not.toContain('should not display')
    expect(output).toContain('should display')
    expect(output).toContain('should also display')
  })

  it('all levels shown when displayLevel=debug', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'debug' })
    lm.log('debug', 'agent', 'debug msg')
    lm.log('info', 'agent', 'info msg')
    lm.log('warn', 'agent', 'warn msg')
    lm.log('error', 'agent', 'error msg')
    const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(output).toContain('debug msg')
    expect(output).toContain('info msg')
    expect(output).toContain('warn msg')
    expect(output).toContain('error msg')
  })

  it('prints a displayed entry carrying a workflow command inside its own stop-commands pair on stdout under GitHub Actions', () => {
    const lm = new LogManager({
      runId: 'run-1',
      displayLevel: 'info',
      env: { GITHUB_ACTIONS: 'true' },
    })
    lm.log('info', 'agent', '::set-output name=x::y')
    expect(stderrSpy).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const block = String(stdoutSpy.mock.calls[0][0])
    expect(block).toMatch(/^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u)
    expect(block).toContain('::set-output name=x::y')
  })

  it('prints a displayed entry to stderr exactly as formatted off GitHub Actions', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'info' })
    lm.log('info', 'agent', '::set-output name=x::y')
    const [entry] = lm.getBuffer()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(formatLogEntry(entry) + '\n')
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('silent displayLevel shows nothing', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('error', 'agent', 'critical error')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('createScopedLogger(cache) produces entries with source=cache', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    const cacheLog = lm.createScopedLogger('cache')
    cacheLog.info('hit', { operation: 'get' })
    cacheLog.debug('lookup', { stepHash: 'abc' })
    cacheLog.warn('expiring')
    cacheLog.error('corrupt')
    const buffer = lm.getBuffer()
    expect(buffer).toHaveLength(4)
    expect(buffer.every(e => e.source === 'cache')).toBe(true)
    expect(buffer[0].level).toBe('info')
    expect(buffer[1].level).toBe('debug')
    expect(buffer[2].level).toBe('warn')
    expect(buffer[3].level).toBe('error')
  })

  it('flush() calls storage.insertLogs when storage provided', () => {
    const mockStorage: LogStorage = {
      insertLogs: vi.fn(),
      getLogs: vi.fn().mockReturnValue([]),
    }
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent', storage: mockStorage })
    lm.log('info', 'agent', 'test')
    lm.log('warn', 'cache', 'warning')
    lm.flush()
    expect(mockStorage.insertLogs).toHaveBeenCalledTimes(1)
    const insertedEntries = (mockStorage.insertLogs as ReturnType<typeof vi.fn>).mock.calls[0][0] as LogEntry[]
    expect(insertedEntries).toHaveLength(2)
    expect(insertedEntries[0].message).toBe('test')
    expect(insertedEntries[1].message).toBe('warning')
  })

  it('flush() handles no storage gracefully (no-op)', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('info', 'agent', 'test')
    expect(() => lm.flush()).not.toThrow()
    expect(lm.getBuffer()).toHaveLength(0)
  })

  it('flush() drops buffered storage entries when no runId is available', () => {
    const mockStorage: LogStorage = {
      insertLogs: vi.fn(),
      getLogs: vi.fn().mockReturnValue([]),
    }
    const lm = new LogManager({ displayLevel: 'silent', storage: mockStorage })
    lm.log('info', 'agent', 'test')
    expect(() => lm.flush()).not.toThrow()
    expect(mockStorage.insertLogs).not.toHaveBeenCalled()
    expect(lm.getBuffer()).toHaveLength(0)
  })

  it('flush() succeeds after setRunId() provides a real ID', () => {
    const mockStorage: LogStorage = {
      insertLogs: vi.fn(),
      getLogs: vi.fn().mockReturnValue([]),
    }
    const lm = new LogManager({ displayLevel: 'silent', storage: mockStorage })
    lm.log('info', 'agent', 'before id')
    lm.setRunId('real-run-id')
    lm.log('info', 'agent', 'after id')
    expect(() => lm.flush()).not.toThrow()
    const inserted = (mockStorage.insertLogs as ReturnType<typeof vi.fn>).mock.calls[0][0] as LogEntry[]
    expect(inserted).toHaveLength(2)
    expect(inserted[0].runId).toBe('real-run-id')
    expect(inserted[1].runId).toBe('real-run-id')
  })

  it('NDJSON emission when ndjson=true', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent', ndjson: true })
    lm.log('info', 'planner', 'plan generated', { model: 'gpt-4' })
    expect(stdoutSpy).toHaveBeenCalled()
    const written = String(stdoutSpy.mock.calls[0][0])
    expect(written).toMatch(/^AGENT_QA_EVENT:/)
    const json = JSON.parse(written.replace('AGENT_QA_EVENT:', '').trim())
    expect(json.type).toBe('log')
    expect(json.source).toBe('planner')
    expect(json.message).toBe('plan generated')
    expect(json.data.model).toBe('gpt-4')
  })

  it('NDJSON line carries no # under GitHub Actions and parses back to the same entry', () => {
    const lm = new LogManager({
      runId: 'run-1',
      displayLevel: 'silent',
      ndjson: true,
      env: { GITHUB_ACTIONS: 'true' },
    })
    lm.log('warn', 'agent', '##[error]x', { note: '#1' })
    const [entry] = lm.getBuffer()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const written = String(stdoutSpy.mock.calls[0][0])
    expect(written.startsWith('AGENT_QA_EVENT:')).toBe(true)
    expect(written).not.toContain('#')
    expect(JSON.parse(written.slice('AGENT_QA_EVENT:'.length))).toEqual({ type: 'log', ...entry })
  })

  it('NDJSON line is the plain serialized entry off GitHub Actions', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent', ndjson: true })
    lm.log('warn', 'agent', '##[error]x', { note: '#1' })
    const [entry] = lm.getBuffer()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledWith(
      `AGENT_QA_EVENT:${JSON.stringify({ type: 'log', ...entry })}\n`,
    )
  })

  it('data defaults to empty object when not provided', () => {
    const lm = new LogManager({ runId: 'run-1', displayLevel: 'silent' })
    lm.log('info', 'runner', 'step started')
    expect(lm.getBuffer()[0].data).toEqual({})
  })

  it('redacts known secret values before buffering, display, and ndjson emission', () => {
    const secretStore = new SecretStore({ API_KEY: 'raw-secret-sentinel' })
    const lm = new LogManager({
      runId: 'run-1',
      displayLevel: 'info',
      ndjson: true,
      redactor: new SecretRedactor(secretStore),
    })

    lm.log('info', 'runner', 'using raw-secret-sentinel', { token: 'raw-secret-sentinel' })

    expect(JSON.stringify(lm.getBuffer())).not.toContain('raw-secret-sentinel')
    expect(lm.getBuffer()[0].message).toContain('[secret:API_KEY]')
    expect(lm.getBuffer()[0].data).toEqual({ token: '[secret:API_KEY]' })
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).not.toContain('raw-secret-sentinel')
    expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).not.toContain('raw-secret-sentinel')
  })
})

describe('declared values in log output', () => {
  let stderrSpy: any
  let stdoutSpy: any

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it('log entries mask a declared value and keep everything else', () => {
    const lm = new LogManager({
      runId: 'run-1',
      displayLevel: 'info',
      ndjson: true,
      redactor: new SecretRedactor(new SecretStore({ SHORT: 'q^7' })),
    })
    const storageState = JSON.stringify({
      cookies: [{ name: 'sid', value: 'auth-cookie-value' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'auth-local-value' }] }],
    })

    lm.log('info', 'runner', `pw=q^7 ${storageState}`, {
      pw: 'q^7',
      cookie: 'c1',
      token: 't1',
      use: { authState: 'demo-acc' },
      storageStatePath: '/tmp/auth/storage-state.json',
    })

    const [entry] = lm.getBuffer()
    expect(entry.message).toBe(`pw=[secret:SHORT] ${storageState}`)
    expect(entry.data).toEqual({
      pw: '[secret:SHORT]',
      cookie: 'c1',
      token: 't1',
      use: { authState: 'demo-acc' },
      storageStatePath: '/tmp/auth/storage-state.json',
    })
    const emitted = [...stderrSpy.mock.calls, ...stdoutSpy.mock.calls]
      .map((c: unknown[]) => String(c[0]))
      .join('')
    expect(emitted).not.toContain('q^7')
    expect(emitted).toContain('auth-cookie-value')
  })
})

// ONE LOG MANAGER, N CONCURRENT MEMBERS (WINDOWS #233).
//
// 402-02 made the DIRECT run path poolable and 402-03 made `workers > 1` reachable from config, so
// `commands/run.ts` now calls `logger.setRunId(memberRunId)` from several members interleaved on
// ONE `LogManager` — the instance is built once at run.ts:3656, outside the per-member closure.
// Two distinct corruptions follow from a single mutable `runId` field, and they are pinned
// separately because they fail for different reasons and a fix for one does not imply the other:
//
//   FORWARD  — after member B stamps, member A's SUBSEQUENT lines carry B's run id.
//   BACKWARD — `setRunId` restamps every buffered entry, so B's stamp REWRITES lines A already
//              wrote and had correctly attributed.
//
// The interleaving below is not a stress test and has no timing assertion: it is the exact
// deterministic order the pool produces (each member mints its id inside its own closure), replayed
// synchronously so the cells are reproducible.
describe('LogManager — concurrent members share one instance', () => {
  let stderrSpy: any

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  const runIdsOf = (lm: LogManager, message: string): string[] =>
    lm.getBuffer().filter((e) => e.message === message).map((e) => e.runId)

  it('keeps each member scope on its OWN run id after a sibling stamps (forward)', async () => {
    const lm = new LogManager({ displayLevel: 'silent', memberScope: new AsyncLocalStorage<MemberLogScope>() })

    // Member A opens its scope and stamps; member B opens its scope and stamps; THEN A logs again.
    // A's later line belongs to A. With one shared mutable field it carries B's id.
    await lm.runInMemberScope(async () => {
      lm.setRunId('run-A')
      lm.log('info', 'agent', 'A-before-sibling')
      await lm.runInMemberScope(async () => {
        lm.setRunId('run-B')
        lm.log('info', 'agent', 'B-line')
      })
      lm.log('info', 'agent', 'A-after-sibling')
    })

    expect(runIdsOf(lm, 'A-before-sibling')).toEqual(['run-A'])
    expect(runIdsOf(lm, 'B-line')).toEqual(['run-B'])
    expect(runIdsOf(lm, 'A-after-sibling')).toEqual(['run-A'])
  })

  it('never restamps a line another member already attributed (backward)', async () => {
    const lm = new LogManager({ displayLevel: 'silent', memberScope: new AsyncLocalStorage<MemberLogScope>() })

    await lm.runInMemberScope(async () => {
      lm.setRunId('run-A')
      lm.log('info', 'agent', 'A-line')
    })
    await lm.runInMemberScope(async () => {
      lm.setRunId('run-B')
      lm.log('info', 'agent', 'B-line')
    })

    // A's line was correct when written. B's stamp must not reach back and rewrite it.
    expect(runIdsOf(lm, 'A-line')).toEqual(['run-A'])
    expect(runIdsOf(lm, 'B-line')).toEqual(['run-B'])
  })

  it('still backfills a member\'s OWN lines written before its id was minted', async () => {
    const lm = new LogManager({ displayLevel: 'silent', memberScope: new AsyncLocalStorage<MemberLogScope>() })

    // The startup affordance `setRunId`'s backfill exists for: a member logs while resolving its
    // target, mints its id, and those earlier lines must join the run. Scoping must not lose it.
    await lm.runInMemberScope(async () => {
      lm.log('info', 'agent', 'A-pre-mint')
      lm.setRunId('run-A')
    })

    expect(runIdsOf(lm, 'A-pre-mint')).toEqual(['run-A'])
  })

  it('does not let one member\'s stamp adopt a sibling\'s not-yet-attributed lines', async () => {
    const lm = new LogManager({ displayLevel: 'silent', memberScope: new AsyncLocalStorage<MemberLogScope>() })

    // Both members log BEFORE either mints. Each backfill must claim only its own scope's lines —
    // an unattributed-only backfill that ignored scope would hand A's line to whoever stamps first.
    const a = lm.runInMemberScope(async () => {
      lm.log('info', 'agent', 'A-pre-mint')
      await Promise.resolve()
      lm.setRunId('run-A')
    })
    const b = lm.runInMemberScope(async () => {
      lm.log('info', 'agent', 'B-pre-mint')
      lm.setRunId('run-B')
    })
    await Promise.all([a, b])

    expect(runIdsOf(lm, 'A-pre-mint')).toEqual(['run-A'])
    expect(runIdsOf(lm, 'B-pre-mint')).toEqual(['run-B'])
  })

  it('REFUSES member isolation the composition root never wired up', () => {
    // Fail loud, not degrade quiet: a manager built without the host's async-context primitive
    // cannot isolate members, and silently running `fn` anyway would restore the corruption on a
    // caller that believed it was isolated.
    const lm = new LogManager({ displayLevel: 'silent' })
    expect(() => lm.runInMemberScope(() => undefined)).toThrow(MemberLogScopeUnavailableError)
  })

  it('leaves the SEQUENTIAL path byte-identical — no scope, one run id, backfill intact', () => {
    const lm = new LogManager({ displayLevel: 'silent', memberScope: new AsyncLocalStorage<MemberLogScope>() })

    lm.log('info', 'agent', 'pre-mint')
    lm.setRunId('run-only')
    lm.log('info', 'agent', 'post-mint')

    expect(runIdsOf(lm, 'pre-mint')).toEqual(['run-only'])
    expect(runIdsOf(lm, 'post-mint')).toEqual(['run-only'])
  })

  it('flushes a scoped run to storage — a scoped stamp still satisfies the runIdSet gate', async () => {
    const inserted: LogEntry[][] = []
    const storage: LogStorage = {
      insertLogs: (entries: LogEntry[]) => { inserted.push(entries) },
      getLogs: vi.fn().mockReturnValue([]),
    }
    const lm = new LogManager({ displayLevel: 'silent', storage, memberScope: new AsyncLocalStorage<MemberLogScope>() })

    await lm.runInMemberScope(async () => {
      lm.setRunId('run-A')
      lm.log('info', 'agent', 'A-line')
    })
    lm.flush()

    // Without this, a fully-attributed concurrent run would be DISCARDED at flush.
    expect(inserted).toHaveLength(1)
    expect(inserted[0]?.map((e) => e.runId)).toEqual(['run-A'])
  })
})
