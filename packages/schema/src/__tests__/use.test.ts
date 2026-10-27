import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { Use } from '../config/use'
import { useSchema } from '../config/use'

describe('useSchema', () => {
  const config: Use = {} as z.infer<typeof useSchema>
  void config

  it('accepts a minimal web use config', () => {
    const result = useSchema.safeParse({
      platform: 'web',
      browser: { name: 'chromium' },
    })

    expect(result.success).toBe(true)
  })

  it('rejects web use carrying mobile-only appState', () => {
    const result = useSchema.safeParse({
      platform: 'web',
      appState: 'reset',
    })

    expect(result.success).toBe(false)
  })

  it('rejects web use carrying a mobile device reference', () => {
    const result = useSchema.safeParse({
      platform: 'web',
      browser: { name: 'chromium' },
      device: 'pixel',
    })

    expect(result.success).toBe(false)
  })

  it('rejects android use carrying a remoteDevice field', () => {
    const result = useSchema.safeParse({
      platform: 'android',
      device: 'pixel',
      appState: 'reset',
      remoteDevice: { appiumUrl: 'http://x' },
    })

    expect(result.success).toBe(false)
  })

  it('rejects android use carrying an unknown key', () => {
    const result = useSchema.safeParse({
      platform: 'android',
      device: 'pixel',
      unknownKey: 'x',
    })

    expect(result.success).toBe(false)
  })

  it('rejects mobile use carrying a web browser config', () => {
    const result = useSchema.safeParse({
      platform: 'android',
      device: 'pixel',
      browser: { name: 'chromium' },
    })

    expect(result.success).toBe(false)
  })
})
