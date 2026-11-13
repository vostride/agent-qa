import type { AppiumManager } from '@vostride/agent-qa-dashboard'

// This process's one Appium manager: every run in the process that starts Appium shares its server.
let manager: AppiumManager | undefined

export async function ensureProcessAppium(logLevel: string): Promise<string> {
  const dashboard = await import('@vostride/agent-qa-dashboard')
  manager ??= new dashboard.AppiumManager({ logLevel: logLevel === 'debug' ? 'debug' : 'normal' })
  // Held here because a stop during the start drops the process's manager.
  const current = manager
  await current.ensureRunning()
  return current.getUrl()
}

// A manager that was shut down starts nothing again, so the next ensure builds a new one.
export function stopProcessAppium(): Promise<void> | undefined {
  const stopping = manager?.shutdown()
  manager = undefined
  return stopping
}

export function stopProcessAppiumWithin(boundMs: number): Promise<void> | undefined {
  const stopping = stopProcessAppium()
  if (stopping === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    stopping,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs)
      timer.unref()
    }),
  ]).finally(() => clearTimeout(timer))
}
