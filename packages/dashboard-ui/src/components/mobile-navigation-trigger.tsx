import { useEffect, useRef } from "react"
import { useLocation } from "react-router"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"

// Below the mobile breakpoint the sidebar is an off-canvas sheet whose own toggle lives inside it,
// so this bar is the only way in.
export function MobileNavigationTrigger() {
  const isMobile = useIsMobile()
  const { openMobile, setOpenMobile } = useSidebar()
  const { pathname } = useLocation()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(openMobile)
  const lastPathname = useRef(pathname)

  useEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  // The sheet is not a Radix-owned trigger's dialog, so nothing hands focus back when it closes.
  useEffect(() => {
    if (wasOpen.current && !openMobile) triggerRef.current?.focus()
    wasOpen.current = openMobile
  }, [openMobile])

  if (!isMobile) return null

  return (
    // One row the height of the 40px control: header-hidden pages share the inset with it, and a taller bar squeezed
    // the run detail composer below its height at 200% zoom.
    <div data-mobile-navigation className="flex shrink-0 items-center border-b px-2 md:hidden">
      <SidebarTrigger
        ref={triggerRef}
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={openMobile}
        className="size-10 [&>span]:hidden"
      />
    </div>
  )
}
