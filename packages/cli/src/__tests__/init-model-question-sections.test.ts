// The headed select on the rail: headings never chosen, a status on every row, every cancel, and
// the window a list taller than the terminal is drawn through.
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'

import { S_BAR_END, S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_STEP_ACTIVE } from '@clack/prompts'
import { describe, expect, it } from 'vitest'

import { PromptCancelled } from '../composition/cli-refusal.js'
import { createClackUi } from '../init-ui/clack-ui.js'
import type { InitSection } from '../init-ui/init-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import { KEY, clackStreams, type ClackStreams } from './clack-keys.js'

const MESSAGE = 'Which one?'
const NEW_HEADING = 'Connect a new model'
const SAVED_HEADING = 'Saved on this machine (2)'

const NEW_SECTION: InitSection<string> = {
  heading: NEW_HEADING,
  options: [
    { value: 'sub', label: 'Claude subscription', status: 'sign in after setup' },
    { value: 'api', label: 'Gemini API', status: 'key in the dashboard' },
    { value: 'endpoint', label: 'OpenAI-compatible endpoint', status: 'set up in the dashboard' },
  ],
}

const SAVED_SECTION: InitSection<string> = {
  heading: SAVED_HEADING,
  options: [
    { value: 'signed', label: 'mine (Claude)', status: 'signed in' },
    { value: 'keyed', label: 'work (OpenAI-compatible)', status: 'key saved' },
  ],
}

const OPTIONS = [...NEW_SECTION.options, ...SAVED_SECTION.options]

function withoutGutter(line: string): string {
  return line.replace(/^\S\s\s/u, '')
}

function headedSelect(
  initialValue: string,
  sections: readonly InitSection<string>[] = [NEW_SECTION, SAVED_SECTION],
) {
  const streams = clackStreams()
  const ui = createClackUi({
    input: streams.input,
    output: streams.output,
    palette: brandPalette({ background: 'dark', level: 0 }),
    columns: 100,
  })
  const answer = ui.select({ message: MESSAGE, sections, initialValue })
  answer.catch(() => {})
  const firstFrame = async (): Promise<string[]> => {
    await streams.waitFor(MESSAGE)
    const text = stripVTControlCharacters(streams.text())
    return text.slice(text.indexOf(MESSAGE)).split('\n')
  }
  return { streams, answer, firstFrame }
}

describe('the headed select on the rail', () => {
  it('draws every option with its own status, each status starting at the same column', async () => {
    const { streams, answer, firstFrame } = headedSelect('sub')
    const lines = await firstFrame()
    await streams.press(KEY.enter)
    await answer

    const columns = OPTIONS.map(({ label, status }) => {
      const line = lines.find((drawn) => drawn.includes(label))
      expect(line, `${label} is drawn`).toBeDefined()
      expect(line).toContain(status)
      return line!.indexOf(status)
    })
    expect(new Set(columns).size).toBe(1)
  })

  it('draws the headings without a radio and exactly one active radio', async () => {
    const { streams, answer, firstFrame } = headedSelect('sub')
    const lines = await firstFrame()
    await streams.press(KEY.enter)
    await answer

    for (const heading of [NEW_HEADING, SAVED_HEADING]) {
      const line = lines.find((drawn) => drawn.includes(heading))
      expect(line, `${heading} is drawn`).toBeDefined()
      expect(withoutGutter(line!)).toBe(heading)
    }
    const active = lines.filter((line) => line.includes(S_RADIO_ACTIVE))
    expect(active).toHaveLength(1)
    expect(active[0]).toContain('Claude subscription')
  })

  it('takes the initial value on Enter at once', async () => {
    const { streams, answer, firstFrame } = headedSelect('api')
    await firstFrame()
    await streams.press(KEY.enter)

    await expect(answer).resolves.toBe('api')
  })

  it('starts the cursor on an initial value in the second section', async () => {
    const { streams, answer, firstFrame } = headedSelect('keyed')
    const active = (await firstFrame()).filter((line) => line.includes(S_RADIO_ACTIVE))
    await streams.press(KEY.enter)

    expect(active).toHaveLength(1)
    expect(active[0]).toContain('work (OpenAI-compatible)')
    await expect(answer).resolves.toBe('keyed')
  })

  it('moves down past the second heading to the first saved row', async () => {
    const { streams, answer, firstFrame } = headedSelect('endpoint')
    await firstFrame()
    await streams.press(KEY.down, KEY.enter)

    await expect(answer).resolves.toBe('signed')
  })

  it('moves up past the first heading and wraps to the last saved row', async () => {
    const { streams, answer, firstFrame } = headedSelect('sub')
    await firstFrame()
    await streams.press(KEY.up, KEY.enter)

    await expect(answer).resolves.toBe('keyed')
  })

  it('draws no second heading when only the first section is given', async () => {
    const { streams, answer, firstFrame } = headedSelect('sub', [NEW_SECTION])
    const lines = await firstFrame()
    await streams.press(KEY.enter)
    await answer

    expect(lines.some((line) => line.includes(NEW_HEADING))).toBe(true)
    expect(lines.some((line) => line.includes('Saved on this machine'))).toBe(false)
  })

  it.each([
    { name: 'Ctrl-C', stop: (streams: ClackStreams) => streams.press(KEY.ctrlC) },
    { name: 'Esc', stop: (streams: ClackStreams) => streams.press(KEY.escape) },
    {
      name: 'an ended input',
      stop: async (streams: ClackStreams) => {
        streams.input.end()
      },
    },
  ])('$name rejects with the prompt cancel', async ({ stop }) => {
    const { streams, answer, firstFrame } = headedSelect('sub')
    await firstFrame()
    await stop(streams)

    await expect(answer).rejects.toBeInstanceOf(PromptCancelled)
  })
})

