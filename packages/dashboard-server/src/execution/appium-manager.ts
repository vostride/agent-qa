import {
  startAppiumServer,
  type AppiumServer,
  type StartAppiumServerOptions,
} from '@vostride/agent-qa-appium-runtime'
import { printLogLine } from '@vostride/agent-qa-core'

const TAG = 'appium'

export interface AppiumLeaseOwner {
  runId: string
  platform: 'android' | 'ios'
}

export class AppiumManager {
  private server: AppiumServer | null = null
  private startPromise: Promise<void> | null = null
  private leases = new Map<string, 'android' | 'ios'>()
  // Settles once every stop begun so far has settled.
  private stopping: Promise<void> = Promise.resolve()
  private closed = false
  private logLevel: 'normal' | 'debug'
  private startAppium: (options: StartAppiumServerOptions) => Promise<AppiumServer>
  private readonly masks = new Set<(text: string) => string>()

  constructor(opts?: {
    logLevel?: 'normal' | 'debug'
    startAppium?: (options: StartAppiumServerOptions) => Promise<AppiumServer>
  }) {
    this.logLevel = opts?.logLevel ?? 'normal'
    this.startAppium = opts?.startAppium ?? startAppiumServer
  }

  bindMask(mask: (text: string) => string): () => void {
    this.masks.add(mask)
    return () => {
      this.masks.delete(mask)
    }
  }

  private masked(text: string): string {
    let result = text
    for (const mask of this.masks) result = mask(result)
    return result
  }

  private debugLine(message: string, data?: Record<string, unknown>): void {
    if (this.logLevel === 'debug') printLogLine({ tag: TAG, message, data })
  }

  async acquireLease(owner: AppiumLeaseOwner): Promise<void> {
    await this.ensureRunning()
    if (!this.leases.has(owner.runId)) this.leases.set(owner.runId, owner.platform)
    this.debugLine('Lease acquired', {
      run: owner.runId,
      platform: owner.platform,
      leases: this.leases.size,
    })
  }

  releaseLease(runId: string, reason = 'completed'): boolean {
    const platform = this.leases.get(runId)
    if (!platform) return false

    this.leases.delete(runId)
    this.debugLine('Lease released', { run: runId, platform, reason, leases: this.leases.size })
    if (this.leases.size > 0) {
      this.debugLine('Server kept alive', { leases: this.leases.size })
    } else {
      void this.performShutdown()
    }
    return true
  }

  async ensureRunning(): Promise<void> {
    if (this.closed) throw new Error('Appium is shut down')
    if (this.server) return

    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = this.startAndWait()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startAndWait(): Promise<void> {
    // A chunk can end inside a line, and inside a secret, so only whole lines are masked and
    // printed.
    const unfinished = { stdout: '', stderr: '' }
    const forward = (line: string, stream: 'stdout' | 'stderr'): void => {
      if (line === '') return
      printLogLine({ tag: TAG, level: 'debug', message: this.masked(line) }, { to: stream })
    }
    const server = await this.startAppium({
      onOutput: (text, stream) => {
        if (this.logLevel !== 'debug') return
        const lines = (unfinished[stream] + text).split(/\r?\n/u)
        unfinished[stream] = lines.pop() ?? ''
        for (const line of lines) forward(line, stream)
      },
    })
    this.server = server
    printLogLine({ tag: TAG, message: `Started on :${new URL(server.url).port}` })
    // A server that ended on its own is no longer held, so the next call starts another.
    void server.exited.then(() => {
      if (this.server === server) this.server = null
      for (const stream of ['stdout', 'stderr'] as const) {
        const rest = unfinished[stream]
        unfinished[stream] = ''
        forward(rest, stream)
      }
    })
  }

  private performShutdown(): Promise<void> {
    const server = this.server
    if (server) {
      // Released before the stop settles, so a lease taken during the stop starts a new server.
      this.server = null
      printLogLine({ tag: TAG, message: 'Stopped' })
      this.stopping = Promise.all([this.stopping, server.stop()]).then(() => {})
    }
    return this.stopping
  }

  shutdown(): Promise<void> {
    this.closed = true
    this.leases.clear()
    const starting = this.startPromise
    if (starting === null) return this.performShutdown()
    // A start in flight is waited for, so the server it produces is stopped too.
    return starting.then(
      () => this.performShutdown(),
      () => this.performShutdown(),
    )
  }

  getUrl(): string {
    if (!this.server) throw new Error('Appium is not running')
    return this.server.url
  }
}
