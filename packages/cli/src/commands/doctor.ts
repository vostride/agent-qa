import { Command } from 'commander'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import pc from 'picocolors'
import { loadConfigFile } from '../config.js'
import type { InspectDaemonRegistrationOutcome } from '../daemon/registration.js'
import type { DevicesHereLister } from './run.js'
import { HARD_CUT_STEPS, INVALID_CONFIG_FIX, isHardCutIssue } from '../hard-cut.js'
import {
  activeModelEntry,
  loadAuthPluginsForRawConfig,
  toModelProfileAndAuth,
  type LLMModelAdapter,
} from '../llm-utils.js'
import { NODE_FLOOR_INSTALL_LINE, NODE_FLOOR_MAJOR, nodeFloorRefusal } from '../node-floor.js'
import { loadProviderPluginsForRawConfig } from '../provider-plugins.js'
import {
  discoverWorkspaceFiles,
  formatAppiumInstallGuidance,
  getAgentQaVersion,
  getAuthPath,
  pluginsAddLine,
  resolveAppiumExecutable,
  resolveWorkspacePaths,
  SUBSCRIPTION_AUTH_PACKAGE,
  type AgentQaConfig,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import { guardJsonText, isGitHubActions, printRunText } from '@vostride/agent-qa-core/run-text-output'
import { createModel, getProvider } from '@vostride/agent-qa-model'
import { findChromiumByDefault, type ChromiumResolver } from './browser-resolver.js'
import { createDeviceChecks } from './doctor-device-checks.js'
import { createKnowledgeChecks } from './doctor-knowledge-checks.js'
import { createPluginChecks } from './doctor-plugin-checks.js'
import { doorLogLevel, pluginDebugLog } from '../composition/plugin-host.js'
import { createRemoteChecks, listedRemotes } from './doctor-remote-checks.js'
import {
  createNewerVersionCheck,
  createSetupChecks,
  projectAgentQaVersion,
} from './doctor-setup-checks.js'
import { askLatestVersionByDefault, type LatestVersionAsk } from './latest-version-ask.js'
import { findProjectAgentQa } from './project-agent-qa.js'
import { defaultProjectIo, projectHost, type ProjectHost } from './project-host.js'
import { projectRange } from './project-range.js'
import { getTargetPlatforms, hasWebTarget, resolveWebPlacement, type WebPlacement } from './web-placement.js'
import {
  composeRow,
  doctorDocument,
  doctorExitCode,
  formatCheckRow,
  formatFixLines,
  formatStatus,
  resolveTerminalWidth,
  rowFix,
} from './doctor-row.js'

// Exported so `doctor-knowledge-checks.ts` builds rows without restating the row contract.
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  status: CheckStatus
  message: string
  fix?: string
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

export type ResolvedDoctorAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'bearer-token'; token: string }
  | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: LLMModelAdapter }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'missing'; message: string }

export interface ActiveLLMConfig {
  name: string
  provider: string
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
}

const NO_MODEL: CheckResult = { status: 'skip', message: 'no model configured' }
const MODEL_FIX =
  "Set a model on the dashboard's model page, `npx agent-qa dashboard --open /config/models`, or with `npx agent-qa init --llm <choice>`."

function activeLLM(config: Record<string, unknown> | null): ActiveLLMConfig | undefined {
  if (!config) return undefined
  return activeModelEntry(config as { registry?: { llms?: ActiveLLMConfig[] }; use?: { llm?: string } })
}

