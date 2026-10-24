/**
 * 422 D-01/D-18 (ADV-01..ADV-04): the adversarial split has ONE writer and ONE operator door.
 *
 * This is the 418 two-root raw-source method (`418-no-eval-writer.test.ts`) extended with the
 * adversarial vocabulary phase 422 introduced. Comments count as hits, exactly as they do there
 * and in `packages/eval`'s module-discipline scan — 422-01 tripped that scanner on the literal
 * `Math.random` inside a doc comment, which is the behaviour, not a bug. Tests may spell needles
 * in fixtures, so `__tests__` is excluded from the scan along with build output.
 *
 * Three separate questions, deliberately not collapsed into one:
 *
 *   1. WRITER OWNERSHIP. No source under `knowledge-local/src` or `agent-local/src` may name an
 *      adversarial storage path, a staging constant, or a writer. Zero allowances; a read-only
 *      path constant is not eligible either, for 418's reason — a path is the first half of a
 *      writer.
 *   2. THE PORT IS NOT THE WRITER. `stageAdversarialProposal` is a capability NAME that the local
 *      composition forwards and never binds (422-09 D-13). Forwarding is legitimate; invoking it,
 *      or naming it beside any writer needle, is not. The forwarding sites are rostered by their
 *      exact source line so a new one has to be reviewed rather than absorbed.
 *   3. THE ADMIT DOOR. `refreshAdversarialSplit` is the only function that touches the committed
 *      root on this path, and the explicit `--admit` branch of the operator verb is its only
 *      production caller. The ordinary post-run job capability reaches STAGE and cannot reach
 *      ADMIT: it passes neither `admit` nor `batch`.
 *
 * D-07/D-10 ride along in the model-construction census at the tail: the staging composition
 * constructs no model, so eval-local's sanctioned `createModel` site set must not have grown.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/arch/src/__tests__ -> packages. */
const PACKAGES_DIR = join(HERE, '..', '..', '..')
const REPO_ROOT = join(PACKAGES_DIR, '..')
const PROTECTED_ROOTS = ['knowledge-local/src', 'agent-local/src'] as const
const SCAN_EXCLUDED_DIRS = new Set(['dist', 'node_modules', '.turbo', 'coverage', '__tests__'])

interface Source {
  file: string
  text: string
}
interface Site {
  file: string
  marker: string
  label: string
}
interface Hit extends Site {
  line: number
}

/**
 * The writer needles. A hit is a violation wherever it lands in the two protected roots.
 *
 * `eval/adversarial(?![\w-])` deliberately covers the `-state` and `-probes` siblings in ONE
 * label rather than three: they are one storage responsibility in eval-local's contract, and a
 * plant that spells any of them should name one rule rather than a set a reader has to add up.
 */
const WRITER_NEEDLES = [
  { label: 'adversarial storage path', needle: /eval\/adversarial(?:-state|-probes)?(?![\w-])/ },
  {
    label: 'staging constant',
    needle: /\b(?:ADVERSARIAL_STAGING_SUBDIR|ADVERSARIAL_STATE_SUBDIR|ADVERSARIAL_PROBE_SUBDIR)\b/,
  },
  {
    label: 'adversarial writer',
    needle:
      /\b(?:refreshAdversarialSplit|publishAdversarialRefreshRecord|reserveProbeCall|completeProbeCall|retireBatch)\b/,
  },
  { label: 'stage-port invocation', needle: /\bstageAdversarialProposal\s*(?:\?\.)?\(/ },
] as const

/**
 * Only a site rostered with a preceding `// 422-READ:` reason may carry a writer needle, and no
 * writer or writer import closure is eligible for one. The current census needs no exemption —
 * the two protected roots name no adversarial path, constant or writer at all.
 */
const ALLOWED: readonly Site[] = Object.freeze([])

/** The capability NAME, which forwarding may spell and a writer may not. */
const PORT_NEEDLE = /\bstageAdversarialProposal\b/

/**
 * Every line in the protected roots that may spell the port name, rostered by its exact text.
 *
 * Content-addressed rather than line-numbered on purpose: an edit anywhere above these lines
 * must not RED the wall, and an edit TO one of them must. All three are neutral forwarding in
 * `composeLocalAgent` — a declared optional member and the presence-spread that passes it
 * through. None of them binds, imports or calls anything.
 */
const ALLOWED_PORT_LINES = [
  {
    file: 'packages/agent-local/src/composition/compose-local-agent.ts',
    text: "readonly stageAdversarialProposal?: PostRunJobCapabilities['stageAdversarialProposal']",
  },
  {
    file: 'packages/agent-local/src/composition/compose-local-agent.ts',
    text: '...(postRun.stageAdversarialProposal === undefined',
  },
  {
    file: 'packages/agent-local/src/composition/compose-local-agent.ts',
    text: ': { stageAdversarialProposal: postRun.stageAdversarialProposal }),',
  },
] as const

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SCAN_EXCLUDED_DIRS.has(entry.name)) collectSourceFiles(full, out)
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
}

