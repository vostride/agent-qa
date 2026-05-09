import { useEffect, useState } from 'react'

import type { HookRunRecord } from '@/hooks/use-hook-run-session'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getHookRuntimeMeta } from '@/lib/hook-runtime'
import { formatDuration } from '@/lib/utils'

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

function StatusBadge({ status }: { status: 'passed' | 'failed' }) {
  if (status === 'passed') {
    return (
      <Badge className="border-emerald-500/20 bg-emerald-500/15 text-emerald-500">
        Passed
      </Badge>
    )
  }
  return <Badge variant="destructive">Failed</Badge>
}

function EmptyResult() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="text-base font-semibold text-foreground">No run selected</div>
        <div className="mt-2 text-sm text-muted-foreground">
          Run this hook or pick a recent local result to inspect.
        </div>
      </div>
    </div>
  )
}

function KeyValueTable({ rows }: { rows: Array<[string, string]> }) {
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">None</div>
  }

  return (
    <div className="rounded-sm border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="border-b last:border-b-0">
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{key}</td>
              <td className="px-3 py-2 font-mono text-xs text-foreground break-all">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function HookRunResultPanel({ selectedRun }: { selectedRun: HookRunRecord | null }) {
  const [activeTab, setActiveTab] = useState<'overview' | 'output' | 'env' | 'sandbox' | 'network'>('overview')
  const previewResult = selectedRun?.result ?? null
  const networkLogs = previewResult?.sandbox.networkLogs ?? []
  const showNetworkTab = previewResult?.sandbox.networkLogsAvailable === true && networkLogs.length > 0

  useEffect(() => {
    setActiveTab('overview')
  }, [selectedRun?.id])

  useEffect(() => {
    if (!showNetworkTab && activeTab === 'network') {
      setActiveTab('overview')
    }
  }, [activeTab, showNetworkTab])

  if (!selectedRun) {
    return <EmptyResult />
  }

  const result = selectedRun.result
  const emittedVariables = Object.entries(result.variables)
  const appliedOverrides = Object.entries(selectedRun.overrideSnapshot)
  const showSummaryHeader = result.status !== 'failed'

  return (
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="flex h-full min-h-0 flex-col gap-0">
      {showSummaryHeader ? (
        <div className="border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={result.status} />
            <div className="text-sm font-medium text-foreground">Latest hook result</div>
            <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <span>{formatDuration(result.duration)}</span>
              <span>{formatRelativeCompact(result.executedAt)}</span>
            </div>
          </div>
        </div>
      ) : null}

      <TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-4">
        <TabsTrigger value="overview" className="flex-initial rounded-none text-xs">Overview</TabsTrigger>
        <TabsTrigger value="output" className="flex-initial rounded-none text-xs">Output</TabsTrigger>
        <TabsTrigger value="env" className="flex-initial rounded-none text-xs">Env</TabsTrigger>
        <TabsTrigger value="sandbox" className="flex-initial rounded-none text-xs">Sandbox</TabsTrigger>
        {showNetworkTab ? (
          <TabsTrigger value="network" className="flex-initial rounded-none text-xs">Network</TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="overview" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</div>
                <div className="mt-2"><StatusBadge status={result.status} /></div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Duration</div>
                <div className="mt-2 text-sm text-foreground">{formatDuration(result.duration)}</div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Executed</div>
                <div className="mt-2 text-sm text-foreground">{new Date(result.executedAt).toLocaleString()}</div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recency</div>
                <div className="mt-2 text-sm text-foreground">{formatRelativeCompact(result.executedAt)}</div>
              </div>
            </div>

            {result.status === 'failed' ? (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Failure summary</div>
                <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground">
                  {result.error ?? result.stderr ?? 'Hook run failed.'}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="output" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">stdout</div>
              <div className="rounded-sm border bg-muted/20 p-3 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                {result.stdout || 'No stdout captured.'}
              </div>
            </section>

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">stderr</div>
              <div className="rounded-sm border bg-destructive/5 p-3 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                {result.stderr || 'No stderr captured.'}
              </div>
            </section>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="env" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Emitted variables</div>
              <KeyValueTable rows={emittedVariables} />
            </section>

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Applied override snapshot</div>
              <KeyValueTable rows={appliedOverrides} />
            </section>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="sandbox" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <div className="rounded-sm border">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Runtime</td>
                    <td className="px-3 py-2 text-sm text-foreground">{getHookRuntimeMeta(result.sandbox.runtime).label}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Image</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground break-all">{result.sandbox.image}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Docker version</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground break-all">
                      {result.sandbox.dockerVersion ?? 'Not available'}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Network</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{result.sandbox.networkMode}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {!showNetworkTab ? (
              <div className="rounded-sm border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
                Network logs aren&apos;t available for this runtime yet.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </TabsContent>

      {showNetworkTab ? (
        <TabsContent value="network" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-4">
              <div className="overflow-hidden rounded-sm border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Method</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">URL</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkLogs.map((entry) => (
                      <tr key={entry.id} className="border-b last:border-b-0">
                        <td className="px-3 py-2 font-mono text-xs text-foreground">{entry.method}</td>
                        <td className="px-3 py-2 font-mono text-xs text-foreground break-all">
                          <div>{entry.url}</div>
                          {entry.error ? (
                            <div className="mt-1 text-destructive">{entry.error}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-foreground">
                          {entry.statusCode ?? '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-foreground">
                          {entry.durationMs == null ? '—' : formatDuration(entry.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
      ) : null}
    </Tabs>
  )
}
