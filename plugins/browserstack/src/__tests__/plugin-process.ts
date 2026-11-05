import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createLineDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from '@vostride/agent-qa-plugin-kit/protocol'

const ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url))

export const USERNAME = 'bs-test-user'
export const ACCESS_KEY = 'bs-test-access-key'
export const RUN_ID = 'run-7'
export const TEST_NAME = 'checkout keeps the cart'

export interface RpcAnswer {
  result?: unknown
  error?: { code: number; message: string; data?: { kind?: string; path?: string } }
}

export interface PluginProcess {
  request(method: string, params?: unknown): { id: number; answered: Promise<RpcAnswer> }
  call(method: string, params?: unknown): Promise<RpcAnswer>
  cancel(id: number): void
  progress(id: number): string[]
  stderr(): string
  close(): Promise<void>
}

export function startPluginProcess(): PluginProcess {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (answer: RpcAnswer) => void>()
  const progress = new Map<number, string[]>()
  let stderr = ''
  let next = 0
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      const message = JSON.parse(line) as RpcAnswer & {
        id?: number
        method?: string
        params?: { id?: number; message?: string }
      }
      if (message.method === '$/progress' && typeof message.params?.id === 'number') {
        const lines = progress.get(message.params.id) ?? []
        lines.push(message.params.message ?? '')
        progress.set(message.params.id, lines)
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
  const request = (method: string, params?: unknown) => {
    next += 1
    const id = next
    const answered = new Promise<RpcAnswer>((resolve) => waiting.set(id, resolve))
    child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
    return { id, answered }
  }
  return {
    request,
    call: (method, params) => request(method, params).answered,
    cancel(id) {
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', method: '$/cancel', params: { id } }))
    },
    progress: (id) => [...(progress.get(id) ?? [])],
    stderr: () => stderr,
    close() {
      child.stdin.end()
      return exited
    },
  }
}

export async function initializePlugin(
  plugin: PluginProcess,
  options: Record<string, unknown>,
  playwrightVersion = 'unknown',
): Promise<RpcAnswer> {
  return plugin.call('initialize', {
    protocolVersions: [1],
    host: {
      pid: process.pid,
      agentQaVersion: '0.0.0',
      playwrightVersion,
      webdriverioVersion: 'unknown',
    },
    entry: 'browserstack',
    options: { username: USERNAME, accessKey: ACCESS_KEY, ...options },
    runFacts: { runId: RUN_ID },
  })
}

export function loopbackOptions(origin: string): Record<string, unknown> {
  return {
    apiUrl: origin,
    appApiUrl: origin,
    hubUrl: `${origin}/wd/hub`,
    playwrightUrl: `${origin.replace(/^http/, 'ws')}/playwright`,
  }
}
