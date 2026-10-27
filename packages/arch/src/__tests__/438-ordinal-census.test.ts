/**
 * THE POSITION-PICK CENSUS (Phase 438, V2-EXEC-04 / SC3; D-11, D-13).
 *
 * Phase 438 removed every path that chose an element by its position among look-alikes, and
 * the silent invalidation of a cached plan whose stored target did not replay. Each cell here
 * REDs if one of them returns, with no mutation driver, following the 436 and 437 censuses:
 * comments are blanked by the same lexer, every needle is assembled from two halves at run time,
 * each cell scans only the file or function region it guards, and C438-SELF-MATCH proves this
 * file spells none of them. The census reads agent-qa's own packages only (434 D-14).
 *
 * The word for a position is overloaded (build, turn, step and knowledge positions all use it),
 * so no cell greps the bare word across the tree: identifiers are read per region.
 *
 * FORMER SITES AND WHAT REPLACED EACH (cell in brackets)
 *
 *   web/src/element-resolver.ts, web/src/types.ts   a role locator narrowed by the builder's
 *                                                   position -> the native aria-ref binding with
 *                                                   role, exact name and row text (438-05)
 *                                                   [C438-NO-WEB-POSITION, C438-NO-BINDING-POSITION]
 *   runner/src/grounding/matcher.ts, gate.ts        the position tiebreak before the hierarchy
 *                                                   check -> two survivors stay ambiguous; the
 *                                                   gate copies only the matcher's fields (438-11)
 *                                                   [C438-NO-MATCHER-POSITION]
 *   runner/src/cache/port.ts, value.ts, reground.ts a stored role + normalized name + position
 *                                                   -> role, exact name and row words replayed
 *                                                   through strictMatch (438-08)
 *                                                   [C438-NO-CACHE-POSITION]
 *   runner/src/loop/index.ts, exact-key hit branch  a key hit that did not replay was invalidated
 *                                                   silently -> the miss is recorded with its typed
 *                                                   reason first (recordCacheMiss, 438-09)
 *                                                   [C438-CACHE-MISS-RECORDED]
 *   runner/src/loop/index.ts, procedure replay      stored and derived positions in the matcher
 *                                                   call and the recovery context -> strictMatch,
 *                                                   a legacy body is descriptor-missing (438-10)
 *                                                   [C438-NO-PROCEDURE-POSITION]
 *   runner/src/loop/index.ts, regroundFailedRef     the heal re-found by position -> the strict
 *                                                   heal (438-07) [C438-NO-HEAL-POSITION]
 *   runner/src/tools/actions/index.ts,              a position key on the planner's target ->
 *   schema/src/action/params.ts                     role, name and row words (438-04)
 *                                                   [C438-NO-TARGET-POSITION]
 *   runner/src/screen-builder.ts,                   the per-screen position minted on the binding
 *   core/src/mobile/types.ts, xml-parser.ts         and the mobile ref entries -> node index only
 *                                                   (438-11) [C438-NO-BINDING-POSITION]
 *   ios/src/adapter.ts, locateIOSTextTarget         the same-type position checked first -> one
 *                                                   unique bounds match or nothing (438-12)
 *                                                   [C438-NO-IOS-POSITION]
 *   cli/src/curation/emit-candidates.ts,            a computed position written into procedure
 *   curator-author.ts                               targets -> exact name and row words (438-10)
 *                                                   [C438-NO-CURATION-POSITION]
 *
 * RECORD-ONLY, CLASSIFIED (record a position, never pick by it) [C438-RECORD-ONLY-CLASSIFIED]
 *
 *   schema/src/identity/exercised-anchors.ts        record-only: the dedup identity of resolved
 *                                                   element evidence and its `el` anchor
 *   schema/src/screen/distilled-state-digest.ts     record-only: one term of a screen digest
 *   runner/src/loop/index.ts                        record-only: the failed element's knowledge
 *     (deriveFailureCautionAnchors)                 `el` anchor for caution recall
 *   runner/src/loop/memory-tools.ts                 record-only: the optional key of the
 *                                                   model-facing `el` recall anchor; it narrows
 *                                                   which knowledge records match, never an element
 *   cli/src/curation/curator-author.ts              record-only: the same optional `el` key in
 *     (anchorSchema)                                the curator's anchor schema
 *   eval/src/                                       record-only: the eval core's offline adversarial
 *                                                   scoring identity; no run path reads it
 *
 * The position helper in schema/src/screen/element-ordinal.ts is called only at the sites above.
 * TargetDescriptor's and ProcedureGuardTarget's optional position is read from old handoffs and
 * committed bodies so they still parse; nothing writes it, and the procedure and heal cells prove
 * no matcher call reads it.
 *
 * Pitfall 2: a snapshot between observe and dispatch other than a `:root` ai-mode one replaces
 * the frame's ref map and unbinds every observed ref [C438-ROOT-AI-SNAPSHOT-ONLY].
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
const OWN = 'arch/src/__tests__/438-ordinal-census.test.ts'

// ---------------------------------------------------------------------------------------------
// The lexer (the 432, 436 and 437 censuses'): comments out, everything else in
// ---------------------------------------------------------------------------------------------

function regexAllowed(out: string): boolean {
  let k = out.length - 1
  while (k >= 0 && /\s/.test(out[k]!)) k--
  if (k < 0) return true
  if ('(,=:[!&|?{};+-*%<>~^'.includes(out[k]!)) return true
  const word = /([A-Za-z_$][\w$]*)$/.exec(out.slice(0, k + 1))
  return word !== null
    && ['return', 'typeof', 'case', 'yield', 'await', 'in', 'of', 'void', 'delete'].includes(word[1]!)
}

function codeOf(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  const templateDepths: number[] = []
  let depth = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < n) {
    const c = text[i]!
    const d = text[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '/' && regexAllowed(out)) {
        let j = i + 1
        let inClass = false
        while (j < n && text[j] !== '\n') {
          const ch = text[j]
          if (ch === '\\') { j += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) break
          j++
        }
        if (j < n && text[j] === '/') {
          j++
          while (j < n && /[a-z]/i.test(text[j]!)) j++
          out += text.slice(i, j)
          i = j
          continue
        }
      }
      if (c === "'") { state = 'single'; out += c; i++; continue }
      if (c === '"') { state = 'double'; out += c; i++; continue }
      if (c === '`') { state = 'template'; out += c; i++; continue }
      if (c === '{') { depth++; out += c; i++; continue }
      if (c === '}') {
        if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
          templateDepths.pop()
          depth--
          state = 'template'
          out += c
          i++
          continue
        }
        depth--
        out += c
        i++
        continue
      }
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"'
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === quote || c === '\n') state = 'code'
      out += c
      i++
      continue
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === '`') { state = 'code'; out += c; i++; continue }
    if (c === '$' && d === '{') { depth++; templateDepths.push(depth); state = 'code'; out += '${'; i += 2; continue }
    out += c
    i++
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The universes: production source by the 412 path rule, read as bytes
// ---------------------------------------------------------------------------------------------

function listTree(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(PACKAGES_DIR, dir))) return
    for (const entry of readdirSync(join(PACKAGES_DIR, dir), { withFileTypes: true })) {
      const child = `${dir}${entry.name}`
      if (entry.isDirectory()) walk(`${child}/`)
      else if (/\.tsx?$/.test(entry.name)) files.push(child)
    }
  }
  walk(root)
  return files.sort()
}

const isProduction = (file: string): boolean =>
  !file.includes('/__tests__/') && !/\.test(-d)?\.tsx?$/.test(file)

function filesOf(region: string): string[] {
  if (region.endsWith('/')) return listTree(region).filter(isProduction)
  return existsSync(join(PACKAGES_DIR, region)) ? [region] : []
}

const bytesOf = (file: string): string => readFileSync(join(PACKAGES_DIR, file)).toString('utf8')

const codeCache = new Map<string, string>()
function code(file: string): string {
  let cached = codeCache.get(file)
  if (cached === undefined) {
    cached = existsSync(join(PACKAGES_DIR, file)) ? codeOf(bytesOf(file)) : ''
    codeCache.set(file, cached)
  }
  return cached
}

function scanned(regions: readonly string[]): string[] {
  return [...new Set(regions.flatMap(filesOf))]
}

function everyProductionRegion(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'src')))
    .map((name) => `${name}/src/`)
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

function hitsIn(label: string, text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
    .map((m) => `${label}:${lineAt(text, m.index)}: ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`)
}

// ---------------------------------------------------------------------------------------------
// The needles, every one assembled from two halves
// ---------------------------------------------------------------------------------------------

type Halves = readonly [string, string]
const joined = (halves: Halves): string => halves[0] + halves[1]
const cat = (...parts: string[]): string => parts.join('')
const rx = (halves: Halves, flags = ''): RegExp => new RegExp(joined(halves), flags)

/** An identifier naming a position: the overloaded word and Playwright's spelling of it. */
const POSITION_NAME: Halves = ['\\b(?:ordi', 'nal|n(?=th\\b)th)\\b']
/** The same, plus the plain word, for model-facing shapes and renderers. */
const POSITION_TEXT: Halves = ['\\b(?:ordi', 'nal|n(?=th\\b)th|position)\\b']
const POSITION_KEY: Halves = ['^(?:ordi', 'nal|n(?=th$)th|position|sameTypeIndex)$']
const HELPER_CALL: Halves = ['\\belementOrdi', 'nal\\s*\\(']
const HELPER_DECLARATION: Halves = ['\\bfunction\\s+elementOrdi', 'nal\\s*\\(']
const HELPER_HOME = 'schema/src/screen/element-ordinal.ts'

