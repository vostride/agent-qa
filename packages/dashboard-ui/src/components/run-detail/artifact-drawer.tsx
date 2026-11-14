import { AlertCircle, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RunArtifactResponse, RunRow } from "@/lib/api"
import { captureStateOf, DRAWER_COPY, DRAWER_TITLE_FALLBACK, ranAgainstParts } from "@/lib/drawer-view"
import { ArtifactTestTab } from "./artifact-test-tab"
import { ArtifactConfigTab } from "./artifact-config-tab"
import { ArtifactTechnicalDetails } from "./artifact-technical-details"
import { t } from "@/lib/i18n"

export type ArtifactDrawerTab = "test" | "config"

interface ArtifactDrawerProps {
  run: RunRow
  open: boolean
  tab?: ArtifactDrawerTab
  response: RunArtifactResponse | null
  loading: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onTabChange: (tab: ArtifactDrawerTab) => void
  onRetry: () => void
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-label={t("Loading artifact data")}>
      <p className="text-sm text-muted-foreground">{t("Loading artifact data...")}</p>
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-[2px] border border-border p-4">
          <Skeleton className="h-4 w-40" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-[2px] border border-red-500/20 bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t("Could not load artifact data")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Retry the request. If it continues, verify the dashboard server can read run artifacts.
          </p>
          <p className="mt-2 break-words font-mono text-xs text-red-500">{error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
            {DRAWER_COPY.retry}
          </Button>
        </div>
      </div>
    </div>
  )
}

function MissingArtifactState() {
  return (
    <div className="rounded-[2px] border border-border p-4">
      <h3 className="text-sm font-medium text-foreground">
        Artifact data is not available for this run
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        This run does not have a persisted artifact record.
      </p>
    </div>
  )
}

function ShellTabContent({
  tab,
  response,
}: {
  tab: ArtifactDrawerTab
  response: RunArtifactResponse
}) {
  if (tab === "test") {
    return <ArtifactTestTab response={response} />
  }

  return <ArtifactConfigTab response={response} />
}

function DrawerBody({
  tab,
  response,
  loading,
  error,
  onRetry,
}: { tab: ArtifactDrawerTab } & Pick<ArtifactDrawerProps, "response" | "loading" | "error" | "onRetry">) {
  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (!response) return <MissingArtifactState />
  if (tab !== "test" && !response.artifact) return <MissingArtifactState />
  return <ShellTabContent tab={tab} response={response} />
}

export function ArtifactDrawer({
  run,
  open,
  tab = "test",
  response,
  loading,
  error,
  onOpenChange,
  onTabChange,
  onRetry,
}: ArtifactDrawerProps) {
  const artifact = response?.artifact ?? null
  const title = run.name || DRAWER_TITLE_FALLBACK(run.id)
  const parts = ranAgainstParts(artifact?.payload.config)
  const description = parts.length > 0 ? parts.join(' · ') : DRAWER_COPY.configNotCaptured

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(820px,92vw)] sm:max-w-none gap-0 overflow-hidden p-0">
        <SheetHeader className="border-b px-4 py-3 pr-12">
          <SheetTitle className="text-base leading-snug font-medium line-clamp-2">{title}</SheetTitle>
          <SheetDescription className="truncate text-xs">{description}</SheetDescription>
        </SheetHeader>

        {artifact && captureStateOf(artifact) === 'unsealed' ? (
          <div role="status" data-capture-state="unsealed"
            className="m-4 flex items-start gap-2 rounded-sm border border-amber-500/25 bg-amber-500/5 p-3 text-sm">
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
            <span>{DRAWER_COPY.unsealedCapture}</span>
          </div>
        ) : null}

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as ArtifactDrawerTab)}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <div className="border-b px-3">
            <TabsList variant="line" className="h-9 w-full justify-start">
              <TabsTrigger value="test" className="max-w-32 flex-none">
                {DRAWER_COPY.test}
              </TabsTrigger>
              <TabsTrigger value="config" className="max-w-32 flex-none">
                {DRAWER_COPY.config}
              </TabsTrigger>
            </TabsList>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <TabsContent value="test" className="m-0 px-4 py-4">
              <DrawerBody
                tab="test"
                response={response}
                loading={loading}
                error={error}
                onRetry={onRetry}
              />
            </TabsContent>
            <TabsContent value="config" className="m-0 px-4 py-4">
              <DrawerBody
                tab="config"
                response={response}
                loading={loading}
                error={error}
                onRetry={onRetry}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
        {artifact ? <ArtifactTechnicalDetails runId={run.id} artifact={artifact} /> : null}
      </SheetContent>
    </Sheet>
  )
}
