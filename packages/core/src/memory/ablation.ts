import type { MemoryProvider } from './provider.js'

export function shouldAblate(
  result: { status: string; steps: Array<unknown> },
  provider: MemoryProvider,
): boolean {
  if (result.status !== 'failed') return false

  for (let i = 0; i < result.steps.length; i++) {
    if (provider.getInjectedObservations(i).length > 0) return true
  }

  return false
}

export function collectAllInjectedIds(
  result: { steps: Array<unknown> },
  provider: MemoryProvider,
): Map<number, string[]> {
  const map = new Map<number, string[]>()

  for (let i = 0; i < result.steps.length; i++) {
    const ids = provider.getInjectedObservations(i)
    if (ids.length > 0) map.set(i, ids)
  }

  return map
}
