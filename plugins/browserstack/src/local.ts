import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginError, type PluginProgress } from '@vostride/agent-qa-plugin-kit'
import { Local } from 'browserstack-local'

const STOP_BOUND_MS = 3_000

export interface TunnelRequest {
  accessKey: string
  identifier: string
  binary: string | undefined
}

export interface RunningTunnel {
  stop(): Promise<void>
}

export interface TunnelFactory {
  start(request: TunnelRequest): Promise<RunningTunnel>
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
    if (request.binary !== undefined) {
      // After a failed run the wrapper deletes its binary and retries; the user's own must stay.
      ;(local as unknown as { retriesLeft: number }).retriesLeft = 0
    }
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

function startFailure(error: unknown, accessKey: string): PluginError {
  if (error instanceof PluginError) return error
  const text = error instanceof Error ? error.message : String(error)
  const shown = accessKey === '' ? text : text.split(accessKey).join('***')
  return new PluginError(`BrowserStack Local did not start: ${shown}`, {
    kind: 'unreachable',
    path: 'local',
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
  let starting: Promise<RunningTunnel> | undefined
  let stopped = false
  let connected = false

  const start = (): Promise<RunningTunnel> => {
    if (starting !== undefined) return starting
    const attempt = Promise.resolve()
      .then(() =>
        input.factory.start({
          accessKey: input.accessKey,
          identifier: identifier as string,
          binary: input.localBinary,
        }),
      )
      .catch((error: unknown) => {
        throw startFailure(error, input.accessKey)
      })
    starting = attempt
    // A failed start is not kept, so the next acquire tries again.
    attempt.then(
      () => {
        connected = true
      },
      () => {
        if (starting === attempt) starting = undefined
      },
    )
    return attempt
  }

  return {
    identifier,

    async ensure(signal, progress) {
      if (!input.local) return
      if (stopped) {
        throw new PluginError('BrowserStack Local was already stopped for this run.', {
          kind: 'unreachable',
          path: 'local',
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
      await bounded(pending.then((tunnel) => tunnel.stop()), STOP_BOUND_MS)
    },
  }
}
