// The help ↔ catalog census, the help text's argument contract, and the skills' command vocabulary
// (Phase 398 plan 09 — XPLN-01, D-01 / SC-1 / Pitfall 5).
//
// WHAT THESE LEGS ARE FOR. `resolver-table.ts`'s header states a law in prose: help text kept
// anywhere other than the canon it documents is a second list of what chat understands, free to
// drift from the one that actually routes. It was a law nothing enforced, and it had already been
// broken — the `digest` line advertised "the latest run digest" while the rule it sits fifteen
// lines below refuses a bare `digest` on purpose. These cells turn the prose into a comparison.
//
// WHICH TWO SETS THE CENSUS COMPARES, SAID PLAINLY (397 D-14's lesson, re-measured in 398). It
// compares (1) the alias tokens named by `CHAT_HELP_ENTRIES` against (2) the committed catalog's
// alias rows, plus the shipped `CHAT_DIRECTIVES`, plus the aliases the catalog producer's own probe
// table classifies as the passthrough. Every member of both sides is read from a shipped module or
// the committed artifact; nothing here is a list somebody typed.
//
// AND WHAT IT THEREFORE CANNOT SEE. A census compares MEMBERSHIP. It is blind to a rule whose
// matching CLAUSE moved while its name stayed — which is exactly the drift that was live in this
// repo — so the argument-contract cell below closes that half by driving the shipped resolver with
// each line's own bare verb. It is equally blind to a capability listing rendered on a surface
// neither set enumerates: a second help string in some other command file is not a member of either
// side, so it touches neither. The second-list sweep is the cell that watches for that, and it
// watches by SEARCHING FOR THE VOCABULARY the shipped modules produce rather than by holding a list
// of forbidden strings — a rule that can only refuse what it can name cannot be driven to zero by
// naming more things.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Command } from 'commander'

import {
  CHAT_DIRECTIVES,
  CHAT_HELP_ENTRIES,
  CHAT_HELP_TEXT,
  CHAT_RESOLVER_TABLE,
  resolveClause,
} from '@vostride/agent-qa-agent'
import { AGENT_QA_MCP_INSTRUCTIONS, AGENT_QA_TOOL_PROJECTIONS } from '@vostride/agent-qa-mcp'
import { describe, expect, it } from 'vitest'

import {
  buildStarterPrompts,
  completionCandidatesFor,
  passthroughFormOf,
  STARTER_PROMPT_COUNT,
  typedVerbs,
} from '../../capability-catalog/chat-discovery.js'
import { loadCapabilityCatalog } from '../../capability-catalog/loader.js'
import {
  DEDICATED_READ_VERBS,
  INIT_AGENT_INSTRUCTIONS_VERB,
} from '../../capability-catalog/manifest.js'
import { buildKnowledgeReadme } from '../../commands/init.js'
import {
  AGENT_QUESTION_MAP,
  buildAgentInstructionPointer,
  buildKnowledgeAgentGuide,
  KNOWLEDGE_SKILL_NAME,
} from '../../commands/knowledge-guide.js'
import { resolveAgentQaSkillsDirectory } from '../../commands/skills.js'
import { curationOutcomeLine } from '../../curation/curation-tail.js'
import { createAgentQaProgram } from '../../program.js'
import { registryOpIds } from './adapters.js'
import { agentQaRoot, buildCatalogSkillRows, CHAT_ALIAS_PROBES } from './catalog.js'
import { configKeyFindings } from './config-keys.js'
import { SURFACE_ROSTER } from './roster.js'

/** Sorted, so a named RED reads the same on every machine. */
function sorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** The first token of a help line's syntax — the word a person types alone. */
function bareVerbOf(syntax: string): string {
  return syntax.trim().split(/\s+/u)[0] ?? ''
}

/**
 * Whether the line PROMISES that a bare verb is enough.
 *
 * `<angle>` is a required argument and `[square]` an optional one, which is the convention the
 * entries already use and the one every CLI help page in this repo uses. Reading it here is what
 * turns a typographic habit into a claim the resolver can be held to.
 */
function requiresArgument(syntax: string): boolean {
  return /<[^>]+>/u.test(syntax)
}

describe('the /help census — one list of what chat understands', () => {
  it('names every row of the shipped resolver table, and no row it does not have', () => {
    const helpAliases = sorted(CHAT_HELP_ENTRIES.map((entry) => entry.alias))
    const tableAliases = sorted(CHAT_RESOLVER_TABLE.map((rule) => rule.alias))

    expect(helpAliases.length, 'the help entries are empty — this census would range nothing')
      .toBeGreaterThan(0)
    expect(
      helpAliases,
      'the help text and the table it sits beside disagree about what chat understands — '
      + 'a help line with no rule behind it is a promise nothing keeps, and a rule with no help '
      + 'line is a capability a person can only find by reading source',
    ).toEqual(tableAliases)
  })

  it('set-equals the committed catalog\'s aliases plus the directives plus the passthrough', () => {
    const catalog = loadCapabilityCatalog()
    const catalogAliases = catalog.rows
      .filter((row) => row.kind === 'alias')
      .map((row) => row.alias)
    // The passthrough is recognised the way the producer recognises it: by the probe table's own
    // classification, which the catalog's census pins against the shipped rules in both
    // directions. Spelling `fn` here would be this file's opinion about which rule is generic.
    const passthroughAliases = CHAT_ALIAS_PROBES
      .filter((probe) => probe.expects === 'passthrough')
      .map((probe) => probe.alias)

    expect(catalogAliases.length, 'the committed catalog carries no alias rows').toBeGreaterThan(0)
    expect(passthroughAliases.length, 'no probe classifies a rule as the passthrough')
      .toBeGreaterThan(0)

    const understood = sorted([...catalogAliases, ...CHAT_DIRECTIVES, ...passthroughAliases])
    const helpAliases = sorted(CHAT_HELP_ENTRIES.map((entry) => entry.alias))

    expect(
      helpAliases,
      'the help text and the ONE capability catalog disagree — every line of help is either a '
      + 'catalogued alias, a session directive or the passthrough, and every one of those has a '
      + 'line (SC-1: one source, no second list)',
    ).toEqual(understood)
  })

  it('renders CHAT_HELP_TEXT from the entries, so the sentences cannot drift from the join keys', () => {
    for (const entry of CHAT_HELP_ENTRIES) {
      expect(
        CHAT_HELP_TEXT,
        `the rendered help omits the ${entry.alias} line's syntax`,
      ).toContain(entry.syntax)
      expect(
        CHAT_HELP_TEXT,
        `the rendered help omits the ${entry.alias} line's summary`,
      ).toContain(entry.summary)
    }
  })

  it('each line\'s argument claim is what the SHIPPED rule actually does', () => {
    // The half a set comparison cannot reach. Every line is driven against the real resolver with
    // its own bare verb: a line showing a required argument must NOT resolve alone (the table's
    // near-miss law), and a line showing none must resolve — to its own rule, not to a neighbour's.
    const findings: string[] = []
    for (const entry of CHAT_HELP_ENTRIES) {
      const verb = bareVerbOf(entry.syntax)
      const resolution = resolveClause(CHAT_RESOLVER_TABLE, verb)
      if (requiresArgument(entry.syntax)) {
        if (resolution.kind !== 'unresolved') {
          findings.push(
            `${entry.alias}: help shows "${entry.syntax}" (an argument is required) but the `
            + `shipped rule resolves the bare "${verb}" to ${resolution.alias}`,
          )
        }
        continue
      }
      if (resolution.kind !== 'resolved') {
        findings.push(
          `${entry.alias}: help shows "${entry.syntax}" (no argument needed) but the shipped `
          + `rule does not resolve the bare "${verb}" at all — a person typing exactly what help `
          + 'printed reaches the planner instead of the capability',
        )
        continue
      }
      if (resolution.alias !== entry.alias) {
        findings.push(
          `${entry.alias}: the bare "${verb}" resolves to ${resolution.alias}, so this line `
          + 'documents a rule other than the one it names',
        )
      }
    }

    // Not vacuous in either direction: the cell has to range at least one line of each class, or
    // it could pass by asserting nothing about the arm that drifted.
    const required = CHAT_HELP_ENTRIES.filter((entry) => requiresArgument(entry.syntax))
    expect(required.length, 'no help line claims a required argument — the cell ranges one arm only')
      .toBeGreaterThan(0)
    expect(
      CHAT_HELP_ENTRIES.length - required.length,
      'no help line claims to work bare — the cell ranges one arm only',
    ).toBeGreaterThan(0)

    expect(
      findings,
      'the help text claims things the resolver does not do',
    ).toEqual([])
  })
})

/**
 * The three packages a chat session's own code lives in, and the one file that owns the vocabulary.
 *
 * The sweep ranges the SURFACE and the two layers behind it rather than this package alone,
 * because a second help listing is likeliest to grow where the directives are handled — and that is
 * `agent-local`'s composition, not a command file.
 */
const SWEEP_ROOTS = ['packages/cli/src', 'packages/agent/src', 'packages/agent-local/src']