function relativePath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/')
}

function readSources(roots: readonly string[]): Source[] {
  const files: string[] = []
  for (const root of roots) collectSourceFiles(join(PACKAGES_DIR, root), files)
  return files.sort().map(file => ({ file: relativePath(file), text: readFileSync(file, 'utf8') }))
}

function findHits(sources: readonly Source[]): Hit[] {
  return sources.flatMap(({ file, text }) => {
    const lines = text.split('\n')
    return lines.flatMap((line, index) =>
      WRITER_NEEDLES.flatMap(({ label, needle }) => {
        if (!needle.test(line)) return []
        const marker = lines[index - 1]?.match(/^\s*\/\/ 422-READ:\s*(.+?)\s*$/)?.[1] ?? ''
        return [{ file, line: index + 1, marker, label }]
      }),
    )
  })
}

function siteKey(site: Site): string {
  return `${site.file}::${site.marker}::${site.label}`
}

function siteDiff(sources: readonly Source[]): string[] {
  const hits = findHits(sources)
  const expected = new Set(ALLOWED.map(siteKey))
  const seen = new Set<string>()
  const differences: string[] = []
  for (const hit of hits) {
    const key = siteKey(hit)
    if (!expected.has(key) || seen.has(key)) {
      differences.push(`${hit.file}:${hit.line}: ${hit.label} (${hit.marker || 'missing 422-READ:'})`)
    }
    seen.add(key)
  }
  for (const key of expected) {
    if (!seen.has(key)) differences.push(`missing allowed site: ${key}`)
  }
  return differences
}

function portLines(sources: readonly Source[]): string[] {
  return sources
    .flatMap(({ file, text }) =>
      text
        .split('\n')
        .filter(line => PORT_NEEDLE.test(line))
        .map(line => `${file}::${line.trim()}`),
    )
    .sort()
}

const PROTECTED_SOURCES = readSources(PROTECTED_ROOTS)

// ---------------------------------------------------------------------------------------------
// The admit door. Scanned across every package source, because "only the operator branch calls
// the writer" is a statement about the whole workspace and not about two roots.
// ---------------------------------------------------------------------------------------------

const WORKSPACE_SOURCES = readSources(
  readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, 'src')))
    .map(entry => `${entry.name}/src`),
)

const REFRESH_WRITER = 'refreshAdversarialSplit'

interface CallSite {
  file: string
  line: number
  guarded: boolean
}

function parse(source: Source): ts.SourceFile {
  return ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

/** Call sites of the committed-root writer, each tagged with whether an explicit admit guard encloses it. */
function refreshCallSites(sources: readonly Source[]): CallSite[] {
  const out: CallSite[] = []
  for (const source of sources) {
    if (!source.text.includes(`${REFRESH_WRITER}(`)) continue
    const ast = parse(source)
    walk(ast, node => {
      if (!ts.isCallExpression(node) || calleeName(node) !== REFRESH_WRITER) return
      let guarded = false
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isIfStatement(parent) && /\badmit\s*===\s*true\b/.test(parent.expression.getText(ast))) {
          guarded = true
        }
      }
      out.push({
        file: source.file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        guarded,
      })
    })
  }
  return out
}

