// init draws everything it shows a person through this seam, so stdout stays free for documents.

export interface InitStepLine {
  done(text: string): void
  skipped(text: string): void
  failed(reason: string, command?: string): void
}

export interface InitChoice<T> {
  value: T
  label: string
  hint?: string
}

export interface InitUi {
  banner(): void
  intro(note: string): void
  select<T>(q: {
    message: string
    options: readonly InitChoice<T>[]
    initialValue: T
    maxItems?: number
  }): Promise<T>
  multiselect<T>(q: {
    message: string
    options: readonly InitChoice<T>[]
    initialValues: readonly T[]
    required?: boolean
  }): Promise<T[]>
  text(q: { message: string; defaultValue: string; signal?: AbortSignal }): Promise<string>
  step(title: string): InitStepLine
  note(title: string, lines: readonly string[]): void
  line(text: string): void
  outro(text: string): void
}

export type InitUiMode = 'interactive' | 'rail' | 'plain'

// The rail needs a person at a terminal; --yes keeps the look and asks nothing.
export function initUiMode(options: {
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  ci: boolean
  yes: boolean
  json: boolean
}): InitUiMode {
  const { stdinIsTTY, stdoutIsTTY, ci, yes, json } = options
  if (json || ci || !stdinIsTTY || !stdoutIsTTY) return 'plain'
  return yes ? 'rail' : 'interactive'
}