/** The one module allowed to spell the vocabulary: the table the vocabulary belongs to. */
const VOCABULARY_OWNER = join('packages', 'agent', 'src', 'chat', 'resolver-table.ts')

/** Every `.ts` file under a directory, tests excluded — the sweep's universe. */
function sourceFilesUnder(root: string): readonly string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry)
    if (statSync(candidate).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      found.push(...sourceFilesUnder(candidate))
      continue
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(candidate)
  }
  return found
}

/**
 * A comment line, approximately.
 *
 * The sweep skips them because a comment is not something a person reads at the prompt — this
 * file's own header names four directive forms while discussing them. The approximation is stated
 * rather than hidden: a directive listing hidden in a TRAILING comment on a line of code is not
 * detected, and it is also not rendered.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/**
 * Whether a body names a directive form AS A FORM rather than as part of a path.
 *
 * MEASURED, NOT ASSUMED (2026-08-17): the first version of this sweep matched substrings and fired
 * on `commands/init.ts` for `'../model-defaults.js'` and for the URL `iana.org/help/…`. Both are
 * paths, and neither is a listing of anything. The boundary conditions are what make the difference
 * — a form a person types is preceded by whitespace or a quote and followed by whitespace,
 * punctuation or the end of the string, which a path segment never is on both sides at once.
 */
function namesDirectiveForm(body: string, form: string): boolean {
  const escaped = form.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
  return new RegExp(`(^|[\\s'"\`(\\[,])${escaped}($|[\\s'"\`)\\],.;:!?])`, 'mu').test(body)
}

describe('no second list of what chat understands', () => {
  it('no CLI module other than the resolver table spells the directive vocabulary', () => {
    // THE SEARCH TERMS ARE PRODUCED, NOT LISTED. They are the shipped directive names plus the
    // passthrough aliases, in the form a person types them — so a fifth directive is swept for the
    // day it lands, without this cell being edited. A guard that could only refuse the four names
    // written here would be an enumeration, and an enumeration is refuted by adding a fifth.
    const forms = sorted([
      ...CHAT_DIRECTIVES.map((directive) => `/${directive}`),
      ...CHAT_ALIAS_PROBES
        .filter((probe) => probe.expects === 'passthrough')
        .map((probe) => `/${probe.alias}`),
    ])
    expect(forms.length, 'the sweep searches for nothing').toBeGreaterThan(1)

    const root = agentQaRoot()
    const swept: string[] = []
    const findings: string[] = []
    for (const sweepRoot of SWEEP_ROOTS) {
      for (const file of sourceFilesUnder(join(root, sweepRoot))) {
        const repoRelative = relative(root, file)
        if (repoRelative === VOCABULARY_OWNER) continue
        swept.push(repoRelative)
        const code = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !isCommentLine(line))
          .join('\n')
        const named = forms.filter((form) => namesDirectiveForm(code, form))
        // TWO OR MORE is the shape of a LISTING. One form on its own is a module that mentions a
        // directive (an error message about `/quit`, say); two or more in one module is a module
        // that has started enumerating the vocabulary, which is the second list SC-1 forbids.
        if (named.length >= 2) findings.push(`${repoRelative} names ${named.join(', ')}`)
      }
    }
    expect(swept.length, 'the sweep read no files').toBeGreaterThan(100)

    // Not vacuous: the detector must fire on a planted listing, or a fragment assembled wrong
    // would leave it quietly searching for nothing.
    const planted = `  ${forms[0] ?? ''}   this list\n  ${forms[1] ?? ''}   end the session`
    expect(
      forms.filter((form) => namesDirectiveForm(planted, form)).length,
      'the sweep no longer recognises a planted directive listing',
    ).toBeGreaterThanOrEqual(2)
    // …and it must NOT fire on the two path shapes that made the first version of this cell red on
    // an innocent file. A boundary rule that forgot one of its boundaries is a sweep nobody can
    // leave switched on.
    const paths = "import { X } from '../model-defaults.js'\nconst u = 'https://iana.org/help/x'"
    expect(
      forms.filter((form) => namesDirectiveForm(paths, form)),
      'the sweep reads path segments as directive forms again',
    ).toEqual([])

    expect(
      findings,
      'a CLI module has started enumerating the chat directive vocabulary — the one list lives in '
      + 'CHAT_HELP_ENTRIES beside the table that routes it, and every consumer renders THAT',
    ).toEqual([])
  })
})

/**
 * The AUTHORED skills tree, which is not the one that ships.
 *
 * MEASURED THE HARD WAY (2026-08-17). `packages/cli/skills` is a GENERATED COPY: the CLI package's
 * `prepack` runs `copy:skills`, which deletes that directory and rebuilds it from this one. A guard
 * that read only the resolved (packaged) directory would certify a reconciliation that the next
 * `prepack` silently undoes — which is exactly what happened while this plan was being written, and
 * `validate:publish` is what surfaced it. Both trees are ranged, so a fix applied to one and not the
 * other is a named RED rather than a regression waiting for the next release.
 */
const SKILLS_SOURCE_DIR = 'skills'

/**
 * Every file a skill DIRECTORY carries, not just its SKILL.md.
 *
 * MEASURED, AND THE REASON THIS IS NOT SCOPED TO SKILL.md (2026-08-17). The first version of the
 * guard read only the three SKILL.md files, and it would have passed while
 * `agent-qa-authoring/references/agent-qa-contracts.json` — a file the skill's own step 3 tells an
 * agent to LOAD — still instructed `agent_qa_generate_id`. A guard scoped to one file of a
 * multi-file input class certifies that file, not the class. The universe here is the whole
 * directory the CLI's own resolution finds, minus binaries.
 */
function shippedSkillFiles(): readonly { name: string; path: string }[] {
  const resolved = resolveAgentQaSkillsDirectory(dirname(fileURLToPath(import.meta.url)))
  const roots = [join(agentQaRoot(), SKILLS_SOURCE_DIR)]
  if (resolved.source !== 'missing') roots.push(resolved.path)

  const found: { name: string; path: string }[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const skill of readdirSync(root)) {
      const skillDir = join(root, skill)
      if (!statSync(skillDir).isDirectory()) continue
      for (const file of filesUnderSkill(skillDir)) {
        found.push({ name: relative(agentQaRoot(), file), path: file })
      }
    }
  }
  return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** Every file under a skill directory, recursively — the whole of what a skill ships. */
function filesUnderSkill(root: string): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry)
    if (statSync(candidate).isDirectory()) {
      found.push(...filesUnderSkill(candidate))
      continue
    }
    found.push(candidate)
  }
  return found
}

/**
 * Every `agent_qa_*` identifier a document mentions, read as whole identifiers so a name that is a
 * prefix of another is not mistaken for it.
 */
function toolTokensIn(body: string): readonly string[] {
  return sorted(body.match(/agent_qa_[a-z0-9_]+/gu) ?? [])
}

describe('the shipped skills quote only live commands', () => {
  it('every tool a skill names is one the shipped mapping actually projects', () => {
    // Asks of every name a skill quotes whether it is LIVE, so no list of forbidden names is
    // needed and a name nobody wrote down cannot slip past.
    const live = new Set(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name))
    expect(live.size, 'the shipped mapping projects no tools — this cell would allow anything')
      .toBeGreaterThan(0)

    const findings: string[] = []
    let scanned = 0
    for (const file of shippedSkillFiles()) {
      for (const token of toolTokensIn(readFileSync(file.path, 'utf8'))) {
        scanned += 1
        if (!live.has(token)) findings.push(`${file.name}: ${token}`)
      }
    }
    // Not vacuous: skills that named no tool at all would pass this cell by saying nothing, and a
    // skill set that stopped naming tools is a skill set that stopped being useful.
    expect(scanned, 'no shipped skill names a tool — the cell certifies nothing').toBeGreaterThan(0)

    expect(
      findings,
      'a shipped skill names a tool the MCP mapping does not project — every command a skill '
      + "quotes has to be one a caller can actually invoke today (SC-2's premise)",
    ).toEqual([])
  })
})

