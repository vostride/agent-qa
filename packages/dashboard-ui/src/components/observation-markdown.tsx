import { marked } from "marked"

import { cn } from "@/lib/utils"

interface ObservationMarkdownProps {
  className?: string
  content: string
}

const renderer = new marked.Renderer()
renderer.html = ({ text }) => escapeHtml(text)

export function ObservationMarkdown({
  className,
  content,
}: ObservationMarkdownProps) {
  const html = marked.parse(content, {
    async: false,
    gfm: true,
    renderer,
  }) as string

  return (
    <div
      className={cn("markdown-preview text-sm text-foreground", className)}
      role="document"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