const PLAYWRIGHT_NTH: Halves = ['\\.n', 'th\\s*\\(']
const PLAYWRIGHT_FIRST_LAST: Halves = ['\\.(?:fir', 'st|last)\\s*\\(\\s*\\)']
const TEXT_RECEIVER: Halves = ['getByTe', 'xt\\([^()]*\\)\\s*$']
const TEXT_ENDING: Halves = ['^\\s*\\.(?:waitFor|scrollIntoView', 'IfNeeded)\\s*\\(']
const ROLE_LOCATOR: Halves = ['\\bget', 'By(?:Role|Label|Text|Placeholder|AltText|Title|TestId)\\s*\\(']
const NATIVE_REF_LOCATOR: Halves = ["this.page.locator('aria-ref=' + data.native", 'Ref)']

const SNAPSHOT_CALL: Halves = ['\\.ariaSnap', 'shot\\s*\\(']
const ROOT_RECEIVER: Halves = ["\\.locator\\(\\s*':ro", "ot'\\s*\\)\\s*$"]
const AI_MODE: Halves = ["^\\(\\s*\\{\\s*mode\\s*:\\s*'a", "i'"]
const OBSERVE_PAGE_CALL: Halves = ['\\bobserve', 'Page\\s*\\(']

const MATCHER = 'runner/src/grounding/matcher.ts'
const GATE = 'runner/src/grounding/gate.ts'
const STRICT = 'runner/src/grounding/strict-match.ts'
const CACHE_PORT = 'runner/src/cache/port.ts'
const CACHE_VALUE = 'runner/src/cache/value.ts'
const REGROUND = 'runner/src/cache/reground.ts'
const LOOP_INDEX = 'runner/src/loop/index.ts'
const MEMORY_TOOLS = 'runner/src/loop/memory-tools.ts'
const TOOL_ACTIONS = 'runner/src/tools/actions/index.ts'
const PARAMS = 'schema/src/action/params.ts'
const BUILDER = 'runner/src/screen-builder.ts'
const MOBILE_TYPES = 'core/src/mobile/types.ts'
const XML_PARSER = 'core/src/mobile/xml-parser.ts'
const IOS_ADAPTER = 'ios/src/adapter.ts'
const EMIT_CANDIDATES = 'cli/src/curation/emit-candidates.ts'
const CURATOR_AUTHOR = 'cli/src/curation/curator-author.ts'
const WEB = 'web/src/'
const WEB_RESOLVER = 'web/src/element-resolver.ts'
const WEB_TYPES = 'web/src/types.ts'
const WEB_OBSERVER = 'web/src/observer.ts'
const SNAPSHOT_FILES = [
  'web/src/adapter.ts',
  'web/src/binding.ts',
  WEB_RESOLVER,
  'web/src/compound-web.ts',
  'web/src/scroll-helper.ts',
] as const

