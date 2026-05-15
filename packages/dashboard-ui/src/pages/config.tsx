import { useEffect, useMemo, useState, type ComponentType } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { FormSkeleton } from "@/components/page-skeleton"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetchAppMetadata, fetchConfig } from "@/lib/api"
import { usePageTitle } from "@/hooks/use-page-title"
import { cn } from "@/lib/utils"
import { routes } from "@/lib/routes"
import {
  CONFIG_BUCKETS,
  type ConfigBucket,
  type ConfigNavigationItem,
  getConfigItemsByBucket,
  normalizeConfigSelection,
  serializeConfigSelection,
} from "@/lib/config-navigation"
import { ConfigLineNotice } from "@/components/config-manager/config-section-shell"
import { LlmSection } from "@/components/config-manager/llm-section"
import { TimeoutSection } from "@/components/config-manager/timeout-section"
import { HealingSection } from "@/components/config-manager/healing-section"
import { CacheSection } from "@/components/config-manager/cache-section"
import { LoggingSection } from "@/components/config-manager/logging-section"
import { BrowserSection } from "@/components/config-manager/browser-section"
import { RecordingSection } from "@/components/config-manager/recording-section"
import { AccessibilitySection } from "@/components/config-manager/accessibility-section"
import { PlannerSection } from "@/components/config-manager/planner-section"
import { AgentRulesSection } from "@/components/config-manager/agent-rules-section"
import { DashboardSection } from "@/components/config-manager/dashboard-section"
import { TestMatchSection } from "@/components/config-manager/test-match-section"
import { FilesSection } from "@/components/config-manager/files-section"
import { LogCaptureSection } from "@/components/config-manager/log-capture-section"
import { ExecutionDefaultsSection } from "@/components/config-manager/execution-defaults-section"
import { MobileSection } from "@/components/config-manager/mobile-section"
import { MemorySection } from "@/components/config-manager/memory-section"
import { TargetsSection } from "@/components/config-manager/targets-section"
import { DevicesSection } from "@/components/config-manager/devices-section"
import { ProvidersSection } from "@/components/config-manager/providers-section"
import { AnalyticsSection } from "@/components/config-manager/analytics-section"

interface SectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const SECTION_COMPONENTS: Record<string, ComponentType<SectionProps>> = {
  'workspace:discovery': TestMatchSection,
  'workspace:files': FilesSection,
  'workspace:agent-rules': AgentRulesSection,
  'services:dashboard': DashboardSection,
  'services:cache': CacheSection,
  'services:logging': LoggingSection,
  'services:recording': RecordingSection,
  'services:accessibility': AccessibilitySection,
  'services:memory': MemorySection,
  'registry:llms': LlmSection,
  'registry:targets': TargetsSection,
  'registry:devices': DevicesSection,
  'registry:providers': ProvidersSection,
  'use:browser': BrowserSection,
  'use:timeouts': TimeoutSection,
  'use:healing': HealingSection,
  'use:planner': PlannerSection,
  'use:log-capture': LogCaptureSection,
  'use:mobile': MobileSection,
  'use:execution-defaults': ExecutionDefaultsSection,
  'analytics:pass-rate-scope': AnalyticsSection,
}

