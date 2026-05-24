import { lazy, Suspense, useEffect, useState } from "react"
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useLocation,
  useMatches,
} from "react-router"
import { routes } from "@/lib/routes"
import { fetchAppMetadata, type AppMetadataResponse } from "@/lib/api"
import { trackDashboardOpenedOnce } from "@/lib/analytics"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "@/components/ui/sonner"
import { CommandPalette } from "@/components/command-palette"
import { RouteErrorBoundary } from "@/components/error-boundary"
import { ProductTourProvider, ProductTourOverlay } from "@/components/product-tour"
import {
  UpdateBanner,
  isUpdateBannerDismissed,
  readUpdateBannerDismissalCookie,
  writeUpdateBannerDismissalCookie,
  type UpdateBannerDismissal,
} from "@/components/update-banner"
import { cn } from "@/lib/utils"
import {
  TableSkeleton,
  DetailSkeleton,
  ChartSkeleton,
  FormSkeleton,
  EditorSkeleton,
} from "@/components/page-skeleton"

const RunsPage = lazy(() => import("@/pages/runs"))
const RunDetailPage = lazy(() => import("@/pages/run-detail"))
const LiveRunPage = lazy(() => import("@/pages/live-run"))
const TestsPage = lazy(() => import("@/pages/tests"))
const HooksPage = lazy(() => import("@/pages/hooks"))
const HookEditorPage = lazy(() => import("@/pages/hook-editor"))
const HookViewerPage = lazy(() => import("@/pages/hook-viewer"))
const TestEditorPage = lazy(() => import("@/pages/test-editor"))
const TestViewerPage = lazy(() => import("@/pages/test-viewer"))
const MemoryPage = lazy(() => import("@/pages/memory"))
const MemoryProductPage = lazy(() => import("@/pages/memory-product"))
const InsightsPage = lazy(() => import("@/pages/insights"))
const ConfigPage = lazy(() => import("@/pages/config"))
const SuitesPage = lazy(() => import("@/pages/suites"))
const SuiteEditorPage = lazy(() => import("@/pages/suite-editor"))
const SuiteViewerPage = lazy(() => import("@/pages/suite-viewer"))

const UPDATE_BANNER_ELIGIBLE_PATHS = new Set<string>([
  routes.runs,
  routes.tests,
  routes.hooks,
  routes.suites,
  routes.memory,
  routes.config,
])

