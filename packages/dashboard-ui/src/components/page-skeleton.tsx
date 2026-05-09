import type { ComponentProps } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

function LineSkeleton({ className, ...props }: ComponentProps<typeof Skeleton>) {
  return <Skeleton className={cn("rounded-none bg-muted", className)} {...props} />
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div data-skeleton="table" className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <LineSkeleton className="h-8 w-48 max-w-full" />
        <LineSkeleton className="h-9 w-32" />
      </div>
      <div className="rounded-none border border-border bg-transparent">
        <LineSkeleton className="h-10 w-full" />
        <div className="divide-y divide-border border-t border-border">
          {Array.from({ length: rows }).map((_, i) => (
            <LineSkeleton key={i} data-skeleton-part="table-row" className="h-14 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div data-skeleton="detail" className="h-full min-h-0 p-4 md:p-6">
      <div className="flex h-full min-h-0 flex-col rounded-none border border-border bg-transparent">
        <div data-skeleton-part="detail-header-nav" className="border-b border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <LineSkeleton className="h-8 w-64 max-w-full" />
              <LineSkeleton className="h-4 w-48 max-w-full" />
            </div>
            <div className="flex gap-2">
              <LineSkeleton className="h-9 w-24" />
              <LineSkeleton className="h-9 w-24" />
            </div>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <div
            data-skeleton-part="detail-timeline-column"
            className="min-h-[420px] space-y-3 rounded-none border-b border-border p-4 md:border-b-0 md:border-r"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2 border-b border-border pb-3 last:border-b-0">
                <LineSkeleton className="h-4 w-3/4" />
                <LineSkeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
          <div
            data-skeleton-part="detail-screenshot-region"
            className="h-[32rem] min-h-[32rem] rounded-none border-border p-4"
          >
            <LineSkeleton className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChartSkeleton() {
  return (
    <div data-skeleton="insights" className="h-full min-h-0 overflow-y-auto p-4 md:p-6">
      <div data-skeleton-part="insights-heading-row" className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <LineSkeleton className="h-8 w-48 max-w-full" />
          <LineSkeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex gap-2">
          <LineSkeleton className="h-9 w-14" />
          <LineSkeleton className="h-9 w-14" />
          <LineSkeleton className="h-9 w-20" />
        </div>
      </div>

      <div data-skeleton-part="insights-kpi-grid" className="rounded-none border border-border bg-transparent">
        <div className="grid gap-0 divide-y divide-border md:grid-cols-4 md:divide-x md:divide-y-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} data-skeleton-part="insights-kpi-cell" className="space-y-3 p-4">
              <LineSkeleton className="h-3 w-24" />
              <LineSkeleton className="h-7 w-20" />
              <LineSkeleton className="h-3 w-28" />
            </div>
          ))}
        </div>
        <div className="grid gap-0 border-t border-border md:grid-cols-2 md:divide-x md:divide-border">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              data-skeleton-part="insights-chart-cell"
              className="h-[220px] space-y-4 rounded-none border-border p-4"
            >
              <LineSkeleton className="h-5 w-32" />
              <LineSkeleton className="h-3 w-56 max-w-full" />
              <LineSkeleton className="h-[150px] w-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-0 rounded-none border border-border bg-transparent md:grid-cols-2 md:divide-x md:divide-border">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} data-skeleton-part="insights-secondary-cell" className="space-y-4 p-4">
            <LineSkeleton className="h-5 w-36" />
            <LineSkeleton className="h-3 w-64 max-w-full" />
            <div className="grid gap-0 rounded-none border border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
              {Array.from({ length: 3 }).map((__, j) => (
                <div key={j} className="space-y-2 border-b border-border p-3 last:border-b-0 sm:border-b-0">
                  <LineSkeleton className="h-3 w-16" />
                  <LineSkeleton className="h-5 w-12" />
                </div>
              ))}
            </div>
            <LineSkeleton className="h-24 w-full" />
          </div>
        ))}
      </div>

      <div
        data-skeleton-part="insights-breakdown-block"
        className="mt-6 min-h-[420px] rounded-none border border-border bg-transparent"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-4">
          <LineSkeleton className="h-5 w-40" />
          <div className="flex gap-2">
            <LineSkeleton className="h-9 w-20" />
            <LineSkeleton className="h-9 w-20" />
            <LineSkeleton className="h-9 w-20" />
          </div>
        </div>
        <div className="divide-y divide-border">
          <LineSkeleton className="h-11 w-full" />
          {Array.from({ length: 5 }).map((_, i) => (
            <LineSkeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function FormSkeleton() {
  return (
    <div data-skeleton="config" className="h-full min-h-0 p-4 md:p-6">
      <div data-skeleton-part="config-title-row" className="mb-6 space-y-2">
        <LineSkeleton className="h-8 w-48" />
        <LineSkeleton className="h-4 w-96 max-w-full" />
      </div>
      <div
        data-skeleton-part="config-layout"
        className="grid gap-0 rounded-none border border-border bg-transparent lg:grid-cols-[minmax(240px,256px)_minmax(0,1fr)]"
      >
        <div data-skeleton-part="config-rail" className="hidden rounded-none border-r border-border p-4 lg:block">
          <div className="space-y-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <LineSkeleton className="h-3 w-24" />
                <div className="space-y-2">
                  <LineSkeleton className="h-8 w-full" />
                  <LineSkeleton className="h-8 w-10/12" />
                  <LineSkeleton className="h-8 w-11/12" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div data-skeleton-part="config-main" className="h-[32rem] min-h-[32rem] rounded-none border-border p-4 lg:p-6">
          <div className="rounded-none border border-border bg-transparent">
            <div className="space-y-2 border-b border-border p-4">
              <LineSkeleton className="h-6 w-56 max-w-full" />
              <LineSkeleton className="h-4 w-80 max-w-full" />
            </div>
            <div className="space-y-5 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <LineSkeleton className="h-4 w-32" />
                  <LineSkeleton className="h-10 w-full" />
                </div>
              ))}
            </div>
            <div className="border-t border-border p-4">
              <LineSkeleton className="h-9 w-32" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function EditorSkeleton() {
  return (
    <div data-skeleton="editor" className="h-full min-h-0 p-4 md:p-6">
      <div className="flex h-full min-h-0 flex-col rounded-none border border-border bg-transparent">
        <div data-skeleton-part="editor-toolbar" className="border-b border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <LineSkeleton className="h-8 w-64 max-w-full" />
            <div className="flex gap-2">
              <LineSkeleton className="h-9 w-20" />
              <LineSkeleton className="h-9 w-20" />
            </div>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <div className="hidden border-r border-border p-4 lg:block">
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <LineSkeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          </div>
          <div data-skeleton-part="editor-surface" className="h-[500px] min-h-[500px] rounded-none border-border p-4">
            <LineSkeleton className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
