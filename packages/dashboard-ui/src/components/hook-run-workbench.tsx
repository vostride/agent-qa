import { Plus, Trash2 } from 'lucide-react'

import type { HookRunRecord, HookRunOverrideRow } from '@/hooks/use-hook-run-session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, formatDuration } from '@/lib/utils'

function formatRelativeCompact(iso: string): string {
  if (!iso) return 'just now'
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

interface HookRunWorkbenchProps {
  baselineCount: number
  baselineFilePath: string | null
  baselineInfo: string | null
  isBaselineLoading: boolean
  overrideRows: HookRunOverrideRow[]
  overridingRowIds: Set<string>
  recentRuns: HookRunRecord[]
  selectedRunId: string | null
  isRunning: boolean
  runDisabledReason: string | null
  runError: string | null
  onAddOverride: () => void
  onUpdateOverride: (rowId: string, patch: Partial<Pick<HookRunOverrideRow, 'key' | 'value'>>) => void
  onRemoveOverride: (rowId: string) => void
  onRun: () => void | Promise<void>
  onSelectRun: (runId: string) => void
}

export function HookRunWorkbench({
  baselineCount,
  baselineFilePath,
  baselineInfo,
  isBaselineLoading,
  overrideRows,
  overridingRowIds,
  recentRuns,
  selectedRunId,
  isRunning,
  runDisabledReason,
  runError,
  onAddOverride,
  onUpdateOverride,
  onRemoveOverride,
  onRun,
  onSelectRun,
}: HookRunWorkbenchProps) {
  const disabledTitle = runDisabledReason === 'Save this hook to run the latest changes.'
    ? 'Save required'
    : "Hook couldn't be executed"

  return (
    <Tabs defaultValue="inputs" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b px-4 py-1.5">
        <TabsList variant="line" className="h-7 w-auto justify-start rounded-none p-0">
          <TabsTrigger value="inputs" className="flex-initial rounded-none px-2.5 text-xs">Input</TabsTrigger>
          <TabsTrigger value="logs" className="flex-initial rounded-none px-2.5 text-xs">Run logs</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="inputs" className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {runDisabledReason ? (
              <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
                <div className="font-medium text-foreground">{disabledTitle}</div>
                <div className="mt-1 text-muted-foreground">{runDisabledReason}</div>
              </div>
            ) : null}

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Workspace env</div>
              <div className="rounded-sm border bg-muted/20 px-3 py-2.5">
                <div className="text-sm text-foreground">
                  {isBaselineLoading
                    ? 'Loading workspace variables...'
                    : baselineFilePath
                      ? `${baselineCount} variable${baselineCount === 1 ? '' : 's'} available from ${baselineFilePath}`
                      : 'No workspace .env file is configured for this project.'}
                </div>
                {baselineInfo ? (
                  <div className="mt-1 text-xs text-muted-foreground">{baselineInfo}</div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Inherited workspace variables are included automatically for each run.
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Runtime variables</div>
                  <div className="text-sm text-muted-foreground">
                    Variables added for this run only. They override inherited workspace values and can model env
                    handoff between hooks.
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={onAddOverride}>
                  <Plus className="h-3.5 w-3.5" />
                  Add variable
                </Button>
              </div>

              {overrideRows.length === 0 ? (
                <div className="rounded-sm border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  No runtime variables yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {overrideRows.map((row) => {
                    const overridesEnv = overridingRowIds.has(row.id)
                    return (
                      <div key={row.id} className="rounded-sm border px-3 py-2.5">
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                          <Input
                            value={row.key}
                            placeholder="KEY"
                            onChange={(event) => onUpdateOverride(row.id, { key: event.target.value })}
                          />
                          <Input
                            value={row.value}
                            placeholder="Value"
                            onChange={(event) => onUpdateOverride(row.id, { value: event.target.value })}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove variable"
                            onClick={() => onRemoveOverride(row.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {overridesEnv ? (
                          <div className="mt-2 text-xs text-primary">Overrides .env</div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {runError ? (
              <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm">
                <div className="font-medium text-foreground">Hook couldn&apos;t be executed</div>
                <div className="mt-1 text-muted-foreground">
                  Review stderr or sandbox details, adjust runtime variables, and run again.
                </div>
                <div className="mt-3 font-mono text-xs text-foreground">{runError}</div>
              </div>
            ) : null}

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Local runs</div>
              <div className="text-sm text-muted-foreground">
                Recent hook runs stay in this browser and are not added to dashboard history.
              </div>

              {recentRuns.length === 0 ? (
                <div className="rounded-sm border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  No run logs in this browser session yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {recentRuns.map((run) => {
                    const isSelected = (selectedRunId ?? recentRuns[0]?.id) === run.id
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => onSelectRun(run.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-sm border px-3 py-2.5 text-left transition-colors',
                          'hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                          isSelected && 'border-primary/50 bg-primary/10',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            {run.result.status === 'passed' ? 'Passed' : 'Failed'}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatRelativeCompact(run.result.executedAt)}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">{formatDuration(run.result.duration)}</div>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
