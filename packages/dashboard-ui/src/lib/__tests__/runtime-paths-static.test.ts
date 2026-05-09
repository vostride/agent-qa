import { readdirSync, readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../../../', import.meta.url)
const demoConfig = readFileSync(new URL('../../../../../demo-project/agent-qa.config.yaml', import.meta.url), 'utf-8')
const releaseConfig = readFileSync(new URL('../../../../../demo-project/agent-qa.release.config.yaml', import.meta.url), 'utf-8')
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

function readFiles(relativeRoot: string, include: RegExp): string {
  return filesMatching(relativeRoot, include)
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n')
}

describe('runtime path static contract', () => {
  it('keeps the demo config cache under the runtime root', () => {
    expect(demoConfig).toContain('dir: .agent-qa/cache')
  })

  it('keeps the demo config memory root explicit and separate from runtime artifacts', () => {
    expect(demoConfig).toContain('memory:')
    expect(demoConfig).toContain('dir: agent-qa-memory')
  })

  it('keeps the demo config on the canonical workspace sample', () => {
    expect(demoConfig).toContain('tests/web/**/*.yaml')
    expect(demoConfig).toContain('tests/mobile/**/*.yaml')
    expect(demoConfig).toContain('tests/farm/**/*.yaml')
    expect(demoConfig).toContain('suites/**/*.suite.yaml')
    expect(demoConfig).toContain('hooksFile: hooks.yaml')
    expect(demoConfig).toContain('agentRules: ./agent-rules.md')
    expect(demoConfig).toContain('envFile: .env')
    expect(demoConfig).toContain('secretsFile: .env.secrets.local')
  })

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

  it('keeps memory runtime consumers on the shared configured root resolver', () => {
    const cliSource = readSource('packages/cli/src/')
    const dashboardSource = readSource('packages/dashboard-server/src/')
    const memoryFactorySource = readFileSync(new URL('../../../../../packages/core/src/memory/factory.ts', import.meta.url), 'utf-8')
    const localProviderSource = readFileSync(new URL('../../../../../packages/core/src/memory/local-provider.ts', import.meta.url), 'utf-8')

    expect(cliSource).toContain('resolveMemoryRoot')
    expect(dashboardSource).toContain('resolveMemoryRoot')
    expect(dashboardSource).not.toContain("join(workspaceDir, 'agent-qa-memory')")
    expect(dashboardSource).not.toContain("join(configDir, 'agent-qa-memory')")
    expect(memoryFactorySource).toContain('DEFAULT_MEMORY_DIR')
    expect(localProviderSource).toContain('DEFAULT_MEMORY_DIR')
    expect(memoryFactorySource).not.toContain("?? 'agent-qa-memory'")
    expect(localProviderSource).not.toContain("?? 'agent-qa-memory'")
  })

  it('keeps dashboard UI source exposing audited config paths and create actions', () => {
    const uiSource = readSource('packages/dashboard-ui/src/')

    for (const path of [
      'services.dashboard.dbPath',
      'services.dashboard.artifactsDir',
      'services.cache.dir',
      'services.cache.ttl',
      'services.memory.dir',
      'services.memory.provider',
      'services.memory.curatorEnabled',
    ]) {
      expect(uiSource).toContain(path)
    }
    expect(uiSource).toContain('routes.testNew')
    expect(uiSource).toContain('routes.suiteNew')
    expect(uiSource).toContain('routes.hookNew')
    expect(uiSource).toContain('Memory Directory')
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

  it('keeps public mobile app-state examples and removed knobs guarded', () => {
    const demoProjectFiles = readFiles('demo-project/', /\.(ya?ml|mjs)$/)

    expect(demoConfig).toContain('appState: preserve')
    expect(releaseConfig).toContain('appState: preserve')
    expect(releaseConfig).not.toContain('actionProofs')
    expect(demoProjectFiles).not.toContain('actionProofs')
    expect(yamlCompletions).not.toContain('noReset')
  })

  it('keeps removed mobile/action-proof copy out of public dashboard surfaces', () => {
    const publicDashboardFiles = [
      'packages/dashboard-ui/src/components/config-manager/execution-defaults-section.tsx',
      'packages/dashboard-ui/src/components/config-manager/mobile-section.tsx',
      'packages/dashboard-ui/src/components/test-settings-panel.tsx',
      'packages/dashboard-ui/src/lib/config-navigation.ts',
      'packages/dashboard-ui/src/pages/config.tsx',
    ].map((file) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf-8')).join('\n')

    expect(publicDashboardFiles).not.toContain('Default Device')
    expect(publicDashboardFiles).not.toContain('fullReset')
    expect(publicDashboardFiles).not.toContain('actionProofs')
  })
})
