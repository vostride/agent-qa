/**
 * Test code never resolves a path outside the agent-qa root.
 *
 * agent-qa is released as its own repository. A test that reaches into the checkout around it
 * passes inside the super-repository and fails only in the release layout, so this census walks
 * every test and test-helper file and fails on any path it resolves above the repository root.
 *
 * THE UNIVERSE is every .ts/.tsx/.mts/.mjs/.js file under packages/<name>/src and
 * scripts/__tests__ that sits in a __tests__ directory or carries a .test. name. Build output
 * and dependencies are skipped.
 *
 * ONLY CALL AND `new` EXPRESSIONS ARE READ, through the TypeScript AST, plus declared names for
 * the parent-root naming rule. Comments never reach the AST, and a string held as an object
 * property value is data rather than a call argument, so neither can be a hit. Nor is the operand
 * of an expectation matcher: it is compared with what the code produced, never resolved.
 * A path that climbs no higher than the repository root is inside it and is not flagged.
 *
 * Every needle in the planted sources below is assembled from two halves at run time, so this
 * file's raw text spells none of them and the self-match cell scans it like any other file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API, type Snapshot } from 'typescript/unstable/sync'
import { afterAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/arch/src/__tests__ -> packages. */
const PACKAGES_DIR = join(HERE, '..', '..', '..')
const REPO_ROOT = join(PACKAGES_DIR, '..')
const THIS_FILE = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/')

type Rule = 'R-URL' | 'R-CLIMB' | 'R-ROOT-UP' | 'R-SUPER' | 'R-DEMO'
interface Hit {
  file: string
  line: number
  rule: Rule
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage'])
const EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js)$/

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, out)
    else if (entry.isFile()) out.push(path)
  }
}

function universe(): string[] {
  const roots: string[] = []
  for (const name of readdirSync(join(REPO_ROOT, 'packages'))) {
    const src = join(REPO_ROOT, 'packages', name, 'src')
    try {
      if (statSync(src).isDirectory()) roots.push(src)
    } catch {
      // a member without src has nothing to scan
    }
  }
  roots.push(join(REPO_ROOT, 'scripts', '__tests__'))
  const files: string[] = []
  for (const root of roots) walkFiles(root, files)
  return files
    .map(path => relative(REPO_ROOT, path).split(sep).join('/'))
    .filter(file => EXTENSIONS.test(file) && (file.split('/').includes('__tests__') || file.includes('.test.')))
    .sort()
}

const ROOT_NAMES = new Set(['AGENT_QA_ROOT', 'REPO_ROOT', 'WORKSPACE_ROOT'])
const PATH_CALLS = new Set(['resolve', 'join'])
const PARENT_ROOT_NAMING = /super_?(?:root|repo)/i
const DEMO_DIRS = new RegExp(`(?:^|[^\\w-])${['de', 'mo'].join('')}/(?:init|acceptance)(?:/|$)`)
const MINIWOB_CHECKOUT = ['agent-qa-mini', 'wob-bench'].join('')

const escapesRoot = (path: string) => {
  const rel = relative(REPO_ROOT, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

const literalText = (node: ts.Node): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined

const literalParts = (node: ts.Node): string[] => {
  const text = literalText(node)
  if (text !== undefined) return [text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)]
  return []
}

const isImportMetaUrl = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'url'

const pathCallName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return PATH_CALLS.has(callee.text) ? callee.text : undefined
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'path' && PATH_CALLS.has(callee.name.text)) return callee.name.text
  return undefined
}

// A matcher operand is compared with the code's output, never resolved, so a path in it is data.
const isMatcherCall = (call: ts.CallExpression) => {
  let callee: ts.Expression = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression
  return ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'expect'
}

// TypeScript 7 parses in its own tsgo process; the virtual path keeps each file's extension,
// which sets its script kind.
const parserFiles = createVirtualFileSystem({})
const parser = new API({ cwd: '/', fs: parserFiles })
afterAll(() => parser.close())

const sourceAt = (snapshot: Snapshot, path: string) => {
  const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path)
  if (source === undefined) throw new Error(`TypeScript could not parse ${path}`)
  return source
}

let planted = 0
let lastPlanted: string | undefined

function parseOne(file: string, text: string): ts.SourceFile {
  const path = `/planted/${String(planted++)}/${file}`
  parserFiles.writeFile?.(path, text)
  const closeFiles = lastPlanted === undefined ? [] : [lastPlanted]
  lastPlanted = path
  return sourceAt(parser.updateSnapshot({ openFiles: [path], closeFiles }), path)
}

// One snapshot over the whole universe: a snapshot per file is many times slower.
function parseAll(texts: ReadonlyMap<string, string>): Map<string, ts.SourceFile> {
  const paths = [...texts].map(([file, text]) => {
    const path = `/tree/${file}`
    parserFiles.writeFile?.(path, text)
    return [file, path] as const
  })
  const snapshot = parser.updateSnapshot({ openFiles: paths.map(([, path]) => path) })
  const sources = new Map(paths.map(([file, path]) => [file, sourceAt(snapshot, path)]))
  parser.updateSnapshot({ closeFiles: paths.map(([, path]) => path) })
  return sources
}