const DIGEST = 'schema/src/screen/distilled-state-digest.ts'
const EXERCISED = 'schema/src/identity/exercised-anchors.ts'
const EVAL = 'eval/src/'
const CAUTION_FN = 'deriveFailureCautionAnchors'
const RECORD_ONLY_SITES = [EXERCISED, DIGEST, LOOP_INDEX, MEMORY_TOOLS, CURATOR_AUTHOR, EVAL] as const

const HIT_START: Halves = ['const hit = await ports.cache!.get(cache', 'Key)']
const HIT_END: Halves = ['if (!procedureReplayed && !cach', 'ed) {']
const REPLAY_CALL: Halves = ['replayFromCache(hit, screenState.ele', 'ments)']
const REPLAY_BRANCH: Halves = ['\\bif\\s*\\(\\s*replay(?:\\.o', 'k)?\\s*\\)\\s*\\{']
const MISS_CALL: Halves = ['.recordCache', 'Miss(']
const INVALIDATE_CALL: Halves = ['.invali', 'date(']
const STRICT_RETURN: Halves = ['return strictMatch(locator, ele', 'ments)']
const REPLAY_REGROUND: Halves = ['deterministicDescriptorMatcher.re', 'ground(']

const UNIQUE_RESOLVE: Halves = ["if (survivors.length === 1) return { kind: 'resolved', ref: survi", 'vors[0].ref }']
const SURVIVOR_INDEX: Halves = ['\\bsurvivors\\s*\\[', '([^\\]]*)\\]']
const STRICT_PROCEDURE_CALL: Halves = ['strictMatch({ role: target.role, name: target.name, row: target.', 'row }, elements)']
const STRICT_HEAL_CALL: Halves = ['strictMatch({ role: prior.role, name: prior.name, r', 'ow }, freshElements)']
const LOOSE_MATCHER_CALL: Halves = ['\\bmatchDescrip', 'tor\\s*\\(']
const IOS_UNIQUE: Halves = ['return matches.length === 1 ? matc', 'hes[0] : undefined']
const IOS_POSITION_SHAPES: readonly Halves[] = [
  ['Object\\.entries\\(\\s*this\\.last', 'Refs\\s*\\)'],
  ['\\.indexOf\\(\\s*r', 'ef\\s*\\)'],
  ['\\.(?:spl', 'ice|unshift)\\s*\\('],
  ['\\bi\\s*===\\s*ordi', 'nal\\b'],
]

/** The pre-438 spellings. None may appear in this file's bytes. */
const PRE_438_NEEDLES: readonly Halves[] = [
  ['locator.n', 'th(data.nth)'],
  ['this.page.getBy', 'Role(data.role as any'],
  ['if (i === ordi', 'nal) return { el, rect }'],
  ['ordinal: elementOrdi', 'nal(element, subAction.stateBefore.elements)'],
  ['return { kind: \'resolved\', ref: survivors', '[ordinal].ref }'],
  ['entry: RefMap[string] = { role: node.role, n', 'th: bind.nth }'],
]

// ---------------------------------------------------------------------------------------------
// Structural readers
// ---------------------------------------------------------------------------------------------

function regionBetween(text: string, start: string, end: string): string | undefined {
  const from = text.indexOf(start)
  if (from < 0) return undefined
  const to = text.indexOf(end, from + start.length)
  return to < 0 ? undefined : text.slice(from, to)
}

/** A top-level declaration from its opening line to its column-0 closing brace. */
function declaration(text: string, opening: RegExp): { start: number; body: string } | undefined {
  const m = opening.exec(text)
  if (m === null) return undefined
  const close = /\n\}(?=\n|$)/g
  close.lastIndex = m.index
  const end = close.exec(text)
  if (end === null) return undefined
  return { start: m.index, body: text.slice(m.index, end.index + 2) }
}

