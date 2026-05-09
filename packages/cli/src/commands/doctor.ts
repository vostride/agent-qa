import { Command } from 'commander'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pc from 'picocolors'
import { loadConfigFile } from '../config.js'
import { loadAuthPluginsForRawConfig, type LLMModelAdapter } from '../llm-utils.js'
import { DEFAULT_ANTHROPIC_MODEL } from '../model-defaults.js'
import {
  discoverWorkspaceFiles,
  formatAppiumInstallGuidance,
  resolveAppiumExecutable,
  resolveWorkspacePaths,
  type AgentQaConfig,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

interface CheckResult {
  status: CheckStatus
  message: string
}

interface DoctorCheck {
  name: string
  check: () => Promise<CheckResult>
  fixInstructions: string
}

type DoctorWorkspaceResolution =
  | { ok: true; workspace: ResolvedWorkspacePaths }
  | { ok: false; error: string }

function resolveDoctorWorkspace(
  config: Record<string, unknown>,
  configPath: string,
): DoctorWorkspaceResolution {
  try {
    return {
      ok: true,
      workspace: resolveWorkspacePaths({
        config: config as AgentQaConfig,
        configPath,
      }),
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

type ResolvedDoctorAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'bearer-token'; token: string }
  | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: LLMModelAdapter }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'missing'; message: string }

const COMPATIBLE_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible'])
const SUBSCRIPTION_PROVIDERS = new Set(['openai-subscription', 'anthropic-subscription'])

interface ActiveLLMConfig {
  name: string
  provider: string
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
}

function getActiveLLMConfig(config: Record<string, unknown> | null): ActiveLLMConfig {
  const registry = config?.registry as { llms?: ActiveLLMConfig[] } | undefined
  const use = config?.use as { llm?: string } | undefined
  const llms = registry?.llms ?? []
  const selected = llms.find(llm => llm.name === use?.llm) ?? llms[0]

  if (selected) {
    return selected
  }

  return {
    name: 'default',
    provider: 'anthropic-subscription',
    model: DEFAULT_ANTHROPIC_MODEL,
  }
}

async function resolveActiveLLMAuth(llm: ActiveLLMConfig): Promise<ResolvedDoctorAuth> {
  const { resolveLLMAuth } = await import('@vostride/agent-qa-core') as unknown as {
    resolveLLMAuth: (
      configName: string,
      llmConfig: {
        provider: string
        model: string
        baseURL?: string
        providerHeaders?: Record<string, string>
      },
    ) => Promise<ResolvedDoctorAuth>
  }
  return await resolveLLMAuth(llm.name, {
    provider: llm.provider,
    model: llm.model,
    ...(llm.baseURL ? { baseURL: llm.baseURL } : {}),
    ...(llm.providerHeaders ? { providerHeaders: llm.providerHeaders } : {}),
  }) as ResolvedDoctorAuth
}

function applyResolvedAuth(llm: ActiveLLMConfig, auth: ResolvedDoctorAuth): Record<string, unknown> {
  switch (auth.kind) {
    case 'api-key':
      return { ...llm, apiKey: auth.apiKey }
    case 'bearer-token':
      return { ...llm, authToken: auth.token }
    case 'auth-fetch':
      return { ...llm, fetch: auth.fetch, modelAdapter: auth.modelAdapter }
    case 'unauthenticated':
      return { ...llm }
    case 'missing':
      throw new Error(auth.message)
  }
}

function formatStatus(status: CheckStatus): string {
  switch (status) {
    case 'pass': return pc.green('PASS')
    case 'warn': return pc.yellow('WARN')
    case 'fail': return pc.red('FAIL')
    case 'skip': return pc.dim('SKIP')
  }
}

function padDots(name: string, message: string): string {
  const totalWidth = 60
  const used = name.length + message.length
  const dots = Math.max(2, totalWidth - used)
  return pc.dim('.'.repeat(dots))
}

function checkNodeVersion(): DoctorCheck {
  return {
    name: 'Node.js',
    fixInstructions: 'Install Node.js 24+ from https://nodejs.org/',
    check: async () => {
      const version = process.version
      const major = parseInt(version.slice(1).split('.')[0], 10)
      if (major >= 24) {
        return { status: 'pass', message: version }
      }
      return { status: 'fail', message: `${version} (requires 24+)` }
    },
  }
}

function checkConfigFile(configPath: string): DoctorCheck {
  return {
    name: 'Config file',
    fixInstructions: 'Run `agent-qa init` to create a config file',
    check: async () => {
      if (existsSync(configPath)) {
        return { status: 'pass', message: 'agent-qa.config.yaml found' }
      }
      return { status: 'warn', message: 'agent-qa.config.yaml not found' }
    },
  }
}

function checkConfigValidation(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Config validation',
    fixInstructions: 'Fix the config errors above, or delete agent-qa.config.yaml and re-run `agent-qa init`',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config to validate' }
      }

      try {
        const { AgentQaConfigSchema } = await import('@vostride/agent-qa-core')
        const result = AgentQaConfigSchema.safeParse(config)
        if (result.success) {
          return { status: 'pass', message: 'config schema valid' }
        }

        const issues = result.error.issues.slice(0, 3)
        const errors = issues.map((i: { path: PropertyKey[]; message: string }) =>
          `${i.path.map(String).join('.')}: ${i.message}`
        ).join('; ')
        return { status: 'fail', message: errors }
      } catch {
        return { status: 'warn', message: 'could not validate config' }
      }
    },
  }
}