describe('the chat host\'s discovery UX is a projection of the catalog', () => {
  it('offers every alias row in the form the shipped resolver actually answers', () => {
    // THE ACCEPTANCE CRITERION, DRIVEN. Every alias the catalog carries must be reachable by
    // typing its first letter — and the candidate that comes back must be a form the table
    // answers, which is asserted rather than assumed: an offered word the resolver refuses is a
    // surface inventing a vocabulary, and it would look exactly like this cell passing.
    const rows = loadCapabilityCatalog().rows
    const aliasRows = rows.filter((row) => row.kind === 'alias')
    expect(aliasRows.length, 'the catalog carries no alias rows').toBeGreaterThan(0)

    const bareVerbs = typedVerbs(CHAT_HELP_ENTRIES).bareVerbs
    const findings: string[] = []
    for (const row of aliasRows) {
      const syntax = CHAT_HELP_ENTRIES.find((entry) => entry.alias === row.alias)?.syntax
      if (syntax === undefined) {
        findings.push(`${row.alias}: no help entry carries a typed form for it`)
        continue
      }
      const verb = syntax.trim().split(/\s+/u)[0] ?? ''
      if (!bareVerbs.includes(verb) && !verb.startsWith('/')) {
        findings.push(`${row.alias}: "${verb}" is in neither half of the typed vocabulary`)
        continue
      }
      const offered = completionCandidatesFor(verb.slice(0, 1), rows, CHAT_HELP_ENTRIES)
      if (!offered.includes(verb)) {
        findings.push(`${row.alias}: typing "${verb.slice(0, 1)}" does not offer "${verb}"`)
      }
    }
    expect(findings, 'an alias row the completer cannot surface').toEqual([])
  })

  it('reaches every catalogued op through the passthrough, and binds the op it names', () => {
    // The catalog earning its place: the resolver table is a CAP of five aliases, so this is the
    // only way a person finds the other capabilities. Each candidate is then driven through the
    // SHIPPED resolver, so a candidate that reads plausibly and binds nothing is a RED.
    const rows = loadCapabilityCatalog().rows
    const passthrough = passthroughFormOf(CHAT_HELP_ENTRIES)
    expect(passthrough, 'no shipped rule behaves as the generic passthrough').toBeDefined()

    const offered = completionCandidatesFor(passthrough ?? '', rows, CHAT_HELP_ENTRIES)
    const opRows = rows.filter((row) => row.kind === 'op')
    expect(opRows.length, 'the catalog carries no op rows').toBeGreaterThan(0)
    expect(offered.length, 'the passthrough offers a different number of ops than the catalog has')
      .toBe(opRows.length)

    const findings: string[] = []
    for (const candidate of offered) {
      const resolution = resolveClause(CHAT_RESOLVER_TABLE, candidate)
      if (resolution.kind !== 'resolved' || resolution.entry.kind !== 'op') {
        findings.push(`${candidate}: the shipped table binds nothing`)
        continue
      }
      // Hoisted, because a second read of `resolution.entry` loses the narrowing under `tsc` even
      // though `vitest --typecheck` accepts it — 398-04's trap, measured again here.
      const bound = resolution.entry.functionId
      if (!rows.some((row) => row.kind === 'op' && row.id === bound)) {
        findings.push(`${candidate}: binds ${bound}, which has no catalog row`)
      }
    }
    expect(findings, 'a passthrough candidate the shipped resolver does not answer').toEqual([])
  })

  it('offers nothing mid-sentence — a chat line is an utterance, not a command line', () => {
    const rows = loadCapabilityCatalog().rows
    expect(completionCandidatesFor('why did the checkout ', rows, CHAT_HELP_ENTRIES)).toEqual([])
    expect(completionCandidatesFor('', rows, CHAT_HELP_ENTRIES).length).toBeGreaterThan(0)
  })

  it('renders the same starter prompts from the same rows, every time', () => {
    const rows = loadCapabilityCatalog().rows
    const first = buildStarterPrompts(rows, CHAT_HELP_ENTRIES)
    const second = buildStarterPrompts([...rows].reverse(), CHAT_HELP_ENTRIES)

    expect(first.length, 'a session opens with no suggestions').toBe(STARTER_PROMPT_COUNT)
    // SAME ROWS, SAME PROMPTS — including when the rows arrive in a different order, which is the
    // property that makes the selection deterministic rather than incidental.
    expect(second, 'the starter prompts depend on the order the rows arrived in').toEqual(first)

    // Every line is CATALOG TEXT, not a sentence this surface wrote.
    const descriptions = rows.filter((row) => row.kind === 'alias').map((row) => row.description)
    for (const prompt of first) {
      expect(
        descriptions.some((description) => prompt.includes(description)),
        `a starter prompt carries text no catalog row provided: ${prompt}`,
      ).toBe(true)
    }
  })
})

// ---- 431 D-24: every name the published guidance quotes is live ---------------------------------
//
// The subjects are the generated guide, the root pointer, and every file of every skill in BOTH the
// source tree and the packaged mirror `copy:skills` produces. Tool names are checked against the MCP
// projection and the committed catalog's op rows; CLI invocations are resolved against the real
// Commander tree (`createAgentQaProgram`) and, for the verbs the capability manifest lists, against
// the manifest too. A packaged input that is absent or empty is a finding, never a skip.

interface GuidanceSubject {
  readonly name: string
  readonly body: string
}

interface GuidanceInputs {
  readonly subjects: readonly GuidanceSubject[]
  readonly findings: readonly string[]
}

function skillDirectoriesIn(root: string): readonly string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((entry) => {
      const candidate = join(root, entry)
      return statSync(candidate).isDirectory() && existsSync(join(candidate, 'SKILL.md'))
    })
    .sort()
}

function subjectName(file: string): string {
  const root = agentQaRoot()
  return file.startsWith(`${root}/`) ? relative(root, file) : file
}

/** Every `references/<file>` a SKILL.md tells an agent to load must sit beside it, non-empty. */
function referenceFindings(skillDir: string): readonly string[] {
  const skillMarkdown = join(skillDir, 'SKILL.md')
  const named = sorted(readFileSync(skillMarkdown, 'utf8').match(/references\/[A-Za-z0-9._-]+/gu) ?? [])
  const findings: string[] = []
  for (const reference of named) {
    const path = join(skillDir, reference)
    if (!existsSync(path)) findings.push(`${subjectName(skillMarkdown)} names ${reference}, which is missing`)
    else if (statSync(path).size === 0) findings.push(`${subjectName(skillMarkdown)} names ${reference}, which is empty`)
  }
  return findings
}

function guidanceInputs(sourceRoot: string, packagedRoot: string): GuidanceInputs {
  const findings: string[] = []
  const subjects: GuidanceSubject[] = [
    { name: 'generated guide', body: buildKnowledgeAgentGuide() },
    { name: 'root pointer', body: buildAgentInstructionPointer().join('\n') },
    { name: 'MCP instructions', body: AGENT_QA_MCP_INSTRUCTIONS },
  ]

  const sourceSkills = skillDirectoriesIn(sourceRoot)
  if (sourceSkills.length === 0) findings.push(`no source skill under ${subjectName(sourceRoot)}`)
  if (!existsSync(packagedRoot)) findings.push(`the packaged skills directory ${subjectName(packagedRoot)} is missing`)

  for (const skill of sourceSkills) {
    for (const file of filesUnderSkill(join(sourceRoot, skill))) {
      const packaged = join(packagedRoot, relative(sourceRoot, file))
      if (statSync(file).size === 0) findings.push(`${subjectName(file)} is empty`)
      if (!existsSync(packaged)) {
        findings.push(`${subjectName(packaged)} is missing — run copy:skills`)
        continue
      }
      if (statSync(packaged).size === 0) findings.push(`${subjectName(packaged)} is empty`)
    }
  }

  for (const root of [sourceRoot, packagedRoot]) {
    for (const skill of skillDirectoriesIn(root)) {
      findings.push(...referenceFindings(join(root, skill)))
      for (const file of filesUnderSkill(join(root, skill))) {
        subjects.push({ name: subjectName(file), body: readFileSync(file, 'utf8') })
      }
    }
  }
  return { subjects, findings }
}

function liveGuidanceInputs(): GuidanceInputs {
  return guidanceInputs(join(agentQaRoot(), SKILLS_SOURCE_DIR), join(agentQaRoot(), 'packages', 'cli', 'skills'))
}

/** The subjects that must each quote at least one tool, and at least one CLI verb. */
function nameBearing(subject: GuidanceSubject, kind: 'tools' | 'verbs'): boolean {
  if (subject.name === 'generated guide') return true
  if (subject.name === 'root pointer') return kind === 'verbs'
  return subject.name.includes(`/${KNOWLEDGE_SKILL_NAME}/`) && subject.name.endsWith('.md')
}

interface CensusResult {
  readonly scanned: number
  readonly findings: readonly string[]
}

function toolCensus(subjects: readonly GuidanceSubject[]): CensusResult {
  const projected = new Map(AGENT_QA_TOOL_PROJECTIONS.map((projection) => [projection.name, projection.ops]))
  const catalogOps = new Set(
    loadCapabilityCatalog().rows.flatMap((row) => (row.kind === 'op' ? [row.id] : [])),
  )
  const findings: string[] = []
  let scanned = 0
  for (const subject of subjects) {
    const tokens = toolTokensIn(subject.body)
    scanned += tokens.length
    if (tokens.length === 0 && nameBearing(subject, 'tools')) {
      findings.push(`${subject.name}: quotes no agent_qa_* tool — the census would certify nothing`)
    }
    for (const token of tokens) {
      const ops = projected.get(token)
      if (ops === undefined) {
        findings.push(`${subject.name}: ${token} is not a projected MCP tool`)
        continue
      }
      for (const op of ops) {
        if (!catalogOps.has(op)) findings.push(`${subject.name}: ${token} projects ${op}, which the catalog has no row for`)
      }
    }
  }
  if (scanned === 0) findings.push('no tool name was scanned')
  return { scanned, findings }
}

