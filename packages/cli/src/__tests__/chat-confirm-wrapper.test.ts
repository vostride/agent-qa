// Chat's three-way inline confirm, and the one thing it could never do.
//
// 392 gave chat 391's two decision forms and nothing else: `y` accepted once, `a` accepted and
// recorded a standing approval through the composition's own grants port, anything else refused.
// Every decision was appended to the conversation's log as an `approval_decision` row.
//
// THE CHAT CONFIRM IS DELETED. Since 432-13 no door built it and no
// gate asked; now `createChatConfirmPort`, `ChatConfirmBindings` (its grant mint and its decision
// sink) and the composition's `chatConfirm` input are gone. The cells that drove the three forms
// over injected streams are re-spelled as absence. The historical `approval_decision` rows stay
// readable — `chat-approval-record-census.test.ts` measures that — and no writer of them remains.

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
  // RE-SPELLED 2026-10-01: was 'binds NOTHING without a terminal', 'offers exactly the two
  // forms', 'accepts once on y, minting nothing at all', 'accepts and mints on a' and 'accepts the
  // long forms of both'. There is no wrapper to offer, accept or mint.
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

  // RE-SPELLED 2026-10-01: was 'refuses on N, on an empty line, on nonsense, on EOF',
  // 'keeps the one-time accept when the standing half is refused', '… when the mint THROWS' and
  // 'answers even when the decision sink throws'. Nothing asks, so nothing can refuse, and no grant
  // is minted from chat.
  it('the composition hands chat no grant mint and no decision sink', () => {
    const composition = code('..', '..', 'agent-local', 'src', 'composition', 'compose-local-agent.ts')
    expect(composition).not.toContain('ChatConfirmBindings')
    expect(composition).not.toContain('recordStandingApproval')
    expect(composition).not.toMatch(/\bchatConfirm\b/)
  })

  // RE-SPELLED 2026-10-01: was 'records nothing when the terminal is in no conversation,
  // and still answers'. The session isolation it measured — a decision never lands in another
  // conversation's log — now holds because no decision is written at all; the per-session log
  // attribution itself is still measured by the chat session isolation suites.
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

  // RE-SPELLED 2026-10-01: was 'leaves the shipped one-form port exactly as it was'. Both
  // forms are gone.
  it('leaves no one-form port behind either', () => {
    const source = code('composition', 'local-agent-host.ts')
    expect(source).not.toContain('[y/N]')
    expect(source).not.toContain('[y/a/N]')
  })
})

// no door builds a chat confirm. The chat command and the CLI
// host are read as source, comments stripped, so their own history notes may still name what the
// code must not call.
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
