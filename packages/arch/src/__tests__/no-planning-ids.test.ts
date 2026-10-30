/**
 * No comment, test title, non-test string or file name carries a planning ID, and no comment
 * or test title carries a date outside backticks.
 *
 * The universe is what git lists as tracked or new and not ignored, so local run output never
 * reaches it. TS and JS comments come from the parser's leaf-token walk; titles are the first
 * argument of describe, it, test and suite, through their modifiers, factories, `extend` and
 * per-file aliases; strings are read only in non-test files under packages/ and scripts/. Shell, YAML,
 * Dockerfile and ignore files are read for `#` comments and CSS for block comments. JSON and
 * Markdown are data and docs, and are not read.
 *
 * Every ID and date in the planted sources below is assembled at run time, so this file passes
 * its own lint.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  type CommentParagraph,
  type LineHit,
  type PlanningIdHit,
  type PlanningIdKind,
  commentParagraphs,
  cssComments,
  formatHit,
  hashCommentLines,
  hashSyntax,
  isCodePath,
  isCssPath,
  pathPlanningIds,
  proseHits,
  readsStrings,
  stringHits,
} from '../lint/planning-ids.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const THIS_FILE = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/')
const MATCHERS = 'packages/arch/src/lint/planning-ids.ts'
const MATCHER_TESTS = 'packages/arch/src/lint/__tests__/planning-ids.test.ts'

function listFiles(): string[] {
  let out: string
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(
      `git ls-files failed in ${REPO_ROOT}: run inside a git checkout of agent-qa. ${error}`,
    )
  }
  return out
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(REPO_ROOT, file)))
    .sort()
}

const scriptKind = (file: string) =>
  file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS

const isJsDoc = (node: ts.Node) =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode

// The union of trailing and leading comment ranges at every leaf, JSDoc nodes and JSX text
// skipped, so a `//` inside a string, template or regex is never read as a comment.
function commentRanges(source: ts.SourceFile, text: string): ts.CommentRange[] {
  const ranges = new Map<number, ts.CommentRange>()
  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(source)
    if (kids.length === 0 || node.kind === ts.SyntaxKind.EndOfFileToken) {
      if (node.kind !== ts.SyntaxKind.JsxText) {
        for (const r of ts.getTrailingCommentRanges(text, node.pos) ?? []) ranges.set(r.pos, r)
        for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) ranges.set(r.pos, r)
      }
      return
    }
    for (const kid of kids) if (!isJsDoc(kid)) visit(kid)
  }
  visit(source)
  return [...ranges.values()].sort((a, b) => a.pos - b.pos)
}

// A run of `//` lines separated only by a newline and indentation is one group; a block
// comment is its own group. Each group is split into paragraphs at blank comment lines.
function codeCommentParagraphs(source: ts.SourceFile, text: string): CommentParagraph[] {
  const groups: ts.CommentRange[][] = []
  let current: ts.CommentRange[] | null = null
  for (const r of commentRanges(source, text)) {
    const last = current?.[current.length - 1]
    const joins =
      r.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      last?.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      /^\r?\n[ \t]*$/.test(text.slice(last.end, r.pos))
    if (joins && current) current.push(r)
    else {
      current = [r]
      groups.push(current)
    }
  }
  return groups.flatMap((group) => {
    const first = group[0]!
    const last = group[group.length - 1]!
    const line = source.getLineAndCharacterOfPosition(first.pos).line + 1
    return commentParagraphs(text.slice(first.pos, last.end), line)
  })
}

const TITLE_BASES = ['describe', 'it', 'test', 'suite']
const MODIFIERS = new Set(['skip', 'only', 'todo', 'fails', 'concurrent', 'sequential'])
const FACTORIES = new Set(['each', 'for', 'runIf', 'skipIf'])

const unwrap = (node: ts.Expression): ts.Expression => {
  let n = node
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression
  }
  return n
}

const isFactoryOf = (node: ts.Expression, extend: boolean): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  (FACTORIES.has(node.name.text) || (extend && node.name.text === 'extend'))

// An identifier, or a chain whose every property is a modifier, factory or `extend`, rooted at a
// base.
function rootedAtBase(node: ts.Expression, bases: ReadonlySet<string>): boolean {
  let n = unwrap(node)
  for (;;) {
    if (ts.isPropertyAccessExpression(n)) {
      if (!MODIFIERS.has(n.name.text) && !FACTORIES.has(n.name.text)) return false
      n = unwrap(n.expression)
    } else if (ts.isCallExpression(n)) {
      const inner = unwrap(n.expression)
      if (!isFactoryOf(inner, true)) return false
      n = unwrap(inner.expression)
    } else if (ts.isTaggedTemplateExpression(n)) {
      if (!isFactoryOf(n.tag, false)) return false
      n = unwrap(n.tag.expression)
    } else break
  }
  return ts.isIdentifier(n) && bases.has(n.text)
}

const aliasOf = (init: ts.Expression, bases: ReadonlySet<string>): boolean => {
  const n = unwrap(init)
  if (ts.isConditionalExpression(n)) {
    return aliasOf(n.whenTrue, bases) && aliasOf(n.whenFalse, bases)
  }
  return rootedAtBase(n, bases)
}

// The four title names plus every `const X = <alias of a title name>` in the file.
function titleBases(source: ts.SourceFile): Set<string> {
  const bases = new Set(TITLE_BASES)
  const decls: { name: string; init: ts.Expression }[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      decls.push({ name: node.name.text, init: node.initializer })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (let grew = true; grew; ) {
    grew = false
    for (const decl of decls) {
      if (!bases.has(decl.name) && aliasOf(decl.init, bases)) {
        bases.add(decl.name)
        grew = true
      }
    }
  }
  return bases
}

function isTitleCall(call: ts.CallExpression, bases: ReadonlySet<string>): boolean {
  let callee = call.expression
  if (ts.isPropertyAccessExpression(callee) && FACTORIES.has(callee.name.text)) return false
  for (;;) {
    if (ts.isCallExpression(callee)) {
      const inner = callee.expression
      if (!isFactoryOf(inner, false)) return false
      callee = inner.expression
    } else if (ts.isTaggedTemplateExpression(callee)) {
      if (!isFactoryOf(callee.tag, false)) return false
      callee = callee.tag.expression
    } else if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text
      if (!MODIFIERS.has(name) && !FACTORIES.has(name)) return false
      callee = callee.expression
    } else break
  }
  return ts.isIdentifier(callee) && bases.has(callee.text)
}

function concatParts(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return concatParts(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...(concatParts(node.left) ?? ['']), ...(concatParts(node.right) ?? [''])]
  }
  return null
}

// The cooked title text, template and concatenation parts joined by a control character.
function readTitle(arg: ts.Expression): string | null {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) {
    return [arg.head.text, ...arg.templateSpans.map((span) => span.literal.text)].join('\u0001')
  }
  if (ts.isBinaryExpression(arg)) return concatParts(arg)?.join('\u0001') ?? null
  return null
}

// The literal pieces readTitle reads, so the string pass skips exactly those.
function titleParts(node: ts.Expression): ts.Node[] {
  if (ts.isTemplateExpression(node)) {
    return [node.head, ...node.templateSpans.map((span) => span.literal)]
  }
  if (ts.isParenthesizedExpression(node)) return titleParts(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...titleParts(node.left), ...titleParts(node.right)]
  }
  return [node]
}

function titles(source: ts.SourceFile): { title: CommentParagraph; parts: ts.Node[] }[] {
  const bases = titleBases(source)
  const out: { title: CommentParagraph; parts: ts.Node[] }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isTitleCall(node, bases)) {
      const arg = node.arguments[0]!
      const text = readTitle(arg)
      if (text !== null) {
        const line = source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1
        out.push({ title: { line, text }, parts: titleParts(arg) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const STRING_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
])

function stringLiterals(source: ts.SourceFile, skip: ReadonlySet<ts.Node>): CommentParagraph[] {
  const out: CommentParagraph[] = []
  const visit = (node: ts.Node): void => {
    if (STRING_KINDS.has(node.kind) && !skip.has(node)) {
      const start = node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(source)
      const line = source.getLineAndCharacterOfPosition(start).line + 1
      out.push({ line, text: (node as ts.LiteralLikeNode).text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function scanFile(file: string, text: string): PlanningIdHit[] {
  const tag =
    (kind: PlanningIdKind) =>
    (hit: LineHit): PlanningIdHit => ({ file, kind, ...hit })
  if (isCodePath(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
    const found = titles(source)
    const hits = [
      ...codeCommentParagraphs(source, text).flatMap(proseHits).map(tag('comment')),
      ...found.flatMap(({ title }) => proseHits(title)).map(tag('title')),
    ]
    if (readsStrings(file)) {
      const skip = new Set(found.flatMap(({ parts }) => parts))
      hits.push(...stringLiterals(source, skip).flatMap(stringHits).map(tag('string')))
    }
    return hits.sort((a, b) => a.line - b.line)
  }
  if (isCssPath(file)) return cssComments(text).flatMap(proseHits).map(tag('comment'))
  if (hashSyntax(file)) return hashCommentLines(file, text).flatMap(proseHits).map(tag('comment'))
  return []
}

const reads = (file: string) => isCodePath(file) || isCssPath(file) || hashSyntax(file) !== null

function scanPaths(files: readonly string[]): PlanningIdHit[] {
  const seen = new Set<string>()
  const hits: PlanningIdHit[] = []
  for (const file of files) {
    for (const hit of pathPlanningIds(file)) {
      if (seen.has(hit.path)) continue
      seen.add(hit.path)
      hits.push({ file: hit.path, line: 0, kind: 'file name', text: hit.segment })
    }
  }
  return hits
}

function scanTree(files: readonly string[]): PlanningIdHit[] {
  const hits = files
    .filter(reads)
    .flatMap((file) => scanFile(file, readFileSync(join(REPO_ROOT, file), 'utf8')))
  return [...hits, ...scanPaths(files)]
}

const kindsOf = (hits: readonly PlanningIdHit[]) => hits.map((hit) => hit.kind)

describe('no planning IDs in comments, titles, strings or file names', () => {
  it("reads every tracked file and the lint's own sources", () => {
    const files = listFiles()
    expect(files).toContain(THIS_FILE)
    expect(files).toContain(MATCHERS)
    expect(files).toContain(MATCHER_TESTS)
    expect(files).toContain('packages/arch/package.json')
    expect(scanTree([THIS_FILE, MATCHERS, MATCHER_TESTS]).map(formatHit)).toEqual([])
  })

  it('finds each kind in planted text', () => {
    const id = ['D', '14'].join('-')
    const date = `${'2026'}-10-29`
    const src = 'packages/planted/src/planted.ts'
    const test = 'packages/planted/src/__tests__/planted.test.ts'
    expect(kindsOf(scanFile(src, `// see ${id}\nconst a = 1\n`))).toEqual(['comment'])
    expect(kindsOf(scanFile(src, `/** written ${date} */\nconst a = 1\n`))).toEqual(['comment'])
    expect(kindsOf(scanFile(src, `const a = 'per ${id}'\n`))).toEqual(['string'])
    expect(kindsOf(scanFile(test, `it('keeps ${id}', () => {})\n`))).toEqual(['title'])
    expect(kindsOf(scanFile(test, `const a = 'per ${id}'\n`))).toEqual([])
    const aliased = `const itLive = live ? it : it.skip\nitLive('on ${date}', () => {})\n`
    expect(kindsOf(scanFile(test, aliased))).toEqual(['title'])
    const extended = `const myTest = test.extend({})\nmyTest('on ${date}', () => {})\n`
    expect(kindsOf(scanFile(test, extended))).toEqual(['title'])
    const tagged = 'it.each`a\n${1}`(' + `'per ${id}', () => {})\n`
    expect(kindsOf(scanFile(test, tagged))).toEqual(['title'])
    const templated = 'describe(`per ' + id + ' ${x}`, () => {})\n'
    expect(kindsOf(scanFile(src, templated))).toEqual(['title'])
    const shell = `#!/bin/sh\n# per ${id}\necho '# ${id}'\n`
    expect(kindsOf(scanFile('scripts/planted.sh', shell))).toEqual(['comment'])
    expect(kindsOf(scanFile('packages/planted/a.css', `/* per ${id} */\na {}\n`))).toEqual([
      'comment',
    ])
    expect(kindsOf(scanPaths([`packages/planted/${['f', '381', '48'].join('-')}/a.ts`]))).toEqual([
      'file name',
    ])
    expect(kindsOf(scanFile(src, `// the protocol is \`${date}\`\nconst a = 1\n`))).toEqual([])
    expect(kindsOf(scanFile('packages/planted/data.json', `{ "a": "${id}" }\n`))).toEqual([])
    const collisions = `// UTF-16, SHA-256 and ROUTE-RANGE-206\nconst a = 'text-red-400'\n`
    expect(kindsOf(scanFile(src, collisions))).toEqual([])
  })

  it(
    'no comment, test title, non-test string or file name carries a planning ID or a date',
    () => {
      expect(scanTree(listFiles()).map(formatHit)).toEqual([])
    },
    120_000,
  )
})
