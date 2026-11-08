import type { InitUi } from '../init-ui/init-ui.js'
import { createPlainUi } from '../init-ui/plain-ui.js'

export type FakeInitUiEntry =
  | {
      kind: 'banner' | 'intro' | 'step' | 'done' | 'skipped' | 'line' | 'copyable' | 'outro'
      text: string
    }
  | { kind: 'failed'; text: string; command?: string }
  | { kind: 'note'; text: string; lines: string[] }
  | { kind: 'select' | 'multiselect' | 'text'; text: string; answer: unknown }

export type FakeInitUi = InitUi & {
  entries: FakeInitUiEntry[]
  // The lines the plain renderer would have drawn for the same calls.
  output(): string
}

// Questions are answered from `answers` by message, else with their default.
export function fakeInitUi(answers: Record<string, unknown> = {}): FakeInitUi {
  const entries: FakeInitUiEntry[] = []
  let drawn = ''
  const plain = createPlainUi((text) => {
    drawn += text
  })
  const answer = <T>(message: string, fallback: T): T =>
    Object.hasOwn(answers, message) ? (answers[message] as T) : fallback

  return {
    entries,
    output: () => drawn,
    banner: () => {
      entries.push({ kind: 'banner', text: '' })
    },
    intro: (note) => {
      entries.push({ kind: 'intro', text: note })
      plain.intro(note)
    },
    select: async (q) => {
      const value = answer(q.message, q.initialValue)
      entries.push({ kind: 'select', text: q.message, answer: value })
      return value
    },
    multiselect: async (q) => {
      const value = answer(q.message, [...q.initialValues])
      entries.push({ kind: 'multiselect', text: q.message, answer: value })
      return value
    },
    text: async (q) => {
      const value = answer(q.message, q.defaultValue)
      entries.push({ kind: 'text', text: q.message, answer: value })
      return value
    },
    step: (title) => {
      entries.push({ kind: 'step', text: title })
      const line = plain.step(title)
      return {
        done: (text) => {
          entries.push({ kind: 'done', text })
          line.done(text)
        },
        skipped: (text) => {
          entries.push({ kind: 'skipped', text })
          line.skipped(text)
        },
        failed: (reason, command) => {
          const entry = { kind: 'failed' as const, text: reason }
          entries.push(command === undefined ? entry : { ...entry, command })
          line.failed(reason, command)
        },
      }
    },
    note: (title, lines) => {
      entries.push({ kind: 'note', text: title, lines: [...lines] })
      plain.note(title, lines)
    },
    line: (text) => {
      entries.push({ kind: 'line', text })
      plain.line(text)
    },
    copyable: (text) => {
      entries.push({ kind: 'copyable', text })
      plain.copyable(text)
    },
    outro: (text) => {
      entries.push({ kind: 'outro', text })
      plain.outro(text)
    },
  }
}
