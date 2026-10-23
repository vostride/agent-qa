// 431 D-25/D-26 · PXH-AGENT-05: agent-facing guidance reads runs through agent-qa, and the package
// docs name only what exists. The forbidden instruction literals live here and nowhere else.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildKnowledgeAgentGuide } from '../commands/knowledge-guide.js'

const AGENT_QA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SKILLS_DIR = join(AGENT_QA_ROOT, 'skills')
const MCP_DIR = join(AGENT_QA_ROOT, 'packages', 'mcp')

const FORBIDDEN_INSTRUCTIONS: readonly RegExp[] = [
  /no tool serves artifact bytes/iu,
  /read the local `?\.agent-qa`? run artifacts/iu,
  /from the run directory on disk/iu,
  /read from the run directory/iu,
  /which file to open/iu,
]
const PRIVATE_RUNTIME_PATH = /(^|[^\w-])\.agent-qa(?![\w-])|agent-jobs\.db|memory\/(index|queue)\//u
const PROHIBITION = /\b(never|not|no)\b/iu

interface Subject {
  readonly name: string
  readonly body: string
}

function markdownUnder(dir: string): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...markdownUnder(path))
    else if (path.endsWith('.md')) found.push(path)
  }
  return found
}

function guidanceSubjects(): readonly Subject[] {
  const skills = readdirSync(SKILLS_DIR)
    .filter((entry) => entry.startsWith('agent-qa-'))
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .flatMap((entry) => markdownUnder(join(SKILLS_DIR, entry)))
    .map((path) => ({ name: relative(AGENT_QA_ROOT, path), body: readFileSync(path, 'utf8') }))
  return [...skills, { name: 'generated agent-qa-knowledge/AGENTS.md', body: buildKnowledgeAgentGuide() }]
}

/** A paragraph, list item or table row with its wrapped lines joined, keyed by its first line. */
function instructionUnits(body: string): readonly { line: number; text: string }[] {
  const units: { line: number; text: string }[] = []
  body.split('\n').forEach((raw, index) => {
    const last = units.at(-1)
    if (raw.trim() === '') {
      units.push({ line: index + 1, text: '' })
    } else if (last === undefined || last.text === '' || /^\s*([-*|#]|\d+\.)/u.test(raw)) {
      units.push({ line: index + 1, text: raw.trim() })
    } else {
      last.text = `${last.text} ${raw.trim()}`
    }
  })
  return units.filter((unit) => unit.text !== '')
}

/** Instructions that send an agent to agent-qa's private runtime files instead of its reads. */
function unsafeInstructions(subject: Subject): readonly string[] {
  const findings: string[] = []
  for (const unit of instructionUnits(subject.body)) {
    const where = `${subject.name}:${String(unit.line)}`
    for (const pattern of FORBIDDEN_INSTRUCTIONS) {
      if (pattern.test(unit.text)) findings.push(`${where}: ${pattern.source}`)
    }
    if (PRIVATE_RUNTIME_PATH.test(unit.text) && !PROHIBITION.test(unit.text)) {
      findings.push(`${where}: names a private runtime path outside a prohibition`)
    }
  }
  return findings
}

function readFirstPaths(agentsMd: string): readonly string[] {
  const section = /^## Read First\n([\s\S]*?)(?=^## )/mu.exec(agentsMd)?.[1] ?? ''
  return [...section.matchAll(/^- `([^`]+)`/gmu)].map((match) => match[1]!)
}

function missingPaths(packageDir: string, paths: readonly string[]): readonly string[] {
  return paths.filter((path) => !existsSync(join(packageDir, path)))
}

const KNOWN_BAD_TRIAGE: Subject = {
  name: 'known-bad triage skill',
  body: [
    '   - Artifacts, logs and the full event feed from the run directory on disk — no tool serves',
    '     artifact bytes, and the digest names what the run produced.',
    '- If MCP is unavailable, read the local `.agent-qa` run artifacts as a fallback.',
  ].join('\n'),
}

describe('INSTRUCTIONS-STRUCTURED-READS', () => {
  it('sends no agent to private runtime files', () => {
    const subjects = guidanceSubjects()
    expect(subjects.length, 'no guidance was scanned').toBeGreaterThanOrEqual(6)
    expect(subjects.flatMap(unsafeInstructions)).toEqual([])
  })

  it('reds on a known-bad instruction subject', () => {
    const findings = unsafeInstructions(KNOWN_BAD_TRIAGE)
    expect(findings.length).toBeGreaterThanOrEqual(3)
    expect(findings.join('\n')).toContain('names a private runtime path outside a prohibition')
  })

  it.each(['agent-qa-result-triage', 'agent-qa-debug-fix'])(
    '%s reads the overview, then evidence, with a CLI fallback',
    (skill) => {
      const body = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8')
      const overview = body.indexOf('agent_qa_get_run_overview')
      const evidence = body.indexOf('agent_qa_get_run_evidence')
      expect(overview).toBeGreaterThanOrEqual(0)
      expect(evidence).toBeGreaterThan(overview)
      expect(body).toContain('agent-qa runs overview <runId>')
      expect(body).toContain('agent-qa runs evidence <runId>')
      expect(body).toMatch(/--screenshot <sha> --out <file>/u)
      const fallback = body.split('\n').filter((line) => /MCP is unavailable/iu.test(line))
      expect(fallback.length).toBeGreaterThan(0)
      for (const line of fallback) expect(line).toContain('agent-qa runs')
    },
  )
})

describe('MCP-DOC-PATHS', () => {
  const agentsMd = readFileSync(join(MCP_DIR, 'AGENTS.md'), 'utf8')

  it('names only Read First files that exist', () => {
    const paths = readFirstPaths(agentsMd)
    expect(paths.length).toBeGreaterThanOrEqual(5)
    expect(missingPaths(MCP_DIR, paths)).toEqual([])
  })

  it('describes the tools as projections, not dashboard-backed handlers', () => {
    const scope = /^## Scope\n([\s\S]*?)(?=^## )/mu.exec(agentsMd)?.[1] ?? ''
    expect(scope).not.toMatch(/dashboard-backed/iu)
    expect(scope).toMatch(/registry op/iu)
  })

  it('reds on the removed v1 Read First files', () => {
    const removed = ['src/server.ts', 'src/local-http.ts', 'src/schema-reference.ts']
    expect(missingPaths(MCP_DIR, [...removed, 'src/index.ts'])).toEqual(removed)
  })
})
