import { describe, it, expect, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TestRunner, type LiveExecutionEvent } from '../execution/test-runner.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixtures = join(__dirname, 'fixtures')
const okScript = join(fixtures, 'ok.sh')
const failScript = join(fixtures, 'fail.sh')
const hangScript = join(fixtures, 'hang.sh')
const heartbeatScript = join(fixtures, 'heartbeat.sh')

let runner: TestRunner | null = null
const tempDirs: string[] = []

afterEach(() => {
  if (runner) {
    runner.killAll()
    runner = null
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTempScript(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-runner-'))
  tempDirs.push(dir)
  const script = join(dir, name)
  writeFileSync(script, body)
  chmodSync(script, 0o755)
  return script
}

function waitForEvent(r: TestRunner, runId: string, eventType: string): Promise<LiveExecutionEvent> {
  return new Promise((resolve) => {
    r.on('execution-event', (_runId: string, event: LiveExecutionEvent) => {
      if (_runId === runId && event.type === eventType) resolve(event)
    })
  })
}

describe('TestRunner', () => {
  it('spawn + event parsing: emits test-start and run-complete on successful exit', async () => {
    runner = new TestRunner({ cliBin: okScript })
    const runId = `run-ok-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    const event = await runComplete
    expect(event.status).toBe('completed')

    const events = runner.getBufferedEvents(runId)
    const types = events.map(e => e.type)
    expect(types).toContain('run-start')
    expect(types).toContain('test-start')
    expect(types).toContain('test-complete')
    expect(types).toContain('run-complete')
  })

  it('kill with tree-kill escalation: process exits and status becomes cancelled', async () => {
    runner = new TestRunner({ cliBin: hangScript })
    const runId = `run-kill-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    // Wait briefly for process to start
    await new Promise(r => setTimeout(r, 200))

    const handle = runner.getHandle(runId)
    expect(handle).toBeDefined()
    expect(handle!.status).toBe('running')

    const killed = runner.kill(runId)
    expect(killed).toBe(true)
    expect(handle!.status).toBe('cancelled')

    const event = await runComplete
    expect(event.status).toBe('cancelled')
  }, 10_000)

  it('kill requests graceful cancellation before force-kill fallback', async () => {
    const gracefulScript = createTempScript('graceful-cancel.sh', `#!/bin/sh
trap "echo 'AGENT_QA_EVENT:{\\"type\\":\\"test-complete\\",\\"testName\\":\\"test\\",\\"status\\":\\"cancelled\\"}'; exit 130" INT TERM
echo 'AGENT_QA_EVENT:{"type":"test-start","testName":"test"}'
while true; do sleep 1; done
`)
    const processKill = vi.spyOn(process, 'kill')
    runner = new TestRunner({ cliBin: gracefulScript })
    const runId = `run-graceful-cancel-${Date.now()}`

    try {
      const runComplete = waitForEvent(runner, runId, 'run-complete')
      runner.execute({ runId, args: [], source: 'manual' })
      await new Promise(r => setTimeout(r, 200))

      expect(runner.kill(runId)).toBe(true)

      const event = await runComplete
      expect(event.status).toBe('cancelled')
      const signals = processKill.mock.calls.map((call) => call[1])
      expect(signals).toContain('SIGINT')
      expect(signals).not.toContain('SIGKILL')
    } finally {
      processKill.mockRestore()
    }
  }, 10_000)

  it('killAll immediate: process dies with SIGKILL', async () => {
    runner = new TestRunner({ cliBin: hangScript })
    const runId = `run-killall-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    await new Promise(r => setTimeout(r, 200))

    const handle = runner.getHandle(runId)
    expect(handle).toBeDefined()
    expect(handle!.status).toBe('running')

    runner.killAll()

    const event = await runComplete
    // killAll sends SIGKILL, which makes the process exit with non-zero
    expect(['failed', 'cancelled']).toContain(event.status)
  })

  it('does not arm an implicit 10 minute process timer without an explicit timeout', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    runner = new TestRunner({
      cliBin: hangScript,
      heartbeatIntervalMs: 1_000,
      staleThresholdMs: 60_000,
    })
    const runId = `run-no-implicit-timeout-${Date.now()}`

    try {
      const runComplete = waitForEvent(runner, runId, 'run-complete')
      runner.execute({ runId, args: [], source: 'manual' })
      await new Promise(r => setTimeout(r, 200))

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1])
      expect(delays).not.toContain(600_000)

      expect(runner.kill(runId)).toBe(true)
      await runComplete
    } finally {
      setTimeoutSpy.mockRestore()
    }
  }, 10_000)

  it('explicit per-run timeout terminates a hanging process', async () => {
    const onClose = vi.fn()
    runner = new TestRunner({
      cliBin: hangScript,
      onProcessClose: onClose,
      heartbeatIntervalMs: 1_000,
      staleThresholdMs: 60_000,
    })
    const runId = `run-explicit-timeout-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual', timeout: 200 })

    const event = await runComplete
    expect(event.status).toBe('timeout')
    expect(onClose).toHaveBeenCalledWith(runId, 'timeout')
  }, 10_000)

  it('heartbeat events keep stale detection from killing an active process', async () => {
    runner = new TestRunner({
      cliBin: heartbeatScript,
      heartbeatIntervalMs: 100,
      staleThresholdMs: 2_500,
    })
    const runId = `run-heartbeat-refresh-${Date.now()}`

    runner.execute({ runId, args: [], source: 'manual' })
    await new Promise(r => setTimeout(r, 4_500))

    const handle = runner.getHandle(runId)
    expect(handle).toBeDefined()
    expect(handle!.status).toBe('running')
    expect(runner.getBufferedEvents(runId).some(e => e.type === 'heartbeat')).toBe(true)

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    expect(runner.kill(runId)).toBe(true)
    await runComplete
  }, 10_000)

  it('resolveCliBin uses env var first', () => {
    const original = process.env.AGENT_QA_CLI_BIN
    process.env.AGENT_QA_CLI_BIN = '/usr/local/bin/agent-qa'
    try {
      expect(TestRunner.resolveCliBin()).toBe('/usr/local/bin/agent-qa')
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_QA_CLI_BIN
      } else {
        process.env.AGENT_QA_CLI_BIN = original
      }
    }
  })

  it('resolveCliBin falls back to node_modules path', () => {
    const original = process.env.AGENT_QA_CLI_BIN
    delete process.env.AGENT_QA_CLI_BIN
    try {
      const result = TestRunner.resolveCliBin()
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    } finally {
      if (original !== undefined) {
        process.env.AGENT_QA_CLI_BIN = original
      }
    }
  })

  it('heartbeat stale detection marks process failed after threshold', async () => {
    const onClose = vi.fn()
    // Use very short intervals for fast testing
    runner = new TestRunner({
      cliBin: hangScript,
      onProcessClose: onClose,
      heartbeatIntervalMs: 100,
      staleThresholdMs: 500,
    })
    const runId = `run-stale-${Date.now()}`

    // hang.sh emits test-start then goes silent (sleep forever)
    runner.execute({ runId, args: [], source: 'manual' })

    // Wait for stale detection to kick in
    await new Promise(r => setTimeout(r, 1500))

    const handle = runner.getHandle(runId)
    expect(handle).toBeDefined()
    expect(handle!.status).toBe('failed')

    const events = runner.getBufferedEvents(runId)
    const runCompletes = events.filter(e => e.type === 'run-complete')
    const staleEvent = runCompletes.find(e => e.reason === 'stale process — no heartbeat')
    expect(staleEvent).toBeDefined()
    expect(staleEvent!.status).toBe('failed')

    expect(onClose).toHaveBeenCalledWith(runId, 'failed')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('fail script: process exits with failed status', async () => {
    runner = new TestRunner({ cliBin: failScript })
    const runId = `run-fail-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    const event = await runComplete
    expect(event.status).toBe('failed')
  })

  it('exit zero without reporter completion is failed', async () => {
    const incompleteScript = createTempScript('incomplete.sh', `#!/bin/sh
echo 'AGENT_QA_EVENT:{"type":"test-start","testName":"test"}'
exit 0
`)
    const onClose = vi.fn()
    runner = new TestRunner({ cliBin: incompleteScript, onProcessClose: onClose })
    const runId = `run-incomplete-zero-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    const event = await runComplete
    expect(event.status).toBe('failed')
    expect(event.reason).toBe('process exited before test completed')
    expect(onClose).toHaveBeenCalledWith(runId, 'failed')
  })

  it('getActiveExecutions returns running processes', async () => {
    runner = new TestRunner({ cliBin: hangScript })
    const runId = `run-active-${Date.now()}`

    runner.execute({ runId, args: [], source: 'manual' })
    await new Promise(r => setTimeout(r, 200))

    const active = runner.getActiveExecutions()
    expect(active.length).toBe(1)
    expect(active[0].runId).toBe(runId)
    expect(active[0].status).toBe('running')
  })

  it('onProcessClose callback is called on normal exit', async () => {
    const onClose = vi.fn()
    runner = new TestRunner({ cliBin: okScript, onProcessClose: onClose })
    const runId = `run-close-${Date.now()}`

    const runComplete = waitForEvent(runner, runId, 'run-complete')
    runner.execute({ runId, args: [], source: 'manual' })

    await runComplete
    expect(onClose).toHaveBeenCalledWith(runId, 'completed')
  })
})
