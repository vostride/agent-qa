import { Command } from 'commander'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pc from 'picocolors'
import { loadConfigFile } from '../config.js'
import { HARD_CUT_STEPS, INVALID_CONFIG_FIX, isHardCutIssue } from '../hard-cut.js'
import { loadAuthPluginsForRawConfig, toModelProfileAndAuth, type LLMModelAdapter } from '../llm-utils.js'
import { DEFAULT_ANTHROPIC_MODEL } from '../model-defaults.js'
import { NODE_FLOOR_INSTALL_LINE, NODE_FLOOR_MAJOR, nodeFloorRefusal } from '../node-floor.js'
import { loadProviderPluginsForRawConfig } from '../provider-plugins.js'
import {
  discoverWorkspaceFiles,
  formatAppiumInstallGuidance,
  isGitHubActions,
  printRunText,
  resolveAppiumExecutable,
  resolveWorkspacePaths,
  type AgentQaConfig,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import { createModel, getProvider } from '@vostride/agent-qa-model'
import { createKnowledgeChecks } from './doctor-knowledge-checks.js'
// 407-30 (REVIEW IN-06): the row renderer lives in its own module now. This command imports the
// five symbols its emit loop prints with, and re-exports NOTHING — this file's surface is the
// check contract below plus `createDoctorCommand`.
import {
  composeRow,
  formatCheckRow,
  formatFixLines,
  formatStatus,
  resolveTerminalWidth,
} from './doctor-row.js'

// 407 D-18: exported so `doctor-knowledge-checks.ts` can build rows this printer prints without
// restating the row contract. The three types are the whole of what a row is.
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  status: CheckStatus
  message: string
}

