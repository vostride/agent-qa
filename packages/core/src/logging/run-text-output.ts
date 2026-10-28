import { randomBytes } from 'node:crypto'

export type RunTextEnv = Readonly<Record<string, string | undefined>>

export interface PrintRunTextOptions {
  readonly env?: RunTextEnv
  readonly stdoutIsData?: boolean
}

let stdoutReservations = 0

export function isGitHubActions(env: RunTextEnv = process.env): boolean {
  const value = env.GITHUB_ACTIONS
  return value !== undefined && value !== '' && value.toLowerCase() !== 'false' && value !== '0'
}

export function guardRunText(text: string, env: RunTextEnv = process.env): string {
  if (!isGitHubActions(env)) return text
  // Longer than 6 characters, so the runner masks the token in the log.
  const token = randomBytes(16).toString('hex')
  const block = text.endsWith('\n') ? text : `${text}\n`
  return `::stop-commands::${token}\n${block}::${token}::\n`
}

export function guardJsonText(serialized: string, env: RunTextEnv = process.env): string {
  return isGitHubActions(env) ? serialized.replaceAll('#', '\\u0023') : serialized
}

/** Marks this process's stdout as carrying a JSON document or protocol; returns the release. */
export function reserveStdoutForData(): () => void {
  stdoutReservations += 1
  let released = false
  return () => {
    if (released) return
    released = true
    stdoutReservations -= 1
  }
}

export function printRunText(
  text: string,
  print: (text: string) => void = (line) => console.log(line),
  options: PrintRunTextOptions = {},
): void {
  const env = options.env ?? process.env
  if (!isGitHubActions(env)) {
    print(text)
    return
  }
  const block = guardRunText(text, env)
  if (options.stdoutIsData ?? stdoutReservations > 0) {
    print(block.slice(0, -1))
    return
  }
  // The runner reads stdout and stderr on separate threads, so every wrapped block shares stdout.
  process.stdout.write(block)
}
