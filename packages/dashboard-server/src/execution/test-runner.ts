import { EventEmitter } from 'node:events'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import type { ExecutionBackend, ExecuteOptions } from './execution-backend.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_STALE_THRESHOLD_MS = 30_000
const PROCESS_TERMINATION_GRACE_MS = 5_000
const HANDLE_RETENTION_MS = 5 * 60 * 1000

export interface LiveExecutionEvent {
  id: number
  type: string
  [key: string]: unknown
}

export interface TestRunHandle {
  runId: string
  process: ChildProcess
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'
  output: string[]
  startedAt: Date
  lastEventAt: number
  completionReason?: string
}

export class TestRunner extends EventEmitter implements ExecutionBackend {
  private cliBin: string
  private defaultTimeout: number | undefined
  private handles = new Map<string, TestRunHandle>()
  private eventBuffers = new Map<string, LiveExecutionEvent[]>()
  private eventCounters = new Map<string, number>()
  private onProcessClose?: (runId: string, status: 'completed' | 'failed' | 'cancelled' | 'timeout') => void
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatIntervalMs: number
  private staleThresholdMs: number

  constructor(opts: {
    cliBin: string
    defaultTimeout?: number
    onProcessClose?: (runId: string, status: 'completed' | 'failed' | 'cancelled' | 'timeout') => void
    heartbeatIntervalMs?: number
    staleThresholdMs?: number
  }) {
    super()
    this.cliBin = opts.cliBin
    this.defaultTimeout = opts.defaultTimeout
    this.onProcessClose = opts.onProcessClose
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.staleThresholdMs = Math.max(
      opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
      this.heartbeatIntervalMs + 1,
    )
  }

  static resolveCliBin(): string {
    const envBin = process.env.AGENT_QA_CLI_BIN
    if (envBin) return envBin

    try {
      const which = execSync('which agent-qa', { encoding: 'utf-8' }).trim()
      if (which) return which
    } catch {
      // not found in PATH
    }

    return './node_modules/.bin/agent-qa'
  }

  execute(opts: ExecuteOptions): void {
    const spawnArgs = ['run', ...opts.args]
    const maxRetries = opts.maxRetries ?? 0

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...opts.env,
      AGENT_QA_LIVE_EVENTS: 'true',
    }
    if (opts.attributes) {
      env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify(opts.attributes)
    }

    if (opts.source === 'suite') {
      // Suites create their own parent row via DashboardReporter.onSuiteStart
      // Pass the enqueued run ID so the suite can update it instead of creating a duplicate
      env.AGENT_QA_SUITE_QUEUE_ID = opts.runId
    } else if (maxRetries > 0) {
      // Retry-enabled: parent run stays in 'running', reporter creates child runs
      env.AGENT_QA_PARENT_RUN_ID = opts.runId
      env.AGENT_QA_MAX_RETRIES = String(maxRetries)
    } else {
      // No retries: reporter updates the existing run row directly
      env.AGENT_QA_RUN_ID = opts.runId
    }

