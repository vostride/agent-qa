import { existsSync, globSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

export const SPECIFIER_RE =
  /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\.resolve\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

export const NODE_BUILTINS = new Set(
  builtinModules.flatMap(moduleName => [moduleName, `node:${moduleName}`]),
)

export interface SpecifierHit {
  specifier: string
  file: string
  line: number
}

export type ClassifiedSpecifier =
  | { kind: 'relative' }
  | { kind: 'node'; bare: string }
  | { kind: 'internal'; pkgName: string }
  | { kind: 'external'; pkgName: string }

// A line opening or continuing a block comment counts as comment only if the block stays open.
function isFullLineComment(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('//')) {
    return true
  }
  if (trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return !trimmed.includes('*/') || trimmed.endsWith('*/')
  }
  return false
}

export function specifiersInSource(source: string, file: string): SpecifierHit[] {
  const hits: SpecifierHit[] = []
  const lines = source.split('\n')

  lines.forEach((text, index) => {
    if (isFullLineComment(text)) {
      return
    }

    for (const match of text.matchAll(SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
      if (specifier) {
        hits.push({ specifier, file, line: index + 1 })
      }
    }
  })

  return hits
}

export function extractSpecifiers(absFile: string): SpecifierHit[] {
  return specifiersInSource(readFileSync(absFile, 'utf8'), absFile)
}

export function classifySpecifier(specifier: string): ClassifiedSpecifier {
  if (specifier.startsWith('.') || specifier.startsWith('@/')) {
    return { kind: 'relative' }
  }

  const bare = specifier.replace(/^node:/, '').split('/')[0] ?? specifier
  if (NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(bare)) {
    return { kind: 'node', bare }
  }

  if (specifier.startsWith('@vostride/agent-qa-')) {
    return { kind: 'internal', pkgName: specifier.split('/').slice(0, 2).join('/') }
  }

  if (specifier.startsWith('@')) {
    return { kind: 'external', pkgName: specifier.split('/').slice(0, 2).join('/') }
  }

  return { kind: 'external', pkgName: bare }
}

export function sourceFilesFor(packageDir: string, repoRoot: string): string[] {
  const packageRoot = join(repoRoot, packageDir)
  if (!existsSync(join(packageRoot, 'src'))) {
    return []
  }

  return globSync('src/**/*.{ts,tsx,css,mjs,cjs,js}', { cwd: packageRoot })
    .filter(file => !file.includes('__tests__'))
    .filter(file => !file.includes('ownership-contract'))
    .sort()
    .map(file => join(packageRoot, file))
}

export function configFilesFor(packageDir: string, repoRoot: string): string[] {
  const packageRoot = join(repoRoot, packageDir)
  if (!existsSync(packageRoot)) {
    return []
  }

  return globSync('*.config.{ts,mts,cts,mjs,cjs,js}', { cwd: packageRoot })
    .sort()
    .map(file => join(packageRoot, file))
}
