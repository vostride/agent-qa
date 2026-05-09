import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { detectGlobOverlap, validateProject } from '../validate.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'overlap-test-'))
  writeFileSync(path.join(tmpDir, 'login.yaml'), 'name: login test\nsteps:\n  - action: go to /login')
  writeFileSync(path.join(tmpDir, 'signup.yaml'), 'name: signup test\nsteps:\n  - action: go to /signup')
  writeFileSync(path.join(tmpDir, 'smoke.suite.yaml'), 'name: smoke\ntests:\n  - login.yaml')
  mkdirSync(path.join(tmpDir, 'nested'))
  writeFileSync(path.join(tmpDir, 'nested', 'deep.yaml'), 'name: deep\nsteps:\n  - action: click button')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('detectGlobOverlap', () => {
  it('returns empty array when testMatch and suiteMatch have no overlap', async () => {
    const overlap = await detectGlobOverlap(
      [path.join(tmpDir, '*.yaml')],
      [path.join(tmpDir, '*.suite.yaml')],
      [],
    )
    // *.yaml matches login.yaml, signup.yaml, smoke.suite.yaml
    // *.suite.yaml matches smoke.suite.yaml
    // overlap = smoke.suite.yaml -- but that is overlap, so use disjoint patterns
    const result = await detectGlobOverlap(
      [path.join(tmpDir, 'login.yaml')],
      [path.join(tmpDir, 'smoke.suite.yaml')],
      [],
    )
    expect(result).toEqual([])
  })

  it('returns overlapping file paths when both patterns match same files', async () => {
    const overlap = await detectGlobOverlap(
      [path.join(tmpDir, '**/*.yaml')],
      [path.join(tmpDir, '**/*.yaml')],
      [],
    )
    expect(overlap.length).toBeGreaterThan(0)
    expect(overlap).toContain(path.resolve(tmpDir, 'login.yaml'))
    expect(overlap).toContain(path.resolve(tmpDir, 'signup.yaml'))
  })

  it('returns empty array when either pattern array is empty', async () => {
    expect(await detectGlobOverlap([], [path.join(tmpDir, '**/*.yaml')], [])).toEqual([])
    expect(await detectGlobOverlap([path.join(tmpDir, '**/*.yaml')], [], [])).toEqual([])
    expect(await detectGlobOverlap([], [], [])).toEqual([])
  })

  it('handles ignore patterns correctly', async () => {
    const overlap = await detectGlobOverlap(
      [path.join(tmpDir, '**/*.yaml')],
      [path.join(tmpDir, '**/*.yaml')],
      [path.join(tmpDir, 'nested/**')],
    )
    const deepFile = path.resolve(tmpDir, 'nested', 'deep.yaml')
    expect(overlap).not.toContain(deepFile)
  })
})

describe('validateProject overlap warnings', () => {
  it('includes overlap warnings as severity warning diagnostics', async () => {
    const result = await validateProject({
      testMatch: [path.join(tmpDir, '**/*.yaml')],
      suiteMatch: [path.join(tmpDir, '**/*.yaml')],
      testPathIgnore: [],
      configPath: undefined,
    })
    const overlapWarnings = result.diagnostics.filter(
      (d) => d.severity === 'warning' && d.message.includes('both testMatch and suiteMatch'),
    )
    expect(overlapWarnings.length).toBeGreaterThan(0)
  })

  it('overlap warnings do not increment errorCount', async () => {
    const result = await validateProject({
      testMatch: [path.join(tmpDir, 'login.yaml')],
      suiteMatch: [path.join(tmpDir, 'login.yaml')],
      testPathIgnore: [],
      configPath: undefined,
    })
    const overlapWarnings = result.diagnostics.filter(
      (d) => d.severity === 'warning' && d.message.includes('both testMatch and suiteMatch'),
    )
    expect(overlapWarnings.length).toBe(1)
    // errorCount should not include overlap warnings
    const nonOverlapErrors = result.diagnostics.filter(
      (d) => d.severity === 'error',
    )
    // The overlap warning itself should NOT be in error count
    expect(result.errorCount).toBe(nonOverlapErrors.length)
    expect(result.warningCount).toBeGreaterThanOrEqual(1)
  })
})