function checkSecretsFile(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Secrets file',
    fixInstructions: 'Set workspace.secretsFile in agent-qa.config.yaml and create the file. It may be empty, but it must exist.',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const resolved = resolveDoctorWorkspace(config, configPath)
      if (!resolved.ok) {
        return { status: 'fail', message: resolved.error }
      }

      if (!existsSync(resolved.workspace.secretsFile.absolutePath)) {
        return { status: 'fail', message: `not found: ${resolved.workspace.secretsFile.absolutePath}` }
      }

      return { status: 'pass', message: `${resolved.workspace.secretsFile.workspaceRelativePath} found` }
    },
  }
}

function checkWorkspaceSupportFiles(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Workspace files',
    fixInstructions: 'Create the files configured by workspace.hooksFile, workspace.agentRules, and workspace.envFile.',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const resolved = resolveDoctorWorkspace(config, configPath)
      if (!resolved.ok) {
        return { status: 'fail', message: resolved.error }
      }

      const missing = [
        ['workspace.hooksFile', resolved.workspace.hooksFile],
        ['workspace.agentRules', resolved.workspace.agentRules],
        ['workspace.envFile', resolved.workspace.envFile],
      ] as const
      const missingFiles = missing.filter(([, file]) => !existsSync(file.absolutePath))

      if (missingFiles.length > 0) {
        return {
          status: 'fail',
          message: missingFiles.map(([key, file]) => `${key} -> ${file.absolutePath}`).join('; '),
        }
      }

      return { status: 'pass', message: 'hooks, agent rules, and env file found' }
    },
  }
}

function checkDocker(): DoctorCheck {
  return {
    name: 'Docker',
    fixInstructions: 'Install Docker Desktop from https://docker.com/ and ensure the daemon is running',
    check: async () => {
      try {
        const { checkDockerAvailable } = await import('@vostride/agent-qa-core')
        const available = await checkDockerAvailable()
        if (available) {
          return { status: 'pass', message: 'Docker daemon running' }
        }
        return { status: 'warn', message: 'Docker not available (hooks require Docker)' }
      } catch {
        return { status: 'warn', message: 'Docker not available (hooks require Docker)' }
      }
    },
  }
}

