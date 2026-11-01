import type { LanguageModelMiddleware } from 'ai'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider'

// Gated by `AGENT_QA_DEBUG_LLM`; a line carries no header value, query string or provider text.

export interface DebugLoggingOptions {
  /** Force enable/disable. When omitted, resolves from the `AGENT_QA_DEBUG_LLM` env flag. */
  enabled?: boolean
  /** Line sink. Defaults to stderr. Injected by tests as a spy. */
  sink?: (line: string) => void
}

const REQUEST_PREFIX = '[agent-qa:llm] request'
const ERROR_PREFIX = '[agent-qa:llm] provider-error'

function isEnvEnabled(): boolean {
  const raw = typeof process !== 'undefined' ? process.env?.AGENT_QA_DEBUG_LLM : undefined
  if (typeof raw !== 'string') return false
  const value = raw.trim().toLowerCase()
  return value !== '' && value !== '0' && value !== 'false' && value !== 'off' && value !== 'no'
}

function modelIdOf(model: LanguageModelV4 | undefined): string {
  if (model && typeof model === 'object' && 'modelId' in model) {
    const id = (model as { modelId?: unknown }).modelId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return 'unknown'
}

function requestShapeLine(params: LanguageModelV4CallOptions, model: LanguageModelV4 | undefined): string {
  const record = params as unknown as Record<string, unknown>
  const prompt = record.prompt as LanguageModelV4Prompt | undefined
  const messages = Array.isArray(prompt) ? prompt : []
  const roles = messages.map((message) => (message as { role?: unknown }).role ?? '?').join(',')
  const toolCount = Array.isArray(record.tools) ? record.tools.length : 0
  // Param KEYS only (never values) — so `maxOutputTokens`/`temperature`/`toolChoice` are visible
  // but a secret carried in a param value never is.
  const paramKeys = Object.keys(record)
    .filter((key) => key !== 'prompt' && key !== 'tools')
    .join(',')
  return `${REQUEST_PREFIX} model=${modelIdOf(model)} messages=${messages.length} roles=[${roles}] tools=${toolCount} params=[${paramKeys}]`
}

// Compact, non-sensitive projection of the provider's requestBodyValues: model id + message
// roles only, so the emitted tool-call shape context is visible without dumping the body.
function compactRequestBodyValues(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model : undefined
  const items = Array.isArray(record.input)
    ? record.input
    : Array.isArray(record.messages)
      ? record.messages
      : undefined
  const roles = items?.map((item) =>
    item && typeof item === 'object' && 'role' in item ? String((item as { role: unknown }).role) : '?',
  )
  const parts: string[] = []
  if (model) parts.push(`model=${model}`)
  if (roles) parts.push(`roles=[${roles.join(',')}]`)
  return parts.length > 0 ? `{${parts.join(',')}}` : undefined
}

function originAndPath(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
}

function stringField(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== 'object') return undefined
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function providerErrorLine(err: unknown): string {
  const e = (err ?? {}) as {
    name?: unknown
    statusCode?: unknown
    isRetryable?: unknown
    url?: unknown
    responseHeaders?: unknown
    responseBody?: unknown
    requestBodyValues?: unknown
    data?: unknown
    message?: unknown
  }
  const statusCode = typeof e.statusCode === 'number' ? e.statusCode : undefined
  const url = originAndPath(e.url)
  const responseBody = typeof e.responseBody === 'string' ? e.responseBody : undefined
  const request = compactRequestBodyValues(e.requestBodyValues)
  const nested = e.data !== null && typeof e.data === 'object'
    ? (e.data as Record<string, unknown>).error
    : undefined
  const type = stringField(nested, 'type') ?? stringField(e.data, 'type')
  const code = stringField(nested, 'code') ?? stringField(e.data, 'code')
  const headerNames = e.responseHeaders !== null && typeof e.responseHeaders === 'object'
    ? Object.keys(e.responseHeaders)
    : undefined

  const parts = [ERROR_PREFIX]
  if (statusCode !== undefined) parts.push(`statusCode=${statusCode}`)
  if (typeof e.name === 'string') parts.push(`name=${e.name}`)
  if (typeof e.isRetryable === 'boolean') parts.push(`isRetryable=${e.isRetryable}`)
  if (url !== undefined) parts.push(`url=${url}`)
  if (type !== undefined) parts.push(`type=${type}`)
  if (code !== undefined) parts.push(`code=${code}`)
  if (headerNames !== undefined) parts.push(`responseHeaders=[${headerNames.join(',')}]`)
  if (responseBody !== undefined) parts.push(`responseBodyLength=${responseBody.length}`)
  if (request !== undefined) parts.push(`request=${request}`)
  if (statusCode === undefined && responseBody === undefined) {
    const message = e.message !== undefined ? String(e.message) : String(err)
    parts.push(`messageLength=${message.length}`)
  }
  return parts.join(' ')
}

export function debugLoggingMiddleware(options: DebugLoggingOptions = {}): LanguageModelMiddleware {
  const enabled = options.enabled ?? isEnvEnabled()

  // Disabled ⇒ a pure passthrough: no wrap hooks at all, so behavior + performance are byte-
  // identical and the sink is never touched.
  if (!enabled) {
    return { specificationVersion: 'v4' }
  }

  const sink = options.sink ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const emit = (line: string): void => { sink(line) }

  return {
    specificationVersion: 'v4',

    wrapGenerate: async ({ doGenerate, params, model }) => {
      emit(requestShapeLine(params, model))
      try {
        return await doGenerate()
      } catch (err) {
        emit(providerErrorLine(err))
        throw err
      }
    },

    wrapStream: async ({ doStream, params, model }) => {
      emit(requestShapeLine(params, model))
      try {
        return await doStream()
      } catch (err) {
        emit(providerErrorLine(err))
        throw err
      }
    },
  }
}
