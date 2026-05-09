import { AlertCircle, Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
import { cn } from "@/lib/utils"
import { ArtifactConfigTab } from "./artifact-config-tab"
import { ArtifactMemoryTab } from "./artifact-memory-tab"

export type ArtifactDrawerTab = "attributes" | "config" | "memory"

interface ArtifactDrawerProps {
  run: RunRow
  open: boolean
  tab: ArtifactDrawerTab
  response: RunArtifactResponse | null
  loading: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onTabChange: (tab: ArtifactDrawerTab) => void
  onRetry: () => void
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-label="Loading artifact data">
      <p className="text-sm text-muted-foreground">Loading artifact data...</p>
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
          <h3 className="text-sm font-medium text-foreground">Could not load artifact data</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Retry the request. If it continues, verify the dashboard server can read run artifacts.
          </p>
          <p className="mt-2 break-words font-mono text-xs text-red-500">{error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
            Retry
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

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const next = (value as Record<string, unknown>)[key]
  return next && typeof next === "object" && !Array.isArray(next)
    ? next as Record<string, unknown>
    : null
}

function stringAttributesFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

function getRunAttributes(response: RunArtifactResponse): Record<string, string> {
  const direct = stringAttributesFrom(response.run.attributes)
  if (Object.keys(direct).length > 0) return direct

  const payload = response.artifact?.payload
  const metadata = recordAt(payload, "metadata")
  return stringAttributesFrom(recordAt(metadata, "attributes"))
}

function sortedAttributeEntries(attributes: Record<string, string>) {
  return Object.entries(attributes).sort(([left], [right]) => {
    const leftInternal = left.startsWith("agent-qa.")
    const rightInternal = right.startsWith("agent-qa.")
    if (leftInternal !== rightInternal) return leftInternal ? -1 : 1
    return left.localeCompare(right)
  })
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}

function AttributesTab({ response }: { response: RunArtifactResponse }) {
  const attributes = getRunAttributes(response)
  const entries = sortedAttributeEntries(attributes)

  if (entries.length === 0) {
    return (
      <div className="rounded-[2px] border border-border p-4">
        <h3 className="text-sm font-medium text-foreground">No run attributes</h3>
        <p className="mt-1 text-sm text-muted-foreground">This run did not record any attributes.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => copyText(JSON.stringify(Object.fromEntries(entries), null, 2))}
        >
          <Copy className="size-4" />
          Copy JSON
        </Button>
      </div>
      <div className="overflow-hidden rounded-[2px] border border-border">
        <table className="w-full table-fixed text-sm">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-border/70 last:border-b-0">
                <th className="w-[240px] align-top px-3 py-2 text-left font-mono text-xs font-medium text-muted-foreground">
                  {key}
                </th>
                <td className="align-top px-3 py-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{value}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Copy ${key} value`}
                      title="Copy value"
                      onClick={() => copyText(value)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  if (tab === "attributes") {
    return <AttributesTab response={response} />
  }

  if (tab === "config") {
    return <ArtifactConfigTab response={response} />
  }

  return (
    <ArtifactMemoryTab response={response} />
  )
}

function DrawerBody({
  tab,
  response,
  loading,
  error,
  onRetry,
}: Pick<ArtifactDrawerProps, "tab" | "response" | "loading" | "error" | "onRetry">) {
  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (!response) return <MissingArtifactState />
  if (tab !== "attributes" && !response.artifact) return <MissingArtifactState />
  return <ShellTabContent tab={tab} response={response} />
}

export function ArtifactDrawer({
  run,
  open,
  tab,
  response,
  loading,
  error,
  onOpenChange,
  onTabChange,
  onRetry,
}: ArtifactDrawerProps) {
  const artifact = response?.artifact ?? null
  const description = run.name || `Run ${run.id}`

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(820px,92vw)] sm:max-w-none gap-0 overflow-hidden p-0">
        <SheetHeader className="border-b px-4 py-3 pr-12">
          <SheetTitle className="text-base leading-snug">Run details</SheetTitle>
          <SheetDescription className="truncate text-xs">{description}</SheetDescription>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <span className="break-all font-mono">{run.id}</span>
            {artifact ? (
              <>
                <Badge variant="outline" className="text-[10px]">
                  {artifact.kind}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  schema {artifact.schemaVersion}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    artifact.finalizedAt
                      ? "border-emerald-500/20 text-emerald-500"
                      : "border-amber-500/25 text-amber-500",
                  )}
                >
                  {artifact.finalizedAt ? "finalized" : "open"}
                </Badge>
              </>
            ) : null}
          </div>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as ArtifactDrawerTab)}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <div className="border-b px-3">
            <TabsList variant="line" className="h-9 w-full justify-start">
              <TabsTrigger value="attributes" className="max-w-32 flex-none">
                Attributes
              </TabsTrigger>
              <TabsTrigger value="config" className="max-w-32 flex-none">
                Config
              </TabsTrigger>
              <TabsTrigger value="memory" className="max-w-32 flex-none">
                Memory
              </TabsTrigger>
            </TabsList>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <TabsContent value="attributes" className="m-0 px-4 py-4">
              <DrawerBody
                tab="attributes"
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
            <TabsContent value="memory" className="m-0 px-4 py-4">
              <DrawerBody
                tab="memory"
                response={response}
                loading={loading}
                error={error}
                onRetry={onRetry}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