function checkLLMApiKey(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'LLM credential',
    fixInstructions: 'Run `agent-qa auth set --config <name> --type api-key` for API modes, or declare a subscription auth plugin and authenticate from `agent-qa dashboard`.',
    check: async () => {
      const llm = getActiveLLMConfig(config)
      try {
        const auth = await resolveActiveLLMAuth(llm)
        switch (auth.kind) {
          case 'api-key':
            return { status: 'pass', message: 'Saved API key' }
          case 'bearer-token':
            return { status: 'pass', message: 'Saved bearer token' }
          case 'auth-fetch':
            return { status: 'pass', message: 'OAuth connected' }
          case 'unauthenticated':
            return { status: 'pass', message: `credential optional — ${auth.message}` }
          case 'missing':
            return { status: 'fail', message: auth.message }
        }
      } catch (err: unknown) {
        return { status: 'warn', message: err instanceof Error ? err.message : 'could not resolve LLM credential' }
      }
    },
  }
}

function checkSubscriptionAuth(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Subscription Auth',
    fixInstructions: 'Install `@vostride/agent-qa-subscription-auth`, declare it in plugins.auth, and authenticate from `agent-qa dashboard`.',
    check: async () => {
      const llm = getActiveLLMConfig(config)
      if (!SUBSCRIPTION_PROVIDERS.has(llm.provider)) {
        return { status: 'skip', message: `subscription not used for ${llm.provider}` }
      }

      try {
        const auth = await resolveActiveLLMAuth(llm)
        if (auth.kind === 'auth-fetch') {
          return { status: 'pass', message: 'OAuth connected' }
        }
        if (auth.kind === 'missing') {
          return { status: 'warn', message: auth.message }
        }
        return { status: 'warn', message: 'Subscription providers use OAuth login' }
      } catch {
        return { status: 'warn', message: 'could not check auth store' }
      }
    },
  }
}

function checkLLMConnection(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'LLM connection',
    fixInstructions: 'Check the saved credential, model name, and exact base URL. Run `agent-qa auth test --config <name>` for details.',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const llm = getActiveLLMConfig(config)
      const provider = llm.provider
      const baseURL = llm.baseURL

      if (COMPATIBLE_PROVIDERS.has(provider) && (!baseURL || baseURL.trim() === '')) {
        return { status: 'fail', message: `baseURL required for ${provider}` }
      }

      try {
        const auth = await resolveActiveLLMAuth(llm)
        if (auth.kind === 'missing') {
          return { status: 'fail', message: auth.message }
        }
        const { createModel, getProviderOptions } = await import('@vostride/agent-qa-core')
        const { generateText } = await import('ai')
        const modelConfig = applyResolvedAuth(llm, auth)
        const testModel = await createModel(modelConfig as any)
        const providerOptions = getProviderOptions(modelConfig as any)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        try {
          await generateText({
            model: testModel,
            prompt: 'Say "ok"',
            abortSignal: controller.signal,
            ...(providerOptions ? { providerOptions } : {}),
          })
        } finally {
          clearTimeout(timeout)
        }
        if (auth.kind === 'unauthenticated') {
          return { status: 'pass', message: auth.message }
        }
        return { status: 'pass', message: 'connected' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/auth|unauthorized|401|invalid.*key/i.test(msg)) {
          return { status: 'fail', message: 'Authentication failed. Check the saved credential for this config.' }
        }
        if (/model|not found|404/i.test(msg)) {
          return { status: 'fail', message: 'Model not found. Check the model name.' }
        }
        if (/rate.?limit|429/i.test(msg)) {
          return { status: 'warn', message: 'rate limited — try again later' }
        }
        if (/ECONNREFUSED|ENOTFOUND|timeout|abort/i.test(msg)) {
          return { status: 'fail', message: 'Network error. Check the exact base URL and try again.' }
        }
        return { status: 'fail', message: msg.slice(0, 60) }
      }
    },
  }
}

function checkPlaywright(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Playwright',
    fixInstructions: 'Run `agent-qa install-browsers --chromium`',
    check: async () => {
      // Skip if no browser config (mobile-only)
      const browsers = config?.browsers as unknown[] | undefined
      const hasBrowsers = browsers && browsers.length > 0
      if (!hasBrowsers && !isWebPlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      try {
        execSync('npx playwright --version', { stdio: 'pipe' })
        return { status: 'pass', message: 'installed' }
      } catch {
        return { status: 'fail', message: 'not installed' }
      }
    },
  }
}

