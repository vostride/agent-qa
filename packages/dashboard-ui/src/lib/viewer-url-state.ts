export const VALID_VIEWER_TABS = ['overview', 'insights'] as const

export type ViewerTopTab = typeof VALID_VIEWER_TABS[number]

export interface ViewerUrlState<View extends string> {
  tab: ViewerTopTab
  view: View
}

interface NormalizeViewerUrlStateOptions<View extends string> {
  defaultTab?: ViewerTopTab
  defaultView?: View
}

function includesValue<T extends string>(
  value: string | null,
  allowedValues: readonly T[],
): value is T {
  return value !== null && (allowedValues as readonly string[]).includes(value)
}

export function normalizeViewerUrlState<View extends string>(
  searchParams: URLSearchParams,
  validViews: readonly View[],
  options: NormalizeViewerUrlStateOptions<View> = {},
): ViewerUrlState<View> {
  const defaultTab = options.defaultTab ?? 'overview'
  const defaultView = options.defaultView ?? validViews[0]

  const rawTab = searchParams.get('tab')
  const rawView = searchParams.get('view')

  return {
    tab: includesValue(rawTab, VALID_VIEWER_TABS) ? rawTab : defaultTab,
    view: includesValue(rawView, validViews) ? rawView : defaultView,
  }
}

export function serializeViewerUrlState<View extends string>(
  state: ViewerUrlState<View>,
  searchParams?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams()

  next.set('tab', state.tab)
  next.set('view', state.view)

  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      if (key === 'tab' || key === 'view' || key === 'sub') {
        continue
      }
      next.append(key, value)
    }
  }

  return next
}
