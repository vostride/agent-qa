// `fn`, `ask` and `chat` can run a test in this process, so each stops the process's Appium as it ends.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appium = vi.hoisted(() => ({
  stopWithin: vi.fn<(boundMs: number) => Promise<void> | undefined>(),
}))

vi.mock('../composition/process-appium.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../composition/process-appium.js')>()),
  stopProcessAppiumWithin: appium.stopWithin,
}))

import { createAskCommand } from '../commands/ask.js'
import { createChatCommand } from '../commands/chat.js'
import { createFnCommand } from '../commands/fn.js'
import { REMOTE_RELEASE_BOUND_MS } from '../composition/remote-sessions.js'

const roots: string[] = []
let exitCodeBefore: typeof process.exitCode

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-stops-its-appium-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    })}\n`,
  )
  writeFileSync(join(root, '.env.secrets.local'), '')
  return configPath
}

function run(command: Command, args: readonly string[]): Promise<unknown> {
  const program = new Command().option('--config <path>', 'config file path').addCommand(command)
  program.exitOverride()
  return program.parseAsync(['node', 'agent-qa', '--config', fixtureWorkspace(), ...args])
}

function runFn(args: readonly string[]): Promise<unknown> {
  return run(createFnCommand(), ['fn', ...args])
}

function runAsk(message: string): Promise<unknown> {
  return run(createAskCommand(), ['ask', message])
}

// Every typed line, then the end of input.
function runChat(typed: readonly string[]): Promise<unknown> {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const ended = run(createChatCommand({ input, output }), ['chat'])
  for (const line of typed) input.write(`${line}\n`)
  input.end()
  return ended
}

function held(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// Every promise job queued before this call has run once it settles.
function jobsRun(): Promise<void> {
  return new Promise((settle) => setImmediate(settle))
}

// The command asks for the stop once, within the bound, and has not ended while the stop is pending.
async function endsOnlyOnceTheStopHasSettled(start: () => Promise<unknown>): Promise<void> {
  const stopping = held()
  appium.stopWithin.mockReturnValueOnce(stopping.promise)
  let ended = false

  const ending = start().then(() => {
    ended = true
  })
  await vi.waitFor(() => expect(appium.stopWithin).toHaveBeenCalled(), { timeout: 20_000 })
  await jobsRun()
  expect(ended).toBe(false)

  stopping.resolve()
  await ending
  expect(appium.stopWithin).toHaveBeenCalledExactlyOnceWith(REMOTE_RELEASE_BOUND_MS)
}

beforeEach(() => {
  exitCodeBefore = process.exitCode
  appium.stopWithin.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = exitCodeBefore
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("a command that can run a test in process stops the process's Appium as it ends", () => {
  it('fn ends only once the stop has settled', async () => {
    await endsOnlyOnceTheStopHasSettled(() => runFn(['runs.list', '--json']))

    expect(process.exitCode).toBeUndefined()
  })

  it('fn stops it when the function fails', async () => {
    await runFn(['runs.nope', '--json'])

    expect(process.exitCode).toBe(1)
    expect(appium.stopWithin).toHaveBeenCalledExactlyOnceWith(REMOTE_RELEASE_BOUND_MS)
  })

  it('ask ends only once the stop has settled', async () => {
    await endsOnlyOnceTheStopHasSettled(() => runAsk('/fn runs.list'))
  })

  it('chat ends only once the stop has settled', async () => {
    await endsOnlyOnceTheStopHasSettled(() => runChat(['/fn runs.list', '/quit']))
  })
})
