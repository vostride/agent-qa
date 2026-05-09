import { describe, it, expect } from 'vitest'
import { jaccardSimilarity, findSimilarObservations } from '../similarity.js'

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1.0)
  })

  it('returns 0.0 for completely disjoint strings', () => {
    expect(jaccardSimilarity('hello', 'goodbye')).toBe(0.0)
  })

  it('returns 0.0 for empty inputs', () => {
    expect(jaccardSimilarity('', '')).toBe(0.0)
    expect(jaccardSimilarity('hello', '')).toBe(0.0)
    expect(jaccardSimilarity('', 'world')).toBe(0.0)
  })

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1.0)
  })

  it('strips punctuation', () => {
    expect(jaccardSimilarity('Hello World!', 'hello world')).toBe(1.0)
    expect(jaccardSimilarity('a, b, c.', 'a b c')).toBe(1.0)
  })

  it('scores real duplicate pair 1 at >= 0.90', () => {
    const a = 'The navbar contains new, past, comments, and popular sections with content counters'
    const b = 'The navbar contains new, top, past, comments, and popular sections with content counters'
    const score = jaccardSimilarity(a, b)
    expect(score).toBeGreaterThanOrEqual(0.90)
  })

  it('scores real duplicate pair 2 at >= 0.84 (11/13 words shared)', () => {
    const a = 'The sidebar navigation contains Dashboard, Runs, Tests, Suites, Insights, and Config links'
    const b = 'The sidebar navigation contains Dashboard, Runs, Tests, Suites, Insights, and Config sections'
    const score = jaccardSimilarity(a, b)
    expect(score).toBeGreaterThanOrEqual(0.84)
    expect(score).toBeLessThan(0.90)
  })

  it('scores non-duplicate pair below 0.50', () => {
    const a = 'Verify the navbar shows all sections'
    const b = 'The navbar contains new past comments popular sections'
    const score = jaccardSimilarity(a, b)
    expect(score).toBeLessThan(0.50)
  })

  it('handles whitespace normalization', () => {
    expect(jaccardSimilarity('hello   world', 'hello world')).toBe(1.0)
  })
})

describe('findSimilarObservations', () => {
  const observations = [
    {
      id: 'obs-1',
      title: 'Navbar: main feed sections are grouped together',
      content: 'The navbar contains new past comments and popular sections',
      trust: 0.8,
    },
    {
      id: 'obs-2',
      title: 'Sidebar: navigation links are grouped in one rail',
      content: 'The sidebar has Dashboard Runs Tests links',
      trust: 0.7,
    },
    {
      id: 'obs-3',
      title: 'Login page: username and password fields appear together',
      content: 'Login page shows a username and password field',
      trust: 0.9,
    },
  ]

  it('returns observations above default threshold (0.85) sorted by similarity descending', () => {
    const query = 'The navbar contains new top past comments and popular sections'
    const results = findSimilarObservations(query, observations)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe('obs-1')
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.85)
  })

  it('returns empty array when nothing meets threshold', () => {
    const query = 'completely unrelated text about something else entirely'
    const results = findSimilarObservations(query, observations)
    expect(results).toEqual([])
  })

  it('returns empty array for empty observations list', () => {
    const results = findSimilarObservations('any query', [])
    expect(results).toEqual([])
  })

  it('respects custom threshold', () => {
    const query = 'The navbar contains new top past comments and popular sections'
    const lowThreshold = findSimilarObservations(query, observations, 0.3)
    const highThreshold = findSimilarObservations(query, observations, 0.99)
    expect(lowThreshold.length).toBeGreaterThan(highThreshold.length)
  })

  it('sorts results by similarity descending', () => {
    const query = 'The navbar contains new past comments popular sections with links'
    const results = findSimilarObservations(query, observations, 0.2)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity)
    }
  })

  it('attaches similarity score to each result', () => {
    const query = 'The navbar contains new past comments and popular sections'
    const results = findSimilarObservations(query, observations, 0.5)
    for (const r of results) {
      expect(r).toHaveProperty('similarity')
      expect(typeof r.similarity).toBe('number')
      expect(r.similarity).toBeGreaterThanOrEqual(0)
      expect(r.similarity).toBeLessThanOrEqual(1)
    }
  })

  it('preserves original observation fields', () => {
    const query = 'The navbar contains new past comments and popular sections'
    const results = findSimilarObservations(query, observations, 0.5)
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('title')
      expect(results[0]).toHaveProperty('content')
      expect(results[0]).toHaveProperty('trust')
    }
  })
})
