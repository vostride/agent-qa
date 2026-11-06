import { execFile, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { PluginError, type PluginProgress } from '@vostride/agent-qa-plugin-kit'
import { Local } from 'browserstack-local'

const STOP_BOUND_MS = 3_000
const CHECK_BOUND_MS = 5_000

export interface TunnelRequest {
  accessKey: string
  identifier: string
  binary: string | undefined
}

export interface RunningTunnel {
  stop(): Promise<void>
}

// A start still in flight can be aborted: the plugin may stop before the tunnel connects.
export interface StartingTunnel {
  running: Promise<RunningTunnel>
  abort(): Promise<void>
}

export interface TunnelFactory {
  start(request: TunnelRequest): StartingTunnel
}

interface WrapperState {
  retriesLeft: number
  tunnel?: ChildProcess
  binaryPath?: string
  key?: string
  getBinaryPath(found: (path: string | undefined) => void): void
}

// browserstack-local downloads BrowserStack's Intel build on every Mac, and only a Mac has Rosetta.
export function localBinaryFix(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Install Rosetta (softwareupdate --install-rosetta --agree-to-license) or set localBinary to a binary this machine can run'
  }
  return 'Set localBinary to a binary this machine can run'
}

function wrapperBinary(wrapper: WrapperState, accessKey: string): Promise<string> {
  // A download authenticates with the key, as the wrapper's own start would set it.
  wrapper.key = accessKey
  return new Promise<string>((resolve, reject) => {
    wrapper.getBinaryPath((path) => {
      if (path) {
        resolve(path)
        return
      }
      reject(
        new Error('browserstack-local found no BrowserStack Local binary and could not download one'),
      )
    })
  })
}

// spawnSync returns a spawn failure, such as BrowserStack's Intel build on an Apple Silicon Mac
// without Rosetta, where the wrapper's own launch throws it from a callback no caller can catch.
function cannotRun(binary: string): string | undefined {
  const { error } = spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: CHECK_BOUND_MS })
  if (error === undefined) return undefined
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ETIMEDOUT') return undefined
  return code ?? error.message
}

// The binary's own stop for a daemon by identifier; it runs whatever state the launch reached.
function stopDaemon(binary: string, request: TunnelRequest): Promise<void> {
  const args = ['--daemon', 'stop', '--local-identifier', request.identifier]
  return new Promise<void>((done) => {
    execFile(binary, [...args, '--key', request.accessKey], { timeout: STOP_BOUND_MS }, () =>
      done(),
    )
  })
}

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const

// The wrapper logs the binary's whole command line, --key included, when the binary fails.
function maskConsole(secret: string): () => void {
  if (secret === '') return () => {}
  const originals = CONSOLE_METHODS.map((method) => console[method])
  CONSOLE_METHODS.forEach((method, index) => {
    const original = originals[index] as (...args: unknown[]) => void
    console[method] = (...args: unknown[]) => original(format(...args).split(secret).join('***'))
  })
  return () => {
    CONSOLE_METHODS.forEach((method, index) => {
      console[method] = originals[index] as (...args: unknown[]) => void
    })
  }
}

function localLogFile(): string {
  const name = `agent-qa-browserstack-local-${process.pid}-${randomBytes(4).toString('hex')}.log`
  return join(tmpdir(), name)
}

export const browserStackLocalFactory: TunnelFactory = {
  start(request) {
    const logFile = localLogFile()
    // Created private first; the wrapper only truncates it, so the mode holds.
    writeFileSync(logFile, '', { mode: 0o600 })
    const local = new Local()
    const wrapper = local as unknown as WrapperState
    if (request.binary !== undefined) {
      // After a failed run the wrapper deletes its binary and retries; the user's own must stay.
      wrapper.retriesLeft = 0
    }
    const unmask = maskConsole(request.accessKey)
    let aborted = false
    // The launch waits for the check, so it always runs from this promise and nothing it throws
    // escapes.
    const running = (async (): Promise<RunningTunnel> => {
      const binary = request.binary ?? (await wrapperBinary(wrapper, request.accessKey))
      const failure = cannotRun(binary)
      if (failure !== undefined) {
        throw new Error(
          `this machine cannot run ${binary} (${failure}). ${localBinaryFix(process.platform)} (its log is ${logFile})`,
        )
      }
      if (aborted) throw new Error('it was stopped while it was starting')
      // Its own find, so a launch that fails still deletes it and downloads another, as the
      // wrapper does.
      if (request.binary === undefined) wrapper.binaryPath = binary
      return new Promise<RunningTunnel>((resolve, reject) => {
        local.start(
          {
            key: request.accessKey,
            localIdentifier: request.identifier,
            logFile,
            ...(request.binary === undefined ? {} : { binarypath: request.binary }),
          },
          (error) => {
            if (error) {
              const [first] = error.message.split('\n')
              reject(new Error(`${first} (its log is ${logFile})`))
              return
            }
            resolve({ stop: () => new Promise<void>((done) => local.stop(() => done())) })
          },
        )
      })
    })().finally(unmask)
    return {
      running,
      async abort() {
        aborted = true
        // A killed launch must not be retried with a fresh download.
        wrapper.retriesLeft = 0
        wrapper.tunnel?.kill()
        if (wrapper.binaryPath !== undefined) await stopDaemon(wrapper.binaryPath, request)
      },
    }
  },
}