const LONG_NEW: InitSection<string> = {
  heading: NEW_HEADING,
  options: Array.from({ length: 7 }, (_, index) => ({
    value: `new-${index + 1}`,
    label: `new-${index + 1}`,
    status: 'set up later',
  })),
}

const LONG_SAVED_HEADING = 'Saved on this machine (12)'

function longSaved(
  label: (name: string) => string = (name) => name,
  status = 'key saved',
): InitSection<string> {
  return {
    heading: LONG_SAVED_HEADING,
    options: Array.from({ length: 12 }, (_, index) => {
      const name = `saved-${String(index + 1).padStart(2, '0')}`
      return { value: name, label: label(name), status }
    }),
  }
}

const LONG_VALUES = [...LONG_NEW.options, ...longSaved().options].map(({ value }) => value)

function windowedSelect(
  terminal: { rows: number; columns?: number },
  sections: readonly InitSection<string>[] = [LONG_NEW, longSaved()],
) {
  const streams = clackStreams(terminal)
  const ui = createClackUi({
    input: streams.input,
    output: streams.output,
    palette: brandPalette({ background: 'dark', level: 0 }),
    columns: terminal.columns ?? 100,
  })
  const answer = ui.select({ message: MESSAGE, sections, initialValue: 'new-1' })
  answer.catch(() => {})
  return { streams, answer }
}

// The question as a terminal shows it now, from the guide line above it to its └.
function frameOf(streams: ClackStreams): string[] {
  const lines = streams.screen()
  const at = lines.findIndex((line) => line.startsWith(S_STEP_ACTIVE) && line.includes(MESSAGE))
  const end = lines.findIndex((line, index) => index > at && line.startsWith(S_BAR_END))
  return at < 1 || end < 0 ? [] : lines.slice(at - 1, end + 1)
}

// The list's lines without the gutter: between the question and the instruction footer.
function listOf(frame: readonly string[]): string[] {
  return frame.slice(2, -2).map(withoutGutter)
}

function activeLine(frame: readonly string[]): string | undefined {
  return frame.find((line) => line.includes(S_RADIO_ACTIVE))
}

async function frameOn(streams: ClackStreams, value: string): Promise<string[]> {
  for (let waited = 0; waited < 3000; waited += 10) {
    const frame = frameOf(streams)
    if (activeLine(frame)?.includes(value)) return frame
    await sleep(10)
  }
  throw new Error(`the cursor never reached ${value}:\n${streams.screen().join('\n')}`)
}

