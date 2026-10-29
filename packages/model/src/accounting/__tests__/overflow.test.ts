import { APICallError } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'

import { isTransientError } from '../../middleware/classify.js'
import { isContextLengthOverflow } from '../overflow.js'

function apiError(statusCode: number, isRetryable: boolean, message: string): APICallError {
  return new APICallError({
    message,
    url: 'http://localhost/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody: '',
    isRetryable,
  })
}

const OPENAI_OVERFLOW = apiError(
  400,
  false,
  "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens",
)
const ANTHROPIC_OVERFLOW = apiError(400, false, 'prompt is too long: 215534 tokens > 200000 maximum')

describe('isContextLengthOverflow', () => {
  it('recognizes the OpenAI overflow error shape', () => {
    expect(isContextLengthOverflow(OPENAI_OVERFLOW)).toBe(true)
  })

  it('recognizes the Anthropic overflow error shape', () => {
    expect(isContextLengthOverflow(ANTHROPIC_OVERFLOW)).toBe(true)
  })

  it('is false for a non-overflow / transient error', () => {
    expect(isContextLengthOverflow(apiError(503, true, 'service unavailable'))).toBe(false)
    expect(isContextLengthOverflow(new Error('plain'))).toBe(false)
  })
})

describe('retry non-transience', () => {
  it('an overflow error is classified non-transient so retry keeps skipping it', () => {
    expect(isTransientError(OPENAI_OVERFLOW)).toBe(false)
    expect(isTransientError(ANTHROPIC_OVERFLOW)).toBe(false)
  })
})
