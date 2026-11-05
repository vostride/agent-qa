import { spawn } from 'node:child_process'

import {
  CANCEL_METHOD,
  MAX_MESSAGE_BYTES,
  PROGRESS_METHOD,
  ProgressParamsSchema,
  createLineDecoder,
  encodeMessage,
  type ProgressParams,
} from '@vostride/agent-qa-plugin-kit/protocol'

import { pluginEnvironment } from './environment.js'

export interface PluginProcessInput {
  entryFile: string
  cwd: string
  mask: (text: string) => string
  debugLog?: (line: string) => void
  onProgress?: (progress: ProgressParams) => void
  cancelGraceMs: number
  killAfterMs: number
}

export type PluginCallOutcome =
  | { status: 'result'; result: unknown; cancelled: boolean }
  | { status: 'error'; code: number; message: string; data: unknown; cancelled: boolean }
  | { status: 'silent' }
  | { status: 'exited' }

export type PluginLateAnswer = Extract<PluginCallOutcome, { status: 'result' | 'error' }>

export interface PluginRequestOptions {
  timeoutMs: number
  onProgress?: (progress: ProgressParams) => void
  // An answer that arrives after the grace, when the call has already been given up on.
  onLate?: (answer: PluginLateAnswer) => void
}

export interface PluginProcess {
  readonly pid: number | undefined
  readonly exited: Promise<void>
  request(
    method: string,
    params: unknown,
    options: PluginRequestOptions,
  ): Promise<PluginCallOutcome>
  stop(killAfterMs?: number): Promise<void>
}

interface Pending {
  settle: (outcome: PluginCallOutcome) => void
  cancelled: boolean
  options: PluginRequestOptions
  timers: ReturnType<typeof setTimeout>[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function startPluginProcess(input: PluginProcessInput): PluginProcess {
  const child = spawn(process.execPath, [input.entryFile], {
    cwd: input.cwd,
    env: pluginEnvironment(process.env, process.platform),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  })
  const debug = (line: string): void => {
    if (input.debugLog !== undefined && line.trim() !== '') input.debugLog(input.mask(line))
  }

  let gone = false
  const pending = new Map<number, Pending>()
  const late = new Map<number, (answer: PluginLateAnswer) => void>()
  let nextId = 0

  const exited = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (gone) return
      gone = true
      for (const [id, call] of pending) {
        pending.delete(id)
        for (const timer of call.timers) clearTimeout(timer)
        call.settle({ status: 'exited' })
      }
      late.clear()
      resolve()
    }
    child.once('exit', finish)
    child.once('error', (error) => {
      debug(`plugin process error: ${error.message}`)
      finish()
    })
  })

  child.stdin.on('error', () => {})

  const send = (message: unknown): void => {
    if (gone || child.stdin.destroyed || child.stdin.writableEnded) return
    child.stdin.write(encodeMessage(message))
  }

  const answer = (id: number, message: Record<string, unknown>): void => {
    const call = pending.get(id)
    const error = message.error
    const outcome: PluginLateAnswer = isRecord(error)
      ? {
          status: 'error',
          code: typeof error.code === 'number' ? error.code : 0,
          message: typeof error.message === 'string' ? error.message : '',
          data: error.data,
          cancelled: call?.cancelled ?? true,
        }
      : { status: 'result', result: message.result, cancelled: call?.cancelled ?? true }
    if (call !== undefined) {
      pending.delete(id)
      for (const timer of call.timers) clearTimeout(timer)
      call.settle(outcome)
      return
    }
    const onLate = late.get(id)
    if (onLate !== undefined) {
      late.delete(id)
      onLate(outcome)
    }
  }

  const progress = (params: unknown): void => {
    const parsed = ProgressParamsSchema.safeParse(params)
    if (!parsed.success) return
    const id = parsed.data.id
    const call = typeof id === 'number' ? pending.get(id) : undefined
    call?.options.onProgress?.(parsed.data)
    input.onProgress?.(parsed.data)
  }

  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine(line) {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        debug(`plugin stdout: ${line}`)
        return
      }
      if (!isRecord(message)) return
      if (message.method === PROGRESS_METHOD) {
        progress(message.params)
        return
      }
      if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        answer(message.id, message)
      }
    },
    onOverflow() {
      debug('plugin stdout: a line over the message size limit was dropped')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  child.stdout.on('end', () => decoder.end())

  let stderrRest = ''
  child.stderr.on('data', (chunk: Buffer) => {
    const lines = (stderrRest + chunk.toString('utf8')).split('\n')
    stderrRest = lines.pop() ?? ''
    for (const line of lines) debug(line.replace(/\r$/, ''))
  })
  child.stderr.on('end', () => {
    if (stderrRest !== '') debug(stderrRest)
    stderrRest = ''
  })

  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill()
      else process.kill(-pid, signal)
    } catch {
      // The group is already gone.
    }
  }

  const exitsWithin = async (ms: number): Promise<boolean> => {
    if (gone) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    const result = await Promise.race([exited.then(() => true as const), timedOut])
    clearTimeout(timer)
    return result
  }

  return {
    pid: child.pid,
    exited,
    request(method, params, options) {
      if (gone) return Promise.resolve({ status: 'exited' })
      nextId += 1
      const id = nextId
      return new Promise<PluginCallOutcome>((settle) => {
        const call: Pending = { settle, cancelled: false, options, timers: [] }
        pending.set(id, call)
        call.timers.push(
          setTimeout(() => {
            if (!pending.has(id)) return
            call.cancelled = true
            send({ jsonrpc: '2.0', method: CANCEL_METHOD, params: { id } })
            call.timers.push(
              setTimeout(() => {
                if (!pending.has(id)) return
                pending.delete(id)
                if (options.onLate !== undefined) late.set(id, options.onLate)
                settle({ status: 'silent' })
              }, input.cancelGraceMs),
            )
          }, options.timeoutMs),
        )
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    async stop(killAfterMs = input.killAfterMs) {
      if (!child.stdin.destroyed) child.stdin.end()
      if (await exitsWithin(killAfterMs)) {
        // A grandchild the plugin started can outlive it in its group.
        signalGroup('SIGTERM')
        return
      }
      signalGroup('SIGTERM')
      if (await exitsWithin(killAfterMs)) return
      signalGroup('SIGKILL')
      await exitsWithin(killAfterMs)
    },
  }
}
