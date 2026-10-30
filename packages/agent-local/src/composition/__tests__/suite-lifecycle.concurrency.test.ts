// Setup awaits before the active key is set, so a held-open setup forces the concurrent-entry race.
import { describe, expect, it } from 'vitest'

import {
  createSuiteLifecycle,
  buildSuiteMemberExecutor,
  SuiteBoundaryWhileLiveError,
} from '../run-composition.js'
import type { SuiteLifecycleHooks, SuiteMemberBinding } from '../run-composition.js'
import type { MemberTestRunContext, RunMemberDescriptor } from '@vostride/agent-qa-runner'
import type { TestResult } from '@vostride/agent-qa-runner'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A hook pair that records every invocation and lets the test hold setup open. */
function recordingHooks(
  key: string,
  log: string[],
  gate?: Promise<void>,
): SuiteLifecycleHooks & { setupCalls: () => number } {
  let setupCalls = 0
  return {
    async setup() {
      setupCalls += 1
      log.push(`setup:${key}`)
      if (gate) await gate
      log.push(`setup-done:${key}`)
    },
    async teardown() {
      log.push(`teardown:${key}`)
    },
    setupCalls: () => setupCalls,
  }
}

describe('createSuiteLifecycle — the per-suite setup once-latch', () => {
  it('merges two members racing into ONE setup invocation, and both await its completion', async () => {
    const log: string[] = []
    const gate = deferred()
    const hooks = recordingHooks('A', log, gate.promise)
    const lifecycle = createSuiteLifecycle()

    // Both members enter before either resolves — the window the `for` loop never opened.
    const first = lifecycle.ensureReady('A', hooks)
    const second = lifecycle.ensureReady('A', hooks)

    // The latch must be visible SYNCHRONOUSLY: by the time the second call returns its promise the
    // first setup is already the one everybody waits on. Draining microtasks here would let a
    // check-then-set implementation look correct if it happened to assign before the second call.
    expect(hooks.setupCalls()).toBe(1)

    let firstSettled = false
    let secondSettled = false
    void first.then(() => {
      firstSettled = true
    })
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    gate.resolve()
    await Promise.all([first, second])
    expect(hooks.setupCalls()).toBe(1)
    expect(log).toEqual(['setup:A', 'setup-done:A'])
  })

  it('does not re-run setup for a later member of the same suite', async () => {
    const log: string[] = []
    const hooks = recordingHooks('A', log)
    const lifecycle = createSuiteLifecycle()

    const one = await lifecycle.ensureReady('A', hooks)
    one.release()
    const two = await lifecycle.ensureReady('A', hooks)
    two.release()

    expect(hooks.setupCalls()).toBe(1)
    expect(log).toEqual(['setup:A', 'setup-done:A'])
  })
})

describe('createSuiteLifecycle — teardown after the LAST member settles', () => {
  it('holds teardown while a sibling member is still live, then runs it once both released', async () => {
    const log: string[] = []
    const a = recordingHooks('A', log)
    const b = recordingHooks('B', log)
    const lifecycle = createSuiteLifecycle()

    const m0 = await lifecycle.ensureReady('A', a)
    const m1 = await lifecycle.ensureReady('A', a)

    // The first member is done and the second is not, so suite A is not torn down here.
    m0.release()
    log.push('m0-settled')
    await expect(lifecycle.ensureReady('B', b)).rejects.toBeInstanceOf(SuiteBoundaryWhileLiveError)
    expect(log).not.toContain('teardown:A')

    m1.release()
    log.push('m1-settled')
    const first = await lifecycle.ensureReady('B', b)
    first.release()
    await lifecycle.finalize()

    expect(log).toEqual([
      'setup:A',
      'setup-done:A',
      'm0-settled',
      'm1-settled',
      'teardown:A',
      'setup:B',
      'setup-done:B',
      'teardown:B',
    ])
  })

  it('names the cross-suite violation instead of silently tearing down a live suite', async () => {
    const log: string[] = []
    const a = recordingHooks('A', log)
    const b = recordingHooks('B', log)
    const lifecycle = createSuiteLifecycle()

    const live = await lifecycle.ensureReady('A', a)
    let caught: unknown
    try {
      await lifecycle.ensureReady('B', b)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SuiteBoundaryWhileLiveError)
    const named = caught as SuiteBoundaryWhileLiveError
    expect(named.activeSuiteKey).toBe('A')
    expect(named.requestedSuiteKey).toBe('B')
    expect(named.liveMembers).toBe(1)
    // Suite A survives the violation intact: neither torn down nor replaced.
    expect(log).toEqual(['setup:A', 'setup-done:A'])
    expect(b.setupCalls()).toBe(0)

    live.release()
  })
})

