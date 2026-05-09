import { Command } from 'commander'
import { exec } from 'node:child_process'
import pc from 'picocolors'
import input from '@inquirer/input'
import password from '@inquirer/password'
import type { LLMAuthProviderPlugin, OAuthTokens } from '@vostride/agent-qa-core'

type ProviderMode =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'openai-subscription'
  | 'anthropic-subscription'
  | 'gemini'
  | (string & {})

type SubscriptionProvider = 'openai-subscription' | 'anthropic-subscription'

type CliLLMConfig = {
  name?: string
  provider: ProviderMode
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
  screenshotSize?: number
  effectiveResolution?: number
  contextWindow?: number
}

type ResolvedAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'bearer-token'; token: string }
  | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter?: string; expires?: number }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'missing'; message: string }

const PROVIDER_LABELS: Record<ProviderMode, string> = {
  'openai-compatible': 'OpenAI-compatible',
  'anthropic-compatible': 'Anthropic-compatible',
  'openai-subscription': 'OpenAI subscription',
  'anthropic-subscription': 'Anthropic subscription',
  gemini: 'Gemini',
}

const SUBSCRIPTION_PROVIDERS = new Set<string>([
  'openai-subscription',
  'anthropic-subscription',
])

const API_KEY_CREDENTIAL_PROVIDERS = new Set<string>([
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
])

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as ProviderMode] ?? provider
}

function isSubscriptionProvider(provider: string): provider is SubscriptionProvider {
  return provider === 'openai-subscription' || provider === 'anthropic-subscription'
}

function normalizeConfigName(rawName: unknown): string | null {
  if (typeof rawName !== 'string') return null
  const name = rawName.trim()
  if (!name || name !== rawName) return null
  return name
}

function getGlobalConfigPath(command: Command): string | undefined {
  return command.parent?.parent?.opts<{ config?: string }>().config
    ?? command.parent?.opts<{ config?: string }>().config
}

function printCredentialGuidance(configName: string, provider: string): void {
  console.log(pc.red(`Config ${configName} uses ${providerLabel(provider)} credentials.`))
  console.log(pc.dim('Use agent-qa auth set --config <name> --type api-key'))
  if (provider === 'anthropic-compatible') {
    console.log(pc.dim('or --type bearer-token'))
  }
}

function applyAuthToModelConfig(llmConfig: CliLLMConfig, auth: ResolvedAuth): Record<string, unknown> {
  switch (auth.kind) {
    case 'api-key':
      return { ...llmConfig, apiKey: auth.apiKey }
    case 'bearer-token':
      return { ...llmConfig, authToken: auth.token }
    case 'auth-fetch':
      return { ...llmConfig, fetch: auth.fetch, modelAdapter: auth.modelAdapter }
    case 'unauthenticated':
      return { ...llmConfig }
    case 'missing':
      throw new Error(auth.message)
  }
}

function statusForResolvedAuth(auth: ResolvedAuth): string {
  switch (auth.kind) {
    case 'api-key':
      return pc.green('Saved API key')
    case 'bearer-token':
      return pc.green('Saved bearer token')
    case 'auth-fetch':
      return Number(auth.expires ?? Date.now() + 1) <= Date.now()
        ? pc.red('Expired')
        : pc.green('OAuth connected')
    case 'unauthenticated':
      return pc.dim('No credential')
    case 'missing':
      return pc.red('Missing credential')
  }
}

function extractProviderError(err: unknown): { message: string; statusCode?: number } {
  const errObj = err as Record<string, unknown>
  const statusCode = errObj?.statusCode as number | undefined
  const responseBody = errObj?.responseBody as string | undefined
  const data = errObj?.data as Record<string, unknown> | undefined
  const apiError = data?.error as Record<string, string> | undefined

  let message = err instanceof Error ? err.message : String(err)

  if (apiError?.message && apiError.message !== 'Error') {
    message = apiError.message
  } else if (typeof data?.detail === 'string') {
    message = data.detail
  } else if (responseBody) {
    try {
      const body = JSON.parse(responseBody)
      if (body?.detail) message = body.detail
      else if (body?.error?.message && body.error.message !== 'Error') message = body.error.message
    } catch {
      // Provider did not return JSON.
    }
  }

  return { message, statusCode }
}