    const child = spawn(this.cliBin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32',
    })

    const handle: TestRunHandle = {
      runId: opts.runId,
      process: child,
      status: 'running',
      output: [],
      startedAt: new Date(),
      lastEventAt: Date.now(),
    }
    this.handles.set(opts.runId, handle)
    this.eventBuffers.set(opts.runId, [])
    this.eventCounters.set(opts.runId, 0)

    this.startHeartbeatChecker()

    const processTimeoutMs = opts.timeout ?? this.defaultTimeout
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    const timer = typeof processTimeoutMs === 'number' && Number.isFinite(processTimeoutMs) && processTimeoutMs > 0
      ? setTimeout(() => {
          if (handle.status !== 'running') return
          handle.status = 'timeout'
          handle.completionReason = `process timeout after ${processTimeoutMs}ms`
          this.signalHandle(handle, 'SIGTERM')
          forceKillTimer = setTimeout(() => {
            this.signalHandle(handle, 'SIGKILL')
          }, PROCESS_TERMINATION_GRACE_MS)
          forceKillTimer.unref()
        }, processTimeoutMs)
      : null
    timer?.unref()

    this.pushEvent(opts.runId, { type: 'run-start', runId: opts.runId, status: 'running' })

    let stdoutBuffer = ''
    // Capture the actual test result status from the reporter (test-complete event).
    // This is the ground truth — process exit code can be misleading (e.g., mobile
    // tests exit non-zero from Appium cleanup even when all steps pass).
    let testResultStatus: string | undefined

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line) continue
        if (line.startsWith('AGENT_QA_EVENT:')) {
          try {
            const payload = JSON.parse(line.slice('AGENT_QA_EVENT:'.length))
            handle.lastEventAt = Date.now()
            if (payload.type === 'test-complete' && payload.status) {
              testResultStatus = payload.status
            }
            this.pushEvent(opts.runId, payload)
          } catch {
            handle.output.push(line)
            this.emit('output', opts.runId, line)
          }
        } else {
          handle.output.push(line)
          this.emit('output', opts.runId, line)
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        handle.output.push(line)
      }
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (stdoutBuffer) {
        if (stdoutBuffer.startsWith('AGENT_QA_EVENT:')) {
          try {
            const payload = JSON.parse(stdoutBuffer.slice('AGENT_QA_EVENT:'.length))
            if (payload.type === 'test-complete' && payload.status) {
              testResultStatus = payload.status
            }
            this.pushEvent(opts.runId, payload)
          } catch {
            handle.output.push(stdoutBuffer)
          }
        } else {
          handle.output.push(stdoutBuffer)
        }
        stdoutBuffer = ''
      }

      if (handle.status !== 'timeout' && handle.status !== 'cancelled' && handle.status !== 'failed') {
        // Use the actual test result from the reporter (test-complete event) as
        // ground truth. A clean process exit without reporter completion is incomplete.
        if (testResultStatus) {
          handle.status = testResultStatus === 'passed'
            ? 'completed'
            : testResultStatus === 'cancelled'
              ? 'cancelled'
              : 'failed'
        } else {
          handle.status = 'failed'
          handle.completionReason = 'process exited before test completed'
        }
      }

      const duration = Date.now() - handle.startedAt.getTime()
      this.pushEvent(opts.runId, {
        type: 'run-complete',
        runId: opts.runId,
        status: handle.status,
        duration,
        ...(handle.completionReason ? { reason: handle.completionReason } : {}),
      })

      if (this.onProcessClose) {
        this.onProcessClose(opts.runId, handle.status)
      }

      const cleanupTimer = setTimeout(() => {
        this.handles.delete(opts.runId)
        this.eventBuffers.delete(opts.runId)
        this.eventCounters.delete(opts.runId)
      }, HANDLE_RETENTION_MS)
      cleanupTimer.unref()
    })
  }

  getBufferedEvents(runId: string): LiveExecutionEvent[] {
    return this.eventBuffers.get(runId) ?? []
  }

  getHandle(runId: string): TestRunHandle | undefined {
    return this.handles.get(runId)
  }

  getActiveExecutions(): { runId: string; status: string; startedAt: string; duration: number; testName?: string }[] {
    const active: { runId: string; status: string; startedAt: string; duration: number; testName?: string }[] = []
    for (const handle of this.handles.values()) {
      if (handle.status === 'running') {
        const events = this.eventBuffers.get(handle.runId) ?? []
        const testStart = events.find(e => e.type === 'test-start')
        active.push({
          runId: handle.runId,
          status: handle.status,
          startedAt: handle.startedAt.toISOString(),
          duration: Date.now() - handle.startedAt.getTime(),
          testName: testStart?.testName as string | undefined,
        })
      }
    }
    return active
  }

  kill(runId: string): boolean {
    const handle = this.handles.get(runId)
    if (handle && handle.status === 'running') {
      this.signalHandle(handle, 'SIGINT')
      const forceTimer = setTimeout(() => {
        this.signalHandle(handle, 'SIGKILL')
      }, PROCESS_TERMINATION_GRACE_MS)
      forceTimer.unref()
      handle.process.once('close', () => clearTimeout(forceTimer))
      handle.status = 'cancelled'
      return true
    }
    return false
  }

  killAll(): void {
    for (const handle of this.handles.values()) {
      if (handle.status === 'running') {
        handle.status = 'cancelled'
        this.signalHandle(handle, 'SIGKILL')
      }
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startHeartbeatChecker(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      for (const handle of this.handles.values()) {
        if (handle.status !== 'running') continue
        if (Date.now() - handle.lastEventAt > this.staleThresholdMs) {
          handle.status = 'failed'
          handle.completionReason = 'stale process — no heartbeat'
          this.signalHandle(handle, 'SIGKILL')
        }
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }

  private pushEvent(runId: string, payload: Record<string, unknown>): void {
    const counter = (this.eventCounters.get(runId) ?? 0) + 1
    this.eventCounters.set(runId, counter)

    const event: LiveExecutionEvent = { ...payload, id: counter } as LiveExecutionEvent
    const buffer = this.eventBuffers.get(runId)
    if (buffer) {
      buffer.push(event)
    }
    this.emit('execution-event', runId, event)
  }

  private signalHandle(handle: TestRunHandle, signal: NodeJS.Signals): void {
    const pid = handle.process.pid
    if (!pid) return

    if (process.platform === 'win32') {
      treeKill(pid, signal, () => {})
      return
    }

    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Fall back to direct child signaling when the process group is unavailable.
    }

    try {
      handle.process.kill(signal)
      return
    } catch {
      // Fall back to tree-kill as a last resort.
    }

    treeKill(pid, signal, () => {})
  }
}
