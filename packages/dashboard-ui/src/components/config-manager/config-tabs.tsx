import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CONFIG_TABS, type ConfigTab } from "@/lib/config-tabs"
import { CONFIG_TAB_LABELS, CONFIG_TABS_ARIA_LABEL, TAB_DRAFT_SR_SUFFIX } from "@/lib/config-copy"

const EDGE_FADE_PX = 24

interface EdgeFade {
  left: boolean
  right: boolean
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

function edgeFadeMask({ left, right }: EdgeFade): string | undefined {
  if (!left && !right) return undefined
  const start = left ? `transparent, black ${EDGE_FADE_PX}px` : "black"
  const end = right ? `black calc(100% - ${EDGE_FADE_PX}px), transparent` : "black"
  return `linear-gradient(to right, ${start}, ${end})`
}

/** Scrolls the strip, and only the strip, so as much of the trigger as fits is showing. */
function revealTrigger(box: HTMLElement, trigger: HTMLElement) {
  const strip = box.getBoundingClientRect()
  const own = trigger.getBoundingClientRect()
  if (own.left < strip.left || own.width > strip.width) box.scrollLeft -= strip.left - own.left
  else if (own.right > strip.right) box.scrollLeft += own.right - strip.right
}

export interface ConfigTabBarProps {
  tab: ConfigTab
  draftTabs?: ReadonlySet<ConfigTab>
  statusSlot?: ReactNode
}

export function ConfigTabBar({ tab, draftTabs, statusSlot }: ConfigTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<EdgeFade>({ left: false, right: false })

  const measure = useCallback(() => {
    const box = scrollRef.current
    if (!box) return
    const left = box.scrollLeft > 0
    const right = box.scrollLeft + box.clientWidth < box.scrollWidth
    setFade((current) => (current.left === left && current.right === right ? current : { left, right }))
  }, [])

  const activeTab = useRef(tab)
  activeTab.current = tab

  useLayoutEffect(() => {
    measure()
    const box = scrollRef.current
    if (!box || typeof ResizeObserver === "undefined") return
    // A widening status (an Undo line) narrows the strip; the active tab stays in view.
    const observer = new ResizeObserver(() => {
      const trigger = box.querySelector<HTMLElement>(`[data-config-tab="${activeTab.current}"]`)
      if (trigger) revealTrigger(box, trigger)
      measure()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    const trigger = scrollRef.current?.querySelector<HTMLElement>(`[data-config-tab="${tab}"]`)
    trigger?.scrollIntoView?.({
      inline: "nearest",
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
    measure()
  }, [measure, tab])

  const mask = edgeFadeMask(fade)

  return (
    <div
      data-config-tabbar
      className="sticky top-0 z-10 flex items-end gap-4 border-b border-border bg-background"
    >
      <div
        ref={scrollRef}
        data-config-tabs-scroll
        data-fade-left={fade.left || undefined}
        data-fade-right={fade.right || undefined}
        onScroll={measure}
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <TabsList variant="line" data-tour-id="tour-config-nav" aria-label={CONFIG_TABS_ARIA_LABEL()}>
          {CONFIG_TABS.map((id) => {
            const hasDraft = draftTabs?.has(id) ?? false
            return (
              <TabsTrigger key={id} value={id} data-config-tab={id}>
                {CONFIG_TAB_LABELS[id]}
                {hasDraft ? (
                  <>
                    <span data-tab-draft aria-hidden className="size-2 rounded-full bg-amber-500" />
                    <span className="sr-only">{TAB_DRAFT_SR_SUFFIX()}</span>
                  </>
                ) : null}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </div>
      <div data-config-status-slot className="shrink-0 pb-2">
        {statusSlot}
      </div>
    </div>
  )
}