interface Invocation {
  readonly text: string
  readonly flags: string[]
  readonly prefixed: boolean
  readonly fence: string
}

const STANDALONE_FLAG = /^--[a-z][a-z0-9-]*(?:\s+<[^>]+>)?$/u
const MARKDOWN_FENCES: readonly string[] = ['md', 'markdown']

/**
 * Every `agent-qa …` or `npx agent-qa …` invocation a document quotes: backtick spans, and lines of
 * fenced blocks other than markdown ones, whose spans are read as prose. The stored text starts at
 * `agent-qa`; `fence` is the info string of the block the invocation sat in, `''` outside one.
 *
 * A bare flag span (`--since`) that follows an invocation in the same paragraph is that
 * invocation's flag, which is how the reference lists a verb's options. Prose that merely says
 * agent-qa is not an invocation.
 */
function invocationsIn(body: string): readonly Invocation[] {
  const invocations: Invocation[] = []
  const paragraphs: string[] = []
  let paragraph: string[] = []
  let fence: string | undefined
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      fence = fence === undefined ? (trimmed.slice(3).trim().split(/\s+/u)[0] ?? '') : undefined
      continue
    }
    if (fence !== undefined && !MARKDOWN_FENCES.includes(fence)) {
      const at = line.search(/(?:^|\s)agent-qa\s+[a-z]/u)
      if (at >= 0) {
        const start = line.indexOf('agent-qa', at)
        invocations.push({
          text: line.slice(start).trim(),
          flags: [],
          prefixed: /(?:^|\s)npx\s+$/u.test(line.slice(0, start)),
          fence,
        })
      }
      continue
    }
    if (line.trim() === '') {
      paragraphs.push(paragraph.join(' '))
      paragraph = []
      continue
    }
    paragraph.push(line)
  }
  paragraphs.push(paragraph.join(' '))

  for (const text of paragraphs) {
    let current: Invocation | undefined
    for (const match of text.matchAll(/`([^`]+)`/gu)) {
      const span = (match[1] ?? '').trim()
      if (/^(?:npx\s+)?agent-qa\s+[a-z]/u.test(span)) {
        const prefixed = /^npx\s/u.test(span)
        current = { text: prefixed ? span.replace(/^npx\s+/u, '') : span, flags: [], prefixed, fence: '' }
        invocations.push(current)
      } else if (current !== undefined && STANDALONE_FLAG.test(span)) {
        current.flags.push(span)
      }
    }
  }
  return invocations
}

function commandPathOf(command: Command): string {
  const names: string[] = []
  for (let at: Command | null = command; at?.parent != null; at = at.parent) names.unshift(at.name())
  return names.join(' ')
}

function takesValue(command: Command, flag: string): boolean | undefined {
  const option = command.options.find((entry) => entry.long === flag || entry.short === flag)
  if (option === undefined) return flag === '--help' ? false : undefined
  return option.required || option.optional
}

function resolveInvocation(program: Command, invocation: Invocation): {
  readonly command?: Command
  readonly flags: readonly string[]
  readonly findings: readonly string[]
} {
  const tokens = invocation.text.split(/\s+/u).slice(1)
  const findings: string[] = []
  let command = program
  let at = 0
  while (at < tokens.length && !(tokens[at] ?? '').startsWith('-')) {
    const name = tokens[at]
    const child = command.commands.find((entry) => entry.name() === name || entry.aliases().includes(name ?? ''))
    if (child === undefined) break
    command = child
    at += 1
  }
  if (command === program) {
    return { flags: [], findings: [`"${invocation.text}": agent-qa has no command "${tokens[0] ?? ''}"`] }
  }

  const path = `agent-qa ${commandPathOf(command)}`
  const flags: string[] = []
  const positionals: string[] = []
  for (; at < tokens.length; at += 1) {
    const token = tokens[at] ?? ''
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const flag = token.split('=')[0] ?? token
    flags.push(flag)
    const value = takesValue(command, flag)
    if (value === undefined) {
      findings.push(`"${invocation.text}": ${path} has no ${flag} option`)
      if ((tokens[at + 1] ?? '').startsWith('<')) at += 1
      continue
    }
    if (value && !token.includes('=') && at + 1 < tokens.length && !(tokens[at + 1] ?? '').startsWith('-')) at += 1
  }
  for (const span of invocation.flags) {
    const flag = span.split(/\s+/u)[0] ?? span
    flags.push(flag)
    if (takesValue(command, flag) === undefined) findings.push(`"${invocation.text}" then \`${span}\`: ${path} has no ${flag} option`)
  }

  const declared = command.registeredArguments
  const variadic = declared.at(-1)?.variadic === true
  if (positionals.length > declared.length && !variadic) {
    findings.push(
      command.commands.length > 0
        ? `"${invocation.text}": ${path} has no subcommand "${positionals[0] ?? ''}"`
        : `"${invocation.text}": ${path} takes ${declared.length} argument(s), not ${positionals.length}`,
    )
  }
  const required = declared.filter((argument) => argument.required).length
  if (positionals.length < required) {
    findings.push(`"${invocation.text}": ${path} requires ${required} argument(s), the guidance gives ${positionals.length}`)
  }
  return { command, flags, findings }
}

function verbCensus(subjects: readonly GuidanceSubject[], program: Command = createAgentQaProgram()): CensusResult {
  const findings: string[] = []
  let scanned = 0
  for (const subject of subjects) {
    const invocations = invocationsIn(subject.body)
    scanned += invocations.length
    if (invocations.length === 0 && nameBearing(subject, 'verbs')) {
      findings.push(`${subject.name}: quotes no agent-qa invocation — the census would certify nothing`)
    }
    for (const invocation of invocations) {
      const resolved = resolveInvocation(program, invocation)
      findings.push(...resolved.findings.map((finding) => `${subject.name}: ${finding}`))
      if (resolved.command === undefined) continue
      const manifestEntry = DEDICATED_READ_VERBS.find((entry) => entry.verb === commandPathOf(resolved.command!))
      if (manifestEntry === undefined) continue
      for (const flag of resolved.flags) {
        const live = takesValue(resolved.command, flag) !== undefined
        if (live && flag !== '--help' && !manifestEntry.flags.includes(flag)) {
          findings.push(`${subject.name}: "${invocation.text}" uses ${flag}, which the manifest's ${manifestEntry.verb} row omits`)
        }
      }
    }
  }
  if (scanned === 0) findings.push('no agent-qa invocation was scanned')
  return { scanned, findings }
}

/** The manifest's verb rows against the live tree, and the question map's CLI and MCP halves against each other. */
function manifestFindings(program: Command = createAgentQaProgram()): readonly string[] {
  const findings: string[] = []
  const find = (path: string): Command | undefined => path.split(' ').reduce<Command | undefined>(
    (parent, name) => parent?.commands.find((command) => command.name() === name), program)

  for (const entry of DEDICATED_READ_VERBS) {
    const live = find(entry.verb)
    if (live === undefined) {
      findings.push(`manifest verb "${entry.verb}" is not a live command`)
      continue
    }
    const longs = sorted(live.options.flatMap((option) => (option.long === undefined ? [] : [option.long])))
    if (JSON.stringify(longs) !== JSON.stringify(sorted(entry.flags))) {
      findings.push(`manifest verb "${entry.verb}" lists ${sorted(entry.flags).join(' ')}, the live command has ${longs.join(' ')}`)
    }
  }
  const init = find(INIT_AGENT_INSTRUCTIONS_VERB.verb)
  for (const flag of INIT_AGENT_INSTRUCTIONS_VERB.flags) {
    if (init?.options.some((option) => option.long === flag) !== true) {
      findings.push(`manifest init flag ${flag} is not an option of the live init command`)
    }
  }

  const projected = new Map(AGENT_QA_TOOL_PROJECTIONS.map((projection) => [projection.name, projection.ops]))
  for (const row of AGENT_QUESTION_MAP) {
    const resolved = resolveInvocation(program, { text: row.cli, flags: [], prefixed: false, fence: '' })
    if (resolved.command === undefined) continue
    const entry = DEDICATED_READ_VERBS.find((verb) => verb.verb === commandPathOf(resolved.command!))
    const ops = projected.get(row.mcp) ?? []
    if (entry !== undefined && !entry.opIds.some((opId) => ops.includes(opId))) {
      findings.push(`"${row.question}": ${row.cli} invokes ${entry.opIds.join(', ')}, ${row.mcp} projects ${ops.join(', ')}`)
    }
  }
  return findings
}

