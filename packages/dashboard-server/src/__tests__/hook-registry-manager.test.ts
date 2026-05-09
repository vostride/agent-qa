import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { HookRegistryManager } from '../hooks/hook-registry-manager.js'

const SEEDED_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SEEDED_HOOK_ID_TWO = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

let tempDirs: string[] = []

function withRequiredWorkspaceConfig(configContent: string): string {
  if (!/^workspace:\s*$/m.test(configContent)) {
    return configContent
  }

  const requiredEntries = [
    ['testMatch', '  testMatch:\n    - specs/web/**/*.yaml'],
    ['suiteMatch', '  suiteMatch:\n    - cases/**/*.suite.yaml'],
    ['agentRules', '  agentRules: ./agent-rules.md'],
    ['envFile', '  envFile: .env'],
    ['secretsFile', '  secretsFile: .env.secrets.local'],
  ]
    .filter(([key]) => !new RegExp(`^\\s*${key}:`, 'm').test(configContent))
    .map(([, entry]) => entry)

  const normalized = requiredEntries.length === 0
    ? configContent
    : configContent.replace(/^workspace:\s*$/m, `workspace:\n${requiredEntries.join('\n')}`)
  return /^use:\s*$/m.test(normalized)
    ? normalized
    : `${normalized.trimEnd()}\nuse:\n  mobile:\n    appState: preserve\n`
}

function createDraftHook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SEEDED_HOOK_ID,
    name: 'login',
    runtime: 'node',
    file: './scripts/login.js',
    timeout: '30s',
    network: true,
    ...overrides,
  }
}

async function createManagerWorkspace(
  configContent: string,
  options: {
    hooksContent?: string
    files?: Record<string, string>
  } = {},
): Promise<{
  dir: string
  configPath: string
  manager: HookRegistryManager
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-hook-manager-'))
  tempDirs.push(dir)

  const normalizedConfigContent = withRequiredWorkspaceConfig(configContent)
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, normalizedConfigContent, 'utf-8')

  if (options.hooksContent !== undefined) {
    const configuredHooksFile = normalizedConfigContent.match(/hooksFile:\s*(.+)/)?.[1]?.trim()
    if (!configuredHooksFile) {
      throw new Error('Test workspace config must define workspace.hooksFile')
    }
    const hooksPath = resolve(dir, configuredHooksFile)
    await mkdir(dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, options.hooksContent, 'utf-8')
  }

  if (options.files) {
    for (const [relativePath, content] of Object.entries(options.files)) {
      const fullPath = join(dir, relativePath)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }
  }

  return {
    dir,
    configPath,
    manager: new HookRegistryManager(new ConfigManager(configPath), configPath),
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

describe('HookRegistryManager.validateDraft', () => {
  it.each([
    {
      label: 'invalid runtime',
      draft: { hooks: [createDraftHook({ runtime: 'ruby' })] },
      expected: { field: 'runtime', code: 'invalid_runtime' },
    },
    {
      label: 'legacy ts runtime',
      draft: { hooks: [createDraftHook({ runtime: 'ts' })] },
      expected: { field: 'runtime', code: 'invalid_runtime' },
    },
    {
      label: 'absolute hook file path',
      draft: { hooks: [createDraftHook({ file: '/tmp/login.js' })] },
      expected: { field: 'file', code: 'absolute_path' },
    },
    {
      label: 'unsafe relative hook file path',
      draft: { hooks: [createDraftHook({ file: '../escape/login.js' })] },
      expected: { field: 'file', code: 'unsafe_path' },
    },
    {
      label: 'malformed timeout metadata',
      draft: { hooks: [createDraftHook({ timeout: 'later' })] },
      expected: { field: 'timeout', code: 'invalid_timeout' },
    },
    {
      label: 'malformed network metadata',
      draft: { hooks: [createDraftHook({ network: 'yes' })] },
      expected: { field: 'network', code: 'invalid_network' },
    },
    {
      label: 'duplicate hook ids',
      draft: {
        hooks: [
          createDraftHook(),
          createDraftHook({
            id: SEEDED_HOOK_ID,
            name: 'cleanup',
            file: './scripts/cleanup.sh',
            runtime: 'bash',
            timeout: '15s',
          }),
        ],
      },
      expected: { field: 'id', code: 'duplicate_id', message: expect.stringContaining('Duplicate hook id') },
    },
    {
      label: 'duplicate hook names',
      draft: {
        hooks: [
          createDraftHook(),
          createDraftHook({
            id: SEEDED_HOOK_ID_TWO,
            name: 'login',
            file: './scripts/cleanup.sh',
            runtime: 'bash',
            timeout: '15s',
          }),
        ],
      },
      expected: { field: 'name', code: 'duplicate_name', message: expect.stringContaining('Duplicate hook name') },
    },
  ])('blocks $label with machine-readable fieldErrors', async ({ draft, expected }) => {
    const { manager } = await createManagerWorkspace('workspace:\n  hooksFile: ./hooks.yaml\n')

    const result = await manager.validateDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining(expected),
      ]),
    )
  })

  it('treats a missing hook source file as a non-blocking file_missing warning', async () => {
    const { manager } = await createManagerWorkspace('workspace:\n  hooksFile: ./hooks.yaml\n')

    const result = await manager.validateDraft({
      hooks: [createDraftHook()],
    })

    expect(result.valid).toBe(true)
    expect(result.fieldErrors).toEqual([])
    expect(result.warnings).toEqual([
      {
        field: 'file',
        code: 'file_missing',
        message: 'Hook file missing',
      },
    ])
  })
})

