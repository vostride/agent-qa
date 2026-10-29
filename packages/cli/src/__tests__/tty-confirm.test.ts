// No terminal confirm: a mutating call without a terminal completes in one call, no stdin read.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { Command } from 'commander'
import type { ComposeLocalAgentInput } from '@vostride/agent-qa-agent-local'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { createFnCommand } from '../commands/fn.js'

import * as cliHost from '../composition/local-agent-host.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
  type ComposeCliLocalAgentInput,
} from '../composition/local-agent-host.js'

/** Product source with comments removed, so history notes may still name what the code must not. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** Every product `.ts` source under one package's `src`, tests excluded. */
function productSources(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.ts$/u.test(entry.name) && !/\.test(?:-d)?\.ts$/u.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

/** A whole config the shipped schema accepts, so the change is measured and not blocked. */
const VALID_CONFIG = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html
use:
  llm: judge
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`

const PROMPT_TEXT = /needs your approval|\[y\/N\]|\[y\/a\/N\]|Proceed\?/u

describe('the CLI binds a confirmation exactly where there is somebody to ask', () => {
  it('the CLI host exports no terminal or chat confirm factory', () => {
    const exported = Object.keys(cliHost)
    expect(exported).not.toContain('createTtyConfirmPort')
    expect(exported).not.toContain('createChatConfirmPort')
    expect(exported).toContain('composeCliLocalAgent')
  })

  it('no prompt text survives in the CLI or the composition sources', () => {
    const scanned = [
      ...productSources(join(__dirname, '..')),
      ...productSources(join(__dirname, '..', '..', '..', 'agent-local', 'src')),
    ]
    expect(scanned.length).toBeGreaterThan(100)
    // The matcher sees the shape the deleted prompt had.
    expect(PROMPT_TEXT.test('agent-qa: fn:x needs your approval. Proceed? [y/N] ')).toBe(true)
    expect(scanned.filter((path) => PROMPT_TEXT.test(code(path)))).toEqual([])
  })

  it('neither composition input can carry a confirm port', () => {
    type CliKeys = keyof ComposeCliLocalAgentInput
    type LocalKeys = keyof ComposeLocalAgentInput
    expectTypeOf<'confirm' extends CliKeys ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'chatConfirm' extends CliKeys ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'confirm' extends LocalKeys ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'chatConfirm' extends LocalKeys ? true : false>().toEqualTypeOf<false>()
    // The source half: the composition declares no confirm input and its barrel exports no
    // confirm contract.
    const barrel = code(join(__dirname, '..', '..', '..', 'agent-local', 'src', 'index.ts'))
    expect(barrel).not.toContain('ChatConfirmBindings')
    const composition = code(join(
      __dirname, '..', '..', '..', 'agent-local', 'src', 'composition', 'compose-local-agent.ts',
    ))
    expect(composition).not.toMatch(/\breadonly confirm\?:/)
    expect(composition).not.toMatch(/\breadonly chatConfirm\?:/)
  })

  it('without a terminal, a mutating call completes in one call and reads no stdin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tty-confirm-one-call-'))
    try {
      const configPath = join(root, 'agent-qa.config.yaml')
      writeFileSync(configPath, VALID_CONFIG)
      const listeners = (): number[] =>
        ['data', 'readable', 'keypress', 'end'].map((event) => process.stdin.listenerCount(event))
      const before = listeners()
      const host = composeCliLocalAgent({ agentQaRoot: join(root, '.agent-qa'), configPath })
      try {
        const answer = await invokeFunction(host.registry, 'config.field.set', {
          path: 'use.timeout.step', value: '45s',
        }, CLI_FUNCTION_CALLER) as { outcome: string }
        expect(answer, JSON.stringify(answer)).toMatchObject({ outcome: 'applied' })
      } finally {
        await host.close()
      }
      expect(listeners()).toEqual(before)
      expect(readFileSync(configPath, 'utf8')).toContain('step: 45s')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The same one-call claim through the real `agent-qa fn` door, with stdin not a terminal.
  it('`agent-qa fn` applies a change without a terminal, in one call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tty-confirm-fn-door-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = process.exitCode
    try {
      const configPath = join(root, 'agent-qa.config.yaml')
      writeFileSync(configPath, VALID_CONFIG)
      writeFileSync(join(root, '.env.secrets.local'), '')
      expect(process.stdin.isTTY === true).toBe(false)
      const before = ['data', 'readable', 'keypress'].map((event) => process.stdin.listenerCount(event))
      const program = new Command().option('--config <path>').addCommand(createFnCommand())
      program.exitOverride()
      await program.parseAsync([
        'node', 'agent-qa', '--config', configPath, 'fn', 'config.field.set', '--json',
        '--input', JSON.stringify({ path: 'use.timeout.step', value: '45s' }),
      ])
      expect(error.mock.calls).toEqual([])
      expect(process.exitCode ?? 0).toBe(0)
      expect(readFileSync(configPath, 'utf8')).toContain('step: 45s')
      expect(['data', 'readable', 'keypress'].map((event) => process.stdin.listenerCount(event)))
        .toEqual(before)
    } finally {
      process.exitCode = exitCode
      log.mockRestore()
      error.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is bound by neither this host nor the daemon composition', () => {
    const daemonHost = code(join(__dirname, '..', 'daemon', 'host.ts'))
    expect(daemonHost).not.toContain('confirm:')
    expect(daemonHost).not.toContain('createTtyConfirmPort')
    const cliComposition = code(join(__dirname, '..', 'composition', 'local-agent-host.ts'))
    expect(cliComposition).toContain('export function composeCliLocalAgent')
    expect(cliComposition).not.toContain('createTtyConfirmPort')
    expect(cliComposition).not.toMatch(/\bconfirm:/)
  })

  it('is bound by no run door', () => {
    const run = code(join(__dirname, '..', 'commands', 'run.ts'))
    expect(run).toContain('createRunCommand')
    expect(run).not.toContain('createTtyConfirmPort')
  })
})

// No line of a declared target name can reach a person as an approval question.
describe('a hostile declared target name cannot author a line on the confirm channel', () => {
  it('there is no confirm channel: the host carries no disclosure writer and no question', () => {
    const host = code(join(__dirname, '..', 'composition', 'local-agent-host.ts'))
    expect(host).not.toContain('writeDisclosure')
    expect(host).not.toContain('createInterface')
    expect(host).not.toMatch(PROMPT_TEXT)
  })
})
