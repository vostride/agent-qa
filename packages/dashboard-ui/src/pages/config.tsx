import { useEffect, useRef, useState, type ComponentType } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { FormSkeleton } from "@/components/page-skeleton"
import { fetchAppMetadata } from "@/lib/api"
import { usePageTitle } from "@/hooks/use-page-title"
import {
  ConfigAutosaveProvider,
  configFieldControlId,
  useConfigAutosave,
  type ConfigDraftTarget,
} from "@/hooks/use-config-autosave"
import {
  CONFIG_SECTIONS,
  CONFIG_TABS,
  configTabPath,
  resolveConfigTab,
  resolveLegacyConfigLink,
  type ConfigSectionId,
  type ConfigTab,
} from "@/lib/config-tabs"
import {
  CONFIG_FILE_ISSUES_TITLE,
  CONFIG_LOAD_FAILED_TITLE,
  CONFIG_PAGE_TITLE,
  CONFIG_SECTION_LABELS,
  LEGACY_LINK_NOT_FOUND_TEXT,
  RELOAD_CONFIG_LABEL,
  configFileIssuesBody,
  configLoadFailedBody,
} from "@/lib/config-copy"
import { ConfigLineNotice } from "@/components/config-manager/config-section-shell"
import { ConfigTabBar } from "@/components/config-manager/config-tabs"
import { SaveStatus } from "@/components/config-manager/save-status"
import { ModelList } from "@/components/config-manager/model-list"
import { TimeoutSection } from "@/components/config-manager/timeout-section"
import { CacheSection } from "@/components/config-manager/cache-section"
import { AuthStatesSection } from "@/components/config-manager/auth-states-section"
import { LoggingSection } from "@/components/config-manager/logging-section"
import { BrowserSection } from "@/components/config-manager/browser-section"
import { RecordingSection } from "@/components/config-manager/recording-section"
import { AccessibilitySection } from "@/components/config-manager/accessibility-section"
import { PlannerSection } from "@/components/config-manager/planner-section"
import { DashboardSection } from "@/components/config-manager/dashboard-section"
import { TestMatchSection } from "@/components/config-manager/test-match-section"
import { FilesSection } from "@/components/config-manager/files-section"
import { LogCaptureSection } from "@/components/config-manager/log-capture-section"
import { RunsSection } from "@/components/config-manager/runs-section"
import { MobileSection } from "@/components/config-manager/mobile-section"
import { KnowledgeSection } from "@/components/config-manager/knowledge-section"
import { VisionSection } from "@/components/config-manager/vision-section"
import { TargetsSection } from "@/components/config-manager/targets-section"
import { DevicesSection } from "@/components/config-manager/devices-section"
import { ProvidersSection } from "@/components/config-manager/providers-section"
import { AnalyticsSection } from "@/components/config-manager/analytics-section"
import { McpSection } from "@/components/config-manager/mcp-section"
import { ConfigFileView } from "@/components/config-manager/config-file-view"

interface SectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const SECTION_COMPONENTS: Partial<Record<ConfigSectionId, readonly ComponentType<SectionProps>[]>> = {
  models: [ModelList],
  "screenshot-size": [VisionSection],
  "planner-limits": [PlannerSection],
  targets: [TargetsSection],
  devices: [DevicesSection],
  "device-farms": [ProvidersSection],
  "login-states": [AuthStatesSection],
  "mobile-app-state": [MobileSection],
  browser: [BrowserSection],
  timeouts: [TimeoutSection],
  runs: [RunsSection],
  cache: [CacheSection],
  recording: [RecordingSection],
  accessibility: [AccessibilitySection],
  "log-capture": [LogCaptureSection],
  "test-discovery": [TestMatchSection],
  files: [FilesSection],
  knowledge: [KnowledgeSection],
  dashboard: [DashboardSection],
  logging: [LoggingSection],
  "pass-rate-scope": [AnalyticsSection],
  mcp: [McpSection],
  "config-file": [ConfigFileView],
}