export interface DoctorCheck {
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

function checkNodeVersion(): DoctorCheck {
  return {
    name: 'Node.js',
    fixInstructions: NODE_FLOOR_INSTALL_LINE,
    check: async () => {
      const version = process.version
      if (nodeFloorRefusal(version) === undefined) {
        return { status: 'pass', message: version }
      }
      return {
        status: 'fail',
        message: `${version} (requires Node.js ${NODE_FLOOR_MAJOR} or newer)`,
      }
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

function checkLegacyV1MemoryData(configPath: string): DoctorCheck {
  const legacyMemoryDir = resolve(dirname(resolve(configPath)), 'agent-qa-memory')

  return {
    name: 'Legacy v1 memory data',
    fixInstructions: `Remove ${legacyMemoryDir} manually if you no longer need the retired v1 data.`,
    check: async () => {
      if (existsSync(legacyMemoryDir)) {
        return {
          status: 'warn',
          message: `v1 memory data found at ${legacyMemoryDir} — no longer used by agent-qa; safe to delete`,
        }
      }
      return { status: 'pass', message: `no v1 memory data found at ${legacyMemoryDir}` }
    },
  }
}

function checkConfigValidation(
  config: Record<string, unknown> | null,
  configPath: string,
): DoctorCheck {
  const row: DoctorCheck = {
    name: 'Config validation',
    fixInstructions: INVALID_CONFIG_FIX(configPath),
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

        // The printed fix is read after this check returns: the hard cut for keys removed in v2,
        // the key fix otherwise.
        row.fixInstructions = result.error.issues.some(isHardCutIssue)
          ? HARD_CUT_STEPS
          : INVALID_CONFIG_FIX(configPath)
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
  return row
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
    fixInstructions: 'Create the files configured by workspace.hooksFile and workspace.envFile.',
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
        ['workspace.envFile', resolved.workspace.envFile],
      ] as const
      const missingFiles = missing.filter(([, file]) => !existsSync(file.absolutePath))

      if (missingFiles.length > 0) {
        return {
          status: 'fail',
          message: missingFiles.map(([key, file]) => `${key} -> ${file.absolutePath}`).join('; '),
        }
      }

      return { status: 'pass', message: 'hooks and env file found' }
    },
  }
}

function checkDocker(): DoctorCheck {
  return {
    name: 'Docker',
    fixInstructions: 'Install Docker Desktop from https://docker.com/ and ensure the daemon is running',
    check: async () => {
      try {
        const { checkDockerAvailable } = await import('@vostride/agent-qa-runner-local')
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

function configuredLLMName(config: Record<string, unknown> | null): string {
  const registry = config?.registry as { llms?: ActiveLLMConfig[] } | undefined
  const use = config?.use as { llm?: string } | undefined
  const llms = registry?.llms ?? []
  return (llms.find(llm => llm.name === use?.llm) ?? llms[0])?.name ?? '<name>'
}

function checkLLMApiKey(config: Record<string, unknown> | null): DoctorCheck {
  const name = configuredLLMName(config)
  return {
    name: 'LLM credential',
    fixInstructions: `Run \`agent-qa auth set --config ${name} --type api-key\` (it asks for the key), or for a subscription run \`agent-qa auth login --config ${name}\``,
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
  const name = configuredLLMName(config)
  return {
    name: 'Subscription Auth',
    fixInstructions: `Install \`@vostride/agent-qa-subscription-auth\` (\`npm install -D @vostride/agent-qa-subscription-auth\`), declare it in plugins.auth, then run \`agent-qa auth login --config ${name}\``,
    check: async () => {
      const llm = getActiveLLMConfig(config)
      if (getProvider(llm.provider)?.subscription !== true) {
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

      if (getProvider(provider)?.needsBaseURL && (!baseURL || baseURL.trim() === '')) {
        return { status: 'fail', message: `baseURL required for ${provider}` }
      }

      try {
        const auth = await resolveActiveLLMAuth(llm)
        if (auth.kind === 'missing') {
          return { status: 'fail', message: auth.message }
        }
        const { generateText } = await import('ai')
        const { profile, auth: modelAuth } = toModelProfileAndAuth(llm, auth as any)
        // 2026-10-12 (441-04, D-06): fixed probe text, nothing to mask.
        const testModel = createModel(profile, modelAuth, (text) => text)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        try {
          await generateText({
            model: testModel,
            prompt: 'Say "ok"',
            abortSignal: controller.signal,
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

function mobileDriverInstallCommand(): string {
  return 'agent-qa install-mobile-drivers --all'
}

function checkAppium(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Appium',
    fixInstructions: `${formatAppiumInstallGuidance()} Then run \`${mobileDriverInstallCommand()}\`.`,
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
    fixInstructions: `Run \`${mobileDriverInstallCommand()}\``,
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
          await loadProviderPluginsForRawConfig(config, configPath)
        }
      } catch {
        // Config load failed — doctor will report it
      }

      const checks: DoctorCheck[] = [
        checkNodeVersion(),
        checkConfigFile(configPath),
        checkLegacyV1MemoryData(configPath),
        // 407 D-18: the knowledge substrate's three rows sit here — directly after the legacy v1
        // memory row, because they are the same subject — and before config validation, so the
        // rung reads as the conclusion of the store and embedder rows above it.
        ...createKnowledgeChecks({ config, configPath }),
        checkConfigValidation(config, configPath),
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

      // 407-24 (G-407-3): every line below goes through the width budget. Colour is applied HERE
      // and only here, by handing named decorators to the same `composeRow` the formatter used to
      // derive its plain line — so the printed line and the pinned one are one recipe run twice.
      //
      // THIS CHANGE IS CONFINED TO ROW RENDERING. No probe, no capability discovery and no
      // registration cleanup is touched by it: the checks above still answer exactly what they
      // answered before, and doctor still only reads.
      const width = resolveTerminalWidth()
      // Rows quote config names, so under GitHub Actions the table prints once as one wrapped
      // block after the last check; elsewhere each row prints as its check finishes.
      const table: string[] | undefined = isGitHubActions() ? [] : undefined
      const printLine = (line: string): void => {
        if (table === undefined) console.log(line)
        else table.push(line)
      }

      for (const check of checks) {
        const result = await check.check()
        results.push({ check, result })

        const row = formatCheckRow(check.name, result.message, result.status, width)
        printLine(composeRow(row, { dots: pc.dim, status: formatStatus }))
        for (const line of row.continuations) printLine(line)

        if (result.status === 'fail') {
          for (const line of formatFixLines(check.fixInstructions, width)) printLine(pc.dim(line))
          hasFailure = true
        }
      }
      if (table !== undefined) printRunText(table.join('\n'))

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