describe('LIVE-GUIDANCE: the guide, pointer and every source and packaged skill quote only live names', () => {
  it('LIVE-GUIDANCE-INPUTS reads the guide, the pointer and both skill trees, with nothing missing or empty', () => {
    const resolved = resolveAgentQaSkillsDirectory(dirname(fileURLToPath(import.meta.url)))
    expect(resolved.source, 'agent-qa skills resolves no packaged mirror — run copy:skills').toBe('package')

    const { subjects, findings } = liveGuidanceInputs()
    expect(findings, 'a guidance input is absent or empty').toEqual([])
    const packaged = subjects.filter((subject) => subject.name.startsWith('packages/cli/skills/'))
    const source = subjects.filter((subject) => subject.name.startsWith(`${SKILLS_SOURCE_DIR}/`))
    expect(source.length, 'no source skill file was read').toBeGreaterThan(0)
    expect(packaged.length, 'the packaged mirror has a different file count from the source').toBe(source.length)
    expect(skillDirectoriesIn(resolved.path)).toContain(KNOWLEDGE_SKILL_NAME)
  })

  it('LIVE-GUIDANCE-INPUTS names a missing or empty packaged reference instead of skipping it', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-431-12-census-'))
    try {
      const sourceRoot = join(root, 'source')
      const packagedRoot = join(root, 'packaged')
      mkdirSync(sourceRoot)
      cpSync(join(agentQaRoot(), SKILLS_SOURCE_DIR, KNOWLEDGE_SKILL_NAME), join(sourceRoot, KNOWLEDGE_SKILL_NAME), { recursive: true })

      expect(guidanceInputs(sourceRoot, packagedRoot).findings.join('\n')).toMatch(/packaged skills directory .* is missing/u)

      cpSync(sourceRoot, packagedRoot, { recursive: true })
      expect(guidanceInputs(sourceRoot, packagedRoot).findings).toEqual([])

      const reference = join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'references', 'knowledge-reads.md')
      writeFileSync(reference, '')
      expect(guidanceInputs(sourceRoot, packagedRoot).findings).toEqual([
        `${reference} is empty`,
        `${join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'SKILL.md')} names references/knowledge-reads.md, which is empty`,
      ])

      rmSync(reference)
      expect(guidanceInputs(sourceRoot, packagedRoot).findings).toEqual([
        `${reference} is missing — run copy:skills`,
        `${join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'SKILL.md')} names references/knowledge-reads.md, which is missing`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('LIVE-GUIDANCE-TOOLS: every agent_qa_* name is a projected tool whose ops the catalog carries', () => {
    const { subjects } = liveGuidanceInputs()
    const live = toolCensus(subjects)
    expect(live.findings, 'the published guidance names a tool that is not live').toEqual([])
    expect(live.scanned, 'the tool census scanned fewer names than the guide alone quotes')
      .toBeGreaterThan(AGENT_QUESTION_MAP.length)

    const planted = toolCensus([
      { name: 'planted', body: 'Call `agent_qa_get_run`, then `agent_qa_get_run_overviews`.' },
    ])
    expect(planted.findings, 'the tool census accepts a stale name').toEqual([
      'planted: agent_qa_get_run is not a projected MCP tool',
      'planted: agent_qa_get_run_overviews is not a projected MCP tool',
    ])
    expect(toolCensus([]).findings).toEqual(['no tool name was scanned'])
    expect(toolCensus([{ name: 'generated guide', body: 'no tools here' }]).findings)
      .toEqual(['generated guide: quotes no agent_qa_* tool — the census would certify nothing', 'no tool name was scanned'])
  })

  it('LIVE-GUIDANCE-VERBS: every agent-qa invocation resolves in the live Commander tree and the manifest', () => {
    const { subjects } = liveGuidanceInputs()
    const program = createAgentQaProgram()
    const live = verbCensus(subjects, program)
    expect(live.findings, 'the published guidance quotes a CLI verb or flag that is not live').toEqual([])
    expect(live.scanned, 'the verb census scanned fewer invocations than the guide alone quotes')
      .toBeGreaterThan(AGENT_QUESTION_MAP.length)
    expect(manifestFindings(program), 'the capability manifest and the live CLI disagree').toEqual([])

    const planted = verbCensus([{
      name: 'planted',
      body: [
        '`agent-qa runs detail <runId>`',
        '',
        '`agent-qa runs overview <runId> --verbose`',
        '',
        '`agent-qa knowledge show`',
        '',
        'CLI: `agent-qa runs list`, with `--sort`.',
        '',
        '```text',
        'Next: agent-qa knowledge why r-brisk-heron',
        '```',
      ].join('\n'),
    }], program)
    expect(planted.findings, 'the verb census accepts a stale verb or flag').toEqual([
      'planted: "agent-qa knowledge why r-brisk-heron": agent-qa knowledge has no subcommand "why"',
      'planted: "agent-qa runs detail <runId>": agent-qa runs has no subcommand "detail"',
      'planted: "agent-qa runs overview <runId> --verbose": agent-qa runs overview has no --verbose option',
      'planted: "agent-qa knowledge show": agent-qa knowledge show requires 1 argument(s), the guidance gives 0',
      'planted: "agent-qa runs list" then `--sort`: agent-qa runs list has no --sort option',
    ])
    expect(verbCensus([], program).findings).toEqual(['no agent-qa invocation was scanned'])
  })

  it('keeps the dedicated verbs off the four-door roster and the knowledge skill in the catalog source', () => {
    expect(SURFACE_ROSTER.map((door) => door.id)).toEqual(['chat', 'mcp', 'fn', 'run-service'])
    const rosterIds = SURFACE_ROSTER.map((door) => door.id)
    for (const { verb } of DEDICATED_READ_VERBS) expect(rosterIds, verb).not.toContain(verb.split(' ')[0])
    const skillRows = buildCatalogSkillRows().map((row) => row.name)
    expect(skillRows, 'the catalog source misses a shipped skill').toEqual([...skillDirectoriesIn(join(agentQaRoot(), SKILLS_SOURCE_DIR))])
    expect(skillRows).toContain(KNOWLEDGE_SKILL_NAME)
  })
})

// 2026-10-01, 432-17 (D-02 / D-05 / D-09): `agent-qa proposals` is deleted with the inbox, including
// its `grants list | revoke` subtree. No alias is kept, so the parse tree rejects the verb the way it
// rejects any word it never had, and nothing in the help, the manifest or the dedicated-verb list
// still names it.
describe('C432-NO-PROPOSAL-CLI: there is no proposals verb', () => {
  it('C432-NO-PROPOSAL-CLI: the live Commander tree and its help name no proposals command', () => {
    const program = createAgentQaProgram()
    const names = program.commands.flatMap((command) => [command.name(), ...command.aliases()])
    expect(names.length, 'the command tree is empty, so the absence below would be vacuous').toBeGreaterThan(5)
    expect(names, 'agent-qa proposals is still registered').not.toContain('proposals')
    expect(program.helpInformation()).not.toMatch(/\bproposals\b/u)
    expect(DEDICATED_READ_VERBS.map(({ verb }) => verb).filter((verb) => verb.split(' ')[0] === 'proposals'))
      .toEqual([])
  })

  it('C432-NO-PROPOSAL-CLI: parsing a proposals or proposals-grants invocation is an unknown command', async () => {
    // Guarded first: on a tree that still registers the verb, parsing would RUN it in this cwd.
    expect(createAgentQaProgram().commands.map((command) => command.name()), 'the verb is registered')
      .not.toContain('proposals')
    for (const argv of [['proposals', 'list'], ['proposals', 'accept', 'prop_0123456789ab'], ['proposals', 'grants', 'list']]) {
      const program = createAgentQaProgram()
      let written = ''
      program.exitOverride().configureOutput({ writeErr: (text) => { written += text }, writeOut: () => {} })
      const refused = await program.parseAsync(argv, { from: 'user' }).then(
        () => undefined,
        (error: unknown) => error as { code?: string },
      )
      expect(refused?.code, argv.join(' ')).toBe('commander.unknownCommand')
      expect(written, argv.join(' ')).toMatch(/unknown command 'proposals'/u)
    }
  })
})

// ---- 432-40 (D-02 / D-05 / D-09 / D-24): the direct model, said with live names only ----------
//
// The LIVE-GUIDANCE cells above prove every NAME the guidance quotes is live. These prove what the
// guidance SAYS: knowledge and config change through agent-qa and apply in the call, wrong knowledge
// is corrected by new feedback or forget, and no current text describes a proposal, an approval, a
// grant, a confirm round or a permission. Old recorded argv and dated history notes in source are
// not guidance and are not read here; the subjects are the generated guide, the root pointer, the
// scaffolded knowledge README, every source and packaged skill file, and the committed catalogue.

/** The six MCP names the proposal round had; none is projected since 432-12. */
const RETIRED_CHANGE_TOOLS: readonly string[] = Object.freeze([
  'agent_qa_propose_knowledge_change',
  'agent_qa_propose_config_change',
  'agent_qa_apply_proposal',
  'agent_qa_apply_config_proposal',
  'agent_qa_list_proposals',
  'agent_qa_show_proposal',
])

/**
 * The approval model's vocabulary, by the claim each word would make. `approval` is also the
 * knowledge gates read's name for an accepted-policy receipt, so its receipt-kind phrases
 * (`marks and approvals`, `mark and approval receipts`, `approval none`) are not the approval model.
 */
const APPROVAL_VOCABULARY: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['a proposal', /\bpropos(?:al|als|e|ed|es|ing)\b/iu],
  ['an approval', /\bapprov(?:e|ed|es|ing)\b|\bapprovals?\b(?<!\bmarks? and approvals?)(?! none\b| receipts?\b)/iu],
  ['a grant', /\bgrant(?:s|ed|ing)?\b/iu],
  ['a permission', /\bpermissions?\b/iu],
  ['an inbox', /\binbox\b/iu],
  ['a pending review', /\b(?:pending|awaiting)\b/iu],
  ['a confirm step', /\bconfirm(?:ation)?\s+(?:round|prompt|step|dialog)\b|--yes\b/iu],
  ['a caller credential', /\bbearer\b|\bsafe[- ]mode\b|\bdefault scopes?\b/iu],
  ['a design-doc path', /\bspec\/v\d/iu],
])

function approvalFindings(subjects: readonly GuidanceSubject[]): readonly string[] {
  const findings: string[] = []
  for (const subject of subjects) {
    for (const [claim, pattern] of APPROVAL_VOCABULARY) {
      const hit = subject.body.match(pattern)
      if (hit !== null) findings.push(`${subject.name}: "${hit[0]}" describes ${claim}`)
    }
    for (const tool of toolTokensIn(subject.body)) {
      if (RETIRED_CHANGE_TOOLS.includes(tool)) findings.push(`${subject.name}: names the retired ${tool}`)
    }
  }
  return findings
}

/** The D-24 rule, as the four facts a knowledge text must state. */
const KNOWLEDGE_RULE: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['changes only through agent-qa', /changes only\s+through agent-qa/u],
  ['applies at once', /appl(?:y|ies) at once/u],
  ['wrong knowledge is corrected by new feedback', /corrected by\s+new feedback/u],
  ['or by forgetting the record', /forgetting the\s+record/u],
])