describe('HookRegistryManager.prepareForExecution', () => {
  it('returns resolvedHooks by canonical hook id and keeps missing-file warnings non-fatal', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )

    const result = await manager.prepareForExecution()

    expect(result.hookRegistryError).toBeUndefined()
    expect([...result.resolvedHooks.keys()]).toEqual([SEEDED_HOOK_ID])
    expect(result.resolvedHooks.get(SEEDED_HOOK_ID)?.file).toBe(resolve(dir, 'scripts/login.js'))
    expect(result.authoringIssuesById.get(SEEDED_HOOK_ID_TWO)).toEqual([
      {
        field: 'file',
        code: 'file_missing',
        message: 'Hook file missing',
      },
    ])
  })

  it.each([
    {
      label: 'malformed hooks.yaml',
      hooksContent: 'hooks: [',
      expectedError: 'Invalid YAML in hooks file',
    },
    {
      label: 'schema validation errors',
      hooksContent: [
        'hooks:',
        `  - id: ${SEEDED_HOOK_ID}`,
        '    name: login',
        '    runtime: node',
        '    file: ./scripts/login.js',
        '    timeout: 30s',
        `  - id: ${SEEDED_HOOK_ID_TWO}`,
        '    name: login',
        '    runtime: bash',
        '    file: ./scripts/cleanup.sh',
        '    timeout: 15s',
      ].join('\n'),
      expectedError: 'Duplicate hook name',
    },
  ])('returns hookRegistryError for $label', async ({ hooksContent, expectedError }) => {
    const { manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      { hooksContent },
    )

    const result = await manager.prepareForExecution()

    expect(result.resolvedHooks.size).toBe(0)
    expect(result.hookRegistryError).toContain(expectedError)
    expect(result.authoringIssuesById.size).toBe(0)
  })
})

describe('HookRegistryManager.createHook', () => {
  it('creates hooks.yaml and source content together, generating a canonical hook id when omitted', async () => {
    const { dir, manager } = await createManagerWorkspace('workspace:\n  hooksFile: ./hooks.yaml\n')

    const result = await manager.createHook({
      hook: {
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: '30s',
        network: false,
      },
      source: 'console.log("login")\n',
    })

    expect(result.hook.id).toMatch(/^h_/)
    expect(result.hook).toEqual({
      id: result.hook.id,
      name: 'login',
      runtime: 'node',
      file: './scripts/login.js',
      timeout: 30000,
      network: false,
      fileMissing: false,
    })
    expect(result.source).toBe('console.log("login")\n')
    expect(result.fieldErrors).toEqual([])

    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(`id: ${result.hook.id}`)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
  })

  it('preserves a provided canonical hook id on create', async () => {
    const { dir, manager } = await createManagerWorkspace('workspace:\n  hooksFile: ./hooks.yaml\n')

    const result = await manager.createHook({
      hook: {
        id: SEEDED_HOOK_ID_TWO,
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: '30s',
        network: false,
      },
      source: 'console.log("login")\n',
    })

    expect(result.hook.id).toBe(SEEDED_HOOK_ID_TWO)
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(`id: ${SEEDED_HOOK_ID_TWO}`)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
  })

  it('blocks validation failures and leaves hooks.yaml and source files untouched', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )

    const hooksBefore = await readFile(join(dir, 'hooks.yaml'), 'utf-8')

    await expect(manager.createHook({
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login',
        runtime: 'ruby' as any,
        file: '../escape/login.js',
        timeout: 'later',
        network: 'yes' as any,
      },
      source: 'console.log("updated")\n',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'id', code: 'duplicate_id' }),
        expect.objectContaining({ field: 'name', code: 'duplicate_name' }),
        expect.objectContaining({ field: 'runtime', code: 'invalid_runtime' }),
        expect.objectContaining({ field: 'file', code: 'unsafe_path' }),
        expect.objectContaining({ field: 'timeout', code: 'invalid_timeout' }),
        expect.objectContaining({ field: 'network', code: 'invalid_network' }),
      ]),
    })

    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toBe(hooksBefore)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
    expect(await pathExists(join(dir, 'escape/login.js'))).toBe(false)
  })
})

