// Renders only when it has something to hold, and wraps rather than clips in a ~400 px pane.

import { Children, type ReactNode } from 'react'

export function PreviewChrome({ status, children }: { status?: ReactNode; children?: ReactNode }) {
  const lead = Children.toArray(status)
  const content = Children.toArray(children)
  if (lead.length === 0 && content.length === 0) return null
  return (
    <div
      data-preview-chrome
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1 text-xs"
    >
      {lead}
      {content}
    </div>
  )
}
