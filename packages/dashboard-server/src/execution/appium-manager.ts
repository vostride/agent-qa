import { request } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  formatAppiumInstallGuidance,
  resolveAppiumExecutable,
  type ResolvedAppiumExecutable,
} from '@vostride/agent-qa-core'
import treeKill from 'tree-kill'
import pc from 'picocolors'

const APPIUM_PREFIX = pc.magenta('[appium]')

export interface AppiumLeaseOwner {
  runId: string
  platform: 'android' | 'ios'
}

export interface AppiumLease extends AppiumLeaseOwner {
  acquiredAt: string
}

export class AppiumManager {
  private process: ChildProcess | null = null
  private port: number
  private ready = false
  private startPromise: Promise<void> | null = null
  private managed = false
  private startupTimeoutMs: number
  private pollIntervalMs: number
  private anonymousRefCount = 0
  private leases = new Map<string, AppiumLease>()
  private logLevel: 'normal' | 'debug'
  private appiumResolver: () => ResolvedAppiumExecutable

  constructor(opts?: {
    port?: number
    startupTimeoutMs?: number
    pollIntervalMs?: number
    logLevel?: 'normal' | 'debug'
    appiumResolver?: () => ResolvedAppiumExecutable
  }) {
    this.port = opts?.port ?? 4723
    this.startupTimeoutMs = opts?.startupTimeoutMs ?? 30_000
    this.pollIntervalMs = opts?.pollIntervalMs ?? 500
    this.logLevel = opts?.logLevel ?? 'normal'
    this.appiumResolver = opts?.appiumResolver ?? resolveAppiumExecutable
  }

  async acquire(): Promise<void> {
    await this.ensureRunning()
    this.anonymousRefCount++
  }

  release(): void {
    if (this.anonymousRefCount > 0) this.anonymousRefCount--
    this.maybeShutdownAfterRelease()
  }

  async acquireLease(owner: AppiumLeaseOwner): Promise<void> {
    await this.ensureRunning()
    if (!this.leases.has(owner.runId)) {
      this.leases.set(owner.runId, {
        runId: owner.runId,
        platform: owner.platform,
        acquiredAt: new Date().toISOString(),
      })
    }
    console.log(`${APPIUM_PREFIX} lease acquired run=${owner.runId} platform=${owner.platform} leases=${this.getLeaseCount()} managed=${this.managed}`)
  }

  releaseLease(runId: string, reason = 'completed'): boolean {
    const lease = this.leases.get(runId)
    if (!lease) return false

    this.leases.delete(runId)
    console.log(`${APPIUM_PREFIX} lease released run=${runId} platform=${lease.platform} reason=${reason} leases=${this.getLeaseCount()} managed=${this.managed}`)
    this.maybeShutdownAfterRelease()
    return true
  }

  releaseAllLeases(reason = 'shutdown'): string[] {
    const runIds = [...this.leases.keys()]
    for (const runId of runIds) {
      this.releaseLease(runId, reason)
    }
    return runIds
  }

  async ensureRunning(): Promise<void> {
    if (this.ready) {
      const still = await this.checkStatus()
      if (still) return
      this.ready = false
    }

    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = (async () => {
      const alive = await this.checkStatus()
      if (alive) {
        this.ready = true
        this.managed = false
        return
      }
      await this.startAndWait()
    })()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async checkStatus(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = request(
        {
          hostname: 'localhost',
          port: this.port,
          path: '/status',
          method: 'GET',
          timeout: 3000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data)
              resolve(parsed?.value?.ready === true)
            } catch {
              resolve(false)
            }
          })
        },
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  private async startAndWait(): Promise<void> {
    const appium = this.appiumResolver()
    const child = spawn(appium.command, ['-p', String(this.port), '--relaxed-security', '--log-no-colors'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process = child
    this.managed = true

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(`${APPIUM_PREFIX} Appium not found. ${formatAppiumInstallGuidance()}`)
      } else {
        console.error(`${APPIUM_PREFIX} Error: ${err.message}`)
      }
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.logLevel !== 'debug') return
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        console.log(`${APPIUM_PREFIX} ${pc.dim(line)}`)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.logLevel !== 'debug') return
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        console.error(`${APPIUM_PREFIX} ${pc.dim(line)}`)
      }
    })

    const start = Date.now()
    while (Date.now() - start < this.startupTimeoutMs) {
      const ok = await this.checkStatus()
      if (ok) {
        this.ready = true
        console.log(`${APPIUM_PREFIX} ${pc.green(`started on :${this.port}`)}`)
        return
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs))
    }

    // Timeout — kill and throw
    if (child.pid) {
      treeKill(child.pid, 'SIGKILL', () => {})
    }
    this.process = null
    this.managed = false
    throw new Error(`Appium server did not become ready within ${this.startupTimeoutMs}ms`)
  }

  private performShutdown(): void {
    if (this.process?.pid && this.managed) {
      treeKill(this.process.pid, 'SIGKILL', () => {})
      console.log(`${APPIUM_PREFIX} ${pc.yellow('stopped')}`)
    }
    this.process = null
    this.ready = false
    this.managed = false
  }

  private maybeShutdownAfterRelease(): void {
    if (this.getRefCount() > 0) {
      console.log(`${APPIUM_PREFIX} server kept alive leases=${this.getLeaseCount()} managed=${this.managed}`)
      return
    }
    if (this.managed) {
      this.performShutdown()
      return
    }
    if (this.ready) {
      console.log(`${APPIUM_PREFIX} external server left running leases=0 managed=false`)
    }
  }

  shutdown(): void {
    this.anonymousRefCount = 0
    this.leases.clear()
    this.performShutdown()
  }

  getUrl(): string {
    return `http://localhost:${this.port}`
  }

  getPort(): number {
    return this.port
  }

  isManaged(): boolean {
    return this.managed
  }

  getRefCount(): number {
    return this.anonymousRefCount + this.leases.size
  }

  getLeaseCount(): number {
    return this.leases.size
  }

  getLeases(): AppiumLease[] {
    return [...this.leases.values()]
  }

  hasLease(runId: string): boolean {
    return this.leases.has(runId)
  }
}
