import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  applyWorkspaceHookReferenceMigration,
  auditWorkspaceHookReferenceMigration,
  HookReferenceMigrationError,
} from '../migrate-hook-refs.js'

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../demo-project')
const CLEANUP_TARGETS = ['.agent-qa'] as const
const COMMIT_SAFE_MEMORY_DIR = 'agent-qa-memory'
const SYNTHETIC_SUITE_FILE = 'suites/hook-reference-migration.suite.yaml'
const FIXTURE_FILES = [
  'agent-qa.config.yaml',
  'hooks.yaml',
  'tests/web/38-hooks-demo.yaml',
  'tests/web/40-hook-runjs-compare.yaml',
  'tests/web/41-env-runjs-compare.yaml',
  'tests/web/43-inline-hook-demo.yaml',
  'tests/web/45-hook-and-runjs-prestep.yaml',
] as const

const DETERMINISTIC_IDS = [
  'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
  'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
  'h_anchor-brick-cobalt-dune-ember-fjord-grove-harvest-iris-juniper',
  'h_apex-brook-cinder-daisy-elm-fable-gold-halo-ivy-jewel',
  'h_arc-basin-crown-drift-echo-flint-gale-harbor-ink-jasmine',
  'h_atlas-brook-cinder-drift-echo-fable-glen-hollow-ink-jade',
  'h_aurora-canyon-delta-ember-fjord-grove-harbor-iris-jungle-kite',
  'h_acorn-basin-cinder-dawn-elm-fjord-grove-haze-ivory-jet',
  'h_aspen-bloom-coral-drift-ember-field-glade-harbor-iris-jolt',
  'h_anchor-birch-cloud-dune-echo-flint-grove-hollow-ink-jubilee',
] as const

interface SeededWorkspace {
  workspaceDir: string
  hookNamesInOrder: string[]
  legacyHookNames: {
    generateTimestamp: string
    fetchApiData: string
    logCleanup: string
    setRuntimeEnv: string
    fetchHnTopStory: string
  }
}

function buildExpectedNameToId(hookNamesInOrder: string[]): Record<string, string> {
  return Object.fromEntries(hookNamesInOrder.map((name, index) => {
    const id = DETERMINISTIC_IDS[index]
    if (!id) {
      throw new Error(`Add more deterministic hook ids for ${hookNamesInOrder.length} hooks`)
    }
    return [name, id]
  }))
}

function resolveLegacyHookNames(hooks: Array<{ name: string; file: string }>): SeededWorkspace['legacyHookNames'] {
  const hookNameByFile = new Map(hooks.map((hook) => [hook.file, hook.name]))

  const generateTimestamp = hookNameByFile.get('hooks/generate-timestamp.sh')
  const fetchApiData = hookNameByFile.get('hooks/fetch-api-data.js')
  const logCleanup = hookNameByFile.get('hooks/log-cleanup.sh')
  const setRuntimeEnv = hookNameByFile.get('hooks/set-runtime-env.js')
  const fetchHnTopStory = hookNameByFile.get('hooks/fetch-hn-top-story.js')

  if (!generateTimestamp || !fetchApiData || !logCleanup || !setRuntimeEnv || !fetchHnTopStory) {
    throw new Error('Demo hook fixtures changed; update migrate-hook-refs.test.ts')
  }

  return {
    generateTimestamp,
    fetchApiData,
    logCleanup,
    setRuntimeEnv,
    fetchHnTopStory,
  }
}

function buildLegacyFileMutations(legacyHookNames: SeededWorkspace['legacyHookNames']) {
  return {
    'tests/web/38-hooks-demo.yaml': {
      setup: [legacyHookNames.generateTimestamp, legacyHookNames.fetchApiData],
      teardown: [legacyHookNames.logCleanup],
    },
    'tests/web/40-hook-runjs-compare.yaml': {
      setup: [legacyHookNames.fetchHnTopStory],
    },
    'tests/web/41-env-runjs-compare.yaml': {
      setup: [legacyHookNames.fetchHnTopStory],
    },
    'tests/web/43-inline-hook-demo.yaml': {
      inlineHookName: legacyHookNames.setRuntimeEnv,
    },
    'tests/web/45-hook-and-runjs-prestep.yaml': {
      inlineHookName: legacyHookNames.setRuntimeEnv,
    },
  } as const
}

const tempDirs: string[] = []

function deterministicIdFactory() {
  let index = 0
  return () => {
    const next = DETERMINISTIC_IDS[index]
    index += 1
    if (!next) throw new Error('Ran out of deterministic hook ids')
    return next
  }
}

async function copyFixtureFile(workspaceDir: string, relativePath: string) {
  const source = resolve(DEMO_ROOT, relativePath)
  const target = resolve(workspaceDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readFile(source, 'utf-8'), 'utf-8')
}

