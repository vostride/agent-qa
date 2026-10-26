import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceFiles = globSync('src/**/*.ts', { cwd: pkgRoot })
  .filter(file => !file.includes('__tests__'))
  .map(file => join(pkgRoot, file))

const bannedPatterns = [
  /\bfs\./,
  /\brequire\(/,
  /process\.(env|exit|cwd)/,
  /\bfetch\(/,
  /child_process/,
  /globalThis\./,
  /\bTextEncoder\b/,
  /\bcrypto\b/,
  /\bnew Date\b|\bDate\.(now|UTC|parse)\b/,
  /\bMath\.random\b/,
]

describe('module discipline', () => {
  it('uses extension-less import specifiers', () => {
    const offenders: string[] = []

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+\.js)['"]/g)) {
        offenders.push(`${file}: ${match[1]}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('contains no runtime IO or side-effect APIs', () => {
    const offenders: string[] = []

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      for (const bannedPattern of bannedPatterns) {
        if (bannedPattern.test(source)) {
          offenders.push(`${file}: ${bannedPattern}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  // 422-01 tripped this scan on the phrase "no `Math.random`" inside a doc comment and read it as
  // a bug. It is not: the scan is textual over whole-file source, so a comment is a hit by
  // construction, and that is what makes it impossible to describe a banned API into the file
  // without also declaring it. Pinned here so the next plan finds the rule instead of the
  // surprise.
  it('counts a banned API named in a comment, by design', () => {
    for (const bannedPattern of bannedPatterns) {
      expect(bannedPattern.test('// nothing here'), String(bannedPattern)).toBe(false)
    }
    expect(
      bannedPatterns.some(bannedPattern =>
        bannedPattern.test('// this module uses no Math.random anywhere'),
      ),
    ).toBe(true)
    expect(
      bannedPatterns.some(bannedPattern => bannedPattern.test('/** never calls Date.now(). */')),
    ).toBe(true)
  })

  it('rejects held-out host and nondeterminism API violations', () => {
    const violationCases = [
      [String.raw`\bTextEncoder\b`, 'const e = new TextEncoder()'],
      [String.raw`\bcrypto\b`, 'crypto.subtle.digest(...)'],
      [String.raw`\bnew Date\b|\bDate\.(now|UTC|parse)\b`, 'const d = new Date()'],
      [String.raw`\bnew Date\b|\bDate\.(now|UTC|parse)\b`, 'Date.now()'],
      [String.raw`\bMath\.random\b`, 'const r = Math.random()'],
    ] as const

    for (const [source, violation] of violationCases) {
      const pattern = bannedPatterns.find(bannedPattern => bannedPattern.source === source)
      expect(pattern, source).toBeDefined()
      expect(pattern?.test(violation)).toBe(true)
    }

    const mathRandomPattern = bannedPatterns.find(
      bannedPattern => bannedPattern.source === String.raw`\bMath\.random\b`,
    )
    expect(mathRandomPattern?.test('Math.floor(x)')).toBe(false)
  })
})