export default function ConfigPage() {
  usePageTitle("Config")
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [showInvalidSelectionNotice, setShowInvalidSelectionNotice] = useState(false)

  const selection = useMemo(
    () => normalizeConfigSelection(searchParams),
    [searchParams],
  )
  const canonicalSearchParams = useMemo(
    () => serializeConfigSelection(selection, searchParams),
    [searchParams, selection],
  )
  const normalizedSearch = `?${canonicalSearchParams.toString()}`
  const search = searchParams.toString()
  const searchIsCanonical = search === canonicalSearchParams.toString()
  const selectedItem = getConfigItemsByBucket(selection.bucket).find((item) => item.item === selection.item)!
  const SectionComponent = SECTION_COMPONENTS[`${selection.bucket}:${selection.item}`]
  const versionText = appVersion ? `agent-qa v${appVersion}` : "agent-qa version unavailable"

  useEffect(() => {
    if (!searchIsCanonical) {
      if (search.length > 0) {
        setShowInvalidSelectionNotice(true)
      }
      navigate(`${routes.config}?${canonicalSearchParams.toString()}`, { replace: true })
    }
  }, [canonicalSearchParams, navigate, search, searchIsCanonical])

  async function loadConfig() {
    try {
      const res = await fetchConfig()
      setConfig(res.config)
    } catch {
      toast.error("Failed to load configuration")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

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

  function handleNavigate(bucket: ConfigBucket, item: string) {
    setShowInvalidSelectionNotice(false)
    const next = serializeConfigSelection({ bucket, item }, searchParams)
    navigate(`${routes.config}?${next.toString()}`)
  }

  if (loading) {
    return <FormSkeleton />
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Configuration</h2>
        <p className="text-muted-foreground">Manage workspace, services, registry, and runtime defaults.</p>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(240px,256px)_minmax(0,1fr)] lg:items-start">
        <aside data-config-rail className="hidden border-r border-border pr-4 lg:block">
          <div className="space-y-5 py-1">
            {CONFIG_BUCKETS.map((bucket) => (
              <ConfigBucketNav
                key={bucket}
                bucket={bucket}
                selectedItem={selection.item}
                onSelect={handleNavigate}
              />
            ))}
          </div>
        </aside>

        <main data-config-main className="min-w-0 lg:pl-6">
          <div data-config-page-root className="grid gap-0">
            <section data-config-mobile-selector className="border-b border-border pb-4 lg:hidden">
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Select Setting
                </p>
                <Select
                  value={`${selection.bucket}:${selection.item}`}
                  onValueChange={(value) => {
                    const [bucket, item] = value.split(':')
                    handleNavigate(bucket as ConfigBucket, item)
                  }}
                >
                  <SelectTrigger aria-label="Select config setting">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIG_BUCKETS.map((bucket) => (
                      <SelectGroup key={bucket}>
                        <SelectLabel>{getConfigItemsByBucket(bucket)[0]?.bucketLabel ?? bucket}</SelectLabel>
                        {getConfigItemsByBucket(bucket).map((item) => (
                          <SelectItem key={`${item.bucket}:${item.item}`} value={`${item.bucket}:${item.item}`}>
                            {item.itemLabel}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            <section className="space-y-4 pt-4 lg:pt-0">
              {showInvalidSelectionNotice && (
                <div data-config-invalid-notice className="border-b border-border py-3 text-sm text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Setting not found.</span>
                    <span>Showing the closest valid config section instead.</span>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {normalizedSearch}
                    </Badge>
                  </div>
                </div>
              )}

              <header className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{selectedItem.bucketLabel}</Badge>
                  <Badge variant="outline">{selectedItem.itemLabel}</Badge>
                </div>
                <div className="space-y-1">
                  <h3 className="text-xl font-semibold tracking-tight">{selectedItem.title}</h3>
                  <p className="max-w-3xl text-sm text-muted-foreground">{selectedItem.description}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedItem.fieldPaths.map((fieldPath) => (
                    <Badge key={fieldPath} variant="outline" className="font-mono text-[11px]">
                      {fieldPath}
                    </Badge>
                  ))}
                </div>
              </header>
            </section>
          </div>

          <div className="mt-4">
            {SectionComponent ? (
              <SectionComponent config={config} onConfigChange={loadConfig} />
            ) : (
              <MissingSectionNotice item={selectedItem} />
            )}
          </div>

          <p
            data-config-app-version
            className="mt-6 border-t border-border pt-3 text-[11px] font-mono text-muted-foreground/70"
          >
            {versionText}
          </p>
        </main>
      </div>
    </div>
  )
}

function ConfigBucketNav({
  bucket,
  selectedItem,
  onSelect,
}: {
  bucket: ConfigBucket
  selectedItem: string
  onSelect: (bucket: ConfigBucket, item: string) => void
}) {
  const items = getConfigItemsByBucket(bucket)

  return (
    <div className="space-y-2">
      <p className="px-3 text-xs text-muted-foreground">
        {items[0]?.bucketLabel ?? bucket}
      </p>
      <div className="space-y-1">
        {items.map((item) => {
          const isActive = item.item === selectedItem
          return (
            <button
              key={`${item.bucket}:${item.item}`}
              type="button"
              onClick={() => onSelect(item.bucket, item.item)}
              className={cn(
                "relative w-full border-l-2 border-transparent px-3 py-2 text-left text-sm transition-colors",
                isActive
                  ? "border-primary text-foreground font-medium"
                  : "text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {item.itemLabel}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MissingSectionNotice({ item }: { item: ConfigNavigationItem }) {
  return (
    <ConfigLineNotice className="space-y-2">
      <p className="text-base font-medium text-foreground">Missing config surface</p>
      <p className="text-sm text-muted-foreground">
        No editor is registered for <span className="font-mono">{item.bucket}/{item.item}</span>.
      </p>
    </ConfigLineNotice>
  )
}
