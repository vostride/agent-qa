// The pinned file set is imported from `enumerateConfigFileSet`, so a new member is never missed.

import {
  CROSS_BOUNDARY_REASONS,
  enumerateConfigFileSet,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { computeCrossBoundary } from '../cross-boundary.js'
import type { CrossBoundaryFacts } from '../cross-boundary.js'

/** The set as the host really enumerates it for a default project — one function, not a literal. */
const PINNED = enumerateConfigFileSet({ configFile: 'agent-qa.config.yaml' })

/** Everything unremarkable, so each cell below varies exactly one fact. */
function facts(overrides: Partial<CrossBoundaryFacts> = {}): CrossBoundaryFacts {
  return {
    fieldEdits: [],
    addsHook: false,
    filesTouched: ['agent-qa.config.yaml'],
    pinnedFileSet: PINNED,
    ...overrides,
  }
}

describe('computeCrossBoundary — one reason per boundary, decided from values', () => {
  it('flags a secret-adjacent field through the SHIPPED matcher, in both directions', () => {
    // Under a root: the obvious case.
    expect(computeCrossBoundary(facts({
      fieldEdits: [{ configPath: 'plugins.auth.0.package', newValue: '@acme/auth' }],
    })).reasons).toEqual(['secret-adjacent-field'])

    // Above a root: `plugins` replaces the whole subtree, auth declarations included.
    expect(computeCrossBoundary(facts({
      fieldEdits: [{ configPath: 'plugins', newValue: 'anything' }],
    })).reasons).toEqual(['secret-adjacent-field'])

    // Through a `*` segment, which the config schema leaves open by design.
    expect(computeCrossBoundary(facts({
      fieldEdits: [{ configPath: 'registry.targets.shop.authState', newValue: 'shop.json' }],
    })).reasons).toEqual(['secret-adjacent-field'])
  })

  // The origin cells fix the path and vary the value, which a path-keyed classifier cannot pass.
  const URL_PATH = 'registry.targets.shop.url'

  it('does NOT flag a same-origin edit — the same host, a different page', () => {
    const verdict = computeCrossBoundary(facts({
      fieldEdits: [{
        configPath: URL_PATH,
        oldValue: 'https://shop.example.com/checkout',
        newValue: 'https://shop.example.com/cart',
      }],
    }))
    expect(verdict.crossBoundary).toBe(false)
    expect(verdict.reasons).toEqual([])
  })

  it('flags a new HOST at the same path', () => {
    expect(computeCrossBoundary(facts({
      fieldEdits: [{
        configPath: URL_PATH,
        oldValue: 'https://shop.example.com/cart',
        newValue: 'https://shop.evil.example/cart',
      }],
    })).reasons).toEqual(['new-origin'])
  })

  it('flags a SCHEME flip on one host — https→http is a different origin and a downgrade', () => {
    expect(computeCrossBoundary(facts({
      fieldEdits: [{
        configPath: URL_PATH,
        oldValue: 'https://shop.example.com/cart',
        newValue: 'http://shop.example.com/cart',
      }],
    })).reasons).toEqual(['new-origin'])
  })

  it('flags a PORT change on one host, and not a redundant default-port spelling', () => {
    expect(computeCrossBoundary(facts({
      fieldEdits: [{
        configPath: URL_PATH,
        oldValue: 'http://127.0.0.1:8931/form.html',
        newValue: 'http://127.0.0.1:9999/form.html',
      }],
    })).reasons).toEqual(['new-origin'])

    // `https://x:443` and `https://x` are one origin. A person asked to re-approve that would
    // learn to answer without reading, which is how a flag stops being information.
    expect(computeCrossBoundary(facts({
      fieldEdits: [{
        configPath: URL_PATH,
        oldValue: 'https://shop.example.com:443/cart',
        newValue: 'https://shop.example.com/cart',
      }],
    })).reasons).toEqual([])
  })

  it('counts absent-to-present as a new origin — a first URL is a first origin', () => {
    expect(computeCrossBoundary(facts({
      fieldEdits: [{ configPath: URL_PATH, newValue: 'https://shop.example.com/' }],
    })).reasons).toEqual(['new-origin'])
  })

  it('flags a hook addition — a hook is code this project will execute, not a setting', () => {
    expect(computeCrossBoundary(facts({ addsHook: true })).reasons).toEqual(['hook-added'])
  })

  it('flags a path outside the pinned set, and the set is the enumeration the port uses', () => {
    expect(computeCrossBoundary(facts({
      filesTouched: ['agent-qa.config.yaml', 'tests/checkout.yaml'],
    })).reasons).toEqual(['out-of-set-path'])

    // The three members, named here so the cell above is a claim about a KNOWN set rather than
    // about whatever the enumeration happened to answer.
    expect([...PINNED]).toEqual(['.gitignore', 'agent-qa.config.yaml', 'hooks.yaml'])

    // Every member of that set is in-set, including the hooks file and the gitignore — the two a
    // classifier comparing against the config file alone would call out-of-set.
    expect(computeCrossBoundary(facts({ filesTouched: [...PINNED] })).reasons).toEqual([])
  })

  it('a project whose config names its own hooks file gets THAT file in the set', () => {
    // The set is what the CONFIG names. A pattern (`hooks*.yaml`) or a hard-coded default would
    // answer differently here, silently, and in the permissive direction.
    const named = enumerateConfigFileSet({
      configFile: 'agent-qa.config.yaml',
      hooksFile: 'config/hooks.yaml',
    })
    expect([...named]).toEqual(['.gitignore', 'agent-qa.config.yaml', 'config/hooks.yaml'])
    expect(computeCrossBoundary({
      fieldEdits: [],
      addsHook: false,
      filesTouched: ['config/hooks.yaml'],
      pinnedFileSet: named,
    }).reasons).toEqual([])
  })

  it('does NOT flag an innocuous in-set field edit — the negative that makes the rest mean anything', () => {
    const verdict = computeCrossBoundary(facts({
      fieldEdits: [{ configPath: 'use.timeout.step', oldValue: '30s', newValue: '45s' }],
    }))
    expect(verdict.crossBoundary).toBe(false)
    expect(verdict.reasons).toEqual([])
  })

  it('reports every reason once, in the vocabulary order, and invents none', () => {
    const verdict = computeCrossBoundary({
      fieldEdits: [
        { configPath: 'registry.targets.shop.url', newValue: 'https://new.example/' },
        { configPath: 'plugins.auth', newValue: 'x' },
        // A second edit that flags the same way must not produce a second reason.
        { configPath: 'plugins.providers', newValue: 'y' },
      ],
      addsHook: true,
      filesTouched: ['agent-qa.config.yaml', 'somewhere/else.yaml'],
      pinnedFileSet: PINNED,
    })

    expect(verdict.crossBoundary).toBe(true)
    // Vocabulary order, not input order — two proposals crossing the same boundaries must render
    // and compare identically regardless of how a caller enumerated its edits.
    expect(verdict.reasons).toEqual([
      'secret-adjacent-field',
      'new-origin',
      'hook-added',
      'out-of-set-path',
    ])
    for (const reason of verdict.reasons) {
      expect(CROSS_BOUNDARY_REASONS).toContain(reason)
    }
  })

  it('a non-URL value cannot change an origin, however it is spelled', () => {
    for (const newValue of ['45s', 'shop.example.com', '/cart', 'mailto:a@b.example', 42, true]) {
      expect(computeCrossBoundary(facts({
        fieldEdits: [{ configPath: 'use.timeout.step', oldValue: '30s', newValue }],
      })).reasons).toEqual([])
    }
  })
})