function AppLayout() {
  const matches = useMatches()
  const location = useLocation()
  const hideHeader = matches.some((m) => (m.handle as Record<string, unknown>)?.hideHeader)
  const [appMetadata, setAppMetadata] = useState<AppMetadataResponse | null>(null)
  const [updateDismissal, setUpdateDismissal] = useState<UpdateBannerDismissal | null>(() =>
    readUpdateBannerDismissalCookie(),
  )

  useEffect(() => {
    trackDashboardOpenedOnce()
  }, [])

  useEffect(() => {
    let active = true

    fetchAppMetadata()
      .then((metadata) => {
        if (active) setAppMetadata(metadata)
      })
      .catch(() => {
        if (active) setAppMetadata(null)
      })

    return () => {
      active = false
    }
  }, [])

  const installedVersion = appMetadata?.version.trim() ?? ""
  const latestVersion = appMetadata?.update?.latestVersion.trim() ?? ""
  const eligibleBannerRoute =
    UPDATE_BANNER_ELIGIBLE_PATHS.has(location.pathname) && !hideHeader
  const showUpdateBanner = Boolean(
    eligibleBannerRoute &&
      installedVersion &&
      latestVersion &&
      !isUpdateBannerDismissed(updateDismissal, latestVersion),
  )

  function dismissUpdateBanner() {
    if (!latestVersion) return

    const dismissal = {
      latestVersion,
      dismissedAt: new Date().toISOString(),
    }
    writeUpdateBannerDismissalCookie(dismissal)
    setUpdateDismissal(dismissal)
  }

  return (
    <SidebarProvider>
      <ProductTourProvider pathname={location.pathname} hideHeader={hideHeader}>
        <AppSidebar />
        <SidebarInset className={cn(hideHeader && "h-svh overflow-hidden")}>
          {showUpdateBanner ? (
            <UpdateBanner
              installedVersion={installedVersion}
              latestVersion={latestVersion}
              onDismiss={dismissUpdateBanner}
            />
          ) : null}
          <main
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              hideHeader ? "overflow-hidden" : "overflow-auto p-6",
            )}
          >
            <Outlet />
          </main>
        </SidebarInset>
        <ProductTourOverlay />
        <CommandPalette />
      </ProductTourProvider>
    </SidebarProvider>
  )
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to={routes.runs} replace /> },
      {
        path: "runs",
        handle: { crumb: "Runs" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<TableSkeleton />}>
                <RunsPage />
              </Suspense>
            ),
          },
          {
            path: ":id",
            handle: { crumb: (params: Record<string, string>) => `Run #${params.id}`, hideHeader: true },
            errorElement: <RouteErrorBoundary />,
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<DetailSkeleton />}>
                    <RunDetailPage />
                  </Suspense>
                ),
              },
              {
                path: "live",
                handle: { crumb: "Live" },
                errorElement: <RouteErrorBoundary />,
                element: (
                  <Suspense fallback={<DetailSkeleton />}>
                    <LiveRunPage />
                  </Suspense>
                ),
              },
            ],
          },
        ],
      },
      {
        path: "tests",
        handle: { crumb: "Tests" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<TableSkeleton />}>
                <TestsPage />
              </Suspense>
            ),
          },
          {
            path: "new",
            handle: { crumb: "New Test", hideHeader: true },
            errorElement: <RouteErrorBoundary />,
            element: (
              <Suspense fallback={<EditorSkeleton />}>
                <TestEditorPage />
              </Suspense>
            ),
          },
        ],
      },
      {
        path: "hooks",
        handle: { crumb: "Hooks" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<TableSkeleton />}>
                <HooksPage />
              </Suspense>
            ),
          },
          {
            path: "new",
            handle: { crumb: "New Hook", hideHeader: true },
            errorElement: <RouteErrorBoundary />,
            element: (
              <Suspense fallback={<EditorSkeleton />}>
                <HookEditorPage />
              </Suspense>
            ),
          },
        ],
      },
      {
        path: "hook",
        handle: { crumb: "Hook" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            path: ":id",
            handle: {
              crumb: (params: Record<string, string>) => params.id ?? "",
              hideHeader: true,
            },
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <HookViewerPage />
                  </Suspense>
                ),
              },
              {
                path: "edit",
                handle: { crumb: "Edit", hideHeader: true },
                errorElement: <RouteErrorBoundary />,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <HookEditorPage />
                  </Suspense>
                ),
              },
            ],
          },
        ],
      },
      {
        path: "test",
        handle: { crumb: "Test" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            path: ":t_id",
            handle: {
              crumb: (params: Record<string, string>) => params.t_id ?? "",
              hideHeader: true,
            },
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <TestViewerPage />
                  </Suspense>
                ),
              },
              {
                path: "edit",
                handle: { crumb: "Edit", hideHeader: true },
                errorElement: <RouteErrorBoundary />,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <TestEditorPage />
                  </Suspense>
                ),
              },
            ],
          },
        ],
      },
      {
        path: "suites",
        handle: { crumb: "Suites" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<TableSkeleton />}>
                <SuitesPage />
              </Suspense>
            ),
          },
          {
            path: "new",
            handle: { crumb: "New Suite", hideHeader: true },
            errorElement: <RouteErrorBoundary />,
            element: (
              <Suspense fallback={<EditorSkeleton />}>
                <SuiteEditorPage />
              </Suspense>
            ),
          },
        ],
      },
      {
        path: "memory",
        handle: { crumb: "Memory" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<TableSkeleton />}>
                <MemoryPage />
              </Suspense>
            ),
          },
          {
            path: ":product",
            handle: {
              crumb: (params: Record<string, string>) => params.product ?? "Memory",
              hideHeader: true,
            },
            errorElement: <RouteErrorBoundary />,
            element: (
              <Suspense fallback={<DetailSkeleton />}>
                <MemoryProductPage />
              </Suspense>
            ),
          },
        ],
      },
      {
        path: "suite",
        handle: { crumb: "Suite" },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            path: ":suite-id",
            handle: {
              crumb: (params: Record<string, string>) => params["suite-id"] ?? "",
              hideHeader: true,
            },
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <SuiteViewerPage />
                  </Suspense>
                ),
              },
              {
                path: "edit",
                handle: { crumb: "Edit", hideHeader: true },
                errorElement: <RouteErrorBoundary />,
                element: (
                  <Suspense fallback={<EditorSkeleton />}>
                    <SuiteEditorPage />
                  </Suspense>
                ),
              },
            ],
          },
        ],
      },
      {
        path: "insights",
        handle: { crumb: "Insights", hideHeader: true },
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            index: true,
            element: (
              <Suspense fallback={<ChartSkeleton />}>
                <InsightsPage />
              </Suspense>
            ),
          },
        ],
      },
      {
        path: "analytics",
        element: <Navigate to="/insights" replace />,
      },
      {
        path: "trends",
        element: <Navigate to="/insights" replace />,
      },
      {
        path: "config",
        handle: { crumb: "Config" },
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<FormSkeleton />}>
            <ConfigPage />
          </Suspense>
        ),
      },
      { path: "settings", element: <Navigate to="/config" replace /> },
      { path: "*", element: <Navigate to={routes.runs} replace /> },
    ],
  },
])

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <RouterProvider router={router} />
      <Toaster richColors position="bottom-right" />
    </ThemeProvider>
  )
}
