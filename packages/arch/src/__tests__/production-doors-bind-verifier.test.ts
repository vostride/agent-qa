// Proves no production door reaches the loop's planner-trusting branch that runs with no verifier.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
const OWN = 'arch/src/__tests__/production-doors-bind-verifier.test.ts'

// ---------------------------------------------------------------------------------------------
// The lexer (the 432, 436, 437 and 438 censuses'): comments out, everything else in
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
// The universe: production source of every package, read as bytes
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
  !file.includes('/__tests__/')
  && !file.includes('/testing/')
  && !file.includes('/dist/')
  && !/\.test(-d)?\.tsx?$/.test(file)

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

function everyProductionRegion(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'src')))
    .map((name) => `${name}/src/`)
}

function scanned(regions: readonly string[]): string[] {
  return [...new Set(regions.flatMap(filesOf))]
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

/** The text from an opening bracket at `open` to its matching close, inclusive. */
function balanced(text: string, open: number): string | undefined {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (pairs[c] !== undefined) stack.push(pairs[c]!)
    else if (c === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return text.slice(open, i + 1)
    }
  }
  return undefined
}

interface Site {
  file: string
  line: number
  region: string
}

/** Every match of `pattern` in production code, with the bracketed region that follows it. */
function sitesOf(files: readonly string[], pattern: RegExp): Site[] {
  return files.flatMap((file) => {
    const text = code(file)
    return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
      .map((m) => {
        const from = m.index + m[0].length - (/[({]$/.test(m[0]) ? 1 : 0)
        const open = text.slice(from).search(/[({]/)
        return {
          file,
          line: lineAt(text, m.index),
          region: open < 0 ? '' : balanced(text, from + open) ?? '',
        }
      })
  })
}

// ---------------------------------------------------------------------------------------------
// The needles, every one assembled from two halves
// ---------------------------------------------------------------------------------------------

type Halves = readonly [string, string]
const joined = (halves: Halves): string => halves[0] + halves[1]
const rx = (halves: Halves, flags = ''): RegExp => new RegExp(joined(halves), flags)

/** A bare call of the loop's step executor; a method of the same name is another thing. */
const STEP_CALL: Halves = ['(?<![\\w.$])execute', 'Step\\s*\\(']
const STEP_DECLARATION: Halves = ['\\bfunction\\s+execute', 'Step\\s*\\(']
const MEMBER_BINDING: Halves = ['verifier: modelScope ? modelScope.veri', 'fier : config.verifier']
const LIVE_BINDING: Halves = ['verifier: this.veri', 'fier!']
const PORTS_LITERAL: Halves = ['const ports: Loop', 'Ports = {']
/** The injected executor seam of the member config; no production composition may fill it. */
const EXECUTOR_NAME: Halves = ['\\bexecute', 'Step\\b']
const INPUT_INTERFACE: Halves = ['export interface BuildMemberRun', 'ConfigInput {']
const REQUIRED_VERIFIER: Halves = ['^\\s*verifier: Veri', 'fier$']
const OPTIONAL_VERIFIER: Halves = ['^\\s*verifier\\?: Veri', 'fier$']
const CONFIG_CALL: Halves = ['(?<![\\w.$])buildMemberRun', 'Config\\s*\\(']
const CONFIG_DECLARATION: Halves = ['\\bfunction\\s+buildMemberRun', 'Config\\s*\\(']
const VERIFIER_KEY: Halves = ['(?:^|[\\s{,])verif', 'ier\\s*[,:}]']
const MEMBER_CALL: Halves = ['(?<![\\w.$])runMember', 'Test\\s*\\(']
const MEMBER_CALL_DECLARATION: Halves = ['\\bfunction\\s+runMember', 'Test\\s*\\(']
const MEMBER_CONFIG_ASSIGN: Halves = ['const memberRunConfig = Object.assign(buildMemberRun', 'Config({']
const CONSUMER_FACTORY: Halves = ["const createConsumers: CliStepModelScopeOptions\\['create", "Consumers'\\]\\s*="]
const LLM_VERIFIER: Halves = ['verifier: new LLMVeri', 'fier(']
const VISION_DEFAULT: Halves = ['vision ?', '? true']
const GATE_SITE: Halves = ['visionGate: resolveVision', 'Gate\\s*\\(']
const FROM_CONFIG: Halves = ['visionFrom', 'Config(']
const LIVE_GATE_RESOLVE: Halves = ['this.visionGate = resolveVisionGate({ vision: visionFrom', 'Config(']
const LIVE_GATE_BINDING: Halves = ['visionGate: this.vision', 'Gate,']

const LOOP_INDEX = 'runner/src/loop/index.ts'
const MEMBER_RUNNER = 'runner/src/run/member-runner.ts'
const LIVE_SESSION = 'dashboard-server/src/live-editor/live-session.ts'
const RUN_COMPOSITION = 'agent-local/src/composition/run-composition.ts'
const CLI_RUN = 'cli/src/commands/run.ts'
const STEP_DOORS = [MEMBER_RUNNER, LIVE_SESSION] as const

const production = (): string[] => scanned(everyProductionRegion())

function withoutDeclarations(sites: Site[], declaration: Halves): Site[] {
  return sites.filter((site) => {
    const text = code(site.file).split('\n')[site.line - 1] ?? ''
    return !rx(declaration).test(text)
  })
}

// ---------------------------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------------------------

describe('the production doors bind the verifier', () => {
  it('executeStep runs only behind a bound verifier', () => {
    const calls = withoutDeclarations(sitesOf(production(), rx(STEP_CALL)), STEP_DECLARATION)
    const callers = [...new Set(calls.map((site) => site.file))].sort()
    expect(callers, calls.map((s) => `${s.file}:${s.line}`).join('\n')).toEqual([...STEP_DOORS].sort())

    const literal = new RegExp(joined(PORTS_LITERAL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    for (const door of STEP_DOORS) {
      const ports = sitesOf([door], literal)
      expect(ports.length, `${door}: no ports literal`).toBe(1)
      const binding = door === LIVE_SESSION ? LIVE_BINDING : MEMBER_BINDING
      expect(ports[0]!.region, `${door}: the ports literal does not bind the verifier`)
        .toContain(`${joined(binding)},`)
    }

    for (const file of [RUN_COMPOSITION, CLI_RUN]) {
      expect(rx(EXECUTOR_NAME).test(code(file)), `${file} injects a step executor`).toBe(false)
    }
  })

  it('the member-run input requires a verifier', () => {
    const composition = code(RUN_COMPOSITION)
    const start = composition.indexOf(joined(INPUT_INTERFACE))
    expect(start, `${RUN_COMPOSITION}: the member-run input is not declared`).toBeGreaterThanOrEqual(0)
    const body = balanced(composition, start + joined(INPUT_INTERFACE).length - 1) ?? ''
    expect(rx(REQUIRED_VERIFIER, 'm').test(body), 'the member-run input does not require a verifier')
      .toBe(true)
    expect(rx(OPTIONAL_VERIFIER, 'm').test(body)).toBe(false)

    const configCalls = withoutDeclarations(sitesOf(production(), rx(CONFIG_CALL)), CONFIG_DECLARATION)
    expect(configCalls.map((s) => s.file)).toEqual([CLI_RUN, CLI_RUN])
    for (const call of configCalls) {
      expect(rx(VERIFIER_KEY).test(call.region), `${call.file}:${call.line} passes no verifier`).toBe(true)
    }

    const memberCalls = withoutDeclarations(sitesOf(production(), rx(MEMBER_CALL)), MEMBER_CALL_DECLARATION)
    expect(memberCalls.map((s) => s.file)).toEqual([CLI_RUN, CLI_RUN])
    const cli = code(CLI_RUN)
    expect(cli.split(joined(MEMBER_CONFIG_ASSIGN)).length - 1).toBe(memberCalls.length)

    const factories = sitesOf([CLI_RUN], rx(CONSUMER_FACTORY))
    expect(factories.length, 'every step model scope needs a consumer factory').toBe(2)
    for (const factory of factories) {
      expect(factory.region, `${CLI_RUN}:${factory.line} builds no verifier`).toContain(joined(LLM_VERIFIER))
    }
  })

  it('every scanned file and region reads real code, so no cell can pass over an empty scan', () => {
    for (const file of [LOOP_INDEX, ...STEP_DOORS, RUN_COMPOSITION, CLI_RUN]) {
      expect(existsSync(join(PACKAGES_DIR, file)), `${file} is missing`).toBe(true)
      expect(code(file).length, `${file} read nothing`).toBeGreaterThan(1000)
    }
    for (const region of ['runner/src/', 'cli/src/', 'dashboard-server/src/', 'agent-local/src/']) {
      expect(filesOf(region).length, `${region} scanned nothing`).toBeGreaterThan(3)
    }
    expect(production().length).toBeGreaterThan(1000)
    expect(rx(STEP_DECLARATION).test(code(LOOP_INDEX)), 'the step executor is not declared').toBe(true)
    expect(rx(CONFIG_DECLARATION).test(code(RUN_COMPOSITION))).toBe(true)
    expect(rx(MEMBER_CALL_DECLARATION).test(code(MEMBER_RUNNER))).toBe(true)
  })

  it('this file spells none of the needles it assembles, and lies outside every region it scans', () => {
    const own = readFileSync(THIS_FILE).toString('utf8')
    expect(existsSync(join(PACKAGES_DIR, OWN)), 'the self path is wrong').toBe(true)
    const literal = [
      MEMBER_BINDING, LIVE_BINDING, PORTS_LITERAL, INPUT_INTERFACE, MEMBER_CONFIG_ASSIGN, LLM_VERIFIER,
      VISION_DEFAULT, FROM_CONFIG, LIVE_GATE_RESOLVE, LIVE_GATE_BINDING,
    ].map(joined)
    const spelled = literal.filter((needle) => own.includes(needle))
    expect(spelled, `this file spells what it reads: ${spelled.join(', ')}`).toEqual([])
    const ownCode = codeOf(own)
    const patterns = [STEP_CALL, CONFIG_CALL, MEMBER_CALL, REQUIRED_VERIFIER, CONSUMER_FACTORY, GATE_SITE]
    const matched = patterns.filter((pattern) => rx(pattern, 'm').test(ownCode)).map(joined)
    expect(matched, `this file's code matches a pattern it reads: ${matched.join(', ')}`).toEqual([])
    const regions = production()
    expect(regions, 'this census file is inside a region it scans').not.toContain(OWN)
    expect(regions.filter((file) => file.includes('/__tests__/')), 'a test file was scanned').toEqual([])
    expect(regions.filter((file) => file.includes('/testing/')), 'a testing helper was scanned').toEqual([])
  })
})

describe('the vision gates', () => {
  it('both CLI gates read the configured vision, else the model capability table', () => {
    const cli = code(CLI_RUN)
    expect(cli.includes(joined(VISION_DEFAULT)), `${CLI_RUN} still defaults vision to true`).toBe(false)
    const gates = sitesOf([CLI_RUN], rx(GATE_SITE))
    expect(gates.length, `${CLI_RUN}: expected both gate sites`).toBe(2)
    for (const gate of gates) {
      expect(gate.region, `${CLI_RUN}:${gate.line} does not resolve vision from the model`)
        .toContain(joined(FROM_CONFIG))
    }
  })

  it('the live editor resolves its gate from its model and binds it on its ports', () => {
    const live = code(LIVE_SESSION)
    expect(live.includes(joined(LIVE_GATE_RESOLVE)), `${LIVE_SESSION} resolves no vision gate`).toBe(true)
    const literal = new RegExp(joined(PORTS_LITERAL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const ports = sitesOf([LIVE_SESSION], literal)
    expect(ports.length, `${LIVE_SESSION}: no ports literal`).toBe(1)
    expect(ports[0]!.region, 'the live ports literal does not bind the vision gate')
      .toContain(joined(LIVE_GATE_BINDING))
  })
})
