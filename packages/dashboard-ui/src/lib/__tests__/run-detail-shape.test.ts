/**
 * THE REBUILT RUN-DETAIL SHAPE IS CLOSED (405-13, D-21 / DETL-06).
 *
 * WHAT THIS PINS. 405-11 deleted the v1 UI step shape — the recording-path fields, the healing
 * screenshot list and the run-detail-only sub-action DTO — and rebuilt the page on the durable
 * projection. Each of those is a set that got SMALLER, and every existing cell on this page asks
 * whether a shape CONTAINS what it should, which a bigger shape satisfies too. So the deletions are
 * pinned by EQUALITY here, and leg U of the phase's mutation driver (since removed) proved the pin
 * reds by re-adding a recording-path field to `DisplayStep`.
 *
 * TWO WALLS, BOTH READ. `DisplayStep` and `RunDetailSubAction` are TypeScript, so a returning field
 * is a compile question first — the `satisfies` pins below make `pnpm --filter
 * @vostride/agent-qa-dashboard-ui typecheck` refuse a key set that drifted. But a type is erased
 * before anything runs, and this package's vitest does not typecheck, so a leg reading only the
 * compiler would go quiet the day somebody widens a shape with a cast. The runtime halves therefore
 * read the SOURCE TEXT of the interface and the SHIPPED zod shape.
 *
 * THE MARKUP CELL READS CODE, NOT PROSE. Three modules under `components/run-detail` carry comments
 * explaining that they inject no markup — that is the safety claim's audit trail, and a raw
 * substring search reports every one of them as an offender. A detector that cannot tell a call
 * from a sentence about a call reds on prose (which trains everyone to weaken it) and its natural
 * weakening — excluding the files that talk about the rule — stops covering exactly the files most
 * likely to break it. This is the argument `packages/analytics/src/__tests__/source-scan.ts` makes
 * verbatim for `.strip()`; the scanner is re-derived here rather than imported because the two
 * packages do not depend on each other.
 *
 * That is a DIFFERENT rule from the D-21 inventory in `dashboard-server`, which counts comments as
 * hits on purpose. There the forbidden thing IS the string (a retired token must not be spelled
 * anywhere); here the forbidden thing is an INJECTION SITE, and a sentence is not one.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { RunDetailSubActionSchema, type RunDetailSubAction } from '@vostride/agent-qa-schema'
import type { DisplayStep } from '../display-step'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `src/lib/__tests__` -> `src`. */
const SRC_DIR = join(HERE, '..', '..')

// ---------------------------------------------------------------------------------------------
// RunDetailSubAction — exactly the bus payload's fields
// ---------------------------------------------------------------------------------------------

/**
 * The `subActionRecorded` payload's field set, verbatim and in the producer's order. The v1 DTO
 * this replaced (`SubActionData`) carried five more, all of them run-detail-only recording paths.
 */
const SUB_ACTION_KEYS = [
  'testIndex',
  'stepIndex',
  'subActionIndex',
  'plan',
  'plannedAction',
  'grounding',
  'result',
  'screenStateHash',
  'screenStateHashAfter',
  'artifactRefs',
  'ariaEvidence',
  'recordingOffsetMs',
] as const

describe('RunDetailSubAction is exactly the sub-action payload', () => {
  // THE SHIPPED SHAPE, not a retyped copy. Reached through the published schema the UI itself
  // parses with, so a key added to the projection is a key this cell sees.
  it('declares exactly the payload key set, in the producer order', () => {
    const shape = (RunDetailSubActionSchema as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).toEqual([...SUB_ACTION_KEYS])
  })

  // THE TYPE WALL. `Record<keyof RunDetailSubAction, true>` is unsatisfiable by an object literal
  // that is missing a key, so a field added to the interface fails `tsc --noEmit` here even if the
  // zod shape were widened in the same commit.
  it('pins the same key set at the type level', () => {
    const exhaustive = {
      testIndex: true,
      stepIndex: true,
      subActionIndex: true,
      plan: true,
      plannedAction: true,
      grounding: true,
      result: true,
      screenStateHash: true,
      screenStateHashAfter: true,
      artifactRefs: true,
      ariaEvidence: true,
      recordingOffsetMs: true,
    } satisfies Record<keyof RunDetailSubAction, true>

    expect(Object.keys(exhaustive).sort()).toEqual([...SUB_ACTION_KEYS].sort())
    expectTypeOf<keyof RunDetailSubAction>().toEqualTypeOf<(typeof SUB_ACTION_KEYS)[number]>()
  })

  // NON-VACUITY on the negative claim. The five v1 recording-path fields are named rather than
  // merely absent — needles built from two halves so this file does not answer the phase's own
  // grep inventory with itself.
  it('carries none of the five v1 recording-path fields', () => {
    const retired = [
      'screenshot' + 'Path',
      'screenshotBef' + 'orePath',
      'healingScreen' + 'shotPaths',
      'video' + 'Path',
      'reasoning' + 'Trace',
    ]
    const keys = Object.keys(
      (RunDetailSubActionSchema as unknown as { shape: Record<string, unknown> }).shape,
    )
    for (const field of retired) expect(keys).not.toContain(field)
  })
})