async function resolveActiveLLMAuth(
  llm: ActiveLLMConfig,
  configPath?: string,
  authPath?: string,
): Promise<ResolvedDoctorAuth> {
  const { resolveLLMAuth } = await import('@vostride/agent-qa-core') as unknown as {
    resolveLLMAuth: (
      configName: string,
      llmConfig: {
        provider: string
        model: string
        baseURL?: string
        providerHeaders?: Record<string, string>
      },
      authPath?: string,
      configPath?: string,
    ) => Promise<ResolvedDoctorAuth>
  }
  return await resolveLLMAuth(llm.name, {
    provider: llm.provider,
    model: llm.model,
    ...(llm.baseURL ? { baseURL: llm.baseURL } : {}),
    ...(llm.providerHeaders ? { providerHeaders: llm.providerHeaders } : {}),
  }, authPath, configPath) as ResolvedDoctorAuth
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
    fixInstructions: 'Run `npx agent-qa init` to create a config file',
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

// A workspace key the config lacks is set by hand before scaffold can write its file.
const WORKSPACE_KEY_FIX =
  'Set the workspace key the message names in agent-qa.config.yaml (workspace.secretsFile, workspace.hooksFile or workspace.envFile), then run `npx agent-qa init --setup scaffold` to write the missing file.'

function checkSecretsFile(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Secrets file',
    fixInstructions:
      'Run `npx agent-qa init --setup scaffold` to write the missing file at workspace.secretsFile. It may be empty, but it must exist.',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const resolved = resolveDoctorWorkspace(config, configPath)
      if (!resolved.ok) {
        return { status: 'fail', message: resolved.error, fix: WORKSPACE_KEY_FIX }
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
    fixInstructions:
      'Run `npx agent-qa init --setup scaffold` to write the missing file at workspace.hooksFile or workspace.envFile.',
    check: async () => {
      if (!config) {
        return { status: 'skip', message: 'no config' }
      }

      const resolved = resolveDoctorWorkspace(config, configPath)
      if (!resolved.ok) {
        return { status: 'fail', message: resolved.error, fix: WORKSPACE_KEY_FIX }
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

async function dockerAvailableByDefault(): Promise<boolean> {
  const { checkDockerAvailable } = await import('@vostride/agent-qa-runner-local')
  return await checkDockerAvailable()
}

function checkDocker(docker: () => Promise<boolean>): DoctorCheck {
  return {
    name: 'Docker',
    fixInstructions: 'Install Docker Desktop from https://docker.com/ and ensure the daemon is running',
    check: async () => {
      try {
        const available = await docker()
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

function checkModel(config: Record<string, unknown> | null): DoctorCheck {
  return {
    name: 'Model',
    fixInstructions: MODEL_FIX,
    check: async () => {
      const llm = activeLLM(config)
      if (!llm) return { status: 'fail', message: 'no model configured' }
      return { status: 'pass', message: `${llm.name}: ${llm.provider} ${llm.model}` }
    },
  }
}

function credentialFix(llm: ActiveLLMConfig | undefined): string {
  if (!llm) return MODEL_FIX
  if (getProvider(llm.provider)?.subscription === true) {
    return `Sign in with \`npx agent-qa auth login --config ${llm.name}\`.`
  }
  return "Save the key on the dashboard's model page, `npx agent-qa dashboard --open /config/models`, or with "
    + `\`npx agent-qa auth set --config ${llm.name} --type api-key\`.`
}

function checkLLMApiKey(
  config: Record<string, unknown> | null,
  configPath?: string,
  authPath?: string,
): DoctorCheck {
  const llm = activeLLM(config)
  return {
    name: 'LLM credential',
    fixInstructions: credentialFix(llm),
    check: async () => {
      if (!llm) return NO_MODEL
      try {
        const auth = await resolveActiveLLMAuth(llm, configPath, authPath)
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

export function checkSubscriptionAuth(
  config: Record<string, unknown> | null,
  configPath?: string,
  authPath?: string,
): DoctorCheck {
  const llm = activeLLM(config)
  const add = pluginsAddLine(SUBSCRIPTION_AUTH_PACKAGE, configPath)
  return {
    name: 'Subscription Auth',
    fixInstructions: llm
      ? `Run \`${add}\`, then run \`npx agent-qa auth login --config ${llm.name}\``
      : MODEL_FIX,
    check: async () => {
      if (!llm) return NO_MODEL
      if (getProvider(llm.provider)?.subscription !== true) {
        return { status: 'skip', message: `subscription not used for ${llm.provider}` }
      }

      try {
        const auth = await resolveActiveLLMAuth(llm, configPath, authPath)
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

const probeModelConnection: DoctorConnectionProbe = async (llm, auth) => {
  const { generateText } = await import('ai')
  const { profile, auth: modelAuth } = toModelProfileAndAuth(llm, auth as any)
  // Fixed probe text, nothing to mask.
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
}

function checkLLMConnection(
  config: Record<string, unknown> | null,
  configPath: string | undefined,
  connection: DoctorConnectionProbe,
  authPath?: string,
): DoctorCheck {
  const llm = activeLLM(config)
  return {
    name: 'LLM connection',
    fixInstructions: llm
      ? `Check the saved credential, model name, and exact base URL. Run \`npx agent-qa auth test --config ${llm.name}\` for details.`
      : MODEL_FIX,
    check: async () => {
      if (!llm) return NO_MODEL

      const provider = llm.provider
      const baseURL = llm.baseURL

      if (getProvider(provider)?.needsBaseURL && (!baseURL || baseURL.trim() === '')) {
        return { status: 'fail', message: `baseURL required for ${provider}` }
      }

      try {
        const auth = await resolveActiveLLMAuth(llm, configPath, authPath)
        if (auth.kind === 'missing') {
          return { status: 'fail', message: auth.message }
        }
        return await connection(llm, auth)
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

async function installedAgentQaDir(configPath: string): Promise<string | undefined> {
  try {
    const range = await projectRange(dirname(resolve(configPath)), {
      homedir: homedir(),
      io: defaultProjectIo,
    })
    return (await findProjectAgentQa(range, range.start, defaultProjectIo))?.realDir
  } catch {
    return undefined
  }
}

function checkPlaywright(
  config: Record<string, unknown> | null,
  configPath: string,
  placement: WebPlacement,
  chromium: ChromiumResolver,
): DoctorCheck {
  return {
    name: 'Playwright',
    fixInstructions: 'Run `npx agent-qa install-browsers --chromium`',
    check: async () => {
      if (placement.everyWebTestRemote) {
        return { status: 'skip', message: 'every web test runs on a remote' }
      }
      if (!hasWebTarget(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      const projectAgentQaDir = await installedAgentQaDir(configPath)
      const answer = chromium(projectAgentQaDir === undefined ? {} : { projectAgentQaDir })
      return answer.found
        ? { status: 'pass', message: 'Chromium found' }
        : { status: 'fail', message: "no Chromium for agent-qa's Playwright" }
    },
  }
}

function appiumResolverCwd(configPath: string): string {
  return dirname(resolve(configPath))
}

function mobileDriverInstallCommand(): string {
  return 'npx agent-qa install-mobile-drivers --all'
}

function checkAppium(
  config: Record<string, unknown> | null,
  configPath: string,
  skips: DeviceToolSkips,
): DoctorCheck {
  return {
    name: 'Appium',
    fixInstructions: `${formatAppiumInstallGuidance()} Then run \`${mobileDriverInstallCommand()}\`.`,
    check: async () => {
      if (skips.appium !== undefined) {
        return { status: 'skip', message: skips.appium }
      }
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

function checkAppiumDrivers(
  config: Record<string, unknown> | null,
  configPath: string,
  skips: DeviceToolSkips,
): DoctorCheck {
  return {
    name: 'Appium drivers',
    fixInstructions: `Run \`${mobileDriverInstallCommand()}\``,
    check: async () => {
      if (skips.appium !== undefined) {
        return { status: 'skip', message: skips.appium }
      }
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

function checkAndroidSDK(
  config: Record<string, unknown> | null,
  skips: DeviceToolSkips,
): DoctorCheck {
  return {
    name: 'Android SDK',
    fixInstructions: 'Install Android Studio and set ANDROID_HOME environment variable',
    check: async () => {
      if (skips.androidSdk !== undefined) {
        return { status: 'skip', message: skips.androidSdk }
      }
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

function checkXcode(config: Record<string, unknown> | null, skips: DeviceToolSkips): DoctorCheck {
  return {
    name: 'Xcode',
    fixInstructions: 'Install Xcode from the Mac App Store and run `xcode-select --install`',
    check: async () => {
      if (skips.xcode !== undefined) {
        return { status: 'skip', message: skips.xcode }
      }
      if (!hasIOSPlatform(config)) {
        return { status: 'skip', message: 'not configured' }
      }

      if (process.platform !== 'darwin') {
        return { status: 'fail', message: 'iOS testing requires macOS' }
      }

      try {
        execSync('xcrun simctl list', { stdio: 'pipe', timeout: 10_000 })
        return { status: 'pass', message: 'simctl available' }
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ETIMEDOUT') {
          return { status: 'fail', message: 'xcrun simctl did not answer within 10 s' }
        }
        return { status: 'fail', message: 'simctl not available' }
      }
    },
  }
}

function checkValidation(config: Record<string, unknown> | null, configPath: string): DoctorCheck {
  return {
    name: 'Validate',
    fixInstructions: 'Run `npx agent-qa validate` for full details, then fix reported errors',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownRemoteSentence(name: string, config: Record<string, unknown> | null): string | undefined {
  const names = listedRemotes(config).map((remote) => remote.name)
  if (names.includes(name)) return undefined
  const listed = names.length === 0
    ? 'registry.remotes lists no remotes.'
    : `registry.remotes lists: ${names.join(', ')}.`
  return `Unknown remote "${name}". ${listed}`
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

interface DeviceToolSkips {
  appium?: string
  androidSdk?: string
  xcode?: string
}

// A device with a remote runs on that server, so the local tools that drive a device are not
// needed for it. A row skips only when the config lists devices and every one it covers is remote.
function deviceToolSkips(config: Record<string, unknown> | null): DeviceToolSkips {
  const registry = config?.registry
  const listed = isRecord(registry) ? registry.devices : undefined
  const devices = isRecord(listed) ? Object.values(listed).filter(isRecord) : []
  const isRemote = (device: Record<string, unknown>): boolean =>
    typeof device.remote === 'string' && device.remote !== ''
  const everyRemote = (some: Record<string, unknown>[]): boolean =>
    some.length > 0 && some.every(isRemote)
  const onPlatform = (platform: string) => devices.filter((device) => device.platform === platform)
  return {
    ...(everyRemote(devices) ? { appium: 'every device is remote' } : {}),
    ...(everyRemote(onPlatform('android')) ? { androidSdk: 'every android device is remote' } : {}),
    ...(everyRemote(onPlatform('ios')) ? { xcode: 'every iOS device is remote' } : {}),
  }
}

function getGlobalConfigPath(command: Command): string {
  return command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
}

// Asks the model one short question with the resolved credential; throws when it cannot answer.
export type DoctorConnectionProbe = (
  llm: ActiveLLMConfig,
  auth: ResolvedDoctorAuth,
) => Promise<CheckResult>

export interface DoctorCommandHooks {
  chromium?: ChromiumResolver
  connection?: DoctorConnectionProbe
  daemon?: (agentQaRoot: string) => Promise<InspectDaemonRegistrationOutcome>
  docker?: () => Promise<boolean>
  host?: Partial<ProjectHost>
  // The latest agent-qa; the default asks the npm registry under a short deadline.
  latestVersion?: LatestVersionAsk
  listDevicesHere?: DevicesHereLister
  now?: () => Date
}

export function createDoctorCommand(hooks: DoctorCommandHooks = {}): Command {
  const chromium = hooks.chromium ?? findChromiumByDefault
  const cmd = new Command('doctor')
    .description('Validate environment and dependencies')
    .option('--remote <name>', 'Show only this remote among the remote rows')
    .option('--json', 'emit the checks as JSON')
    .action(async function (this: Command, options: { remote?: string; json?: boolean }) {
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

      if (options.remote !== undefined) {
        const unknown = unknownRemoteSentence(options.remote, config)
        if (unknown !== undefined) {
          console.error(unknown)
          process.exitCode = 2
          return
        }
      }

      const resolved = config ? resolveDoctorWorkspace(config, configPath) : undefined
      const workspace = resolved?.ok ? resolved.workspace : undefined
      const placement = await resolveWebPlacement(config, workspace)
      const skips = deviceToolSkips(config)
      const host = projectHost(hooks.host)
      const authPath = getAuthPath({ env: host.env, homeDir: host.homedir })
      const setup = { configPath, host: hooks.host ?? {}, runningVersion: getAgentQaVersion().trim() }
      const agentQaVersion = await projectAgentQaVersion(setup)
      const doorFlags = this.parent?.opts<Parameters<typeof doorLogLevel>[0]>() ?? {}
      const debugLog = pluginDebugLog(doorLogLevel(doorFlags, config))

      const checks: DoctorCheck[] = [
        checkNodeVersion(),
        checkConfigFile(configPath),
        checkLegacyV1MemoryData(configPath),
        // After the legacy v1 memory row and before config validation, concluding the store rows.
        ...createKnowledgeChecks({
          config,
          configPath,
          ...(hooks.daemon === undefined ? {} : { probes: { inspectDaemon: hooks.daemon } }),
        }),
        checkConfigValidation(config, configPath),
        ...createSetupChecks(setup),
        checkSecretsFile(config, configPath),
        checkWorkspaceSupportFiles(config, configPath),
        checkDocker(hooks.docker ?? dockerAvailableByDefault),
        checkModel(config),
        checkLLMApiKey(config, configPath, authPath),
        checkSubscriptionAuth(config, configPath, authPath),
        checkLLMConnection(config, configPath, hooks.connection ?? probeModelConnection, authPath),
        checkPlaywright(config, configPath, placement, chromium),
        ...createRemoteChecks({
          config,
          configPath,
          secretsFile: workspace?.secretsFile,
          only: options.remote,
          loopbackTargetsByRemote: placement.loopbackTargetsByRemote,
        }),
        ...createPluginChecks({
          config,
          configDir: dirname(resolve(configPath)),
          configPath,
          secretsFile: workspace?.secretsFile,
          only: options.remote,
          agentQaVersion,
          ...(debugLog === undefined ? {} : { debugLog }),
        }),
        checkAppium(config, configPath, skips),
        checkAppiumDrivers(config, configPath, skips),
        checkAndroidSDK(config, skips),
        checkXcode(config, skips),
        ...createDeviceChecks({
          config,
          ...(hooks.listDevicesHere === undefined ? {} : { listDevicesHere: hooks.listDevicesHere }),
        }),
        createNewerVersionCheck({
          projectVersion: agentQaVersion,
          latestVersion: hooks.latestVersion ?? askLatestVersionByDefault,
          homeDir: host.homedir,
          ...(hooks.now === undefined ? {} : { now: hooks.now }),
        }),
        checkTestDiscovery(config, configPath),
        checkValidation(config, configPath),
      ]

      const results: { check: DoctorCheck; result: CheckResult }[] = []

      if (options.json === true) {
        for (const check of checks) {
          results.push({ check, result: await check.check() })
        }
        console.log(guardJsonText(JSON.stringify(doctorDocument(results), null, 2)))
        process.exitCode = doctorExitCode(results)
        return
      }

      console.log('')
      console.log(pc.bold('  agent-qa doctor'))
      console.log('')

      // Colour is applied only here, through the `composeRow` the formatter uses for plain lines.
      const width = resolveTerminalWidth()
      // Rows quote config names, so under GitHub Actions the table prints once as one wrapped
      // block after the last check; elsewhere each row prints as its check finishes.
      const table: string[] | undefined = isGitHubActions() ? [] : undefined
      const printLine = (line: string): void => {
        if (table === undefined) console.log(line)
        else table.push(line)
      }

      for (const check of checks) {
        const entry = { check, result: await check.check() }
        results.push(entry)

        const row = formatCheckRow(check.name, entry.result.message, entry.result.status, width)
        printLine(composeRow(row, { dots: pc.dim, status: formatStatus }))
        for (const line of row.continuations) printLine(line)

        const fix = rowFix(entry)
        if (fix !== undefined) {
          for (const line of formatFixLines(fix, width)) printLine(pc.dim(line))
        }
      }
      if (table !== undefined) printRunText(table.join('\n'))

      console.log('')
      const exitCode = doctorExitCode(results)
      if (exitCode !== 0) {
        console.log(pc.red('  Some checks failed. See fix instructions above.'))
      } else if (results.some(({ result }) => result.status === 'warn')) {
        console.log(pc.yellow('  No check failed. The warnings above say what to fix.'))
      } else {
        console.log(pc.green('  All checks passed! Your environment is ready.'))
      }
      console.log('')
      process.exitCode = exitCode
    })

  return cmd
}
