import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { backstopServerError } from '../server/request-url.js'

class LeakyError extends Error {
  readonly body = 'token=sk-live-123'
}

function fakeResponse(): ServerResponse {
  return {
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ServerResponse
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the request backstop line', () => {
  it('names the method and the error kind under the server tag, and nothing else of the error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    backstopServerError(fakeResponse(), { method: 'POST' }, new LeakyError('secret-message'))

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]).toHaveLength(1)
    const line = String(errorSpy.mock.calls[0]?.[0])
    expect(line).toMatch(
      /^\d\d:\d\d:\d\d  server     A POST handler threw \(LeakyError\); answered 500 rather than ending the process$/u,
    )
    expect(line).not.toContain('secret-message')
    expect(line).not.toContain('sk-live-123')
  })
})
