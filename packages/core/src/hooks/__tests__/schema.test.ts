import { describe, it, expect } from 'vitest'
import { HookDefinitionSchema, HooksFileSchema } from '../schema.js'

describe('HookDefinitionSchema', () => {
  it('parses valid hook with all fields', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Get Auth Token',
      runtime: 'bun',
      file: 'scripts/auth.ts',
      deps: ['scripts/helpers.ts'],
      packageFile: 'hooks/package.json',
      timeout: '30s',
      network: false,
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Get Auth Token',
      runtime: 'bun',
      file: 'scripts/auth.ts',
      deps: ['scripts/helpers.ts'],
      packageFile: 'hooks/package.json',
      timeout: 30000,
      network: false,
    })
  })

  it('parses minimal hook with defaults (deps=[], network=true)', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Seed Data',
      runtime: 'node',
      file: 'seed.js',
      timeout: '10s',
    })
    expect(result.success).toBe(true)
    expect(result.data!.deps).toEqual([])
    expect(result.data!.network).toBe(true)
    expect(result.data!.packageFile).toBeUndefined()
  })

  it('rejects invalid runtime value', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Bad',
      runtime: 'ruby',
      file: 'script.rb',
      timeout: '5s',
    })
    expect(result.success).toBe(false)
  })

  it('rejects legacy ts runtime value', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Old TS Hook',
      runtime: 'ts',
      file: 'script.ts',
      timeout: '5s',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing timeout', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'No Timeout',
      runtime: 'bash',
      file: 'run.sh',
    })
    expect(result.success).toBe(false)
  })

  it('transforms human-readable timeout "30s" to 30000', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Timer',
      runtime: 'python',
      file: 'timer.py',
      timeout: '30s',
    })
    expect(result.success).toBe(true)
    expect(result.data!.timeout).toBe(30000)
  })

  it('transforms "2m" to 120000', () => {
    const result = HookDefinitionSchema.safeParse({
      id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
      name: 'Long Hook',
      runtime: 'bash',
      file: 'long.sh',
      timeout: '2m',
    })
    expect(result.success).toBe(true)
    expect(result.data!.timeout).toBe(120000)
  })
})

describe('HooksFileSchema', () => {
  it('rejects duplicate hook names', () => {
    const result = HooksFileSchema.safeParse({
      hooks: [
        { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'Auth', runtime: 'node', file: 'a.js', timeout: '5s' },
        { id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper', name: 'Auth', runtime: 'bash', file: 'b.sh', timeout: '10s' },
      ],
    })
    expect(result.success).toBe(false)
    const msg = result.error!.issues.map((i) => i.message).join(', ')
    expect(msg).toContain('Duplicate hook name')
  })

  it('rejects duplicate hook ids', () => {
    const result = HooksFileSchema.safeParse({
      hooks: [
        { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'Auth', runtime: 'node', file: 'a.js', timeout: '5s' },
        { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'Seed', runtime: 'bash', file: 'b.sh', timeout: '10s' },
      ],
    })
    expect(result.success).toBe(false)
    const msg = result.error!.issues.map((i) => i.message).join(', ')
    expect(msg).toContain('Duplicate hook id')
  })

  it('accepts empty hooks array', () => {
    const result = HooksFileSchema.safeParse({ hooks: [] })
    expect(result.success).toBe(true)
    expect(result.data!.hooks).toEqual([])
  })

  it('accepts valid hooks file with multiple hooks', () => {
    const result = HooksFileSchema.safeParse({
      hooks: [
        { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'Setup DB', runtime: 'python', file: 'setup.py', timeout: '1m' },
        { id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper', name: 'Auth', runtime: 'bun', file: 'auth.ts', timeout: '30s' },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data!.hooks).toHaveLength(2)
  })
})
