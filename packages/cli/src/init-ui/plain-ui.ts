import type { InitUi } from './init-ui.js'

// For --json, CI and runs without a terminal: plain lines, no colour, cursor code or spinner,
// and every question answered with its default.
export function createPlainUi(
  write: (text: string) => void = (text) => process.stderr.write(text),
): InitUi {
  const print = (text: string): void => write(`${text}\n`)
  return {
    banner: () => {},
    intro: print,
    select: async (q) => q.initialValue,
    multiselect: async (q) => [...q.initialValues],
    text: async (q) => q.defaultValue,
    step: () => ({
      done: (text) => print(`✓ ${text}`),
      skipped: (text) => print(`– ${text}`),
      failed: (reason, command) => {
        print(`✗ ${reason}`)
        if (command !== undefined) print(`  Run: ${command}`)
      },
    }),
    note: (title, lines) => {
      print(title)
      for (const line of lines) print(`  ${line}`)
    },
    line: print,
    copyable: print,
    outro: print,
  }
}
