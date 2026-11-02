import { isSdkWarningLogger } from '@vostride/agent-qa-agent-local'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { LogWarningsFunction } from 'ai'

/** Eval stdout is a data channel. The SDK's default logger emits a one-time stdout tip. */
export function installEvalWarningLogger(): () => void {
  const previous = globalThis.AI_SDK_LOG_WARNINGS
  // Respect an operator's deliberate logger or disabled logging. Replace only the SDK default and
  // the logger every command starts with.
  if (previous === false || (typeof previous === 'function' && !isSdkWarningLogger(previous))) {
    return () => {}
  }
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
