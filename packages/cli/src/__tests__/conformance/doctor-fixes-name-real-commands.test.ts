// C446-DOCTOR-FIXES (446-05, D-16): every command and key a doctor fix names is real

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadCapabilityCatalog } from '../../capability-catalog/loader.js'
import { agentQaArgv, commandFindings, createHelpReader, type HelpReader } from './cli-help.js'
import { configKeyFindings, dottedKeyCandidates } from './config-keys.js'
import {
  ANCHORED_BUILDS,
  CLI_PACKAGE_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  trackTempRoot,
} from './spawned-chat.js'

const SOURCES = ['src/commands/doctor.ts', 'src/commands/doctor-knowledge-checks.ts']
const COMMANDS = [
  'init',
  'auth set',
  'auth login',
  'auth test',
  'install-browsers',
  'install-mobile-drivers',
  'validate',
  'knowledge rebuild-index',
  'daemon stop',
]
const KEYS = ['workspace.secretsFile', 'workspace.hooksFile', 'workspace.envFile', 'plugins.auth']
const PLANTED =
  'Run `agent-qa embedder set --profile bge`, then `agent-qa auth set --typ api-key`, and set `embedder.profile`.'
const HELP_BUDGET_MS = 180_000

let helpOf: HelpReader

function fixText(source: string): string {
  const text = source.split('\n')
    .filter((line) => !/^(?:\/\/|\/\*|\*)/u.test(line.trimStart()))
    .join('\n')
    .replaceAll('\\`', '`')
  const literals = new Map<string, string>()
  const oneLineReturn = /function (\w+)\([^)]*\)[^{\n]*\{\n\s*return '([^'\n]*)'\n\s*\}/gu
  for (const match of text.matchAll(oneLineReturn)) literals.set(match[1]!, match[2]!)
  return text
    .replace(/\$\{(\w+)\(\)\}/gu, (whole, name: string) => literals.get(name) ?? whole)
    .replace(/\$\{([^}]*)\}/gu, (_whole, inner: string) => (
      `<${/^[\w.]+/u.exec(inner.trim())?.[0] ?? 'value'}>`
    ))
}

function doctorSubjects(): { name: string; body: string }[] {
  return SOURCES.map((name) => ({
    name,
    body: fixText(readFileSync(join(CLI_PACKAGE_ROOT, name), 'utf8')),
  }))
}

function commandSpans(text: string): string[] {
  return [...text.matchAll(/(?<=`)(?:npx )?agent-qa [^`\n]*(?=`)/gu)]
    .map((match) => match[0].trim())
}

function catalogOpIds(): ReadonlySet<string> {
  const rows = loadCapabilityCatalog().rows
  return new Set(rows.flatMap((row) => (row.kind === 'op' ? [row.id] : [])))
}

function commandPath(argv: readonly string[]): string {
  const end = argv.findIndex((token) => token.startsWith('-') || /^<[^>]+>$/u.test(token))
  return argv.slice(0, end === -1 ? argv.length : end).join(' ')
}

function assertFreshBuild(): void {
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect({ missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`).toEqual({ missing: [], stale: [] })
}

beforeAll(() => {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-446-doctor-fixes-')))
  helpOf = createHelpReader(root)
})

afterAll(() => {
  cleanupTempRoots()
})

describe('the commands, flags and keys doctor fixes name', () => {
  it('every agent-qa command and flag a doctor fix names exists in the shipped help', () => {
    assertFreshBuild()
    const findings: string[] = []
    const found = new Set<string>()
    for (const subject of doctorSubjects()) {
      for (const span of commandSpans(subject.body)) {
        const argv = agentQaArgv(span) ?? []
        const named = commandFindings(argv, helpOf)
        findings.push(...named.map((finding) => `${subject.name}: ${finding}`))
        if (named.length === 0) found.add(commandPath(argv))
      }
    }
    expect(findings, 'a doctor fix names a command or flag the built CLI does not have').toEqual([])
    expect(COMMANDS.filter((command) => !found.has(command)), `found: ${[...found].join(', ')}`)
      .toEqual([])
  }, HELP_BUDGET_MS)

  it('every config key a doctor fix names resolves in the config schema', () => {
    const subjects = doctorSubjects()
    const opIds = catalogOpIds()
    const keys = new Set(subjects.flatMap((subject) => dottedKeyCandidates(subject.body, opIds)))
    const { scanned, findings } = configKeyFindings(subjects, opIds)
    expect(findings, 'a doctor fix names a config key the schema refuses').toEqual([])
    expect(scanned).toBeGreaterThan(0)
    expect(KEYS.filter((key) => !keys.has(key)), `found: ${[...keys].sort().join(', ')}`)
      .toEqual([])
  })

  it('a phantom command, flag or key in a fix text is named', () => {
    assertFreshBuild()
    const body = fixText(PLANTED)
    const spans = commandSpans(body)
    expect(spans).toEqual(['agent-qa embedder set --profile bge', 'agent-qa auth set --typ api-key'])
    const findings = spans.flatMap((span) => commandFindings(agentQaArgv(span) ?? [], helpOf))
    expect(findings).toEqual([
      '"agent-qa embedder set": agent-qa has no command "embedder"',
      '"agent-qa auth set --typ": agent-qa auth set --help names no --typ',
    ])
    expect(configKeyFindings([{ name: 'planted', body }], catalogOpIds()).findings).toEqual([
      'planted: embedder.profile is not a config key',
    ])
  }, HELP_BUDGET_MS)
})