describe('HookRegistryManager.updateHook', () => {
  it('moves the source file when the authored hook path changes and leaves no stale file behind', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )

    const result = await manager.updateHook(SEEDED_HOOK_ID, {
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login setup',
        runtime: 'bun',
        file: './moved/login.ts',
        timeout: '45s',
        network: true,
      },
      source: 'export default async function login() {}\n',
    })

    expect(result.hook).toEqual({
      id: SEEDED_HOOK_ID,
      name: 'login setup',
      runtime: 'bun',
      file: './moved/login.ts',
      timeout: 45000,
      network: true,
      fileMissing: false,
    })
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(false)
    expect(await readFile(join(dir, 'moved/login.ts'), 'utf-8')).toBe('export default async function login() {}\n')
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain('file: ./moved/login.ts')
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain('timeout: 45s')
  })

  it('preserves a shared old source file when another hook still points at it', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/shared.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/shared.js',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/shared.js': 'console.log("shared")\n',
        },
      },
    )

    await manager.updateHook(SEEDED_HOOK_ID, {
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login setup',
        runtime: 'bun',
        file: './moved/login.ts',
        timeout: '45s',
        network: true,
      },
      source: 'export default async function login() {}\n',
    })

    expect(await pathExists(join(dir, 'scripts/shared.js'))).toBe(true)
    expect(await readFile(join(dir, 'scripts/shared.js'), 'utf-8')).toBe('console.log("shared")\n')
    expect(await readFile(join(dir, 'moved/login.ts'), 'utf-8')).toBe('export default async function login() {}\n')
  })

  it('surfaces legacy ts runtime records as invalid registry data', async () => {
    const { manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: ts',
          '    file: ./scripts/login.ts',
          '    timeout: 30s',
        ].join('\n'),
      },
    )

    await expect(manager.updateHook(SEEDED_HOOK_ID, {
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login setup',
        runtime: 'bun',
        file: './scripts/login.ts',
        timeout: '45s',
        network: true,
      },
      source: 'export default async function login() {}\n',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'runtime', code: 'invalid_runtime' }),
      ]),
    })
  })

  it('blocks path collisions and keeps the original registry plus source content intact', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
          'scripts/existing.js': 'console.log("existing")\n',
        },
      },
    )

    const hooksBefore = await readFile(join(dir, 'hooks.yaml'), 'utf-8')

    await expect(manager.updateHook(SEEDED_HOOK_ID, {
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login',
        runtime: 'node',
        file: './scripts/existing.js',
        timeout: '30s',
        network: true,
      },
      source: 'console.log("updated")\n',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'file', code: 'collision' }),
      ]),
    })

    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toBe(hooksBefore)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
    expect(await readFile(join(dir, 'scripts/existing.js'), 'utf-8')).toBe('console.log("existing")\n')
  })

  it('recreates source content when the old hook file is already missing instead of failing before save', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
      },
    )

    const result = await manager.updateHook(SEEDED_HOOK_ID, {
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: '30s',
        network: true,
      },
      source: 'console.log("recreated")\n',
    })

    expect(result.hook.fileMissing).toBe(false)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("recreated")\n')
  })
})

