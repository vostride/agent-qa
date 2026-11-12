import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const builtEntry = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js'),
).href

// Starts the bundled server, prints the pid and APPIUM_HOME its spawn was given, and ends by
// returning, with no stop() and no process.exit.
const HOST = `
import { spawn } from 'node:child_process'
import { startAppiumServer } from ${JSON.stringify(builtEntry)}

let started
await startAppiumServer({
  spawn(command, args, options) {
    const child = spawn(command, [...args], options)
    started = { pid: child.pid, home: options.env.APPIUM_HOME }
    return child
  },
})
console.log(JSON.stringify(started))
`

interface Server {
  readonly pid: number
  readonly home: string
}

const hosts: ChildProcess[] = []
let server: Server | undefined

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 20))
  }
  return done()
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.kill('SIGKILL')
  if (server !== undefined) {
    if (isRunning(server.pid)) process.kill(server.pid, 'SIGKILL')
    rmSync(server.home, { recursive: true, force: true })
    server = undefined
  }
})

describe('a process that started the bundled server', () => {
  it('leaves no server process and no home when it ends without stopping the server', async () => {
    const host = spawn(process.execPath, ['--input-type=module', '--eval', HOST], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    hosts.push(host)
    let printed = ''
    let errors = ''
    let exitCode: number | null | undefined
    host.stdout?.on('data', (chunk: Buffer) => {
      printed += chunk.toString('utf8')
    })
    host.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8')
    })
    host.once('close', (code) => {
      exitCode = code
    })

    await waitUntil(() => printed.includes('\n') || exitCode !== undefined, 60_000)
    expect(printed, errors).toMatch(/^\{.+\}\n/u)
    const started = JSON.parse(printed.split('\n')[0]) as Server
    server = started

    const ended = await waitUntil(() => exitCode !== undefined, 15_000)
    expect(ended, 'the process that started the server did not end by itself').toBe(true)
    expect(exitCode, errors).toBe(0)
    const endedAt = Date.now()
    const gone = await waitUntil(() => !isRunning(started.pid), 10_000)
    expect(gone, 'the server process is still running').toBe(true)
    const goneAfter = Date.now() - endedAt
    expect(existsSync(started.home), 'the prepared home is still there').toBe(false)
    console.log(
      `server pid ${started.pid}: the process that started it ended by itself with code ${exitCode}, and the pid was gone ${goneAfter}ms later`,
    )
  }, 90_000)
})
