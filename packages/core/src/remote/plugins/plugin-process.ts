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
  // Called once, at the first stdout line that is not a protocol message.
  onStray?: () => void
  cancelGraceMs: number
  killAfterMs: number
}

// `stderr` is the first stderr line that is not a Node runtime warning, masked, written while the
// call was open.
export type PluginCallOutcome =
  | { status: 'result'; result: unknown; cancelled: boolean }
  | {
      status: 'error'
      code: number
      message: string
      data: unknown
      cancelled: boolean
      stderr?: string
    }
  | { status: 'silent' }
  | { status: 'exited'; stderr?: string }
  | { status: 'stray' }

export type PluginLateAnswer = Extract<PluginCallOutcome, { status: 'result' | 'error' }>

export interface PluginRequestOptions {
  timeoutMs: number
  // In place of the process's own cancel grace, such as what a signal's bound leaves.
  cancelGraceMs?: number
  onProgress?: (progress: ProgressParams) => void
  // An answer that arrives after the grace, when the call has already been given up on.
  onLate?: (answer: PluginLateAnswer) => void
}

export interface PluginProcess {
  readonly pid: number | undefined
  readonly exited: Promise<void>
  // The first stderr line that is not a Node runtime warning, masked, since the last request was
  // sent.
  readonly stderrLine: string | undefined
  request(
    method: string,
    params: unknown,
    options: PluginRequestOptions,
  ): Promise<PluginCallOutcome>
  // stdin closes; after killAfterMs whatever is left of the group gets SIGTERM, then SIGKILL
  // after termMs, even when the plugin itself has exited.
  stop(killAfterMs?: number, termMs?: number): Promise<void>
}

interface Pending {
  settle: (outcome: PluginCallOutcome) => void
  cancelled: boolean
  options: PluginRequestOptions
  timers: ReturnType<typeof setTimeout>[]
  stderr?: string
  // An error answer with no message, held briefly for the stderr line that explains it.
  awaiting?: PluginLateAnswer
}

// After exit, how long stdout and stderr may take to deliver what the plugin wrote last.
const STDIO_DRAIN_MS = 250
// stderr and stdout are separate pipes, so a reason logged before an answer can arrive after it.
const STDERR_REASON_WAIT_MS = 150
// How often a stop looks for the plugin's group after SIGTERM.
const GROUP_POLL_MS = 50
// Node's own runtime warnings, such as a dependency's deprecation, never explain a failure.
const NODE_WARNING_LINE =
  /^\(node:\d+\) |^\(Use `[^`]* --trace-[a-z-]+ [^`]*` to show where the warning was created\)$/

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
  let finished = false
  let strayed = false
  let stderrLine: string | undefined
  const pending = new Map<number, Pending>()
  const late = new Map<number, (answer: PluginLateAnswer) => void>()
  let nextId = 0

  const exited = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (finished) return
      finished = true
      gone = true
      const outcome: PluginCallOutcome = {
        status: 'exited',
        ...(stderrLine === undefined ? {} : { stderr: stderrLine }),
      }
      for (const [id, call] of pending) {
        if (call.awaiting !== undefined) {
          finishCall(id, call, call.awaiting)
          continue
        }
        pending.delete(id)
        for (const timer of call.timers) clearTimeout(timer)
        call.settle(outcome)
      }
      late.clear()
      resolve()
    }
    child.once('exit', () => {
      gone = true
      setTimeout(finish, STDIO_DRAIN_MS)
    })
    child.once('close', finish)
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

  const finishCall = (id: number, call: Pending, outcome: PluginLateAnswer): void => {
    pending.delete(id)
    for (const timer of call.timers) clearTimeout(timer)
    call.settle(
      outcome.status === 'error' && call.stderr !== undefined
        ? { ...outcome, stderr: call.stderr }
        : outcome,
    )
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
      const unexplained =
        outcome.status === 'error' && outcome.message.trim() === '' && call.stderr === undefined
      if (unexplained) {
        for (const timer of call.timers) clearTimeout(timer)
        call.awaiting = outcome
        call.timers = [setTimeout(() => finishCall(id, call, outcome), STDERR_REASON_WAIT_MS)]
        return
      }
      finishCall(id, call, outcome)
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

  // Anything on stdout that is not a protocol message gives up every open call; an answer that
  // still follows goes to its call's late handler.
  const stray = (line: string): void => {
    debug(`plugin stdout: ${line}`)
    if (strayed) return
    strayed = true
    for (const [id, call] of pending) {
      pending.delete(id)
      for (const timer of call.timers) clearTimeout(timer)
      if (call.options.onLate !== undefined) late.set(id, call.options.onLate)
      call.settle({ status: 'stray' })
    }
    input.onStray?.()
  }

  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine(line) {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        stray(line)
        return
      }
      if (!isRecord(message) || message.jsonrpc !== '2.0') {
        stray(line)
        return
      }
      if (message.method === PROGRESS_METHOD) {
        progress(message.params)
        return
      }
      if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        answer(message.id, message)
      }
    },
    onOverflow() {
      stray('a line over the message size limit')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  child.stdout.on('end', () => decoder.end())

  const logLine = (raw: string): void => {
    const line = input.mask(raw.replace(/\r$/, ''))
    if (line.trim() === '') return
    input.debugLog?.(line)
    if (NODE_WARNING_LINE.test(line.trim())) return
    stderrLine ??= line.trim()
    for (const [id, call] of pending) {
      if (call.stderr !== undefined) continue
      call.stderr = line.trim()
      if (call.awaiting !== undefined) finishCall(id, call, call.awaiting)
    }
  }
  let stderrRest = ''
  child.stderr.on('data', (chunk: Buffer) => {
    const lines = (stderrRest + chunk.toString('utf8')).split('\n')
    stderrRest = lines.pop() ?? ''
    for (const line of lines) logLine(line)
  })
  child.stderr.on('end', () => {
    if (stderrRest !== '') logLine(stderrRest)
    stderrRest = ''
  })

  // Two stops can overlap, such as a signal's kill and a stop already under way; each signal
  // still reaches the group once.
  const signalled = new Set<NodeJS.Signals>()
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined || signalled.has(signal)) return
    signalled.add(signal)
    try {
      if (process.platform === 'win32') child.kill()
      else process.kill(-pid, signal)
    } catch {
      // The group is already gone.
    }
  }

  // A grandchild the plugin started stays in its group after the plugin itself exits.
  const groupAlive = (): boolean => {
    const pid = child.pid
    if (pid === undefined || process.platform === 'win32') return !gone
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  const groupGoneWithin = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (groupAlive()) {
      const remaining = until - Date.now()
      if (remaining <= 0) return false
      await new Promise((resolve) => setTimeout(resolve, Math.min(GROUP_POLL_MS, remaining)))
    }
    return true
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
    get stderrLine() {
      return stderrLine
    },
    request(method, params, options) {
      if (strayed) return Promise.resolve({ status: 'stray' })
      if (gone) return Promise.resolve({ status: 'exited' })
      nextId += 1
      const id = nextId
      stderrLine = undefined
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
              }, options.cancelGraceMs ?? input.cancelGraceMs),
            )
          }, options.timeoutMs),
        )
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    async stop(killAfterMs = input.killAfterMs, termMs = killAfterMs) {
      if (!child.stdin.destroyed) child.stdin.end()
      await exitsWithin(killAfterMs)
      if (!groupAlive()) return
      signalGroup('SIGTERM')
      if (await groupGoneWithin(termMs)) return
      signalGroup('SIGKILL')
      await exitsWithin(termMs)
    },
  }
}
