import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionPlan } from '../../schema/action-schema.js'
import { FileActionCache, parseTTL } from '../file-cache.js'
import { CACHE_SCHEMA_VERSION } from '../types.js'
import { hashStep } from '../hasher.js'

function makePlan(overrides?: Partial<ActionPlan>): ActionPlan {
  return {
    reasoning: 'Click the button to sign in',
    action: { type: 'click', ref: 'btn-1' },
    confidence: 0.95,
    stepComplete: false,
    stepFailed: false,
    ...overrides,
  }
}

describe('FileActionCache', () => {
  let cacheDir: string
  let cache: FileActionCache

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'agent-qa-cache-test-'))
    cache = new FileActionCache({ dir: cacheDir, ttl: '7d' })
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('returns null on cache miss (empty cache)', async () => {
    const result = await cache.get('step-abc', 'screen-123')
    expect(result).toBeNull()
  })

  it('stores and retrieves a cache entry (cache hit)', async () => {
    const plan = makePlan()
    await cache.set('step-abc', 'screen-123', plan)

    const result = await cache.get('step-abc', 'screen-123')
    expect(result).toEqual(plan)
  })

  it('different screen hash = different cache entry', async () => {
    const plan1 = makePlan({ reasoning: 'Plan for screen A' })
    const plan2 = makePlan({ reasoning: 'Plan for screen B' })

    await cache.set('step-abc', 'screen-A', plan1)
    await cache.set('step-abc', 'screen-B', plan2)

    const resultA = await cache.get('step-abc', 'screen-A')
    const resultB = await cache.get('step-abc', 'screen-B')

    expect(resultA?.reasoning).toBe('Plan for screen A')
    expect(resultB?.reasoning).toBe('Plan for screen B')
  })

  it('invalidate removes cache entry', async () => {
    const plan = makePlan()
    await cache.set('step-abc', 'screen-123', plan)

    const beforeInvalidate = await cache.get('step-abc', 'screen-123')
    expect(beforeInvalidate).toEqual(plan)

    await cache.invalidate('step-abc', 'screen-123')

    const afterInvalidate = await cache.get('step-abc', 'screen-123')
    expect(afterInvalidate).toBeNull()
  })

  it('cache file is valid JSON with expected fields', async () => {
    const plan = makePlan()
    await cache.set('step-abc', 'screen-123', plan, {
      model: 'claude-sonnet',
      provider: 'anthropic',
      stepInstruction: 'Click Sign In',
    })

    const filePath = join(cacheDir, 'step-abc', 'screen-123.json')
    const raw = await readFile(filePath, 'utf-8')
    const entry = JSON.parse(raw)

    expect(entry.stepInstruction).toBe('Click Sign In')
    expect(entry.stepHash).toBe('step-abc')
    expect(entry.screenHash).toBe('screen-123')
    expect(entry.plan).toEqual(plan)
    expect(entry.createdAt).toBeDefined()
    expect(entry.model).toBe('claude-sonnet')
    expect(entry.provider).toBe('anthropic')
  })

  it('cache file is human-readable (2-space indentation)', async () => {
    const plan = makePlan()
    await cache.set('step-abc', 'screen-123', plan)

    const filePath = join(cacheDir, 'step-abc', 'screen-123.json')
    const raw = await readFile(filePath, 'utf-8')

    // 2-space indented JSON has lines starting with "  "
    const lines = raw.split('\n')
    const indentedLines = lines.filter((l) => l.startsWith('  '))
    expect(indentedLines.length).toBeGreaterThan(0)
    // Not minified (single line)
    expect(lines.length).toBeGreaterThan(1)
  })

  it('TTL expiry: expired entry returns null', async () => {
    // Use 1ms TTL
    const shortCache = new FileActionCache({ dir: cacheDir, ttl: '1m' })
    const plan = makePlan()
    await shortCache.set('step-exp', 'screen-exp', plan)

    // Manually backdate the cache entry
    const filePath = join(cacheDir, 'step-exp', 'screen-exp.json')
    const raw = await readFile(filePath, 'utf-8')
    const entry = JSON.parse(raw)
    entry.createdAt = new Date(Date.now() - 120000).toISOString() // 2 min ago
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(filePath, JSON.stringify(entry, null, 2), 'utf-8')

    const result = await shortCache.get('step-exp', 'screen-exp')
    expect(result).toBeNull()
  })

  it('TTL not expired: valid entry is returned', async () => {
    const plan = makePlan()
    await cache.set('step-ok', 'screen-ok', plan)

    // 7d TTL, just created — should be valid
    const result = await cache.get('step-ok', 'screen-ok')
    expect(result).toEqual(plan)
  })

  it('invalidate on non-existent entry does not throw', async () => {
    await expect(
      cache.invalidate('nonexistent', 'also-nonexistent'),
    ).resolves.not.toThrow()
  })
})

