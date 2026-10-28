import { printRunText } from '@vostride/agent-qa-core'
import type { LogWarningsFunction } from 'ai'

/** Eval stdout is a data channel. The SDK's default logger emits a one-time stdout tip. */
export function installEvalWarningLogger(): () => void {
  const previous = globalThis.AI_SDK_LOG_WARNINGS
  // Respect an operator's deliberate logger or disabled logging. Only replace the SDK default.
  if (previous === false || typeof previous === 'function') return () => {}
  const logger: LogWarningsFunction = ({ warnings, provider, model }) => {
    for (const warning of warnings) {
      printRunText(
        `AI SDK Warning (${provider} / ${model}): ${JSON.stringify(warning)}`,
        (text) => process.stderr.write(`${text}\n`),
      )
    }
  }
  globalThis.AI_SDK_LOG_WARNINGS = logger
  return () => {
    if (globalThis.AI_SDK_LOG_WARNINGS === logger) globalThis.AI_SDK_LOG_WARNINGS = previous
  }
}
