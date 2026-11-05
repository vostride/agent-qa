import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createLineDecoder, encodeMessage, MAX_MESSAGE_BYTES } from '../protocol/index.js'
import { writeScriptedPlugin, type ScriptedPluginInput } from '../testing/index.js'

export interface RpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

export interface SentRequest {
  id: number
  answered: Promise<RpcMessage>
}

export interface HostIdentity {
  pid: number
  agentQaVersion: string
  playwrightVersion: string
  webdriverioVersion: string
}

export interface SpawnedPlugin {
  dir: string
  entry: string
  ledgerFile: string
  send(method: string, params?: unknown): SentRequest
  request(method: string, params?: unknown): Promise<RpcMessage>
  notify(method: string, params?: unknown): void
  initialize(
    options?: Record<string, unknown>,
    protocolVersions?: number[],
    host?: HostIdentity,
  ): Promise<RpcMessage>
  writeRaw(text: string): void
  takeUnaddressed(): RpcMessage[]
  stdoutLines(): string[]
  stderr(): string
  ledger(): Record<string, unknown>[]
  signal(name: NodeJS.Signals): void
  exited: Promise<number | null>
  close(): Promise<number | null>
  kill(): void
}

const created: SpawnedPlugin[] = []

export function hostIdentity(pid = process.pid): HostIdentity {
  return {
    pid,
    agentQaVersion: '0.0.0',
    playwrightVersion: 'unknown',
    webdriverioVersion: 'unknown',
  }
}

export async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`nothing arrived within ${timeoutMs} ms`)
    await sleep(20)
  }
}

export function spawnScriptedPlugin(input?: ScriptedPluginInput): SpawnedPlugin {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-plugin-kit-'))
  const ledgerFile = join(dir, 'ledger.jsonl')
  const { entry } = writeScriptedPlugin(dir, input)
  const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<string | number, (message: RpcMessage) => void>()
  const unaddressed: RpcMessage[] = []
  const lines: string[] = []
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      lines.push(line)
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch {
        return
      }
      const id = message.id
      const resolve = id === null || id === undefined ? undefined : waiting.get(id)
      if (resolve !== undefined && id !== null && id !== undefined) {
        waiting.delete(id)
        resolve(message)
        return
      }
      unaddressed.push(message)
    },
    onOverflow: () => {
      throw new Error('the plugin wrote an oversized line')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  let next = 0

  const plugin: SpawnedPlugin = {
    dir,
    entry,
    ledgerFile,
    exited,
    send(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcMessage>((resolve, reject) => {
        waiting.set(id, resolve)
        void exited.then((code) =>
          reject(new Error(`the plugin exited with ${code} before answering ${method}: ${stderr}`)),
        )
      })
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return { id, answered }
    },
    request(method, params) {
      return plugin.send(method, params).answered
    },
    notify(method, params) {
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }))
    },
    initialize(options = {}, protocolVersions = [1], host = hostIdentity()) {
      return plugin.request('initialize', {
        protocolVersions,
        host,
        entry: 'lab',
        options: { ledgerFile, ...options },
      })
    },
    writeRaw(text) {
      child.stdin.write(text)
    },
    takeUnaddressed() {
      return unaddressed.splice(0)
    },
    stdoutLines() {
      return [...lines]
    },
    stderr() {
      return stderr
    },
    ledger() {
      if (!existsSync(ledgerFile)) return []
      return readFileSync(ledgerFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    signal(name) {
      child.kill(name)
    },
    close() {
      child.stdin.end()
      return exited
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
  created.push(plugin)
  return plugin
}

export function stopSpawnedPlugins(): void {
  for (const plugin of created.splice(0)) plugin.kill()
}
