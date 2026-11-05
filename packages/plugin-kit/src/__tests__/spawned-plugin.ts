import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineDecoder, encodeMessage, MAX_MESSAGE_BYTES } from '../protocol/index.js'
import { writeScriptedPlugin, type ScriptedPluginInput } from '../testing/index.js'

export interface RpcMessage {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

export interface SpawnedPlugin {
  dir: string
  ledgerFile: string
  request(method: string, params?: unknown): Promise<RpcMessage>
  initialize(options?: Record<string, unknown>, protocolVersions?: number[]): Promise<RpcMessage>
  writeRaw(text: string): void
  takeUnaddressed(): RpcMessage[]
  ledger(): Record<string, unknown>[]
  close(): Promise<number | null>
  kill(): void
}

const created: SpawnedPlugin[] = []

export function hostIdentity() {
  return {
    pid: process.pid,
    agentQaVersion: '0.0.0',
    playwrightVersion: 'unknown',
    webdriverioVersion: 'unknown',
  }
}

export function spawnScriptedPlugin(input?: ScriptedPluginInput): SpawnedPlugin {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-plugin-kit-'))
  const ledgerFile = join(dir, 'ledger.jsonl')
  const { entry } = writeScriptedPlugin(dir, input)
  const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<string | number, (message: RpcMessage) => void>()
  const unaddressed: RpcMessage[] = []
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      const message = JSON.parse(line) as RpcMessage
      const resolve = message.id === null ? undefined : waiting.get(message.id)
      if (resolve !== undefined && message.id !== null) {
        waiting.delete(message.id)
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
    ledgerFile,
    request(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcMessage>((resolve, reject) => {
        waiting.set(id, resolve)
        void exited.then((code) =>
          reject(new Error(`the plugin exited with ${code} before answering ${method}: ${stderr}`)),
        )
      })
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return answered
    },
    initialize(options = {}, protocolVersions = [1]) {
      return plugin.request('initialize', {
        protocolVersions,
        host: hostIdentity(),
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
    ledger() {
      return readFileSync(ledgerFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
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
