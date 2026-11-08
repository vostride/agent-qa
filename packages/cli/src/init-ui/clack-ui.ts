import type { Readable, Writable } from 'node:stream'

import {
  S_BAR,
  S_STEP_SUBMIT,
  S_WARN,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  type Option,
} from '@clack/prompts'

import { PromptCancelled } from '../composition/cli-refusal.js'
import { renderBanner } from './banner.js'
import type { InitStepLine, InitUi } from './init-ui.js'
import type { BrandPalette } from './palette.js'
import { sectionSelect } from './section-select.js'

const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'] as const
const SPINNER_DELAY_MS = 80
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const CLEAR_LINE = '\x1b[1G\x1b[J'

interface PromptStreams {
  input: Readable
  output: Writable
  signal: AbortSignal
}

// The signals that would end init with the cursor still hidden; the step runner owns SIGINT.
const ENDING_SIGNALS = ['SIGTERM', 'SIGHUP'] as const

export interface RailProcess {
  readonly pid: number
  on(event: string, listener: (signal: NodeJS.Signals) => void): unknown
  off(event: string, listener: (signal: NodeJS.Signals) => void): unknown
  listenerCount(event: string): number
  kill(pid: number, signal: NodeJS.Signals): unknown
}

export type ClackUi = InitUi & {
  // Stops a spinner a step left running, as when a refusal passes through the step runner.
  dispose(): void
}

export function createClackUi(options: {
  input: Readable
  output: Writable
  palette: BrandPalette
  columns: number
  host?: RailProcess
}): ClackUi {
  const { input, output, palette, columns } = options
  const host: RailProcess = options.host ?? process
  const common = { output }
  const bar = palette.dim(S_BAR)
  let stopSpinner: (() => void) | undefined

  // Clack leaves a prompt pending when its input closes, so each prompt aborts itself then.
  const ask = async <T>(prompt: (streams: PromptStreams) => Promise<T | symbol>): Promise<T> => {
    const controller = new AbortController()
    const close = (): void => controller.abort()
    input.once('end', close)
    input.once('close', close)
    if (input.readableEnded || input.destroyed) close()
    try {
      const value = await prompt({ input, output, signal: controller.signal })
      if (!isCancel(value)) return value as T
      throw new PromptCancelled()
    } finally {
      input.off('end', close)
      input.off('close', close)
    }
  }

  const choices = <T>(options: readonly { value: T; label: string; hint?: string }[]) =>
    options.map((option) => ({ ...option })) as Option<T>[]

  // Each frame clears only the row the cursor is on, so the spinner's line must never wrap: the
  // frame and its gap take three columns, and the last column stays free.
  const fit = (text: string): string => {
    const width = (output as Partial<Record<'columns', number>>).columns ?? columns
    const room = width - 4
    const chars = [...text]
    if (width <= 0 || chars.length <= room) return text
    return room <= 1 ? '' : `${chars.slice(0, room - 1).join('')}…`
  }

  const step = (title: string): InitStepLine => {
    stopSpinner?.()
    output.write(`${bar}\n${HIDE_CURSOR}`)
    let frame = 0
    const draw = (): void => {
      output.write(`${CLEAR_LINE}${palette.accent(SPINNER_FRAMES[frame]!)}  ${fit(title)}`)
      frame = (frame + 1) % SPINNER_FRAMES.length
    }
    draw()
    const timer = setInterval(draw, SPINNER_DELAY_MS)
    timer.unref()
    // A kill or an exit mid-step shows the cursor again; a signal nobody else handles then takes
    // its default action, as it would have without this listener.
    const showCursor = (): void => {
      output.write(SHOW_CURSOR)
    }
    const release = (): void => {
      host.off('exit', showCursor)
      for (const signal of ENDING_SIGNALS) host.off(signal, onSignal)
    }
    const onSignal = (signal: NodeJS.Signals): void => {
      release()
      clearInterval(timer)
      showCursor()
      if (host.listenerCount(signal) === 0) host.kill(host.pid, signal)
    }
    host.on('exit', showCursor)
    for (const signal of ENDING_SIGNALS) host.on(signal, onSignal)
    const close = (lines: readonly string[]): void => {
      if (stopSpinner !== stop) return
      stopSpinner = undefined
      clearInterval(timer)
      release()
      const shown = lines.length === 0 ? '' : `${lines.join('\n')}\n`
      output.write(`${CLEAR_LINE}${shown}${SHOW_CURSOR}`)
    }
    const stop = (): void => close([])
    stopSpinner = stop
    return {
      done: (text) => close([`${palette.success(S_STEP_SUBMIT)}  ${text}`]),
      skipped: (text) => close([`${palette.dim(S_STEP_SUBMIT)}  ${palette.dim(text)}`]),
      failed: (reason, command) => {
        const [first = '', ...rest] = reason.split('\n')
        close([
          `${palette.warning(S_WARN)}  ${first}`,
          ...rest.map((line) => `${bar}  ${line}`),
          ...(command === undefined ? [] : [`${bar}  Run: ${command}`]),
        ])
      },
    }
  }

  return {
    banner: () => {
      const lines = renderBanner({ columns, palette })
      if (lines !== undefined) output.write(`${lines.join('\n')}\n\n`)
    },
    intro: () => {
      intro('agent-qa init', common)
    },
    select: (q) =>
      ask<typeof q.initialValue>((streams) =>
        sectionSelect({
          ...streams,
          message: q.message,
          sections: q.sections,
          initialValue: q.initialValue,
        }),
      ),
    multiselect: (q) =>
      ask<(typeof q.initialValues)[number][]>((streams) =>
        multiselect({
          ...streams,
          message: q.message,
          options: choices(q.options),
          initialValues: [...q.initialValues],
          required: q.required ?? false,
        }),
      ),
    step,
    note: (title, lines) => note(lines.join('\n'), palette.accent(title), common),
    line: (text) => log.message(text, common),
    copyable: (text) => output.write(`${bar}\n${text}\n`),
    outro: (text) => outro(text, common),
    dispose: () => stopSpinner?.(),
  }
}
