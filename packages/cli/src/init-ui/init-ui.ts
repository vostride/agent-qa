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

// A section's status is drawn on every row, not only under the cursor.
export interface InitSectionChoice<T> {
  value: T
  label: string
  status: string
}

export interface InitSection<T> {
  heading: string
  options: readonly InitSectionChoice<T>[]
}

export interface InitUi {
  banner(): void
  intro(): void
  // The initial value is matched by identity, so it must be one of the options' own values; a
  // heading is never chosen.
  select<T>(q: {
    message: string
    sections: readonly InitSection<T>[]
    initialValue: T
  }): Promise<T>
  multiselect<T>(q: {
    message: string
    options: readonly InitChoice<T>[]
    initialValues: readonly T[]
    required?: boolean
  }): Promise<T[]>
  step(title: string): InitStepLine
  note(title: string, lines: readonly string[]): void
  line(text: string): void
  // Drawn flush left, without the rail's gutter, so the line pastes as it is.
  copyable(text: string): void
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
