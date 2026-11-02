import { APICallError } from '@ai-sdk/provider'
import type { LanguageModelMiddleware } from 'ai'

import { isTransientError } from './classify.js'

export interface RetryMiddlewareOptions {
  maxRetries?: number
  initialDelayInMs?: number
  backoffFactor?: number
}

export function retryMiddleware({
  maxRetries = 2,
  initialDelayInMs = 1000,
  backoffFactor = 2,
}: RetryMiddlewareOptions = {}): LanguageModelMiddleware {
  async function run<T>(call: () => PromiseLike<T>): Promise<T> {
    let delay = initialDelayInMs

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call()
      } catch (error) {
        if (isAbortError(error)) throw error
        if (!isTransientError(error) || attempt >= maxRetries) throw error

        const headerDelay = retryAfterMs(error, delay)
        await sleep(headerDelay ?? delay)
        delay *= backoffFactor
      }
    }
  }

  return {
    specificationVersion: 'v4',
    wrapGenerate: ({ doGenerate }) => run(doGenerate),
    wrapStream: ({ doStream }) => run(doStream),
  }
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

function retryAfterMs(error: unknown, delay: number): number | undefined {
  if (!APICallError.isInstance(error)) return undefined

  const headerMs = parseMs(error.responseHeaders?.['retry-after-ms'])
  if (headerMs !== undefined && shouldHonorRetryAfter(headerMs, delay)) return headerMs

  const retryAfter = error.responseHeaders?.['retry-after']
  const seconds = parseSeconds(retryAfter)
  if (seconds !== undefined && shouldHonorRetryAfter(seconds, delay)) return seconds

  return undefined
}

function parseMs(value: string | undefined): number | undefined {
  if (!value) return undefined

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined

  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000)

  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined

  return date - Date.now()
}

function shouldHonorRetryAfter(ms: number, delay: number): boolean {
  return ms >= 0 && (ms < 60_000 || ms < delay)
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
