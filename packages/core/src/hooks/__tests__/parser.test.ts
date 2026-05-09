import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseHooksFile } from '../parser.js'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

const mockReadFile = vi.mocked(readFile)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseHooksFile', () => {
  it('accepts an empty hooks registry', async () => {
    mockReadFile.mockResolvedValue('hooks: []\n')

    const result = await parseHooksFile('/project/hooks.yaml')

    expect(result.errors).toHaveLength(0)
    expect(result.hooks).toEqual([])
  })

  it('parses valid hooks.yaml and returns HookDefinition array', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Get Auth
    runtime: bun
    file: scripts/auth.ts
    timeout: "30s"
  - id: h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper
    name: Seed Data
    runtime: python
    file: scripts/seed.py
    deps:
      - scripts/helpers.py
    timeout: "1m"
    network: false
`)
    const result = await parseHooksFile('/project/hooks/hooks.yaml')
    expect(result.errors).toHaveLength(0)
    expect(result.hooks).toHaveLength(2)
    expect(result.hooks[0].name).toBe('Get Auth')
    expect((result.hooks[0] as any).id).toBe('h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle')
    expect(result.hooks[0].timeout).toBe(30000)
    expect(result.hooks[1].network).toBe(false)
  })

  it('resolves file paths relative to hooks.yaml directory', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Auth
    runtime: python
    file: scripts/auth.ts
    deps:
      - scripts/helpers.ts
    packageFile: package.json
    timeout: "10s"
`)
    const result = await parseHooksFile('/project/hooks/hooks.yaml')
    expect(result.errors).toHaveLength(0)
    expect(result.hooks[0].file).toBe('/project/hooks/scripts/auth.ts')
    expect(result.hooks[0].deps[0]).toBe('/project/hooks/scripts/helpers.ts')
    expect(result.hooks[0].packageFile).toBe('/project/hooks/package.json')
  })

  it('returns errors for invalid YAML content', async () => {
    mockReadFile.mockResolvedValue('hooks:\n  - name: [invalid yaml')
    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns errors for schema validation failures', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Bad Hook
    runtime: ruby
    file: script.rb
    timeout: "10s"
`)
    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns errors when a hook id is missing or invalid', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - name: Missing ID
    runtime: bun
    file: scripts/missing-id.ts
    timeout: "10s"
  - id: not-a-hook-id
    name: Invalid ID
    runtime: bun
    file: scripts/invalid-id.ts
    timeout: "10s"
`)
    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('hooks.0.id'),
      expect.stringContaining('hooks.1.id'),
    ]))
  })

  it('returns errors when hook ids are duplicated', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: First Hook
    runtime: bun
    file: scripts/first.ts
    timeout: "10s"
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Second Hook
    runtime: bun
    file: scripts/second.ts
    timeout: "10s"
`)
    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate hook id: "h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle"'),
    ]))
  })

  it('returns errors for duplicate hook names even when ids differ', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Duplicate Name
    runtime: bun
    file: scripts/first.ts
    timeout: "10s"
  - id: h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper
    name: Duplicate Name
    runtime: bun
    file: scripts/second.ts
    timeout: "10s"
`)
    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate hook name: "Duplicate Name"'),
    ]))
  })

  it('returns errors when a hook uses removed ts runtime', async () => {
    mockReadFile.mockResolvedValue(`
hooks:
  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle
    name: Legacy TS Hook
    runtime: ts
    file: scripts/legacy.ts
    timeout: "10s"
`)

    const result = await parseHooksFile('/project/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('hooks.0.runtime'),
    ]))
  })

  it('returns error when file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))
    const result = await parseHooksFile('/nonexistent/hooks.yaml')
    expect(result.hooks).toHaveLength(0)
    expect(result.errors[0]).toContain('Failed to read hooks file')
  })
})