function knowledgeRuleFindings(subject: GuidanceSubject): readonly string[] {
  return KNOWLEDGE_RULE.flatMap(([fact, pattern]) =>
    pattern.test(subject.body) ? [] : [`${subject.name}: does not say knowledge ${fact}`])
}

function directGuidanceSubjects(): readonly GuidanceSubject[] {
  return [
    ...liveGuidanceInputs().subjects,
    { name: 'knowledge README', body: buildKnowledgeReadme() },
  ]
}

describe('C432-GUIDANCE-DIRECT: current guidance describes changes that apply in the call', () => {
  it('C432-GUIDANCE-DIRECT: no guide, README, pointer or skill file uses approval-model words or retired change tools', () => {
    const subjects = directGuidanceSubjects()
    expect(subjects.length, 'fewer guidance subjects than the guide, pointer, README and one skill')
      .toBeGreaterThan(4)
    expect(approvalFindings(subjects), 'current guidance still describes the approval model').toEqual([])

    // The census fires: each word class, and a retired change tool, is named when planted.
    const planted = approvalFindings([{
      name: 'planted',
      body: 'File a proposal, wait for approval in the inbox, then grant it. '
        + 'Call agent_qa_apply_proposal; see spec/v2/knowledge-store.md.',
    }])
    expect(planted).toEqual([
      'planted: "proposal" describes a proposal',
      'planted: "approval" describes an approval',
      'planted: "grant" describes a grant',
      'planted: "inbox" describes an inbox',
      'planted: "spec/v2" describes a design-doc path',
      'planted: names the retired agent_qa_apply_proposal',
    ])
    expect(approvalFindings([{
      name: 'receipt kinds',
      body: 'Which marks and approvals back a record? It lists mark and approval receipts. '
        + 'standing: mark false-fail @6; approval none',
    }])).toEqual([])
  })

  it('C432-GUIDANCE-DIRECT: the guide, the knowledge skill and its reference, and the README each state the change rule', () => {
    const subjects = directGuidanceSubjects()
    const ruleBearing = subjects.filter((subject) =>
      subject.name === 'generated guide'
      || subject.name === 'knowledge README'
      || (subject.name.includes(`/${KNOWLEDGE_SKILL_NAME}/`) && subject.name.endsWith('.md')))
    // guide + README + (SKILL.md + knowledge-reads.md) in both the source and the packaged tree.
    expect(ruleBearing.map((subject) => subject.name).length).toBe(6)
    expect(ruleBearing.flatMap(knowledgeRuleFindings), 'a knowledge text omits part of the D-24 rule')
      .toEqual([])
    for (const subject of ruleBearing.filter((candidate) => candidate.name !== 'knowledge README')) {
      expect(toolTokensIn(subject.body), `${subject.name}: the change tool`).toContain('agent_qa_change_knowledge')
    }
    expect(knowledgeRuleFindings({ name: 'planted', body: 'Edit the fact or the evidence.' })).toHaveLength(4)
  })

  // The texts 432-40 replaced, as a historical witness: each sentence the census would have to
  // miss for the old wording to return is named by it. Assembled from fragments so this file's own
  // body is not a guidance subject that carries them.
  it('C432-GUIDANCE-DIRECT: the replaced README and authoring wording is named by the census', () => {
    const replaced = approvalFindings([
      { name: 'old README', body: ['content humans write or ', 'approve', ' — QA rules.'].join('') },
      { name: 'old README staging', body: ['pending skill writes awaiting ', 'approval', '.'].join('') },
      { name: 'old README pointer', body: ['the agent-qa design docs: `', 'spec/v2', '/knowledge-store.md`'].join('') },
      { name: 'old authoring', body: ['`tools/list` names every tool your ', 'grants', ' let you see'].join('') },
      { name: 'old authoring posture', body: ['default scopes, ', 'safe-mode', ' state'].join('') },
      { name: 'old authoring inbox', body: ['there is no apply step and no review ', 'inbox'].join('') },
      { name: 'old migration route', body: ['the change arrives as a reviewable ', 'proposal'].join('') },
    ])
    expect(replaced).toEqual([
      'old README: "approve" describes an approval',
      'old README staging: "approval" describes an approval',
      'old README staging: "pending" describes a pending review',
      'old README pointer: "spec/v2" describes a design-doc path',
      'old authoring: "grants" describes a grant',
      'old authoring posture: "default scopes" describes a caller credential',
      'old authoring inbox: "inbox" describes an inbox',
      'old migration route: "proposal" describes a proposal',
    ])
  })

  it('C432-GUIDANCE-DIRECT: the authoring skill names the change tools and the written-test receipt, and no review step', () => {
    const authoring = directGuidanceSubjects().filter((subject) =>
      subject.name.endsWith('/agent-qa-authoring/SKILL.md'))
    expect(authoring.map((subject) => subject.name).sort()).toEqual([
      'packages/cli/skills/agent-qa-authoring/SKILL.md',
      'skills/agent-qa-authoring/SKILL.md',
    ])
    for (const subject of authoring) {
      for (const tool of ['agent_qa_write_test', 'agent_qa_refine_test', 'agent_qa_change_config']) {
        expect(toolTokensIn(subject.body), `${subject.name}: ${tool}`).toContain(tool)
      }
      expect(subject.body, `${subject.name}: the written-test receipt`).toMatch(/`written` receipt/u)
      expect(subject.body, `${subject.name}: the disposition`).toMatch(/disposition/u)
      expect(subject.body, `${subject.name}: changes apply in the call`).toMatch(/apply in the call/u)
      expect(subject.body, `${subject.name}: a review instruction`).not.toMatch(/\breview/iu)
    }
  })
})

/** Every file under one tree, as tree-relative POSIX paths. */
function treeFiles(root: string): readonly string[] {
  if (!existsSync(root)) return []
  return skillDirectoriesIn(root)
    .flatMap((skill) => filesUnderSkill(join(root, skill)).map((file) => relative(root, file)))
    .sort()
}

/** Where a packaged mirror differs from its source tree, file by file and byte by byte. */
function mirrorFindings(sourceRoot: string, packagedRoot: string): readonly string[] {
  const source = treeFiles(sourceRoot)
  const packaged = treeFiles(packagedRoot)
  const findings: string[] = []
  for (const file of source) {
    if (!packaged.includes(file)) {
      findings.push(`${file}: missing from the packaged mirror`)
      continue
    }
    if (!readFileSync(join(sourceRoot, file)).equals(readFileSync(join(packagedRoot, file)))) {
      findings.push(`${file}: the packaged copy differs from the source`)
    }
  }
  for (const file of packaged) {
    if (!source.includes(file)) findings.push(`${file}: in the packaged mirror with no source`)
  }
  if (source.length === 0) findings.push('no source skill file was read')
  return findings
}

