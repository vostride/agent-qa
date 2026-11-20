import type { AppiumManager } from '@vostride/agent-qa-dashboard'

// This process's one Appium manager: every run in the process that starts Appium shares its server.
let manager: AppiumManager | undefined
let releases: Array<() => void> = []

export async function ensureProcessAppium(
  logLevel: string,
  mask?: (text: string) => string,
): Promise<string> {
  const dashboard = await import('@vostride/agent-qa-dashboard')
  manager ??= new dashboard.AppiumManager({ logLevel: logLevel === 'debug' ? 'debug' : 'normal' })
  // Held here because a stop during the start drops the process's manager.
  const current = manager
  // Bound for each run, because the process's manager can serve runs of more than one config.
  if (mask !== undefined) releases.push(current.bindMask(mask))
  await current.ensureRunning()
  return current.getUrl()
}

function releaseMasks(bound: ReadonlyArray<() => void>): void {
  for (const release of bound) {
    try {
      release()
    } catch {
      // One mask that cannot be removed leaves the others to remove.
    }
  }
}

// A manager that was shut down starts nothing again, so the next ensure builds a new one.
export function stopProcessAppium(): Promise<void> | undefined {
  const stopping = manager?.shutdown()
  manager = undefined
  const bound = releases
  releases = []
  if (stopping === undefined) {
    releaseMasks(bound)
    return undefined
  }
  // Released once the stop settles, so what Appium prints while it ends is still masked.
  return stopping.finally(() => releaseMasks(bound))
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
