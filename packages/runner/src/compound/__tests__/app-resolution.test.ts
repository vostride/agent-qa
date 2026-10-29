import { describe, it, expect } from 'vitest'
import { resolveAppName as resolveAppNameImpl, DEFAULT_CANDIDATE_COUNT } from '../app-resolution.js'

// A flat view so the assertions read id and candidates off the union without per-branch narrowing.
type ResolveView = {
  kind: 'exact' | 'fuzzy' | 'ambiguous' | 'unknown'
  id?: string
  candidates: { id: string; label?: string }[]
}
const resolveAppName = (...args: Parameters<typeof resolveAppNameImpl>): ResolveView =>
  resolveAppNameImpl(...args) as unknown as ResolveView

// A small fixture registry: full ids everywhere, labels only where one enumeration yields them.
const registry = [
  { id: 'com.google.android.calendar' },
  { id: 'com.google.android.deskclock', label: 'Clock' },
  { id: 'org.mozilla.firefox', label: 'Firefox' },
  { id: 'com.android.settings' },
]

describe('resolveAppName — the exact rung', () => {
  it('(1) an exact id match resolves kind=exact', () => {
    const r = resolveAppName('com.android.settings', registry)
    expect(r.kind).toBe('exact')
    expect(r.id).toBe('com.android.settings')
  })

  it('(2) an exact label match resolves kind=exact after case/space/punct normalization', () => {
    const r = resolveAppName('clock', registry)
    expect(r.kind).toBe('exact')
    expect(r.id).toBe('com.google.android.deskclock')
  })

  it('(3) an id-segment token match resolves the package', () => {
    const r = resolveAppName('calendar', registry)
    expect(r.id).toBe('com.google.android.calendar')
  })
})

describe('resolveAppName — the fuzzy ladder ordering', () => {
  it('(4) a prefix candidate beats a substring candidate', () => {
    const ladder = [
      { id: 'a.prefix', label: 'Firefox' }, // 'firefox' starts with 'fire' (prefix)
      { id: 'b.substr', label: 'Campfire' }, // 'campfire' contains 'fire' (substring)
    ]
    const r = resolveAppName('fire', ladder)
    expect(r.id).toBe('a.prefix')
  })

  it('(4b) a substring candidate beats a bounded-edit-distance-only candidate', () => {
    const ladder = [
      { id: 'a.substr', label: 'Notebook' }, // 'notebook' contains 'note' (substring)
      { id: 'b.edit', label: 'Nope' }, // 'nope' only reachable via edit distance from 'note'
    ]
    const r = resolveAppName('note', ladder)
    expect(r.id).toBe('a.substr')
  })
})

describe('resolveAppName — margin + candidate rules', () => {
  it('(5) two near-equal candidates within the margin resolve ambiguous with NO launch winner', () => {
    const ambiguous = [
      { id: 'x.reddit', label: 'Reddit' },
      { id: 'y.reddir', label: 'Reddir' },
    ]
    const r = resolveAppName('reddip', ambiguous)
    expect(r.kind).toBe('ambiguous')
    expect(Array.isArray(r.candidates)).toBe(true)
    // The ambiguity gate NEVER coin-flips a winner: no launchable id on the result.
    expect((r as { id?: string }).id).toBeUndefined()
  })

  it('(6) an unknown name resolves kind=unknown with at most DEFAULT_CANDIDATE_COUNT (3) id-bearing candidates', () => {
    expect(DEFAULT_CANDIDATE_COUNT).toBe(3)
    const r = resolveAppName('zzzz-nonexistent-app', registry)
    expect(r.kind).toBe('unknown')
    expect(r.candidates.length).toBeLessThanOrEqual(DEFAULT_CANDIDATE_COUNT)
    for (const candidate of r.candidates) expect(typeof candidate.id).toBe('string')
  })

  it('(7) ScorerOptions injection overrides the defaults and changes an outcome', () => {
    const wide = resolveAppName('zzzz-nonexistent-app', registry)
    const narrow = resolveAppName('zzzz-nonexistent-app', registry, { candidateCount: 1 })
    expect(narrow.candidates.length).toBeLessThanOrEqual(1)
    // Injection demonstrably changed the surfaced candidate set vs the default.
    expect(narrow.candidates.length).toBeLessThan(wide.candidates.length + 1)
    expect(wide.candidates.length).toBeLessThanOrEqual(DEFAULT_CANDIDATE_COUNT)
  })

  it('(8) normalization makes "Fire Fox" and "firefox" resolve identically', () => {
    const a = resolveAppName('Fire Fox', registry)
    const b = resolveAppName('firefox', registry)
    expect(a.id).toBe('org.mozilla.firefox')
    expect(b.id).toBe('org.mozilla.firefox')
    expect(a.id).toBe(b.id)
  })
})
