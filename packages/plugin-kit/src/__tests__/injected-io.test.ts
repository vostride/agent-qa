import { describe, expect, it } from 'vitest'
import { definePlugin, z } from '../index.js'
import { startInProcessPlugin } from './in-process-plugin.js'

const plugin = definePlugin({
  options: z.object({}),
  settings: z.object({}),
  serves: ['cdp'],
  acquire: () => ({ handle: { n: 1 }, protocol: 'cdp', url: 'ws://127.0.0.1:9/b' }),
  release: () => {},
})

describe('runPlugin given its own stdout', () => {
  it("leaves the process's console, stdout and signal listeners as they were", async () => {
    const consoleLog = console.log
    const stdoutWrite = process.stdout.write
    const sigterm = process.listenerCount('SIGTERM')
    const sigint = process.listenerCount('SIGINT')

    const running = startInProcessPlugin(plugin)
    expect((await running.initialize()).result).toMatchObject({ serves: ['cdp'] })

    expect(console.log).toBe(consoleLog)
    expect(process.stdout.write).toBe(stdoutWrite)
    expect(process.listenerCount('SIGTERM')).toBe(sigterm)
    expect(process.listenerCount('SIGINT')).toBe(sigint)
    expect(await running.close()).toBe(0)
  })
})
