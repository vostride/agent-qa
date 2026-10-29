// the one provider-error classifier the CLI and the dashboard share.
// Moved from `agent-qa auth test`: its regexes, their order and its six sentences are the
// contract `auth-test.test.ts` pins, so the CLI's printed lines stay byte-identical.

/** The class of a failed provider call, in the order the classifier tests them. */
export type ProviderErrorClass =
  | 'auth_error'
  | 'model_not_found'
  | 'rate_limit'
  | 'network_error'
  | 'invalid_request'
  | 'provider_error'
// prettier-ignore
export const PROVIDER_ERROR_CLASSES = [
  'auth_error',
  'model_not_found',
  'rate_limit',
  'network_error',
  'invalid_request',
  'provider_error',
] as const satisfies readonly ProviderErrorClass[]

export function extractProviderError(err: unknown): { message: string; statusCode?: number } {
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

/** The first class whose pattern matches wins, so a message naming two classes is stable. */
export function classifyProviderError(message: string, statusCode?: number): ProviderErrorClass {
  const fullContext = `${message} ${statusCode ?? ''}`
  if (/auth|unauthorized|401|invalid.*key|permission/i.test(fullContext)) return 'auth_error'
  if (/model.*not.*support|not found|404|does not exist/i.test(fullContext)) return 'model_not_found'
  if (/rate|429|quota|limit/i.test(fullContext)) return 'rate_limit'
  if (/ECONNREFUSED|ENOTFOUND|timeout|abort|fetch failed|network/i.test(fullContext)) {
    return 'network_error'
  }
  if (/invalid_request|400|bad request/i.test(fullContext)) return 'invalid_request'
  return 'provider_error'
}

export function providerErrorSentence(errorClass: ProviderErrorClass, message: string): string {
  switch (errorClass) {
    case 'auth_error':
      return 'Authentication failed. Check the saved credential for this config.'
    case 'model_not_found':
      return 'Model not found. Check the model name.'
    case 'rate_limit':
      return 'Rate limited. Try again later.'
    case 'network_error':
      return 'Network error. Check the exact base URL and try again.'
    case 'invalid_request':
      return 'Invalid request. Check model and provider settings.'
    case 'provider_error':
      return `Connection failed. ${message}`
  }
}
