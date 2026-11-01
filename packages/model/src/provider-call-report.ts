import type { LanguageModelV4GenerateResult, LanguageModelV4Usage } from '@ai-sdk/provider'
import type { MaskFn } from '@vostride/agent-qa-schema'

/** Neutral facts for one completed provider dispatch. Missing facts are omitted. */
export interface ModelCallReport {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  respondingModelId?: string
}

export type ModelCallEvent =
  | { kind: 'start' }
  | { kind: 'success'; report: ModelCallReport }
  | { kind: 'failure' }

export const MODEL_CALL_EVENT_KINDS = [
  'start', 'success', 'failure',
] as const satisfies readonly ModelCallEvent['kind'][]

/** An explicit assertion that raw usage and response metadata retain this wire origin. */
export type ModelCallReportOrigin =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini'

export const MODEL_CALL_REPORT_ORIGINS = [
  'openai-chat', 'openai-responses', 'anthropic-messages', 'gemini',
] as const satisfies readonly ModelCallReportOrigin[]

export interface ModelCallObservation {
  /** Legacy notification, invoked once per dispatch, without provider data. */
  onProviderCall?: () => void
  /** No prompts, credentials, response bodies or error text cross this callback. */
  onCall?: (event: ModelCallEvent) => void
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isInteger(value) && value >= 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Model-owner only: never infer origin from a model/provider name supplied by a custom model. */
export function providerCallReport(
  result: Pick<LanguageModelV4GenerateResult, 'usage' | 'response'>,
  origin: ModelCallReportOrigin | undefined,
  mask: MaskFn,
): ModelCallReport {
  const inputTokens = count(result.usage.inputTokens.total)
  const outputTokens = count(result.usage.outputTokens.total)
  const cachedInputTokens = rawCacheCount(result.usage, origin)
  // Google 3.0.67 preserves modelVersion in the raw body but leaves modelId TODO.
  // This is still provider-origin metadata, never the requested model fallback.
  const modelId = origin === undefined ? undefined : result.response?.modelId
    ?? (origin === 'gemini' ? object(result.response?.body)?.modelVersion : undefined)
  const respondingModelId = typeof modelId === 'string' && modelId.length > 0
    ? mask(modelId) : undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(respondingModelId === undefined ? {} : { respondingModelId }),
  }
}

function rawCacheCount(usage: LanguageModelV4Usage, origin: ModelCallReportOrigin | undefined) {
  const raw = object(usage.raw)
  if (!raw) return undefined
  switch (origin) {
    case 'openai-chat': return count(object(raw.prompt_tokens_details)?.cached_tokens)
    case 'openai-responses': return count(object(raw.input_tokens_details)?.cached_tokens)
    case 'anthropic-messages': return count(raw.cache_read_input_tokens)
    case 'gemini': return count(raw.cachedContentTokenCount)
    case undefined: return undefined
    default: {
      const exhaustive: never = origin
      return exhaustive
    }
  }
}
