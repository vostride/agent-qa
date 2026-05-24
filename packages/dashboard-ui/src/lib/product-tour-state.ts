import { getKnownProductTourStepIds } from '@/lib/product-tour-steps'

export const PRODUCT_TOUR_COOKIE = 'agent_qa_product_tour_state'
export const PRODUCT_TOUR_SCHEMA_VERSION = 1
export const PRODUCT_TOUR_VERSION = 'foundation-v1'

const PRODUCT_TOUR_COOKIE_MAX_AGE = 31536000

export interface ProductTourState {
  schemaVersion: typeof PRODUCT_TOUR_SCHEMA_VERSION
  tourVersion: typeof PRODUCT_TOUR_VERSION
  completedAt?: string
  skippedAt?: string
  lastStartedAt?: string
  activeStepId?: string
  activeRoute?: string
}

const timestampFields = ['completedAt', 'skippedAt', 'lastStartedAt'] as const

export function normalizeProductTourState(
  value: unknown,
  knownStepIds = getKnownProductTourStepIds(),
): ProductTourState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== PRODUCT_TOUR_SCHEMA_VERSION) return null
  if (candidate.tourVersion !== PRODUCT_TOUR_VERSION) return null

  for (const field of timestampFields) {
    const timestamp = candidate[field]
    if (timestamp !== undefined && !isIsoTimestamp(timestamp)) return null
  }

  if (
    candidate.activeStepId !== undefined &&
    (typeof candidate.activeStepId !== 'string' || !knownStepIds.includes(candidate.activeStepId))
  ) {
    return null
  }

  if (candidate.activeRoute !== undefined && typeof candidate.activeRoute !== 'string') {
    return null
  }

  return {
    schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
    tourVersion: PRODUCT_TOUR_VERSION,
    ...(typeof candidate.completedAt === 'string' ? { completedAt: candidate.completedAt } : {}),
    ...(typeof candidate.skippedAt === 'string' ? { skippedAt: candidate.skippedAt } : {}),
    ...(typeof candidate.lastStartedAt === 'string'
      ? { lastStartedAt: candidate.lastStartedAt }
      : {}),
    ...(typeof candidate.activeStepId === 'string' ? { activeStepId: candidate.activeStepId } : {}),
    ...(typeof candidate.activeRoute === 'string' ? { activeRoute: candidate.activeRoute } : {}),
  }
}

export function readProductTourStateCookie(): ProductTourState | null {
  if (typeof document === 'undefined') return null

  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PRODUCT_TOUR_COOKIE}=`))
  if (!cookie) return null

  try {
    const raw = decodeURIComponent(cookie.slice(PRODUCT_TOUR_COOKIE.length + 1))
    return normalizeProductTourState(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeProductTourStateCookie(state: ProductTourState): void {
  if (typeof document === 'undefined') return

  try {
    document.cookie = `${PRODUCT_TOUR_COOKIE}=${encodeURIComponent(
      JSON.stringify(state),
    )}; path=/; max-age=${PRODUCT_TOUR_COOKIE_MAX_AGE}; samesite=lax`
  } catch {
    // Cookie writes can be blocked by browser settings; the tour must stay usable.
  }
}

export function clearProductTourStateCookie(): void {
  if (typeof document === 'undefined') return

  try {
    document.cookie = `${PRODUCT_TOUR_COOKIE}=; path=/; max-age=0; samesite=lax`
  } catch {
    // Ignore storage failures for the same reason as writes.
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}