export interface TunnelManagerInput {
  factory: TunnelFactory
  accessKey: string
  local: boolean
  localIdentifier: string | undefined
  localBinary: string | undefined
}

export interface TunnelManager {
  readonly identifier: string | undefined
  ensure(signal: AbortSignal, progress: (update: PluginProgress) => void): Promise<void>
  stop(): Promise<void>
}

function freshLocalIdentifier(): string {
  return `agent-qa-${randomBytes(8).toString('hex')}`
}

// The tunnel starts from acquire, where a bare path would name a remote setting.
function startFailure(error: unknown, accessKey: string, binarySet: boolean): PluginError {
  if (error instanceof PluginError) return error
  const text = error instanceof Error ? error.message : String(error)
  const shown = accessKey === '' ? text : text.split(accessKey).join('***')
  return new PluginError(`BrowserStack Local did not start: ${shown}`, {
    kind: 'unreachable',
    path: binarySet ? 'options.localBinary' : 'options.local',
  })
}

function bounded(work: Promise<void>, boundMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boundMs)
  })
  return Promise.race([work.catch(() => {}), bound]).finally(() => clearTimeout(timer))
}

export function createTunnelManager(input: TunnelManagerInput): TunnelManager {
  const identifier = input.local
    ? (input.localIdentifier ?? freshLocalIdentifier())
    : input.localIdentifier
  const binarySet = input.localBinary !== undefined
  let starting: StartingTunnel | undefined
  let stopped = false
  let connected = false

  const start = (): Promise<RunningTunnel> => {
    if (starting !== undefined) return starting.running
    let begun: StartingTunnel
    try {
      begun = input.factory.start({
        accessKey: input.accessKey,
        identifier: identifier as string,
        binary: input.localBinary,
      })
    } catch (error) {
      return Promise.reject(startFailure(error, input.accessKey, binarySet))
    }
    const attempt: StartingTunnel = {
      running: begun.running.catch((error: unknown) => {
        throw startFailure(error, input.accessKey, binarySet)
      }),
      abort: () => begun.abort(),
    }
    starting = attempt
    // A failed start is not kept, so the next acquire tries again.
    attempt.running.then(
      () => {
        connected = true
      },
      () => {
        if (starting === attempt) starting = undefined
      },
    )
    return attempt.running
  }

  return {
    identifier,

    async ensure(signal, progress) {
      if (!input.local) return
      if (stopped) {
        throw new PluginError('BrowserStack Local was already stopped for this run.', {
          kind: 'unreachable',
          path: 'options.local',
        })
      }
      signal.throwIfAborted()
      const shared = start()
      if (!connected) progress({ message: 'starting BrowserStack Local' })
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(new Error('the acquire was cancelled while BrowserStack Local was starting'))
        signal.addEventListener('abort', onAbort, { once: true })
        shared.then(
          () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
    },

    async stop() {
      if (stopped) return
      stopped = true
      const pending = starting
      if (pending === undefined) return
      const stopRunning = pending.running.then((tunnel) => tunnel.stop())
      if (connected) {
        await bounded(stopRunning, STOP_BOUND_MS)
        return
      }
      // Still starting: abort the launch, and stop the tunnel too if it connects meanwhile.
      const both = Promise.allSettled([pending.abort(), stopRunning]).then(() => {})
      await bounded(both, STOP_BOUND_MS)
    },
  }
}