function appiumResolverCwd(configPath: string): string {
  return dirname(resolve(configPath))
}

function mobileDriverInstallCommand(config: Record<string, unknown> | null): string {
  const hasAndroid = hasAndroidPlatform(config)
  const hasIOS = hasIOSPlatform(config)
  if (hasAndroid && hasIOS) return 'agent-qa install-mobile-drivers --all'
  if (hasAndroid) return 'agent-qa install-mobile-drivers --android'
  if (hasIOS) return 'agent-qa install-mobile-drivers --ios'
  return 'agent-qa install-mobile-drivers --all'
}

function checkAppium(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Appium',
    fixInstructions: `${formatAppiumInstallGuidance()} Then run \`${mobileDriverInstallCommand(config)}\`.`,
    check: async () => {
      if (!isMobilePlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      try {
        const appium = resolveAppiumExecutable({ cwd: appiumResolverCwd(configPath) })
        const version = execFileSync(appium.command, ['--version'], { stdio: 'pipe' }).toString().trim()
        return { status: 'pass', message: `v${version}` }
      } catch {
        return { status: 'fail', message: 'not installed' }
      }
    },
  }
}

function checkAppiumDrivers(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Appium drivers',
    fixInstructions: `Run \`${mobileDriverInstallCommand(config)}\``,
    check: async () => {
      if (!isMobilePlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      try {
        const appium = resolveAppiumExecutable({ cwd: appiumResolverCwd(configPath) })
        const output = execFileSync(appium.command, ['driver', 'list', '--installed'], { stdio: 'pipe' }).toString()
        const hasDrivers = output.includes('uiautomator2') || output.includes('xcuitest')
        if (hasDrivers) {
          return { status: 'pass', message: 'drivers installed' }
        }
        return { status: 'fail', message: 'no drivers installed' }
      } catch {
        return { status: 'fail', message: 'could not check drivers' }
      }
    },
  }
}

function checkAndroidSDK(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Android SDK',
    fixInstructions: 'Install Android Studio and set ANDROID_HOME environment variable',
    check: async () => {
      if (!hasAndroidPlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
      if (!androidHome) {
        return { status: 'fail', message: 'ANDROID_HOME not set' }
      }

      const adbPath = `${androidHome}/platform-tools/adb`
      if (existsSync(adbPath)) {
        return { status: 'pass', message: 'SDK found' }
      }
      return { status: 'fail', message: 'adb not found in ANDROID_HOME' }
    },
  }
}

function checkXcode(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Xcode',
    fixInstructions: 'Install Xcode from the Mac App Store and run `xcode-select --install`',
    check: async () => {
      if (!hasIOSPlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      if (process.platform !== 'darwin') {
        return { status: 'fail', message: 'iOS testing requires macOS' }
      }

      try {
        execSync('xcrun simctl list', { stdio: 'pipe' })
        return { status: 'pass', message: 'simctl available' }
      } catch {
        return { status: 'fail', message: 'simctl not available' }
      }
    },
  }
}

function checkValidation(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Validate',
    fixInstructions: 'Run `agent-qa validate` for full details, then fix reported errors',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const resolved = resolveDoctorWorkspace(config, configPath)
      if (!resolved.ok) {
        return { status: 'fail', message: resolved.error }
      }

      try {
        const { validateProject } = await import('@vostride/agent-qa-core')
        const result = await validateProject({ configPath, workspace: resolved.workspace })

        if (result.errorCount === 0 && result.warningCount === 0) {
          return { status: 'pass', message: `${result.fileCount} files valid` }
        }
        if (result.errorCount === 0) {
          return { status: 'warn', message: `${result.warningCount} warning(s)` }
        }
        return { status: 'fail', message: `${result.errorCount} error(s), ${result.warningCount} warning(s)` }
      } catch {
        return { status: 'warn', message: 'could not run validation' }
      }
    },
  }
}

