// The terminal confirmation, and the two hosts that differed over it (Phase 391, PROP-01).
//
// 391 gave the v48 gate's ask ladder its first host binding: a `[y/N]` prompt the CLI bound when
// both of its streams were a terminal, and that the daemon never bound.
//
// 2026-10-01, 432-16 (D-14/D-15): THE PROMPT IS DELETED. Since 432-13 no gate asked and no door
// built it; now `createTtyConfirmPort`, its disclosure writer and the composition's `confirm` input
// are gone too. The cells that drove the prompt over injected streams are re-spelled as absence:
// no factory, no prompt text in the CLI or the composition, no input field that could carry one,
// and a mutating call without a terminal completes in one call and reads no stdin. No channel
// exists on which a disclosure could be printed.

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
  // RE-SPELLED 2026-10-01 (432-16): was 'binds NOTHING without a terminal — the gate keeps its
  // deny-by-default'. There is no factory left to bind anything, with a terminal or without one.
  it('C432-NO-CONFIRM-PORTS: the CLI host exports no terminal or chat confirm factory', () => {
    const exported = Object.keys(cliHost)
    expect(exported).not.toContain('createTtyConfirmPort')
    expect(exported).not.toContain('createChatConfirmPort')
    expect(exported).toContain('composeCliLocalAgent')
  })

  // RE-SPELLED 2026-10-01 (432-16): was 'answers yes to an explicit yes', 'accepts the long form
  // too' and 'refuses everything else'. Their subject, the prompt, is gone from both packages that
  // composed it.
  it('C432-NO-CONFIRM-PORTS: no prompt text survives in the CLI or the composition sources', () => {
    const scanned = [
      ...productSources(join(__dirname, '..')),
      ...productSources(join(__dirname, '..', '..', '..', 'agent-local', 'src')),
    ]
    expect(scanned.length).toBeGreaterThan(100)
    // The matcher sees the shape the deleted prompt had.
    expect(PROMPT_TEXT.test('agent-qa: fn:x needs your approval. Proceed? [y/N] ')).toBe(true)
    expect(scanned.filter((path) => PROMPT_TEXT.test(code(path)))).toEqual([])
  })

  it('C432-NO-CONFIRM-PORTS: neither composition input can carry a confirm port', () => {
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

  it('C432-NO-CONFIRM-PORTS: without a terminal, a mutating call completes in one call and reads no stdin', async () => {
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

  // 432-16 task 2: the same one-call claim through the real `agent-qa fn` door, with stdin as the
  // test runner leaves it (not a terminal): the change lands and nothing waits for an answer.
  it('C432-NO-CONFIRM-PORTS: `agent-qa fn` applies a change without a terminal, in one call', async () => {
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

  // RE-SPELLED 2026-10-01 (432-16): was 'is bound by THIS host and not by the daemon composition'.
  // Neither host binds one now.
  it('is bound by neither this host nor the daemon composition', () => {
    const daemonHost = code(join(__dirname, '..', 'daemon', 'host.ts'))
    expect(daemonHost).not.toContain('confirm:')
    expect(daemonHost).not.toContain('createTtyConfirmPort')
    const cliComposition = code(join(__dirname, '..', 'composition', 'local-agent-host.ts'))
    expect(cliComposition).toContain('export function composeCliLocalAgent')
    expect(cliComposition).not.toContain('createTtyConfirmPort')
    expect(cliComposition).not.toMatch(/\bconfirm:/)
  })

  // 432-13 (D-01/D-14): `agent-qa run` no longer binds it.
  it('is bound by no run door since 432-13', () => {
    const run = code(join(__dirname, '..', 'commands', 'run.ts'))
    expect(run).toContain('createRunCommand')
    expect(run).not.toContain('createTtyConfirmPort')
  })
})

// ---- THE CHANNEL A PERSON READ (401-15, WR-01 / T-401-G5) ---------------------------------------
//
// RE-SPELLED 2026-10-01 (432-16): these two cells drove a disclosure carrying a forged approval
// line through the prompt and counted the lines that reached the stream. The prompt and its
// `writeDisclosure` are deleted, so no line of a declared target name can reach a person as an
// approval question.
describe('a hostile declared target name cannot author a line on the confirm channel', () => {
  it('there is no confirm channel: the host carries no disclosure writer and no question', () => {
    const host = code(join(__dirname, '..', 'composition', 'local-agent-host.ts'))
    expect(host).not.toContain('writeDisclosure')
    expect(host).not.toContain('createInterface')
    expect(host).not.toMatch(PROMPT_TEXT)
  })
})