describe('C432-PACKAGED-SKILLS: the packaged skills are the source skills, byte for byte', () => {
  it('C432-PACKAGED-SKILLS: every source skill file has a byte-identical packaged copy, and nothing else is packaged', () => {
    const sourceRoot = join(agentQaRoot(), SKILLS_SOURCE_DIR)
    const packagedRoot = join(agentQaRoot(), 'packages', 'cli', 'skills')
    expect(mirrorFindings(sourceRoot, packagedRoot), 'run pnpm --filter agent-qa copy:skills').toEqual([])
    const files = treeFiles(sourceRoot)
    for (const rewritten of [
      'agent-qa-knowledge/SKILL.md',
      'agent-qa-knowledge/references/knowledge-reads.md',
      'agent-qa-authoring/SKILL.md',
      'agent-qa-result-triage/SKILL.md',
    ]) {
      expect(files, `${rewritten} is not a shipped skill file`).toContain(rewritten)
    }
  })

  it('C432-PACKAGED-SKILLS: a one-byte drift, a missing copy and a stray copy are each named', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-432-40-mirror-'))
    try {
      const sourceRoot = join(root, 'source')
      const packagedRoot = join(root, 'packaged')
      cpSync(join(agentQaRoot(), SKILLS_SOURCE_DIR, KNOWLEDGE_SKILL_NAME), join(sourceRoot, KNOWLEDGE_SKILL_NAME), { recursive: true })
      cpSync(sourceRoot, packagedRoot, { recursive: true })
      expect(mirrorFindings(sourceRoot, packagedRoot)).toEqual([])

      const skill = join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'SKILL.md')
      writeFileSync(skill, `${readFileSync(skill, 'utf8')} `)
      const reference = join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'references', 'knowledge-reads.md')
      rmSync(reference)
      writeFileSync(join(packagedRoot, KNOWLEDGE_SKILL_NAME, 'stray.md'), 'stray\n')
      expect(mirrorFindings(sourceRoot, packagedRoot)).toEqual([
        `${KNOWLEDGE_SKILL_NAME}/SKILL.md: the packaged copy differs from the source`,
        `${KNOWLEDGE_SKILL_NAME}/references/knowledge-reads.md: missing from the packaged mirror`,
        `${KNOWLEDGE_SKILL_NAME}/stray.md: in the packaged mirror with no source`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Retired op ids and tool names, as whole tokens (432-12/17/18 deleted them). */
const RETIRED_CAPABILITY = /\bproposals\.(?:list|show|accept|reject)\b|\bgrants\.(?:list|revoke)\b|\b(?:knowledge|config)\.proposal\.apply\b|\bconfig\.undo\.propose\b|\bagent_qa_(?:propose_[a-z_]+|apply_[a-z_]*proposal|list_proposals|show_proposal)\b/u

/** Permission-shaped keys a catalogue row could carry. */
const PERMISSION_KEYS: readonly string[] = Object.freeze([
  'requiredScopes', 'requiresHumanOrigin', 'credential', 'defaultScopes', 'safeMode', 'grantedScopes',
])

function keysDeep(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...keysDeep(child)])
}

describe('C432-CATALOG-CURRENT: the committed catalogue describes only the live tree', () => {
  it('C432-CATALOG-CURRENT: op rows are the live registry, tools are the twenty projected tools, and no row names a retired capability or a permission', () => {
    const catalog = loadCapabilityCatalog()
    const opRows = catalog.rows.flatMap((row) => (row.kind === 'op' ? [row] : []))
    expect(sorted(opRows.map((row) => row.id)), 'op rows against the live registry census')
      .toEqual(sorted(registryOpIds()))

    const toolOf = new Map<string, string>()
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const op of projection.ops) toolOf.set(op, projection.name)
    }
    for (const row of opRows) {
      expect(row.mcpTool, `${row.id}: the row's MCP tool against the live mapping`).toBe(toolOf.get(row.id))
      expect(row.mcpTool === undefined, `${row.id}: a door, or the visible-absence key, never both`)
        .toBe(row.mcpUnprojectedReasonKey !== undefined)
    }
    const tools = sorted(opRows.flatMap((row) => (row.mcpTool === undefined ? [] : [row.mcpTool])))
    expect(tools, 'the catalogue tools against the live projections').toEqual(
      sorted(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name)),
    )
    expect(tools.length, 'the MCP tool count').toBe(20)
    expect(tools).toEqual(expect.arrayContaining(['agent_qa_change_knowledge', 'agent_qa_change_config']))

    const skillRows = catalog.rows.flatMap((row) => (row.kind === 'skill' ? [row.name] : []))
    expect(skillRows, 'skill rows against the shipped skills')
      .toEqual([...skillDirectoriesIn(join(agentQaRoot(), SKILLS_SOURCE_DIR))])
    expect(catalog.rowCount).toBe(catalog.rows.length)

    for (const row of catalog.rows) {
      const name = row.kind === 'op' ? row.id : row.kind === 'alias' ? row.alias : row.name
      expect(JSON.stringify(row).match(RETIRED_CAPABILITY), `${name}: names a retired capability`).toBeNull()
      expect(keysDeep(row).filter((key) => PERMISSION_KEYS.includes(key)), `${name}: a permission key`).toEqual([])
    }
    expect(catalog.$note.join(' '), 'the note still describes per-caller filtering or a grant')
      .not.toMatch(/per-caller|\bgrants?\b/iu)
  })
})