function checkTestDiscovery(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Test discovery',
    fixInstructions: 'Add testMatch patterns to agent-qa.config.yaml, or create test files matching your configured patterns',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      try {
        const resolved = resolveDoctorWorkspace(config, configPath)
        if (!resolved.ok) {
          return { status: 'fail', message: resolved.error }
        }
        const parts: string[] = []

        const [testFiles, suiteFiles] = await Promise.all([
          discoverWorkspaceFiles({ workspace: resolved.workspace, kind: 'test' }),
          discoverWorkspaceFiles({ workspace: resolved.workspace, kind: 'suite' }),
        ])
        parts.push(`${testFiles.length} test file(s)`)
        parts.push(`${suiteFiles.length} suite file(s)`)

        const total = parts.join(', ')
        if (parts.every(p => p.startsWith('0 '))) {
          return { status: 'warn', message: `no files found — ${total}` }
        }
        return { status: 'pass', message: total }
      } catch {
        return { status: 'warn', message: 'could not scan for test files' }
      }
    },
  }
}

// Helpers to detect platform from config
function getTargetPlatforms(config: Record<string, unknown> | null): string[] {
  const registry = config?.registry as { targets?: Record<string, Record<string, unknown>> } | undefined
  const targets = registry?.targets
    ?? (config?.targets as Record<string, Record<string, unknown>> | undefined)
  if (!targets) return []
  return Object.values(targets).map((t) => (t.platform as string) ?? 'web')
}

function isWebPlatform(config: Record<string, unknown> | null): boolean {
  const platforms = getTargetPlatforms(config)
  if (platforms.length === 0) return true // default
  return platforms.some((p) => p === 'web')
}

function isMobilePlatform(config: Record<string, unknown> | null): boolean {
  const platforms = getTargetPlatforms(config)
  return platforms.some((p) => p === 'android' || p === 'ios')
}

function hasAndroidPlatform(config: Record<string, unknown> | null): boolean {
  return getTargetPlatforms(config).some((p) => p === 'android')
}

function hasIOSPlatform(config: Record<string, unknown> | null): boolean {
  return getTargetPlatforms(config).some((p) => p === 'ios')
}

function getGlobalConfigPath(command: Command): string {
  return command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
}

export function createDoctorCommand(): Command {
  const cmd = new Command('doctor')
    .description('Validate environment and dependencies')
    .action(async function (this: Command) {
      const configPath = getGlobalConfigPath(this)

      // Try loading config (non-validated, just raw YAML)
      let config: Record<string, unknown> | null = null
      try {
        const loaded = await loadConfigFile(configPath)
        if (loaded && typeof loaded === 'object') {
          config = loaded as Record<string, unknown>
          await loadAuthPluginsForRawConfig(config, configPath)
        }
      } catch {
        // Config load failed — doctor will report it
      }

      const checks: DoctorCheck[] = [
        checkNodeVersion(),
        checkConfigFile(configPath),
        checkConfigValidation(config),
        checkSecretsFile(config, configPath),
        checkWorkspaceSupportFiles(config, configPath),
        checkDocker(),
        checkLLMApiKey(config),
        checkSubscriptionAuth(config),
        checkLLMConnection(config),
        checkPlaywright(config),
        checkAppium(config, configPath),
        checkAppiumDrivers(config, configPath),
        checkAndroidSDK(config),
        checkXcode(config),
        checkTestDiscovery(config, configPath),
        checkValidation(config, configPath),
      ]

      console.log('')
      console.log(pc.bold('  agent-qa doctor'))
      console.log('')

      let hasFailure = false
      const results: { check: DoctorCheck; result: CheckResult }[] = []

      for (const check of checks) {
        const result = await check.check()
        results.push({ check, result })

        const dots = padDots(check.name, result.message)
        const status = formatStatus(result.status)
        console.log(`    ${check.name}  ${dots}  ${result.message}  ${status}`)

        if (result.status === 'fail') {
          console.log(pc.dim(`      Fix: ${check.fixInstructions}`))
          hasFailure = true
        }
      }

      console.log('')
      if (hasFailure) {
        console.log(pc.red('  Some checks failed. See fix instructions above.'))
        process.exitCode = 1
      } else {
        console.log(pc.green('  All checks passed! Your environment is ready.'))
      }
      console.log('')
    })

  return cmd
}
