function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

export function isLiveDebugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true
  }

  if (!canUseStorage()) {
    return false
  }

  try {
    return window.localStorage.getItem("agent-qa:live-debug") === "1"
  } catch {
    return false
  }
}

export function logLiveDebug(
  scope: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (!isLiveDebugEnabled()) {
    return
  }

  const prefix = `[agent-qa live:${scope}] ${event}`
  if (details) {
    console.info(prefix, details)
    return
  }

  console.info(prefix)
}