/** Source with block comments and whole-line `//` comments removed: what a reader is shown. */
function codeOf(relativePath: string): string {
  return readFileSync(join(agentQaRoot(), relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('C432-CURATION-COPY: curation and chat say where a change went, and point at no review', () => {
  it('C432-CURATION-COPY: a local fold reports what it applied; ci and cloud report what they kept proposed', () => {
    expect(curationOutcomeLine({ executionContext: 'local-interactive', committed: 3, downgraded: 0 }))
      .toBe('curation: 3 learned change(s) applied, 0 kept proposed (local runs apply learned knowledge to the knowledge root)')
    expect(curationOutcomeLine({ executionContext: 'local-headless', committed: 3, downgraded: 1 }))
      .toBe('curation: 2 learned change(s) applied, 1 kept proposed (local runs apply learned knowledge to the knowledge root)')
    expect(curationOutcomeLine({ executionContext: 'ci', committed: 2, downgraded: 2 }))
      .toBe('curation: 0 learned change(s) recorded, 2 kept proposed (ci runs never promote learned knowledge)')
    expect(curationOutcomeLine({ executionContext: 'cloud', committed: 1, downgraded: 1 }))
      .toBe('curation: 0 learned change(s) recorded, 1 kept proposed (cloud runs never promote learned knowledge)')
    // A fold that committed nothing says nothing, so the one-line drained hint stays one line.
    expect(curationOutcomeLine({ executionContext: 'ci', committed: 0, downgraded: 0 })).toBeUndefined()
    expect(curationOutcomeLine({ executionContext: undefined, committed: 1, downgraded: 5 }))
      .toBe('curation: 0 learned change(s) applied, 1 kept proposed (local runs apply learned knowledge to the knowledge root)')
  })

  it('C432-CURATION-COPY: the curation tail and the chat turn engine show no review command and no waiting step', () => {
    for (const file of [
      'packages/cli/src/curation/curation-tail.ts',
      'packages/agent/src/chat/turn-engine.ts',
    ]) {
      const code = codeOf(file)
      expect(code.length, `${file} read back empty`).toBeGreaterThan(1000)
      for (const pattern of [
        /agent-qa proposals/u,
        /review (?:with|it|them)\b/iu,
        /\b(?:pending|awaiting) (?:review|approval|acceptance)\b/iu,
        /\bproposals? (?:pending|waiting)\b/iu,
        /\bapprove\b/iu,
      ]) {
        expect(code.match(pattern), `${file} shows ${String(pattern)}`).toBeNull()
      }
    }
  })
})

// C446-GUIDANCE-KEYS (446-04, D-16): every dotted config key in the guidance resolves in the schema
function catalogOpIds(): ReadonlySet<string> {
  return new Set(loadCapabilityCatalog().rows.flatMap((row) => (row.kind === 'op' ? [row.id] : [])))
}

describe('C446-GUIDANCE-KEYS', () => {
  it('every dotted config key the guide, the pointer, the MCP instructions, the skills and the contracts file name resolves in the config schema', () => {
    const { subjects } = liveGuidanceInputs()
    const opIds = catalogOpIds()
    expect(subjects.map((subject) => subject.name)).toContain('MCP instructions')
    const contracts = subjects.filter((subject) => subject.name.endsWith('/agent-qa-contracts.json'))
    expect(contracts.map((subject) => subject.name).sort()).toEqual([
      'packages/cli/skills/agent-qa-authoring/references/agent-qa-contracts.json',
      'skills/agent-qa-authoring/references/agent-qa-contracts.json',
    ])

    const live = configKeyFindings(subjects, opIds)
    expect(live.findings, 'the guidance names a config key the schema refuses').toEqual([])
    expect(live.scanned, 'the key census scanned no key').toBeGreaterThan(0)
    const source = subjects.filter((subject) => subject.name.startsWith(`${SKILLS_SOURCE_DIR}/`))
    const packaged = subjects.filter((subject) => subject.name.startsWith('packages/cli/skills/'))
    expect(configKeyFindings(source, opIds).scanned, 'no key was scanned in the source skills')
      .toBeGreaterThan(0)
    expect(configKeyFindings(packaged, opIds).scanned, 'no key was scanned in the packaged skills')
      .toBeGreaterThan(0)
  })

  it('a key the schema lacks is named, and a census that finds no key fails', () => {
    const opIds = catalogOpIds()
    const planted = configKeyFindings([{
      name: 'planted',
      body: [
        'Set `safety.trustMode`, `services.mcp.tokens`, `embedder.profile`',
        'and `workspace.secretsfile`.',
        'Keep `workspace.secretsFile`, `use.timeout.test` and `services.dashboard.baseUrl`.',
        'Read `runs.evidence`, then `record.md`; send `"action": "knowledge.accept"`.',
      ].join('\n'),
    }], opIds)
    expect(planted.findings, 'the key census accepts a key the schema refuses').toEqual([
      'planted: embedder.profile is not a config key',
      'planted: safety.trustMode is not a config key',
      'planted: services.mcp.tokens is not a config key',
      'planted: workspace.secretsfile is not a config key',
    ])
    expect(planted.scanned).toBe(7)
    expect(configKeyFindings([], opIds).findings).toEqual(['no config key was scanned'])
    expect(configKeyFindings([{ name: 'generated guide', body: 'no keys here' }], opIds).findings)
      .toEqual(['no config key was scanned'])
  })
})

const SKILL_TREES = [`${SKILLS_SOURCE_DIR}/`, 'packages/cli/skills/'] as const

function skillSubjects(): readonly GuidanceSubject[] {
  return liveGuidanceInputs().subjects.filter((subject) =>
    SKILL_TREES.some((tree) => subject.name.startsWith(tree)))
}

function bareInvocations(subjects: readonly GuidanceSubject[]): readonly string[] {
  return subjects.flatMap((subject) => invocationsIn(subject.body)
    .filter((invocation) => invocation.fence !== 'text' && !invocation.prefixed)
    .map((invocation) => `${subject.name}: "${invocation.text}" is not prefixed with npx`))
}

// C446-GUIDANCE-NPX (446-06, D-09): every command a skill quotes can be copied and run with a local install
describe('C446-GUIDANCE-NPX', () => {
  it('every CLI command a source or packaged skill quotes outside a text block reads npx agent-qa', () => {
    const skills = skillSubjects()
    for (const tree of SKILL_TREES) {
      const quoted = skills
        .filter((subject) => subject.name.startsWith(tree))
        .flatMap((subject) => invocationsIn(subject.body).filter((invocation) => invocation.fence !== 'text'))
      expect(quoted.length, `no CLI command was found in ${tree}`).toBeGreaterThan(0)
    }
    expect(bareInvocations(skills), 'a skill quotes a CLI command without npx').toEqual([])
  })

  it('a bare agent-qa command outside a text block is named, and a text block quoting CLI output is not', () => {
    const body = [
      'Run `agent-qa runs list`, then `npx agent-qa runs overview <runId>`.',
      '',
      '```text',
      'Next: agent-qa runs overview r-1',
      '```',
      '',
      '```sh',
      'agent-qa knowledge bundles',
      'npx agent-qa knowledge inspect',
      '```',
    ].join('\n')
    expect(invocationsIn(body).map(({ text, prefixed, fence }) => [text, prefixed, fence])).toEqual([
      ['agent-qa runs overview r-1', false, 'text'],
      ['agent-qa knowledge bundles', false, 'sh'],
      ['agent-qa knowledge inspect', true, 'sh'],
      ['agent-qa runs list', false, ''],
      ['agent-qa runs overview <runId>', true, ''],
    ])
    expect(bareInvocations([{ name: 'planted', body }])).toEqual([
      'planted: "agent-qa knowledge bundles" is not prefixed with npx',
      'planted: "agent-qa runs list" is not prefixed with npx',
    ])
    const markdown = ['```md', '<!-- agent-qa init:start -->', '- Runs: `agent-qa runs list`', '```'].join('\n')
    expect(invocationsIn(markdown).map(({ text, prefixed, fence }) => [text, prefixed, fence]))
      .toEqual([['agent-qa runs list', false, '']])
  })

  // 2026-10-20 (446-07, D-09, D-29): the map keeps bare verbs; only its rendering adds npx
  it('every CLI command the guide, the pointer and the MCP instructions quote reads npx agent-qa, while the question map keeps bare verbs', () => {
    const names: readonly string[] = ['generated guide', 'root pointer', 'MCP instructions']
    const generated = liveGuidanceInputs().subjects.filter((subject) => names.includes(subject.name))
    expect(generated.map((subject) => subject.name)).toEqual(names)
    for (const subject of generated) {
      expect(invocationsIn(subject.body).length, `no CLI command was found in the ${subject.name}`)
        .toBeGreaterThan(0)
    }
    expect(bareInvocations(generated), 'generated guidance quotes a CLI command without npx').toEqual([])
    expect(AGENT_QUESTION_MAP.map((row) => row.cli).filter((cli) => !cli.startsWith('agent-qa ')))
      .toEqual([])
  })

})

const EVIDENCE_KINDS = ['console', 'network', 'a11y', 'aria', 'variables'] as const

// C446-PLACEHOLDERS (446-06, D-15): a skill explains each placeholder where it uses it
describe('C446-PLACEHOLDERS', () => {
  it('every skill that names the build placeholder says it is a build ordinal or tag, and every skill that names runs evidence --kind names the five evidence kinds', () => {
    const findings: string[] = []
    let builds = 0
    let kinds = 0
    for (const subject of skillSubjects()) {
      if (subject.body.includes('<build>')) {
        builds += 1
        if (!/build ordinal or tag/u.test(subject.body)) {
          findings.push(`${subject.name}: names <build> without saying it is a build ordinal or tag`)
        }
      }
      if (subject.body.includes('runs evidence') && subject.body.includes('--kind <kind>')) {
        kinds += 1
        for (const kind of EVIDENCE_KINDS) {
          if (!new RegExp(`\\b${kind}\\b`, 'u').test(subject.body)) {
            findings.push(`${subject.name}: names runs evidence --kind <kind> without the ${kind} kind`)
          }
        }
      }
    }
    expect(builds, 'no skill names the build placeholder').toBeGreaterThan(0)
    expect(kinds, 'no skill names runs evidence --kind').toBeGreaterThan(0)
    expect(findings, 'a skill uses a placeholder it does not explain').toEqual([])
  })

  it('the guide says the build placeholder is a build ordinal or tag and names the five evidence kinds', () => {
    const guide = buildKnowledgeAgentGuide()
    const prose = guide.split('\n')
      .filter((line) => line.includes('knowledge diff <build>') && !line.startsWith('|'))
    expect(prose.length, 'the guide names knowledge diff <build> nowhere outside its table').toBeGreaterThan(0)
    expect(prose.filter((line) => !/build ordinal or tag/u.test(line)), 'the guide leaves <build> unexplained')
      .toEqual([])
    expect(EVIDENCE_KINDS.filter((kind) => !new RegExp(`\\b${kind}\\b`, 'u').test(guide))).toEqual([])
  })
})

// 2026-10-21 (446-15, D-32): a forced init rebuilds agent-qa.config.yaml; a backtick ends a code span
const INIT_FORCE = /\binit\b[^`\n]*--force\b/u

function initForceFindings(
  subjects: readonly GuidanceSubject[],
): { readonly scanned: number; readonly findings: readonly string[] } {
  let scanned = 0
  const findings: string[] = []
  for (const subject of subjects) {
    for (const line of subject.body.split('\n')) {
      scanned += 1
      if (INIT_FORCE.test(line)) findings.push(`${subject.name}: ${line.trim()}`)
    }
  }
  return { scanned, findings: sorted(findings) }
}

// C446-NO-INIT-FORCE (446-15, D-32): agent-facing guidance never hands an agent a forced init
describe('C446-NO-INIT-FORCE', () => {
  it('no agent-facing guidance offers agent-qa init with --force, which rebuilds the workspace config', () => {
    const { subjects } = liveGuidanceInputs()
    const names = subjects.map((subject) => subject.name)
    for (const name of ['generated guide', 'root pointer', 'MCP instructions']) {
      expect(names, `the census did not scan the ${name}`).toContain(name)
    }
    expect(names.filter((name) => name.endsWith('/SKILL.md')).length,
      'the census scanned fewer than eight SKILL.md files').toBeGreaterThanOrEqual(8)
    const { scanned, findings } = initForceFindings(subjects)
    expect(scanned, 'the census scanned no line').toBeGreaterThan(0)
    expect(findings, 'agent-facing guidance offers an init command with --force').toEqual([])
  })

  it('an init command with --force in planted guidance is named, a plain init is not, and a census that scans nothing fails', () => {
    expect(initForceFindings([{
      name: 'planted',
      body: 'Generated by agent-qa init; `npx agent-qa init --force` regenerates it.',
    }])).toEqual({
      scanned: 1,
      findings: ['planted: Generated by agent-qa init; `npx agent-qa init --force` regenerates it.'],
    })
    expect(initForceFindings([{
      name: 'planted',
      body: ['Run `npx agent-qa init` once.', '', '```sh', 'npx agent-qa init --agent', '```'].join('\n'),
    }])).toEqual({ scanned: 5, findings: [] })
    expect(initForceFindings([])).toEqual({ scanned: 0, findings: [] })
  })
})
