// The headed select on the rail: headings never chosen, a status on every row, and every cancel.
import { stripVTControlCharacters } from 'node:util'

import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from '@clack/prompts'
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
      expect(line).not.toContain(S_RADIO_ACTIVE)
      expect(line).not.toContain(S_RADIO_INACTIVE)
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
