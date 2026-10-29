import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// LOOP-02 deletion proof (Phase 353). The v1 blanket-retry / self-heal machinery
// was deleted grep-provably across the phase: the memory-ablation re-run and the
// circuit-breaker class (353-06), the healing attempt-limit counter in the v1 loop,
// and the healing-config type surface (353-07, D-10). This test walks every workspace
// source tree and fails if ANY of the five deleted v1 symbols reappears — turning
// "grep-provable" into a permanent, self-enforcing CI gate (T-353-18 mitigation).
//
// Each forbidden needle is built by concatenating two halves so the whole token never
// appears in THIS file's source: otherwise the test would match itself and the
// phase-gate greps (e.g. a `grep -rn` for the class name over packages) would flag the
// test as a hit. Comments count as occurrences by design — grep-provable means
// grep-clean everywhere, including comments.
const FORBIDDEN: { label: string; needle: string }[] = [
  { label: 'v1 circuit-breaker class', needle: 'Circuit' + 'Breaker' },
  { label: 'v1 memory-ablation predicate', needle: 'should' + 'Ablate' },
  { label: 'v1 memory-ablation id collector', needle: 'collectAll' + 'InjectedIds' },
  { label: 'v1 consecutive-failure healing counter', needle: 'consecutive' + 'Failures' },
  { label: 'v1 healing-config type', needle: 'Healing' + 'Config' },
]

const testFilePath = fileURLToPath(import.meta.url)
// __tests__ -> src -> core -> packages
const packagesRoot = resolve(dirname(testFilePath), '..', '..', '..')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage'])

function collectTsSources(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectTsSources(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.ts') && full !== testFilePath) {
      out.push(full)
    }
  }
}

function workspaceTsSources(): string[] {
  const files: string[] = []
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue
    collectTsSources(join(packagesRoot, pkg.name, 'src'), files)
  }
  return files
}

describe('v1 retry/self-heal machinery is deleted grep-provably', () => {
  const sources = workspaceTsSources()

  it('scans a non-trivial number of workspace source files', () => {
    // Guard against a resolution bug silently making the proof vacuous.
    expect(sources.length).toBeGreaterThan(100)
  })

  for (const { label, needle } of FORBIDDEN) {
    it(`no source reintroduces the ${label}`, () => {
      const hits: string[] = []
      for (const file of sources) {
        const lines = readFileSync(file, 'utf-8').split('\n')
        lines.forEach((line, index) => {
          if (line.includes(needle)) {
            hits.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        })
      }
      expect(
        hits,
        `Deleted v1 symbol "${needle}" reappeared (D-10/LOOP-02):\n${hits.join('\n')}`,
      ).toEqual([])
    })
  }
})
