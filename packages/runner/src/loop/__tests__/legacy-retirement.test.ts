import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testFilePath = fileURLToPath(import.meta.url)
// __tests__ -> loop -> src -> runner -> packages
const packagesRoot = resolve(dirname(testFilePath), '..', '..', '..', '..')

const SCAN_GLOBS = [
  'runner/src/**/*.ts',
  'web/src/**/*.ts',
  'android/src/**/*.ts',
  'ios/src/**/*.ts',
]

// The ten LegacyFoldedWebVerbs + the retired common/mobile verbs, as QUOTED type/case literals.
const RETIRED_LITERALS = [
  "'keyDown'", "'keyUp'", "'refresh'", "'navigateHistory'",
  "'readConsoleLogs'", "'readNetworkLogs'", "'readCookies'", "'readLocalStorage'",
  "'newTab'", "'switchTab'",
  "'assert'", "'openLink'", "'launchApp'",
]

// The legacy type-alias identifiers (bare — each is distinctive enough not to collide).
const RETIRED_ALIASES = [
  'LegacyFoldedWebVerbs',
  'RuntimeOnlyCommonVerbs',
  'RuntimeOnlyMobileVerbs',
]

// The assert coaching phrase the planner prompt must not carry.
const RETIRED_PHRASES = [
  "evidence: 'none'",
  "evidence:'none'",
]

const NEEDLES = [...RETIRED_LITERALS, ...RETIRED_ALIASES, ...RETIRED_PHRASES]

interface Finding {
  file: string
  line: number
  needle: string
  text: string
}

function scannedFiles(): string[] {
  const files: string[] = []
  for (const pattern of SCAN_GLOBS) {
    for (const rel of globSync(pattern, { cwd: packagesRoot })) {
      if (rel.includes('__tests__')) continue
      if (rel.includes('/dist/') || rel.startsWith('dist/')) continue
      if (rel.endsWith('legacy-retirement.test.ts')) continue
      files.push(rel)
    }
  }
  return files
}

function scan(): Finding[] {
  const findings: Finding[] = []
  for (const rel of scannedFiles()) {
    const lines = readFileSync(join(packagesRoot, rel), 'utf8').split('\n')
    lines.forEach((text, i) => {
      for (const needle of NEEDLES) {
        if (text.includes(needle)) {
          findings.push({ file: rel, line: i + 1, needle, text: text.trim() })
        }
      }
    })
  }
  return findings
}

describe('retired-verb source scan', () => {
  it('actually visits the four package source trees (guards against a false-green path bug)', () => {
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('runner/src/platform.ts')
  })

  it('excludes __tests__, dist/, and this suite itself from the scan', () => {
    const findings = scan()
    for (const f of findings) {
      expect(f.file.includes('__tests__')).toBe(false)
      expect(f.file.includes('/dist/') || f.file.startsWith('dist/')).toBe(false)
      expect(f.file.endsWith('legacy-retirement.test.ts')).toBe(false)
    }
  })

  it('no retired verb literal, alias, or coaching phrase remains in runner/web/android/ios source', () => {
    const findings = scan()
    const report = findings.map((f) => `  ${f.file}:${f.line} [${f.needle}] ${f.text}`).join('\n')
    expect(findings, `retired verb occurrences still present (${findings.length}):\n${report}`).toEqual([])
  })
})
