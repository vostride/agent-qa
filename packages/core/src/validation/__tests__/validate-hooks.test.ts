import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HookDefinition } from '../../hooks/types.js'

// Mock all external dependencies before importing validate
vi.mock('yaml', () => ({
  parse: vi.fn(),
  LineCounter: vi.fn(),
  parseDocument: vi.fn(),
}))

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../schema/config-schema.js', () => ({
  AgentQaConfigSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
}))

vi.mock('../../schema/suite-schema.js', () => ({
  SuiteDefinitionSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
}))

vi.mock('../../parser/yaml-parser.js', () => ({
  parseTestFile: vi.fn().mockReturnValue({ tests: [], errors: [] }),
}))

vi.mock('../../hooks/parser.js', () => ({
  parseHooksFile: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(),
  }
})

import { existsSync } from 'node:fs'
import { parseHooksFile } from '../../hooks/parser.js'

const mockExistsSync = vi.mocked(existsSync)
const mockParseHooksFile = vi.mocked(parseHooksFile)
const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const VALID_HOOK_ID_TWO = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

describe('validateHooksFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty diagnostics when hooks.yaml does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toEqual([])
  })

  it('returns error diagnostics when hooks.yaml has parse errors', async () => {
    mockExistsSync.mockReturnValue(true)
    mockParseHooksFile.mockResolvedValue({
      hooks: [],
      errors: ['hooks.0.runtime: Invalid enum value'],
    })

    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    expect(diags[0].message).toContain('Invalid enum value')
  })

  it('returns error diagnostic when hook script file does not exist', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p) === '/project/hooks.yaml') return true
      if (String(p) === '/project/hooks/setup.ts') return false
      return true
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{
        id: VALID_HOOK_ID,
        name: 'setup', runtime: 'bun' as const, file: '/project/hooks/setup.ts',
        deps: [], timeout: 30000, network: true,
      } as HookDefinition],
      errors: [],
    })

    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    expect(diags[0].message).toContain('Hook "setup"')
    expect(diags[0].message).toContain('script file not found')
  })

  it('returns error diagnostic when dep file does not exist', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p) === '/project/hooks.yaml') return true
      if (String(p) === '/project/hooks/setup.ts') return true
      if (String(p) === '/project/hooks/utils.ts') return false
      return true
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{
        id: VALID_HOOK_ID,
        name: 'setup', runtime: 'bun' as const, file: '/project/hooks/setup.ts',
        deps: ['/project/hooks/utils.ts'], timeout: 30000, network: true,
      } as HookDefinition],
      errors: [],
    })

    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    expect(diags[0].message).toContain('dependency file not found')
  })

  it('returns error diagnostic when packageFile does not exist', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p) === '/project/hooks.yaml') return true
      if (String(p) === '/project/hooks/setup.ts') return true
      if (String(p) === '/project/hooks/package.json') return false
      return true
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{
        id: VALID_HOOK_ID,
        name: 'setup', runtime: 'bun' as const, file: '/project/hooks/setup.ts',
        deps: [], packageFile: '/project/hooks/package.json', timeout: 30000, network: true,
      } as HookDefinition],
      errors: [],
    })

    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    expect(diags[0].message).toContain('package file not found')
  })

  it('returns no diagnostics when hooks.yaml is valid with existing files', async () => {
    mockExistsSync.mockReturnValue(true)
    mockParseHooksFile.mockResolvedValue({
      hooks: [{
        id: VALID_HOOK_ID,
        name: 'setup', runtime: 'node' as const, file: '/project/hooks/setup.js',
        deps: [], timeout: 30000, network: true,
      } as HookDefinition],
      errors: [],
    })

    const { validateHooksFile } = await import('../validate.js')
    const diags = await validateHooksFile('/project/hooks.yaml')
    expect(diags).toEqual([])
  })
})

describe('validateHookReferences', () => {
  it('returns warning when a hook id is not defined', async () => {
    const { validateHookReferences } = await import('../validate.js')
    const hookIds = new Set([VALID_HOOK_ID, VALID_HOOK_ID_TWO])
    const diags = validateHookReferences(
      [VALID_HOOK_ID, 'h_broken-cedar-delta-ember-falcon-garden-harbor-island-jungle-kite'],
      hookIds,
      '/project/tests/login.yaml',
      'setup',
    )
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('warning')
    expect(diags[0].message).toContain('Hook ID')
    expect(diags[0].message).toContain('not defined in the configured hooks file')
  })

  it('returns no diagnostics when all references are valid', async () => {
    const { validateHookReferences } = await import('../validate.js')
    const hookIds = new Set([VALID_HOOK_ID, VALID_HOOK_ID_TWO])
    const diags = validateHookReferences(
      [VALID_HOOK_ID, VALID_HOOK_ID_TWO],
      hookIds,
      '/project/tests/login.yaml',
      'setup',
    )
    expect(diags).toEqual([])
  })
})
