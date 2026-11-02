import { sdkWarningLogger } from '@vostride/agent-qa-model'

const installed = new WeakSet<object>()

// So a command with a logger of its own may replace this one, and never an operator's.
export function isSdkWarningLogger(logger: unknown): boolean {
  return typeof logger === 'function' && installed.has(logger)
}

// Adapted call settings go to the AGENT_QA_DEBUG_LLM log; other warnings print, deprecations once.
export function createSdkWarningLogger(
  print: (line: string, deprecation: boolean) => void,
): ReturnType<typeof sdkWarningLogger> {
  const deprecations = new Set<string>()
  return sdkWarningLogger(({ warnings, provider, model }) => {
    const scope = provider === undefined ? '' : ` (${provider} / ${model})`
    for (const warning of warnings) {
      if (warning.type === 'deprecated') {
        if (deprecations.has(warning.setting)) continue
        deprecations.add(warning.setting)
      }
      print(`AI SDK Warning${scope}: ${JSON.stringify(warning)}`, warning.type === 'deprecated')
    }
  })
}

export function installSdkWarningLogger(): void {
  // An operator's own logger, or `false`, stays.
  if (globalThis.AI_SDK_LOG_WARNINGS !== undefined) return
  const logger = createSdkWarningLogger((line, deprecation) => {
    process.emitWarning(line, { type: deprecation ? 'DeprecationWarning' : 'Warning' })
  })
  installed.add(logger)
  globalThis.AI_SDK_LOG_WARNINGS = logger
}