// ---------------------------------------------------------------------------------------------
// DisplayStep — no path-named member survives
// ---------------------------------------------------------------------------------------------

/**
 * The member names declared on an interface, read out of the source.
 *
 * SOURCE TEXT, DELIBERATELY. The runtime has no `DisplayStep` object to enumerate — it is a type
 * over two producers with different optional halves — so a key pin over a sample value would only
 * ever see the keys that sample happens to set. Reading the declaration is the only instrument that
 * reds when a member is ADDED but never assigned, which is exactly how a path field comes back.
 */
function interfaceMemberNames(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`)
  if (start === -1) throw new Error(`interface ${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  const names: string[] = []
  let nesting = 0
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    // Only TOP-LEVEL members are declarations of this interface; a key inside a nested object
    // literal type (the console/network log rows) belongs to that row, not to the step.
    if (nesting === 0) {
      const match = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
      if (match?.[1] !== undefined) names.push(match[1])
    }
    nesting += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length
  }
  return names
}

const DISPLAY_STEP_SOURCE = readFileSync(join(SRC_DIR, 'lib', 'display-step.ts'), 'utf8')

/** A member whose NAME claims a recording path, a healing capture or a video. */
const PATH_NAMED = /screenshot|healing|video|Path$/i

describe('DisplayStep carries no path-named member', () => {
  it('has a non-trivial member list — the control for the extractor', () => {
    const members = interfaceMemberNames(DISPLAY_STEP_SOURCE, 'DisplayStep')
    expect(members.length).toBeGreaterThan(15)
    // The three fields the durable projection genuinely supplies, so the extractor is reading the
    // interface it thinks it is reading rather than an empty body.
    expect(members).toContain('subActions')
    expect(members).toContain('tokenUsage')
    expect(members).toContain('verifierVerdict')
  })

  it('finds a planted path-named member — the known-positive control', () => {
    // The planted member is assembled from two halves like every other needle in this phase, so
    // this file cannot be the hit a repo-wide grep for the retired field reports.
    const plantedMember = 'screenshot' + 'Path'
    const planted = [
      'export interface Planted {',
      '  id: string',
      `  ${plantedMember}?: string`,
      '}',
    ].join('\n')
    const offenders = interfaceMemberNames(planted, 'Planted').filter((m) => PATH_NAMED.test(m))
    expect(offenders).toEqual([plantedMember])
  })

  it('declares no member naming a screenshot, a healing capture, a video or a path', () => {
    const offenders = interfaceMemberNames(DISPLAY_STEP_SOURCE, 'DisplayStep').filter((member) =>
      PATH_NAMED.test(member),
    )
    expect(
      offenders,
      `a v1 recording-path member returned to DisplayStep: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  // The type wall for the same claim: `Extract` over the key union is `never` only while no key
  // matches, so this fails `tsc --noEmit` the moment one does.
  it('pins the absence at the type level too', () => {
    type PathNamed = Extract<keyof DisplayStep, `${string}Path` | `${string}Paths`>
    expectTypeOf<PathNamed>().toEqualTypeOf<never>()
  })
})

// ---------------------------------------------------------------------------------------------
// No run-detail component injects markup
// ---------------------------------------------------------------------------------------------

/**
 * The source with line and block comments removed and string/template literals kept intact.
 *
 * Literals are preserved on purpose: a token inside a string is data the module really carries —
 * it can be printed, matched or rendered — while a token inside a comment can be none of those.
 * The scanner tracks quoting so a `//` inside a URL does not start a comment.
 */
function withoutComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]

    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }

    out += char
    index += 1
  }

  return out
}

function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : componentFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const RUN_DETAIL_DIR = join(SRC_DIR, 'components', 'run-detail')
const MARKUP_SINK = 'dangerously' + 'SetInnerHTML'

describe('no run-detail component injects markup', () => {
  it('scans the whole run-detail component directory', () => {
    expect(componentFiles(RUN_DETAIL_DIR).length).toBeGreaterThan(15)
  })

  it('the scanner drops comments, keeps literals, and survives a URL', () => {
    const stripped = withoutComments(
      [
        `// a comment naming ${MARKUP_SINK} and why there is none`,
        `/* a block comment naming ${MARKUP_SINK} too */`,
        'const host = "https://example.test/a" // trailing',
        `const call = <div ${MARKUP_SINK}={{ __html: html }} />`,
      ].join('\n'),
    )

    expect(stripped).not.toContain('a comment naming')
    expect(stripped).not.toContain('a block comment')
    expect(stripped).toContain('https://example.test/a')
    // The known-positive control: a REAL injection site survives the strip and is found.
    expect(stripped).toContain(MARKUP_SINK)
  })

  it('no module under components/run-detail reaches the markup sink in code', () => {
    const offenders = componentFiles(RUN_DETAIL_DIR)
      .filter((file) => withoutComments(readFileSync(file, 'utf8')).includes(MARKUP_SINK))
      .map((file) => file.slice(SRC_DIR.length + 1))
    expect(
      offenders,
      `a run-detail component injects markup: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