const fnOpening = (name: string): RegExp =>
  new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\s*[(<]`)
const typeOpening = (name: string): RegExp =>
  new RegExp(`(?:^|\\n)(?:export )?(?:interface ${name}\\b|type ${name}\\s*=)`)

function fnBody(text: string, name: string): string | undefined {
  return declaration(text, fnOpening(name))?.body
}

function typeBody(text: string, name: string): string | undefined {
  return declaration(text, typeOpening(name))?.body
}

/** A class member from its signature to the next member at the same indent. */
function methodBody(text: string, name: string): string | undefined {
  const start = new RegExp(`\\n  (?:private |public |protected )?(?:async )?${name}\\(`).exec(text)
  if (start === null) return undefined
  const rest = text.slice(start.index + 1)
  const next = /\n  (?:private|public|protected|async|static|get|set)\b/.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/** The names declared one level inside a type literal, interface or object literal. */
function membersOf(body: string): string[] {
  return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]!)
}

function positionKeys(body: string): string[] {
  const key = rx(POSITION_KEY)
  return membersOf(body).filter((member) => key.test(member))
}

/** The balanced `{ … }` that opens at `open`. */
function blockAt(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

const depthAt = (block: string, index: number): number =>
  [...block.slice(0, index)].reduce((d, c) => d + (c === '{' ? 1 : c === '}' ? -1 : 0), 0)

function indicesOf(text: string, needle: string): number[] {
  const out: number[] = []
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(at)
  return out
}

function webPositionOffenders(file: string, text: string): string[] {
  const offenders = hitsIn(file, text, rx(PLAYWRIGHT_NTH))
  for (const m of text.matchAll(rx(PLAYWRIGHT_FIRST_LAST, 'g'))) {
    const before = text.slice(Math.max(0, m.index - 200), m.index)
    const after = text.slice(m.index + m[0].length)
    if (rx(TEXT_RECEIVER).test(before) && rx(TEXT_ENDING).test(after)) continue
    offenders.push(`${file}:${lineAt(text, m.index)}: ${m[0]} on a locator that is not a text wait or scroll`)
  }
  return offenders
}

function snapshotOffenders(file: string, text: string): string[] {
  const offenders: string[] = []
  for (const m of text.matchAll(rx(SNAPSHOT_CALL, 'g'))) {
    const before = text.slice(Math.max(0, m.index - 200), m.index)
    const after = text.slice(m.index + m[0].length - 1)
    if (rx(ROOT_RECEIVER).test(before) && rx(AI_MODE).test(after)) continue
    offenders.push(`${file}:${lineAt(text, m.index)}: a snapshot that is not :root ai mode`)
  }
  return [...offenders, ...hitsIn(file, text, rx(OBSERVE_PAGE_CALL))]
}

function cacheMissOffenses(text: string): string[] {
  const region = regionBetween(text, joined(HIT_START), joined(HIT_END))
  if (region === undefined) return ['the exact-key hit region is not found']
  const out: string[] = []
  if (!region.includes(joined(REPLAY_CALL))) out.push('the hit region no longer replays through replayFromCache, so this scan is stale')
  const branch = rx(REPLAY_BRANCH).exec(region)
  if (branch === null) return [...out, 'the branch on the replay result is not found']
  const okOpen = branch.index + branch[0].length - 1
  const okBlock = blockAt(region, okOpen)
  const elseMatch = /^\s*else\s*\{/.exec(region.slice(okOpen + okBlock.length))
  if (elseMatch === null) return [...out, 'the path taken when the plan does not replay is not an else block']
  const elseOpen = okOpen + okBlock.length + elseMatch[0].length - 1
  const elseBlock = blockAt(region, elseOpen)
  const miss = elseBlock.indexOf(joined(MISS_CALL))
  if (miss < 0) out.push('the not-replayed path never records the miss')
  else if (depthAt(elseBlock, miss) !== 1) out.push('the not-replayed path records the miss only conditionally')
  const invalidations = indicesOf(region, joined(INVALIDATE_CALL))
  if (invalidations.length === 0) out.push('nothing in the hit region invalidates, so this scan is stale')
  for (const at of invalidations) {
    const inElse = at > elseOpen && at < elseOpen + elseBlock.length
    if (!inElse) out.push(`an invalidation outside the not-replayed path at region line ${lineAt(region, at)}`)
    else if (miss >= 0 && at - elseOpen < miss) out.push(`an invalidation before the recorded miss at region line ${lineAt(region, at)}`)
  }
  return out
}

function survivorIndexOffenses(body: string): string[] {
  const offenses = [...body.matchAll(rx(SURVIVOR_INDEX, 'g'))]
    .filter((m) => m[1]!.trim() !== '0')
    .map((m) => `matchDescriptor indexes its survivors by ${m[1]!.trim()}`)
  const zeroReads = [...body.matchAll(rx(SURVIVOR_INDEX, 'g'))].filter((m) => m[1]!.trim() === '0').length
  if (zeroReads !== 1 || !body.includes(joined(UNIQUE_RESOLVE))) {
    offenses.push('the only survivor read is not the single-survivor resolve')
  }
  return offenses
}

function iosPositionOffenses(body: string): string[] {
  const offenses = IOS_POSITION_SHAPES.flatMap((shape) => hitsIn('locateIOSTextTarget', body, rx(shape)))
  offenses.push(...hitsIn('locateIOSTextTarget', body, rx(POSITION_NAME, 'i')))
  if (!body.includes(joined(IOS_UNIQUE))) offenses.push('the lookup does not return only a unique bounds match')
  return offenses
}

function helperCallOffenders(files: readonly string[]): string[] {
  const offenders: string[] = []
  for (const file of files) {
    const text = code(file)
    const declared = new Set([...text.matchAll(rx(HELPER_DECLARATION, 'g'))].map((m) => m.index + m[0].indexOf('element')))
    for (const m of text.matchAll(rx(HELPER_CALL, 'g'))) {
      if (declared.has(m.index)) continue
      if (file === EXERCISED || file === DIGEST || file.startsWith(EVAL)) continue
      if (file === LOOP_INDEX) {
        const region = declaration(text, fnOpening(CAUTION_FN))
        if (region !== undefined && m.index > region.start && m.index < region.start + region.body.length) continue
      }
      offenders.push(`${file}:${lineAt(text, m.index)}: the position helper is called outside the record-only sites`)
    }
  }
  return offenders
}

/** In a knowledge-anchor file, every position name sits inside the `el` anchor object. */
function anchorKeyOffenses(file: string, text: string, scope: string): string[] {
  const region = regionBetween(text, scope, '\n])')
  if (region === undefined) return [`${file}: the anchor schema is not found`]
  const from = text.indexOf(region)
  const elAt = region.indexOf("t: z.literal('el')")
  if (elAt < 0) return [`${file}: the anchor schema has no el anchor`]
  const elObject = regionBetween(region.slice(elAt), "t: z.literal('el')", '.strict()') ?? ''
  const elRange = [from + elAt, from + elAt + elObject.length] as const
  const scoped = file === MEMORY_TOOLS ? text : region
  const base = file === MEMORY_TOOLS ? 0 : from
  return [...scoped.matchAll(rx(POSITION_NAME, 'gi'))]
    .filter((m) => base + m.index < elRange[0] || base + m.index > elRange[1])
    .map((m) => `${file}:${lineAt(text, base + m.index)}: a position name outside the el recall anchor`)
}

// ---------------------------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------------------------

describe('C438-CENSUS — no position pick on the live, heal, procedure-replay or cached paths (438 D-11, D-13)', () => {
  it('C438-UNIVERSE-FLOORS: every guarded file and region reads real code, so no cell can pass over an empty scan', () => {
    const files = [
      MATCHER, GATE, STRICT, CACHE_PORT, CACHE_VALUE, REGROUND, LOOP_INDEX, MEMORY_TOOLS, TOOL_ACTIONS,
      PARAMS, BUILDER, MOBILE_TYPES, XML_PARSER, IOS_ADAPTER, EMIT_CANDIDATES, CURATOR_AUTHOR,
      WEB_RESOLVER, WEB_TYPES, WEB_OBSERVER, HELPER_HOME, DIGEST, EXERCISED, ...SNAPSHOT_FILES,
    ]
    for (const file of files) expect(existsSync(join(PACKAGES_DIR, file)), `${file} is missing`).toBe(true)
    for (const region of [WEB, 'runner/src/', 'core/src/', 'ios/src/', 'android/src/', EVAL]) {
      expect(filesOf(region).length, `${region} scanned nothing`).toBeGreaterThan(3)
    }
    expect(scanned(everyProductionRegion()).length).toBeGreaterThan(1000)
    const loop = code(LOOP_INDEX)
    for (const name of ['attemptProcedureReplayAction', 'strictProcedureTarget', 'regroundFailedRef', CAUTION_FN, 'replayFromCache']) {
      expect(fnBody(loop, name), `${LOOP_INDEX}: ${name} is not declared`).toBeDefined()
    }
  })

  it('C438-NO-WEB-POSITION: web production calls no Playwright position method on an element locator, and the resolver builds no role locator', () => {
    const files = scanned([WEB])
    const offenders = files.flatMap((file) => webPositionOffenders(file, code(file)))
    expect(offenders, offenders.join('\n')).toEqual([])
    const resolver = code(WEB_RESOLVER)
    const roleLocators = hitsIn(WEB_RESOLVER, resolver, rx(ROLE_LOCATOR))
    expect(roleLocators, roleLocators.join('\n')).toEqual([])
    expect(hitsIn(WEB_RESOLVER, resolver, rx(POSITION_NAME, 'i'))).toEqual([])
    expect(resolver, 'the resolver no longer acts through the native ref, so this scan is stale')
      .toContain(joined(NATIVE_REF_LOCATOR))
  })

  it('C438-NO-MATCHER-POSITION: DescriptorInput declares no position member and matchDescriptor indexes no survivor list', () => {
    const matcher = code(MATCHER)
    const input = typeBody(matcher, 'DescriptorInput')
    expect(input, 'DescriptorInput is not declared').toBeDefined()
    expect(membersOf(input!)).toEqual(['role', 'name', 'nameNormalized', 'near'])
    const body = fnBody(matcher, 'matchDescriptor')
    expect(body, 'matchDescriptor is not declared').toBeDefined()
    const offenses = [...survivorIndexOffenses(body!), ...hitsIn('matchDescriptor', body!, rx(POSITION_NAME, 'i'))]
    expect(offenses, offenses.join('\n')).toEqual([])
    const toInput = fnBody(code(GATE), 'toDescriptorInput')
    expect(toInput, `${GATE}: toDescriptorInput is not declared`).toBeDefined()
    expect(hitsIn('toDescriptorInput', toInput!, rx(POSITION_NAME, 'i'))).toEqual([])
    expect(toInput!).toContain('const { role, name, nameNormalized, near } = value')
  })

  it('C438-NO-CACHE-POSITION: GroundedLocator declares no position, value.ts computes none, and re-grounding returns the strict match', () => {
    const locator = typeBody(code(CACHE_PORT), 'GroundedLocator')
    expect(locator, 'GroundedLocator is not declared').toBeDefined()
    expect(membersOf(locator!)).toEqual(['role', 'name', 'row'])
    for (const file of [CACHE_VALUE, REGROUND, STRICT]) {
      const hits = [...hitsIn(file, code(file), rx(POSITION_NAME, 'i')), ...hitsIn(file, code(file), rx(HELPER_CALL))]
      expect.soft(hits, hits.join('\n')).toEqual([])
    }
    expect(code(REGROUND).replace(/\s+/g, ' ')).toContain(joined(STRICT_RETURN))
    expect(typeBody(code(STRICT), 'StrictTarget') && membersOf(typeBody(code(STRICT), 'StrictTarget')!))
      .toEqual(['role', 'name', 'row'])
  })

  it('C438-CACHE-MISS-RECORDED: a key hit that does not replay records its typed miss before the entry is invalidated', () => {
    const loop = code(LOOP_INDEX)
    const offenses = cacheMissOffenses(loop)
    expect(offenses, offenses.join('\n')).toEqual([])
    const replay = fnBody(loop, 'replayFromCache')
    expect(replay, 'replayFromCache is not declared').toBeDefined()
    expect(replay!, 'the replay no longer re-finds through the strict re-ground').toContain(joined(REPLAY_REGROUND))
    expect(hitsIn('replayFromCache', replay!, rx(POSITION_NAME, 'i'))).toEqual([])
    expect(code(REGROUND).replace(/\s+/g, ' '), 'cache re-grounding no longer returns the strict match result')
      .toContain(joined(STRICT_RETURN))
  })

  it('C438-NO-PROCEDURE-POSITION: procedure replay passes no position to a matcher, and the recovery context carries none', () => {
    const loop = code(LOOP_INDEX)
    const strict = fnBody(loop, 'strictProcedureTarget')
    expect(strict, 'strictProcedureTarget is not declared').toBeDefined()
    expect(strict!.replace(/\s+/g, ' ')).toContain(joined(STRICT_PROCEDURE_CALL))
    const replay = fnBody(loop, 'attemptProcedureReplayAction')
    expect(replay, 'attemptProcedureReplayAction is not declared').toBeDefined()
    expect(replay!.split('strictProcedureTarget(').length - 1, 'a target is re-found other than strictly').toBe(2)
    const regions: [string, string | undefined][] = [
      ['strictProcedureTarget', strict],
      ['attemptProcedureReplayAction', replay],
      ['ProcedureRecoveryDescriptor', typeBody(loop, 'ProcedureRecoveryDescriptor')],
      ['ProcedureGuardMissRecoveryContext', typeBody(loop, 'ProcedureGuardMissRecoveryContext')],
      ['projectProcedureRecoveryDescriptor', fnBody(loop, 'projectProcedureRecoveryDescriptor')],
      ['projectProcedureGuardMissRecovery', fnBody(loop, 'projectProcedureGuardMissRecovery')],
      ['renderProcedureRecoveryDescriptor', fnBody(loop, 'renderProcedureRecoveryDescriptor')],
      ['renderProcedureGuardMissRecoveryBlock', fnBody(loop, 'renderProcedureGuardMissRecoveryBlock')],
    ]
    for (const [name, body] of regions) {
      expect(body, `${name} is not declared`).toBeDefined()
      const hits = [
        ...hitsIn(name, body ?? '', rx(POSITION_TEXT, 'i')),
        ...hitsIn(name, body ?? '', rx(LOOSE_MATCHER_CALL)),
        ...hitsIn(name, body ?? '', rx(HELPER_CALL)),
      ]
      expect.soft(hits, hits.join('\n')).toEqual([])
    }
    expect(membersOf(typeBody(loop, 'ProcedureRecoveryDescriptor')!)).toEqual(['lane', 'role', 'name', 'row'])
  })

  it('C438-NO-HEAL-POSITION: the heal re-finds a replaced element strictly and passes no position', () => {
    const heal = fnBody(code(LOOP_INDEX), 'regroundFailedRef')
    expect(heal, 'regroundFailedRef is not declared').toBeDefined()
    expect(heal!.replace(/\s+/g, ' ')).toContain(joined(STRICT_HEAL_CALL))
    const hits = [
      ...hitsIn('regroundFailedRef', heal!, rx(POSITION_NAME, 'i')),
      ...hitsIn('regroundFailedRef', heal!, rx(LOOSE_MATCHER_CALL)),
      ...hitsIn('regroundFailedRef', heal!, rx(HELPER_CALL)),
    ]
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('C438-NO-TARGET-POSITION: the planner target schema and its emission type have no position key', () => {
    const schema = regionBetween(code(TOOL_ACTIONS), 'export const targetSchema = z.object({', '}).strict()')
    expect(schema, 'targetSchema is not declared').toBeDefined()
    expect(membersOf(schema!)).toEqual(['role', 'name', 'row'])
    const emitted = typeBody(code(PARAMS), 'EmittedTargetDescriptor')
    expect(emitted, 'EmittedTargetDescriptor is not declared').toBeDefined()
    expect(membersOf(emitted!)).toEqual(['role', 'name', 'row'])
    expect([...positionKeys(schema!), ...positionKeys(emitted!)]).toEqual([])
  })

  it('C438-NO-BINDING-POSITION: RefBinding, RefEntry and the web ref map carry no position member, and none is minted', () => {
    const binding = typeBody(code(BUILDER), 'RefBinding')
    expect(binding, 'RefBinding is not declared').toBeDefined()
    expect(membersOf(binding!)).toEqual(['index'])
    const entry = typeBody(code(MOBILE_TYPES), 'RefEntry')
    expect(entry, 'RefEntry is not declared').toBeDefined()
    expect(membersOf(entry!)).toContain('bounds')
    expect(positionKeys(entry!)).toEqual([])
    const webMap = regionBetween(code(WEB_TYPES), 'export type RefMap = Record<string, {', '}>')
    expect(webMap, 'the web RefMap is not declared').toBeDefined()
    expect(membersOf(webMap!)).toContain('nativeRef')
    expect(positionKeys(webMap!)).toEqual([])
    const minted = [
      ...hitsIn(BUILDER, code(BUILDER), rx(POSITION_NAME, 'i')),
      ...hitsIn('buildRefEntries', fnBody(code(XML_PARSER), 'buildRefEntries') ?? '', rx(POSITION_NAME, 'i')),
      ...hitsIn('buildRefMap', fnBody(code(WEB_RESOLVER), 'buildRefMap') ?? '', rx(POSITION_NAME, 'i')),
    ]
    expect(minted, minted.join('\n')).toEqual([])
    expect(fnBody(code(XML_PARSER), 'buildRefEntries'), 'buildRefEntries is not declared').toBeDefined()
  })

  it('C438-NO-IOS-POSITION: the iOS text-target lookup computes no same-type position, and no mobile adapter names one', () => {
    const body = methodBody(code(IOS_ADAPTER), 'locateIOSTextTarget')
    expect(body, 'locateIOSTextTarget is not declared').toBeDefined()
    const offenses = iosPositionOffenses(body!)
    expect(offenses, offenses.join('\n')).toEqual([])
    const mobile = scanned(['ios/src/', 'android/src/', 'core/src/mobile/'])
      .flatMap((file) => hitsIn(file, code(file), rx(POSITION_NAME, 'i')))
    expect(mobile, mobile.join('\n')).toEqual([])
  })

  it('C438-NO-CURATION-POSITION: the two curation writers write no position into procedure targets', () => {
    const emit = code(EMIT_CANDIDATES)
    const schema = regionBetween(emit, 'const trajectoryGuardTargetSchema = z', '.strict()')
    expect(schema, 'trajectoryGuardTargetSchema is not declared').toBeDefined()
    expect(positionKeys(schema!.replace(/^ {4}/gm, '  '))).toEqual([])
    expect(membersOf(schema!.replace(/^ {4}/gm, '  '))).toEqual(['ref', 'role', 'nameNormalized', 'name', 'row'])
    const writers: [string, string | undefined][] = [
      ['trajectoryTargets', fnBody(emit, 'trajectoryTargets')],
      ['bodyTarget', fnBody(code(CURATOR_AUTHOR), 'bodyTarget')],
    ]
    for (const [name, body] of writers) {
      expect(body, `${name} is not declared`).toBeDefined()
      const hits = [...hitsIn(name, body ?? '', rx(POSITION_NAME, 'i')), ...hitsIn(name, body ?? '', rx(HELPER_CALL))]
      expect.soft(hits, hits.join('\n')).toEqual([])
    }
  })

  it('C438-RECORD-ONLY-CLASSIFIED: the position helper is called only at the classified record-only sites, each named in the header', () => {
    const files = scanned(everyProductionRegion())
    const declarations = files.flatMap((file) => hitsIn(file, code(file), rx(HELPER_DECLARATION)))
    expect(declarations.length, declarations.join('\n')).toBe(1)
    expect(declarations[0]!.startsWith(`${HELPER_HOME}:`)).toBe(true)
    const offenders = helperCallOffenders(files)
    expect(offenders, offenders.join('\n')).toEqual([])
    for (const site of [EXERCISED, DIGEST]) {
      expect(rx(HELPER_CALL).test(code(site)), `${site} no longer records a position; the classification is stale`).toBe(true)
    }
    const caution = fnBody(code(LOOP_INDEX), CAUTION_FN)
    expect(caution !== undefined && rx(HELPER_CALL).test(caution), 'the caution anchor no longer records one; the classification is stale')
      .toBe(true)
    const anchors = [
      ...anchorKeyOffenses(MEMORY_TOOLS, code(MEMORY_TOOLS), "const anchorSchema = z.discriminatedUnion('t', ["),
      ...anchorKeyOffenses(CURATOR_AUTHOR, code(CURATOR_AUTHOR), "const anchorSchema: z.ZodType<Anchor> = z.discriminatedUnion('t', ["),
    ]
    expect(anchors, anchors.join('\n')).toEqual([])
    const own = readFileSync(THIS_FILE).toString('utf8')
    const header = own.slice(0, own.indexOf('\nimport '))
    for (const site of RECORD_ONLY_SITES) {
      expect.soft(header, `the header does not classify ${site}`).toMatch(new RegExp(`${site.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+record-only`))
    }
    expect(header).toContain(`(${CAUTION_FN})`)
  })

  it('C438-ROOT-AI-SNAPSHOT-ONLY: every accessibility snapshot in the web adapters, binding helper, resolver and compounds is :root ai mode', () => {
    const offenders = SNAPSHOT_FILES.flatMap((file) => snapshotOffenders(file, code(file)))
    expect(offenders, offenders.join('\n')).toEqual([])
    const taken = SNAPSHOT_FILES.flatMap((file) => hitsIn(file, code(file), rx(SNAPSHOT_CALL)))
    expect(taken.length, 'too few snapshots found, so this scan is stale').toBeGreaterThanOrEqual(4)
    const observer = code(WEB_OBSERVER)
    const observePage = fnBody(observer, 'observePage')
    const observerSnapshots = hitsIn(WEB_OBSERVER, observer, rx(SNAPSHOT_CALL)).length
    expect(observePage !== undefined && hitsIn('observePage', observePage, rx(SNAPSHOT_CALL)).length === observerSnapshots,
      'observer.ts takes a snapshot outside observePage').toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Controls: the planted pre-438 shapes and this file
// ---------------------------------------------------------------------------------------------

describe('C438-CENSUS instruments', () => {
  it('C438-PLANTED-POSITIVE: every removed shape is found when planted as code, and none as a comment', () => {
    const nth = cat('    if (data.n', 'th !== undefined) locator = locator.n', 'th(data.n', 'th)\n')
    expect(webPositionOffenders('planted.ts', codeOf(nth)).length).toBeGreaterThan(0)
    expect(webPositionOffenders('planted.ts', codeOf(`// ${nth}`))).toEqual([])
    const firstRole = cat('await page.getBy', "Role('button', { name }).fir", 'st().click()')
    expect(webPositionOffenders('planted.ts', codeOf(firstRole))).toHaveLength(1)
    const textWait = cat('await page.getBy', 'Text(action.text).fir', "st().waitFor({ state: 'visible', timeout })")
    expect(webPositionOffenders('planted.ts', codeOf(textWait))).toEqual([])
    expect(webPositionOffenders('planted.ts', codeOf(cat('await page.getBy', 'Text(t).fir', 'st().click()')))).toHaveLength(1)

    const tiebreak = joined([
      "const survivors = rung()\nif (survivors.length === 0) return { kind: 'no-match' }\n"
        + "return { kind: 'resolved', ref: survivors" + '[descriptor.ordi',
      "nal].ref }\n",
    ])
    expect(survivorIndexOffenses(codeOf(tiebreak)).length).toBeGreaterThan(0)
    expect(survivorIndexOffenses(codeOf(`const survivors = rung()\n${joined(UNIQUE_RESOLVE)}\n`))).toEqual([])

    const oldIos = joined([
      cat('    const ordinal = Object.entries(this.last', 'Refs).map(([r]) => r).indexOf(r', 'ef)\n')
        + '    for (const i of order) {\n      if (i === ordi',
      cat('nal) return { el, rect }\n    }\n    return matches.length === 1 ? matc', 'hes[0] : undefined\n'),
    ])
    expect(iosPositionOffenses(codeOf(oldIos)).length).toBeGreaterThanOrEqual(4)
    expect(iosPositionOffenses(codeOf(`    const matches = []\n    ${joined(IOS_UNIQUE)}\n`))).toEqual([])

    const silent = [
      `${joined(HIT_START)}\nif (hit) {\n  const replay = ${joined(REPLAY_CALL)}\n  if (replay) {\n    cached = true\n  } else {\n`,
      `    await ports.cache!${joined(INVALIDATE_CALL)}cacheKey)\n  }\n}\n${joined(HIT_END)}\n`,
    ].join('')
    expect(cacheMissOffenses(codeOf(silent))).toEqual(['the not-replayed path never records the miss'])
    const recorded = silent.replace('  } else {\n', `  } else {\n    recorder${joined(MISS_CALL)}{ reason: replay.reason })\n`)
    expect(cacheMissOffenses(codeOf(recorded))).toEqual([])
    const late = silent.replace(`cacheKey)\n  }\n}`, `cacheKey)\n    recorder${joined(MISS_CALL)}{ reason })\n  }\n}`)
    expect(cacheMissOffenses(codeOf(late))).toHaveLength(1)
    const conditional = silent.replace('  } else {\n', `  } else {\n    if (log) { recorder${joined(MISS_CALL)}{ reason }) }\n`)
    expect(cacheMissOffenses(codeOf(conditional))).toContain('the not-replayed path records the miss only conditionally')
    const commented = silent.replace('  } else {\n', `  } else {\n    // recorder${joined(MISS_CALL)}{ reason })\n`)
    expect(cacheMissOffenses(codeOf(commented))).toEqual(['the not-replayed path never records the miss'])

    const write = joined(['    targets[key] = { ref, role: element.role, ordinal: elementOrdi', 'nal(element, elements) }\n'])
    expect(rx(HELPER_CALL).test(codeOf(write))).toBe(true)
    expect(rx(HELPER_CALL).test(codeOf(`/* ${write} */`))).toBe(false)
    expect(positionKeys(joined(['{\n  role: string\n  ordi', 'nal?: number\n}']))).toHaveLength(1)
    expect(positionKeys('{\n  index: number\n}')).toEqual([])

    const defaultMode = joined(["const tree = await page.locator('body').ariaSnap", 'shot()\n'])
    expect(snapshotOffenders('planted.ts', codeOf(defaultMode))).toHaveLength(1)
    const pageDefault = joined(["await page.locator(':root').ariaSnap", 'shot()\n'])
    expect(snapshotOffenders('planted.ts', codeOf(pageDefault))).toHaveLength(1)
    const root = joined(["await page.locator(':root').ariaSnap", "shot({\n  mode: 'ai',\n  timeout })\n"])
    expect(snapshotOffenders('planted.ts', codeOf(root))).toEqual([])
    expect(snapshotOffenders('planted.ts', codeOf(`// ${defaultMode}`))).toEqual([])
  })

  it('C438-SELF-MATCH: this file spells none of the needles it assembles, and lies outside every region it scans', () => {
    const own = readFileSync(THIS_FILE).toString('utf8')
    expect(existsSync(join(PACKAGES_DIR, OWN)), 'the self path is wrong').toBe(true)
    const needles = [...PRE_438_NEEDLES, NATIVE_REF_LOCATOR, UNIQUE_RESOLVE, IOS_UNIQUE, STRICT_RETURN, HIT_START, MISS_CALL]
      .map(joined)
    const spelled = needles.filter((needle) => own.includes(needle))
    expect(spelled, `this file spells what it reads: ${spelled.join(', ')}`).toEqual([])
    const patterns = [PLAYWRIGHT_NTH, PLAYWRIGHT_FIRST_LAST, ROLE_LOCATOR, SNAPSHOT_CALL, OBSERVE_PAGE_CALL, HELPER_CALL, LOOSE_MATCHER_CALL, SURVIVOR_INDEX, ...IOS_POSITION_SHAPES]
    const ownCode = codeOf(own)
    const matched = patterns.filter((pattern) => rx(pattern).test(ownCode)).map(joined)
    expect(matched, `this file's code matches a pattern it forbids: ${matched.join(', ')}`).toEqual([])
    const regions = scanned(everyProductionRegion())
    expect(regions, 'this census file is inside a region it scans').not.toContain(OWN)
    expect(regions.filter((file) => file.includes('/__tests__/')), 'a test file was scanned').toEqual([])
  })
})
