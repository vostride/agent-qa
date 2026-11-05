import {
  startLoopbackFake,
  type LoopbackFake,
  type LoopbackRequest,
  type LoopbackRoute,
} from '@vostride/agent-qa-plugin-kit/testing'

export const APP_SESSION_ROUTE = 'GET /app-automate/sessions/:file'
export const MARK_ROUTE = 'PUT /app-automate/sessions/:file'
export const UPLOAD_ROUTE = 'POST /app-automate/upload'
export const RECENT_APPS_ROUTE = 'GET /app-automate/recent_apps/:customId'
export const AUTOMATE_PLAN_ROUTE = 'GET /automate/plan.json'
export const APP_AUTOMATE_PLAN_ROUTE = 'GET /app-automate/plan.json'
export const BUILDS_ROUTE = 'GET /automate/builds.json'
export const BUILD_SESSIONS_ROUTE = 'GET /automate/builds/:buildId/sessions.json'

export interface RecentApp {
  app_url: string
  custom_id: string
  uploaded_at: string
}

export interface FakeBrowserStackApiInput {
  // What recent_apps answers for a custom id nothing was uploaded under.
  noRecentApps?: 'empty-list' | 'message'
  recentApps?: Record<string, RecentApp[]>
  routes?: Record<string, LoopbackRoute>
}

export interface FakeBrowserStackApi extends LoopbackFake {
  dashboardLink(sessionId: string): string
  publicLink(sessionId: string): string
  marks(): { sessionId: string; body: unknown }[]
  uploads(): LoopbackRequest[]
}

export function sessionIdOf(file: string | undefined): string {
  return (file ?? '').replace(/\.json$/, '')
}

function dashboardLink(sessionId: string): string {
  return `https://app-automate.example.invalid/dashboard/v2/sessions/${sessionId}`
}

function publicLink(sessionId: string): string {
  return `https://app-automate.example.invalid/public/${sessionId}?token=${sessionId}-share`
}

function multipartField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'string') return undefined
  const part = new RegExp(
    `name="${name}"(?:; filename="[^"]*")?\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([^\\r]*)`,
  )
  return part.exec(body)?.[1]
}

export function uploadedField(request: LoopbackRequest, name: string): string | undefined {
  return multipartField(request.body, name)
}

export async function startFakeBrowserStackApi(
  input: FakeBrowserStackApiInput = {},
): Promise<FakeBrowserStackApi> {
  const recent = new Map<string, RecentApp[]>(Object.entries(input.recentApps ?? {}))
  let uploaded = 0
  const fake = await startLoopbackFake({
    routes: {
      [APP_SESSION_ROUTE]: (request) => {
        const id = sessionIdOf(request.params.file)
        return {
          status: 200,
          json: {
            automation_session: {
              hashed_id: id,
              name: 'a session',
              status: 'running',
              browser_url: dashboardLink(id),
              public_url: publicLink(id),
            },
          },
        }
      },
      [MARK_ROUTE]: (request) => ({
        status: 200,
        json: {
          automation_session: {
            hashed_id: sessionIdOf(request.params.file),
            ...(request.body as object),
          },
        },
      }),
      [UPLOAD_ROUTE]: (request) => {
        uploaded += 1
        const customId = multipartField(request.body, 'custom_id') ?? ''
        const app = {
          app_url: `bs://uploaded-${String(uploaded)}`,
          custom_id: customId,
          uploaded_at: new Date(Date.UTC(2026, 10, 5, 12, uploaded)).toISOString(),
        }
        if (customId !== '') recent.set(customId, [app, ...(recent.get(customId) ?? [])])
        return { status: 200, json: { ...app, shareable_id: `bs-test-user/${customId}` } }
      },
      [RECENT_APPS_ROUTE]: (request) => {
        const apps = recent.get(request.params.customId ?? '') ?? []
        if (apps.length > 0) return { status: 200, json: apps }
        return input.noRecentApps === 'message'
          ? { status: 200, json: { message: 'No results found' } }
          : { status: 200, json: [] }
      },
      [AUTOMATE_PLAN_ROUTE]: [
        {
          status: 200,
          json: {
            automate_plan: 'Automate Pro',
            parallel_sessions_running: 0,
            parallel_sessions_max_allowed: 5,
            queued_sessions: 0,
            queued_sessions_max_allowed: 5,
          },
        },
      ],
      [APP_AUTOMATE_PLAN_ROUTE]: [
        {
          status: 200,
          json: {
            automate_plan: 'App Automate Device Cloud Pro',
            parallel_sessions_running: 0,
            parallel_sessions_max_allowed: 5,
            queued_sessions: 0,
            queued_sessions_max_allowed: 5,
          },
        },
      ],
      [BUILDS_ROUTE]: [{ status: 200, json: [] }],
      [BUILD_SESSIONS_ROUTE]: [{ status: 200, json: [] }],
      ...input.routes,
    },
  })
  return {
    ...fake,
    dashboardLink,
    publicLink,
    marks: () =>
      fake
        .routeCalls(MARK_ROUTE)
        .map((request) => ({ sessionId: sessionIdOf(request.params.file), body: request.body })),
    uploads: () => [...fake.routeCalls(UPLOAD_ROUTE)],
  }
}
