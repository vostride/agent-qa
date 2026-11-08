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
  select,
  text,
  type Option,
} from '@clack/prompts'

import { PromptCancelled } from '../composition/cli-refusal.js'
import { renderBanner } from './banner.js'
import type { InitStepLine, InitUi } from './init-ui.js'
import type { BrandPalette } from './palette.js'

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

export type ClackUi = InitUi & {
  // Stops a spinner a step left running, as when a refusal passes through the step runner.
  dispose(): void
}

export function createClackUi(options: {
  input: Readable
  output: Writable
  palette: BrandPalette
  columns: number
}): ClackUi {
  const { input, output, palette, columns } = options
  const common = { output }
  const bar = palette.dim(S_BAR)
  let stopSpinner: (() => void) | undefined

  // Clack leaves a prompt pending when its input closes, so each prompt aborts itself then.
  // A deferring signal ends the prompt without a cancel, and the caller takes its default.
  const ask = async <T>(
    prompt: (streams: PromptStreams) => Promise<T | symbol>,
    deferred?: AbortSignal,
  ): Promise<T | undefined> => {
    const controller = new AbortController()
    let closed = false
    const close = (): void => {
      closed = true
      controller.abort()
    }
    const defer = (): void => controller.abort()
    input.once('end', close)
    input.once('close', close)
    deferred?.addEventListener('abort', defer, { once: true })
    if (input.readableEnded || input.destroyed) close()
    if (deferred?.aborted === true) defer()
    try {
      const value = await prompt({ input, output, signal: controller.signal })
      if (!isCancel(value)) return value as T
      if (!closed && deferred?.aborted === true) return undefined
      throw new PromptCancelled()
    } finally {
      input.off('end', close)
      input.off('close', close)
      deferred?.removeEventListener('abort', defer)
    }
  }

  const choices = <T>(options: readonly { value: T; label: string; hint?: string }[]) =>
    options.map((option) => ({ ...option })) as Option<T>[]

  const step = (title: string): InitStepLine => {
    stopSpinner?.()
    output.write(`${bar}\n${HIDE_CURSOR}`)
    let frame = 0
    const draw = (): void => {
      output.write(`${CLEAR_LINE}${palette.accent(SPINNER_FRAMES[frame]!)}  ${title}`)
      frame = (frame + 1) % SPINNER_FRAMES.length
    }
    draw()
    const timer = setInterval(draw, SPINNER_DELAY_MS)
    timer.unref()
    const close = (lines: readonly string[]): void => {
      if (stopSpinner !== stop) return
      stopSpinner = undefined
      clearInterval(timer)
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
    intro: (summary) => {
      intro('agent-qa init', common)
      log.message([palette.accent('What to expect'), summary], common)
    },
    select: async (q) => {
      const value = await ask<typeof q.initialValue>((streams) =>
        select({
          ...streams,
          message: q.message,
          options: choices(q.options),
          initialValue: q.initialValue,
          ...(q.maxItems === undefined ? {} : { maxItems: q.maxItems }),
        }),
      )
      return value ?? q.initialValue
    },
    multiselect: async (q) => {
      const value = await ask<(typeof q.initialValues)[number][]>((streams) =>
        multiselect({
          ...streams,
          message: q.message,
          options: choices(q.options),
          initialValues: [...q.initialValues],
          required: q.required ?? false,
        }),
      )
      return value ?? [...q.initialValues]
    },
    text: async (q) => {
      const value = await ask<string>(
        (streams) => text({ ...streams, message: q.message, defaultValue: q.defaultValue }),
        q.signal,
      )
      return value ?? q.defaultValue
    },
    step,
    note: (title, lines) => note(lines.join('\n'), palette.accent(title), common),
    line: (text) => log.message(text, common),
    outro: (text) => outro(text, common),
    dispose: () => stopSpinner?.(),
  }
}
