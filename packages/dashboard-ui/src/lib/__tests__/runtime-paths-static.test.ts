import { readdirSync, readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../../../', import.meta.url)
const yamlCompletions = readFileSync(new URL('../yaml-completions.ts', import.meta.url), 'utf-8')
const workspaceResolverTest = readFileSync(new URL('../../../../../packages/core/src/workspace/__tests__/workspace-paths.test.ts', import.meta.url), 'utf-8')

function sourceFiles(relativeRoot: string): string[] {
  return filesMatching(relativeRoot, /\.(ts|tsx)$/, (entry) => !/\.test\.(ts|tsx)$/.test(entry))
}

function filesMatching(relativeRoot: string, include: RegExp, includeFile: (entry: string) => boolean = () => true): string[] {
  const root = new URL(relativeRoot, repoRoot)
  const files: string[] = []
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue
      const child = new URL(`${entry}${statSync(new URL(entry, dir)).isDirectory() ? '/' : ''}`, dir)
      const stat = statSync(child)
      if (stat.isDirectory()) {
        walk(child)
      } else if (include.test(entry) && includeFile(entry)) {
        files.push(child.pathname)
      }
    }
  }
  walk(root)
  return files
}

function readSource(relativeRoot: string): string {
  return sourceFiles(relativeRoot)
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n')
}

describe('runtime path static contract', () => {
  it('keeps legacy runtime path fallbacks out of CLI and dashboard source', () => {
    const cliSource = readSource('packages/cli/src/')
    const dashboardSource = readSource('packages/dashboard-server/src/')
    const dashboardStartup = [
      readFileSync(new URL('../../../../../packages/cli/src/commands/dashboard.ts', import.meta.url), 'utf-8'),
      readFileSync(new URL('../../../../../packages/dashboard-server/src/server/server.ts', import.meta.url), 'utf-8'),
    ].join('\n')
    const servicesSchema = readFileSync(new URL('../../../../../packages/core/src/schema/services-schema.ts', import.meta.url), 'utf-8')
    const validateSource = readFileSync(new URL('../../../../../packages/core/src/validation/validate.ts', import.meta.url), 'utf-8')
    const doctorSource = readFileSync(new URL('../../../../../packages/cli/src/commands/doctor.ts', import.meta.url), 'utf-8')

    expect(cliSource).not.toContain("?? 'hooks.yaml'")
    expect(dashboardSource).not.toContain("DEFAULT_HOOKS_FILE = 'hooks.yaml'")
    expect(dashboardStartup).not.toContain('servicesConfig.testsDir')
    expect(dashboardStartup).not.toContain("const suitesDir = '.'")
    expect(servicesSchema).not.toContain('testsDir')
    expect(validateSource).not.toContain('config.testMatch')
    expect(validateSource).not.toContain('config?.testMatch')
    expect(doctorSource).not.toContain('config.testMatch')
    expect(doctorSource).not.toContain('config?.testMatch')
  })

  it('keeps dashboard UI source exposing audited config paths and create actions', () => {
    const uiSource = readSource('packages/dashboard-ui/src/')

    for (const path of [
      'services.dashboard.dbPath',
      'services.dashboard.artifactsDir',
      'services.cache.dir',
      'knowledge.dir',
      'knowledge.commitArtifacts',
      'knowledge.contextBudgetTokens',
    ]) {
      expect(uiSource).toContain(path)
    }
    expect(uiSource).toContain('routes.testNew')
    expect(uiSource).toContain('routes.suiteNew')
    expect(uiSource).toContain('routes.hookNew')
    expect(uiSource).toContain('Knowledge folder')
  })

  it('keeps UI source copy aligned with required env files', () => {
    const uiSource = readSource('packages/dashboard-ui/src/')

    expect(uiSource).not.toContain('Optional dotenv file')
    expect(uiSource).not.toContain('Optional dotenv file loaded before runs start')
  })

  it('keeps non-default workspace resolver fixtures covered', () => {
    expect(workspaceResolverTest).toContain('specs/web/**/*.yaml')
    expect(workspaceResolverTest).toContain('specs/mobile/**/*.yaml')
    expect(workspaceResolverTest).toContain('cases/**/*.suite.yaml')
    expect(workspaceResolverTest).toContain('runtime/hooks/custom-hooks.yaml')
    expect(workspaceResolverTest).toContain('config/env/public.env')
    expect(workspaceResolverTest).toContain('config/env/secrets.local')
  })

  it('keeps the removed noReset knob out of the YAML completions', () => {
    expect(yamlCompletions).not.toContain('noReset')
  })

  it('keeps removed mobile/action-proof copy out of public dashboard surfaces', () => {
    const publicDashboardFiles = [
      'packages/dashboard-ui/src/components/config-manager/mobile-section.tsx',
      'packages/dashboard-ui/src/components/config-manager/model-list.tsx',
      'packages/dashboard-ui/src/components/test-settings-panel.tsx',
      'packages/dashboard-ui/src/lib/config-tabs.ts',
      'packages/dashboard-ui/src/pages/config.tsx',
    ].map((file) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf-8')).join('\n')

    expect(publicDashboardFiles).not.toContain('Default Device')
    expect(publicDashboardFiles).not.toContain('fullReset')
    expect(publicDashboardFiles).not.toContain('actionProofs')
  })
})