function scanSource(file: string, text: string, parsed?: ts.SourceFile): Hit[] {
  const abs = join(REPO_ROOT, file)
  const dir = dirname(abs)
  const source = parsed ?? parseOne(file, text)
  const hits: Hit[] = []
  const hit = (node: ts.Node, rule: Rule) =>
    hits.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule })

  const urlRule = (node: ts.NewExpression) => {
    const [target, base] = node.arguments ?? []
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return
    const text = target === undefined ? undefined : literalText(target)
    if (text === undefined || base === undefined || !isImportMetaUrl(base)) return
    const url = new URL(text, pathToFileURL(abs))
    if (url.protocol === 'file:' && escapesRoot(fileURLToPath(url))) hit(node, 'R-URL')
  }

  // A non-literal first argument stands for the file's own directory; an absolute literal is not
  // a climb from the file, so the call is not this rule's to judge.
  const climbRule = (node: ts.CallExpression) => {
    let path = dir
    let climbs = false
    for (const arg of node.arguments) {
      const text = literalText(arg)
      if (text === undefined) continue
      if (isAbsolute(text)) return
      if (text.split(/[\\/]/).includes('..')) climbs = true
      path = resolve(path, text)
    }
    if (climbs && escapesRoot(path)) hit(node, 'R-CLIMB')
  }

  const rootUpRule = (node: ts.CallExpression) => {
    const [first, second] = node.arguments
    if (first === undefined || second === undefined || !ts.isIdentifier(first) || !ROOT_NAMES.has(first.text)) return
    if (literalText(second)?.startsWith('..')) hit(node, 'R-ROOT-UP')
  }

  const demoRule = (node: ts.CallExpression | ts.NewExpression) => {
    if (ts.isCallExpression(node) && isMatcherCall(node)) return
    for (const arg of node.arguments ?? []) {
      if (literalParts(arg).some(part => DEMO_DIRS.test(part) || part.includes(MINIWOB_CHECKOUT))) hit(arg, 'R-DEMO')
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      urlRule(node)
      demoRule(node)
    } else if (ts.isCallExpression(node)) {
      if (pathCallName(node) !== undefined) {
        climbRule(node)
        rootUpRule(node)
      }
      demoRule(node)
    } else if ((ts.isVariableDeclaration(node) || ts.isParameterDeclaration(node) || ts.isFunctionDeclaration(node)
      || ts.isPropertyDeclaration(node) || ts.isBindingElement(node))
      && node.name !== undefined && ts.isIdentifier(node.name) && PARENT_ROOT_NAMING.test(node.name.text)) {
      hit(node.name, 'R-SUPER')
    }
    node.forEachChild(visit)
  }
  visit(source)
  return hits
}

const describeHit = (hit: Hit) => `${hit.file}:${hit.line} ${hit.rule}`

const UNIVERSE = universe()
const TEXTS = new Map(UNIVERSE.map(file => [file, readFileSync(join(REPO_ROOT, file), 'utf8')]))
const SOURCES = parseAll(TEXTS)
const REAL_HITS = [...TEXTS].flatMap(([file, text]) => scanSource(file, text, SOURCES.get(file)))

const PLANTED = 'packages/planted/src/__tests__/planted.test.ts'
const UP = '../'
const DEMO = ['de', 'mo'].join('')
const plantedRules = (text: string) => scanSource(PLANTED, text).map(hit => hit.rule)

describe('test code reads nothing outside the agent-qa root', () => {
  it('the scan universe is the workspace\'s test and test-helper code', () => {
    expect(UNIVERSE.length).toBeGreaterThanOrEqual(1_500)
    expect(UNIVERSE).toContain('packages/eval-local/src/__tests__/replay-composition.test.ts')
  })

  it('every detection rule fires on its planted shape and ignores comments and data strings', () => {
    const fileDir = 'dirname(fileURLToPath(import.meta.url))'
    expect(plantedRules(`new URL('${UP.repeat(5)}x', import.meta.url)`)).toEqual(['R-URL'])
    expect(plantedRules(`new URL('${UP.repeat(4)}x', import.meta.url)`)).toEqual([])
    expect(plantedRules(`resolve(${fileDir}, '${UP.repeat(5)}x')`)).toEqual(['R-CLIMB'])
    expect(plantedRules(`resolve(${fileDir}, '${UP.repeat(4)}x')`)).toEqual([])
    expect(plantedRules(`resolve(${'AGENT_QA'}_ROOT, '..')`)).toEqual(['R-ROOT-UP'])
    expect(plantedRules(`const ${'SUPER'}_ROOT = '/tmp'`)).toEqual(['R-SUPER'])
    expect(plantedRules(`read('${UP}${DEMO}/init/a.json')`)).toEqual(['R-DEMO'])
    expect(plantedRules(`// read('${UP}${DEMO}/init/a.json')`)).toEqual([])
    expect(plantedRules(`const cell = { filePath: '${UP}${DEMO}/init/a.json' }`)).toEqual([])
    expect(plantedRules(`expect(ref).toBe('${DEMO}/init/tests/a.yaml::a test')`)).toEqual([])
    expect(plantedRules(`expect(readFileSync('${UP}${DEMO}/init/a.json', 'utf8')).toBe('x')`)).toEqual(['R-DEMO'])
    expect(plantedRules(`spawn('python3', ['${MINIWOB_CHECKOUT}/product.py'])`)).toEqual([])
    expect(plantedRules(`join(root, '${MINIWOB_CHECKOUT}')`)).toEqual(['R-DEMO'])
  })

  it('no test or test helper resolves a path outside the agent-qa root', () => {
    expect(REAL_HITS.map(describeHit)).toEqual([])
  })

  it('this file matches none of its own rules', () => {
    expect(UNIVERSE).toContain(THIS_FILE)
    expect(scanSource(THIS_FILE, readFileSync(fileURLToPath(import.meta.url), 'utf8')).map(describeHit)).toEqual([])
  })
})