describe('the headed select in a terminal shorter than its list', () => {
  it.each([12, 15])(
    'fits a %i-row terminal at every cursor position of a full lap, with the visible section heading first',
    async (rows) => {
      const { streams, answer } = windowedSelect({ rows })
      const walk = [...LONG_VALUES, LONG_VALUES[0]!]
      const frames: string[][] = []
      for (const [step, value] of walk.entries()) {
        if (step > 0) await streams.press(KEY.down)
        frames.push(await frameOn(streams, value))
      }
      await streams.press(KEY.enter)
      await expect(answer).resolves.toBe('new-1')

      for (const frame of frames) {
        expect(frame.length).toBeLessThan(rows)
        expect(frame.filter((line) => line.includes(S_RADIO_ACTIVE))).toHaveLength(1)
        const list = listOf(frame)
        expect([NEW_HEADING, LONG_SAVED_HEADING]).toContain(list[0])
        for (const heading of [NEW_HEADING, LONG_SAVED_HEADING]) {
          expect(list.filter((line) => line === heading).length).toBeLessThanOrEqual(1)
        }
        const topOption = list.find(
          (line) => line.startsWith(S_RADIO_ACTIVE) || line.startsWith(S_RADIO_INACTIVE),
        )
        if (topOption?.includes('saved-')) expect(list[0]).toBe(LONG_SAVED_HEADING)
        const sectionFirst = list[0] === NEW_HEADING ? 'new-1' : 'saved-01'
        if (list[1] === '...') {
          expect(list[2]).not.toContain(sectionFirst)
          expect([NEW_HEADING, LONG_SAVED_HEADING]).not.toContain(list[2])
        } else {
          expect(list[1]).toContain(sectionFirst)
        }
        if (frame.some((line) => line.includes('saved-12'))) {
          expect(list.at(-1)).not.toBe('...')
        } else {
          expect(list.at(-1)).toBe('...')
          expect([NEW_HEADING, LONG_SAVED_HEADING]).not.toContain(list.at(-2))
        }
      }
      expect(frames.some((frame) => listOf(frame).at(-1) === '...')).toBe(true)
      expect(frames.some((frame) => listOf(frame)[0] === LONG_SAVED_HEADING)).toBe(true)
      expect(frames.some((frame) => listOf(frame)[1] === '...')).toBe(true)
    },
  )

  it.each(LONG_VALUES.map((value, downs) => ({ value, downs })))(
    'Enter after $downs presses of ↓ takes $value, the row under the active radio',
    async ({ value, downs }) => {
      const { streams, answer } = windowedSelect({ rows: 12 })
      await frameOn(streams, 'new-1')
      await streams.press(...Array<string>(downs).fill(KEY.down))
      const frame = await frameOn(streams, value)
      await streams.press(KEY.enter)

      expect(activeLine(frame)).toContain(value)
      await expect(answer).resolves.toBe(value)
    },
  )

  it('draws every row, both headings and no ... when the terminal is tall enough', async () => {
    const { streams, answer } = windowedSelect({ rows: 40 })
    const frame = await frameOn(streams, 'new-1')
    await streams.press(KEY.enter)
    await answer

    const list = listOf(frame)
    expect(list).toHaveLength(LONG_VALUES.length + 2)
    expect(list).toContain(NEW_HEADING)
    expect(list).toContain(LONG_SAVED_HEADING)
    for (const value of LONG_VALUES) expect(frame.some((line) => line.includes(value))).toBe(true)
    expect(list).not.toContain('...')
  })

  it('cuts a row wider than the terminal to one line ending in …', async () => {
    const wide = (name: string) => `${name} ${'x'.repeat(60 - name.length - 1)}`
    const { streams, answer } = windowedSelect({ rows: 12, columns: 40 }, [
      LONG_NEW,
      longSaved(wide, 'a status too long for this terminal'),
    ])
    await frameOn(streams, 'new-1')
    await streams.press(...Array<string>(LONG_NEW.options.length).fill(KEY.down))
    const frame = await frameOn(streams, 'saved-01')
    await streams.press(KEY.enter)
    await expect(answer).resolves.toBe('saved-01')

    expect(wide('saved-01')).toHaveLength(60)
    expect(frame.length).toBeLessThan(12)
    const row = frame.find((line) => line.includes('saved-01'))
    expect(row?.endsWith('…')).toBe(true)
    for (const line of frame) expect(line.length).toBeLessThanOrEqual(40)
  })

  it('cuts only an over-long label, so every status is drawn in full at 80 columns', async () => {
    const long = 'my-company-claude-subscription-for-the-whole-team (Anthropic subscription)'
    const saved: InitSection<string> = {
      heading: 'Saved on this machine (1)',
      options: [{ value: 'long', label: long, status: 'signed in' }],
    }
    const { streams, answer } = windowedSelect({ rows: 40, columns: 80 }, [NEW_SECTION, saved])
    const frame = await frameOn(streams, 'Claude subscription')
    await streams.press(KEY.enter)
    await expect(answer).resolves.toBe('sub')

    const columns = [...NEW_SECTION.options, ...saved.options].map(({ label, status }) => {
      const line = frame.find((drawn) => drawn.includes(label.slice(0, 20)))
      expect(line, `${label} is drawn`).toBeDefined()
      expect(line!.endsWith(status)).toBe(true)
      return line!.indexOf(status)
    })
    expect(new Set(columns).size).toBe(1)
    for (const { label } of NEW_SECTION.options) {
      expect(frame.some((line) => line.includes(label))).toBe(true)
    }
    const longRow = frame.find((line) => line.includes(long.slice(0, 20)))
    expect(longRow).not.toContain(long)
    expect(longRow).toContain('…')
    for (const line of frame) expect(line.length).toBeLessThanOrEqual(80)
  })
})
