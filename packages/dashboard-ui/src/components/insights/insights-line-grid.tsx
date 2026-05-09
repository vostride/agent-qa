import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

type LineNoticeProps = ComponentProps<"div"> & {
  title?: string
  description?: ReactNode
}

type MetricCellProps = ComponentProps<"div"> & {
  label: string
  value: string
  description?: string
}

export function InsightsLineGrid({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-insights-line-grid
      className={cn(
        "grid gap-0 divide-y divide-border border border-border bg-transparent rounded-none shadow-none",
        className,
      )}
      {...props}
    />
  )
}

export function InsightsLineCell({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-w-0 bg-transparent p-4 rounded-none", className)}
      {...props}
    />
  )
}

export function InsightsLineNotice({
  title,
  description,
  children,
  className,
  ...props
}: LineNoticeProps) {
  return (
    <InsightsLineCell className={cn("flex flex-col justify-center", className)} {...props}>
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      {description ? (
        <p className={cn("text-sm text-muted-foreground", title && "mt-1")}>{description}</p>
      ) : null}
      {children}
    </InsightsLineCell>
  )
}

export function InsightsMetricCell({
  label,
  value,
  description,
  className,
  ...props
}: MetricCellProps) {
  return (
    <InsightsLineCell className={cn("flex h-full flex-col justify-between gap-4", className)} {...props}>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">{value}</p>
      </div>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </InsightsLineCell>
  )
}
