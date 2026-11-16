import { useEffect, useState } from 'react'

import type { HookRunRecord } from '@/hooks/use-hook-run-session'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/i18n'
import { getHookRuntimeMeta } from '@/lib/hook-runtime'
import { formatRegionalDateTime, formatRelativeCompact } from '@/lib/format'
import { formatDuration } from '@/lib/utils'

// The fields of a bare `toLocaleString()`, in the dashboard's language and the browser's region.
const EXECUTED_AT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
}

function StatusBadge({ status }: { status: 'passed' | 'failed' }) {
  const { t } = useTranslation()
  if (status === 'passed') {
    return (
      <Badge className="border-emerald-500/20 bg-emerald-500/15 text-emerald-500">
        {t('status.passed')}
      </Badge>
    )
  }
  return <Badge variant="destructive">{t('status.failed')}</Badge>
}

function EmptyResult() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="text-base font-semibold text-foreground">
          {t('hooks.run.noRunSelected')}
        </div>
        <div className="mt-2 text-sm text-muted-foreground">{t('hooks.run.noRunSelectedHint')}</div>
      </div>
    </div>
  )
}

function KeyValueTable({ rows }: { rows: Array<[string, string]> }) {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">{t('hooks.run.none')}</div>
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
  const { t } = useTranslation()
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
            <div className="text-sm font-medium text-foreground">{t('hooks.run.latestResult')}</div>
            <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <span>{formatDuration(result.duration)}</span>
              <span>{formatRelativeCompact(result.executedAt)}</span>
            </div>
          </div>
        </div>
      ) : null}

      <TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-4">
        <TabsTrigger value="overview" className="flex-initial rounded-none text-xs">{t('hooks.run.tab.overview')}</TabsTrigger>
        <TabsTrigger value="output" className="flex-initial rounded-none text-xs">{t('hooks.run.tab.output')}</TabsTrigger>
        <TabsTrigger value="env" className="flex-initial rounded-none text-xs">{t('hooks.run.tab.env')}</TabsTrigger>
        <TabsTrigger value="sandbox" className="flex-initial rounded-none text-xs">{t('hooks.run.tab.sandbox')}</TabsTrigger>
        {showNetworkTab ? (
          <TabsTrigger value="network" className="flex-initial rounded-none text-xs">{t('hooks.run.tab.network')}</TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="overview" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.status')}</div>
                <div className="mt-2"><StatusBadge status={result.status} /></div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.duration')}</div>
                <div className="mt-2 text-sm text-foreground">{formatDuration(result.duration)}</div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.executed')}</div>
                <div className="mt-2 text-sm text-foreground">{formatRegionalDateTime(new Date(result.executedAt), EXECUTED_AT_OPTIONS)}</div>
              </div>
              <div className="rounded-sm border px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.recency')}</div>
                <div className="mt-2 text-sm text-foreground">{formatRelativeCompact(result.executedAt)}</div>
              </div>
            </div>

            {result.status === 'failed' ? (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.failureSummary')}</div>
                <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground">
                  {result.error ?? result.stderr ?? t('hooks.run.failedSummary')}
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
                {result.stdout || t('hooks.run.noStdout')}
              </div>
            </section>

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">stderr</div>
              <div className="rounded-sm border bg-destructive/5 p-3 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                {result.stderr || t('hooks.run.noStderr')}
              </div>
            </section>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="env" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.emittedVariables')}</div>
              <KeyValueTable rows={emittedVariables} />
            </section>

            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.appliedOverrides')}</div>
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
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.field.runtime')}</td>
                    <td className="px-3 py-2 text-sm text-foreground">{getHookRuntimeMeta(result.sandbox.runtime).label}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.image')}</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground break-all">{result.sandbox.image}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.dockerVersion')}</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground break-all">
                      {result.sandbox.dockerVersion ?? t('hooks.run.notAvailable')}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.field.network')}</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{result.sandbox.networkMode}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {!showNetworkTab ? (
              <div className="rounded-sm border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
                {t('hooks.run.networkLogsUnavailable')}
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
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.method')}</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">URL</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.status')}</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('hooks.run.duration')}</th>
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
