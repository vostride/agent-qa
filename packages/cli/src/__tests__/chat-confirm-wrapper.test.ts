// Older `approval_decision` rows stay readable, and nothing writes them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as cliHost from '../composition/local-agent-host.js'

/** Product source with comments removed, so history notes may still name what the code must not. */
function code(...segments: string[]): string {
  return readFileSync(join(__dirname, '..', ...segments), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('the chat confirm is gone from the CLI host and its composition', () => {
  it('the CLI host exports no chat confirm and the composition no bindings for one', () => {
    expect(Object.keys(cliHost)).not.toContain('createChatConfirmPort')
    expect(Object.keys(cliHost)).not.toContain('createTtyConfirmPort')
    const barrel = code('..', '..', 'agent-local', 'src', 'index.ts')
    expect(barrel).not.toContain('ChatConfirmBindings')
    expect(barrel).not.toContain('ChatApprovalDecisionRecord')
    const host = code('composition', 'local-agent-host.ts')
    expect(host).not.toContain('recordStandingApproval')
    expect(host).not.toContain('onDecision')
    expect(host).not.toContain('[y/a/N]')
  })

  it('the composition hands chat no grant mint and no decision sink', () => {
    const composition = code('..', '..', 'agent-local', 'src', 'composition', 'compose-local-agent.ts')
    expect(composition).not.toContain('ChatConfirmBindings')
    expect(composition).not.toContain('recordStandingApproval')
    expect(composition).not.toMatch(/\bchatConfirm\b/)
  })

  it('no CLI or composition source appends an approval_decision row', () => {
    for (const source of [
      code('composition', 'local-agent-host.ts'),
      code('commands', 'chat.ts'),
      code('..', '..', 'agent-local', 'src', 'composition', 'compose-local-agent.ts'),
    ]) {
      expect(source).not.toMatch(/kind:\s*['"]approval_decision['"]/)
      expect(source).not.toContain('ChatApprovalDecisionRecord')
    }
  })

  it('leaves no one-form port behind either', () => {
    const source = code('composition', 'local-agent-host.ts')
    expect(source).not.toContain('[y/N]')
    expect(source).not.toContain('[y/a/N]')
  })
})

// The chat command and CLI host are read with comments stripped, so their prose may name the call.
describe('no chat door constructs the chat confirm', () => {
  it('commands/chat.ts neither imports nor calls createChatConfirmPort', () => {
    const chat = code('commands', 'chat.ts')
    expect(chat).toContain('createChatCommand')
    expect(chat).not.toContain('createChatConfirmPort')
    expect(chat).not.toMatch(/chatConfirm\s*:/)
  })

  it('the CLI host forwards no confirm port into the composition', () => {
    const host = code('composition', 'local-agent-host.ts')
    expect(host).toContain('export function composeCliLocalAgent')
    expect(host).not.toMatch(/\bconfirm:\s*input\.confirm\b/)
    expect(host).not.toMatch(/\bchatConfirm:\s*input\.chatConfirm\b/)
  })
})
