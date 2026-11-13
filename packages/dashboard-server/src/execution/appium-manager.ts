import {
  startAppiumServer,
  type AppiumServer,
  type StartAppiumServerOptions,
} from '@vostride/agent-qa-appium-runtime'
import { printRunText } from '@vostride/agent-qa-core'
import pc from 'picocolors'

const APPIUM_PREFIX = pc.magenta('[appium]')

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

  constructor(opts?: {
    logLevel?: 'normal' | 'debug'
    startAppium?: (options: StartAppiumServerOptions) => Promise<AppiumServer>
  }) {
    this.logLevel = opts?.logLevel ?? 'normal'
    this.startAppium = opts?.startAppium ?? startAppiumServer
  }

  async acquireLease(owner: AppiumLeaseOwner): Promise<void> {
    await this.ensureRunning()
    if (!this.leases.has(owner.runId)) this.leases.set(owner.runId, owner.platform)
    console.log(`${APPIUM_PREFIX} lease acquired run=${owner.runId} platform=${owner.platform} leases=${this.leases.size}`)
  }

  releaseLease(runId: string, reason = 'completed'): boolean {
    const platform = this.leases.get(runId)
    if (!platform) return false

    this.leases.delete(runId)
    console.log(`${APPIUM_PREFIX} lease released run=${runId} platform=${platform} reason=${reason} leases=${this.leases.size}`)
    if (this.leases.size > 0) {
      console.log(`${APPIUM_PREFIX} server kept alive leases=${this.leases.size}`)
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
    const server = await this.startAppium({
      onOutput: (text, stream) => {
        if (this.logLevel !== 'debug') return
        for (const line of text.split('\n').filter(Boolean)) {
          printRunText(`${APPIUM_PREFIX} ${pc.dim(line)}`, (out) =>
            stream === 'stdout' ? console.log(out) : console.error(out),
          )
        }
      },
    })
    this.server = server
    console.log(`${APPIUM_PREFIX} ${pc.green(`started on :${new URL(server.url).port}`)}`)
    // A server that ended on its own is no longer held, so the next call starts another.
    void server.exited.then(() => {
      if (this.server === server) this.server = null
    })
  }

  private performShutdown(): Promise<void> {
    const server = this.server
    if (server) {
      // Released before the stop settles, so a lease taken during the stop starts a new server.
      this.server = null
      console.log(`${APPIUM_PREFIX} ${pc.yellow('stopped')}`)
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