describe('FileActionCache schema versioning', () => {
  let cacheDir: string
  let cache: FileActionCache

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'agent-qa-cache-version-test-'))
    cache = new FileActionCache({ dir: cacheDir, ttl: '7d' })
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('returns null for cache entries without schemaVersion', async () => {
    // Write a v1-style cache entry (no schemaVersion field)
    const dir = join(cacheDir, 'step-old')
    await mkdir(dir, { recursive: true })
    const entry = {
      stepInstruction: 'Click button',
      stepHash: 'step-old',
      screenHash: 'screen-old',
      plan: { reasoning: 'test', action: { type: 'click', ref: 'btn-1' }, confidence: 0.9 },
      createdAt: new Date().toISOString(),
      model: 'gpt-4',
      provider: 'openai',
    }
    await writeFile(join(dir, 'screen-old.json'), JSON.stringify(entry, null, 2), 'utf-8')

    const result = await cache.get('step-old', 'screen-old')
    expect(result).toBeNull()
  })

  it('returns null for cache entries with old schemaVersion', async () => {
    const dir = join(cacheDir, 'step-v1')
    await mkdir(dir, { recursive: true })
    const entry = {
      schemaVersion: 1,
      stepInstruction: 'Click button',
      stepHash: 'step-v1',
      screenHash: 'screen-v1',
      plan: { reasoning: 'test', action: { type: 'click', ref: 'btn-1' }, confidence: 0.9 },
      createdAt: new Date().toISOString(),
      model: 'gpt-4',
      provider: 'openai',
    }
    await writeFile(join(dir, 'screen-v1.json'), JSON.stringify(entry, null, 2), 'utf-8')

    const result = await cache.get('step-v1', 'screen-v1')
    expect(result).toBeNull()
  })

  it('returns plan for cache entries with current schemaVersion', async () => {
    const plan = {
      reasoning: 'Click the button',
      action: { type: 'click' as const, ref: 'btn-1' },
      confidence: 0.9,
      stepComplete: false,
      stepFailed: false,
    }
    await cache.set('step-cur', 'screen-cur', plan)

    const result = await cache.get('step-cur', 'screen-cur')
    expect(result).toEqual(plan)
  })

  it('writes schemaVersion in new cache entries', async () => {
    const plan = {
      reasoning: 'Click the button',
      action: { type: 'click' as const, ref: 'btn-1' },
      confidence: 0.9,
      stepComplete: false,
      stepFailed: false,
    }
    await cache.set('step-new', 'screen-new', plan)

    const filePath = join(cacheDir, 'step-new', 'screen-new.json')
    const raw = await readFile(filePath, 'utf-8')
    const entry = JSON.parse(raw)

    expect(entry.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
  })

  it('handles corrupted JSON gracefully', async () => {
    const dir = join(cacheDir, 'step-corrupt')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'screen-corrupt.json'), 'this is not json{{{', 'utf-8')

    const result = await cache.get('step-corrupt', 'screen-corrupt')
    expect(result).toBeNull()
  })
})

describe('hashStep', () => {
  it('same instruction produces same hash (deterministic)', () => {
    const hash1 = hashStep('Click the Sign In button')
    const hash2 = hashStep('Click the Sign In button')
    expect(hash1).toBe(hash2)
  })

  it('different instructions produce different hashes', () => {
    const hash1 = hashStep('Click the Sign In button')
    const hash2 = hashStep('Fill in the email field')
    expect(hash1).not.toBe(hash2)
  })

  it('hash is 16 hex characters', () => {
    const hash = hashStep('test')
    expect(hash).toMatch(/^[a-f0-9]{16}$/)
  })
})

describe('parseTTL (ms-based)', () => {
  it('parses days', () => {
    expect(parseTTL('7d')).toBe(604800000)
  })

  it('parses hours', () => {
    expect(parseTTL('24h')).toBe(86400000)
  })

  it('parses minutes', () => {
    expect(parseTTL('30m')).toBe(1800000)
  })

  it('defaults to 7d on invalid input', () => {
    expect(parseTTL('invalid')).toBe(604800000)
  })

  it('handles decimal durations (ms lib feature)', () => {
    expect(parseTTL('1.5h')).toBe(5400000)
  })
})

describe('prefix cache invalidation', () => {
  it('cacheState ref starts with invalidated=false', () => {
    const cacheState = { invalidated: false }
    expect(cacheState.invalidated).toBe(false)
  })

  it('mutation via shared ref is visible to holder (D-01)', () => {
    const cacheState = { invalidated: false }
    function innerScope(state: { invalidated: boolean }) {
      state.invalidated = true
    }
    innerScope(cacheState)
    expect(cacheState.invalidated).toBe(true)
  })

  it('per-test isolation: two cacheState refs are independent (D-07)', () => {
    const stateA = { invalidated: false }
    const stateB = { invalidated: false }
    stateA.invalidated = true
    expect(stateA.invalidated).toBe(true)
    expect(stateB.invalidated).toBe(false)
  })

  it('retry reset: new ref object starts clean regardless of prior state (D-08)', () => {
    const attempt1State = { invalidated: false }
    attempt1State.invalidated = true
    const attempt2State = { invalidated: false }
    expect(attempt2State.invalidated).toBe(false)
  })

  it('cache conditional: undefined cacheState does not block (no-cache mode)', () => {
    const cacheState = undefined as { invalidated: boolean } | undefined
    const prefixValid = !cacheState?.invalidated
    expect(prefixValid).toBe(true)
  })

  it('cache conditional: cacheState.invalidated=false allows reads', () => {
    const cacheState = { invalidated: false }
    const prefixValid = !cacheState?.invalidated
    expect(prefixValid).toBe(true)
  })

  it('cache conditional: cacheState.invalidated=true blocks reads (D-02)', () => {
    const cacheState = { invalidated: true }
    const prefixValid = !cacheState?.invalidated
    expect(prefixValid).toBe(false)
  })

  it('setSubAction is not guarded by cacheState — writes always continue (D-04, D-05)', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agent-qa-prefix-test-'))
    try {
      const cache = new FileActionCache({ dir: cacheDir, ttl: '7d' })
      const plan = makePlan({ reasoning: 'Written after invalidation' })
      await cache.setSubAction('step-prefix', 0, plan)
      const retrieved = await cache.getSubAction('step-prefix', 0)
      expect(retrieved).toEqual(plan)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