function openAuthorizationUrl(url: string): void {
  const quotedUrl = JSON.stringify(url)
  const command = process.platform === 'darwin'
    ? `open ${quotedUrl}`
    : process.platform === 'win32'
      ? `start "" ${quotedUrl}`
      : `xdg-open ${quotedUrl}`
  exec(command, () => {})
}

function printMissingSubscriptionPluginGuidance(configName: string, provider: SubscriptionProvider): void {
  console.log(pc.red(`Provider "${provider}" is configured for "${configName}", but no auth plugin is registered.`))
  console.log(pc.dim(`Config: ${configName}`))
  console.log(pc.dim(`Provider: ${provider}`))
  console.log(pc.dim('Install the subscription auth plugin:'))
  console.log(pc.dim('  npm install -D @vostride/agent-qa-subscription-auth'))
  console.log(pc.dim('Declare it in agent-qa.config.yaml under plugins.auth:'))
  console.log(pc.dim('  plugins:'))
  console.log(pc.dim('    auth:'))
  console.log(pc.dim('      - package: @vostride/agent-qa-subscription-auth'))
  console.log(pc.dim('Then authenticate from agent-qa dashboard or rerun this command.'))
}

async function readTokensFromPlugin(
  provider: SubscriptionProvider,
  plugin: LLMAuthProviderPlugin,
  started: Awaited<ReturnType<NonNullable<LLMAuthProviderPlugin['startAuth']>>>,
): Promise<OAuthTokens | null> {
  if (started.waitForTokens) {
    return await started.waitForTokens
  }

  if (plugin.dashboardAuth.mode === 'manual-code') {
    if (!plugin.exchangeCode) {
      console.log(pc.red(`Provider "${provider}" does not support CLI code exchange. Use agent-qa dashboard.`))
      process.exitCode = 1
      return null
    }
    const code = (await input({ message: 'Authorization code:' })).trim()
    if (!code) {
      console.log(pc.red('Authorization code is required'))
      process.exitCode = 1
      return null
    }
    return await plugin.exchangeCode({ code, sessionState: started.sessionState })
  }

  console.log(pc.red(`Provider "${provider}" does not support CLI auth login. Use agent-qa dashboard.`))
  process.exitCode = 1
  return null
}

