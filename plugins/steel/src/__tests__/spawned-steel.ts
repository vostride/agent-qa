import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createLineDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from '@vostride/agent-qa-plugin-kit/protocol'

const ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url))

export interface RpcErrorData {
  kind?: string
  path?: string
  handle?: unknown
}

export interface RpcAnswer {
  result?: unknown
  error?: { code: number; message: string; data?: RpcErrorData }
}

export interface RpcNotification {
  method: string
  params?: Record<string, unknown>
}

export interface SpawnedSteel {
  request(method: string, params?: unknown): { id: number; answer: Promise<RpcAnswer> }
  call(method: string, params?: unknown): Promise<RpcAnswer>
  notify(method: string, params?: unknown): void
  notifications(): RpcNotification[]
  nextNotification(): Promise<RpcNotification>
  stderr(): string
  close(): Promise<void>
}

export function spawnSteelPlugin(): SpawnedSteel {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (answer: RpcAnswer) => void>()
  const notifications: RpcNotification[] = []
  let notified: (() => void) | undefined
  let stderr = ''
  let next = 0
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      const message = JSON.parse(line) as RpcAnswer & Partial<RpcNotification> & { id?: number }
      if (typeof message.method === 'string') {
        notifications.push({
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        })
        notified?.()
        return
      }
      if (typeof message.id !== 'number') return
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    },
    onOverflow: () => {
      throw new Error('the plugin wrote an oversized line')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const send = (message: Record<string, unknown>) => child.stdin.write(encodeMessage(message))
  const request = (method: string, params?: unknown) => {
    next += 1
    const id = next
    const answer = new Promise<RpcAnswer>((resolve) => waiting.set(id, resolve))
    send({ jsonrpc: '2.0', id, method, params })
    return { id, answer }
  }
  return {
    request,
    call: (method, params) => request(method, params).answer,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    notifications: () => [...notifications],
    nextNotification() {
      const seen = notifications.length
      return new Promise<RpcNotification>((resolve) => {
        notified = () => {
          const found = notifications[seen]
          if (found === undefined) return
          notified = undefined
          resolve(found)
        }
      })
    },
    stderr: () => stderr,
    close() {
      child.stdin.end()
      return exited
    },
  }
}

export async function initializeSteel(plugin: SpawnedSteel, options: Record<string, unknown>) {
  return plugin.call('initialize', {
    protocolVersions: [1],
    host: {
      pid: process.pid,
      agentQaVersion: '0.0.0',
      playwrightVersion: 'unknown',
      webdriverioVersion: 'unknown',
    },
    entry: 'steel',
    options,
  })
}
