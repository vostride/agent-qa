import type { ReactNode } from 'react'

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'

interface HookWorkspaceShellProps {
  isMobile: boolean
  leftPane: ReactNode
  rightTopPane: ReactNode
  rightBottomPane: ReactNode
  className?: string
}

export function HookWorkspaceShell({
  isMobile,
  leftPane,
  rightTopPane,
  rightBottomPane,
  className,
}: HookWorkspaceShellProps) {
  if (isMobile) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto', className)}>
        <section data-slot="leftPane" className="min-h-0">
          {leftPane}
        </section>
        <section data-slot="rightTopPane" className="border-t">
          {rightTopPane}
        </section>
        <section data-slot="rightBottomPane" className="min-h-[360px] border-t">
          {rightBottomPane}
        </section>
      </div>
    )
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className={cn('min-h-0 flex-1', className)}>
      <ResizablePanel defaultSize={46} minSize={30}>
        <div data-slot="leftPane" className="h-full min-h-0 overflow-hidden">
          {leftPane}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={54} minSize={30}>
        <ResizablePanelGroup orientation="vertical" className="h-full min-h-0">
          <ResizablePanel defaultSize={42} minSize={24}>
            <div data-slot="rightTopPane" className="h-full min-h-0 overflow-hidden border-b">
              {rightTopPane}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={58} minSize={28}>
            <div data-slot="rightBottomPane" className="h-full min-h-0 overflow-hidden">
              {rightBottomPane}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
