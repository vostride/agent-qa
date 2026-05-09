import type { PlatformAdapter } from '../types/platform.js'

export async function captureFailureScreenshot(
  adapter: PlatformAdapter,
): Promise<Buffer | undefined> {
  try {
    if (!('screenshot' in adapter) || typeof (adapter as { screenshot?: () => Promise<Buffer> }).screenshot !== 'function') {
      return undefined
    }
    return await (adapter as { screenshot: () => Promise<Buffer> }).screenshot()
  } catch {
    return undefined
  }
}