async function runSubscriptionPluginLogin(configName: string, provider: SubscriptionProvider): Promise<void> {
  const { getLLMAuthProviderPlugin, writeAuth } = await import('@vostride/agent-qa-core')
  const plugin = getLLMAuthProviderPlugin(provider)

  if (!plugin) {
    printMissingSubscriptionPluginGuidance(configName, provider)
    process.exitCode = 1
    return
  }

  if (!plugin.startAuth) {
    console.log(pc.red(`Provider "${provider}" does not support CLI auth login. Use agent-qa dashboard.`))
    process.exitCode = 1
    return
  }

  let started: Awaited<ReturnType<NonNullable<LLMAuthProviderPlugin['startAuth']>>> | undefined
  try {
    started = await plugin.startAuth({ configName })
    console.log(`Open this URL to authenticate: ${pc.cyan(started.authorizeUrl)}`)
    openAuthorizationUrl(started.authorizeUrl)

    const tokens = await readTokensFromPlugin(provider, plugin, started)
    if (!tokens) return

    await writeAuth(configName, {
      type: 'oauth',
      provider: plugin.credentialProviderId,
      tokens,
    })
    console.log(pc.green(`Authenticated ${configName} with ${plugin.label}`))
  } catch (err: unknown) {
    console.log(pc.red(err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  } finally {
    started?.cleanup?.()
  }
}

export function createAuthCommand(): Command {
  const cmd = new Command('auth')
    .description('Manage LLM config credentials')

  cmd.addCommand(
    new Command('login')
      .description('Authenticate with a subscription provider')
      .requiredOption('--config <name>', 'named subscription LLM config to authenticate')
      .action(async (opts: { config: string }, command: Command) => {
        const { resolveNamedConfig } = await import('../llm-utils.js')
        const configPath = getGlobalConfigPath(command)

        let provider: SubscriptionProvider
        let configName: string

        try {
          const requestedName = normalizeConfigName(opts.config)
          if (!requestedName) {
            console.log(pc.red('configName is required'))
            return
          }
          const resolved = await resolveNamedConfig(requestedName, configPath)
          const resolvedName = normalizeConfigName(resolved.config.name)
          if (!resolvedName) {
            console.log(pc.red('Config name is invalid'))
            return
          }
          configName = resolvedName
          const configProvider = resolved.config.provider
          if (!isSubscriptionProvider(configProvider)) {
            printCredentialGuidance(configName, configProvider)
            return
          }
          provider = configProvider
        } catch (err: unknown) {
          console.log(pc.red(err instanceof Error ? err.message : String(err)))
          return
        }

        await runSubscriptionPluginLogin(configName, provider)
      }),
  )

  cmd.addCommand(
    new Command('set')
      .description('Save a credential for a named LLM config')
      .requiredOption('--config <name>', 'named LLM config to save a credential for')
      .requiredOption('--type <type>', 'credential type: api-key or bearer-token')
      .argument('[secret]', 'credential secret; prompted when omitted')
      .action(async (secretArg: string | undefined, opts: { config: string; type: string }, command: Command) => {
        const credentialType = opts.type.trim()
        if (credentialType !== 'api-key' && credentialType !== 'bearer-token') {
          console.log(pc.red('type must be api-key or bearer-token'))
          return
        }

        const { resolveNamedConfig } = await import('../llm-utils.js')
        const configPath = getGlobalConfigPath(command)
        let resolved: { config: CliLLMConfig }
        try {
          resolved = await resolveNamedConfig(opts.config, configPath)
        } catch (err: unknown) {
          console.log(pc.red(err instanceof Error ? err.message : String(err)))
          return
        }

        const configName = resolved.config.name ?? opts.config
        const provider = resolved.config.provider

        if (SUBSCRIPTION_PROVIDERS.has(provider)) {
          console.log(pc.red('Subscription providers use OAuth login'))
          return
        }

        if (credentialType === 'bearer-token' && provider !== 'anthropic-compatible') {
          console.log(pc.red('bearer-token credentials are only supported for anthropic-compatible configs'))
          return
        }

        if (credentialType === 'api-key' && !API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
          console.log(pc.red('api-key credentials are not supported for this provider'))
          return
        }

        const secret = (secretArg ?? await password({ message: 'Secret:' })).trim()
        if (!secret) {
          console.log(pc.red('Secret is required'))
          return
        }

        const { writeAuth } = await import('@vostride/agent-qa-core') as unknown as {
          writeAuth: (configName: string, credential: Record<string, unknown>) => Promise<void>
        }
        if (credentialType === 'bearer-token') {
          await writeAuth(configName, { type: 'bearer', provider: 'anthropic-compatible', token: secret })
          console.log(pc.green(`Saved bearer token for ${configName}`))
        } else {
          await writeAuth(configName, { type: 'api', provider, key: secret })
          console.log(pc.green(`Saved API key for ${configName}`))
        }
      }),
  )

  cmd.addCommand(
    new Command('status')
      .description('Show credential status for configured LLMs')
      .action(async function (this: Command) {
        const { loadAuthPluginsForRawConfig, resolveModelAuth } = await import('../llm-utils.js')
        const { loadConfigFile } = await import('../config.js')
        const configPath = getGlobalConfigPath(this) ?? 'agent-qa.config.yaml'

        console.log(pc.bold('Auth status:\n'))

        let llms: CliLLMConfig[] | undefined
        let defaultLLM: string | undefined
        try {
          const cfg = (await loadConfigFile(configPath)) as any
          await loadAuthPluginsForRawConfig(cfg, configPath)
          llms = cfg?.registry?.llms
          defaultLLM = cfg?.use?.llm
        } catch {
          // No readable config.
        }

        if (!llms?.length) {
          console.log(pc.dim('  No LLM configs found'))
          return
        }

        const maxNameLen = Math.max(...llms.map(c => String(c.name ?? '').length), 4) + 12
        for (const llm of llms) {
          const name = String(llm.name ?? '')
          const isDefault = name === defaultLLM
          const label = isDefault ? `${name} ${pc.dim('(default)')}` : name
          const rawLabel = isDefault ? `${name} (default)` : name
          const padLen = Math.max(0, maxNameLen - rawLabel.length)
          const dots = '.'.repeat(padLen + 2)
          const provider = llm.provider
          const status = statusForResolvedAuth(await resolveModelAuth(name, llm) as ResolvedAuth)

          console.log(`  ${label} ${pc.dim(`[${providerLabel(provider)}]`)} ${pc.dim(dots)} ${status}`)
        }
      }),
  )

  cmd.addCommand(
    new Command('logout')
      .description('Remove stored credentials for a named config')
      .option('--config <name>', 'named LLM config to log out from')
      .action(async (opts: { config?: string }, command: Command) => {
        const { removeAuth } = await import('@vostride/agent-qa-core')
        const { resolveNamedConfig } = await import('../llm-utils.js')
        const configPath = getGlobalConfigPath(command)

        let storeKey: string | undefined

        if (opts.config) {
          storeKey = opts.config
        } else {
          try {
            const resolved = await resolveNamedConfig(undefined, configPath)
            storeKey = resolved.config.name
          } catch {
            console.log(pc.red('Specify --config <name> or run with a config file'))
            return
          }
        }

        await removeAuth(storeKey)
        console.log(pc.green(`Logged out from ${storeKey}`))
      }),
  )

  cmd.addCommand(
    new Command('test')
      .description('Test LLM connection using named config credentials')
      .option('--config <name>', 'named LLM config to test')
      .option('--provider <name>', 'override config provider')
      .option('--model <name>', 'override config model')
      .action(async (opts: { config?: string; provider?: string; model?: string }, command: Command) => {
        const { resolveModelAuth, resolveNamedConfig } = await import('../llm-utils.js')
        const configPath = getGlobalConfigPath(command)

        let planner: CliLLMConfig
        let configName: string

        try {
          const resolved = await resolveNamedConfig(opts.config, configPath)
          const { name, ...modelFields } = resolved.config
          planner = modelFields
          configName = name
        } catch (err: unknown) {
          console.log(pc.red(err instanceof Error ? err.message : String(err)))
          return
        }

        if (opts.provider) planner = { ...planner, provider: opts.provider as ProviderMode }
        if (opts.model) planner = { ...planner, model: opts.model }

        console.log(pc.dim(`Testing config: ${configName}...`))

        const auth = await resolveModelAuth(configName, planner) as ResolvedAuth
        if (auth.kind === 'missing') {
          console.log(pc.red(auth.message))
          return
        }
        if (auth.kind === 'unauthenticated') {
          console.log(pc.dim(auth.message))
        }

        const { createModel, getProviderOptions } = await import('@vostride/agent-qa-core')
        const { generateText } = await import('ai')

        const modelConfig = applyAuthToModelConfig(planner, auth)
        const model = await createModel(modelConfig as any)
        const providerOpts = getProviderOptions(modelConfig as any)

        const start = Date.now()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        try {
          await generateText({
            model,
            prompt: 'Say "ok"',
            abortSignal: controller.signal,
            ...(providerOpts ? { providerOptions: providerOpts } : {}),
          })
          const elapsed = Date.now() - start
          console.log(pc.green(`Connected to ${planner.provider}/${planner.model} (${elapsed}ms)`))
        } catch (err: unknown) {
          const { message, statusCode } = extractProviderError(err)
          const fullContext = `${message} ${statusCode ?? ''}`

          if (/auth|unauthorized|401|invalid.*key|permission/i.test(fullContext)) {
            console.log(pc.red('Authentication failed. Check the saved credential for this config.'))
          } else if (/model.*not.*support|not found|404|does not exist/i.test(fullContext)) {
            console.log(pc.red('Model not found. Check the model name.'))
          } else if (/rate|429|quota|limit/i.test(fullContext)) {
            console.log(pc.red('Rate limited. Try again later.'))
          } else if (/ECONNREFUSED|ENOTFOUND|timeout|abort|fetch failed|network/i.test(fullContext)) {
            console.log(pc.red('Network error. Check the exact base URL and try again.'))
          } else if (/invalid_request|400|bad request/i.test(fullContext)) {
            console.log(pc.red('Invalid request. Check model and provider settings.'))
          } else {
            console.log(pc.red(`Connection failed. ${message}`))
          }
          console.log(pc.dim(message))
        } finally {
          clearTimeout(timeout)
        }
      }),
  )

  return cmd
}