// The Models heading shares its row with Add model (UI-SPEC S4); the list spans the row below.
const SECTION_LAYOUT: Partial<Record<ConfigSectionId, string>> = {
  models: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4",
}

function configSectionHeadingId(section: ConfigSectionId): string {
  return `config-section-${section}-heading`
}

function sectionBelongsTo(tab: ConfigTab, section: string): section is ConfigSectionId {
  return (CONFIG_SECTIONS[tab] as readonly string[]).includes(section)
}

function issueReason(message: string): string {
  return message.trim().replace(/[.\s]+$/, "")
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

export default function ConfigPage() {
  usePageTitle(CONFIG_PAGE_TITLE)
  const navigate = useNavigate()
  const { tab: tabParam } = useParams()
  const [searchParams] = useSearchParams()
  const autosave = useConfigAutosave()
  const state = autosave.load
  const [pendingFocus, setPendingFocus] = useState<ConfigDraftTarget | undefined>(undefined)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [showLegacyNotice, setShowLegacyNotice] = useState(false)

  const resolvedTab = resolveConfigTab(tabParam)
  const tab: ConfigTab = resolvedTab ?? "models"
  const sectionParam = searchParams.get("section")
  const versionText = appVersion ? `agent-qa v${appVersion}` : "agent-qa version unavailable"

  useEffect(() => {
    const legacy = resolveLegacyConfigLink(searchParams)
    if (legacy.kind === "mapped") {
      navigate(configTabPath(legacy.tab, legacy.section), { replace: true })
      return
    }
    const unknownLink =
      legacy.kind === "unknown" ||
      (tabParam !== undefined && resolvedTab === undefined) ||
      (resolvedTab !== undefined && sectionParam !== null && !sectionBelongsTo(resolvedTab, sectionParam))
    if (unknownLink) {
      setShowLegacyNotice(true)
      navigate(configTabPath("models"), { replace: true })
      return
    }
    if (tabParam === undefined) {
      navigate(configTabPath("models"), { replace: true })
    }
  }, [navigate, resolvedTab, searchParams, sectionParam, tabParam])

  useEffect(() => {
    let active = true

    async function loadAppMetadata() {
      try {
        const metadata = await fetchAppMetadata()
        const version = metadata.version.trim()
        if (active) setAppVersion(version || null)
      } catch {
        if (active) setAppVersion(null)
      }
    }

    loadAppMetadata()

    return () => {
      active = false
    }
  }, [])

  const ready = state.kind === "ready"

  useEffect(() => {
    if (!ready || resolvedTab === undefined || sectionParam === null) return
    if (!sectionBelongsTo(resolvedTab, sectionParam)) return
    const heading = document.getElementById(configSectionHeadingId(sectionParam))
    if (heading) {
      heading.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" })
      heading.focus({ preventScroll: true })
    }
    navigate(configTabPath(resolvedTab), { replace: true })
  }, [navigate, ready, resolvedTab, sectionParam])

  // Not saved: focus the draft's control once its tab is active. Radix mounts a newly active
  // panel's children one render later, so the focus waits a tick.
  useEffect(() => {
    if (pendingFocus === undefined || pendingFocus.tab !== tab) return
    const timer = setTimeout(() => {
      document.getElementById(configFieldControlId(pendingFocus.fieldKey))?.focus()
      setPendingFocus(undefined)
    }, 0)
    return () => clearTimeout(timer)
  }, [pendingFocus, tab])

  // UI-SPEC S9: the Retry button unmounts once its write lands, so focus goes back to the field
  // that had failed, else the active tab. A retry that fails again leaves focus on Retry.
  const retryFocus = useRef<{ target: ConfigDraftTarget | undefined; sent: boolean } | undefined>(undefined)
  const saveState = autosave.status.state

  useEffect(() => {
    const pending = retryFocus.current
    if (pending === undefined) return
    if (saveState === "saving") {
      pending.sent = true
      return
    }
    if (saveState === "failed") {
      if (pending.sent) retryFocus.current = undefined
      return
    }
    retryFocus.current = undefined
    if (document.activeElement !== null && document.activeElement !== document.body) return
    const field =
      pending.target?.tab === tab ? document.getElementById(configFieldControlId(pending.target.fieldKey)) : null
    ;(field ?? document.querySelector<HTMLElement>(`[data-config-tab="${tab}"]`))?.focus()
  }, [saveState, tab])

  function retrySave() {
    retryFocus.current = { target: autosave.failedFieldTarget(), sent: false }
    autosave.retry()
  }

  function handleTabChange(value: string) {
    const next = resolveConfigTab(value)
    if (next === undefined || next === tab) return
    setShowLegacyNotice(false)
    navigate(configTabPath(next))
  }

  function goToFirstDraft() {
    const target = autosave.goToFirstDraft()
    if (target === undefined) return
    if (target.tab !== tab) {
      setShowLegacyNotice(false)
      navigate(configTabPath(target.tab))
    }
    setPendingFocus(target)
  }

  if (state.kind === "loading") {
    return (
      <div data-config-page data-config-state="loading">
        <FormSkeleton />
      </div>
    )
  }

  return (
    <div data-config-page data-config-state={state.kind} className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">{CONFIG_PAGE_TITLE}</h1>

      {showLegacyNotice ? (
        <ConfigLineNotice data-config-invalid-notice className="mt-6">
          {LEGACY_LINK_NOT_FOUND_TEXT}
        </ConfigLineNotice>
      ) : null}

      {state.kind === "error" ? (
        <ConfigLineNotice data-config-load-error className="mt-6 space-y-2">
          <p className="text-sm font-medium text-foreground">{CONFIG_LOAD_FAILED_TITLE}</p>
          <p className="text-xs">{configLoadFailedBody(state.reason)}</p>
          <Button type="button" variant="outline" size="sm" onClick={autosave.reload}>
            {RELOAD_CONFIG_LABEL}
          </Button>
        </ConfigLineNotice>
      ) : (
        <ConfigAutosaveProvider value={autosave}>
          {state.answer.fileIssues?.[0] ? (
            <ConfigLineNotice data-config-file-issues className="mt-6 space-y-2">
              <p className="text-sm font-medium text-foreground">{CONFIG_FILE_ISSUES_TITLE}</p>
              <p className="text-xs">{configFileIssuesBody(issueReason(state.answer.fileIssues[0].message))}</p>
            </ConfigLineNotice>
          ) : null}
          <Tabs value={tab} onValueChange={handleTabChange} className="mt-6">
            <ConfigTabBar
              tab={tab}
              draftTabs={autosave.draftTabs}
              statusSlot={
                <SaveStatus
                  status={autosave.status}
                  onRetry={retrySave}
                  onUndo={() => void autosave.undo()}
                  onGoToDraft={goToFirstDraft}
                />
              }
            />
            {CONFIG_TABS.map((id) => (
              <TabsContent
                key={id}
                value={id}
                data-config-panel={id}
                data-tour-id={id === tab ? "tour-config-section" : undefined}
                className="space-y-8 pt-6"
              >
                {CONFIG_SECTIONS[id].map((section) => {
                  const components = SECTION_COMPONENTS[section]
                  if (!components) return null
                  const headingId = configSectionHeadingId(section)
                  return (
                    <section
                      key={section}
                      data-config-section={section}
                      aria-labelledby={headingId}
                      className={SECTION_LAYOUT[section] ?? "space-y-4"}
                    >
                      <h2
                        id={headingId}
                        tabIndex={-1}
                        className="rounded-sm text-base font-medium leading-snug outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {CONFIG_SECTION_LABELS[section]}
                      </h2>
                      {components.map((Component, index) => (
                        <Component key={index} config={state.answer.config} onConfigChange={autosave.refresh} />
                      ))}
                    </section>
                  )
                })}
              </TabsContent>
            ))}
          </Tabs>
        </ConfigAutosaveProvider>
      )}

      <p
        data-config-app-version
        className="mt-6 border-t border-border pt-3 text-[11px] font-mono text-muted-foreground/70"
      >
        {versionText}
      </p>
    </div>
  )
}
