"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type ScrollAreaProps = React.ComponentProps<"div"> & {
  type?: "auto" | "always" | "scroll" | "hover"
  scrollHideDelay?: number
}

function ScrollArea({
  className,
  children,
  type: _type,
  scrollHideDelay: _scrollHideDelay,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative overflow-auto [scrollbar-width:thin]", className)}
      {...props}
    >
      <div
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:!block"
      >
        {children}
      </div>
    </div>
  )
}

function ScrollBar({
  orientation: _orientation = "vertical",
  ..._props
}: React.ComponentProps<"div"> & {
  orientation?: "vertical" | "horizontal"
}) {
  return null
}

export { ScrollArea, ScrollBar }