describe('HookRegistryManager.deleteHook', () => {
  it('blocks delete by default and returns sorted references from tests, suites, and inline runHook usage', async () => {
    const { dir, manager } = await createManagerWorkspace(
      [
        'workspace:',
        '  hooksFile: runtime/hooks/custom-hooks.yaml',
        '  testMatch:',
        '    - specs/web/**/*.yaml',
        '  suiteMatch:',
        '    - cases/**/*.suite.yaml',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'runtime/hooks/scripts/login.js': 'console.log("login")\n',
          'specs/web/auth/login.yaml': [
            'name: Login flow',
            'setup:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
          'specs/web/auth/inline.yaml': [
            'name: Inline login',
            'steps:',
            `  - '{{runHook:"${SEEDED_HOOK_ID}"}} Continue after login'`,
          ].join('\n'),
          'cases/smoke.suite.yaml': [
            'name: Smoke suite',
            'teardown:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
        },
      },
    )

    const result = await manager.deleteHook(SEEDED_HOOK_ID)

    expect(result).toEqual({
      deleted: false,
      references: [
        {
          kind: 'suite',
          label: 'Smoke suite',
          path: 'cases/smoke.suite.yaml',
          context: 'teardown',
        },
        {
          kind: 'inline-runHook',
          label: 'Inline login',
          path: 'specs/web/auth/inline.yaml',
          context: 'steps[0]',
        },
        {
          kind: 'test',
          label: 'Login flow',
          path: 'specs/web/auth/login.yaml',
          context: 'setup',
        },
      ],
    })
    expect(await pathExists(join(dir, 'runtime/hooks/scripts/login.js'))).toBe(true)
    expect(await pathExists(join(dir, 'hooks.yaml'))).toBe(false)
    expect(await readFile(join(dir, 'runtime/hooks/custom-hooks.yaml'), 'utf-8')).toContain(SEEDED_HOOK_ID)
  })

  it('force deletes the registry entry and source file while echoing discovered references', async () => {
    const { dir, manager } = await createManagerWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  testMatch:',
        '    - tests/**/*.yaml',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
          'scripts/cleanup.sh': 'echo cleanup\n',
          'tests/auth/login.yaml': [
            'name: Login flow',
            'setup:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
        },
      },
    )

    const result = await manager.deleteHook(SEEDED_HOOK_ID, { force: true })

    expect(result).toEqual({
      deleted: true,
      references: [
        {
          kind: 'test',
          label: 'Login flow',
          path: 'tests/auth/login.yaml',
          context: 'setup',
        },
      ],
    })
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(false)
    const hooksYaml = await readFile(join(dir, 'hooks.yaml'), 'utf-8')
    expect(hooksYaml).not.toContain(SEEDED_HOOK_ID)
    expect(hooksYaml).toContain(SEEDED_HOOK_ID_TWO)
  })

  it('keeps a shared source file when force deleting one hook that is not the last owner', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/shared.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/shared.js',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/shared.js': 'console.log("shared")\n',
        },
      },
    )

    const result = await manager.deleteHook(SEEDED_HOOK_ID, { force: true })

    expect(result).toEqual({ deleted: true, references: [] })
    expect(await pathExists(join(dir, 'scripts/shared.js'))).toBe(true)
    expect(await readFile(join(dir, 'scripts/shared.js'), 'utf-8')).toBe('console.log("shared")\n')
    const hooksYaml = await readFile(join(dir, 'hooks.yaml'), 'utf-8')
    expect(hooksYaml).not.toContain(SEEDED_HOOK_ID)
    expect(hooksYaml).toContain(SEEDED_HOOK_ID_TWO)
  })

  it('allows force delete when the source file is already missing', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/cleanup.sh': 'echo cleanup\n',
        },
      },
    )

    const result = await manager.deleteHook(SEEDED_HOOK_ID, { force: true })

    expect(result).toEqual({ deleted: true, references: [] })
    const hooksYaml = await readFile(join(dir, 'hooks.yaml'), 'utf-8')
    expect(hooksYaml).not.toContain(SEEDED_HOOK_ID)
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(false)
  })

  it('refuses to delete hooks whose authored source path escapes the hooks.yaml directory', async () => {
    const { dir, manager } = await createManagerWorkspace(
      'workspace:\n  hooksFile: ./nested/hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ../outside/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'outside/login.js': 'console.log("outside")\n',
        },
      },
    )

    await expect(manager.deleteHook(SEEDED_HOOK_ID, { force: true })).rejects.toMatchObject({
      code: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'file', code: 'unsafe_path' }),
      ]),
    })
    expect(await readFile(join(dir, 'outside/login.js'), 'utf-8')).toBe('console.log("outside")\n')
  })
})
