// RED scaffold (Wave 0, Phase 358 · WM-01 · D-11/D-12 · Pattern 6 · Pitfall 7). Pins the
// run-scoped WorkingMemoryStore + structured turn injection BEFORE Plan 05 lands it. Three
// distinct redaction boundaries (Pitfall 7): VERBATIM in the store and in turn content;
// redactSecretValue at CAPTURE (registered secrets only); mask() only at snapshot/flush
// (tested elsewhere). Latest-wins key overwrite (D-12); whole-set recall (D-11).
//
// RED BY DESIGN: `../working-memory/store` does not exist until Plan 05 — the unresolved
// import IS the intended failure. Pinned API:
//   new WorkingMemoryStore(redactor?)
//     .capture(entries, provenanceCtx?); .entries(): WorkingMemoryEntry[]; .dispose()
import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import type { ScreenState, WorkingMemoryEntry } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import type { SecretRedactorPort } from '../ports.js'
import { composeTurnMessages } from '../prompts.js'
import { buildAgentScreenState } from './screen-fixtures.js'
// Plan-05 working-memory module — intentionally unresolved today (the RED reason for this suite):
import { WorkingMemoryStore } from '../working-memory/store.js'

const OTP = { key: 'otp', value: '4821', kind: 'extracted-value', provenance: 'observation' } satisfies WorkingMemoryEntry

function screen(): ScreenState {
  return buildAgentScreenState({ tree: '- button "Submit" [ref=e1]', elements: [{ ref: 'e1', role: 'button', name: 'Submit', attributes: {} }], metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 } })
}

function context(entries: unknown): StepContext {
  return { stepInstruction: 'Enter the OTP', testName: 'wm test', previousSteps: [], plannerModel: {} as never, verifierModel: {} as never, workingMemory: entries } as unknown as StepContext
}

function renderTurn(messages: ModelMessage[]): string {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')).join(''))).join('\n')
}

describe('WorkingMemoryStore — capture + latest-wins recall', () => {
  it('stores structured entries and re-capturing a key replaces its value (one key ⇒ one current value)', () => {
    const store = new WorkingMemoryStore()
    store.capture([OTP], { step: 0 })
    store.capture([{ ...OTP, value: '9999' }], { step: 1 }) // OTP resend — latest wins
    const all = store.entries()
    const otpEntries = all.filter((e: { key: string }) => e.key === 'otp')
    expect(otpEntries).toHaveLength(1)
    expect(otpEntries[0].value).toBe('9999')
    expect(all.some((e: { value: string }) => e.value === '4821')).toBe(false)
  })

  it('preserves kind + provenance on captured entries', () => {
    const store = new WorkingMemoryStore()
    store.capture([OTP], { step: 2 })
    const entry = store.entries().find((e: { key: string }) => e.key === 'otp')
    expect(entry).toMatchObject({ key: 'otp', value: '4821', kind: 'extracted-value', provenance: 'observation' })
  })
})

describe('WorkingMemoryStore — redactSecretValue at capture', () => {
  const redactor: SecretRedactorPort = { redactString: (v: string) => v.split('SECRET123').join('[secret]') }

  it('redacts a registered secret at capture; leaves unregistered values verbatim', () => {
    const store = new WorkingMemoryStore(redactor)
    store.capture([{ key: 'token', value: 'Bearer SECRET123', kind: 'extracted-value', provenance: 'toolResult' }], { step: 0 })
    store.capture([{ key: 'name', value: 'Ada Lovelace', kind: 'extracted-value', provenance: 'observation' }], { step: 1 })
    const token = store.entries().find((e: { key: string }) => e.key === 'token')
    const name = store.entries().find((e: { key: string }) => e.key === 'name')
    expect(token?.value).toBe('Bearer [secret]')
    expect(name?.value).toBe('Ada Lovelace')
  })
})

describe('WorkingMemoryStore — run-scoped set + disposal', () => {
  it('entries() returns the whole set (no filtering); dispose() empties the store', () => {
    const store = new WorkingMemoryStore()
    store.capture([OTP, { key: 'file', value: 'report.pdf', kind: 'filename', provenance: 'observation' }], { step: 0 })
    expect(store.entries()).toHaveLength(2)
    store.dispose()
    expect(store.entries()).toHaveLength(0)
  })
})

describe('structured turn injection — verbatim, own turn message, never the cached prefix', () => {
  it('renders entries verbatim (key, value, kind, provenance) as their own turn message', () => {
    const store = new WorkingMemoryStore()
    store.capture([OTP], { step: 0 })
    const turn = renderTurn(composeTurnMessages(context(store.entries()), screen()))
    expect(turn).toContain('otp')
    expect(turn).toContain('4821')
    expect(turn).toContain('extracted-value')
    expect(turn).toContain('observation')
  })

  it('emits no working-memory message when the store is empty', () => {
    const store = new WorkingMemoryStore()
    const messages = composeTurnMessages(context(store.entries()), screen())
    expect(messages.every((m) => renderTurn([m]).trim().length > 0)).toBe(true)
    expect(renderTurn(messages)).not.toContain('Working memory')
  })
})