const STAGE_CAPABILITY_FILE = 'packages/cli/src/composition/proposal-stage-capabilities.ts'

/** The property keys the job capability hands to the operator verb. */
function stageCapabilityVerbOptions(source: Source): string[] {
  const ast = parse(source)
  let region: ts.Node | undefined
  walk(ast, node => {
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node))
      && node.name.getText(ast) === 'stageAdversarialProposal'
    ) {
      region = node
    }
  })
  expect(region, `${source.file} no longer binds stageAdversarialProposal`).toBeDefined()
  const keys: string[] = []
  walk(region!, node => {
    if (!ts.isCallExpression(node) || calleeName(node) !== 'runAdversarialVerb') return
    for (const argument of node.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue
      for (const property of argument.properties) {
        if (property.name) keys.push(property.name.getText(ast))
      }
    }
  })
  return keys.sort()
}

function sourceOf(file: string): Source {
  const found = WORKSPACE_SOURCES.find(source => source.file === file)
  expect(found, `${file} is no longer a scanned workspace source`).toBeDefined()
  return found!
}

// ---------------------------------------------------------------------------------------------
// D-07/D-10: the model-construction census and the contract it is measured against.
// ---------------------------------------------------------------------------------------------

const EVAL_LOCAL_CONTRACT = 'packages/eval-local/src/ownership-contract.ts'
const MODEL_CENSUS_ROOTS = ['eval-local/src'] as const
const MODEL_CENSUS_EXTRA_FILES = ['packages/cli/src/adversarial-probe-author.ts'] as const

const MODEL_CENSUS_SOURCES: readonly Source[] = [
  ...readSources(MODEL_CENSUS_ROOTS),
  ...MODEL_CENSUS_EXTRA_FILES.map(file => ({
    file,
    text: readFileSync(join(REPO_ROOT, file), 'utf8'),
  })),
]

interface ModelSite {
  file: string
  owner: string
  scoped: boolean
}

/**
 * Names that construct a model IN THIS FILE: the factory itself, plus any local binding whose
 * initializer names it. The CLI probe author calls through `const create = input.createModelImpl
 * ?? createModel`, and a census that only matched the literal spelling would read that file as
 * constructing nothing.
 */
function factoryNames(ast: ts.SourceFile): Set<string> {
  const names = new Set(['createModel'])
  walk(ast, node => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && !ts.isCallExpression(node.initializer)
      && /\bcreateModel\b/.test(node.initializer.getText(ast))
    ) {
      names.add(node.name.text)
    }
  })
  return names
}

/** The nearest NAMED function-like ancestor; anonymous callbacks are transparent. */
function ownerOf(node: ts.Node, ast: ts.SourceFile): string {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text
    if (ts.isMethodDeclaration(parent)) return parent.name.getText(ast)
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      if (ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) {
        return parent.parent.name.text
      }
      if (ts.isPropertyAssignment(parent.parent)) return parent.parent.name.getText(ast)
    }
  }
  return '(module)'
}

function modelSites(sources: readonly Source[]): ModelSite[] {
  const out: ModelSite[] = []
  for (const source of sources) {
    if (!/\bcreateModel\b/.test(source.text)) continue
    const ast = parse(source)
    const names = factoryNames(ast)
    walk(ast, node => {
      if (!ts.isCallExpression(node) || !names.has(calleeName(node))) return
      let scoped = false
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent) && calleeName(parent) === 'runSafetyScope') scoped = true
      }
      out.push({ file: source.file, owner: ownerOf(node, ast), scoped })
    })
  }
  return out
}

function modelSiteKeys(sources: readonly Source[]): string[] {
  return modelSites(sources)
    .map(site => `${site.file}::${site.owner}::${site.scoped ? 'scoped' : 'standalone'}`)
    .sort()
}

