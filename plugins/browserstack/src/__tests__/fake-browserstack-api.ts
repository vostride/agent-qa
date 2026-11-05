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
export const WEB_SESSION_ROUTE = 'GET /automate/sessions/:file'
export const WEB_MARK_ROUTE = 'PUT /automate/sessions/:file'

export interface RecentApp {
  app_url: string
  custom_id: string
  uploaded_at: string
}

export interface WebSessionScript {
  build: string
  name: string
  hashedId: string
  // Left out, the session's details carry no created_at.
  createdAt?: string
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
  // A running Automate session, listed under a running build of that name.
  addWebSession(session: WebSessionScript): void
  webDashboardLink(sessionId: string): string
  webPublicLink(sessionId: string): string
  webMarks(): { sessionId: string; body: unknown }[]
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

function webDashboardLink(sessionId: string): string {
  return `https://automate.example.invalid/dashboard/v2/sessions/${sessionId}`
}

function webPublicLink(sessionId: string): string {
  return `https://automate.example.invalid/public/${sessionId}?token=${sessionId}-share`
}

function webSessionJson(session: WebSessionScript): Record<string, unknown> {
  return {
    name: session.name,
    hashed_id: session.hashedId,
    status: 'running',
    browser_url: webDashboardLink(session.hashedId),
    public_url: webPublicLink(session.hashedId),
  }
}

export function buildIdOf(name: string): string {
  return `build-${Buffer.from(name).toString('hex')}`
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
  const webSessions: WebSessionScript[] = []
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
      [BUILDS_ROUTE]: () => {
        const names = [...new Set(webSessions.map((session) => session.build))]
        return {
          status: 200,
          json: names.map((name) => ({
            automation_build: { name, hashed_id: buildIdOf(name), status: 'running' },
          })),
        }
      },
      [BUILD_SESSIONS_ROUTE]: (request) => ({
        status: 200,
        json: webSessions
          .filter((session) => buildIdOf(session.build) === request.params.buildId)
          .map((session) => ({ automation_session: webSessionJson(session) })),
      }),
      [WEB_SESSION_ROUTE]: (request) => {
        const id = sessionIdOf(request.params.file)
        const session = webSessions.find((candidate) => candidate.hashedId === id)
        if (session === undefined) return { status: 404, json: { message: 'Session not found' } }
        return {
          status: 200,
          json: {
            automation_session: {
              ...webSessionJson(session),
              ...(session.createdAt === undefined ? {} : { created_at: session.createdAt }),
            },
          },
        }
      },
      [WEB_MARK_ROUTE]: (request) => ({
        status: 200,
        json: {
          automation_session: {
            hashed_id: sessionIdOf(request.params.file),
            ...(request.body as object),
          },
        },
      }),
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
    webDashboardLink,
    webPublicLink,
    addWebSession: (session) => {
      webSessions.push(session)
    },
    webMarks: () =>
      fake
        .routeCalls(WEB_MARK_ROUTE)
        .map((request) => ({ sessionId: sessionIdOf(request.params.file), body: request.body })),
  }
}