describe('createSuiteLifecycle — a failed setup poisons the whole suite', () => {
  it('runs setup once, rejects EVERY member of the suite with it, and tears nothing down', async () => {
    const log: string[] = []
    const gate = deferred()
    let setupCalls = 0
    const boom = new Error('suite setup exploded')
    const hooks: SuiteLifecycleHooks = {
      async setup() {
        setupCalls += 1
        log.push('setup:A')
        await gate.promise
        throw boom
      },
      async teardown() {
        log.push('teardown:A')
      },
    }
    const lifecycle = createSuiteLifecycle()

    const members = [
      lifecycle.ensureReady('A', hooks),
      lifecycle.ensureReady('A', hooks),
      lifecycle.ensureReady('A', hooks),
    ]
    gate.reject(boom)
    const settled = await Promise.allSettled(members)

    expect(setupCalls).toBe(1)
    // No member half-starts: all three see the SAME failure, not one failure and two successes.
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected')
      expect((outcome as PromiseRejectedResult).reason).toBe(boom)
    }
    // A fourth member arriving later reuses the poisoned latch rather than retrying setup.
    await expect(lifecycle.ensureReady('A', hooks)).rejects.toBe(boom)
    expect(setupCalls).toBe(1)

    // A suite whose setup threw is never torn down — there is nothing that came up to take down.
    await lifecycle.finalize()
    expect(log).toEqual(['setup:A'])
  })
})

describe('buildSuiteMemberExecutor — the lease is released even when the member throws', () => {
  function bindingFor(
    suiteKey: string,
    hooks: SuiteLifecycleHooks,
    run: (ctx: MemberTestRunContext) => Promise<TestResult>,
  ): SuiteMemberBinding {
    return { suiteKey, hooks, run }
  }

  function member(id: string): RunMemberDescriptor {
    return { testId: id, name: `${id} test`, filePath: `${id}.test.ts` }
  }

  function ctxFor(testIndex: number): MemberTestRunContext {
    return {
      abortSignal: new AbortController().signal,
      testIndex,
      events: {
        stepStarted: () => undefined,
        loopEmitFor: () => ({}) as never,
        hookStarted: () => undefined,
        hookFinished: () => undefined,
        testRetryScheduled: () => undefined,
      },
      setEvidenceContext: () => undefined,
    }
  }

  function passing(id: string): TestResult {
    return { name: id, filePath: `${id}.test.ts`, status: 'passed', steps: [], duration: 1 }
  }

  it('drops the hold when a member rejects, so the next suite is not blocked forever', async () => {
    const log: string[] = []
    const a = recordingHooks('A', log)
    const b = recordingHooks('B', log)
    const lifecycle = createSuiteLifecycle()
    const boom = new Error('member exploded')
    const executor = buildSuiteMemberExecutor({
      lifecycle,
      bindings: [
        bindingFor('A', a, async () => {
          throw boom
        }),
        bindingFor('B', b, async () => passing('m1')),
      ],
    })

    await expect(executor(member('m0'), ctxFor(0))).rejects.toBe(boom)
    // If the failing member's hold leaked, this would be a SuiteBoundaryWhileLiveError.
    await expect(executor(member('m1'), ctxFor(1))).resolves.toEqual(passing('m1'))
    expect(log).toEqual(['setup:A', 'setup-done:A', 'teardown:A', 'setup:B', 'setup-done:B'])
  })

  it('merges two concurrent members of one suite into a single setup end to end', async () => {
    const log: string[] = []
    const gate = deferred()
    const a = recordingHooks('A', log, gate.promise)
    const lifecycle = createSuiteLifecycle()
    const executor = buildSuiteMemberExecutor({
      lifecycle,
      bindings: [
        bindingFor('A', a, async () => passing('m0')),
        bindingFor('A', a, async () => passing('m1')),
      ],
    })

    const both = Promise.all([executor(member('m0'), ctxFor(0)), executor(member('m1'), ctxFor(1))])
    expect(a.setupCalls()).toBe(1)
    gate.resolve()
    expect(await both).toEqual([passing('m0'), passing('m1')])
    expect(a.setupCalls()).toBe(1)
  })
})