/** The adversarial store subdir VALUES, read from the modules that declare them. */
function adversarialSubdirValues(): string[] {
  return MODEL_CENSUS_SOURCES.flatMap(source =>
    [...source.text.matchAll(/export const ADVERSARIAL_\w*SUBDIR = '([^']+)'/g)].map(
      match => match[1]!,
    ),
  ).sort()
}

describe('422 the adversarial split has one writer and one operator door', () => {
  it('D-01 raw source in knowledge-local and agent-local names no adversarial path, constant or writer', () => {
    const differences = siteDiff(PROTECTED_SOURCES)
    expect(differences, differences.join('\n')).toEqual([])
  })

  it.each([
    ['eval/adversarial', ['adversarial storage path']],
    ['eval/adversarial-state', ['adversarial storage path']],
    ['eval/adversarial-probes', ['adversarial storage path']],
    ['ADVERSARIAL_STAGING_SUBDIR', ['staging constant']],
    ['ADVERSARIAL_STATE_SUBDIR', ['staging constant']],
    ['ADVERSARIAL_PROBE_SUBDIR', ['staging constant']],
    ['refreshAdversarialSplit', ['adversarial writer']],
    ['publishAdversarialRefreshRecord', ['adversarial writer']],
    ['reserveProbeCall', ['adversarial writer']],
    ['completeProbeCall', ['adversarial writer']],
    ['retireBatch', ['adversarial writer']],
    ['stageAdversarialProposal(', ['stage-port invocation']],
  ] as const)(
    'D-18 detects %s in comments and code in both roots, even with an unrostered marker',
    (text, labels) => {
      for (const root of PROTECTED_ROOTS) {
        const file = `packages/${root}/422-plant.ts`
        for (const prefix of ['', '// ', '// 422-READ: forged allowance\n']) {
          const line = prefix.includes('\n') ? 2 : 1
          const marker = line === 2 ? 'forged allowance' : 'missing 422-READ:'
          expect(siteDiff([...PROTECTED_SOURCES, { file, text: prefix + text }])).toEqual(
            labels.map(label => `${file}:${line}: ${label} (${marker})`),
          )
        }
      }
    },
  )

  it('D-13 the stage capability NAME is forwarded at exactly the rostered lines and nowhere else', () => {
    expect(portLines(PROTECTED_SOURCES)).toEqual(
      ALLOWED_PORT_LINES.map(site => `${site.file}::${site.text}`).sort(),
    )
  })

  it('D-13 a new forwarding site, a rebinding, or an invocation of the port is detected', () => {
    const root = 'packages/agent-local/src'
    for (const plant of [
      'stageAdversarialProposal: buildLocalAdversarialStager(),',
      'const staged = await stageAdversarialProposal({ candidateIds })',
      'readonly stageAdversarialProposal?: LocalStager',
    ]) {
      const planted = [...PROTECTED_SOURCES, { file: `${root}/422-port-plant.ts`, text: plant }]
      expect(portLines(planted)).not.toEqual(
        ALLOWED_PORT_LINES.map(site => `${site.file}::${site.text}`).sort(),
      )
    }
    // An invocation is additionally a writer-census violation, not merely an unrostered name.
    expect(
      siteDiff([
        ...PROTECTED_SOURCES,
        { file: `${root}/422-port-plant.ts`, text: 'await stageAdversarialProposal({ candidateIds })' },
      ]),
    ).toEqual([`${root}/422-port-plant.ts:1: stage-port invocation (missing 422-READ:)`])
  })

  it('D-01 the committed-root writer has exactly one production caller, inside the explicit admit branch', () => {
    expect(refreshCallSites(WORKSPACE_SOURCES).map(site => `${site.file}:${site.guarded}`)).toEqual([
      'packages/cli/src/eval-session-composition.ts:true',
    ])
  })

  it('D-01 an unguarded or second caller of the committed-root writer is detected', () => {
    const unguarded: Source = {
      file: 'packages/cli/src/422-admit-plant.ts',
      text: 'export function stage() {\n  return refreshAdversarialSplit({ product })\n}\n',
    }
    expect(refreshCallSites([unguarded]).map(site => `${site.file}:${site.guarded}`)).toEqual([
      'packages/cli/src/422-admit-plant.ts:false',
    ])
    const guardedElsewhere: Source = {
      file: 'packages/eval-local/src/422-admit-plant.ts',
      text: 'function go(opts: Opts) {\n  if (opts.admit === true) {\n    refreshAdversarialSplit({ product })\n  }\n}\n',
    }
    expect(refreshCallSites([...WORKSPACE_SOURCES, guardedElsewhere]).length).toBe(2)
  })

  it('D-01 the ordinary post-run job capability reaches stage and cannot reach admit', () => {
    expect(stageCapabilityVerbOptions(sourceOf(STAGE_CAPABILITY_FILE))).toEqual([
      'agentQaRoot',
      'product',
    ])
    const region = sourceOf(STAGE_CAPABILITY_FILE).text
    expect(new RegExp(`\\b${REFRESH_WRITER}\\b`).test(region)).toBe(false)
  })

  it('D-01 an admit flag or a batch digest added to the job capability is detected', () => {
    const planted: Source = {
      file: STAGE_CAPABILITY_FILE,
      text: `const capabilities = {
  stageAdversarialProposal: async ({ candidateIds }) => {
    return runAdversarialVerb(await session(), { agentQaRoot, product, admit: true, batch })
  },
}
`,
    }
    expect(stageCapabilityVerbOptions(planted)).toEqual(['admit', 'agentQaRoot', 'batch', 'product'])
  })

  it('does not weaken the 418 wall it extends', () => {
    const wall = readFileSync(join(HERE, '418-no-eval-writer.test.ts'), 'utf8')
    for (const label of [
      'feedback staging path',
      'gate-2 audit path',
      'staging constant',
      'committed corpus writer',
      'committed root dir',
      'eval-local main entry',
    ]) {
      expect(wall, `418 no longer declares the ${label} needle`).toContain(`label: '${label}'`)
    }
    expect(wall).toContain('const ALLOWED: readonly Site[] = Object.freeze([])')
    expect(wall).toContain("const ROOTS = ['knowledge-local/src', 'agent-local/src'] as const")
  })

  // -------------------------------------------------------------------------------------------
  // 422 D-07/D-10: the model-construction census.
  //
  // The staging composition constructs no model — it calls a `ProbeAuthorPort` the CLI bound
  // (422-06). That is a claim about a SET of call sites, so it is counted rather than asserted,
  // and the count is taken independently of `judge-panel-walls.ts`'s `judge-factory` rule: two
  // censuses of the same fact are how a fact drifts, but this one asks a different question
  // (where does the WORKSPACE construct a model on this path) than that rule does (is eval-local's
  // per-file factory count exactly one at a sanctioned owner).
  //
  // REGION-AWARE, not file-wide. eval-local acquires its handle STANDALONE at bind time, outside
  // any safety scope, and the invocations that use it run inside one; the CLI probe author
  // constructs INLINE inside `runSafetyScope`'s callback. A rule that demanded one shape would
  // ban the other, so each site records which it is and the roster fixes both.
  // -------------------------------------------------------------------------------------------

  it('D-07/D-10 the sanctioned model-construction sites are exactly the existing ones', () => {
    expect(modelSiteKeys(MODEL_CENSUS_SOURCES)).toEqual([
      'packages/cli/src/adversarial-probe-author.ts::author::scoped',
      'packages/eval-local/src/judge-binding.ts::bindJudgePort::standalone',
      'packages/eval-local/src/replay-composition.ts::runCassetteReplay::standalone',
    ])
  })

  it('D-10 a second eval-local construction site is detected, in an existing file or a new one', () => {
    const inExistingFile: Source = {
      file: 'packages/eval-local/src/judge-binding.ts',
      text: `${sourceOf('packages/eval-local/src/judge-binding.ts').text}
export function bindSecondJudgePort(input: JudgeBindingInput): JudgePort {
  const model = createModel(input.profile, input.auth)
  return bind(model)
}
`,
    }
    expect(modelSiteKeys([inExistingFile])).toEqual([
      'packages/eval-local/src/judge-binding.ts::bindJudgePort::standalone',
      'packages/eval-local/src/judge-binding.ts::bindSecondJudgePort::standalone',
    ])

    const inNewFile: Source = {
      file: 'packages/eval-local/src/adversarial-author.ts',
      text: `import { createModel } from '@vostride/agent-qa-model'
export function bindProbeAuthor(input: Input): ProbeAuthorPort {
  const model = createModel(input.profile, input.auth)
  return { author: async request => call(model, request) }
}
`,
    }
    expect(modelSiteKeys([...MODEL_CENSUS_SOURCES, inNewFile])).not.toEqual(
      modelSiteKeys(MODEL_CENSUS_SOURCES),
    )
    expect(modelSiteKeys([inNewFile])).toEqual([
      'packages/eval-local/src/adversarial-author.ts::bindProbeAuthor::standalone',
    ])
  })

  it('D-10 the census follows an aliased factory and records the safety region it sits in', () => {
    const aliased: Source = {
      file: 'packages/cli/src/422-author-plant.ts',
      text: `const create = input.createModelImpl ?? createModel
export function bindAuthor(input: Input): ProbeAuthorPort {
  const model = create(input.profile, input.auth)
  return { author: async request => call(model, request) }
}
`,
    }
    expect(modelSiteKeys([aliased])).toEqual([
      'packages/cli/src/422-author-plant.ts::bindAuthor::standalone',
    ])

    // The same alias, moved inside the scope: the tag flips, so an author that stops running
    // inside `runSafetyScope` is a roster change rather than an invisible one.
    const scoped: Source = {
      file: 'packages/cli/src/422-author-plant.ts',
      text: `const create = input.createModelImpl ?? createModel
export function bindAuthor(input: Input): ProbeAuthorPort {
  return { author: async request => runSafetyScope(scope, async () => {
    const model = create(input.profile, input.auth)
    return call(model, request)
  }) }
}
`,
    }
    // The owner is the `author` method the scope sits inside, exactly as the real probe author
    // resolves — the nearest NAMED function-like, not the exported binder two levels up.
    expect(modelSiteKeys([scoped])).toEqual([
      'packages/cli/src/422-author-plant.ts::author::scoped',
    ])
  })

  // -------------------------------------------------------------------------------------------
  // The ownership contract is the declaration this census is measured against. A store that is
  // written but not declared, or a provider-invocation clause quietly widened to make room for an
  // adversarial author, are both changes to the same file — so both are pinned here, against the
  // subdir constants read from their own source rather than against a copy.
  // -------------------------------------------------------------------------------------------

  it('D-01 eval-local declares every adversarial store it writes', () => {
    const contract = sourceOf(EVAL_LOCAL_CONTRACT).text
    for (const value of adversarialSubdirValues()) {
      expect(contract, `the contract does not name .agent-qa/${value}/`).toContain(
        `.agent-qa/${value}/`,
      )
    }
    expect(adversarialSubdirValues()).toEqual([
      'eval/adversarial',
      'eval/adversarial-probes',
      'eval/adversarial-state',
    ])
  })

  it('D-07 the provider-invocation clause stands unamended and states the census conclusion', () => {
    const contract = sourceOf(EVAL_LOCAL_CONTRACT).text
    expect(contract).toContain(
      "'provider invocation ownership beyond the single sanctioned replay-composition helper',",
    )
    expect(contract).toContain(
      "'agent decision or planning logic beyond invoking the unmodified planner in that one helper',",
    )
    // 422-21: the conclusion of the census above, recorded where a future plan that wants to
    // construct a model here has to read it and delete it on purpose.
    expect(contract).toContain('NO MODEL IS CONSTRUCTED ON THE ADVERSARIAL PATH')
    expect(contract).toContain('packages/cli/src/adversarial-probe-author.ts')
  })
})
