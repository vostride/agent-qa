import { PassThrough } from 'node:stream'
import type { z } from 'zod'
import type { PluginDefinition } from '../define-plugin.js'
import { encodeMessage } from '../protocol/index.js'
import { runPlugin } from '../run-plugin.js'
import { hostIdentity, type RpcMessage } from './spawned-plugin.js'

export interface InProcessPlugin {
  request(method: string, params?: unknown): Promise<RpcMessage>
  initialize(options?: Record<string, unknown>): Promise<RpcMessage>
  close(): Promise<number>
}

// Runs the stdio loop inside the test process, over its own stdin, stdout and exit.
export function startInProcessPlugin<
  OptionsSchema extends z.ZodType,
  SettingsSchema extends z.ZodType,
>(definition: PluginDefinition<OptionsSchema, SettingsSchema>): InProcessPlugin {
  const stdin = new PassThrough()
  const waiting = new Map<string | number, (message: RpcMessage) => void>()
  let exited: (code: number) => void = () => {}
  const exit = new Promise<number>((resolve) => {
    exited = resolve
  })
  const stdout = {
    write(chunk: string, callback?: (error?: Error | null) => void) {
      for (const line of chunk.split('\n')) {
        if (line === '') continue
        const message = JSON.parse(line) as RpcMessage
        if (message.id !== null && message.id !== undefined) waiting.get(message.id)?.(message)
      }
      callback?.()
      return true
    },
  }
  runPlugin(definition, { stdin, stdout, exit: (code) => exited(code) })
  let next = 0

  const plugin: InProcessPlugin = {
    request(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcMessage>((resolve) => waiting.set(id, resolve))
      stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return answered
    },
    initialize(options = {}) {
      return plugin.request('initialize', {
        protocolVersions: [1],
        host: hostIdentity(),
        entry: 'in-process',
        options,
      })
    },
    close() {
      stdin.end()
      return exit
    },
  }
  return plugin
}