async function seedLegacyWorkspace(): Promise<SeededWorkspace> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-hook-migrate-'))
  tempDirs.push(workspaceDir)

  for (const fixtureFile of FIXTURE_FILES) {
    await copyFixtureFile(workspaceDir, fixtureFile)
  }

  const hooksPath = resolve(workspaceDir, 'hooks.yaml')
  const hooksDoc = parseYaml(await readFile(hooksPath, 'utf-8')) as { hooks: Array<Record<string, unknown>> }
  const hookNamesInOrder = hooksDoc.hooks.map((hook) => String(hook.name))
  const legacyHookNames = resolveLegacyHookNames(hooksDoc.hooks as Array<{ name: string; file: string }>)
  const legacyFileMutations = buildLegacyFileMutations(legacyHookNames)
  for (const hook of hooksDoc.hooks) {
    delete hook.id
  }
  await writeFile(hooksPath, stringifyYaml(hooksDoc), 'utf-8')

  for (const [relativePath, mutation] of Object.entries(legacyFileMutations)) {
    const absolutePath = resolve(workspaceDir, relativePath)
    const doc = parseYaml(await readFile(absolutePath, 'utf-8')) as Record<string, unknown>
    if ('setup' in mutation) doc.setup = [...mutation.setup]
    if ('teardown' in mutation) doc.teardown = [...mutation.teardown]
    if ('inlineHookName' in mutation && Array.isArray(doc.steps)) {
      doc.steps = doc.steps.map((step) => {
        if (typeof step === 'string') {
          return step.replace(/\{\{runHook:"[^"]+"\}\}/g, `{{runHook:"${mutation.inlineHookName}"}}`)
        }
        if (step && typeof step === 'object' && typeof (step as Record<string, unknown>).step === 'string') {
          return {
            ...(step as Record<string, unknown>),
            step: ((step as Record<string, unknown>).step as string)
              .replace(/\{\{runHook:"[^"]+"\}\}/g, `{{runHook:"${mutation.inlineHookName}"}}`),
          }
        }
        return step
      })
    }
    await writeFile(absolutePath, stringifyYaml(doc), 'utf-8')
  }

  const syntheticSuitePath = resolve(workspaceDir, SYNTHETIC_SUITE_FILE)
  await mkdir(dirname(syntheticSuitePath), { recursive: true })
  await writeFile(
    syntheticSuitePath,
    stringifyYaml({
      'suite-id': 's_hook-reference-migration-demo',
      name: 'Hook reference migration demo',
      target: 'hn-web',
      setup: [legacyHookNames.generateTimestamp],
      teardown: [legacyHookNames.logCleanup],
      tests: [
        {
          test: 'tests/web/01-homepage-basics.yaml',
          id: 't_reit-border-hour-nancy-tram-beni-stra-pool-hen-merk',
        },
      ],
    }),
    'utf-8',
  )

  for (const cleanupTarget of CLEANUP_TARGETS) {
    const cleanupPath = resolve(workspaceDir, cleanupTarget)
    await mkdir(cleanupPath, { recursive: true })
    await writeFile(resolve(cleanupPath, 'seed.txt'), cleanupTarget, 'utf-8')
  }
  const memoryPath = resolve(workspaceDir, COMMIT_SAFE_MEMORY_DIR)
  await mkdir(memoryPath, { recursive: true })
  await writeFile(resolve(memoryPath, 'seed.txt'), COMMIT_SAFE_MEMORY_DIR, 'utf-8')

  return {
    workspaceDir,
    hookNamesInOrder,
    legacyHookNames,
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('hook reference demo migration', () => {
  it('rejects legacy ts runtime definitions during audit', async () => {
    const { workspaceDir } = await seedLegacyWorkspace()
    const hooksPath = resolve(workspaceDir, 'hooks.yaml')
    const hooksDoc = parseYaml(await readFile(hooksPath, 'utf-8')) as { hooks: Array<Record<string, unknown>> }
    hooksDoc.hooks[0].runtime = 'ts'
    await writeFile(hooksPath, stringifyYaml(hooksDoc), 'utf-8')

    const result = await auditWorkspaceHookReferenceMigration({
      workspaceDir,
      generateId: deterministicIdFactory(),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('hooks.0.runtime'),
    ]))
  })

  it('audits the real demo fixtures into a deterministic rewrite payload and cleanup plan', async () => {
    const { workspaceDir, hookNamesInOrder, legacyHookNames } = await seedLegacyWorkspace()
    const expectedNameToId = buildExpectedNameToId(hookNamesInOrder)

    const result = await auditWorkspaceHookReferenceMigration({
      workspaceDir,
      generateId: deterministicIdFactory(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.hookNameToId).toEqual(expectedNameToId)
    expect(result.cleanupTargets).toEqual([...CLEANUP_TARGETS])
    expect(result.rewriteFiles.map((rewrite) => rewrite.path)).toEqual(expect.arrayContaining([
      'hooks.yaml',
      'tests/web/38-hooks-demo.yaml',
      'tests/web/40-hook-runjs-compare.yaml',
      'tests/web/41-env-runjs-compare.yaml',
      'tests/web/43-inline-hook-demo.yaml',
      'tests/web/45-hook-and-runjs-prestep.yaml',
      SYNTHETIC_SUITE_FILE,
    ]))

    const hooksRewrite = result.rewriteFiles.find((rewrite) => rewrite.path === 'hooks.yaml')
    expect(hooksRewrite).toBeDefined()
    const hooksDoc = parseYaml(hooksRewrite!.content) as { hooks: Array<{ name: string; id: string }> }
    expect(hooksDoc.hooks.map((hook) => [hook.name, hook.id])).toEqual(
      hookNamesInOrder.map((name) => [name, expectedNameToId[name]]),
    )

    const hooksDemo = parseYaml(result.rewriteFiles.find((rewrite) => rewrite.path === 'tests/web/38-hooks-demo.yaml')!.content) as Record<string, unknown>
    expect(hooksDemo.setup).toEqual([
      expectedNameToId[legacyHookNames.generateTimestamp],
      expectedNameToId[legacyHookNames.fetchApiData],
    ])
    expect(hooksDemo.teardown).toEqual([expectedNameToId[legacyHookNames.logCleanup]])

    const inlineHookDemo = result.rewriteFiles.find((rewrite) => rewrite.path === 'tests/web/43-inline-hook-demo.yaml')!.content
    expect(inlineHookDemo).toContain(`{{runHook:"${expectedNameToId[legacyHookNames.setRuntimeEnv]}"}}`)

    const suiteRewrite = parseYaml(result.rewriteFiles.find((rewrite) => rewrite.path === SYNTHETIC_SUITE_FILE)!.content) as Record<string, unknown>
    expect(suiteRewrite.setup).toEqual([expectedNameToId[legacyHookNames.generateTimestamp]])
    expect(suiteRewrite.teardown).toEqual([expectedNameToId[legacyHookNames.logCleanup]])
  })

  it('returns blocking errors and aborts before cleanup when any kept hook reference is unmappable', async () => {
    const { workspaceDir, legacyHookNames } = await seedLegacyWorkspace()
    const inlinePath = resolve(workspaceDir, 'tests/web/43-inline-hook-demo.yaml')
    const brokenInline = (await readFile(inlinePath, 'utf-8'))
      .replace(`{{runHook:"${legacyHookNames.setRuntimeEnv}"}}`, '{{runHook:"Missing Demo Hook"}}')
    await writeFile(inlinePath, brokenInline, 'utf-8')

    const audit = await auditWorkspaceHookReferenceMigration({
      workspaceDir,
      generateId: deterministicIdFactory(),
    })

    expect(audit.ok).toBe(false)
    if (audit.ok) return

    expect(audit.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('tests/web/43-inline-hook-demo.yaml'),
      expect.stringContaining('Missing Demo Hook'),
    ]))
    expect(audit.rewriteFiles).toEqual([])
    expect(audit.cleanupTargets).toEqual([])

    await expect(applyWorkspaceHookReferenceMigration({
      workspaceDir,
      generateId: deterministicIdFactory(),
    })).rejects.toBeInstanceOf(HookReferenceMigrationError)

    for (const cleanupTarget of CLEANUP_TARGETS) {
      await expect(readFile(resolve(workspaceDir, cleanupTarget, 'seed.txt'), 'utf-8')).resolves.toBe(cleanupTarget)
    }
    await expect(readFile(resolve(workspaceDir, COMMIT_SAFE_MEMORY_DIR, 'seed.txt'), 'utf-8')).resolves.toBe(COMMIT_SAFE_MEMORY_DIR)
    await expect(readFile(resolve(workspaceDir, 'hooks.yaml'), 'utf-8')).resolves.not.toContain('id: h_')
  })

  it('rewrites the demo fixtures in place and removes runtime state only after a clean audit', async () => {
    const { workspaceDir, hookNamesInOrder, legacyHookNames } = await seedLegacyWorkspace()
    const expectedNameToId = buildExpectedNameToId(hookNamesInOrder)

    const result = await applyWorkspaceHookReferenceMigration({
      workspaceDir,
      generateId: deterministicIdFactory(),
    })

    expect(result.rewriteFiles.length).toBeGreaterThan(1)
    const hooksYaml = await readFile(resolve(workspaceDir, 'hooks.yaml'), 'utf-8')
    expect(hooksYaml).toContain(`id: ${expectedNameToId[legacyHookNames.generateTimestamp]}`)
    const preStepDoc = parseYaml(await readFile(resolve(workspaceDir, 'tests/web/45-hook-and-runjs-prestep.yaml'), 'utf-8')) as { steps: string[] }
    expect(preStepDoc.steps[1]).toContain(`{{runHook:"${expectedNameToId[legacyHookNames.setRuntimeEnv]}"}}`)
    expect(await readFile(resolve(workspaceDir, SYNTHETIC_SUITE_FILE), 'utf-8'))
      .toContain(`- ${expectedNameToId[legacyHookNames.generateTimestamp]}`)

    for (const cleanupTarget of CLEANUP_TARGETS) {
      await expect(readFile(resolve(workspaceDir, cleanupTarget, 'seed.txt'), 'utf-8')).rejects.toThrow()
    }
    await expect(readFile(resolve(workspaceDir, COMMIT_SAFE_MEMORY_DIR, 'seed.txt'), 'utf-8')).resolves.toBe(COMMIT_SAFE_MEMORY_DIR)
  })
})
