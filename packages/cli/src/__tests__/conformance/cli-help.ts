// The help walk over the built CLI, returned as findings.

import { spawnSync } from 'node:child_process'

import { CLI_ENTRY, hermeticEnv } from './spawned-chat.js'

export interface Help {
  readonly code: number | null
  readonly text: string
  readonly commands: readonly string[]
}

export type HelpReader = (path: readonly string[]) => Help

const PLACEHOLDER = /^<[^>]+>$/u

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function shellLines(markdown: string): string[] {
  const lines: string[] = []
  for (const block of markdown.matchAll(/^[ \t]*```(?:sh|bash)\n([\s\S]*?)^[ \t]*```$/gmu)) {
    lines.push(...block[1]!.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
  }
  return lines
}

export function agentQaArgv(line: string): string[] | undefined {
  const tokens = line.trim().split(/\s+/u)
  const at = tokens[0] === 'npx' ? 1 : 0
  return tokens[at] === 'agent-qa' ? tokens.slice(at + 1) : undefined
}

export function createHelpReader(root: string): HelpReader {
  const cache = new Map<string, Help>()
  return (path) => {
    const key = path.join(' ')
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...path, '--help'], {
      cwd: root,
      env: hermeticEnv(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    const text = `${result.stdout}${result.stderr}`
    const lines = text.split('\n')
    const start = lines.findIndex((line) => line.trim() === 'Commands:')
    const commands: string[] = []
    if (start !== -1) {
      for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') break
        const match = /^ {2}(\S+)/u.exec(line)
        if (match !== null) commands.push(match[1]!)
      }
    }
    const help = { code: result.status, text, commands }
    cache.set(key, help)
    return help
  }
}

export function commandFindings(argv: readonly string[], helpOf: HelpReader): string[] {
  const path: string[] = []
  let help = helpOf(path)
  let at = 0
  while (at < argv.length && !argv[at]!.startsWith('-') && help.commands.includes(argv[at]!)) {
    path.push(argv[at]!)
    help = helpOf(path)
    at += 1
  }
  const firstFlag = argv.findIndex((token) => token.startsWith('-'))
  const named = ['agent-qa', ...argv.slice(0, firstFlag === -1 ? argv.length : firstFlag)].join(' ')
  const parent = ['agent-qa', ...path].join(' ')
  const rest = argv.slice(at)
  const next = rest.find((token) => !token.startsWith('-') && !PLACEHOLDER.test(token))
  if (next !== undefined && (path.length === 0 || help.commands.length > 0)) {
    return [`"${named}": ${parent} has no command "${next}"`]
  }
  if (path.length === 0) return [`"${named}": names no agent-qa command`]

  const findings: string[] = []
  if (help.code !== 0) findings.push(`"${parent}": ${parent} --help exited ${String(help.code)}`)
  if (!new RegExp(`Usage: ${escaped(parent)}(?: |$)`, 'mu').test(help.text)) {
    findings.push(`"${parent}": ${parent} --help prints no Usage: ${parent}`)
  }
  const flags = rest.filter((token) => token.startsWith('--')).map((token) => token.split('=')[0]!)
  for (const flag of flags) {
    const listed = help.text.split('\n')
      .some((line) => new RegExp(`^\\s+(?:-\\w, )?${escaped(flag)}(?:\\s|,|$)`, 'u').test(line))
    if (!listed) findings.push(`"${parent} ${flag}": ${parent} --help names no ${flag}`)
  }
  return findings
}
