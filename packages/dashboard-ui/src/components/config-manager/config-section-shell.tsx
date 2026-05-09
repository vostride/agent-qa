import { type ComponentProps } from "react"

import { cn } from "@/lib/utils"

export function ConfigSectionShell({
  className,
  ...props
}: ComponentProps<"section">) {
  return (
    <section
      data-config-section-shell
      className={cn(
        "border border-border bg-transparent rounded-none shadow-none",
        className,
      )}
      {...props}
    />
  )
}

export function ConfigSectionHeader({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      className={cn("border-b border-border px-5 py-4", className)}
      {...props}
    />
  )
}

export function ConfigSectionBody({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-config-section-body
      className={cn("space-y-6 px-5 py-5", className)}
      {...props}
    />
  )
}

export function ConfigSectionFooter({
  className,
  ...props
}: ComponentProps<"footer">) {
  return (
    <footer
      className={cn("border-t border-border px-5 py-4", className)}
      {...props}
    />
  )
}

export function ConfigLineNotice({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-config-line-notice
      className={cn(
        "border border-border bg-transparent rounded-none px-4 py-3 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}
