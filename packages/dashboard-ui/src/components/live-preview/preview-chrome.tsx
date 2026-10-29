// THE PREVIEW'S CHROME ROW: it renders only when it has something to hold.
//
// The preview's status leads it, at the container's top-left, before any host content such as the
// editor's toolbar (owner decision 2026-09-26 (4), G-428-4). The row wraps rather than clips, so
// words and an action still fit a ~400 px pane.

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
